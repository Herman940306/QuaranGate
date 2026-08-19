# Phase A6 — Retained-Resource Lifecycle Architecture R3/R4 FINAL FREEZE

**Status:** ARCHITECTURE READY — IMPLEMENTATION APPROVED
**Revision:** R3/R4 (SOURCE RECONCILIATION COMPLETE)
**Parent:** A6-B6 (`24582afa7bab10bc21dcfa300524d8dcf3b2cd27` — `feat: add guarded agent discard`)
**R2 SHA:** `9cbf1ca655d6b4ae4f7c8d09934d96ee7289013b680df602ac349e8e2b23babe`
**R3 SHA:** `891ede2fe11406faa1b70b4764dd01ed7ea276c35ba93f8232e252a606315e84`

---

## R3/R4 Purpose

R3 resolved all five blocking user decisions. R4 hostile review identified final source-level discrepancies before implementation. R3/R4 is the **FINAL RECONCILIATION PATCH** correcting only:

- Quarantine column name (`quarantine_causing_job_id`, not `quarantined_job_id`)
- APPLIED disposition timestamp atomicity (`applied_at` and `disposition_at` must both be written)
- Timestamp comparison safety (avoid mixed ISO/SQLite datetime formats)
- Lane B post-recovery classification accuracy (FAILED_INFRASTRUCTURE does not prove crash provenance)
- Lane B discovery model (bounded prefix-based discovery for malformed-label detection)
- Unexpected missing volume policy (integrity anomaly, do NOT auto-EXPIRE)
- EXPIRED API behavior (no new changes required, current code already fails closed)
- Startup ordering (AWAIT sandbox.reconcileOrphans synchronously)
- Startup failure policy (global vs per-resource)
- Bounded reporting (counts + sample IDs, not unbounded logs)
- Retention constant name (AGENT_RETENTION_DURATION_MS frozen)
- Retention validation (malformed durable metadata fails closed)
- Exact implementation paths (add migration test file, add jobEngine test file)
- Delete completion identity proof (all correlation points frozen)
- Additional test coverage (timestamp atomicity, malformed metadata, post-recovery classification)

**User decisions (frozen from R3):**

- **R1 — Retention Duration Mapping:** Time-based. ephemeral=24h, short=14d, audit=180d
- **R2 — Success Disposition Retention Anchor:** `disposition_at` (not `completed_at`)
- **R3 — Failure Evidence Retention Model:** RETAIN + CLASSIFY + REPORT (indefinite, no automatic deletion)
- **R4 — Job Metadata Persistence:** Indefinite (job rows never deleted)
- **R5 — GC Invocation Model:** Startup-only (before service availability)

R3/R4 is the **FINAL ARCHITECTURE FREEZE**. All source discrepancies resolved. Implementation path frozen. This is the normative specification for A6 retained-resource lifecycle implementation.

No implementation in this document. Architecture freeze only.

---

## Authoritative Requirements (Unchanged from R2)

### Master PRD Actual Text (§32 Phase A6)

The Master PRD (`MCP_IDE_BRIDGE_MASTER_PRD.md`) §32 specifies `agent_discard` must:

> - leave live source unchanged;
> - preserve minimum audit evidence;
> - remove sandbox according to retention rules.

### Accepted B2 Future Obligations

`docs/audits/PHASE_A6_B2_STAGED_BEFORE_CAPTURE.md` "Next-Phase Obligations" §4:

> **Evidence retention / expiry / disposition lifecycle.** Discarded work/evidence must remain reviewable according to retention policy. Discard does NOT automatically delete evidence.

§6:

> **Retained resource garbage collection/recovery** must distinguish legitimate evidence from abandoned/incomplete resources.

### Current A6 Scope

The narrow accepted A6 requirement is:

**Retained-resource garbage collection must distinguish legitimate evidence-backed jobs from abandoned/incomplete resources, enabling recovery and preventing unbounded physical resource accumulation.**

---

## User-Approved Policy Decisions (R3 — FROZEN)

### Decision R1 — Retention Duration Mapping (APPROVED)

**Model:** Time-based TTL

**Approved mapping:**

| Retention Class | Duration (milliseconds) | Duration (human-readable) |
|----------------|------------------------|--------------------------|
| `ephemeral` | 86,400,000 | 24 hours |
| `short` | 1,209,600,000 | 14 days |
| `audit` | 15,552,000,000 | 180 days |

**Authority:** This mapping is the single source of truth for retention durations. It must be defined in executor configuration alongside the existing resource policy definitions.

**Location:** A new constant map in `src/executor/agentConfig.ts` or `src/shared/agents.ts`, co-located with `AGENT_RETENTION_CLASSES` definition:

```typescript
export const AGENT_RETENTION_DURATION_MS: Record<AgentRetentionClass, number> = {
  ephemeral: 24 * 60 * 60 * 1000,       // 24 hours
  short: 14 * 24 * 60 * 60 * 1000,      // 14 days
  audit: 180 * 24 * 60 * 60 * 1000,     // 180 days
};
```

**Not in `agents.yaml`.** This is product policy, not operator configuration. Operators select retention classes in their resource policies; the duration mapping is fixed by the bridge implementation.

**Non-retroactive:** Future changes to these durations affect only NEW jobs. Existing jobs retain their originally-resolved durations (see durable retention snapshot below).

### Decision R2 — Success Disposition Retention Anchor (APPROVED)

**Clock start:** `disposition_at`

**For jobs in status APPLIED or DISCARDED:**

```
retain_until = disposition_at + retention_duration_ms
```

**Rationale:** Ensures evidence survives the human review period between COMPLETED and disposition. The review window does not consume retention time.

**COMPLETED jobs:** Jobs with `status=COMPLETED` and `artifact_state=AVAILABLE` MUST NEVER automatically expire while they remain COMPLETED. They are awaiting human review / apply / discard disposition. No automatic expiry eligibility.

### Decision R3 — Failure Evidence Retention Model (APPROVED)

**Model:** RETAIN + CLASSIFY + REPORT (indefinite retention)

**Jobs with terminal failure status:**
- `FAILED_PRECONDITION`
- `FAILED_POLICY`
- `FAILED_AGENT`
- `FAILED_TIMEOUT`
- `FAILED_INFRASTRUCTURE`
- `CANCELLED`

**AND incomplete evidence (no published artifact):**

Must NOT be automatically deleted in A6.

**Lane B implementation** (see below) MUST identify, classify, and report incomplete evidence for manual review. Lane B is NOT an automatic deletion path.

**Future failure-evidence expiry:** May be a later bounded enhancement (e.g., FAILED_PRECONDITION before model invocation = safe to delete). This requires explicit safety analysis beyond A6 scope. Do NOT introduce failure TTLs in A6.

### Decision R4 — Job Metadata Persistence (APPROVED)

**Model:** Indefinite retention of database truth

**Job rows (`agent_jobs`):** NEVER automatically deleted. Retained indefinitely.

**Apply attempt rows (`agent_apply_attempts`):** NEVER automatically deleted. Retained indefinitely.

**Apply journal rows (`agent_apply_journal`):** NEVER automatically deleted. Retained indefinitely.

**Project quarantine state (`agent_project_apply_state`):** Never automatically cleared (existing B1/B6 semantics preserved).

**Physical evidence bytes may expire. Historical database truth does not.**

**Consequence:** When evidence expires, the job row remains with:
- `status` unchanged (APPLIED, DISCARDED, etc. — historical truth preserved)
- `artifact_state = EXPIRED` (physical availability changed)
- All other metadata intact (who, what, when, promptHash, baseCommit, etc.)

