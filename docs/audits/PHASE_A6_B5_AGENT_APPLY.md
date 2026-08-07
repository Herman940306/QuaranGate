# Phase A6-B5: `agent_apply` — Frozen Architecture

## Status

**ARCHITECTURE FROZEN — NOT YET IMPLEMENTED.**

This document is the canonical source of truth for the remaining A6-B5 work
(everything beyond the already-committed P1 policy primitives). It exists
because no such document previously existed — B1/B2/B3 each have a closeout
doc in this directory, but B4 (`agent_diff`) and B5 never got one, and an
earlier session incorrectly asserted that a B5 architecture was "already
frozen" when it was not. This document is that missing artifact, written by
inspecting the actual committed source rather than assuming prior intent.

P1 is complete and committed (`b5d972a2ab938556f3fc6e7483866d77567bbd26`,
`src/executor/agents/applyPolicy.ts`). This document does not redesign it.

Per the governing instruction for this batch: **after this document is
accepted, the remainder of B5 is implemented as ONE coherent batch — no
P2/P3/P4/P5 gates.** Section headers below use "Step" numbers purely for
engineering sequencing within that one batch, not as separate authorization
gates.

---

## 1. Source reconciliation

Classification legend: **VERIFIED EXISTING** (proven by reading the file) /
**PARTIAL** (exists but incomplete or unused) / **NOT IMPLEMENTED** /
**CONTRADICTED** (present but a bug relative to its own stated intent).

| # | Subsystem | Status | Evidence |
|---|---|---|---|
| 1 | Public job state machine (`AgentJobStatus`, `COMPLETED→APPLIED/DISCARDED`) | VERIFIED EXISTING | `src/shared/agents.ts:64-135` |
| 2 | Internal apply-attempt state machine (`AgentApplyAttemptState`) | VERIFIED EXISTING | `src/shared/agents.ts:155-213` |
| 3 | Project apply-admission state (`NORMAL`/`QUARANTINED`) | VERIFIED EXISTING | `src/shared/agents.ts:220-221`, `jobStore.ts:151-163` |
| 4 | SQLite schema v3: `agent_apply_attempts`, `agent_project_apply_state`, partial-unique active-attempt indexes | VERIFIED EXISTING | `jobStore.ts:391-429` |
| 5 | `startApplyAttempt` — atomic admission (job COMPLETED check, quarantine check, active-attempt exclusion) | VERIFIED EXISTING | `jobStore.ts:708-772` |
| 6 | `markApplySuccess` — atomic attempt+job dual commit | VERIFIED EXISTING, **not yet called from any runtime path** | `jobStore.ts:828-859` |
| 7 | `discardJob` — blocks discard while UNCERTAIN/active | VERIFIED EXISTING (B6 territory, out of scope here) | `jobStore.ts:880-906` |
| 8 | `recoverApplyAttempts` — startup reconciliation (STARTED/VERIFYING→ABORTED_NO_MUTATION, APPLYING→UNCERTAIN+quarantine, one transaction) | **PARTIAL — fully implemented but dead code.** Not called from `index.ts`, `jobEngine.ts`, or anywhere else. | `jobStore.ts:924-977`; confirmed no call site by repo-wide grep |
| 9 | Canonical artifact manifest + change-set schema (`ArtifactManifest`, `CanonicalChangeSet`) | VERIFIED EXISTING | `canonicalJson.ts:322-563` |
| 10 | `CHANGE_OPS` — **exact enum is `ADD \| CONTENT_MODIFY \| DELETE \| MODE_CHANGE \| SYMLINK_CHANGE \| TYPE_CHANGE`** | VERIFIED EXISTING | `canonicalJson.ts:322-323`. The prior instruction's op names (`CONTENT_ADD`, `CONTENT_DELETE`) **do not exist** and are corrected throughout this document. |
| 11 | `verifyCanonicalArtifact` / `ReadonlyEvidenceSource` / `readVerifiedBlob` (hardened B4 reader) | VERIFIED EXISTING | `artifactReader.ts:74-121,297-338` |
| 12 | `agent_diff` gateway+executor wiring (authz, schema, route, client) | VERIFIED EXISTING | see §2 below |
| 13 | `agent_apply` gateway authz entry (`agents:apply` scope, job ownership, current project grant) | VERIFIED EXISTING — **already frozen, mirrors `agent_diff` exactly** | `agentAuthz.ts` (see §2) |
| 14 | `agent_apply` Zod schemas (`agentApplyInput`/`Output`) | VERIFIED EXISTING — **frozen, `{jobId}` only, no patch text** | `agentSchemas.ts` (see §2) |
| 15 | `agent_apply` gateway tool registration | NOT IMPLEMENTED | `agentTools.ts` has no `agent_apply` entry |
| 16 | `agent_apply` executor route (`POST /agent/jobs/:id/apply`) | NOT IMPLEMENTED | `routes.ts` has no such route |
| 17 | `agent_apply` executor-client method | NOT IMPLEMENTED | `executorClient.ts` has no `agentApply` method |
| 18 | Committed P1 guarded-path/path-safety primitives (`applyPolicy.ts`) | VERIFIED EXISTING, FROZEN | `b5d972a` |
| 19 | A3 trusted-helper-container pattern (non-root/root-when-needed, cap-drop ALL, no-new-privileges, network none, no docker.sock, bounded resources, exact ownership labels) | VERIFIED EXISTING — the direct precedent for the B5 applier | `sandboxSpec.ts`, `sandboxRunner.ts` |
| 20 | Docker exec-argv (no-shell) trusted-command pattern against a **real hostPath** bind | VERIFIED EXISTING — `gitHelper.ts` already binds a **trusted registered project's real hostPath** read-only and runs fixed argv via `execCreate`/`execStartStream`; this is the direct precedent for B5's host-side checks | `gitHelper.ts:142-166,205-289` |
| 21 | Docker archive read/write primitives (`getArchive`, `putArchive`) | VERIFIED EXISTING. `getArchive` is heavily used (B2/B3 capture, B4 evidence reads). `putArchive` exists and is used once (`beforeCapture.ts` evidence write) — **it has no apply-path caller yet.** | `docker.ts` (exact functions in §6) |
| 22 | In-container `/proc/self/mountinfo` read primitive | NOT IMPLEMENTED — no existing helper reads it; nothing in `docker.ts` does more than Docker's own `Mounts` inspection view | confirmed by search |
| 23 | Trusted project registry (`hostPath`, `gitRequired`, `guardedPaths`) | VERIFIED EXISTING | `agentConfig.ts` (exact fields in §5) |
| 24 | Trusted helper image resolution (`AGENT_RUNNER_IMAGE`/`AGENT_HELPER_IMAGE`, non-caller-selectable) | VERIFIED EXISTING | `index.ts:44-46,67-90` |
| 25 | Resource-kind label taxonomy (`SandboxResourceKind`) | VERIFIED EXISTING — currently `'runner' \| 'stager' \| 'workspace' \| 'evidence'`; **no `'applier'` kind yet** | `sandboxSpec.ts:30` |
| 26 | Distinct "artifact" volume/label kind, `retain=true` label | **NOT FOUND anywhere in the codebase.** The B3/B4 canonical artifact (manifest+snapshots+blobs) lives on the *same* volume as B2 BEFORE evidence, labeled `resource=evidence`, which orphan reconciliation already skips. | confirmed by repo-wide grep |
| 27 | **CONTRADICTED: label-namespace bug.** `sandboxSpec.ts` uses `io.mcp-ide-bridge.*`; `gitHelper.ts` independently defines `io.mcp-bridge.*` (one fewer segment). `RunnerSandbox.reconcileOrphans()` filters only on `io.mcp-ide-bridge.managed=true`, so an orphaned git-helper container (e.g. executor crash between `createContainer` and its own `finally`) is **never found by any reconciliation path**. | CONTRADICTED, pre-existing, **not introduced by B5** | `sandboxSpec.ts:25-28` vs `gitHelper.ts:43-46`; `sandboxRunner.ts:245-268` |
| 28 | `kiroBackend.ts` private unhardened `extractSingleFile()` | VERIFIED EXISTING, confirmed **out of B5's path**: it is called only from `createEvidenceVolumeIO().readFile()`, used exclusively during B3 artifact *construction* (`constructArtifact`). B5's own host-precert/POST-verification reads are new code against the **real hostPath**, not this function; B5's artifact re-verification reuses the *hardened* `artifactReader.ts` version. | `kiroBackend.ts:88-104,1113-1158` vs `artifactReader.ts:425-467,479-508` |

### Resolution of #27 and #26 for B5

- #27 (label mismatch) is pre-existing, not on the B5 mutation path, and out of
  the approved file scope for this batch (it affects `gitHelper.ts`, a B3
  file). **Deferred**, logged here so it is not silently lost. B5's own new
  applier resource uses the correct `io.mcp-ide-bridge` namespace throughout
  (§10), so B5 does not add to this problem.
- #26 (no distinct artifact retention label): B5 does not need one. The
  applier mounts the job's *existing* evidence volume read-only (§9); no new
  persistent volume is introduced by B5 at all (§10).
- #8 (`recoverApplyAttempts` dead code) **is directly relevant to B5** — B5
  cannot claim restart safety while its own state machine's recovery function
  is never invoked. **This document requires it be wired into `index.ts`
  startup, immediately after `agentEngine.recover()`, as part of the B5
  batch** (§16).

---

## 2. `agent_apply` — confirmed pre-existing frozen surface (not re-decided here)

Both the gateway authorization matrix and the wire schemas for `agent_apply`
already exist and are treated as frozen inputs to this design, not decisions
made by this document:

- **Scope**: `agents:apply` (`agentAuthz.ts`), already mapped for the tool
  name `agent_apply`.
