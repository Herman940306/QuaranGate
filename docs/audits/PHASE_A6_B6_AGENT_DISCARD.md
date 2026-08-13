# Phase A6-B6: `agent_discard` — Frozen Architecture

## Status

**ARCHITECTURE FROZEN — NOT YET IMPLEMENTED.**

This document is the canonical source of truth for activating `agent_discard`
— the last of A6's three named MCP tools, but (per §21, R3) **not** the last
of A6's full accepted scope; a separate, still-open resource-lifecycle
obligation from `PHASE_A6_B2_STAGED_BEFORE_CAPTURE.md` remains outstanding
independent of this document. It follows the same discipline
`PHASE_A6_B5_AGENT_APPLY.md` established — written by inspecting the actual
committed source (as of commit `427bea8fe0ecf5e171665b16836c4684375f6193`,
branch `main`) rather than assuming prior intent, with every claim about
"existing" behavior traced to an exact file/line.

---

## 1. Purpose

Activate `agent_discard`: let the owner of a `COMPLETED` job durably record
that its verified canonical artifact will **not** be applied. This is the
second of the two dispositions the public job-status state machine already
defines for `COMPLETED` jobs (`COMPLETED → APPLIED | DISCARDED`,
`src/shared/agents.ts:92`) — `agent_apply` (A6-B5) implemented the first;
this document specifies the second. Discard is a **logical, durable
disposition change only** — it records an intent and a terminal state; it
does not touch the registered project's filesystem, and (per §11) it does
not delete any evidence.

---

## 2. Authority / source hierarchy

1. **`MCP_IDE_BRIDGE_MASTER_PRD.md`** — the top-level roadmap. Its A6 entry
   (line ~1956, ~2939) is titled **"Review / apply / discard"** as ONE phase.
   The PRD does **not** define a B1–B6 sub-phase numbering; that numbering is
   an engineering-session convention visible only in `docs/audits/PHASE_A6_B*.md`
   filenames and cross-references (B1 persistence, B2 before-capture, B3
   canonical artifact, B4 diff, B5 apply). This document's "B6" label follows
   that same convention — it is not a PRD term. Per the governing instruction
   for this batch, this label must not be misattributed to the PRD, and it is
   not here.
2. **`CLAUDE.md`** (local, untracked, read for steering only) — describes A6
   as "phased: A1…A6" and lists `agent_diff`/`agent_apply`/`agent_discard` as
   the tool trio; states discard "remain[s] contract-only / in-progress."
3. **`docs/audits/PHASE_A6_B5_AGENT_APPLY.md`** — the direct sibling document
   this one follows in structure and discipline. Its item #7 (line 40) is the
   only place in the whole repository that uses the string "B6": *"`discardJob`
   — blocks discard while UNCERTAIN/active | VERIFIED EXISTING (B6 territory,
   out of scope here) | `jobStore.ts:880-906`"* — a passing annotation in a
   source-reconciliation table, not a frozen spec.
4. **Current source** — authoritative for everything already implemented
   (schemas, authz, the store primitive). Traced exactly in §4–§5.

No `PHASE_A6_B6*.md` or equivalent document existed before this one (verified
by directory listing, §3 of the discovery task that preceded this one).

---

## 3. Current repository checkpoint

```
HEAD:    427bea8fe0ecf5e171665b16836c4684375f6193
branch:  main
staged:  none
```

`git status --short` at the start of this task showed only the two known
unrelated untracked local paths, `.kiro/` and `CLAUDE.md`. This document is
the only file this task creates.

---

## 4. Source reconciliation

Classification legend (same as PHASE_A6_B5_AGENT_APPLY.md §1): **VERIFIED
EXISTING** (proven by reading the file) / **PARTIAL** / **NOT IMPLEMENTED**.

| # | Subsystem | Status | Evidence |
|---|---|---|---|
| 1 | Public job state machine `COMPLETED → DISCARDED` edge | VERIFIED EXISTING | `src/shared/agents.ts:92` |
| 2 | `AgentJobStore.discardJob(jobId)` — atomic disposition primitive | VERIFIED EXISTING, FROZEN | `jobStore.ts:935-961` |
| 3 | `agent_discard` Zod schemas (`agentDiscardInput`/`Output`) | VERIFIED EXISTING, FROZEN — `{jobId}` in, `{jobId, status}` out | `src/gateway/agentSchemas.ts:195-196` |
| 4 | `agent_discard` gateway authorization entry | VERIFIED EXISTING, FROZEN | `src/gateway/agentAuthz.ts:35,91,111,125` |
| 5 | `agent_discard` gateway tool registration | NOT IMPLEMENTED | `agentTools.ts` has no `agent_discard` entry (confirmed by its own header comment, line 6-7) |
| 6 | `agent_discard` executor route | NOT IMPLEMENTED | no `/agent/jobs/:id/discard` in `routes.ts` |
| 7 | `agent_discard` executor-client method | NOT IMPLEMENTED | no `agentJobDiscard` in `executorClient.ts` — `agentJobDiscard` is the ONE frozen name for the method to be added (frozen here, §5f, and used identically at §14/§15 below), matching its direct sibling `agentJobCancel(jobId, principal)` exactly, both in name shape and in positional `(jobId, principal)` call signature (`executorClient.ts:63-64`) |
| 8 | `AgentJobEngine.discard()` orchestration method | NOT IMPLEMENTED | no `discard` symbol in `jobEngine.ts` |
| 9 | `ARTIFACT_STATES` `'EXPIRED'` value | **DECLARED, NEVER SET** | `src/shared/agents.ts:235`; repo-wide grep found zero assignments — see §18 |
| 10 | Any TTL/purge/GC/quota mechanism | **NOT FOUND** | repo-wide grep for `TTL`, `purge`, `garbage.collect`, `GC`, `quota` — zero implementation hits outside comments |
| 11 | `agent_apply`'s `startApplyAttempt` "not COMPLETED" precedent | VERIFIED EXISTING, FROZEN — throws `PRECONDITION_FAILED` | `jobStore.ts:770-776`; relied on in §10 |

---

## 5. Existing discard primitives — exact current behavior

### 5a. `AgentJobStore.discardJob(jobId): boolean`

**PATH**: `src/executor/agents/jobStore.ts:935-961`
**SYMBOL**: `discardJob`
**CURRENT BEHAVIOR** (read directly from source, not assumed):

```
assertAgentJobTransition('COMPLETED', 'DISCARDED')   // static edge check — always true, see note below
BEGIN IMMEDIATE
  active := COUNT(agent_apply_attempts WHERE job_id=? AND state IN (STARTED,VERIFYING,APPLYING))
  if active > 0: throw APPLY_ATTEMPT_ACTIVE (409); ROLLBACK
  uncertain := COUNT(agent_apply_attempts WHERE job_id=? AND state = 'UNCERTAIN')
  if uncertain > 0: throw APPLY_ATTEMPT_UNCERTAIN (409); ROLLBACK
  res := UPDATE agent_jobs SET status='DISCARDED', disposition_at=now WHERE job_id=? AND status='COMPLETED'
COMMIT
return res.changes === 1
```

