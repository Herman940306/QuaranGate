# QuaranGate — A8 Session Continuity Completion Validation

Historical source-candidate date: 2026-09-06
Forward integration branch: `integrate/quarangate-forward`
Forward pre-A8 base: `91cc72fa80e5eca75ff8c002c1d86f5dfa454abf`
Historical A8 lane/base: `lane/a8-session-continuity` / `9867cd66a451ec44bcd2e24d994e9aed78fb284f`
Role of this document: source/integration completion evidence; it does not claim independent reviewer or live-provider acceptance.

## Verdict

`PASS_CANDIDATE_FORWARD_INTEGRATION`

The A8 source candidate addresses the final narrow R3 post-COMMIT diagnostic ambiguity blockers and has now been integrated onto the accepted P1+U1 forward line. The combined source passes fresh A8, full-unit, U1/Console, typecheck, build, and diff checks. Live provider qualification remains separate and is explicitly not claimed here.

`LIVE_KIRO=NOT_QUALIFIED_ON_INTEGRATED_REVISION`

The live runtime remains at accepted P1 revision `b01015c4c2854881aeac7cab6e2caf45d978a75d`; this integrated A8 revision has not yet been frozen/deployed. Do not promote provider continuity as live-qualified until a bounded Kiro `session/new` then `session/load` resume qualification passes on the exact integrated revision under the governed runtime.

## Remediated review blockers

### 1. Provider restore protocol

A resume path uses the actual ACP restoration primitive:

```text
initialize
→ session/load
→ session/prompt
```

`session/new` is not called on resume. `AcpDriver.sessionLoad()` is capability-gated on `agentCapabilities.loadSession === true` and fails closed with `SESSION_NOT_RESUMABLE` for unsupported, empty, malformed, or rejected provider sessions.

### 2. Provider state durability

Kiro provider state is represented as a QuaranGate-managed Docker volume mounted only at:

```text
$KIRO_HOME/sessions/cli
```

The durable reference is stored in `agent_sessions.provider_state_ref`. It is not returned through public session/job reads. `kiroFactory.ts` passes the reserved session's `providerStateRef` back into `KiroBackend` as `providerStateVolume`, so resume has both the provider session id and the provider state volume. Existing provider-state volumes are verified by QuaranGate ownership labels and a trusted binding hash before reuse, so a volume bound to another principal/project/backend/profile fails closed.

### 3. Atomic resume reservation

Resume dispatch now uses `AgentJobStore.insertWithSessionReservation()` instead of a lookup followed by independent job insertion. The job row insert and `ACTIVE -> RESERVED` transition are committed in one `BEGIN IMMEDIATE` transaction.

Expected invariant:

```text
source ACTIVE
→ source RESERVED(job)
→ provider turn
→ source CONSUMED
→ successor ACTIVE
→ job COMPLETED and points to successor
```

### 4. True execution race

Execution no longer reads an ACTIVE-only provider token. It uses `getReservedProviderContext(sessionId, jobId)`, so only the job that owns the reservation can receive provider identity/state. If the reservation is mutated before execution, backend construction does not occur and the job fails closed.

### 5. Post-COMMIT success boundary

For atomic QuaranGate state transitions, `COMMIT` is the authoritative success boundary. A diagnostic or readback operation after a successful `COMMIT` must never convert committed success into application-level failure, alter session/provider lifecycle, or invalidate committed resources.

A8 R2 removes the two blocking readback seams:

- `insertWithSessionReservation()` no longer performs a required post-COMMIT job-row SELECT; it returns deterministic `QUEUED` job data from the generated job id, trusted request/policy data, transaction timestamp, and reserved source session id.
- `finalizeCompletedWithSession()` no longer performs a required post-COMMIT job-row SELECT; it returns deterministic `COMPLETED` job data built from the pre-COMMIT job row and completion input.

The deterministic R2 tests force `AgentJobStore.get()` to throw at the former readback seam and prove the committed result is still treated as success.

### 5b. R3 post-COMMIT diagnostic boundary

R3 adds a narrowly scoped `bestEffortLog()` helper in `jobEngine.ts`. It is
used only after a durable dispatch reservation commit or atomic completion
commit. It catches serialization/output failure without mutation, rethrowing,
or fallback logging. Pre-commit/provider logging still uses normal failure
semantics.

Deterministic tests make the finalization diagnostic, first dispatch
diagnostic, and second dispatch diagnostic throw independently. They prove:

- committed completion remains `COMPLETED`, with source `CONSUMED`, successor
  `ACTIVE`, and the job pointing to that successor;
- no session expiration, provider-state discard, or `failActive()` occurs after
  completion commit;
- both reservation diagnostics still return the committed `QUEUED` job with the
  source reserved by that exact job; and
- queue processing is kicked even when either diagnostic fails.

### 6. Atomic finalization

Successful completion is coordinated by `AgentJobStore.finalizeCompletedWithSession()`:

- source session consumption
- successor session creation
- job `backend_session_id` linkage
- job `VALIDATING -> COMPLETED`
- required completion metadata