**Do NOT design job-row deletion.** Do NOT add cascade deletion. Do NOT alter the B6 append-only journal assumption.

### Decision R5 — GC Invocation Model (APPROVED)

**Model:** Startup-only (before service availability)

**Collector execution:** The retained-evidence lifecycle pass MUST complete before the executor accepts agent requests.

**Required startup order:**

```
1. initialize job store (jobStore constructor + migrate)
2. recover persisted job/apply state (jobStore.recoverActive, jobStore.recoverApplyAttempts)
3. AWAIT reconcile existing ephemeral/orphan runtime resources (sandbox.reconcileOrphans — MUST complete synchronously)
4. AWAIT reconcile previously-authorized EXPIRED evidence deletions (evidenceCollector.reconcileExpiredEvidence)
5. AWAIT run Lane A published-evidence expiry collection (evidenceCollector.collectExpiredEvidence)
6. AWAIT run Lane B incomplete-evidence classification/reporting (evidenceCollector.classifyIncompleteEvidence)
7. register/expose agent routes (registerAgentRoutes)
8. server.listen()
```

**Current source ordering** (`src/executor/index.ts` lines 46-77):

```typescript
const agentStore = new AgentJobStore(JOBS_DB);  // Step 1
// ...
const recovered = agentEngine.recover();        // Step 2
const applyRecovery = agentStore.recoverApplyAttempts(...); // Step 2
// ...
sandbox.reconcileOrphans()...                   // Step 3 (currently async fire-and-forget)
```

**A6 implementation MUST:**

1. AWAIT `sandbox.reconcileOrphans()` synchronously (not fire-and-forget)
2. Insert Steps 4-6 synchronously AFTER Step 3 completes
3. Ensure Steps 1-6 complete BEFORE Step 7

**Critical requirement:** Evidence collector MUST complete (or fail-safe abort) BEFORE `server.listen()` or any `app.use(routes)` that exposes agent API endpoints.

**Route construction:** Route objects MAY be constructed in memory earlier if current Express structure requires it. The security boundary is: NO externally reachable agent request before steps 1-6 finish.

**Concurrency guarantee:** If collector finishes before service accepts requests, no `agent_diff` or `agent_apply` can run concurrently with collection. Therefore no reader locks, refcounts, or artifact locks are required for A6.

**Trade-off (accepted):**

> Evidence whose retain_until passes while the executor remains continuously running is not physically collected until the next executor startup.

**Collection occurs at the first safe startup after eligibility is reached, NOT exactly at the retention timestamp.**

**Urgent GC:** Requires executor restart (acceptable for A6 MVP).

**Failure handling:**

**Global failures** (SQLite unavailable/corrupt, Docker unavailable for lifecycle processing, collector/classifier logic throws unexpectedly):

→ fail startup closed. Service SHOULD NOT start.

**Per-resource failures** (wrong labels, mismatched identity, malformed retention metadata, one deletion failure, orphaned/missing DB row, ambiguous volume):

→ RETAIN resource, bounded structured report, continue processing. Startup MAY continue after the overall lifecycle pass completes.

**Rationale:** A single malformed historical volume must not become an availability DoS. If retention processing encounters an ambiguous resource: fail closed for that resource. Do not delete it. Log error.

---

## Durable Retention Snapshot Model (FROZEN)

### Problem

Current implementation persists only `resource_policy` ID. If the operator later changes the `retentionClass` or duration mapping in configuration, re-resolving the policy yields different retention semantics than originally assigned.

This violates immutability of retention decisions.

### Approved Solution (Model B from R2)

**Persist THREE fields at job creation:**

```sql
retention_class         TEXT    -- 'ephemeral', 'short', or 'audit'
retention_duration_ms   INTEGER -- resolved milliseconds from AGENT_RETENTION_DURATION_MS
retain_until            TEXT    -- NULL until disposition, then absolute ISO 8601 timestamp
```

**At job creation (jobStore.insert):**

1. Resolve `policy.retentionClass` from the current resource policy
2. Resolve duration from `AGENT_RETENTION_DURATION_MS[retentionClass]`
3. Persist both `retention_class` and `retention_duration_ms`
4. `retain_until` remains NULL (disposition has not occurred)

**At successful final disposition (jobStore.markApplySuccess or jobStore.discardJob):**

1. Generate ONE canonical timestamp T = `nowIso()`
2. For APPLIED: write `applied_at = T` AND `disposition_at = T` atomically
3. For DISCARDED: write `disposition_at = T` atomically
4. Compute `retain_until = T + retention_duration_ms` (derived from that exact T)
5. Persist all values in the SAME transaction as the disposition transition

**Invariant:** Every NEW post-v5 APPLIED row has both `applied_at` and `disposition_at` set to the same timestamp. Every NEW post-v5 DISCARDED row has `disposition_at` set. Legacy rows remain unchanged.

**GC eligibility check:**

Collector obtains one canonical `nowIso` timestamp and compares using SQLite `julianday()` or exact canonical ISO string comparison when both operands use the same representation. Fail closed if `retain_until` is NULL, malformed, or unparsable. Do not treat malformed `retain_until` as expired.

```sql
WHERE retain_until IS NOT NULL
  AND julianday(retain_until) <= julianday(?)  -- safe canonical comparison
```

**Immutability guarantee:**

- If the operator changes the duration mapping (e.g., `short` from 14 days to 30 days), only NEW jobs get the new duration.
- Existing jobs retain their originally-resolved `retention_duration_ms` and absolute `retain_until`.
- Historical jobs CANNOT be retroactively affected by configuration changes.

**Schema migration:** v4 → v5 (see below)

---

## Legacy Jobs Rule (FROZEN)

Jobs created before these durable retention fields exist cannot prove their historical retention policy.

**Fail-closed rule:**

```
IF retention_class IS NULL
   OR retention_duration_ms IS NULL
   OR (retain_until IS NULL AND job requires automatic expiry eligibility):
  => RETAIN + REPORT
```

**Do NOT infer historical values from current configuration.**

**Do NOT treat legacy evidence as `audit` automatically.**

**Do NOT auto-migrate.**

**A migration tool/policy may be considered separately later.** This is NOT part of automatic GC.

**GC eligibility proof MUST include:**

```sql
WHERE retention_class IS NOT NULL
  AND retention_duration_ms IS NOT NULL
  AND retain_until IS NOT NULL
```

Absent any required field, fail closed (do not delete).

---

## Two-Lane Architecture (FROZEN)

### LANE A — Published Evidence Expiry (Automatic)

**Target population:** Published artifacts that have reached successful final disposition

**Required state:**

- `artifact_state = AVAILABLE` (not NONE, not already EXPIRED)
- `artifact_volume IS NOT NULL`
- `status IN ('APPLIED', 'DISCARDED')` (terminal success disposition only)
- `disposition_at IS NOT NULL`
- `retention_class IS NOT NULL`
- `retention_duration_ms IS NOT NULL`
- `retain_until IS NOT NULL`
- `retain_until <= now()`

**Plus all fail-closed ownership and safety checks (see proof below).**

**Operation:** Transition `AVAILABLE → EXPIRED` atomically, then remove evidence volume.

**Job metadata remains:** Job row, apply attempts, apply journal, project quarantine state all retained indefinitely.

**Excluded populations:**

- COMPLETED jobs (awaiting disposition — no `disposition_at`, evidence required for review)
- Failure/CANCELLED jobs (Decision R3 — indefinite retention)
- Jobs with active apply attempts
- Jobs with UNCERTAIN apply attempts
- Jobs that are the `quarantine_causing_job_id` (current source column name)
- Legacy jobs (missing durable retention fields)

### LANE B — Incomplete / Failed Evidence Classification (Classification + Report)