- **Authorization shape**: identical to `agent_diff` — `agents:apply` scope +
  exact job ownership (`job.principalId === principal.id`, no admin override)
  + current project grant evaluated against the **job's own recorded
  project** (never caller input), re-checked at the executor independently.
- **Input contract**: `{ jobId }` only — **no patch text, no host path, no
  Docker options, no override flags.** (`agentSchemas.ts`)
- **Output contract**: `{ jobId, status, project, appliedAt? }`.

Everything below designs what happens *between* "authorized, owned COMPLETED
job with an AVAILABLE artifact" and "job is APPLIED or the attempt reaches a
terminal failure state" — the part that does not exist yet.

---

## 3. End-to-end flow (authoritative)

```
gateway: authenticate → agents:apply scope → executor.agentJob(jobId, principal)
         → requireAgentAuthz({tool:'agent_apply', principal, job}) [ownership + project grant]
         → executor.agentApply({jobId, principal})
                                                    │
executor route POST /agent/jobs/:id/apply (re-validates principal/body, .strict() Zod)
                                                    │
AgentJobEngine.apply(jobId, principal):
  1.  getOwnedJob(jobId, principal)                          [reuse — FORBIDDEN_JOB / UNKNOWN_JOB]
  2.  project = trusted registry lookup by job.project        [reuse agent_diff pattern — FORBIDDEN_PROJECT]
  3.  attemptId = generate (same id-generation style as jobId: `att_` + 32 hex)
  4.  store.startApplyAttempt({attemptId, jobId})             [REUSE B1 — atomic: COMPLETED-only,
                                                                 not-quarantined, no concurrent active
                                                                 attempt for this job OR project]
      -> on success, attempt state = STARTED. Zero mutation possible yet.
  5.  re-verify artifact (verifyCanonicalArtifact, REUSE B4 hardened reader)
      -> manifest.applicable must be true, else
         transitionApplyAttempt(STARTED, 'ARTIFACT_INVALID') ; throw ARTIFACT_NOT_APPLICABLE
      -> changes[] must contain no SYMLINK_CHANGE / TYPE_CHANGE entries, else
         transitionApplyAttempt(STARTED, 'ARTIFACT_INVALID') ; throw APPLY_UNSUPPORTED_OPERATION
  6.  transitionApplyAttempt(STARTED, 'VERIFYING')
  7.  create ONE applier container for this attempt (§9), project hostPath RW +
      evidence volume RO, long-lived (idle Cmd), removed in a `finally` that
      always runs regardless of outcome
  8.  exec: nested-mount preflight (§12) — fail closed to PRECONDITION_FAILED
      (`NESTED_MOUNT_DETECTED`) -> transitionApplyAttempt(VERIFYING,'PRECONDITION_FAILED')
  9.  exec: repository identity + stale-HEAD + dirty-host check (§11) — fail
      closed (`STALE_BASE_COMMIT` / `HOST_DIRTY`) -> VERIFYING -> PRECONDITION_FAILED
  10. guardedPaths check: applyPolicy.assertChangesetNotGuarded(changedPaths,
      project.guardedPaths) [REUSE P1 EXACTLY] — GUARDED_PATH_DENIED ->
      VERIFYING -> PRECONDITION_FAILED
  11. path/mode safety per changed path: applyPolicy.validateApplyPath +
      assertSupportedRegularFileMode [REUSE P1 EXACTLY] — PATH_VIOLATION /
      PRECONDITION_FAILED -> VERIFYING -> PRECONDITION_FAILED
  12. exec: live host BEFORE recertification, one read per changed path (§13)
      — any mismatch -> HOST_PRECERTIFICATION_FAILED -> VERIFYING -> PRECONDITION_FAILED
  13. transitionApplyAttempt(VERIFYING, 'APPLYING')             <- LAST SAFE POINT.
      From here on, host mutation MAY occur; restart before this line is always
      safe (recoverApplyAttempts finds STARTED/VERIFYING -> ABORTED_NO_MUTATION).
  14. write ops-manifest (small, trusted, no raw bytes) into applier scratch
      tmpfs via putArchive; exec the fixed mutation script (§14), streaming
      one JSON journal line per completed op; persist each line into
      `agent_apply_journal` (NEW table, §8) as it arrives — BEFORE processing
      the next op.
  15. on script success (all ops applied, exit 0): exec live host POST
      verification (§15), reusing the same read primitive as BEFORE recert.
  16. on full POST match: store.markApplySuccess(attemptId, jobId, {...})
      [REUSE B1 EXACTLY — atomic attempt+job dual commit]. Return APPLIED.
  17. on any failure at 14/15 (script error, exec infra failure, POST
      mismatch): rollback (§16) using ONLY the journal rows for this attempt.
      -> if rollback fully verified: transitionApplyAttempt(APPLYING,
         'FAILED_ROLLED_BACK') [generic transition — already a legal edge]
      -> if rollback cannot be verified, or the applier/executor cannot
         complete rollback: store.markApplyUncertain(attemptId, projectId,
         reason) [NEW atomic primitive, §8, mirrors markApplySuccess's shape]
  18. always: remove the applier container (`finally`).
```

Steps 1–13 are the "VERIFYING" phase: zero host mutation, fully re-runnable,
every failure is a clean terminal attempt state with no project impact beyond
that attempt. Step 13's transition is the sole authorization boundary for
mutation. This ordering satisfies the fail-closed admission order requested
in the originating instruction — reproduced exactly, nothing reordered.

---

## 4. Legal job states / one-time apply semantics

**Already fully enforced by frozen B1 code — no new logic needed.**

`startApplyAttempt` requires `job.status === 'COMPLETED'` exactly
(`jobStore.ts:715-721`). After a successful apply, `markApplySuccess` sets
`job.status = 'APPLIED'` atomically with the attempt's `VERIFIED_SUCCESS`
(`jobStore.ts:849-852`). A second `agent_apply` call against the same job
therefore hits `startApplyAttempt`'s COMPLETED check first and throws
`PRECONDITION_FAILED` **before any admission row is even inserted** — zero
writes, zero mutation, by construction. Running/failed/discarded/
artifact-unavailable jobs are rejected the same way (`status !== 'COMPLETED'`
covers all of them). `agent_dispatch` never calls `startApplyAttempt` or
`markApplySuccess` anywhere in `jobEngine.ts` — there is no implicit-apply
path to close.

---

## 5. Project admission / concurrency

**Already fully enforced by frozen B1 code — no new logic needed for
admission itself.** The B5 batch's only obligation here is §1's finding: wire
`recoverApplyAttempts()` into startup (§16).

- Same project, one mutation-capable attempt at a time: enforced by the
  partial unique index `idx_apply_attempts_active_project`
  (`jobStore.ts:427-428`) over `state IN (STARTED, VERIFYING, APPLYING)` —
  this is the SQL-level authority, not an in-process mutex, so it is
  restart-safe by construction.
- Different projects proceed independently: the same index is scoped
  per-`project_id`; no global lock exists in this path (B2's job-execution
  serialization is a *different*, orthogonal lock and is unaffected by B5).
- `QUARANTINED` project rejects apply: `startApplyAttempt` checks
  `agent_project_apply_state` inside the same transaction
  (`jobStore.ts:733-736`) — `PROJECT_QUARANTINED`.
- UNCERTAIN blocks the project: `recoverApplyAttempts`/the new
  `markApplyUncertain` set `agent_project_apply_state.state = 'QUARANTINED'`
  in the SAME transaction as the attempt transition — there is no window
  where UNCERTAIN exists without quarantine.
