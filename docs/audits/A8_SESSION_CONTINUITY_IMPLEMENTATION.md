# QUARANGATE — A8 SESSION CONTINUITY IMPLEMENTATION / REMEDIATION R1

## Status

**Implementation state:** `PASS_CANDIDATE_FORWARD_INTEGRATION`; this document is part of the 24-path forward freeze candidate. The immutable commit identity is verified and recorded after commit; live Kiro qualification remains separate.
**Forward branch / accepted base:** `integrate/quarangate-forward` at immutable pre-A8 base `91cc72fa80e5eca75ff8c002c1d86f5dfa454abf`; the A8 integration delta is exactly 24 governed paths on that sole development line.
**Historical A8 source lane:** `lane/a8-session-continuity` at base `9867cd66a451ec44bcd2e24d994e9aed78fb284f`; retained as read-only evidence, not the active writer.
**Live Kiro session restore:** `NOT_QUALIFIED_ON_INTEGRATED_REVISION` — the live QuaranGate runtime is still the accepted P1 revision `b01015c4c2854881aeac7cab6e2caf45d978a75d`; this exact integrated A8 candidate has not yet been deployed.
**ODR-1:** fail closed remains implemented.
**ODR-2:** historical R1 status was owner-decision pending. The owner later selected the hybrid policy; current source implements it through the bounded ODR-2 source-revision remediation documented in `A8_ODR2_SOURCE_REVISION_BINDING.md`.

This document supersedes the pre-R1 A8 implementation notes that incorrectly treated local client-side session-ID injection as sufficient provider restoration.

---

## 1. R1 review failures closed

Independent review rejected the original A8 candidate for four material reasons:

1. provider restoration was not actually negotiated/executed;
2. the engine could consume the newly-created successor instead of the source session;
3. session lifecycle writes and job completion were not one durable transaction;
4. a lookup-only resume decision allowed two dispatches to observe the same ACTIVE session before execution.

R1 changes the contract at the provider, database, concurrency, and restart boundaries.

---

## 2. Kiro provider restoration protocol

### Evidence used

The targeted Kiro backend is Kiro CLI 2.5.0. Retained repository protocol evidence for that target advertises:

```text
agentCapabilities.loadSession = true
```

and the retained Kiro ACP integration documentation names:

```text
session/load
```

as the restoration operation. Current Kiro ACP documentation also describes provider session persistence under:

```text
~/.kiro/sessions/cli/
```

The implementation therefore does **not** infer that a provider session can be restored by ID alone.

### Frozen R1 wire behavior

Fresh session:

```text
initialize
→ verify protocol
→ session/new
→ session/prompt
```

Resume:

```text
initialize
→ verify protocol
→ require agentCapabilities.loadSession == true
→ session/load { sessionId, cwd, mcpServers: [] }
→ session/prompt
```

A resume request NEVER falls back to `session/new`.

The former `AcpDriver.injectSessionId()` restoration path has been removed. The driver assigns its local active session ID only after `session/load` succeeds.

Failures including unsupported load capability, dead/unknown session, provider rejection, and malformed load result fail closed as `SESSION_NOT_RESUMABLE`.

---

## 3. Provider state persistence

Kiro ACP restoration depends on provider-local state. A normal QuaranGate Kiro job previously used a disposable job HOME, which would destroy that state at cleanup.

R1 persists only the minimum Kiro ACP session subtree rather than the entire arbitrary HOME:

```text
/home/runner/.kiro/sessions/cli
```

A dedicated QuaranGate-managed Docker volume is mounted at that exact path. The remainder of runner HOME remains disposable.

### Provider-state ownership

Each fresh provider-state volume carries QuaranGate ownership metadata including:

```text
managed=true
resource=provider-session
job=<creating job id>
provider-binding=<sha256 of principalId\0project\0backend\0profile>
```

On resume, the backend proves:

- exact referenced volume exists;
- QuaranGate managed ownership is present;
- resource type is `provider-session`;
- trusted 4-tuple binding hash matches the current authorized job context.

A database reference to a missing, unowned, or differently-bound provider-state volume fails closed and the affected session is invalidated rather than returned to ACTIVE.

The provider state reference is backend-private. It is not part of the public session object or public job result.

---

## 4. Session identity and authority

A resumable session is bound to the exact trusted identity tuple:

```text
principalId
project
backend
profile
```

Session rows contain identity/lifecycle information, not grants. Every dispatch re-runs the ordinary current authorization chain before any session reservation is attempted.

Session state cannot confer or restore:

- client authorization;
- project authorization;
- backend authorization;
- profile authorization;
- writer classification;
- apply authority;
- guarded-path override;
- stale-artifact override;
- project-quarantine override;
- Docker authority;
- GitHub authority.

Raw provider session IDs and provider-state references remain executor-side only.

---

## 5. Durable session lifecycle

R1 state machine:

```text
ACTIVE
  │ atomic reservation at dispatch
  ▼
RESERVED(jobId)
  ├─ safe cancellation / failure before provider use ──> ACTIVE
  ├─ missing/corrupt provider state ───────────────────> EXPIRED
  ├─ crash / ambiguous provider advancement ───────────> EXPIRED
  └─ successful atomic finalization ───────────────────> CONSUMED
                                                        + successor ACTIVE
```

`CONSUMED` and `EXPIRED` are terminal and never become ACTIVE again.

`RESERVED` records the exact owning job ID and reservation timestamp.

### Automatic wall-clock expiry

A schema field `expires_at` exists as a reserved future seam. **A8 R1 does not implement automatic TTL/wall-clock session expiry.** Eligibility is determined by durable lifecycle state, not by an unimplemented timestamp policy.

---

## 6. Atomic resume reservation

Production resume admission no longer performs a lookup-only policy decision.

`AgentJobStore.insertWithSessionReservation()` owns one `BEGIN IMMEDIATE` transaction that:

1. searches for an ACTIVE session matching the exact 4-tuple;
2. CAS-transitions that session `ACTIVE → RESERVED(jobId)`;
3. inserts the QUEUED job with the immutable source QuaranGate session ID;
4. commits both decisions together.

If no session is eligible or the reservation CAS loses, dispatch fails closed with `SESSION_NOT_RESUMABLE`.

This prevents two jobs from successfully reserving the same provider session.

---

## 7. Correct source/successor semantics

The source session selected at dispatch is preserved as immutable execution state.

Successful continuation is:

```text
SOURCE sess_A: RESERVED(job)
provider turn succeeds
↓
atomic finalization
↓
SOURCE sess_A: CONSUMED by job
SUCCESSOR sess_B: ACTIVE
JOB.backend_session_id: sess_B
```

The engine never re-reads an overwritten job session field to decide which source session to consume.

The successor receives a fresh opaque QuaranGate `sess_...` identity while retaining the provider's actual continued session ID and provider-state reference server-side.

---

## 8. Atomic job + session success boundary

`AgentJobStore.finalizeCompletedWithSession()` owns one SQLite `BEGIN IMMEDIATE` transaction.

Before commit it proves:

- job still has status `VALIDATING`;
- for mutation-capable jobs, required canonical artifact is already `AVAILABLE`;
- source session ID on the job still equals the immutable reserved source;
- source session is still `RESERVED` by the exact job.

Inside the same transaction it:

1. consumes the exact source reservation;
2. inserts the ACTIVE successor session when a provider continuation exists;
3. writes the successor opaque session ID to the job;
4. writes completion metadata;
5. transitions the job to `COMPLETED`;
6. commits.

Any database failure rolls back the session lifecycle and job completion decision together.

The post-COMMIT row read is deliberately outside the transaction catch block so a diagnostic read failure cannot trigger an invalid rollback against an already-committed transaction.

---

## 9. Artifact / writer safety

For jobs requiring a canonical artifact, artifact validation/publication occurs before R1 can make any successor session durable.

A provider turn cannot create a future ACTIVE continuation point from a writer job that later fails the existing artifact requirement.

A8 does not change:

- staged writer workspace isolation;
- per-job baseCommit capture;
- stale-HEAD apply refusal;
- canonical artifact identity;
- explicit owner review/apply/discard;
- guarded-path enforcement;
- project quarantine.

---

## 10. Ambiguous provider advancement

A provider can advance its own persistent conversation state before QuaranGate succeeds in committing job finalization.

R1 refuses to make the source resumable again when equivalence cannot be proven.

If provider use may have started and any later operation fails:

```text
source RESERVED → EXPIRED
provider-state volume → discarded
job → normal fail-closed terminal failure
```

If required provider state is already missing/mismatched before provider use:

```text
source RESERVED → EXPIRED
```

Only a failure/cancellation proven to occur before provider use and unrelated to session integrity may safely release:

```text
RESERVED → ACTIVE
```

Queued cancellation performs this safe release in the same transaction as the job's `CANCELLED` transition.

---

## 11. Restart and orphan reconciliation

Startup order is security-significant.

`AgentJobEngine.recover()` now performs:

```text
recover active jobs fail closed
→ reconcile RESERVED sessions
→ only then kick queued work
```

Reservation reconciliation is transactional:

- `RESERVED + owning job still QUEUED` → reservation remains RESERVED;
- any other leaked RESERVED session → EXPIRED.

The generic sandbox orphan sweeper previously deleted every managed non-evidence volume, which would have destroyed active Kiro session state.

R1 therefore supplies an exact DB-derived preserve set to `sandbox.reconcileOrphans()` after session recovery:

```text
provider_state_ref referenced by ACTIVE or RESERVED session
```

Only those exact names are protected. `CONSUMED`/`EXPIRED`-only provider state is not protected and is cleanup-eligible.

Lookalike names alone are never persistence authority.

---

## 12. Restart matrix proven by deterministic tests

R1 tests cover:

- ACTIVE session durability through DB reopen;
- CONSUMED remains terminal after restart;
- EXPIRED remains terminal after restart;
- RESERVED + QUEUED remains reserved and eligible for later execution;
- reservation belonging to a job failed during recovery becomes EXPIRED;
- engine recovery reconciles reservations before queued execution is kicked;
- completed job, CONSUMED source, and ACTIVE successor survive restart consistently;
- provider state missing/mismatched at execution fails closed;
- startup orphan cleanup preserves exact ACTIVE/RESERVED provider state and removes unprotected provider-session state.

No new A8 race test relies on arbitrary sleeps.

---

## 13. Deterministic provider-wire tests

The mock ACP server now requires a session to be actually created or loaded before accepting `session/prompt`.

Tests prove:

### NEW

```text
initialize
session/new
session/prompt
```

and no `session/load`.

### RESUME

```text
initialize
session/load
session/prompt
```

and `session/new` call count is zero.

Additional fail-closed tests cover:

- `loadSession` capability absent;
- dead/unknown provider session;
- malformed `session/load` response;
- no fallback to new session.

---

## 14. Concurrency and race tests

R1 directly proves:

- two resume dispatches targeting the same ACTIVE session cannot both reserve it;
- the winner owns `RESERVED(jobId)`;
- the loser receives `SESSION_NOT_RESUMABLE`;
- execution re-reads provider identity only through the exact reserved session/job pair;
- if reservation is invalidated after dispatch but before execution, backend construction/provider invocation does not occur;
- failed finalization rolls back source consumption;
- successful finalization consumes source and leaves exactly one ACTIVE successor.

---

## 15. ODR-1 and ODR-2

### ODR-1 — unchanged

```text
sessionPolicy=resume
+
no eligible session
=
SESSION_NOT_RESUMABLE
```

No silent fallback to `new` exists.

### ODR-2 — historical R1 status, superseded by bounded remediation

At the original A8 R1 freeze, sessions were not revision-bound and ODR-2 remained an explicit owner decision. That historical statement is preserved for chronology.

The owner later selected the hybrid policy and current source now persists the trusted staged Git revision on resumable sessions. A mutating/`implement` resume requires an exact revision match and fails closed on drift or on a legacy unbound session. Read-only `audit`/`plan`/`review` continuity may cross revision drift only after the current project revision has been freshly attested by trusted staging; provider memory remains context only. See `docs/audits/A8_ODR2_SOURCE_REVISION_BINDING.md`.

---

## 16. Validation evidence

The historical A8 lane was first requalified without mutation, then its delta was integrated onto the accepted P1+U1 forward line. The old A8 base `9867cd66a451ec44bcd2e24d994e9aed78fb284f` is an ancestor of the forward base `91cc72fa80e5eca75ff8c002c1d86f5dfa454abf`, allowing Git three-way integration rather than whole-file replacement.

Seventeen tracked A8 paths applied cleanly. `src/executor/agents/sandboxRunner.ts` was the only overlapping conflict: later H1 work added managed-network orphan reconciliation while A8 added preservation of exact ACTIVE/RESERVED provider-session volumes. The forward candidate retains both controls; neither replaces the other. Six new A8 source/test/evidence files were copied byte-identically from the requalified historical candidate.

Final integrated-source validation before freeze:

```text
A8 focused matrix:
10 files / 336 PASS / 0 FAIL

Full forward unit suite:
62 files / 2223 PASS / 0 FAIL

U1 / Console focused regression:
5 files / 34 PASS / 0 FAIL

Production TypeScript typecheck:
PASS

Production build:
PASS

git diff --check:
PASS
```

The full suite includes the P1/O1 final-closeout tests, H1 network reconciliation, A8 reservation/finalization/restart/cancellation/provider-state cases, and the accepted U1 Console regressions. No test count is inferred from historical documents; the numbers above are the fresh integrated-run results.

---

## 17. Live qualification

No live Kiro CLI/session restoration was claimed by this lane.

The implementation has deterministic protocol and persistence tests, but live qualification requires the governed Kiro runtime, credentials, and existing authorized execution boundary.

R1 does not change credentials or egress to manufacture that evidence.

Current classification:

```text
LIVE_KIRO_SESSION_RESTORE=BLOCKED_OWNER_RUNTIME_GATE
```

---

## 18. Security conclusion

A8 R1 now separates five authorities that the original candidate conflated:

```text
authorization        → current trusted config on every dispatch
session admission    → atomic ACTIVE→RESERVED DB transaction
provider restoration → negotiated Kiro ACP session/load
provider persistence → dedicated binding-verified session-state volume
success authority    → atomic source-consume + successor-create + job-COMPLETED transaction
```

Session memory remains context only. It is never permission, apply authority, or filesystem truth. Current ODR-2 enforcement additionally records the trusted staged source revision and prevents mutating resume across revision drift; read-only drift remains context-only after fresh staging.

**Candidate status:** `PASS_CANDIDATE_FORWARD_INTEGRATION`; deterministic source qualification is green on the sole forward line. Immutable commit and bounded live Kiro `session/load` qualification remain separate gates.