**Important:** Lane B is NOT merely an architecture-document classification. The final A6 implementation MUST contain a bounded runtime classifier/reconciler that identifies incomplete retained evidence and reports its classification.

**It does NOT automatically delete Lane B evidence.**

**Target population:** Evidence volumes created before canonical artifact publication completed

**Required classification outcomes:**

```
LEGITIMATE_FAILURE_EVIDENCE — job failed terminally, evidence is forensic record
ORPHANED_DB_MISSING — evidence volume exists, no DB job row (possible DB corruption)
AMBIGUOUS_LABELS — evidence volume exists with malformed/missing bridge labels
INCONSISTENT_STATE — artifact_state and job status do not match expected lifecycle
LEGACY_RETENTION_UNKNOWN — pre-retention job, no durable policy
```

**Note on post-recovery classification:** Startup recovery (`jobStore.recoverActive`) converts PREPARING/RUNNING/VALIDATING to FAILED_INFRASTRUCTURE before Lane B executes. Therefore Lane B cannot reliably distinguish process-crash FAILED_INFRASTRUCTURE from other infrastructure failures without additional durable evidence. Classification uses the current terminal status only; provenance inference beyond what the DB row proves is not frozen.

**Use source-compatible names if better terminology already exists.**

**Default action for ALL Lane B outcomes:** RETAIN + REPORT

**Implementation requirement:**

Lane B satisfies the accepted requirement that retained-resource GC/recovery distinguish legitimate evidence from abandoned/incomplete resources.

**Discovery model (bounded):**

Lane B uses two discovery paths:

1. **Exact-label discovery:** Enumerate Docker volumes with exact bridge ownership labels (`managed=true`, `resource=evidence`, valid `job` label)
2. **Prefix-based discovery (classification-only):** Enumerate Docker volumes matching the deterministic bridge evidence-volume naming prefix `io-mcp-ide-bridge-evidence-` that do NOT satisfy exact ownership labels

**For prefix-discovered volumes with malformed/missing labels:** Classification = AMBIGUOUS_LABELS, RETAIN + REPORT, NEVER DELETE.

**A deterministic name prefix alone is NOT deletion authority.** Only Lane A / delete-completion proof with full DB + label correlation may delete.

**Reporting bound:** Lane B output includes total resources scanned, count per classification, bounded sample of identifiers per class (e.g., first 10), and count of suppressed additional entries. Do NOT create unbounded logs. Do NOT add a metrics framework.

**Do NOT expand Lane B into automated failure-evidence deletion.** Classification and reporting only.

**Future enhancement:** After forensic review patterns are established, specific abandoned-setup states (e.g., FAILED_PRECONDITION before model invocation with no BEFORE snapshot) MAY be safe to auto-delete. This requires explicit approval beyond A6.

---

## Apply Concurrency Analysis (FROZEN)

Because automatic Lane A expiry is restricted to:

```sql
status IN ('APPLIED', 'DISCARDED')
```

And apply admission (jobStore.startApplyAttempt) already requires:

```sql
status = 'COMPLETED'
```

**State-machine ordering:** A new apply attempt should not normally be admissible for Lane A jobs.

**Current apply admission architecture** (`src/executor/agents/jobStore.ts` `startApplyAttempt`, lines 716-804):

```typescript
if (String(job.status) !== 'COMPLETED') {
  throw new BridgeError('PRECONDITION_FAILED',
    `job ${attempt.jobId} is ${String(job.status)}, not COMPLETED; apply attempts may only be started for COMPLETED jobs`,
    409);
}
```

**Analysis:** The existing state machine already prevents a new apply from being admitted for APPLIED/DISCARDED jobs. An APPLIED or DISCARDED job can never transition back to COMPLETED (terminal states, no outgoing transitions).

**Therefore:** A collector/apply race where Lane A deletes evidence for a job that then receives a new apply attempt is impossible under the frozen job state machine.

**Defensive checks retained:**

- Active apply attempt check (STARTED/VERIFYING/APPLYING)
- UNCERTAIN apply attempt check

These remain in the GC eligibility proof (see below) because they protect against inconsistent/corrupt state (e.g., a manually-corrupted DB row), not because they defend against a normal concurrent apply.

**Do NOT introduce new locking or synchronization for apply concurrency.** The frozen state machine already makes it impossible.

---

## `agent_diff` Concurrency Analysis (FROZEN)

Because Herman approved startup-only collection (Decision R5):

**Freeze:**

```
Collector completes before server availability.
```

**Therefore:** No online evidence collector exists during normal service operation.

No new reader lease, read refcount, diff lock, or artifact lock is required for A6.

This is an intentional bounded architecture decision.

**Trade-off (documented):**

> Evidence whose retain_until passes while the executor remains continuously running is not physically collected until the next executor startup.

**This is accepted for A6.**

**Do NOT claim collection occurs exactly at the retention timestamp.** It occurs at the first safe startup after eligibility is reached.

---

## Expiry Admission Proof (FROZEN)

Separate expiry authorization from physical-delete completion.

### PROOF A — Expiry Admission (AVAILABLE → EXPIRED Authorization)

**Purpose:** Authorize transition from `artifact_state = AVAILABLE` to `artifact_state = EXPIRED`

**Minimum required proof (fail closed):**

1. **Current bridge-managed evidence labels valid:** `io.mcp-ide-bridge.managed = "true"`
2. **Resource type:** `io.mcp-ide-bridge.resource = "evidence"`
3. **Job label matches:** `io.mcp-ide-bridge.job = "{jobId}"`
4. **Durable job row exists:** `SELECT 1 FROM agent_jobs WHERE job_id = ?`
5. **Current artifact state:** `artifact_state = 'AVAILABLE'` (not NONE, not already EXPIRED)
6. **Artifact volume identity:** `artifact_volume` matches exact expected Docker volume name
7. **Terminal success disposition:** `status IN ('APPLIED', 'DISCARDED')` (NOT COMPLETED, NOT failure codes)
8. **Disposition timestamp exists:** `disposition_at IS NOT NULL`
9. **Durable retention class exists:** `retention_class IS NOT NULL` (fail closed for legacy jobs)
10. **Durable retention duration exists:** `retention_duration_ms IS NOT NULL`
11. **Absolute expiry timestamp exists:** `retain_until IS NOT NULL`
12. **Retention period elapsed:** `julianday(retain_until) <= julianday(?)` where ? is collector's canonical `nowIso` timestamp (safe comparison avoiding mixed ISO/SQLite datetime formats; fail closed if `retain_until` is NULL, malformed, or unparsable)
13. **No active apply attempt:** `SELECT 1 FROM agent_apply_attempts WHERE job_id = ? AND state IN ('STARTED', 'VERIFYING', 'APPLYING') LIMIT 1` returns nothing
14. **No UNCERTAIN apply attempt:** `SELECT 1 FROM agent_apply_attempts WHERE job_id = ? AND state = 'UNCERTAIN' LIMIT 1` returns nothing
15. **Job is not quarantine cause:** `SELECT 1 FROM agent_project_apply_state WHERE quarantine_causing_job_id = ? LIMIT 1` returns nothing (OR project.state != 'QUARANTINED'; source column name is `quarantine_causing_job_id`, not `quarantined_job_id`)

**Fail closed if ANY proof fails.**

**Implementation pattern (atomic):**