- `agent_discard` vs `agent_apply` race: `discardJob` (`jobStore.ts:880-906`)
  already refuses to discard while any attempt is active
  (`APPLY_ATTEMPT_ACTIVE`) or UNCERTAIN (`APPLY_ATTEMPT_UNCERTAIN`) — B5 adds
  no new race here because B5 does not touch `discardJob`, and the active-
  attempt exclusion is the same partial unique index enforcing project
  admission above. `agent_discard` remains unregistered in `agentTools.ts`
  (confirmed §1/#15-17 analog) — this document does not activate it.

---

## 6. Artifact re-verification before mutation

**Reuses `verifyCanonicalArtifact` (`artifactReader.ts`) exactly as `agent_diff`
does — no second implementation.** `AgentJobEngine.apply()` calls it with the
same `ExpectedArtifactBinding` shape agent_diff builds (`jobId, principalId,
projectId, backend, profile, expectedArtifactHash: job.artifactHash,
baseCommit: job.baseCommit, changeSetHash: job.changeSetHash,
contentComplete: job.artifactContentComplete, applicable:
job.artifactApplicable, reason: job.artifactReason, opCount:
job.artifactOpCount, artifactBytes: job.artifactBytes}`), all sourced from the
trusted `AgentJobRow` — never from caller input. This independently
re-verifies: artifactHash, manifest integrity, before/post snapshot
identities, every referenced blob's SHA-256 + size, base commit binding, job
binding, principal/project binding. Additionally at apply time (not required
for read-only diff):

- `manifest.applicable !== true` → `ARTIFACT_NOT_APPLICABLE` (new code, VERIFYING→ARTIFACT_INVALID).
- Any `changes[].op` in `SYMLINK_CHANGE`/`TYPE_CHANGE` → `APPLY_UNSUPPORTED_OPERATION` (new code, same transition). v1 apply supports exactly `ADD`, `CONTENT_MODIFY`, `DELETE`, `MODE_CHANGE`. This is a whole-changeset refusal (consistent with guardedPaths' whole-changeset refusal semantics) — never a partial apply that skips the unsupported ops.

---

## 7. Stale HEAD / dirty host / live host BEFORE recertification / nested-mount

All four reuse the **same one applier container** created in flow-step 7,
via `docker exec` (argv-only, no shell — the same discipline `gitHelper.ts`
already uses for git object reads against a real hostPath bind). No new
Docker primitive is required beyond what already exists
(`execCreate`/`execStartStream`/`execInspect`, `getArchive`).

### 7a. Repository identity / stale HEAD / dirty host (flow step 9)

New fixed, non-shell-string-interpolated script — **directly reuses the exact
check logic already proven in `GIT_STAGING_SCRIPT`**
(`sandboxSpec.ts:145-159`), minus the `git archive` materialization step
(nothing is staged; this only *inspects*):

```
git -c safe.directory=/project -C /project rev-parse --git-dir   # not a repo -> exit 4
git -c safe.directory=/project -C /project rev-parse HEAD        # no HEAD    -> exit 5
git -c safe.directory=/project -C /project status --porcelain --untracked-files=all
                                                                   # non-empty -> DIRTY
```

Dirty-state definition (fail closed, no looser policy invented): non-empty
`git status --porcelain --untracked-files=all` output covers tracked
modifications, staged modifications, AND untracked files in one check
(exactly what `GIT_STAGING_SCRIPT` already relies on for A3 staging — this is
the existing frozen project policy, not a new one). Additionally, before the
porcelain check, test for an in-progress Git operation via the presence of
any of: `.git/MERGE_HEAD`, `.git/rebase-merge`, `.git/rebase-apply`,
`.git/CHERRY_PICK_HEAD`, `.git/REVERT_HEAD` (all standard Git sequencer state
files; porcelain status alone does not surface these) — any present ⇒ dirty.
Ignored files and submodules: **unchanged from the existing frozen policy** —
`git status --porcelain` never reports ignored files by default (no `-uall`
equivalent for ignored is invoked, matching A3's `GIT_STAGING_SCRIPT`
verbatim), and gitlinks/submodules are already handled at the *artifact*
level (`baseCertifier.ts`'s `hasGitlinks` forces `applicable=false` before
apply is even reachable) — B5 does not invent a second submodule policy.

`HEAD` result is compared to `job.baseCommit` (the trusted value recorded at
dispatch time, `AgentJobRow.baseCommit`) — exact 40-hex string equality, no
ancestry check, no merge-base, no "close enough." Any mismatch →
`STALE_BASE_COMMIT`. No merge, rebase, fuzzy application, patch offset, or
conflict resolution is ever attempted — this is the hard refusal the
originating instruction required.

### 7b. Nested-mount preflight (flow step 8)

No existing primitive reads `/proc/self/mountinfo`; this is new. A fixed
`node -e` script (same style as `PROBE_SCRIPT`/`MANIFEST_SCRIPT` in
`sandboxSpec.ts` — literal embedded source, zero caller-influenced content)
reads `/proc/self/mountinfo` (plain readable file, no special permission
needed), parses the standard whitespace-delimited mountinfo format, and
asserts: **no mount point path is a strict descendant of `/project`
(the fixed applier project-bind target) other than `/project` itself.**
Malformed/unparseable mountinfo → fail closed (script exits nonzero with a
distinct sentinel). This is checked once, before any git/host-read exec —
finding a nested mount aborts before repository-identity checks even run
(cheapest check first, and it protects the git/read checks that follow from
operating on an attacker-influenced view of `/project`).

### 7c. Live host BEFORE recertification (flow step 12)

For each changed path in the (already guardedPaths/path-safety validated)
change set, the applier execs a fixed read against `/project/<relPath>` and
returns exact bytes hashed + mode, OR absence. This is the **live host**
analog of `certifyBeforeAgainstBase` (`baseCertifier.ts`) — same exactness
discipline (exact mode, exact SHA-256, exact existence), but reading the real
host filesystem right now rather than Git objects at baseCommit. Reuses
`getArchive(containerId, absPath)` — the Docker archive GET primitive already
supports a **single-file path**, not just a directory tree (confirmed:
`beforeCapture.ts`/`postCapture.ts` call it with a directory root, but the
primitive itself takes an arbitrary absolute path) — so each changed path is
read individually via `getArchive(containerId, '/project/' + relPath)`,
parsed as a one-entry tar (reusing `tar-stream`, same library already a
dependency), never following symlinks (a symlink at a changed-path location
is itself a certification mismatch, since the artifact's BEFORE snapshot
requires a `file` kind at every `MODIFY`/`DELETE`/`MODE_CHANGE` path — see
`SUPPORTED_REGULAR_FILE_MODES` in P1). Exact required checks per op:

| Op | Required live-host state before mutation |
|---|---|
| `ADD` | target **absent** (checked via `FILE_NOT_FOUND` from `getArchive`, exactly how `EvidenceVolumeIO`/`ReadonlyEvidenceSource` already distinguish "not found" from "any other error" per their existing contracts) |
| `CONTENT_MODIFY` / `DELETE` / `MODE_CHANGE` | target exists, is a supported regular file, exact BEFORE bytes hash to `beforeSnapshot`'s `contentHash` for that path, exact BEFORE mode equals `beforeSnapshot`'s `mode` |

Any mismatch → `HOST_PRECERTIFICATION_FAILED`. This is a distinct check from
artifact re-verification (§6): artifact re-verification proves the *artifact
itself* is internally consistent and matches Git at `baseCommit`; host
recertification proves the *live filesystem right now* still matches what
the artifact claims was true. Both must pass; neither substitutes for the
other.

---

## 8. New persistence: apply journal + `markApplyUncertain`

Two additive, non-breaking schema/store changes are needed. **Both are
additive to schema v3 — no new `AGENT_JOB_SCHEMA_VERSION` bump is required**
(the same forward-only `ALTER`/`CREATE TABLE IF NOT EXISTS` migration
discipline `jobStore.ts` already uses is reused; this is still "v3", just
migrated further, exactly like how B2→B3 both stayed inside the `version < 3`
block conceptually — here it is a genuinely new post-v3 addition, so it
becomes `version < 4` → **`AGENT_JOB_SCHEMA_VERSION` becomes 4**). This is the
one schema-version change in the whole B5 batch, and it is purely additive
(new tables only; no column changes to `agent_jobs` or
`agent_apply_attempts`).

### 8a. `agent_apply_journal` (new table)

```sql
CREATE TABLE agent_apply_journal (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id         TEXT NOT NULL REFERENCES agent_apply_attempts(attempt_id),
  op_index           INTEGER NOT NULL,       -- position in the canonical sorted change list
  path               TEXT NOT NULL,
  op                 TEXT NOT NULL,          -- ADD | CONTENT_MODIFY | DELETE | MODE_CHANGE
  before_existed     INTEGER,                -- nullable: unknown until this op's BEFORE read
  before_content_hash TEXT,
  before_mode        INTEGER,
  created_dirs       TEXT,                   -- JSON array of directory paths this op created, shallow-first
  completed_at       TEXT NOT NULL,
  UNIQUE(attempt_id, op_index)
);
CREATE INDEX idx_apply_journal_attempt ON agent_apply_journal(attempt_id);
```

Written by the executor **after** each op's exec-stream JSON line arrives
(flow step 14) — one `INSERT` per completed op, each its own committed
transaction (not batched), so a crash between ops leaves an exact, provable
record of which ops actually landed. No source bytes are ever stored here
(only path/hash/mode metadata) — the actual POST bytes remain solely in the
already-verified B3/B4 evidence blobs, and BEFORE bytes for rollback are
re-derived from the artifact's `beforeSnapshot` (already verified in §6),
never duplicated into SQLite. This satisfies "avoid duplicating source bytes
in SQLite" directly.

### 8b. `AgentJobStore.markApplyUncertain(attemptId, jobId, projectId, reason)`

New method, mirroring `markApplySuccess`'s exact transactional shape
(`jobStore.ts:828-859`) but for the failure side: inside one
`BEGIN IMMEDIATE`, CAS `agent_apply_attempts` `APPLYING → UNCERTAIN` (reusing
the already-frozen state-machine assertion `assertApplyAttemptTransition`)
**and** the same idempotent quarantine `INSERT ... ON CONFLICT` upsert
`recoverApplyAttempts` already uses (`jobStore.ts:955-969`), committed
together. This is the **runtime** (non-restart) counterpart to
`recoverApplyAttempts`'s startup-only UNCERTAIN handling — both paths must
produce the identical durable outcome (attempt UNCERTAIN + project
QUARANTINED, atomically, idempotently), so this method literally reuses the
same upsert SQL text as `recoverApplyAttempts`, not a re-derived variant.

---

## 9. Trusted applier — image, container, security profile

### Image decision: **reuse the existing trusted A3/B2/B3 helper image family**
(`AGENT_HELPER_IMAGE`, defaulting to `AGENT_RUNNER_IMAGE`, i.e. the
`runner/Dockerfile` image: `node:24-alpine` + `git`). **Justification, from
existing source, not invented here**: the A3 closeout doc states outright
("§19 Deviations, item 6") that this one controlled image already
"serves both trusted roles" (stager + probe) *by design*, and every
subsequent trusted-helper role added since (before-capture, evidence-write,
evidence-read, git-helper) has reused the same `HELPER_IMAGE` rather than
introducing a new build. The applier needs exactly what this image already
has: Node (for the fixed mutation/mountinfo/precert scripts) and nothing
else — no new package, no new Dockerfile, no new build/publish pipeline. A
**dedicated new image** was considered and rejected: it would duplicate an
already-approved minimal trusted surface for zero additional isolation
benefit (isolation comes from the container's `HostConfig`, not the image
choice), and would add a new artifact to pin/rebuild/audit for no
functional gain.

### Container lifecycle

One applier container per apply **attempt** (keyed by `attemptId`, not
`jobId` — an attemptId is generated fresh per `agent_apply` call and a job
can only ever have one *successful* apply, but a failed/precondition-rejected
attempt must not collide names with a subsequent retry attempt for the same
job). Created when the attempt enters `VERIFYING` (flow step 7), reused via
multiple `docker exec` calls for every check in §7 and the mutation/rollback
scripts in §14/§16, removed in a `finally` after the attempt reaches any
terminal state or the executor itself fails. This "one container, many
execs, explicit close" shape is the same one `createDockerEvidenceReader`
already uses for `agent_diff` (`artifactReader.ts:479-508`) — not a new
pattern.

```
applierContainerName(attemptId) = 'mcp-ide-bridge-applier-' + attemptId
Labels: { 'io.mcp-ide-bridge.managed': 'true',
          'io.mcp-ide-bridge.resource': 'applier',   // NEW SandboxResourceKind member
          'io.mcp-ide-bridge.job': jobId,
          'io.mcp-ide-bridge.attempt': attemptId }   // NEW label key, additive
```

`SandboxResourceKind` (`sandboxSpec.ts:30`) gains `'applier'`. Unlike
`'evidence'`, `'applier'` is **NOT** skipped by `reconcileOrphans()` — an
applier container found running at startup is, by construction, evidence of
an `APPLYING` (or earlier) attempt that never reached a terminal state, and
`recoverApplyAttempts()` (now wired per §16) already independently
quarantines that project from the SQL side; the orphaned container itself is
just ephemeral compute to reclaim exactly like a runner/stager orphan
(`reconcileOrphans` already kills+removes any managed container
unconditionally — no special-casing needed, `'applier'` simply isn't added to
any skip-list).

### Mounts (exactly two — no third mount)

| Target | Source | Mode | Purpose |
|---|---|---|---|
| `/project` | `project.hostPath` (trusted registry) | **RW** | the real registered project — the only host-authority bind |
| `/artifact` | `job.artifactVolume` (the job's existing B3/B4 evidence volume) | **RO** | canonical POST blobs (`blobs/<prefix>/<hash>`) read during mutation (§14); manifest/snapshots are not re-read here (already verified in-process in §6) |

No third "control" volume: the small ops-manifest (§14) and any scratch
temp-file need go into the container's own `Tmpfs /tmp`, pushed in via
`putArchive` — identical mechanism `beforeCapture.ts`'s `writeEvidenceToVolume`
already uses to push a tar into a running helper container, just targeting
`/tmp` instead of a volume root.

### Security profile (every field the originating instruction asked for, each justified by an existing precedent)

| Field | Value | Precedent |
|---|---|---|
| `NetworkMode` | `none`, `NetworkDisabled: true` | identical to every existing trusted helper (`sandboxSpec.ts`, `gitHelper.ts`, `beforeCapture.ts`) |
| `Privileged` | `false` | same |
| `CapDrop` | `['ALL']`, `CapAdd: []` | same |
| `SecurityOpt` | `['no-new-privileges']` | same |
| Docker socket | absent (no bind, no env) | same — never any trusted helper gets it |
| Project mount | exactly one RW bind, `/project` only | new, but "exactly one host bind, everything else is a volume/tmpfs" is A3's stager pattern exactly (`buildStagerCreateBody`) |
| Artifact mount | exactly one RO volume, `/artifact` only | mirrors `createDockerEvidenceReader`'s RO evidence mount |
| `ReadonlyRootfs` | `true` | same as every trusted helper **except** where the container itself must write to a host bind — here the rootfs stays read-only; only `/project` (the explicit bind) and `/tmp` (tmpfs) are writable, exactly like the stager's `/workspace` + `/tmp` split |
| `User` | **`0:0` (root in the container's own user namespace)** | **justified by the existing `gitHelper.ts` precedent** (`gitHelper.ts:145`, comment: "root to read host-owned .git objects") — the applier must reliably write files matching arbitrary host file ownership (a dev's real project is host-uid-owned, not necessarily uid 1000), the same reason `gitHelper.ts` already runs as root against a host bind. Confinement comes from `CapDrop: ALL` + `Privileged: false` + `no-new-privileges` + no docker.sock + network none, not from UID alone — root-in-container with all Linux capabilities dropped cannot do anything a normal unprivileged host process couldn't already do to files it's bind-mounted into, and it still cannot touch anything outside `/project`/`/tmp`. |
| `Tmpfs` | `{'/tmp': 'rw,nosuid,nodev,size=16m'}` | same size class as the A3 runner |
| `Memory` / `NanoCpus` / `PidsLimit` | derived from the job's *own* `AgentResourcePolicy` via the existing `toRunnerLimits()` (`sandboxSpec.ts:95-104`) — **reused exactly**, no new limit-derivation function | — |
| Environment | none beyond `HOME=/tmp` (matching every other helper) — **no provider credentials, no OAuth tokens, no bridge secrets ever set** | same |
| Command/entrypoint | fixed idle `Cmd: ['sleep','300']` at create time (bounded — an applier attempt that somehow runs past this is killed and becomes an orphan, safely reconciled per above); all real work happens via `docker exec` with fixed argv, **never** `sh -c`, **never** caller-influenced strings | `gitHelper.ts`'s `HELPER_IDLE_CMD` pattern exactly, `sleep 300` instead of `sleep 60` to bound the whole multi-exec attempt lifecycle generously above `maxRuntimeMs` |
| Namespaces | `PidMode: ''`, `IpcMode: 'private'`, `UTSMode: ''`, `UsernsMode: ''`, `GroupAdd: []`, `Devices: []` | identical to `hardenedHostConfig()` (`sandboxSpec.ts:200-217`) — reused verbatim, not re-derived |

---

## 10. New Docker resources introduced by B5

Exactly one new ephemeral resource kind (`applier` container). **No new
Docker volume.** No new image. No new network. This is deliberately minimal
— every other requirement (control data, scratch space) is satisfied by
`Tmpfs`/`putArchive` against the already-created container, per §9.

---

## 11. Mutation algorithm

### Ops manifest (trusted, executor-authored, no raw bytes)

Before exec, the executor writes (`putArchive` into the applier's `/tmp`) a
single canonical JSON file, one array of objects, **sorted by path** (same
sort order the artifact's own `changes[]` is already required to be in per
`validateChangeSet`, so no re-sort is needed — it is passed straight from the
already-verified manifest):

```json
[{"path":"src/foo.ts","op":"CONTENT_MODIFY",
  "beforeHash":"<sha256>","beforeMode":420,
  "postHash":"<sha256>","postMode":420}, ...]
```

(`420` = decimal `0644`; modes are plain decimal integers, matching
`SnapshotFileEntry.mode`'s existing type.) This file contains **hashes and
modes only — never byte content** (content comes from `/artifact/blobs/...`,
already mounted). It is generated purely from data §6 already verified
in-process; it is not caller input and is never derived from the raw prompt
or model output text.

### Fixed mutation script (embedded literal source, `node -e`, no shell)

Executed once via a single `docker exec` (argv: `['node','-e',
APPLY_SCRIPT]`), same literal-embedded-script discipline as `PROBE_SCRIPT`/
`MANIFEST_SCRIPT`. Processes the ops file **strictly in array order**
(already the canonical sorted order) using only synchronous `node:fs`
primitives, printing exactly one JSON line to stdout per completed op
(consumed incrementally by the executor via `execStartStream`'s already-
existing demultiplexed stdout stream — the same mechanism `gitHelper.ts`
already reads from), so the executor can persist a journal row per line as
it arrives (§8a) rather than waiting for the whole exec to finish:

- **`ADD`**: split the path into segments; for each missing leading directory
  (checked with `fs.existsSync`, walked shallowest-first, one
  `fs.mkdirSync(dir, {recursive:false})` per missing level — **never**
  `{recursive:true}`), create it at mode `0755`; on `EEXIST` from a
  concurrent/unexpected creation, treat as success only if `fs.statSync` on
  that path is a real directory, otherwise fail the whole op (and thus the
  whole attempt — no continuation). Then write POST bytes (read from
  `/artifact/blobs/<prefix>/<postHash>`) to a temp sibling
  `<dir>/.mcp-apply-<random>.tmp`, `fs.writeFileSync` with the exact
  `postMode`, then `fs.renameSync(tmp, finalPath)` (atomic same-filesystem
  rename — `/project` is one bind, one filesystem, so this is always atomic).
  Defensive re-check: if `finalPath` unexpectedly already exists, fail
  closed (host recertification in §7c already proved absence moments
  earlier; this would indicate a race outside the applier's control, and the
  correct response is to stop, not overwrite).
- **`CONTENT_MODIFY`**: **re-verify immediately before mutation** —
  `fs.readFileSync(finalPath)`, sha256 it, compare to `beforeHash`; `fs.statSync`
  mode compare to `beforeMode`. Any mismatch fails the op (this is the
  "verify preimage again immediately before mutation" requirement — distinct
  from §7c's earlier check, which happens before `APPLYING` even begins; this
  one happens in the same exec, immediately adjacent to the write, closing
  the TOCTOU window between VERIFYING and the actual write). Then identical
  temp-sibling-write + atomic-rename as `ADD`, using `postMode`.
- **`DELETE`**: same immediate re-verify (bytes + mode against `beforeHash`/
  `beforeMode`), then `fs.unlinkSync(finalPath)` — never a directory removal,
  never recursive (the artifact's op grammar only ever names regular files
  here; a `DELETE` op is structurally impossible against a directory because
  `CHANGE_OPS` change entries are per-file, and P1's `validateApplyPath`
  already rejects a `.git`/`.`-segment path — this is defense-in-depth, not
  the primary guarantee).
- **`MODE_CHANGE`**: re-verify content hash matches `beforeHash` AND current
  mode matches `beforeMode`, then `fs.chmodSync(finalPath, postMode)`.

Any op failure (thrown exception, hash mismatch, unexpected `EEXIST`, I/O
error) **stops the script immediately** — no further ops are attempted, the
process exits nonzero after emitting its final journal line (if any progress
was made on a partially-processed op, that partial state is never journaled
as complete — only a fully-completed op is journaled). This directly
implements the "no partial application accepted as success" and "no
continuation past a failure" requirements.

---

## 12. POST verification

Reuses the **exact same live-host single-path read mechanism** as §7c
(`getArchive(containerId, '/project/' + relPath)`, one-entry tar parse, exact
hash/mode/existence check) — this is a real code-reuse decision, not a
restatement: BEFORE-recert and POST-verify are the same function with a
different expected-state argument (`expected: {kind:'absent'} |
{kind:'file', hash, mode}`).

| Op | Required live-host state after mutation |
|---|---|
| `ADD` / `CONTENT_MODIFY` | exists, supported regular file, exact bytes hash to `postHash`, exact mode equals `postMode` |
| `DELETE` | absent |
| `MODE_CHANGE` | exact bytes still hash to `beforeHash` (content never touched), exact mode equals `postMode` |

Only if **every** changed path independently passes this check does
`markApplySuccess` run. Ordering guarantee against a false `APPLIED` after
crash: `markApplySuccess` is the *only* code path that sets `job.status =
'APPLIED'`, it does so in one SQLite transaction with the attempt's
`VERIFIED_SUCCESS`, and it is called **only after** every POST check above
has independently passed in-process — there is no intermediate durable state
that could be mistaken for success (the journal in §8a records *op
completion*, never *verified success*; only `markApplySuccess`'s own atomic
write means "verified").

---

## 13. Rollback

Reads back **only** the rows in `agent_apply_journal` for this `attemptId`
(never a broader scan) and reverses each journaled op via the same applier
container/script family, in **reverse `op_index` order**:

- Journaled `ADD` → delete the file the applier created (`fs.unlinkSync`);
  then remove any directories *this attempt's own journal* recorded as
  created for that op (`created_dirs`, deepest-first, `fs.rmdirSync` —
  **never** recursive, and only proceeds if the directory is empty; if not
  empty, per instruction, this is a bounded rollback failure, not a silent
  skip — it means something else populated that directory since, and
  rollback cannot be proven complete → escalate to `markApplyUncertain`, §8b).
- Journaled `CONTENT_MODIFY` → restore exact `before_content_hash`/
  `before_mode` bytes from `/artifact/blobs/...` via the same temp-sibling +
  atomic-rename write as forward apply.
- Journaled `DELETE` → recreate the file from `before_content_hash`/
  `before_mode` (same write mechanism) — the artifact volume still has this
  blob (nothing is ever deleted from evidence storage by B5).
- Journaled `MODE_CHANGE` → `fs.chmodSync` back to `before_mode`.

After all journaled ops are reversed, rollback verification re-runs the exact
§12 mechanism but with **BEFORE** as the expected state for every journaled
path. Only if 100% match: `transitionApplyAttempt(attemptId, 'APPLYING',
'FAILED_ROLLED_BACK', {rollbackEvidence, mutatedPathCount})` (already a legal
edge in the frozen state machine, no new primitive needed here — `attempt →
UNCERTAIN` is the only guarded transition, `→ FAILED_ROLLED_BACK` uses the
plain `transitionApplyAttempt`). Any rollback step failure, or any
post-rollback verification mismatch → `markApplyUncertain` (§8b) — quarantine
is the only path forward, exactly as required ("if rollback cannot be proven,
UNCERTAIN + QUARANTINE").

---

## 14. UNCERTAIN / quarantine

Reached via exactly two code paths, both atomic (attempt + project quarantine
in one transaction), both reusing the same idempotent upsert SQL:

1. **Runtime**: `markApplyUncertain` (§8b), called when rollback fails or
   cannot be verified during a live `agent_apply` call.
2. **Restart**: `recoverApplyAttempts` (already frozen, §16 wires it in),
   called when the executor restarts and finds an attempt still `APPLYING`
   — unconditionally, no attempt to distinguish "probably fine" from
   "probably not," per B1's already-accepted (frozen) policy. This document
   does **not** add the more elaborate "try to prove exact POST/exact BEFORE
   before deciding" logic a prior instruction suggested for restart recovery
   — that would be **redesigning a frozen B1 phase** (CLAUDE.md: "respect
   phase freezes — do not redesign completed phases"), and B1's existing
   unconditional-UNCERTAIN policy is already safe (it never under-reports
   risk, only ever over-quarantines, which is the correct fail-closed
   direction). If Herman later wants restart-time POST/BEFORE proof-based
   recovery, that is a new, explicitly-scoped change to B1, not something
   this document silently bundles into B5.

Once quarantined: `startApplyAttempt` refuses all future apply attempts for
that project (`PROJECT_QUARANTINED`, already frozen), `discardJob` refuses to
discard the causing job (`APPLY_ATTEMPT_UNCERTAIN`, already frozen — and
quarantine is independent of any single job's disposition regardless), and
**no code path anywhere in this document clears `QUARANTINED`** — no MCP
tool, no automatic retry, no timeout-based auto-clear. Recovery is explicitly
out of scope for B5, matching B1's original closeout note.

---

## 15. Restart reconciliation (executor startup)

**Required code change, minimal and additive**: in `src/executor/index.ts`,
immediately after `const recovered = agentEngine.recover();` (`index.ts:93`,
inside the same `if (fs.existsSync(AGENTS_CONFIG))` branch, before the
existing `sandbox.reconcileOrphans()` call), add:

```ts
const applyRecovery = agentStore.recoverApplyAttempts('executor restarted with an active apply attempt');
```

with the same structured `console.log` shape the neighboring calls already
use (counts of `abortedNoMutation`/`uncertain`, never attempt reasons or
paths verbatim beyond the existing bounded `reason` string already passed
in). This single call closes the §1/#8 gap: `STARTED`/`VERIFYING` attempts
found at startup → `ABORTED_NO_MUTATION` (host was never touched, safe,
project stays `NORMAL`); `APPLYING` attempts found at startup → `UNCERTAIN` +
project `QUARANTINED`, atomically, exactly the policy in §14. No other
startup-ordering change is needed — `reconcileOrphans()` running after this
(as it already does) means any orphaned `applier` container is reaped
*after* the SQL-level quarantine has already been durably recorded, so there
is no window where an orphaned container exists without its owning attempt
already being safely terminal.

---

## 16. Executor/helper crash behavior (mid-flight, not restart)

- Crash during VERIFYING (before flow-step 13's transition): the attempt
  simply never reaches `APPLYING`; on restart it is found as `STARTED`/
  `VERIFYING` → `ABORTED_NO_MUTATION` per §15. No special runtime handling
  needed — this is not a distinct case from restart recovery.
- Crash during `APPLYING` (executor process dies mid-mutation-script or
  between journaled ops): on restart, found as `APPLYING` → `UNCERTAIN` +
  quarantine per §15. The orphaned applier container (if still running) is
  reaped by `reconcileOrphans()` afterward — its in-flight, unjournaled
  partial state on the real host filesystem is exactly why UNCERTAIN is the
  only safe answer; the journal only proves what completed *before* the
  crash, never what the dying exec might have been mid-write on.
- Applier container itself dies/is OOM-killed/killed by Docker mid-exec
  (rather than the executor process): the executor's `execStartStream`
  read loop ends without a matching journal-complete line for the
  in-progress op; the executor treats this exactly like a script failure at
  flow-step 14/15 (§13 rollback path) — it is not a distinct case, it is
  handled by the same try/rollback/uncertain logic already covering any
  other mutation-script failure.

---

## 17. Audit binding

New audit fields recorded by the gateway's existing `agentGuarded()`/audit
plumbing (`agentTools.ts`) for `agent_apply`, following the exact same
bounded-identifier discipline every other agent tool already uses (per
CLAUDE.md: reqId, principal, tool, target, decision, code?, durationMs,
detail? — never prompt text, source contents, blob bytes, secrets):

`{reqId, principal, tool:'agent_apply', jobId, project, artifactHash,
baseCommit, attemptId, outcome (VERIFIED_SUCCESS|FAILED_ROLLED_BACK|
UNCERTAIN|PRECONDITION_FAILED|ARTIFACT_INVALID), durationMs}`. No secrets
(none ever exist in this path — the applier never receives credentials, per
§9), no raw prompt (never read by this code path at all — apply operates
purely on the verified artifact and journal), no source code bodies (paths
and hashes only, exactly like the rest of A6's audit surface).

---

## 18. Orphan artifact safety

Verified in §1 (#26): the job's evidence volume (holding the canonical
artifact the applier mounts read-only) is already protected by
`reconcileOrphans()`'s existing `resource === 'evidence'` skip rule — B5
introduces no new artifact storage, so no new protection rule is needed.
**Test obligation, not a fix**: add a Docker-integration test asserting that
running `reconcileOrphans()` while a job's evidence volume exists (with or
without a concurrently-orphaned `applier` container for the same job) leaves
the evidence volume untouched while the `applier` container IS reaped — i.e.
prove the new `'applier'` kind and the existing `'evidence'` kind are treated
correctly *differently* by the same sweep.

---

## 19. `kiroBackend.ts` deferred finding

Confirmed in §1 (#28) **out of scope**: the unhardened private
`extractSingleFile()` is used only by B3's `EvidenceVolumeIO` during artifact
*construction*, never by any B5 read path (B5's host reads are new code
against `/project`, not the evidence volume; B5's artifact re-verification
reuses the already-hardened `artifactReader.ts` version). **Left unchanged.**
Reported here as required, not remediated.

---

## 20. New `BridgeErrorCode` entries (additive only, one new error module edit)

```
STALE_BASE_COMMIT            409  — live HEAD != job.baseCommit
HOST_DIRTY                   409  — tracked/staged/untracked changes or an in-progress
                                     git sequencer operation on the real project
HOST_PRECERTIFICATION_FAILED 409  — live host BEFORE state != artifact's beforeSnapshot
NESTED_MOUNT_DETECTED        409  — /proc/self/mountinfo shows an unexpected mount under /project
ARTIFACT_NOT_APPLICABLE      409  — re-verified manifest.applicable === false
APPLY_UNSUPPORTED_OPERATION  409  — changeset contains SYMLINK_CHANGE/TYPE_CHANGE
APPLY_MUTATION_FAILED        500  — the mutation script failed mid-changeset (pre-rollback signal)
APPLY_POST_VERIFICATION_FAILED 500 — post-mutation live state didn't match expected POST
APPLY_ROLLBACK_FAILED        500  — rollback could not be verified complete (→ UNCERTAIN)
```

`GUARDED_PATH_DENIED`, `PATH_VIOLATION`, `PRECONDITION_FAILED`, `SANDBOX_FAILED`
(reused for applier container/exec infrastructure failures — no new code for
that), `ARTIFACT_STORAGE_INTEGRITY_FAILED`, `ARTIFACT_NOT_AVAILABLE`,
`PROJECT_QUARANTINED`, `APPLY_ATTEMPT_ACTIVE`, `DUPLICATE_ATTEMPT_ID`,
`INVALID_ATTEMPT_TRANSITION`, `UNKNOWN_JOB`, `FORBIDDEN_JOB`,
`FORBIDDEN_PROJECT`, `MALFORMED_REQUEST`, `FILE_NOT_FOUND` are all reused
verbatim, unmodified — no redefinition, per CLAUDE.md's "add new error codes
here, never invent ad-hoc error strings."

---

## 21. Complete deterministic test plan

**Unit** (`tests/unit/a6-b5-apply-engine.test.ts` or similarly named,
in-memory fakes for Docker/store — no daemon):
- Ops-manifest construction from a verified `ArtifactManifest` (ordering,
  hash/mode fields, no byte content).
- Mutation-script logic tested as **pure functions** where possible (the
  script itself is a literal string executed in-container, but its
  constituent decisions — e.g. "is this an EEXIST I should tolerate" — should
  be unit-testable by extracting the decision logic into a plain TS module
  the script-string embeds/mirrors, exactly as `sandboxSpec.ts` keeps
  `GIT_STAGING_SCRIPT` as a reviewable exported constant rather than opaque
  inline text).
- §7a dirty/stale parsing (porcelain output → dirty boolean; sequencer-file
  presence → dirty; HEAD mismatch → stale) against synthetic stdout fixtures.
- §7b mountinfo parser against synthetic well-formed/malformed fixtures.
- Attempt-state transition coverage: every legal edge in §3's flow exercised
  against the real `assertApplyAttemptTransition`/`transitionApplyAttempt`
  (no double-testing of B1's own already-covered transitions — only the NEW
  call sites this batch adds).
- `markApplyUncertain` idempotency (two calls, same attempt, same quarantine
  cause preserved — mirroring the existing `recoverApplyAttempts` idempotency
  test pattern).
- Project admission: same-project serialization, cross-project independence,
  quarantine refusal — reusing `AgentJobStore` directly (real SQLite,
  `:memory:`, exactly how `agent-apply-state.test.ts` already tests B1).
- One-time apply: second `agent_apply` call after `APPLIED` performs zero
  writes (assert no new row in `agent_apply_attempts`, no journal rows).
- No implicit apply from `agent_dispatch` (grep-level/structural test: no
  code path in `dispatch()`/`execute()` calls `startApplyAttempt`).

**Docker integration** (`tests/integration/a6-b5-apply.test.ts`, disposable
git fixture repos only, never this repo):
- Exact applier `HostConfig` assertions (RW project bind, RO artifact volume,
  network none, cap-drop ALL, unprivileged, no docker.sock, resource limits)
  — same inspect-based proof style as `tests/integration/a3-sandbox.test.ts`.
- Nested-mount rejection: deliberately bind-mount something under the
  fixture's project directory before invoking apply; assert
  `NESTED_MOUNT_DETECTED`, zero mutation.
- ADD / CONTENT_MODIFY / DELETE / MODE_CHANGE against a real disposable repo,
  each independently, plus one combined changeset.
- Symlink defense: a changed-path target that is actually a symlink on the
  live host (artifact says file) → `HOST_PRECERTIFICATION_FAILED`, zero
  mutation.
- Failure injection: kill the applier container mid-mutation (simulate step
  14 crash) → assert rollback runs and either `FAILED_ROLLED_BACK` (if the
  simulated crash is between ops, so rollback of already-journaled ops
  succeeds) or `UNCERTAIN` (if rollback itself is then also prevented).
- Orphan-safety test from §18.

**Restart/persistence** (extends `tests/unit/agent-jobstore*.test.ts` or a new
file, real SQLite):
- Seed `STARTED`/`VERIFYING` rows directly, call `recoverApplyAttempts`,
  assert `ABORTED_NO_MUTATION`, project stays `NORMAL`.
- Seed `APPLYING` rows (with and without prior journal rows), call
  `recoverApplyAttempts`, assert `UNCERTAIN` + `QUARANTINED`, idempotent on a
  second call.
- Assert `agentEngine.recover()` + the new `recoverApplyAttempts()` call
  both actually run at simulated `index.ts` startup order (an integration-
  level smoke test, not just a unit call).

**Adversarial** (folded into the above suites, not a separate phase):
unauthorized apply / foreign job / revoked grant — already covered by the
existing frozen `agentAuthz.ts` test suite, B5 adds no new authz surface so
no new tests are owed there beyond confirming `agent_apply`'s registration
uses the existing matrix (a wiring-only assertion). Mount injection / hostPath
injection / command injection: structurally impossible per the input
contract (§2 — `{jobId}` only) and the argv-only exec discipline (§9/§11) —
tested by asserting the ops-manifest and every exec `Cmd` array contain no
dynamic string concatenation of caller-influenced data (a source-level
review assertion, mirrored in a unit test that fuzzes path/hash strings
through the ops-manifest builder and asserts they never appear as raw
argv/shell text, only as JSON-file *values*).

---

## 22. Implementation file plan (exact — the ONE authorized changed-path set)

```
src/shared/errors.ts                       + 9 new BridgeErrorCode entries (§20)
src/executor/agents/jobStore.ts            + agent_apply_journal table (schema v3→v4)
                                            + markApplyUncertain()
                                            + insertApplyJournalRow() / listApplyJournalForAttempt()
src/executor/agents/sandboxSpec.ts         + 'applier' SandboxResourceKind
                                            + applierContainerName()
                                            + buildApplierCreateBody() (or equivalent)
                                            + MOUNTINFO_SCRIPT / GIT_HOST_CHECK_SCRIPT / APPLY_SCRIPT
                                              (literal exported constants, same style as
                                              GIT_STAGING_SCRIPT/PROBE_SCRIPT/MANIFEST_SCRIPT)
src/executor/agents/applyEngine.ts         NEW — orchestrates flow §3 (host checks, mutation,
                                            rollback, journal persistence); imports applyPolicy.ts
                                            (P1) unchanged, verifyCanonicalArtifact (B4) unchanged
src/executor/agents/jobEngine.ts           + apply(jobId, principal) method delegating to
                                            applyEngine.ts, mirroring diff()'s existing shape
src/executor/agents/routes.ts              + POST /agent/jobs/:id/apply (.strict() Zod body)
src/executor/index.ts                      + recoverApplyAttempts() call after recover() (§15)
                                            + applyEngine wiring into AgentJobEngine construction
src/gateway/agentTools.ts                  + agent_apply registration (mirrors agent_diff's
                                            existing end-to-end shape exactly, §2)
                                            + APPLY annotation constant if the existing READ/WRITE/
                                            CANCEL set doesn't already cover it correctly
src/gateway/executorClient.ts              + agentApply() client method (mirrors agentDiff())
tests/unit/a6-b5-apply-engine.test.ts      NEW (§21)
tests/integration/a6-b5-apply.test.ts      NEW (§21)
tests/unit/agent-jobstore.test.ts          extended: schema v4 migration coverage (mirrors the
                                            existing v1→v2/v2→v3 migration test pattern exactly)
```

No other file is touched. In particular: `kiroBackend.ts`, `kiroFactory.ts`,
`gitHelper.ts`, `baseCertifier.ts`, `artifactConstructor.ts`,
`canonicalJson.ts`, `canonicalDiff.ts`, `postCapture.ts`, `beforeCapture.ts`,
`applyPolicy.ts`, `agentAuthz.ts`, `agentSchemas.ts`, `agentConfig.ts` are all
**reused, not modified** — every one of B5's dependencies on them is a plain
import of an already-frozen export.

---

## 23. Unresolved user decisions

**None.** Every area the originating instruction listed was resolvable from
existing accepted architecture and source, per the instruction's own
"do not stop merely because implementation is large" / "STOP only for a
genuine architecture contradiction or missing user decision" guidance. The
one genuine contradiction found (§14's restart-recovery sophistication
request vs. B1's frozen simpler policy) is resolved in favor of **not**
redesigning the frozen phase, which is the safe, conservative, already-
authorized default — not a new decision requiring Herman's input.

---

## 24. Explicit non-goals (unchanged from every prior A6 doc)

`agent_discard` implementation, A7, real-project execution of any kind by
this document (documentation-only batch), any change to B1–B4 behavior
beyond the two additive fixes explicitly called out (§8, §15), any new
runtime dependency, any change to `.kiro/` or `CLAUDE.md`.


---

## AS-BUILT SECURITY REMEDIATIONS (Final Implementation)

**Implementation complete.** This section documents the final as-built behavior
incorporating all security remediations applied during implementation. The
original frozen architecture sections (§3-§16 above) remain unchanged for
historical reference.

### F1: Per-Operation Exec + Journal Protocol

**Original Risk**: Batch mutation execution with single-pass journaling created
an ambiguity window where multiple operations could execute between journal
commits, making it impossible to determine which operations actually landed
after container failure.

**Remediation**: Each mutation operation is executed via a separate Docker exec
with its own single-operation control file. The journal row is committed
durably BEFORE the next operation starts.

**Implementation**:
- `buildSingleOpControlTar()` creates control file with `{mode, opIndex, op}`
- Forward loop executes one op, awaits completion, inserts journal row, repeats
- Rollback also uses per-operation execs for independent reversal
- A container kill/OOM between filesystem syscall and completion emit leaves
  the attempt in APPLYING — restart recovery unconditionally marks it UNCERTAIN

**Evidence**: `applyEngine.ts:556-575` (forward), `applyEngine.ts:678-705`
(rollback)

### F2: Post-APPLYING Exception Funnel

**Original Risk**: Unexpected exceptions after the VERIFYING→APPLYING transition
(Docker infra errors, journal INSERT failures) could leave attempts stuck at
APPLYING indefinitely.

**Remediation**: All awaited operations after the APPLYING transition are
wrapped in a single try/catch block. Any exception is funneled through
`rollbackAndFail` / `markApplyUncertain`, ensuring the attempt always reaches a
terminal state.

**Implementation**:
- The entire APPLYING body (ops loop + POST verification + success commit) is
  wrapped in try/catch
- Exceptions from rollback itself are caught separately and still transition to
  UNCERTAIN
- No live process path can leave an attempt at APPLYING

**Evidence**: `applyEngine.ts:551-602` (F1+F2 combined wrapper)

### F3: ADD Rollback Interference Detection

**Original Risk**: External process could replace/modify an ADD target between
forward success and rollback, causing rollback to delete the wrong bytes.

**Remediation**: Before unlinking a journaled ADD target during rollback, the
production mutation script verifies the live file exactly matches the attempt's
POST state (hash + size + mode + nlink===1). Any mismatch → rollback refuses
deletion → UNCERTAIN + QUARANTINED.

**Implementation**:
- `APPLY_MUTATION_SCRIPT` rollback mode for ADD: `requireSingleLinkRegularFile`,
  verify hash/size/mode match journaled POST
- Any deviation → rollback fails with "live file no longer matches attempt POST"
- External replacement bytes survive intact
- Attempt becomes UNCERTAIN, project QUARANTINED

**Evidence**: `sandboxSpec.ts:774-783` (rollback ADD verification)

### F4: Live Hardlink Confinement

**Original Risk**: Tar archive headers are not authoritative for live filesystem
link counts. A hardlink target (nlink>1) could allow chmod/content changes to
affect inodes outside the project bind.

**Remediation**:
1. **Live precertification**: For existing changed targets, `liveStatProjectPath`
   executes `LIVE_STAT_SCRIPT` to obtain real live `lstat().nlink` from inside
   the applier's project filesystem. Targets with nlink>1 are refused before
   APPLYING.
2. **Mutation-script recertification**: `requireSingleLinkRegularFile` performs
   an independent live `lstat()` immediately before each filesystem-changing
   syscall, refusing targets with nlink≠1.

**Implementation**:
- `LIVE_STAT_SCRIPT`: Fixed Node executable, validated canonical path from env,
  no shell, no command interpolation, emits `{ok, exists, kind, mode, nlink,
  size}` from `lstatSync()`
- `liveStatProjectPath` called for all non-ADD ops during BEFORE recertification
- `requireSingleLinkRegularFile` called by mutation script for CONTENT_MODIFY /
  DELETE / MODE_CHANGE forward, and all rollback ops that read live targets
- (R3) Archive content reads (`HostReadResult`, `extractSingleEntryWithMode`)
  carry **no `nlink` field at all** — not even a placeholder. Live stat reads
  return a separate type, `LiveStatResult`, which is the only place `nlink`
  appears in the `ApplierIO` seam. Archive metadata cannot represent live
  hardlink-count authority, so the type system now makes it structurally
  impossible to read an `nlink` value off an archive-read result.
- (R3) `liveStatProjectPath`'s validation requires `typeof nlink === 'number'
  && Number.isInteger(nlink) && nlink >= 1`; anything else (missing,
  fractional, negative, zero, or a non-numeric JSON value such as a string)
  throws rather than defaulting, rounding, or coercing.

**Evidence**:
- `sandboxSpec.ts:570-590` (LIVE_STAT_SCRIPT definition)
- `applyEngine.ts` — `HostReadResult` / `LiveStatResult` type definitions
  (R3 split), `extractSingleEntryWithMode` (archive read, no nlink field),
  `createDockerApplierIO().liveStatProjectPath` (integer validation)
- `applyEngine.ts` — live nlink precertification call site in `runApplyAttempt`
- `sandboxSpec.ts:675-681` (requireSingleLinkRegularFile)
- `tests/unit/a6-b5-apply-engine.test.ts` — "F4-R3 live nlink parsing
  (createDockerApplierIO)" (missing/0/-1/1.5/string-"1" fail closed; 1/2
  accepted as parsed results)

### F5: Atomic ADD No-Clobber Publication

**Original Risk**: The sequence `lstat(final) → renameSync(temp, final)` has a
TOCTOU window where a competing process can create `final`, and `renameSync`
will overwrite it on Linux.

**Remediation**: ADD publication uses `linkSync(temp, final)` which atomically
fails with EEXIST if `final` already exists, providing genuine no-clobber
semantics without a race window.

**Implementation**:
- `atomicWriteNew()`: create exclusive random sibling temp with O_CREAT|O_EXCL,
  write exact bytes, chmod exact mode, `linkSync(temp, final)`, unlink temp
- `linkSync` never overwrites an existing file — atomic no-replace property
- Post-publication: verify `lstat(final).nlink === 1` as defense-in-depth
- If `final` appears between absence check and linkSync, temp is cleaned up and
  op fails

**Evidence**: `sandboxSpec.ts:688-700` (atomicWriteNew using linkSync)

### Restart / Recovery Behavior

**Wired during implementation**: `recoverApplyAttempts()` is now invoked from
`index.ts` startup, immediately after `agentEngine.recover()`.

**Recovery policy** (from frozen B1 design, now active):
- Attempts in STARTED or VERIFYING at startup → ABORTED_NO_MUTATION (project
  never reached APPLYING, provably zero mutation)
- Attempts in APPLYING at startup → UNCERTAIN + project QUARANTINED (ambiguous
  whether current op landed, fail-closed)
- Single atomic transaction per recovery
- No automatic replay of uncertain attempts

**Evidence**:
- `jobStore.ts:924-977` (recoverApplyAttempts implementation)
- `index.ts` startup wiring (added during B5 batch)

### Special-File Handling

**Implementation**:
- Symlinks: `lstatSync()` never follows symlinks; `isFile()=false` for symlinks
  → refused by both live precertification and mutation script
- FIFOs / character devices / block devices / other special files: `isFile()=
  false` → refused as 'other' kind
- Directories: Never appear as changed file targets (only files in canonical
  artifact)

**Evidence**:
- `sandboxSpec.ts:677` (requireSingleLinkRegularFile checks `st.isFile()`)
- `applyEngine.ts:533-536` (live precert checks `liveStat.kind !== 'file'`)

### Control Volume Purpose

**Added during implementation**: A dedicated small RW control volume
(`/control`) holds the per-operation control file (ops manifest: paths/hashes/
modes only, never raw byte content).

**Rationale**: Docker's archive PUT endpoint refuses writes into tmpfs when
`ReadonlyRootfs: true` is set. The control volume is executor-owned,
attempt-scoped, and contains zero actual project data.

**Evidence**:
- `sandboxSpec.ts:477-479` (CONTROL_PATH constant)
- `applyEngine.ts:106-109` (createControlVolume / removeControlVolume interface)
- `sandboxSpec.ts:520-527` (control volume in buildApplierCreateBody)

### DAC_OVERRIDE + FOWNER Rationale

**Added during implementation**: The applier runs as `root:0` with `CapAdd:
['DAC_OVERRIDE', 'FOWNER']` (all other capabilities dropped).

**Rationale**:
- Typical real project directories are NOT world/group-accessible (e.g. 0700
  owner-only permissions)
- `CapDrop: ['ALL']` strips CAP_DAC_OVERRIDE, so container-root loses the
  ability to read/write/traverse files it doesn't own by UID
- Without DAC_OVERRIDE, root-in-container cannot access restricted project trees
- CAP_FOWNER is required for `chmod` operations on files owned by a different
  UID (not covered by DAC_OVERRIDE alone)
- These are the narrowest capabilities fulfilling the "reliable access
  regardless of host file ownership" requirement
- All other dropped capabilities remain dropped

**Evidence**: `sandboxSpec.ts:437-470` (module-level comment documenting live
discovery during Docker testing)

### Quarantine Behavior

**Existing B1 policy, now exercised**:
- Project enters QUARANTINED state on UNCERTAIN attempt
- `startApplyAttempt` atomic admission refuses QUARANTINED projects
- No automatic recovery — human must investigate and manually clear
- Independent of individual attempt terminal state (UNCERTAIN is per-attempt;
  QUARANTINED is per-project)

**Evidence**: `jobStore.ts:151-163` (project apply state), `jobStore.ts:728-735`
(quarantine check in admission)

### Test Evidence — Deterministic Later-Operation In-Flight Ambiguity (R2)

**Requirement (R2)**: The Docker proof must demonstrate ambiguity attaching to
a *later* operation in a multi-op changeset, with an *earlier* operation
already durably journaled — not merely a single op killed in isolation (a
prior draft of this test intercepted op 0 in a one-op changeset, which cannot
distinguish "current op ambiguous" from "no ops ever landed").

**Implementation** (`tests/integration/a6-b5-apply.test.ts`, "later-operation
in-flight ambiguity" test): a two-op changeset (`src/delete.txt` DELETE = op
0, `src/modify.txt` CONTENT_MODIFY = op 1, canonical path order). Op 0 runs
the real, entirely unintercepted `APPLY_MUTATION_SCRIPT` to completion; the
test asserts `listApplyJournalForAttempt` already contains exactly op 0
*before* any interception is set up for op 1. Op 1 then runs the real
`APPLY_MUTATION_SCRIPT` wrapped only at its I/O boundary: a
`process.stdout.write` override that fires *only* when the production success
line (`"ok":true`) is written — i.e. strictly after op 1's real filesystem
mutation has already executed, since the script always mutates before it
emits. On firing, the override writes a sentinel file into the `/control`
volume and then blocks the container process **synchronously** via
`Atomics.wait(int32Array, 0, 0, 60000)` — a real blocking primitive, not an
unresolved Promise (an unresolved Promise returned from a non-async function
does not block the caller and was the flaw in the R1 draft of this test) and
not an arbitrary `setTimeout`/sleep guess. The host test polls
(`getArchive` against the sentinel path) until the sentinel is observed, which
is only possible after the intercepted write — and therefore the mutation
preceding it — has actually happened. At that point the test independently
verifies op 1's mutation is visible on the real host bind
(`readFileSync(dir/src/modify.txt)`), re-confirms the journal still contains
exactly op 0, then removes the applier container out from under the blocked
exec. The executor's `exec()` call rejects; `runApplyAttempt` funnels this
through F2's exception handler with `ambiguousCurrentOpIndex = 1`, forcing
`markApplyUncertain` regardless of op 0's clean, provable state. Final
assertions: attempt state is `UNCERTAIN` (never `FAILED_ROLLED_BACK`), project
is `QUARANTINED`, `agent_apply_journal` for the attempt contains exactly the
op 0 row, op 1's landed mutation remains on disk (unreconciled, ambiguous by
design), and a second `runApplyAttempt` call against the same (still
`COMPLETED`) job is refused with `PROJECT_QUARANTINED` before any container is
created — proving quarantine, not merely the one attempt, blocks further
apply.

**Evidence**: `tests/integration/a6-b5-apply.test.ts` — "later-operation
in-flight ambiguity: op 0 journaled for real, op 1 mutates but completion is
synchronously blocked -> UNCERTAIN + QUARANTINED, journal=[op0] only,
subsequent apply refused".

### Test Evidence — ADD Rollback Interference

**Requirement**: Prove production rollback script detects external replacement
and refuses deletion.

**Implementation**: Test uses Docker exec to replace ADD target with different
bytes after successful forward operation. Deterministically forces next op to
fail (triggering rollback). Rollback executes through REAL production script,
detects hash mismatch, refuses deletion with authentic production error message.
Replacement bytes survive intact.

**Evidence**: `tests/integration/a6-b5-apply.test.ts:660-706` (F3 test using
Docker-side replacement, production rollback logic)

### Known Deferred Pre-Existing Issues

1. **Label namespace inconsistency** (§2 item #27): `gitHelper.ts` uses
   `io.mcp-bridge.*`; everything else uses `io.mcp-ide-bridge.*`. Orphaned
   git-helper containers are not found by reconciliation. Pre-existing, not on
   B5 mutation path, affects files outside B5 scope.

2. **Artifact volume retention** (§2 item #26): No distinct `retain=true`
   artifact label exists. Evidence volumes (which hold B3 artifacts) are
   protected by resource kind check. Adequate for current needs, but not a
   distinct retention policy.

**Resolution**: Both logged for future remediation, not blocking B5 closure.

---

## R2: Final Ambiguity Boundary Rule (authoritative)

This section is the canonical statement of the semantic boundary F1/F1-R2/F2
converge on, superseding any looser prose earlier in this document.

> A current operation remains **potentially mutated** from the moment its
> mutation exec begins until its journal row is durably committed.

Consequences, stated precisely:

**PRE-EXEC FAILURE** (failure strictly before the current op's mutation exec
is invoked — e.g. `putArchive` of its control file throws, or the loop fails
before calling `applierIO.exec` for that op):
- there is **no ambiguous current operation**;
- previously journaled operations may be cleanly rolled back **if the
  rollback is fully proven** (every journaled path independently re-read and
  matched back to its BEFORE state after reversal);
- outcome: `FAILED_ROLLED_BACK` if proven, otherwise `UNCERTAIN` (rollback
  itself is never assumed to succeed).

**POST-EXEC / PRE-JOURNAL FAILURE** (the current op's mutation exec has been
invoked and any of the following happens before its journal row is durably
`INSERT`ed): exec throws; the exec completes but its completion is lost,
blocked, or never observed by the executor; the script itself reports
`ok:false`; the journal `INSERT` for an op whose exec genuinely returned
`ok:true` itself fails —
- there **is** an ambiguous current operation: the executor cannot prove
  whether that operation's filesystem syscall landed;
- outcome is unconditionally `UNCERTAIN` + project `QUARANTINED`, **even if**
  every earlier, already-journaled operation's rollback can be independently
  and fully proven. A provably-clean rollback of earlier ops never converts an
  ambiguous *current* operation into `FAILED_ROLLED_BACK` — the two facts are
  independent, and the current op's ambiguity is the one that governs the
  attempt's terminal state.

**Implementation of the boundary**: `ambiguousCurrentOpIndex` in
`applyEngine.ts`'s `runApplyAttempt` is set to the op's index **immediately
before** its mutation exec is invoked, and cleared to `null` **only after**
that op's journal row has been durably inserted (`applyEngine.ts:582,617`).
Every failure path in `rollbackAndFail` checks this flag first
(`applyEngine.ts:754-769`): if set, it forces `markApplyUncertain` regardless
of what rollback verification of the already-journaled rows finds. This is
mechanically what the "later-operation in-flight ambiguity" Docker test
(above) proves against the real container/script, and what the five focused
unit-level scenarios (`ambiguous marker set timing`, `ambiguous marker clear
timing`, `later-op completion loss`, `journal INSERT failure`, `pre-exec
clean rollback regression`) prove against the in-memory fake.

### Live-nlink hardlink authority (restated precisely; type shape corrected in R3)

- The Docker archive (tar) GET path (`extractSingleEntryWithMode` in
  `applyEngine.ts`) **never** provides nlink authority for any security
  decision, and — as of R3 — **has no `nlink` field at all**, fabricated or
  otherwise. Its return type, `HostReadResult`, is structurally distinct from
  the live-stat return type, `LiveStatResult`: only the latter carries
  `nlink`. Archive/tar metadata cannot represent live hardlink-count
  authority, so R3 made it a type error, not merely a documented convention,
  to read `.nlink` off an archive read.
- `liveStatProjectPath` (`applyEngine.ts`, `createDockerApplierIO`), backed by
  `LIVE_STAT_SCRIPT` (`sandboxSpec.ts:570-591`) running a real in-container
  `lstatSync()`, is the **sole** authority for nlink used in any
  BEFORE-recertification decision (`runApplyAttempt`'s live-nlink
  precertification block).
- Fail-closed (R3): `liveStatProjectPath` requires `typeof nlink === 'number'
  && Number.isInteger(nlink) && nlink >= 1`. Missing, fractional (e.g. `1.5`),
  non-positive (`0`, `-1`), or non-numeric (e.g. the JSON string `"1"`) values
  all throw `INTERNAL` rather than defaulting, rounding, or coercing — an
  invalid/malformed nlink can never be silently treated as safe. Covered by
  `tests/unit/a6-b5-apply-engine.test.ts`'s "F4-R3 live nlink parsing"
  suite, which exercises the real `createDockerApplierIO()` parsing logic
  (not the in-memory fake) via the existing `execWithEnv` seam.
- The mutation script independently re-derives the same guarantee at the
  moment of each filesystem-changing syscall via `requireSingleLinkRegularFile`
  (`sandboxSpec.ts:676-681`), which throws on any `st.nlink !== 1`. This is a
  second, independent enforcement point (closing the VERIFYING→APPLYING TOCTOU
  window), not a restatement of the same check.
- Confirmed by source search (`grep -RInE
  'nlink|header|as unknown|LIVE_STAT_SCRIPT|liveStatProjectPath|renameSync|linkSync'
  src/executor/agents/applyEngine.ts src/executor/agents/sandboxSpec.ts`,
  reconfirmed R3): no forced nlink cast, no archive-header nlink authority,
  and ADD publication (`atomicWriteNew`) uses `linkSync` exclusive-create
  semantics rather than `lstat(final) → renameSync(temp, final)` — there is
  no security-critical rename-over-existing-destination path for ADD. The
  stale JSDoc above `APPLY_MUTATION_SCRIPT` that previously described ADD
  no-clobber in terms of `lstatSync`-then-`renameSync` has been corrected to
  describe the actual `linkSync`-based implementation (R3).

### R2 correction to prior test evidence

R1's "mid-exec kill" test intercepted **op 0 of a single-op changeset**,
which cannot distinguish "the current op is ambiguous" from "no op has ever
run" and used an unresolved Promise as its blocking mechanism (a no-op as a
synchronization primitive — nothing observed it). This was replaced in R2 by
the two-op, `Atomics.wait`-blocked test described above; the R1 test no
longer exists in the working tree.