Note on the leading `assertAgentJobTransition` call: this checks the
*abstract* edge `COMPLETED → DISCARDED` is legal in the matrix (it always is
— it's a static, argument-independent check, not a check of the specific
job's current state). The specific job's actual current status is enforced
only by the `WHERE status = 'COMPLETED'` clause in the `UPDATE`. This means:

- If the job **is** `COMPLETED` at commit time: the row is updated, `changes
  === 1`, method returns `true`.
- If the job is in **any other status** (already `DISCARDED`, already
  `APPLIED`, or still active/failed) at commit time: the `UPDATE` matches
  zero rows, `changes === 0`, method returns `false`. **No exception is
  thrown for this case.**
- Never clears `agent_project_apply_state` — confirmed by the method's own
  docstring and by test `"discarding a job never clears an existing project
  quarantine"` (`tests/unit/agent-apply-state.test.ts:363-374`).

**WHETHER REUSABLE AS-IS**: Yes, verbatim. No change to this method is
authorized or needed.

**GAP**: The `false`-return path ("job wasn't COMPLETED") has no caller yet
to translate it into an MCP-facing error. This is exactly item #8's gap
(`AgentJobEngine.discard()` doesn't exist) and is resolved in §10.

### 5b. State machine

**PATH**: `src/shared/agents.ts:87-101`
**SYMBOL**: `AGENT_JOB_TRANSITIONS`, `assertAgentJobTransition`
**CURRENT BEHAVIOR**: `COMPLETED: ['APPLIED', 'DISCARDED']`; both `APPLIED`
and `DISCARDED` have zero outgoing edges (`isTerminalAgentJobStatus` returns
true for both). **REUSABLE AS-IS.** No gap.

### 5c. Schemas

**PATH**: `src/gateway/agentSchemas.ts:195-196`
**SYMBOL**: `agentDiscardInput`, `agentDiscardOutput`
**CURRENT BEHAVIOR**: `agentDiscardInput = z.object({ jobId }).strict()` —
identical shape to `agentCancelInput`/`agentApplyInput`. `agentDiscardOutput
= z.object({ jobId, status: jobStatus }).strict()` — **identical shape to
`agentCancelOutput`** (`agentSchemas.ts:181`), not to `agentApplyOutput`
(which additionally carries `project`/`appliedAt`). This is a frozen,
pre-existing signal that discard's *response contract* was designed to mirror
cancel's, not apply's. **REUSABLE AS-IS.**

### 5d. Authorization

**PATH**: `src/gateway/agentAuthz.ts:35,91,111,125,156-168`
**SYMBOL**: `AGENT_TOOL_REQUIRED_SCOPE.agent_discard`, `JOB_ADDRESSED`,
`authorizeAgentTool`
**CURRENT BEHAVIOR**: `agent_discard` requires scope `agents:dispatch` (not
`agents:apply`) + job ownership (`principalOwnsAgentJob`). It is listed in
`JOB_ADDRESSED`, so the ownership check runs, but the additional **current
project grant** check inside that block is explicitly gated to `tool ===
'agent_apply' || tool === 'agent_diff'` only (`agentAuthz.ts:164`) —
`agent_discard` is deliberately excluded. This is a frozen, deliberate
asymmetry: unlike apply/diff, discard does not re-check a live project grant.
This is consistent with discard never touching project content — it only
disposes of the job's own durable record. **REUSABLE AS-IS. This document
does not change agentAuthz.ts.**

### 5e. Gateway tool registration

**PATH**: `src/gateway/agentTools.ts:1-7` (module docstring), whole file
**CURRENT BEHAVIOR**: Six tools registered (`agents_list`, `agent_projects`,
`agent_dispatch`, `agent_status`, `agent_result`, `agent_diff`, `agent_apply`,
`agent_cancel` — eight, per the current file; the docstring's "six" is itself
now stale prose left over from A2, see §19) via `server.registerTool(...)`.
`agent_discard` has **zero** registration. **GAP — this is the primary
activation target.**

### 5f. Executor wiring

**PATH**: `src/executor/agents/routes.ts`, `src/gateway/executorClient.ts`,
`src/executor/agents/jobEngine.ts`
**CURRENT BEHAVIOR**: No `discard` route, no `agentJobDiscard` client method
(the one frozen name, §2), no `AgentJobEngine.discard()` method. **GAP** —
the exact three-file wiring gap B5 had before it existed (§1 items #15-17 of
`PHASE_A6_B5_AGENT_APPLY.md`), now on the discard side.

---

## 6. Missing activation path (summary of §5's gaps)

```
gateway: agentTools.ts     — register 'agent_discard' (NEW)
gateway: executorClient.ts — add discard client method (NEW)
executor: routes.ts        — add POST /agent/jobs/:id/discard (NEW)
executor: jobEngine.ts     — add discard(jobId, principal) method (NEW)
```

Every layer below the job-engine boundary (`AgentJobStore.discardJob`, the
state machine, the schemas, the authz matrix) is already frozen and requires
**zero** changes. This is a strictly narrower activation than B5's (which
also had to build a whole new mutation subsystem); B6 is wiring-only.

---

## 7. State-machine semantics — discard eligibility

### 7a. Eligible states

Only `COMPLETED` is eligible, enforced by `discardJob`'s `WHERE status =
'COMPLETED'` guard (§5a) — **not** by the leading
`assertAgentJobTransition` call, which is state-independent. Exact behavior
per state, verified against the transition matrix (`agents.ts:87-101`) and
`discardJob`'s guard:

| Current status | Discard result |
|---|---|
| `QUEUED` / `PREPARING` / `RUNNING` / `VALIDATING` | Refused — job not `COMPLETED` (§10 defines the exact error) |
| `COMPLETED`, no apply attempt | **Succeeds** → `DISCARDED` |
| `COMPLETED`, apply attempt active (`STARTED`/`VERIFYING`/`APPLYING`) | Refused — `APPLY_ATTEMPT_ACTIVE` (409) |
| `COMPLETED`, an apply attempt is `UNCERTAIN` | Refused — `APPLY_ATTEMPT_UNCERTAIN` (409) |
| `APPLIED` | Refused — not `COMPLETED` (§10) |
| `DISCARDED` (already) | Refused — not `COMPLETED` (§10; this is the double-discard case) |
| Any `FAILED_*` / `CANCELLED` | Refused — not `COMPLETED` (§10) |

### 7b. Apply interaction (required by task §6B)

- **Discard while no apply exists**: succeeds as in 7a.
- **Discard while apply attempt active**: refused, `APPLY_ATTEMPT_ACTIVE` —
  already implemented and tested (`agent-apply-state.test.ts:356-360`).
- **Discard while apply attempt uncertain**: refused,
  `APPLY_ATTEMPT_UNCERTAIN` — already implemented and tested
  (`agent-apply-state.test.ts:390-403`).
- **Discard after successful apply** (job is `APPLIED`): refused — not
  `COMPLETED`. Not separately tested today (job never reaches `APPLIED` in
  the existing discard test file), but mechanically identical to every other
  non-`COMPLETED` case; added to §16's test matrix.
- **Apply after discard**: **already implemented and tested** —
  `agent-apply-state.test.ts:571-573` proves `store.startApplyAttempt(...)`
  on a `DISCARDED` job throws `PRECONDITION_FAILED` (the job's status fails
  `startApplyAttempt`'s own `status !== 'COMPLETED'` guard,
  `jobStore.ts:770-776`). No new store-level behavior needed; §9 proves this
  holds under concurrency too.
- **Double discard**: refused — `discardJob`'s second call sees
  `status='DISCARDED' !== 'COMPLETED'`, `UPDATE` matches 0 rows, returns
  `false`. **Not yet tested at the store level** (gap, added to §16). The
  MCP-facing behavior for this case is resolved in §10.
- **Concurrent discard/apply requests**: proven safe in §9.

### 7c. Diff interaction

- **`agent_diff` before discard**: unaffected — works exactly as today.
- **`agent_diff` after discard**: **verified definitively, not hedged** —
  `REVIEWABLE_JOB_STATUSES` (`jobEngine.ts:104-106`) is `{COMPLETED, APPLIED,
  DISCARDED}` explicitly, and `diff()`'s guard (`jobEngine.ts:331-338`)
  requires `REVIEWABLE_JOB_STATUSES.has(job.status)` AND `artifactState ===
  'AVAILABLE'`. **`DISCARDED` is already, today, a reviewable status** — a
  discarded job's canonical artifact remains fully reviewable via
  `agent_diff` with zero change required. This is **existing B4 behavior,
  unmodified by B6** (§20: "no redesign of B4 agent_diff") — the frozen
  design already anticipated exactly this case.
- **Discarded artifacts remain reviewable/auditable**: **yes**, confirmed by
  the above, and consistent with §11 (discard never deletes evidence).

---

## 8. Authorization model (already frozen — restated for completeness)

- **Required scope**: `agents:dispatch` (not `agents:apply`) —
  `agentAuthz.ts:91`.
- **Job ownership**: exact principal match, no admin override —
  `principalOwnsAgentJob`, enforced via `JOB_ADDRESSED`.
- **Project grant**: **not required** — deliberately excluded from the
  extra check at `agentAuthz.ts:164` (§5d). A principal whose project grant
  was revoked can still discard a job it owns in that project (it cannot
  apply or diff it, but discarding is pure disposition of the principal's own
  job record).
- **Cross-principal refusal**: `FORBIDDEN_JOB` (403) — same mechanism as
  every other job-addressed tool, enforced twice (gateway `agentAuthz.ts` +
  executor `AgentJobEngine.getOwnedJob`, `jobEngine.ts:297-304`), matching
  the defense-in-depth pattern every other A6 tool uses.
- **Cross-project refusal**: not applicable — there is no project input to
  this tool at all (`agentDiscardInput` carries only `jobId`).

This document makes **no change** to `agentAuthz.ts`.

---

## 9. Discard/apply concurrency — hostile analysis

**Scenario under test** (from the governing instruction): does an
interleaving exist where either (a) a job ends up `DISCARDED` while a valid
apply can still mutate the project, or (b) an apply successfully lands after
discard became durable?

**PRIMARY INVARIANT: database transaction serialization, not process
topology.** The safety of this system must not rest on "there happens to be
only one Node.js process today" — that is a fact about the current
deployment, not a security property of the code. The actual security
invariant is that both operations are durable, transactionally-guarded state
machines, and SQLite's own write-transaction locking makes their relative
order — whichever order it turns out to be — always resolve to one of
exactly two safe outcomes.

**Mechanism proof, transaction-first:**

1. Both `discardJob()` (`jobStore.ts:938-960`) and `startApplyAttempt()`
   (`jobStore.ts:764-826`) open with `this.db.exec('BEGIN IMMEDIATE')`
   (confirmed at `jobStore.ts:938` and `jobStore.ts:764` respectively — every
   apply/discard-admission mutation in this store uses this same discipline,
   `grep -n "BEGIN IMMEDIATE" jobStore.ts` returns eight call sites, all
   guarding exactly this class of admission/disposition decision).
   `BEGIN IMMEDIATE` acquires SQLite's RESERVED lock **at the BEGIN
   statement itself**, not at the first write — meaning no other connection
   (or the same connection reused later) can open a second write transaction
   against this database until the first's `COMMIT` or `ROLLBACK`
   completes. This is a database-level mutual-exclusion guarantee that holds
   regardless of how many OS processes, threads, or connections exist; it is
   not contingent on this repository's current single-process deployment.
2. Because SQLite serializes writers this way, exactly two total orderings
   of a racing discard-request and apply-admission-request exist for the
   same job, and every possible timing collapses into one of these two —
   there is no third, partially-interleaved outcome, because a second
   `BEGIN IMMEDIATE` cannot proceed at all until the first transaction has
   fully committed or rolled back.

   **ORDER A — discard transaction wins:**
   ```
   discardJob() transaction:
     - COUNT active attempts (STARTED/VERIFYING/APPLYING) for this job -> 0
     - COUNT UNCERTAIN attempts for this job -> 0
     - UPDATE agent_jobs SET status='DISCARDED' WHERE job_id=? AND status='COMPLETED'
     - COMMIT                                            [job is now durably DISCARDED]

   startApplyAttempt() transaction (begins only after the above COMMITs):
     - SELECT * FROM agent_jobs WHERE job_id=?           [sees status='DISCARDED']
     - status !== 'COMPLETED' -> throw PRECONDITION_FAILED
     - ROLLBACK, zero rows inserted into agent_apply_attempts
   ```
   No apply attempt is ever admitted once discard has durably committed.

   **ORDER B — apply-admission transaction wins:**
   ```
   startApplyAttempt() transaction:
     - SELECT * FROM agent_jobs WHERE job_id=?           [sees status='COMPLETED']
     - project not QUARANTINED
     - INSERT INTO agent_apply_attempts (..., state='STARTED')
     - COMMIT                                             [attempt is now durably STARTED]

   discardJob() transaction (begins only after the above COMMITs):
     - COUNT active attempts (STARTED/VERIFYING/APPLYING) for this job -> 1
     - throw APPLY_ATTEMPT_ACTIVE
     - ROLLBACK, agent_jobs.status is never touched
   ```
   The job is never transitioned to `DISCARDED` while an apply attempt is
   active — proven by the same COUNT guard `discardJob()` already runs
   today, unmodified.
3. Both orderings are exhaustive precisely because `BEGIN IMMEDIATE`
   prevents any interleaving: whichever transaction acquires the RESERVED
   lock first runs to completion (COMMIT or ROLLBACK) before the second
   transaction's own `BEGIN IMMEDIATE` can even proceed past that statement.
   There is no window in which the second transaction can read state that
   the first has partially, but not durably, written.

**Current-runtime reinforcement (secondary, not load-bearing):** in the
present deployment, the job store is `node:sqlite`'s `DatabaseSync`
(`jobStore.ts:16,304`), a synchronous binding with no `await` inside either
method body, running in the executor's single Node.js process. This means
that today, the two transactions are additionally serialized by the JS event
loop itself before SQLite's own locking is ever even contended. This is
documented here as a **useful current-runtime fact**, not as the security
argument — per this reconciliation, if the executor were ever split across
multiple processes or given a threaded/async job store, step 1–3's
`BEGIN IMMEDIATE` proof continues to hold unchanged, whereas a proof resting
solely on single-threadedness would silently stop being true.

**ATOMICITY_VERDICT: SAFE — proven at the database-transaction layer.** No
remediation to `jobStore.ts` is required. This proof depends on one
structural fact that must hold for any future `AgentJobEngine.discard()`
implementation to inherit it: `discard()` must call `store.discardJob(jobId)`
as the **sole** mutating store call (no separate read-then-later-write split
across an `await` boundary that could straddle two transactions), exactly
mirroring how `apply()` calls `runApplyAttempt`, whose every state
transition is itself a single atomic store call. §15 enforces this in the
frozen method body.

---

## 10. Idempotency — resolved by direct precedent

**The exact question**: should a second `agent_discard` call against an
already-`DISCARDED` job return idempotent success, or a deterministic error?

**This is resolved by existing, accepted precedent — not invented here.**
A6-B5 already faced the structurally identical question for `agent_apply`
(repeat call after the job left `COMPLETED`) and `PHASE_A6_B5_AGENT_APPLY.md`
§4 records the accepted answer: *"A second `agent_apply` call against the
same job therefore hits `startApplyAttempt`'s COMPLETED check first and
throws `PRECONDITION_FAILED`."* This is a **non-idempotent, error-on-repeat**
design, already shipped and tested (`agent-apply-state.test.ts` covers
`startApplyAttempt` on a non-`COMPLETED` job throwing `PRECONDITION_FAILED`).

Applying the same precedent to discard: `AgentJobEngine.discard()` must,
after calling `store.discardJob(jobId)` and observing `false`, **re-fetch the
job and throw `PRECONDITION_FAILED`** with a message of the same shape
`startApplyAttempt` already uses (`jobStore.ts:771-775`): *"job ${jobId} is
${status}, not COMPLETED; discard may only be performed on a COMPLETED
job."* This single error covers double-discard, discard-after-apply, and
discard-of-a-still-active/failed job uniformly — **no new error code is
introduced** (§13 reuses `PRECONDITION_FAILED`, already in
`BridgeErrorCode`).

This is flagged here explicitly, with its reasoning shown, precisely so
Herman can override it if he disagrees — but it is not left as a silent
choice, and it is not logged as a blocking unresolved decision, because an
unambiguous accepted precedent for the identical structural question already
exists within the same phase.

---

## 11. Artifact/evidence retention — PRD reconciliation (R3, forensically traced)

### 11a. The exact PRD requirements (quoted, not paraphrased)

`MCP_IDE_BRIDGE_MASTER_PRD.md` line 2528 (Phase A5 deliverables): *"sandbox
remains after completion for review."*

`MCP_IDE_BRIDGE_MASTER_PRD.md` lines 2584-2590 (Phase A6, `agent_discard`
requirements): *"Must: leave live source unchanged; preserve minimum audit
evidence; remove sandbox according to retention rules."*

R0-R2 of this document asserted "logical disposition only, zero physical
deletion" without tracing these two PRD sentences against actual source. That
was an assumption, not a proof. This section replaces it with one.

### 11b. Three distinct resource types (previously conflated)

- **SANDBOX WORKSPACE** — the mutation-capable, disposable Docker volume a
  real Kiro implement job writes into (`workspaceVolumeName(jobId)`,
  `sandboxSpec.ts`/`sandboxRunner.ts`). Ephemeral by design; owned by the
  executor's job-execution machinery, never by any A6 tool.
- **CANONICAL REVIEW ARTIFACT** — the immutable manifest + change-set
  produced by B3's `constructArtifact` (`artifactConstructor.ts`), stored in
  the job's evidence volume. This is the sole authority `agent_diff` (B4)
  and `agent_apply` (B5) ever read from — never the workspace.
  Content-addressed, hash-verified on every read (`artifactReader.ts`).
- **AUDIT EVIDENCE** — the BEFORE snapshot (`beforeCapture.ts`) and POST
  snapshot (`postCapture.ts`) manifests + content blobs, stored in the SAME
  evidence volume as the canonical artifact (confirmed:
  `constructArtifact`'s call site passes `evidenceVolume:
  this.beforeCapture.evidenceVolume` — before-capture, post-capture, and the
  canonical artifact are co-located on one volume, not three).

The PRD's "sandbox" (11a) refers to the first of these three. Neither the
canonical artifact nor audit evidence is a "sandbox" in the PRD's sense —
they are what the sandbox's final state was *captured into* before the
sandbox itself was destroyed.

### 11c. Forensic resource-state trace (exact source, not inference)

Traced through `kiroBackend.ts` (the real, non-fake A4/A5 backend) and
`jobEngine.ts`'s orchestration (`jobEngine.ts:485-531`) for a real
write-mode (`implement`) job:

| State | Runner container | Proxy/networks | Home/control/secret volumes | Workspace volume | Evidence volume (BEFORE+POST+artifact) |
|---|---|---|---|---|---|
| A. Model execution finished (`backend.run()` returns; still `RUNNING`) | exists | exist | exist | exists | exists (BEFORE only) |
| B. Status → `VALIDATING` (`jobEngine.ts:488`, before `validate()` body runs) | exists | exist | exist | exists | exists (BEFORE only) |
| C. Canonical artifact finalized (`kiroBackend.ts:924`, inside `validate()`) | **already removed** (write-quiescence gate, `kiroBackend.ts:900-901`, runs *before* POST capture) | exist | exist | exists | exists (BEFORE+POST+artifact) |
| D. Immediately before `cleanup()` (`kiroBackend.ts:974`, `finally` about to run) | already removed | exist | exist | exists | exists (unchanged) |
| E. Immediately after `cleanup()` (`kiroBackend.ts:1248-1277` complete) | already removed | **removed** | **removed** | **removed** (`disposeWorkspace`, line 1273) | exists (unchanged) — the ONLY survivor |
| F. Status → `COMPLETED` (`jobEngine.ts:531`, strictly after `validate()` — which contains `cleanup()` — has returned) | gone | gone | gone | gone | exists |
| G. After `agent_diff` (B4) | gone | gone | gone | gone | exists (read-only; B4 creates only transient read-helper containers, torn down per-read) |
| H. After `agent_apply` (B5) | gone | gone | gone | gone | exists, **untouched** (mounted RO during apply; `runApplyAttempt`'s `finally` removes only the transient applier container + control volume, `PHASE_A6_B5_AGENT_APPLY.md` §18) |
| I. Proposed, after `agent_discard` (this document) | gone | gone | gone | gone | exists, **unchanged** (§5a — `discardJob()` is pure SQLite, zero Docker I/O) |

**Proof, not inference, of the load-bearing claim:** `jobEngine.ts:488`
transitions `RUNNING → VALIDATING`, THEN `jobEngine.ts:489` calls `await
backend.validate(...)`. `kiroBackend.ts`'s `validate()` body is exactly the
method containing the POST-capture/artifact-construction/`cleanup()`
sequence read directly at `kiroBackend.ts:883-976`, with `cleanup()`
(`kiroBackend.ts:1248-1277`, itself: *"Remove ALL job-scoped resources
(success / failure / timeout / cancel)"*) running unconditionally in that
method's `finally` block. `jobEngine.ts:531` (`step('VALIDATING',
'COMPLETED', ...)`) executes only after that `await` resolves. Therefore
**state E always precedes state F** — the workspace is destroyed *during*
`VALIDATING`, strictly before `COMPLETED` is ever reached, for every job
that reaches `COMPLETED` at all.

### 11d. Answering the central question directly

**Is a sandbox physically present when `agent_discard` can be called? NO —
proven, not assumed.** `AgentJobStore.discardJob()`'s own guard (§7) requires
`status === 'COMPLETED'`. By state F (proven above), the workspace volume,
runner container, proxy container, networks, home volume, control volume,
and secret volume are **all already gone** for every job whose status is
`COMPLETED`. There is no code path, timing window, or failure mode in which
a `COMPLETED` job still has a live sandbox — discard could never "remove" one
even if its own logic tried to, because §5a already proves `discardJob()`
does no Docker I/O, and this section now additionally proves there would be
nothing there to remove regardless.

### 11e. Reconciling this against the PRD's literal words

The PRD's A5 sentence ("sandbox remains after completion for review") and A6
sentence ("remove sandbox according to retention rules") describe a
lifecycle that **does not match** the accepted, shipped, frozen
architecture — not because of an unremarked implementation drift, but
because of an **explicit, documented, accepted design decision made across
three already-frozen phase gates**:

1. `kiroBackend.ts`'s own inline comments (tagged `A5` and `A6-B3`,
   `kiroBackend.ts:883-887,894-896`) state the reason directly: *"Done here
   (before cleanup disposes the workspace) so the evidence is captured even
   though A5 never applies it"* and *"construct the canonical artifact
   BEFORE cleanup disposes the workspace volume."* This is not silent
   drift — it is a stated, deliberate capture-then-destroy design, shipped
   as part of the already-accepted A5 and A6-B3 phase gates.
2. `docs/audits/PHASE_A6_B2_STAGED_BEFORE_CAPTURE.md` — an **already
   accepted, frozen** phase document — explicitly reframes the requirement
   in terms of evidence, not sandbox, and explicitly pre-answers B6's own
   central question. Quoted exactly (`PHASE_A6_B2_STAGED_BEFORE_CAPTURE.md`
   lines 224-226): *"Evidence retention / expiry / disposition lifecycle.
   Discarded work/evidence must remain reviewable according to retention
   policy. **Discard does NOT automatically delete evidence.**"* This is
   durable, approved project authority for B6's own specific behavior — not
   an assumption invented by this document. B6's "logical disposition only"
   design (§11c-11d, R0-R2) is not this document choosing a policy; it is
   this document correctly implementing a policy already fixed by an earlier
   accepted phase.
3. B4 (`agent_diff`) — already implemented, shipped, and accepted — reads
   **only** the canonical artifact; it has never had access to a live
   sandbox, because by the time any job is reviewable, none exists (state F
   onward, 11c). B4's acceptance is itself evidence that "review" now means
   "canonical-artifact review," not "live-sandbox review," in the project's
   real accepted architecture.

**What is NOT found**: no document explicitly says "PRD A5/A6's literal
sandbox-retention sentences are hereby superseded." The PRD's own text was
never amended to match the shipped architecture. This is the one genuine gap
this reconciliation surfaces — a **documentation** gap, not an
**implementation** or **security** gap: the technical decision is durable
and already approved (11e.1-11e.3 above); the PRD's prose describing it is
stale.

**Conclusion for B6 specifically**: no user-selectable decision blocks B6.
The question "should `agent_discard` delete anything physical" is answered
by 11e.2's direct quote from an already-accepted B2 decision, not by this
document. B6 does not need to, and must not, implement any physical deletion
— doing so would contradict the already-accepted B2 policy, not merely a
convention this document could have chosen differently.

**Conclusion beyond B6 (carried into §18/§21)**: the PRD's stale prose is a
symptom of a real, still-open item — B2's own "Next-Phase Obligations" list
a **retained-resource garbage collection/recovery** capability as a "future
A6 obligation," not yet built by any phase through B6. This is addressed in
§18 and changes the A6-completion verdict in §21 — but it is explicitly
**not** B6's obligation to resolve (B2 scoped it as a general A6 item, not a
specific sub-phase's), and does not block B6's own readiness.

---

## 12. Restart / recovery

- **Executor crashes during discard**: `discardJob()`'s entire mutation is
  one `BEGIN IMMEDIATE ... COMMIT` transaction (§5a). SQLite's transaction
  atomicity guarantees that on restart the job is either still `COMPLETED`
  (transaction never committed — client sees the original request fail, may
  safely retry) or already `DISCARDED` (transaction committed — a retry hits
  the double-discard path, §10, and gets a clear `PRECONDITION_FAILED`
  rather than a silent no-op). **No new recovery code is required** — unlike
  B5's apply, there is no multi-step "ambiguous mid-mutation" window here,
  because discard has no external side effect (no container, no filesystem
  write) that could land without a matching durable record. This is the
  fundamental reason B6 needs no analogue to B5's `agent_apply_journal` or
  `recoverApplyAttempts`.
- **Gateway loses the response after discard succeeds**: the client's retry
  is a second `agent_discard` call, which hits the double-discard path (§10)
  — a deterministic, safe, informative error, not data loss.
- **Same discard request retried**: identical to the above — safe by
  construction, not merely by convention.
- **Job already `DISCARDED` at startup**: no special handling needed; it's
  simply a terminal state like any other, unaffected by executor restart
  (verified today by test `"a restart after DISCARDED returns the original
  disposition_at unchanged"`, `agent-apply-state.test.ts:375-384`).
- **Apply-attempt state conflicts with discard at startup**: already fully
  handled by `recoverApplyAttempts()` (frozen B1 behavior, wired at
  `index.ts:107` per the R2 remediation of B5) — an `APPLYING` orphan found
  at startup becomes `UNCERTAIN` + project `QUARANTINED` before any new
  discard call could even be admitted (discard would then correctly hit
  `APPLY_ATTEMPT_UNCERTAIN`, §7b). No new interaction to design.

---

## 13. Error contract

All codes below **already exist** in `src/shared/errors.ts`
(`BridgeErrorCode`, lines 3-67). **No new error code is introduced by this
document.**

| Situation | Code | HTTP | Source |
|---|---|---|---|
| Caller doesn't own the job | `FORBIDDEN_JOB` | 403 | existing, reused (`agentAuthz.ts`, `jobEngine.ts:301`) |
| Missing `agents:dispatch` scope | `FORBIDDEN_SCOPE` | 403 | existing, reused (`agentTools.ts`'s `agentGuarded`) |
| Unknown job id | `UNKNOWN_JOB` | 404 | existing, reused (`jobEngine.ts:299`) |
| Job not `COMPLETED` (covers: still active, `FAILED_*`, `CANCELLED`, already `APPLIED`, already `DISCARDED` / double-discard) | `PRECONDITION_FAILED` | 409 | existing, reused — mirrors `startApplyAttempt`'s identical case (§10) |
| An apply attempt is active for this job | `APPLY_ATTEMPT_ACTIVE` | 409 | existing, reused verbatim (`discardJob` already throws this) |
| An apply attempt for this job is `UNCERTAIN` | `APPLY_ATTEMPT_UNCERTAIN` | 409 | existing, reused verbatim (`discardJob` already throws this) |
| Malformed request body/params | `MALFORMED_REQUEST` | 400 | existing, reused (route-level Zod validation, mirrors `cancelBody`) |
| Executor unreachable / infra failure | `DOCKER_UNAVAILABLE` / `INTERNAL` | 503/500 | existing, reused (gateway `call()` wrapper, `executorClient.ts:17-23`) |

No route for arbitrary reasons, host paths, or Docker controls is
introduced — the input contract remains exactly `{jobId}` (already frozen,
§5c).

---

## 14. End-to-end flow (authoritative)

```
gateway: authenticate → agents:dispatch scope → executor.agentJob(jobId, principal)
         [ownership enforced executor-side, mirrors agent_cancel exactly]
         → requireAgentAuthz({tool:'agent_discard', principal, job})
           [ownership only — no project-grant check, per §8]
         → executor.agentJobDiscard(jobId, principal)    [the ONE frozen client
           method name and call shape — positional args, mirroring
           agentJobCancel(jobId, principal) exactly, §5f/§15]
                                                    │
executor route POST /agent/jobs/:id/discard (re-validates principal, strict Zod body,
                                              mirrors POST /agent/jobs/:id/cancel exactly)
                                                    │
AgentJobEngine.discard(jobId, principal):
  1. job = getOwnedJob(jobId, principal)         [reuse — UNKNOWN_JOB / FORBIDDEN_JOB]
  2. ok = store.discardJob(jobId)                [reuse B1 EXACTLY — the sole mutating call,
                                                    atomic, proven race-free in §9]
  3. if not ok:
       current = store.get(jobId)                [re-read for an accurate message only —
                                                    NEVER retries the mutation, never treats
                                                    false as success — see invariant below]
       throw PRECONDITION_FAILED(
         `job ${jobId} is ${current.status}, not COMPLETED; discard may only be
          performed on a COMPLETED job`)          [§10 — mirrors startApplyAttempt's message shape]
  4. return store.get(jobId)!                     [status is now DISCARDED]
```

Steps 1–2 are the entire orchestration; there is no "verifying" phase, no
container, no artifact re-verification — discard never reads the artifact at
all. This is the simplest of the three A6 tools by a wide margin.

**Invariant governing step 3's re-read (the false-return mapping, resolved,
not hand-waved):** `store.get(jobId)` at step 3 is guaranteed to return a
row, never `undefined`, and this is a proven structural fact, not an
assumption papered over by a non-null assertion:

- Step 1 (`getOwnedJob`) already proved a row with this `jobId` exists at the
  time of that read (else it would have thrown `UNKNOWN_JOB` first).
- `agent_jobs` rows are **append-only** — confirmed by a repo-wide search
  (`grep -rn "DELETE FROM agent_jobs" src/`) returning **zero** matches. No
  code path anywhere in this codebase ever deletes a job row; only its
  `status` (and a small number of other columns) can change via `UPDATE`.
- Therefore a row proven to exist at step 1 cannot have disappeared by step
  3 — it can only have changed `status`, which is exactly the value step 3
  needs to report.
- Given this, step 3's re-read may use a direct dereference
  (`store.get(jobId)!`) exactly as step 4 already does, but the invariant
  making that safe is now stated explicitly rather than left implicit. If
  this invariant were ever violated by a future change (e.g. a retention/GC
  feature that physically deletes old job rows — explicitly out of scope
  today per §18), the correct fail-closed response would be to throw the
  existing `INTERNAL` code (`src/shared/errors.ts`) rather than dereference
  a missing row — the implementation must add that explicit guard at the
  same time any such future deletion capability is introduced, not before.

---

## 15. Implementation file plan (bounded — the ONE authorized changed-path set for the eventual implementation task)

### EXPECTED_PRODUCTION_CHANGES (exactly four files, no others)

```
src/executor/agents/jobEngine.ts
  + discard(jobId, principal) method (§14) — mirrors apply()'s/diff()'s
    shape (getOwnedJob, one call into the store, typed throw); imports
    nothing new.

src/executor/agents/routes.ts
  + POST /agent/jobs/:id/discard — mirrors POST /agent/jobs/:id/cancel
    EXACTLY (same body shape { principal }, same jobWire() response
    pattern, same requireJobId()/cancelBody-style Zod validation — a
    sibling discardBody = z.object({ principal: principalSchema }).strict()
    reusing the existing principalSchema constant already in this file).

src/gateway/executorClient.ts
  + agentJobDiscard(jobId, principal) client method — mirrors
    agentJobCancel exactly (GET-free, single POST, returns
    { job: AgentJobWire }, same call<T>() wrapper).

src/gateway/agentTools.ts
  + agent_discard registration — mirrors agent_cancel's registration block
    exactly, using a new DISCARD annotation constant (see below);
  + corrects its own header docstring (lines 1-7) to state agent_discard is
    now activated (the "A2 activated the first six" prose is already stale
    independent of B6 — correct it in the same edit since this file is
    already being touched).
```

**Annotation constant** (part of the `agentTools.ts` change above):
`agentTools.ts` currently defines `READ`, `WRITE`, `CANCEL`, `APPLY` (lines
33-38). Discard is, like cancel, a one-time irreversible terminal disposition
with **no host mutation** (unlike apply, which is `destructiveHint: true`
because it writes to the real project). Define:

```ts
/** Discard permanently records a job's artifact as not applied (no host mutation). */
const DISCARD = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
```

— the same shape as `CANCEL`, defined as its own named constant (not a reuse
of `CANCEL`'s own binding) to keep the existing one-constant-per-verb
convention intact.

### EXPECTED_TEST_CHANGES (exact paths, no "or" choices)

**`tests/unit/agent-apply-state.test.ts`** (already owns all `discardJob`
store-level coverage — §5a, confirmed by its existing "A6-B1 atomic
success / discard primitives" and "A6-B1 UNCERTAIN blocks discardJob"
`describe` blocks):
- STORE: `discardJob` on an already-`DISCARDED` job returns `false` (double
  discard) — new.
- STORE: `discardJob` on an `APPLIED` job returns `false` — new.
- (Reconfirm only, no new assertions needed) `COMPLETED → DISCARDED`
  success; active-apply refusal; uncertain-apply refusal; quarantine
  untouched by discard; restart preserves `DISCARDED` + `dispositionAt`.

**`tests/unit/agent-authz.test.ts`** (already owns `agent_discard` authz
coverage — confirmed existing test `"discard requires agents:dispatch, not
agents:apply"`):
- AUTHZ: new test proving `agent_discard` is allowed even when the
  principal's project grant has been revoked, asserting the deliberate
  no-project-check asymmetry documented in §8.

**`tests/unit/a6-b6-agent-discard.test.ts`** (**NEW FILE** — the exact same
one-file-per-audited-B-phase convention `a6-b4-agent-diff.test.ts` and
`a6-b5-apply-engine.test.ts` already establish; constructs `AgentJobEngine`
directly against an in-memory `AgentJobStore(':memory:')`, exactly like
`a6-b4-agent-diff.test.ts`'s `engineFor()` helper — no Docker, no
`FakeApplierIO`, needed anywhere in this file):
- ENGINE: successful discard path through `AgentJobEngine.discard()`.
- ENGINE: unknown job → `UNKNOWN_JOB`.
- ENGINE: non-owner → `FORBIDDEN_JOB`.
- ENGINE: wrong state, one test per state (still active in each of
  `QUEUED`/`PREPARING`/`RUNNING`/`VALIDATING`, each `FAILED_*` code,
  `CANCELLED`, `APPLIED`, already `DISCARDED`) → `PRECONDITION_FAILED` with
  the exact message shape from §14 step 3. `APPLIED` and already-`DISCARDED`
  are reached via `store.markApplySuccess(...)` / `store.discardJob(...)`
  called directly before invoking `engine.discard()` a second/conflicting
  time — no Docker needed, mirroring how `agent-apply-state.test.ts` already
  drives these states directly through the store.
- ENGINE: active apply attempt (via `store.startApplyAttempt(...)`, left in
  `STARTED`/`VERIFYING`/`APPLYING`) → `APPLY_ATTEMPT_ACTIVE`.
- ENGINE: uncertain apply attempt (via `store.startApplyAttempt(...)` +
  `store.transitionApplyAttempt(...)` + `store.recoverApplyAttempts(...)`,
  exactly the sequence `agent-apply-state.test.ts` already uses) →
  `APPLY_ATTEMPT_UNCERTAIN`.
- **WIRING (gateway handler → executor client → HTTP → executor route →
  engine), real end-to-end, zero mocking — this is the primary new coverage
  this R2 revision adds, and it is REQUIRED, not waived by precedent.**
  Historical absence of route tests for the eight already-live agent tools
  is *not* evidence this activation path is correct — it is exactly the gap
  R2 closes for the newly-added wiring specifically, without expanding scope
  to retrofit the other eight tools.

  **Mechanism (one harness, reused by every sub-bullet below — uses only
  already-exported production functions and already-present dependencies;
  introduces no production test-only API):**
  1. In a `beforeAll`, build a real, Docker-free executor HTTP server:
     `express()` + `express.json()` + an internal-token check middleware +
     a local `handle()` response wrapper — both pieces are a direct,
     literal replication of `src/executor/index.ts:131-152` (11 lines of
     pure boilerplate: await the promise, JSON-respond, or map a
     `BridgeError` via the already-exported `asBridgeError` to
     `{status, body}` — not a new pattern, the existing one copied
     verbatim) — then `registerAgentRoutes(app, handle, () => engine)`
     where `engine` is a real `AgentJobEngine` constructed against a real
     `AgentJobStore(':memory:')` (the same construction
     `a6-b4-agent-diff.test.ts`'s `engineFor()` helper already uses).
  2. `app.listen(0)` on an OS-assigned ephemeral port (read back via
     `server.address()`).
  3. Set `process.env.INTERNAL_TOKEN` to a fixed test value and
     `process.env.EXECUTOR_URL` to `http://127.0.0.1:<assigned port>`
     **before** the first import of `src/gateway/executorClient.js`
     anywhere in this test file (that module reads both env vars into
     top-level `const`s at first import — this ordering is a hard
     requirement of the mechanism, not an implementation detail to
     rediscover later; use a `beforeAll`-scoped dynamic
     `await import('../../src/gateway/executorClient.js')` and the same
     for `agentTools.js`, exactly because both must observe the env vars
     already set).
  4. Register tools against a `fakeServer` capturing handlers (the same
     `captureTools()` pattern `a6-b4-agent-diff.test.ts:1115-1122` already
     uses) using the dynamically-imported `registerAgentTools`.
  5. Establish principal context with the real, already-exported
     `withPrincipal()` (`src/gateway/context.js`) — the actual production
     mechanism `agentGuarded()` reads via `currentPrincipal()`, not a
     test-only substitute.
  6. Invoke the captured `agent_discard` handler directly inside
     `withPrincipal(principal, () => handler({jobId}))`.

  This one harness proves, for real, with no mock anywhere in the chain:
  - **(A) Gateway → client boundary**: the handler's only path to a result
    is through the real `executorClient.agentJobDiscard(jobId, principal.id)`
    making a real HTTP call — assert the final `structuredContent` reflects
    the real store's post-discard state, which is only reachable if exactly
    `{jobId, principal}`-shaped data reached the executor (no host path,
    project field, artifact id, or Docker option is expressible in the
    handler's own input type to begin with, per §5c/§13, but this proves the
    *whole path*, not just the type).
  - **(B) Client HTTP request**: `agentJobDiscard`'s real
    `POST /agent/jobs/:id/discard` traverses a real loopback socket; two
    further sub-tests issue a raw `undici.request()` (already a project
    dependency, the same library `executorClient.ts` itself uses) directly
    against the test server — **bypassing the gateway entirely** — to prove
    the executor route's *own* independent strict Zod validation, per
    CLAUDE.md's "executor routes validate every payload ... never trust the
    gateway":
    - a body missing `principal` → `MALFORMED_REQUEST`;
    - a body with a **valid** `principal` **plus one unexpected extra
      property** (e.g. `{ principal: 'p', extra: 'x' }`) →
      `MALFORMED_REQUEST` — this is the specific assertion that proves the
      new `discardBody` schema (§15's production-changes list) is declared
      `.strict()`, mirroring `cancelBody`'s existing `.strict()` shape
      exactly, not merely "has a required field."
  - **(C) Route → engine**: the real Express route, installed by the real
    `registerAgentRoutes`, parses `req.params.id`, validates the body,
    calls the real `AgentJobEngine.discard()`, and returns `jobWire(...)` —
    asserted by reading the underlying real `AgentJobStore`'s `get(jobId)`
    directly after the HTTP round-trip completes and confirming
    `status === 'DISCARDED'`.
  - **(D) Broken wiring fails a test, by construction, not by a
    hand-written negative-path check**: because every layer is real, a
    wrong URL means a real 404 from Express; a wrong HTTP verb means the
    real router doesn't match the route at all; a wrong body field means
    the real strict Zod schema rejects it; a route that called the wrong
    engine method would leave the real store's job status unchanged from
    what the test asserts. There is no separate "wrong-wiring" test to
    write — every wiring mistake independently breaks one of (A)-(C)'s
    existing assertions.

  No `vi.mock` is used for this mechanism (unlike the one existing
  precedent in `a6-b2-before-capture.test.ts`, which mocks Docker) —
  everything here is real, in-process, Docker-free infrastructure, which is
  possible specifically because discard (unlike apply) never touches Docker
  at all.
- GATEWAY REGISTRATION/SCHEMA: `registerAgentTools(fakeServer)` structural
  check that `agent_discard` is present with the `DISCARD` annotation
  (non-`readOnlyHint`) — mirrors the existing "A6-B4 public tool
  registration" block in `a6-b4-agent-diff.test.ts:1115-1120` exactly. This
  may reuse the same dynamically-imported `registerAgentTools` from the
  WIRING mechanism above, or a plain static import — either is equivalent
  for this purely structural assertion since it does not call the handler.
- GATEWAY REGISTRATION/SCHEMA: `agentDiscardInput`/`agentDiscardOutput`
  strict-schema unknown-property rejection — reuses the existing
  schema-strictness pattern already applied to every other tool in
  `agent-schemas.test.ts`. **Frozen location: this file
  (`tests/unit/a6-b6-agent-discard.test.ts`), not `agent-schemas.test.ts`**
  — every other discard-specific assertion already lives here, and this
  keeps all discard-specific coverage in the one file this document names.
- LIFECYCLE MATRIX: diff → discard (assert `agent_diff`'s current behavior
  is unchanged post-discard, per §7c's proof that `DISCARDED` is already
  reviewable — do not change that behavior, only assert it).
- LIFECYCLE MATRIX: discard → diff (same assertion, reverse order).
- LIFECYCLE MATRIX: discard → apply — engine-level reconfirmation of the
  already-store-level-proven fact (`agent-apply-state.test.ts:571-573`):
  `engine.discard()` then `engine.apply()` asserts `PRECONDITION_FAILED`.
- LIFECYCLE MATRIX: apply → discard — drive the job to `APPLIED` via
  `store.markApplySuccess(...)` directly (the same store primitive
  `agent-apply-state.test.ts`'s own "atomically stores APPLIED" test uses,
  no Docker required), then `engine.discard()` asserts
  `PRECONDITION_FAILED`.
- LIFECYCLE MATRIX: discard twice — `engine.discard()` then `engine.discard()`
  again, assert the second call's exact `PRECONDITION_FAILED` message.
- LIFECYCLE MATRIX: apply active → discard — `store.startApplyAttempt(...)`
  then `engine.discard()`, assert `APPLY_ATTEMPT_ACTIVE` (engine-level
  reconfirmation of the existing store-level test).
- LIFECYCLE MATRIX: apply uncertain → discard — same pattern, assert
  `APPLY_ATTEMPT_UNCERTAIN`.
- RESTART/DURABILITY (engine-level only — store-level restart coverage
  already lives in `agent-apply-state.test.ts` and needs no B6 addition):
  repeated `engine.discard()` call after a job is already durably
  `DISCARDED` returns the same deterministic `PRECONDITION_FAILED` (proves
  "lost response, client retries" is safe, no duplicate side effect);
  `store.recoverApplyAttempts(...)` producing an `UNCERTAIN`+quarantined
  attempt followed by `engine.discard()` asserts `APPLY_ATTEMPT_UNCERTAIN`
  (proves no accidental disposition change across a simulated restart
  boundary).

### EXPECTED_B6_INLINE_DOC/COMMENT_CHANGES

```
src/gateway/agentTools.ts (lines 1-7)
  Part of the SAME edit as its production change above (§15's first list) —
  not a separate task. Corrects "agent_discard remains CONTRACT-ONLY" to
  describe it as activated.
```

**`src/gateway/mcp.ts:272`'s stale inline comment is explicitly OUT of B6's
scope** (resolves this document's internal §3/§19 contradiction in favor of
the narrower reading): `mcp.ts` requires **zero functional change** for
`agent_discard` to work — `registerAgentTools(server)` already delegates
everything, and once `agentTools.ts` registers `agent_discard`, `mcp.ts`
needs no edit for correctness. Its one-line comment ("agent_diff / agent_apply
/ agent_discard remain contract-only until A6") is broad phase-status prose
of the exact kind §21's A6 closeout gate exists to reconcile in one bounded
pass across `AGENT_CONTROL_PLANE.md`/`ARCHITECTURE.md`/`SECURITY.md`/
`mcp.ts` together — fixing it piecemeal during B6 while leaving the other
three stale would be inconsistent. `mcp.ts` is therefore **not** in
`EXPECTED_PRODUCTION_CHANGES` and **not** touched by B6 implementation at
all; see the corrected §19 table.

### EXPLICITLY_EXCLUDED_PATHS

`src/executor/agents/jobStore.ts`, `src/shared/agents.ts`,
`src/shared/errors.ts`, `src/gateway/agentAuthz.ts`,
`src/gateway/agentSchemas.ts`, `src/executor/agents/applyEngine.ts`,
`src/executor/agents/sandboxSpec.ts`, `src/executor/index.ts`,
`src/gateway/mcp.ts` (see above), `tests/unit/agent-jobstore-migration.test.ts`
(no schema change — §5, §18), `tests/integration/a6-b5-apply.test.ts` (B5
regression only, unmodified), any file under `docs/` other than this
document's own future as-built reconciliation, `.kiro/`, `CLAUDE.md`.

---

## 16. Test matrix

This section is now fully absorbed into §15's `EXPECTED_TEST_CHANGES` (exact
file, exact coverage, no implementation-time choices remain). It is retained
here only as the flat category checklist §16 was required to provide, cross-
referencing §15 for the authoritative exact-path detail:

- **STORE** → `tests/unit/agent-apply-state.test.ts` (§15)
- **AUTHZ** → `tests/unit/agent-authz.test.ts` (§15)
- **ENGINE** → `tests/unit/a6-b6-agent-discard.test.ts` (§15)
- **ROUTE / WIRING** → `tests/unit/a6-b6-agent-discard.test.ts` — real,
  Docker-free, unmocked end-to-end HTTP mechanism (§15's WIRING bullet); NOT
  waived by the absence of route tests elsewhere in the repository
- **GATEWAY REGISTRATION/SCHEMA** → `tests/unit/a6-b6-agent-discard.test.ts` (§15)
- **LIFECYCLE MATRIX** → `tests/unit/a6-b6-agent-discard.test.ts` (§15)
- **RESTART/DURABILITY** → split: store-level already covered in
  `agent-apply-state.test.ts` (reconfirm only); engine-level new coverage in
  `tests/unit/a6-b6-agent-discard.test.ts` (§15)

**REGRESSION (unchanged baselines to reconfirm, matching the R3 pattern)**
- `tests/unit/a6-b5-apply-policy.test.ts` — 126/126
- `tests/unit/a6-b4-agent-diff.test.ts` — 165/165
- `tests/unit/a6-b5-apply-engine.test.ts` — 59/59
- `tests/integration/a6-b5-apply.test.ts` — 12/12
- Full unit suite — 1005/1005 baseline (plus whatever B6 adds)
- `npm run typecheck`, `npm run build`
- `git diff --cached --check` **on the STAGED set, before commit
  authorization** — the exact lesson recorded in the prior task's
  `FINAL_NOTES`: untracked new files are invisible to a plain
  `git diff --check`; this document itself, plus every new B6 file, must be
  staged first and checked with `--cached` before any commit is authorized.

---

## 17. Security invariants

- Discard never grants any host filesystem access, Docker capability, or
  artifact byte access it didn't already have — it is pure SQLite
  disposition state (§11).
- Discard can never race an apply into an unsafe terminal state (§9, proven,
  not assumed).
- Discard's input contract (`{jobId}` only) makes host-path/Docker-option/
  artifact-id injection structurally inexpressible, identical to apply's
  already-accepted contract.
- No raw prompt text is read, logged, or returned by any part of this flow
  (discard never touches `agent_jobs.prompt` at all).
- Audit: `agentGuarded()`'s existing bounded-identifier discipline
  (`{reqId, principal, tool:'agent_discard', jobId, decision, code?,
  durationMs}`) applies unchanged — no new audit field is needed since
  discard carries no project/artifact-hash/attempt identity worth recording
  beyond the job id and outcome.

---

## 18. Retention / GC / quota reconciliation (R3-corrected — absence of
## implementation is not evidence of supersession)

R0-R2 of this document labeled several of these items "SUPERSEDED HISTORICAL
PLAN" or "NOT FOUND / OUTSIDE B6" solely because no implementation exists.
Per §11e, that reasoning was wrong for at least one of them: B2's own
accepted architecture document explicitly carries these forward as **open,
still-binding future obligations**, not abandoned plans. Corrected,
evidence-backed classification:

| Mechanism | Classification | Evidence |
|---|---|---|
| `ArtifactState.EXPIRED` | **DECLARED BUT UNUSED** (not "superseded" — no document ever withdrew it) | `shared/agents.ts:235` declares it; repo-wide search finds zero assignments in `src/`. Not required for B6 specifically: `discardJob()`/`discard()` never read `artifactState` (§14). Whether it is ever needed is tied to item 3 below, not decidable by B6 alone. |
| `retentionClass` (`ephemeral`/`short`/`audit`) runtime consumption | **DECLARED ONLY** | Exists in exactly two places, both declarations: `agentConfig.ts:77` (Zod schema field on a resource *policy*) and `shared/agents.ts:304` (the `AgentResourceLimits` interface field). Confirmed by repo-wide search: never read by `createVolume`, `removeVolume`, `cleanup()`, `disposeWorkspace()`, `reconcileOrphans()`, or anywhere in `jobStore.ts`/`jobEngine.ts`. **Not even persisted per-job** — `agent_jobs.resource_policy` stores only the policy's string *id* (e.g. `"economy"`), never the resolved `retentionClass` value (`jobStore.ts:504-507`). |
| Actual TTL durations | **NOT FOUND** | No mapping from `ephemeral`/`short`/`audit` to any concrete duration exists anywhere in source. |
| Retention scheduler | **NOT FOUND** | No `setInterval`/cron/scheduled task of any kind touches volume or evidence lifecycle anywhere in `src/`. |
| Restart-safe expiry | **NOT FOUND** | No expiry-on-restart logic exists; `recoverApplyAttempts()` (B1) reconciles *apply-attempt* state on restart, never evidence/artifact retention. |
| Quota enforcement | **NOT FOUND** | No quota mechanism exists anywhere in the agent subsystem. |
| Evidence/artifact volume disposal ("Discard does NOT automatically delete evidence") | **IMPLEMENTED** (as a *policy*, correctly honored by B6's own design) | `discardJob()` (§5a, §11c) performs zero Docker I/O; B6's design in §11 correctly implements this, matching the accepted B2 policy quoted in §11e.2 verbatim. |
| **Retained-resource garbage collection/recovery** ("must distinguish legitimate evidence from abandoned/incomplete resources") | **REQUIRED BY MASTER PRD (indirectly) / DEFERRED BY ACCEPTED B2 ARCHITECTURE, STILL OUTSTANDING** | `docs/audits/PHASE_A6_B2_STAGED_BEFORE_CAPTURE.md` lines 214-228, "Next-Phase Obligations" item 6, quoted exactly: *"Retained resource garbage collection/recovery must distinguish legitimate evidence from abandoned/incomplete resources."* Listed there as a **future A6 obligation, explicitly not a B2 defect** — and no B3, B4, B5, or B6 (this document) implements it. This is the one item this reconciliation confirms is genuinely still open, not resolved and not superseded. |
| Evidence/artifact volume TTL/expiry lifecycle generally | **REQUIRED BY MASTER PRD (indirectly) / DEFERRED, STILL OUTSTANDING** | Same B2 document, same "Next-Phase Obligations" list, item 4: *"Evidence retention / expiry / disposition lifecycle."* Same status as above — open, not superseded, not owned by any shipped phase through B6. |

**Conclusion, corrected from R0-R2**: B6 (activating `agent_discard`'s
wiring) requires **zero** new deletion, GC, TTL, or quota mechanism, and its
own "no physical deletion" design is not merely convenient — it is the
already-accepted B2 policy, correctly carried forward. **This is a narrower
claim than R0-R2's**, which is corrected: the *general* retention/GC/TTL/quota
obligation is **not resolved and not superseded** — it remains an explicitly
acknowledged, still-outstanding requirement from an already-accepted phase
document, owned by A6 as a whole rather than by any single B-phase,
including this one. See §21 for how this changes the A6-completion verdict.

---

## 19. Stale documentation inventory (reported, not modified — per this task's read-only scope)

| Location | Stale claim | Classification |
|---|---|---|
| `.kiro/steering/product.md:30` | "Current phase: A5 — Kiro sandbox implementation (A0–A4 complete/PASS)" | LEAVE UNCHANGED — `.kiro/` is explicitly out of scope for any A6 batch; not a project-authoritative doc (confirmed stale relative to A0-A5 already, unrelated to B6 specifically) |
| `.kiro/steering/structure.md:60` | audits comment scoped to "(A0–A5)" | LEAVE UNCHANGED — same reasoning |
| `docs/AGENT_CONTROL_PLANE.md:7` | "agent_diff, agent_apply, agent_discard remain contract-only until A6" | UPDATE DURING A6 CLOSEOUT — broad phase-status prose, not something B6 implementation directly falsifies mid-batch; correct once all three are live |
| `docs/ARCHITECTURE.md:102` | same "contract-only until A6" wording | UPDATE DURING A6 CLOSEOUT — same reasoning |
| `docs/SECURITY.md:58` | "apply lands in A6 ... agent_diff/agent_apply/agent_discard stay unregistered" | UPDATE DURING A6 CLOSEOUT — same reasoning |
| `src/gateway/mcp.ts:272` | inline comment "// agent_diff / agent_apply / agent_discard remain contract-only until A6." | UPDATE DURING A6 CLOSEOUT — **resolved (was self-contradictory in an earlier draft of this document, corrected in R1):** `mcp.ts` requires zero functional change for `agent_discard` to work (`registerAgentTools(server)` already delegates everything), so it is explicitly excluded from §15's `EXPECTED_PRODUCTION_CHANGES`/`EXPECTED_B6_INLINE_DOC_CHANGES`. Its one-line comment is the same class of broad phase-status prose as the three `docs/` rows above and is grouped with them for the same one-bounded-pass A6-closeout correction, rather than fixed piecemeal mid-B6 while its three siblings remain stale |
| `src/gateway/agentTools.ts:1-7` | header docstring says "A2 activated the first six" (now eight are registered before B6, nine after) and (until B6 ships) still correctly says discard is contract-only | **UPDATE DURING B6 IMPLEMENTATION** — already in §15's file list; the docstring must be corrected as part of that same edit, not deferred |

---

## 20. Explicit non-goals

- No A7 GitHub Copilot backend work.
- No A8 session continuity work.
- No A9 production hardening expansion.
- No `io.mcp-bridge.*` / `io.mcp-ide-bridge.*` label namespace housekeeping
  (pre-existing, logged, deferred issue — unrelated to discard).
- No retention/GC/quota system (§18 — none required).
- No physical evidence deletion of any kind (§11).
- No redesign of B4 `agent_diff`.
- No redesign of B5 `agent_apply`.
- No change to `AgentJobStore.discardJob`, the state machine, the schemas,
  or `agentAuthz.ts` — all four are frozen and reused verbatim.
- No source changes during this architecture-freeze task itself.
- No push, no commit, no staging performed by this task.

---

## 21. A6 closeout criteria (verdict corrected in R3)

**Does delivering B6 satisfy the remainder of A6 ("Review / apply /
discard")?**

```
A6_COMPLETE_AFTER_B6: NO
```

**This is a correction from R0-R2's "YES."** `agent_diff` (B4),
`agent_apply` (B5), and `agent_discard` (B6) are indeed the PRD's entire
named A6 *tool* scope, and B6 fully activates the third tool. But §18's
corrected reconciliation shows the PRD's A6 section and the already-accepted
`PHASE_A6_B2_STAGED_BEFORE_CAPTURE.md` both carry a **resource-lifecycle**
obligation — retained-resource garbage collection/recovery, and the general
evidence retention/expiry/disposition lifecycle — that is **explicitly still
open**, not resolved by B4, B5, or this document. Shipping three working
tools is not the same as satisfying A6's full accepted scope, because B2's
own accepted architecture already defined that scope to include this
resource-lifecycle work, independent of any single tool's wiring.

**Exact remaining A6 requirement** (quoted from the one durable source that
defines it, not invented here): *"Retained resource garbage
collection/recovery must distinguish legitimate evidence from
abandoned/incomplete resources"* and *"Evidence retention / expiry /
disposition lifecycle"* (`PHASE_A6_B2_STAGED_BEFORE_CAPTURE.md`, Next-Phase
Obligations items 4 and 6). No B-phase number is invented for this here —
B2 itself scoped it as a general A6 obligation, not a specific numbered
sub-phase, and this document does not assign it one either.

Once B6 is implemented and its own gates pass, a future **A6 closeout gate**
should verify:

1. **Full review/apply/discard disposition matrix** — every cell of §7's and
   §16's lifecycle matrix passes, end to end, through the real MCP tool
   surface (not just store-level).
2. **Stale documentation reconciliation** — every row in §19 marked "UPDATE
   DURING A6 CLOSEOUT" is corrected in one bounded pass, **including now the
   PRD's own A5/A6 sandbox-retention sentences** (§11e) — the PRD's prose
   should be updated to describe the accepted artifact-first model, or the
   model's approval should be recorded against the PRD explicitly, so this
   gap does not need re-discovering in a future session.
3. **Security review** — a hostile review of the same shape B5's R2/R3
   closures used, focused on: authorization matrix completeness for all
   nine `AGENT_TOOL_NAMES`, no lingering "contract-only" tool, no
   regression in B4/B5 behavior.
4. **Source-control verification** — the same staged-diff-check discipline
   this session's whitespace-closure task established (stage the exact
   authorized set, run `git diff --cached --check` on the STAGED set before
   any commit authorization — the lesson explicitly recorded in that task's
   `FINAL_NOTES`).
5. **Regression suite** — full unit + integration + typecheck + build, same
   as §16's regression list.
6. **Confirmation no A6 `AGENT_TOOL_NAMES` contract-only tool remains** —
   grep for "contract-only" across `src/` and `docs/` should return zero
   hits describing any of the nine tools by name.
7. **Resolution or explicit re-scoping of the retained-resource GC/recovery
   and evidence retention/expiry obligation** (this section) — either
   implemented, or formally re-deferred with its own bounded architecture
   document (mirroring how this document and `PHASE_A6_B5_AGENT_APPLY.md`
   were each written before their implementation began), so it stops being
   an unowned, undated "future obligation" and becomes a scheduled one.

This document does not itself define that closeout gate's exact test
commands, nor does it design the GC/retention mechanism — both are future
work, correctly sequenced *after* B6 ships, not invented speculatively here.
**B6 itself remains READY** (§23) — this obligation is explicitly not B6's
to resolve (§11e, §18) — but the broader A6 phase cannot be marked complete
until it is addressed.

---

## 22. Unresolved user decisions

**None that block B6's own readiness.** Two judgment calls were made in this
document by direct, explicit precedent rather than invention (§10's
idempotency policy, §15's annotation-constant shape) — both are flagged with
their exact reasoning so Herman can override either without needing to
re-derive the analysis. Neither is a "genuine product decision left
undetermined by source": both have an unambiguous accepted sibling precedent
within the same phase (B5), and CLAUDE.md's "respect phase freezes" guidance
favors following that precedent over inventing a divergent new pattern.

**Not a blocking decision, but explicitly surfaced (R3):** §18/§21's
retained-resource GC/recovery and evidence retention/expiry obligation is
**not** a binary choice this document could resolve either way — its actual
design (what triggers cleanup, what the TTLs are, whether it's
time-based/reference-counted/manual) has never been decided by any accepted
document, B2 included; B2 only established THAT it's owed, not HOW. This is
future design work belonging to its own future architecture document (per
§21 item 7), not a question this R3 pass could answer by picking an option —
there is no "Option A vs Option B" to present yet because the option space
itself hasn't been scoped. Recorded here so it is not lost, not because
Herman needs to choose anything in this task.

---

## 23. Architecture readiness verdict

**B6_ARCHITECTURE_STATUS: READY.**
**A6_COMPLETE_AFTER_B6: NO** (corrected in R3 — see §21; this is a separate
verdict from B6's own readiness, not a contradiction of it).

Justification against the gate's own required checklist (R1 + R2 + R3
reconciliation):
- State semantics are deterministic (§7).
- Discard/apply concurrency is proven safe at the **database-transaction
  layer** (`BEGIN IMMEDIATE` mutual exclusion, both orderings traced
  exhaustively) — the primary invariant, with single-process/synchronous
  execution documented only as a secondary, non-load-bearing reinforcement
  of the current deployment (§9, R1-strengthened).
- Retention semantics are resolved for B6's own behavior — logical
  disposition only, zero physical deletion — **not by this document's own
  assumption, but by direct quotation of an already-accepted B2 policy**
  (§11e.2: *"Discard does NOT automatically delete evidence"*), backed by a
  forensic proof that no physical sandbox resource exists by the time
  discard is ever callable (§11c-11d, R3-strengthened from R0-R2's
  unproven assumption).
- Idempotency is resolved by precedent (§10); the false-return re-read at
  step 3 of §14 is backed by a proven append-only-rows invariant, not a bare
  non-null assertion (§14, R1-added).
- Error behavior is fully resolved, reusing existing codes only (§13).
- Exactly **one** executor-client method name and call shape is frozen and
  used identically everywhere in this document —
  `agentJobDiscard(jobId, principal)`, mirroring `agentJobCancel` exactly
  (§5f/§14/§15, R2-resolved; a name/shape mismatch between §14 and §15 in
  an earlier draft is fixed).
- The newly-added gateway → executor-client → HTTP → executor-route → engine
  wiring has its own real, unmocked, Docker-free end-to-end test mechanism,
  now including an explicit `.strict()`-schema unknown-property assertion
  (§15's WIRING bullet, R2-added, R3-extended) — not waived by the
  (accurate but insufficient) observation that older agent routes lack
  dedicated HTTP tests.
- Implementation path is bounded to **exactly four** production files, with
  every test path frozen to an exact file and no "or"/"either" choices
  remaining anywhere in the document (§15, R1+R2-resolved), and the
  `mcp.ts` scope contradiction is resolved — excluded from B6, grouped into
  A6 closeout (§15, §19, R1-resolved).
- No production test-only API is introduced anywhere in the test plan — the
  WIRING mechanism composes only already-exported production functions
  (`registerAgentRoutes`, `AgentJobEngine`, `AgentJobStore`,
  `registerAgentTools`, `withPrincipal`, `asBridgeError`) plus already-present
  dependencies (`express`, `undici`) (§15, R2-added).
- Acceptance criteria are explicit (§15's `EXPECTED_TEST_CHANGES`, cross-
  referenced from §16).
- The PRD/resource-lifecycle conflict raised by R3 is **fully source-resolved
  as it applies to B6's own implementation surface** (§11e's three-point
  proof: A5/A6-B3's shipped capture-then-destroy design, B2's explicit
  no-auto-delete policy, B4's artifact-only acceptance) — the *broader*,
  cross-cutting retained-resource GC/recovery obligation is real and open
  (§18, §21) but was never owned by any single B-phase including this one,
  so it does not block B6's own readiness; it blocks the *A6-complete*
  claim instead, which is corrected separately (§21).
- No user-selectable decision remains that B6 itself could resolve either
  way (§22) — the GC/recovery obligation's eventual design is future work
  with no option space yet defined, not a choice being deferred here.
- All R1/R2-accepted design (COMPLETED-only eligibility, double-discard
  policy, authz rules including the no-project-grant asymmetry, the
  concurrency proof, the discard/apply orderings, the `mcp.ts` closeout
  deferral, the four-file production scope, the frozen client-method name,
  the WIRING test mechanism, and the B1/B4/B5 freezes) is unchanged by R3 —
  this revision added the PRD/resource-lifecycle forensic proof, corrected
  §18's classifications, corrected the A6-completion verdict, and added one
  test assertion. It did not alter any accepted R1/R2 design decision.

This document is written so a separate implementation agent can build B6
without inventing architecture: §14 is the literal method body (with the
one frozen client-method call), §15 is the exact production/test/doc-comment
file list with exact responsibilities, exact exclusions, and a fully
specified WIRING test mechanism (now including the strict-schema
extra-property assertion), §13 is the exact error mapping, §9 is the exact
concurrency proof to cite rather than re-derive, and §11/§18/§21 are the
exact PRD-reconciliation proof and corrected A6-scope verdict to cite rather
than re-derive or re-litigate.