```sql
BEGIN IMMEDIATE;

-- Collector obtains one canonical nowIso timestamp
-- Compare using julianday for safe canonical comparison

UPDATE agent_jobs
SET artifact_state = 'EXPIRED'
WHERE job_id = ?
  AND artifact_state = 'AVAILABLE'
  AND status IN ('APPLIED', 'DISCARDED')
  AND disposition_at IS NOT NULL
  AND retention_class IS NOT NULL
  AND retention_duration_ms IS NOT NULL
  AND retain_until IS NOT NULL
  AND julianday(retain_until) <= julianday(?)  -- ? = collector's nowIso timestamp
  AND NOT EXISTS (
    SELECT 1 FROM agent_apply_attempts
    WHERE job_id = agent_jobs.job_id
      AND state IN ('STARTED', 'VERIFYING', 'APPLYING')
  )
  AND NOT EXISTS (
    SELECT 1 FROM agent_apply_attempts
    WHERE job_id = agent_jobs.job_id
      AND state = 'UNCERTAIN'
  )
  AND NOT EXISTS (
    SELECT 1 FROM agent_project_apply_state
    WHERE quarantine_causing_job_id = agent_jobs.job_id
      AND state = 'QUARANTINED'
  );

-- Check rows_affected
-- If 0: admission failed (race lost or criteria not met)
-- If 1: admission succeeded, proceed to delete completion

COMMIT;
```

**Validation:** If `retain_until` is NULL, malformed, or unparsable, `julianday()` returns NULL and comparison fails closed (no match, no expiry).

**Concurrency safety:** SQLite WAL mode + `BEGIN IMMEDIATE` ensures total ordering. If multiple collectors attempt concurrent expiry, only one UPDATE wins. Labels are verified before physical delete (delete completion proof below).

### PROOF B — Delete Completion (Physical Volume Removal)

**Purpose:** Complete an already-authorized deletion (either immediately after Proof A, or on restart after crash)

**Required proof:**

1. **Durable expiry decision exists:** `artifact_state = 'EXPIRED'`
2. **Volume identity recorded:** `artifact_volume IS NOT NULL`
3. **Docker volume identity matches expected:** volume name == `io-mcp-ide-bridge-evidence-{jobId}` (deterministic pattern)
4. **Labels prove current bridge ownership:** `managed=true`, `resource=evidence`, `job={jobId}` (all must match)

**All identity correlation points must agree:** DB job_id, DB artifact_volume, deterministic `evidenceVolumeName(jobId)`, Docker volume name, and Docker volume labels. Wrong-job or ambiguous volume: RETAIN + REPORT.

**Operation:** `docker volume rm {artifact_volume}` (idempotent)

**Does NOT require:**
- Re-checking active apply (that was required for admission, not completion)
- Re-checking UNCERTAIN (admission-time only)
- Re-checking retention elapsed (decision already made durably)

**Idempotency:** Docker volume delete returns success even if volume already absent. Explicitly handle Docker's not-found condition (do not claim Docker automatically returns success). Proof B can be executed multiple times after crashes.

**If volume delete fails:** Log error, leave `artifact_state = EXPIRED`. Next reconciliation cycle can retry.

**If identity/labels conflict:** RETAIN volume, report anomaly. Never delete an ambiguous Docker volume merely because the DB says EXPIRED.

---

## Unexpected Evidence Loss (FROZEN)

**Scenario:**

```
artifact_state = AVAILABLE (not EXPIRED)
+
expected artifact volume missing (Docker volume absent)
+
no prior durable EXPIRED decision
```

**This is an INTEGRITY ANOMALY, NOT ordinary expiry.**

**Required behavior:**

1. **DO NOT silently transition to `artifact_state = EXPIRED`**
2. **DO NOT fabricate a valid policy expiry**
3. Preserve job metadata (artifact_state remains AVAILABLE)
4. Report the anomaly (structured logging)

**Do NOT introduce a new public job status.** Job status remains unchanged (APPLIED, DISCARDED, COMPLETED, etc.).

**Do NOT introduce a new database anomaly flag** unless per-resource reporting proves insufficient. Prefer logging/report classification.

**Suggested logging:**

```typescript
log('integrity anomaly: expected evidence volume missing', {
  jobId,
  artifactState: 'AVAILABLE',
  artifactVolume,
  status: job.status,
  dispositionAt: job.dispositionAt,
});
```

**Classification:** If an integrity anomaly occurs, the evidence volume will NOT be EXPIRED by GC. Manual operator investigation is required.

**EXPIRED API behavior:** Current code (`agent_diff`, `agent_apply`) already checks `artifact_state !== 'AVAILABLE'` and fails closed with existing error codes (ARTIFACT_NOT_AVAILABLE). NO new public status, NO new BridgeError code, NO gateway schema change, NO agent_diff implementation change, NO agent_apply implementation change. Add regression coverage proving current behavior remains intact.

---

## UNCERTAIN / Quarantine Evidence Protection (FROZEN)

### UNCERTAIN Evidence Hold

**Evidence belonging to a job with an UNCERTAIN apply attempt is not auto-expirable.**

**GC eligibility proof MUST include:**

```sql
AND NOT EXISTS (
  SELECT 1 FROM agent_apply_attempts
  WHERE job_id = agent_jobs.job_id
    AND state = 'UNCERTAIN'
)
```

**Rationale:** UNCERTAIN means host mutation may have occurred and the outcome is unknown. Evidence for forensic recovery must be retained indefinitely.

### Quarantined Job Protection

**Evidence belonging to the job that caused project quarantine is not auto-expirable.**

**GC eligibility proof MUST include:**

```sql
AND NOT EXISTS (
  SELECT 1 FROM agent_project_apply_state
  WHERE quarantine_causing_job_id = agent_jobs.job_id
    AND state = 'QUARANTINED'
)
```

**Rationale:** The quarantined job's evidence is required for forensic analysis and manual recovery. Source column name is `quarantine_causing_job_id`, not `quarantined_job_id`.

### Unrelated Jobs in Quarantined Project

**GC never clears project quarantine.** This is B1/B6 frozen invariant.

**Unrelated historical jobs in the same project MAY expire normally IF:**

- They are NOT the `quarantine_causing_job_id` (source column name)
- They have no UNCERTAIN apply attempts themselves
- They otherwise satisfy Lane A eligibility

**No project-wide blanket evidence hold.** Quarantine blocks NEW applies to the project. It does NOT freeze ALL historical evidence for unrelated jobs.

---

## Physical Deletion Granularity (FROZEN)

**Current physical evidence deletion is WHOLE DOCKER EVIDENCE VOLUME.**

**Evidence volume layout:**

```
/before/         BEFORE snapshot
/post/           POST snapshot
/artifact/       Canonical artifact (manifest.json + blobs/*)
```

All three directories are co-located on a single Docker named volume.

**Deletion granularity:** WHOLE VOLUME ONLY.

**No partial deletion.**
**No archive.**
**No repacking.**
**No cold storage.**
**No object store.**

Designing partial deletion would require a new storage model (separate volumes per lifecycle phase, object storage, explicit repacking/archiving). This is NOT current A6 scope.

---

## Exact Implementation Path (FROZEN)

### Required Production Paths

1. **`src/shared/agents.ts`** — AGENT_RETENTION_DURATION_MS constant
2. **`src/executor/agents/jobStore.ts`** — Schema migration v4 → v5, persistence of durable retention fields, disposition timestamp atomicity
3. **`src/executor/agents/jobEngine.ts`** — Job creation persistence of retention class + duration
4. **`src/executor/agents/evidenceCollector.ts`** (new file) — Lane A collector, Lane B classifier, expiry reconciler
5. **`src/executor/index.ts`** — Startup ordering integration (await sandbox.reconcileOrphans synchronously)

### Required Test Paths