These occur in one SQLite transaction. If successor creation or job completion fails, the source remains `RESERVED` and the job remains `VALIDATING`; no partial lineage is accepted.

For writer jobs, canonical artifact publication must already be `AVAILABLE` when `requireArtifact=true`, so resumable continuation is not made valid before artifact success.

### 7. Provider-advanced / DB-failed case

After provider use may have advanced conversation state, failure handling is fail-closed:

- resume source reservation is expired, not reactivated;
- backend `discardSessionState()` is invoked when available;
- no successor session is made active;
- failed job does not point at a fresh active continuation.

### 8. Double resume

Two dispatches racing for the same ACTIVE session are mediated by the atomic reservation primitive. The first dispatch reserves the source; the second fails closed with `SESSION_NOT_RESUMABLE` and does not insert a job row.

### 9. Cancellation and reservation cleanup

Queued/pre-provider cancellation releases the unused reservation back to `ACTIVE`. Active cancellation is fail-closed: if execution has reached `RUNNING` or `VALIDATING`, the source reservation is expired because provider state may already have advanced.

### 10. Restart reconciliation

`AgentJobEngine.recover()` now runs job recovery first and then `sessionStore.recoverReservations()` before queued work is allowed to execute. RESERVED sessions owned by still-QUEUED jobs are kept; leaked reservations owned by recovered/non-queued jobs are expired.

### 11. Authority isolation

Session state continues to carry identity/lifecycle only. Every dispatch still revalidates current trusted configuration before session lookup:

- principal ownership
- project availability
- backend availability and project allowance
- profile allowance
- resource policy
- writer classification from trusted profile config

Session rows do not grant apply, guarded-path exceptions, GitHub authority, Docker authority, network authority, backend authority, profile escalation, project access, or writer status.

## Forward integration reconciliation

The historical A8 base is an ancestor of the accepted forward line. Git three-way application cleanly reconciled 17 tracked paths. The only content overlap was `src/executor/agents/sandboxRunner.ts`: H1 had added managed-network orphan cleanup after the A8 base, while A8 added an explicit preserve set for ACTIVE/RESERVED provider-session state volumes. The integrated implementation preserves both controls. Six new A8 files were copied byte-identically from the requalified historical lane.

Fresh integrated validation returned:

```text
A8 focused:             10 files / 336 tests PASS
Full unit:              62 files / 2223 tests PASS
U1/Console focused:      5 files / 34 tests PASS
Typecheck:              PASS
Build:                  PASS
git diff --check:       PASS
```

The historical lane remains read-only evidence. `integrate/quarangate-forward` is the sole source-development line.

## Frozen validation protocol

This document is part of the final R3 candidate. The exact final validation counts and candidate hashes are captured in the handoff only after editing stops, so the reported tests run against the same source state as the candidate identity.

Required R3 evidence:

- focused A8/session/provider-state/ACP/Kiro suites;
- agent job engine/store/migration suites;
- startup/recovery suites;
- artifact/apply suites affected by finalization;
- full `npm test`;
- `npm run typecheck`;
- `npm run build`;
- `git diff --check`;
- `git status --short`;
- `git diff --cached --name-only`;
- repository-root fixture leak check for `generated.ts`, `target.ts`, and `keep.ts`.

## Environment note

The worktree's untracked `node_modules` symlink originally pointed at the host-absolute path `/home/herman/projects/QuaranGate/node_modules`. Inside the bounded review container that path does not exist, which caused the earlier ACP/runner harness failure before the new R3 assertions were reached. The auxiliary symlink was corrected to the relative target:

```text
node_modules -> ../QuaranGate/node_modules
```

That relative target resolves to the same dependency tree on both the host worktree layout and the review-container workspace layout. With that environment-only correction, the previously failing ACP/Kiro targeted suites pass without changing ACP/provider behavior. Classification: `ENVIRONMENTAL_TEST_HARNESS`, not an A8 source regression.

The symlink is untracked auxiliary test infrastructure only; it is not part of the A8 source candidate and must never be staged or committed.

## Not claimed

- No live Kiro provider resume qualification has been performed on the integrated revision.
- Historical note: at this validation point no owner approval of ODR-2 source-revision binding was implied. This is superseded by the later owner-approved hybrid ODR-2 policy and its bounded source remediation.
- No independent-review claim is made for this direct forward integration.
- Source validation does not substitute for the required live provider-restoration gate.

## Required next validation before promotion

Freeze and mechanically reverify the exact integrated 24-path candidate on `integrate/quarangate-forward`; after the immutable commit identity is proven, deploy that exact revision through the bounded owner-host path, then run live Kiro continuity proving a fresh `session/new` followed by `session/load`/`session/prompt` with zero `session/new` on resume and provider state surviving the governed lifecycle. ODR-2 is no longer an owner-policy decision: the hybrid policy is implemented in current source and documented in `A8_ODR2_SOURCE_REVISION_BINDING.md`. The live Kiro provider-restoration qualification remains a separate external/runtime gate.