1. **`tests/unit/agent-jobstore-migration.test.ts`** (new file) — v4→v5 migration, legacy NULL retention semantics, fresh-v5 vs migrated-v5 schema equivalence
2. **`tests/unit/agent-jobstore.test.ts`** (extend existing) — Retention persistence, timestamp atomicity, malformed retention metadata
3. **`tests/unit/agent-jobengine.test.ts`** (new file) — Job engine resolution of policy.retentionClass + AGENT_RETENTION_DURATION_MS, immutable snapshot passing to jobStore
4. **`tests/unit/agent-evidence-collector.test.ts`** (new file) — Lane A eligibility, proofs, Lane B classification, delete completion, integrity anomalies, malformed metadata, post-recovery classification accuracy
5. **`tests/integration/a6-evidence-lifecycle.test.ts`** (new file) — End-to-end lifecycle, crash consistency, startup ordering (awaited reconcileOrphans), timestamp boundary cases

### Required Config Paths

**One authoritative source for retention duration mapping.**

**Location (frozen):** `src/shared/agents.ts` (co-located with `AGENT_RETENTION_CLASSES` definition)

**Why not `agentConfig.ts` or `agents.yaml`:** This is product policy, not operator configuration. The duration mapping is fixed by the bridge implementation. Operators select retention classes in their resource policies; they do not define the duration mapping.

**Constant definition:**

```typescript
export const AGENT_RETENTION_DURATION_MS: Record<AgentRetentionClass, number> = {
  ephemeral: 24 * 60 * 60 * 1000,       // 24 hours
  short: 14 * 24 * 60 * 60 * 1000,      // 14 days
  audit: 180 * 24 * 60 * 60 * 1000,     // 180 days
};
```

**No duplicate configuration sources.** This is the single source of truth.

**Do NOT place duration mapping in:**
- `agents.yaml` (operator config)
- `agentConfig.ts` validation (validator does not define policy values)
- Per-project config
- Resource policy YAML

**Duration values are persisted per job at creation time (durable snapshot). Future changes to `AGENT_RETENTION_DURATION_MS` affect only NEW jobs.**

---

## Schema Migration (FROZEN)

### Current Schema Version

**Version 4** (`src/executor/agents/jobStore.ts` `AGENT_JOB_SCHEMA_VERSION = 4`)

**Path:** `jobStore.ts` lines 24

### Migration Version

**v4 → v5**

### Schema Columns Added

**Table:** `agent_jobs`

**Columns:**

```sql
retention_class         TEXT    -- 'ephemeral' | 'short' | 'audit'
retention_duration_ms   INTEGER -- milliseconds, resolved at job creation
retain_until            TEXT    -- ISO 8601 timestamp, NULL until disposition
```

### SQL Types

**`retention_class`:** TEXT (matches existing pattern for enums in SQLite)

**`retention_duration_ms`:** INTEGER (milliseconds, matches existing time-interval pattern)

**`retain_until`:** TEXT (ISO 8601 timestamp, matches existing `created_at`, `disposition_at`, etc.)

### NULLability

**All three columns are nullable.**

**New jobs (after migration):**
- `retention_class` and `retention_duration_ms` set at creation (INSERT)
- `retain_until` set at disposition (markApplySuccess / discardJob)

**Legacy rows (before migration):**
- All three remain NULL
- Never backfilled from current config
- GC eligibility proof fails closed (RETAIN + REPORT for legacy jobs)

### Write Points

**`retention_class` and `retention_duration_ms`:**

Written at job creation inside `jobStore.insert()`.

```typescript
// At job creation
const retentionClass = policy.retentionClass;
const retentionDurationMs = AGENT_RETENTION_DURATION_MS[retentionClass];

this.db.prepare(`
  INSERT INTO agent_jobs (job_id, ..., retention_class, retention_duration_ms)
  VALUES (?, ..., ?, ?)
`).run(job.jobId, ..., retentionClass, retentionDurationMs);
```

**`retain_until`:**

Written at disposition inside:
- `jobStore.markApplySuccess()` (for APPLIED)
- `jobStore.discardJob()` (for DISCARDED)

```typescript
// At disposition — ONE canonical timestamp T
const dispositionAt = nowIso();  // single canonical value
const retainUntil = new Date(Date.parse(dispositionAt) + retentionDurationMs).toISOString();

// For APPLIED: Inside the SAME atomic transaction as the disposition transition
UPDATE agent_jobs
SET status = 'APPLIED', applied_at = ?, disposition_at = ?, retain_until = ?
WHERE job_id = ? AND status = 'COMPLETED';
// applied_at and disposition_at receive the SAME timestamp value

// For DISCARDED: Inside the SAME atomic transaction
UPDATE agent_jobs
SET status = 'DISCARDED', disposition_at = ?, retain_until = ?
WHERE job_id = ? AND status = 'COMPLETED';
```

**Atomicity requirement:** All disposition timestamps (`applied_at`, `disposition_at`, `retain_until`) MUST be written in the SAME DB transaction as the disposition transition (COMPLETED → APPLIED/DISCARDED). This ensures the retention decision is historically frozen when disposition occurs.

**Timestamp atomicity:** Generate ONE canonical timestamp and use it for both `applied_at` and `disposition_at` (for APPLIED) or `disposition_at` alone (for DISCARDED). Do NOT independently call `Date.now()` or `nowIso()` multiple times within the same disposition transaction.

**Do not calculate `retain_until` later in collector code.** Calculate and persist it atomically at disposition time.

**Validation:** Implementation must fail closed if persisted `retention_duration_ms` is not a positive safe integer, or if `retain_until` is malformed/unparsable. Malformed durable retention metadata: RETAIN + REPORT, NEVER AUTO DELETE.

### Read Points

**GC eligibility query** (`evidenceCollector.collectExpiredEvidence()`):

```sql
-- Collector obtains one canonical nowIso timestamp
-- Use julianday for safe canonical comparison
SELECT job_id, artifact_volume, retention_duration_ms
FROM agent_jobs
WHERE artifact_state = 'AVAILABLE'
  AND status IN ('APPLIED', 'DISCARDED')
  AND retention_class IS NOT NULL
  AND retention_duration_ms IS NOT NULL
  AND retain_until IS NOT NULL
  AND julianday(retain_until) <= julianday(?)  -- ? = collector's nowIso timestamp
  AND ... (other safety checks)
```

**Validation:** If `retention_duration_ms` is not a positive safe integer, or if `retain_until` is NULL/malformed, fail closed (do not match, do not expire).

**Legacy job classification** (Lane B or general GC refusal):

```sql
WHERE retention_class IS NULL
   OR retention_duration_ms IS NULL
```

### Migration SQL

```sql
-- v4 → v5 migration (inside jobStore.migrate())
IF version < 5:
  IF NOT columnExists('agent_jobs', 'retention_class'):
    ALTER TABLE agent_jobs ADD COLUMN retention_class TEXT;
  END IF
  IF NOT columnExists('agent_jobs', 'retention_duration_ms'):
    ALTER TABLE agent_jobs ADD COLUMN retention_duration_ms INTEGER;
  END IF
  IF NOT columnExists('agent_jobs', 'retain_until'):
    ALTER TABLE agent_jobs ADD COLUMN retain_until TEXT;
  END IF
  PRAGMA user_version = 5;
END IF
```

**Legacy behavior:** All existing v4 job rows will have these columns as NULL after migration. This is correct and intentional. They will NOT be backfilled.

---

## Failure / Incomplete Evidence Retention (FROZEN)

### No Automatic Expiry for A6

Jobs with terminal failure status or incomplete evidence do NOT follow the same automatic expiry path as APPLIED/DISCARDED.

**Affected statuses:**

- `FAILED_PRECONDITION`
- `FAILED_POLICY`
- `FAILED_AGENT`
- `FAILED_TIMEOUT`
- `FAILED_INFRASTRUCTURE`
- `CANCELLED`

**Lane B implementation:** IDENTIFY + CLASSIFY + REPORT + RETAIN

**Do NOT require `retention_duration_ms` or `retain_until` to be usable for failure evidence.** These fields may be NULL for jobs that never reach APPLIED/DISCARDED.

**Do NOT fabricate `retain_until` for a job that never reaches disposition.**

**Lane B classifier output:** Structured log or report identifying incomplete evidence for manual review. NOT automatic deletion.

---

## Test Architecture (FROZEN)

### Retention Persistence Tests

**File:** `tests/unit/agent-jobstore.test.ts` (extend existing) and `tests/unit/agent-jobstore-migration.test.ts` (new)

**Migration tests (new file):**
- **v4→v5 migration leaves all legacy retention fields NULL:** Migrate existing v4 DB with jobs, verify all jobs have `retention_class=NULL`, `retention_duration_ms=NULL`, `retain_until=NULL`
- **fresh-v5 and migrated-v5 schema column sets match:** Create fresh v5 DB, migrate v4 DB to v5, compare schema (column names, types, indexes)

**Retention persistence tests (extend existing):**
- **ephemeral job persists 24h resolved duration:** Create job with `resourcePolicy=economy` (ephemeral), verify `retention_class='ephemeral'`, `retention_duration_ms=86400000`
- **short job persists 14d resolved duration:** Create job with `resourcePolicy=standard` (short), verify `retention_class='short'`, `retention_duration_ms=1209600000`
- **audit job persists 180d resolved duration:** Create job with `resourcePolicy=deep` (audit), verify `retention_class='audit'`, `retention_duration_ms=15552000000`
- **later config changes do not change persisted historical duration:** Create job, mutate `AGENT_RETENTION_DURATION_MS` in memory (test-only), create another job, verify first job retains original duration
- **APPLIED writes applied_at == disposition_at atomically:** Transition job to APPLIED, verify `applied_at` and `disposition_at` are set to the SAME timestamp value
- **APPLIED retain_until derives from exact disposition timestamp:** Transition job to APPLIED, verify `retain_until = disposition_at + retention_duration_ms` (exact arithmetic)
- **DISCARDED retain_until derives from exact disposition_at:** Transition job to DISCARDED, verify `retain_until = disposition_at + retention_duration_ms`
- **malformed retention_duration_ms fails closed:** Create job with artificially corrupted `retention_duration_ms` (non-integer, negative), verify GC eligibility check fails closed (does not expire)
- **malformed retain_until fails closed:** Create job with artificially corrupted `retain_until` (non-ISO string, unparsable), verify GC eligibility check fails closed

**Use deterministic clocks (Date.now mocked). Do NOT use real sleeps.**

### Lane A Tests

**File:** `tests/unit/agent-evidence-collector.test.ts` (new)

- **APPLIED before retain_until → retain:** Job with `status=APPLIED`, `retain_until` in future, verify NOT eligible for deletion
- **APPLIED at/after retain_until → expire/delete:** Job with `status=APPLIED`, `retain_until` in past, verify eligible, transition to EXPIRED, delete volume (test timestamp boundary: exact equality + 1ms past)
- **DISCARDED before retain_until → retain:** Same as APPLIED
- **DISCARDED at/after retain_until → expire/delete:** Same as APPLIED (test timestamp boundary)
- **COMPLETED → retain regardless of age:** Job with `status=COMPLETED`, old `completed_at`, verify NOT eligible (awaiting disposition)
- **legacy missing durable policy → retain/report:** Job with `retention_class=NULL`, verify NOT eligible, classification = LEGACY_RETENTION_UNKNOWN
- **UNCERTAIN → retain:** Job with UNCERTAIN apply attempt, verify NOT eligible
- **quarantined job → retain:** Job that is `quarantine_causing_job_id`, verify NOT eligible (source column name)
- **unrelated job in quarantined project → normal eligibility:** Job in project P, different job Q caused quarantine for P (Q is `quarantine_causing_job_id`), verify original job eligible if otherwise meets criteria

### Delete Completion Tests

**File:** `tests/unit/agent-evidence-collector.test.ts`

- **EXPIRED + correct existing volume → delete:** Job with `artifact_state=EXPIRED`, volume exists with correct labels, verify idempotent deletion
- **EXPIRED + already missing volume → idempotent success:** Job with `artifact_state=EXPIRED`, volume absent, explicitly handle Docker not-found condition, verify no error, remains EXPIRED
- **EXPIRED + wrong labels → refuse:** Job with `artifact_state=EXPIRED`, volume exists with malformed labels, verify refusal, log anomaly
- **EXPIRED + mismatched volume identity → refuse:** Job with `artifact_state=EXPIRED`, volume name does not match expected deterministic pattern, verify refusal
- **EXPIRED + wrong job label → refuse:** Job with `artifact_state=EXPIRED`, volume exists with correct `managed`/`resource` but `job` label points to different jobId, verify refusal (identity correlation failure)

### Integrity Anomaly Tests

**File:** `tests/unit/agent-evidence-collector.test.ts`

- **AVAILABLE + expected volume missing → report anomaly, do NOT transition EXPIRED:** Job with `artifact_state=AVAILABLE`, volume absent (no prior EXPIRED decision), verify anomaly logged, `artifact_state` unchanged

### Lane B Tests

**File:** `tests/unit/agent-evidence-collector.test.ts`

- **BEFORE exists + FAILED_AGENT:** Job with `artifact_state=NONE`, `status=FAILED_AGENT`, evidence volume exists, verify classification = LEGITIMATE_FAILURE_EVIDENCE, NOT deleted
- **partial POST:** Job with `status=FAILED_TIMEOUT`, incomplete POST, evidence volume exists, verify classification = LEGITIMATE_FAILURE_EVIDENCE, NOT deleted
- **canonical build interrupted:** Job with `status=FAILED_INFRASTRUCTURE`, BEFORE + POST exist but no canonical, verify classification = LEGITIMATE_FAILURE_EVIDENCE, NOT deleted
- **manifest exists but DB publication absent:** Evidence volume with canonical artifact, job row has `artifact_state=NONE` / `artifact_volume=NULL`, verify classification = INCONSISTENT_STATE, NOT deleted
- **evidence with missing DB row:** Evidence volume exists with correct labels, no DB job row, verify classification = ORPHANED_DB_MISSING, NOT deleted
- **malformed labels:** Evidence volume exists with `managed=true` but missing `resource` label, verify classification = AMBIGUOUS_LABELS, NOT deleted
- **inconsistent terminal status/artifact state:** Job with `status=APPLIED` but `artifact_state=NONE`, verify classification = INCONSISTENT_STATE, NOT deleted
- **legacy row:** Job with `retention_class=NULL`, verify classification = LEGACY_RETENTION_UNKNOWN, NOT deleted
- **post-recovery FAILED_INFRASTRUCTURE classification:** Job with `status=FAILED_INFRASTRUCTURE` (after startup recovery), verify classification does NOT claim crash provenance, uses current terminal status only
- **prefix-matching evidence volume with malformed labels:** Volume matching `io-mcp-ide-bridge-evidence-*` pattern but missing bridge ownership labels, verify classification = AMBIGUOUS_LABELS, discovered by prefix-based discovery, NOT deleted

**Each MUST produce:** Deterministic classification + NO AUTO DELETE

### Startup Ordering Tests

**File:** `tests/integration/a6-evidence-lifecycle.test.ts`

**Prove:**

```
recovery
→ ephemeral reconcile (sandbox.reconcileOrphans — AWAITED synchronously)
→ EXPIRED delete completion (evidenceCollector.reconcileExpiredEvidence)
→ Lane A collector (evidenceCollector.collectExpiredEvidence)
→ Lane B classifier (evidenceCollector.classifyIncompleteEvidence)
→ server readiness (server.listen)
```

**Additional startup tests:**
- **startup waits for reconcileOrphans:** Verify `sandbox.reconcileOrphans()` completes synchronously before evidence lifecycle pass
- **global startup failure:** Mock SQLite/Docker unavailable during lifecycle processing, verify startup fails closed
- **per-resource startup failure:** Mock one malformed volume during classification, verify startup continues, other resources processed normally

**Verify:** No `agent_diff` can race collector (service not available until after collection completes)

### Full Regression Tests

**Future implementation validation MUST include:**

- B4 `agent_diff` (artifact reader, canonical manifest, diff rendering)
- B5 `agent_apply` (apply engine, preconditions, mutation, rollback, journal)
- B6 `agent_discard` (discard admission, active apply check, UNCERTAIN check)
- P1 guarded apply policy (path validation, mode safety, guarded paths)
- B5 Docker integration tests (real applier container, real host project)
- Full unit suite (all A0-A6 tests)
- `npm run typecheck` (zero type errors)
- `npm run build` (zero build errors)
- `git diff --check` (zero trailing whitespace)

**No regression is acceptable.** A6 implementation must pass ALL prior tests plus new GC tests.

---

## A6 Completion Status (FROZEN)

**A6_COMPLETE_AFTER_RESOURCE_LIFECYCLE_IMPLEMENTATION: YES**

**Reasoning:**

A6's accepted obligations are:

1. **`agent_discard`** — COMPLETE (B6, committed at HEAD `24582afa`)
2. **Evidence retention/expiry lifecycle** — satisfied by Lane A implementation (published artifact automatic expiry according to approved retention policy)
3. **Retained-resource GC distinguishing legitimate vs abandoned** — satisfied by Lane A + Lane B classification (incomplete evidence identified, classified, reported; legitimate failure evidence retained)

**Lane B provides classification and fail-closed retention, NOT automatic deletion.** This satisfies the "distinguish legitimate from abandoned" requirement. Automatic deletion of incomplete evidence is a future enhancement beyond A6 scope.

**Remaining after A6 functional implementation:**

- A6 closeout documentation (architecture reconciliation, test results summary, security checklist)
- A6 regression gate validation (all prior tests + new GC tests pass)
- Independent A6 final acceptance audit (evidence review, implementation consistency verification)

These are **documentation and verification activities**, not unfinished functional implementation.

**Therefore, A6 is FUNCTIONALLY COMPLETE after:**

- Lane A implementation (published-evidence expiry)
- Lane B implementation (incomplete-evidence classification)
- Schema migration (v5 durable retention snapshot)
- Startup integration (correct ordering)
- Test coverage (unit + integration)
- Regression validation (all prior tests pass)
- Final A6 closeout

---

## Architecture Status (FROZEN)

**ARCHITECTURE_STATUS: READY**

**IMPLEMENTATION_READY: YES**

All policy decisions resolved. All concurrency ambiguities resolved. All proof requirements frozen. Implementation path frozen.

**No source-level blockers remain.**

---

## Remaining Functional A6 Requirements

**NONE.**

All A6 functional requirements are satisfied by:

- Lane A (published-evidence lifecycle)
- Lane B (incomplete-evidence classification)
- Durable retention snapshot (immutable policy decisions)
- Startup-only collection (safe concurrency model)
- Fail-closed eligibility proofs (ownership + safety gates)
- Metadata retention (indefinite audit continuity)

---

## Implementation Effort Estimate (Informational)

### Production Code

- **Schema migration (jobStore.ts v4 → v5):** ~30 lines
- **Retention persistence at job creation (jobEngine.ts / jobStore.ts):** ~20 lines
- **Retention duration constant (shared/agents.ts):** ~10 lines
- **Disposition-time retain_until calculation (jobStore.ts markApplySuccess / discardJob):** ~20 lines
- **evidenceCollector.ts (new file):** ~350 lines
- Lane A expiry admission: ~100 lines
- Delete completion reconciler: ~50 lines
- Lane B classifier: ~150 lines
- Helper utilities (volume identity, label verification, logging): ~50 lines
- **Startup integration (index.ts):** ~30 lines

**Total production code:** ~480 lines (includes timestamp atomicity fixes, malformed metadata validation, awaited startup ordering)

### Test Code

- **Unit tests (agent-jobstore-migration.test.ts):** ~150 lines
- **Unit tests (agent-jobstore.test.ts extensions):** ~120 lines
- **Unit tests (agent-jobengine.test.ts):** ~100 lines
- **Unit tests (agent-evidence-collector.test.ts):** ~450 lines
- Lane A eligibility tests: ~180 lines (includes timestamp boundary cases)
- Delete completion tests: ~80 lines (includes identity correlation, explicit Docker not-found handling)
- Integrity anomaly tests: ~40 lines
- Lane B classification tests: ~150 lines (includes post-recovery accuracy, prefix discovery)
- **Integration tests (a6-evidence-lifecycle.test.ts):** ~300 lines
- End-to-end lifecycle: ~120 lines
- Crash consistency: ~100 lines
- Startup ordering: ~80 lines (includes awaited reconcileOrphans, global/per-resource failure)

**Total test code:** ~1,120 lines

**Total A6 implementation:** ~1,600 lines (production + tests)

**Additional lines from R3/R4 reconciliation:** +490 lines (additional test coverage, validation, atomicity, bounded reporting, malformed metadata handling)

**Excludes:** Documentation, audit closeout, regression validation harness (not counted as "implementation").

---

END A6 RETAINED-RESOURCE LIFECYCLE ARCHITECTURE R3/R4 FINAL FREEZE


---

## A6 IMPLEMENTATION CLOSEOUT

**Documented status above reflects architecture freeze, NOT current verified implementation state.**

This closeout records completion and verification evidence for the retained-resource lifecycle implementation.

### Architecture Status

The R3/R4 architecture specification remains **NORMATIVE and UNCHANGED**. All implementation and verification were executed against R3/R4 frozen requirements. No architecture changes occurred during implementation.

### Implementation Commits

**A6 functional-completion commit:**

```
0121b31d56bdab85663d8a8bfb36a3e41dc6a575
feat: add retained-resource lifecycle
```

This commit delivered:
- Lane A published-evidence expiry (automatic AVAILABLE → EXPIRED transition + physical deletion)
- Lane B incomplete-evidence classification (IDENTIFY + CLASSIFY + REPORT + RETAIN)
- Schema migration v4 → v5 (durable retention snapshot: `retention_class`, `retention_duration_ms`, `retain_until`)
- Startup-only collection (awaited synchronous execution before service availability)
- Fail-closed eligibility proofs (ownership + safety gates)
- Metadata retention (indefinite job/apply/journal record preservation)

**Post-implementation remediation:**

```
91fb583ff26cfb7a59c1a8ba71be706e252cdd55
fix: harden filesystem ownership and path handling
```

Classification: **filesystem/path remediation relevant to final deployed acceptance**, NOT retained-resource lifecycle architecture. This commit addressed executor ownership hardening and path canonicalization edge cases discovered during deployed integration testing. It did NOT change the A6 lifecycle architecture, evidence retention model, or collection semantics.

**Closeout reconciliation baseline:**

```
0d886883cf7ffdb4a482580dd64fc8426aaa7e59
chore: add python tooling to review targets
```

This is the pre-closeout repository baseline (Python tooling addition unrelated to lifecycle implementation). A6 functional implementation is COMPLETE at this baseline.

### Verification Evidence

**Post-remediation full unit suite:**

```
1398 / 1398 PASS
```

All prior unit tests plus new A6 lifecycle tests passed after remediation.

**Exact P1 reconciliation (guarded apply policy):**

```
126 / 126 PASS
```

P1 path validation, mode safety, and guarded-path enforcement remain intact.

**Focused lifecycle reconciliation suite:**

```
188 / 188 PASS
```

Targeted verification of retention persistence, Lane A expiry, Lane B classification, delete completion, integrity anomalies, malformed metadata, timestamp atomicity, and startup ordering.

**Deployed executor acceptance:**

```
PASS
```

Real deployed executor with actual agent jobs database, actual evidence volumes, real Docker environment. Lifecycle collection executed successfully at startup. No unbounded resource accumulation.

**Real ChatGPT-origin MCP acceptance:**

```
PASS
```

Live MCP client invoked agent dispatch, received results, evidence lifecycle operated correctly in deployed production-equivalent environment.

### Lifecycle Status

**LIFECYCLE_STATUS:** IMPLEMENTED / VERIFIED

**A6_FUNCTIONAL_STATUS:** COMPLETE

All A6 retained-resource lifecycle obligations satisfied:

1. **Lane A (published-evidence expiry)** — automatic time-based expiry for APPLIED/DISCARDED jobs with published canonical artifacts; durable retention snapshot (immutable policy decisions); fail-closed eligibility proofs; atomic AVAILABLE → EXPIRED transition; idempotent physical deletion.

2. **Lane B (incomplete-evidence classification)** — identifies and classifies incomplete/failed/orphaned evidence; reports bounded structured findings; RETAINS all Lane B evidence (no automatic deletion); distinguishes legitimate failure evidence from abandoned/incomplete resources.

3. **Durable retention snapshot** — persisted `retention_class`/`retention_duration_ms`/`retain_until` at job creation/disposition; immutable against future config changes; fail-closed for legacy jobs.

4. **Startup-only collection** — lifecycle pass completes synchronously before executor service availability; no concurrent agent operations during collection; safe concurrency model without read locks/refcounts.

5. **Metadata retention** — job rows, apply attempts, apply journal, project quarantine state retained indefinitely; historical database truth preserved; only physical evidence bytes expire.

### A6 Complete

A6 satisfied all accepted obligations from Master PRD §32 and B2 future obligations:

- `agent_discard` implementation (B6, prior to A6 functional implementation)
- Evidence retention/expiry lifecycle (Lane A automatic expiry according to approved retention policy)
- Retained-resource GC distinguishing legitimate vs abandoned evidence (Lane A + Lane B classification/reporting)

Remaining after A6 functional implementation: **documentation reconciliation only** (this closeout + current-state updates across PRD and architecture docs).

A6 is **FUNCTIONALLY COMPLETE and VERIFIED** at baseline `0d886883cf7ffdb4a482580dd64fc8426aaa7e59`.

**Next phase:** A7 — GitHub Copilot backend (after A6 documentation closeout).

---

END A6 IMPLEMENTATION CLOSEOUT


---

## IMPLEMENTATION CLOSEOUT RECONCILIATION

**Status:** IMPLEMENTED / VERIFIED
**Phase:** A6 — COMPLETE
**Closeout reconciliation baseline:** `0d886883cf7ffdb4a482580dd64fc8426aaa7e59` —
`chore: add python tooling to review targets`

### Architecture status

The R3/R4 architecture freeze reflected in this document's header/status is the historical
architecture-ready state. **R3/R4 remains the normative architecture specification.** This closeout
section records that the architecture has now been successfully implemented and verified.

### Implementation evidence

**Lifecycle implementation commit:** `0121b31d56bdab85663d8a8bfb36a3e41dc6a575` —
`feat: add retained-resource lifecycle`

**Post-implementation remediation:** `91fb583ff26cfb7a59c1a8ba71be706e252cdd55` —
`fix: harden filesystem ownership and path handling` (filesystem/path remediation relevant to final
deployed acceptance; **not** part of the retained-resource lifecycle architecture itself)

### Verification evidence

**Post-remediation full unit test suite:** 1398 / 1398 PASS

**Exact P1 reconciliation test suite:** 126 / 126 PASS

**Focused lifecycle reconciliation test suite:** 188 / 188 PASS

**Deployed executor acceptance:** PASS

**Real ChatGPT-origin MCP acceptance:** PASS

### Implementation scope satisfied

All A6 functional requirements delivered:

- **Guarded agent_diff:** Implemented and activated; canonical artifact-based diff rendering with
  workspace-relative paths; fail-closed artifact availability checks; bounded structured output;
  registered as operational MCP tool with strict schema.

- **Guarded agent_apply:** Implemented and activated; precondition-gated apply engine with base
  commit verification, working-tree cleanliness policy, guarded-path enforcement; atomic
  patch-based application with rollback on failure; fail-closed artifact + evidence proofs; durable
  apply journal (schema v5); project-level quarantine state enforcement; registered as operational
  MCP tool with strict schema.

- **Guarded agent_discard:** Implemented and activated; fail-closed admission checks (no active/
  UNCERTAIN apply attempts); leaves live source unchanged; preserves audit evidence according to
  retention policy; registered as operational MCP tool with strict schema.

- **Retained-resource lifecycle:** Lane A (published-evidence expiry) and Lane B (incomplete-
  evidence classification) collectors implemented per R3/R4; durable retention snapshot (schema v5:
  `retention_class`, `retention_duration_ms`, `retain_until`); immutable policy decisions;
  fail-closed eligibility proofs; timestamp atomicity for disposition; startup-only collection with
  synchronous ordering; bounded structured reporting.

- **Durable schema-v5 retention metadata:** Migration v4→v5 implemented and verified; retention
  fields persisted at job creation; `retain_until` calculated atomically at disposition; legacy
  jobs fail closed to RETAIN.

- **Lane A expiry:** Automatic published-evidence expiry for APPLIED/DISCARDED jobs that have
  reached `retain_until`; atomic AVAILABLE→EXPIRED transition with full ownership/label/identity
  proofs; idempotent physical volume deletion; implemented per R3/R4 proof requirements.

- **Lane B classification/reporting:** Incomplete/failed evidence classifier identifies and reports
  legitimate failure evidence, orphaned resources, ambiguous labels, inconsistent state, legacy
  retention-unknown; bounded prefix-based discovery for malformed-label detection; RETAIN + REPORT
  only (no automatic deletion); implemented per R3/R4.

- **Startup lifecycle ordering:** `sandbox.reconcileOrphans()` awaited synchronously before
  evidence lifecycle pass; expiry reconciliation, Lane A collection, and Lane B classification
  complete before service availability; per-resource failures do not block startup; global failures
  fail startup closed.

- **Fail-closed resource proofs:** All expiry admission checks (15-point proof), delete completion
  identity correlation, malformed retention metadata validation, unexpected volume loss detection,
  UNCERTAIN/quarantine evidence holds implemented and unit-tested per R3/R4.

- **Regression validation:** All pre-A6 unit tests (1210/1210 prior to lifecycle), integration
  tests, typecheck, and build pass; no regression in existing Agent Control Plane or bridge tools.

- **Independent acceptance:** Full A6 lifecycle reconciliation performed independently; exact test
  evidence recorded; deployed real executor acceptance verified; real ChatGPT MCP integration
  confirmed operational.

### A6 functional status

**A6 COMPLETE.** All retained-resource lifecycle obligations satisfied. Remaining work after A6
functional implementation consists of documentation closeout and verification activities only, not
unfinished functional implementation.
