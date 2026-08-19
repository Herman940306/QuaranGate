/**
 * A6 Retained-Resource Lifecycle — Evidence Collector (Phase A6).
 *
 * Bounded, fail-closed startup-only lifecycle pass. Runs BEFORE the executor
 * accepts any agent requests (see src/executor/index.ts startup sequence).
 *
 * Three responsibilities:
 *
 *   reconcileExpiredEvidence()  — delete-completion for jobs already durably
 *                                 EXPIRED in DB (Proof B). Handles crash
 *                                 recovery: EXPIRED is the durable authorization;
 *                                 the physical delete is just completing it.
 *
 *   collectExpiredEvidence()    — Lane A: admit new AVAILABLE→EXPIRED transitions
 *                                 for jobs whose retain_until has elapsed, then
 *                                 complete the physical deletes (Proof A + B).
 *
 *   classifyIncompleteEvidence() — Lane B: classify and report retained evidence
 *                                  that is not a Lane A candidate. RETAIN + REPORT
 *                                  only — NO automatic deletion.
 *
 * All three functions are exported individually and wrapped by the convenience
 * function runStartupEvidenceLifecycle() which is the primary entry point used
 * by index.ts.
 *
 * Failure policy:
 *   - Global failure (DB unavailable, Docker unavailable, unexpected throw at
 *     the collector level): propagated to the caller, which FAILS STARTUP CLOSED.
 *   - Per-resource failure (wrong labels, identity mismatch, delete failure,
 *     integrity anomaly): RETAIN the resource, add to the structured report,
 *     continue processing other resources. Startup may proceed.
 */
import { BridgeError } from '../../shared/errors.js';
import { AGENT_RETENTION_CLASSES } from '../../shared/agents.js';
import {
  LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB,
} from './sandboxSpec.js';
import {
  listVolumesByFilter, removeVolume,
  type VolumeSummary,
} from '../docker.js';
import type { AgentJobStore } from './jobStore.js';

// ---------------------------------------------------------------------------
// Re-export label constants from sandboxSpec (used by tests)
// ---------------------------------------------------------------------------

export { LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB } from './sandboxSpec.js';

// ---------------------------------------------------------------------------
// Deterministic evidence volume naming
// ---------------------------------------------------------------------------

const EVIDENCE_VOLUME_PREFIX = 'io-mcp-ide-bridge-evidence-';

/**
 * Deterministic per-job evidence volume name. Mirrors the naming convention
 * used by runnerAssets.ts (which creates the volume at job time). This must
 * never be caller-influenced.
 */
export function evidenceVolumeName(jobId: string): string {
  return `${EVIDENCE_VOLUME_PREFIX}${jobId}`;
}

// ---------------------------------------------------------------------------
// Reporting constants
// ---------------------------------------------------------------------------

/** Maximum sample identifiers emitted per Lane B classification category. */
const SAMPLE_BOUND = 10;

// ---------------------------------------------------------------------------
// Lane B classification categories (frozen)
// ---------------------------------------------------------------------------

export type LaneBClassification =
  | 'LEGITIMATE_FAILURE_EVIDENCE'
  | 'ORPHANED_DB_MISSING'
  | 'AMBIGUOUS_LABELS'
  | 'INCONSISTENT_STATE'
  | 'LEGACY_RETENTION_UNKNOWN';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ReconcileExpiredResult {
  /** Jobs where delete-completion succeeded (volume was present and deleted). */
  deleteSuccessCount: number;
  /** Jobs where volume was already absent (idempotent success). */
  alreadyAbsentCount: number;
  /** Jobs where identity proof failed or delete errored — RETAIN + REPORT. */
  retainedCount: number;
  /** Bounded sample of retained job IDs with reasons. */
  retainedSamples: Array<{ jobId: string; reason: string }>;
}

export interface CollectExpiredResult {
  /** Jobs admitted from AVAILABLE→EXPIRED and their volumes deleted. */
  expiredCount: number;
  /** Jobs that were eligible candidates but failed admission or delete. */
  retainedCount: number;
  /** Integrity anomalies: AVAILABLE + recorded volume absent from Docker. */
  integrityAnomalyCount: number;
  retainedSamples: Array<{ jobId: string; reason: string }>;
  integrityAnomalySamples: Array<{ jobId: string; artifactVolume: string }>;
}

export interface LaneBCategoryReport {
  count: number;
  samples: string[];
  suppressed: number;
}

export interface ClassifyIncompleteResult {
  /** Total Docker evidence volumes scanned (exact-label + prefix paths). */
  totalScanned: number;
  byClassification: Record<LaneBClassification, LaneBCategoryReport>;
}

export interface StartupEvidenceLifecycleResult {
  reconcile: ReconcileExpiredResult;
  collect: CollectExpiredResult;
  classify: ClassifyIncompleteResult;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function log(msg: string, fields: Record<string, unknown>): void {
  // Prompts, credentials, raw artifact content are never logged here.
  console.log(JSON.stringify({ level: 'info', msg, ...fields }));
}

function logWarn(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'warn', msg, ...fields }));
}

/**
 * Validate that a Docker volume satisfies exact bridge ownership labels for
 * a specific jobId. All three labels must be present and correct.
 *
 * Returns null on success or a string describing the proof failure.
 */
function probeOwnershipLabels(
  labels: Record<string, string> | null | undefined,
  jobId: string,
): string | null {
  if (!labels) return 'volume has no labels';
  if (labels[LABEL_MANAGED] !== 'true') return `${LABEL_MANAGED} != "true" (got ${String(labels[LABEL_MANAGED])})`;
  if (labels[LABEL_RESOURCE] !== 'evidence') return `${LABEL_RESOURCE} != "evidence" (got ${String(labels[LABEL_RESOURCE])})`;
  if (labels[LABEL_JOB] !== jobId) return `${LABEL_JOB} != "${jobId}" (got ${String(labels[LABEL_JOB])})`;
  return null;
}

/**
 * Validate a retain_until ISO string using julianday-equivalent logic:
 * parse it as a Date and compare to nowMs. Returns null if valid and elapsed,
 * or a string reason if invalid or not yet elapsed.
 *
 * Mirrors the SQL: julianday(retain_until) <= julianday(nowIso).
 * At exact equality: eligible. Before equality: not eligible.
 */
function checkRetainUntilElapsed(retainUntil: string, nowMs: number): string | null {
  const t = Date.parse(retainUntil);
  if (!Number.isFinite(t)) return `retain_until is malformed/unparsable: "${retainUntil}"`;
  if (t > nowMs) return `retain_until (${retainUntil}) has not elapsed yet`;
  return null;
}

/**
 * Validate persisted retention_duration_ms: must be a positive safe integer.
 */
function checkRetentionDurationMs(rdms: number | null): string | null {
  if (rdms === null) return 'retention_duration_ms is NULL';
  if (!Number.isSafeInteger(rdms) || rdms <= 0) return `retention_duration_ms is invalid: ${rdms}`;
  return null;
}

/**
 * Check whether a retention class string is a valid AgentRetentionClass.
 */
function isValidRetentionClass(rc: string | null): boolean {
  return rc !== null && (AGENT_RETENTION_CLASSES as readonly string[]).includes(rc);
}

// ---------------------------------------------------------------------------
// PROOF B — Delete Completion
// ---------------------------------------------------------------------------

/**
 * Complete the physical deletion of an already-authorized (artifact_state=EXPIRED)
 * evidence volume. Performs full identity correlation before any delete:
 *
 *   1. artifact_volume from DB == evidenceVolumeName(jobId) (deterministic)
 *   2. Docker volume name matches artifact_volume
 *   3. managed label == "true"
 *   4. resource label == "evidence"
 *   5. job label == jobId
 *
 * Returns:
 *   'deleted'       — volume existed and was successfully removed
 *   'already-absent' — volume not found (idempotent success)
 *   string          — a failure/refuse reason (RETAIN + REPORT)
 */
async function deleteCompletionProof(
  jobId: string,
  artifactVolume: string,
): Promise<'deleted' | 'already-absent' | string> {
  // 1. Deterministic name agreement.
  const expected = evidenceVolumeName(jobId);
  if (artifactVolume !== expected) {
    return `artifact_volume "${artifactVolume}" does not match expected deterministic name "${expected}"`;
  }

  // 2–5. Fetch the actual Docker volume and verify labels.
  let vol: VolumeSummary | undefined;
  try {
    const vols = await listVolumesByFilter({ name: [artifactVolume] });
    vol = vols.find((v) => v.Name === artifactVolume);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    return `Docker volume list failed: ${msg}`;
  }

  if (!vol) {
    // Volume absent — idempotent completion (Docker not-found is success here).
    return 'already-absent';
  }

  // Identity proof against Docker labels.
  const labelFail = probeOwnershipLabels(vol.Labels, jobId);
  if (labelFail) {
    return `identity proof failed: ${labelFail}`;
  }

  // All proofs passed — execute the physical delete.
  try {
    await removeVolume(artifactVolume, true);
    return 'deleted';
  } catch (e) {
    if (e instanceof BridgeError && e.httpStatus === 404) {
      // Race: volume was removed between list and delete. Idempotent success.
      return 'already-absent';
    }
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    return `delete failed: ${msg} (artifact_state remains EXPIRED; will retry on next startup)`;
  }
}

// ---------------------------------------------------------------------------
// RECONCILE PREVIOUSLY EXPIRED (startup crash recovery)
// ---------------------------------------------------------------------------

/**
 * At startup: find all jobs where artifact_state=EXPIRED and artifact_volume
 * is recorded. For each, run Proof B (delete-completion identity proof).
 *
 * Does NOT re-run Lane A admission. EXPIRED is already the durable
 * authorization. This function only completes already-authorized deletions.
 *
 * Global failures (DB read, Docker unavailable) propagate to caller.
 * Per-resource failures: RETAIN + REPORT, continue.
 */
export async function reconcileExpiredEvidence(
  store: AgentJobStore,
): Promise<ReconcileExpiredResult> {
  const result: ReconcileExpiredResult = {
    deleteSuccessCount: 0,
    alreadyAbsentCount: 0,
    retainedCount: 0,
    retainedSamples: [],
  };

  const expired = store.queryExpiredWithVolume();
  log('evidence lifecycle: reconcile previously EXPIRED', { count: expired.length });

  for (const { jobId, artifactVolume } of expired) {
    const outcome = await deleteCompletionProof(jobId, artifactVolume);
    if (outcome === 'deleted') {
      result.deleteSuccessCount++;
      log('evidence lifecycle: EXPIRED volume deleted (reconcile)', { jobId, artifactVolume });
    } else if (outcome === 'already-absent') {
      result.alreadyAbsentCount++;
      log('evidence lifecycle: EXPIRED volume already absent (idempotent)', { jobId });
    } else {
      result.retainedCount++;
      logWarn('evidence lifecycle: EXPIRED volume retained (reconcile)', { jobId, artifactVolume, reason: outcome });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason: outcome });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// LANE A — Published Evidence Expiry
// ---------------------------------------------------------------------------

/**
 * Lane A collection pass. Obtains ONE canonical now timestamp for the entire
 * pass. For each DB-eligible job:
 *
 *   1. Validate persisted retention metadata (fail closed on malformed values).
 *   2. Call store.markExpired() — atomic AVAILABLE→EXPIRED transition.
 *   3. If authorized (rows changed), run Proof B (delete completion).
 *
 * Also detects integrity anomalies: AVAILABLE jobs whose expected volume is
 * absent from Docker with no prior EXPIRED decision.
 *
 * Global failures propagate to caller.
 * Per-resource failures: RETAIN + REPORT, continue.
 */
export async function collectExpiredEvidence(
  store: AgentJobStore,
): Promise<CollectExpiredResult> {
  const result: CollectExpiredResult = {
    expiredCount: 0,
    retainedCount: 0,
    integrityAnomalyCount: 0,
    retainedSamples: [],
    integrityAnomalySamples: [],
  };

  // ONE canonical now timestamp for the entire Lane A pass.
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  const candidates = store.queryRetentionEligible(nowIso);
  log('evidence lifecycle: Lane A candidates', { count: candidates.length, nowIso });

  for (const cand of candidates) {
    const { jobId, artifactVolume, retentionDurationMs, retainUntil } = cand;

    // Per-resource validation of persisted retention metadata.
    const rdmsErr = checkRetentionDurationMs(retentionDurationMs);
    if (rdmsErr) {
      result.retainedCount++;
      logWarn('evidence lifecycle: Lane A retain (malformed retention_duration_ms)', { jobId, reason: rdmsErr });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason: rdmsErr });
      }
      continue;
    }

    const retainUntilErr = checkRetainUntilElapsed(retainUntil, nowMs);
    if (retainUntilErr) {
      result.retainedCount++;
      logWarn('evidence lifecycle: Lane A retain (retain_until not elapsed)', { jobId, reason: retainUntilErr });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason: retainUntilErr });
      }
      continue;
    }

    if (!isValidRetentionClass(cand.retentionClass)) {
      result.retainedCount++;
      const reason = `invalid retention_class: "${cand.retentionClass}"`;
      logWarn('evidence lifecycle: Lane A retain (invalid retention_class)', { jobId, reason });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason });
      }
      continue;
    }

    // Deterministic name agreement before attempting expiry.
    const expected = evidenceVolumeName(jobId);
    if (artifactVolume !== expected) {
      result.retainedCount++;
      const reason = `artifact_volume "${artifactVolume}" != expected "${expected}"`;
      logWarn('evidence lifecycle: Lane A retain (volume name mismatch)', { jobId, reason });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason });
      }
      continue;
    }

    // Fetch Docker volume to verify labels before authorizing expiry.
    let vol: VolumeSummary | undefined;
    try {
      const vols = await listVolumesByFilter({ name: [artifactVolume] });
      vol = vols.find((v) => v.Name === artifactVolume);
    } catch (e) {
      result.retainedCount++;
      const reason = `Docker volume list failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
      logWarn('evidence lifecycle: Lane A retain (Docker error)', { jobId, reason });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason });
      }
      continue;
    }

    // Integrity anomaly: AVAILABLE + recorded volume absent + no prior EXPIRED.
    if (!vol) {
      result.integrityAnomalyCount++;
      logWarn('evidence lifecycle: INTEGRITY ANOMALY — AVAILABLE job expected volume absent', {
        jobId,
        artifactState: 'AVAILABLE',
        artifactVolume,
        status: cand.status,
        dispositionAt: cand.dispositionAt,
      });
      if (result.integrityAnomalySamples.length < SAMPLE_BOUND) {
        result.integrityAnomalySamples.push({ jobId, artifactVolume });
      }
      // artifact_state remains AVAILABLE. No fabricated expiry. Continue.
      continue;
    }

    // Verify Docker labels before authorizing the durable transition.
    const labelFail = probeOwnershipLabels(vol.Labels, jobId);
    if (labelFail) {
      result.retainedCount++;
      const reason = `label proof failed: ${labelFail}`;
      logWarn('evidence lifecycle: Lane A retain (label proof failed)', { jobId, reason });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason });
      }
      continue;
    }

    // Proof A: atomically authorize AVAILABLE→EXPIRED in the DB.
    // The SQL predicate re-checks all Lane A admission criteria atomically.
    let authorized: boolean;
    try {
      authorized = store.markExpired(jobId, nowIso);
    } catch (e) {
      result.retainedCount++;
      const reason = `markExpired threw: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
      logWarn('evidence lifecycle: Lane A retain (markExpired error)', { jobId, reason });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason });
      }
      continue;
    }

    if (!authorized) {
      // Race lost or criteria changed between query and update — safe to skip.
      result.retainedCount++;
      logWarn('evidence lifecycle: Lane A retain (markExpired CAS failed — race or criteria changed)', { jobId });
      if (result.retainedSamples.length < SAMPLE_BOUND) {
        result.retainedSamples.push({ jobId, reason: 'markExpired CAS returned false' });
      }
      continue;
    }

    // Proof B: complete the physical deletion (EXPIRED is now durable).
    const deleteOutcome = await deleteCompletionProof(jobId, artifactVolume);
    if (deleteOutcome === 'deleted') {
      result.expiredCount++;
      log('evidence lifecycle: Lane A expired and volume deleted', { jobId, artifactVolume });
    } else if (deleteOutcome === 'already-absent') {
      result.expiredCount++;
      log('evidence lifecycle: Lane A expired, volume already absent', { jobId });
    } else {
      // Delete failed — artifact_state is EXPIRED but volume remains.
      // Will be retried on next startup via reconcileExpiredEvidence().
      result.expiredCount++;
      logWarn('evidence lifecycle: Lane A expired (delete deferred to next startup)', {
        jobId, artifactVolume, reason: deleteOutcome,
      });
    }
  }

  // Also scan AVAILABLE+volume jobs that were NOT in the retention-eligible
  // set, to detect integrity anomalies (volume missing with no EXPIRED).
  // This catches cases where the volume was manually deleted without going
  // through the lifecycle path.
  const allAvailable = store.queryAvailableWithVolume();
  const eligibleJobIds = new Set(candidates.map((c) => c.jobId));
  for (const { jobId, artifactVolume, status } of allAvailable) {
    if (eligibleJobIds.has(jobId)) continue; // already checked above

    const expected = evidenceVolumeName(jobId);
    if (artifactVolume !== expected) continue; // non-standard volume — skip anomaly check

    // Check if the expected volume is actually missing from Docker.
    let volPresent = true;
    try {
      const vols = await listVolumesByFilter({ name: [artifactVolume] });
      volPresent = vols.some((v) => v.Name === artifactVolume);
    } catch {
      continue; // Docker error — skip; reconcileExpiredEvidence will retry
    }

    if (!volPresent) {
      result.integrityAnomalyCount++;
      logWarn('evidence lifecycle: INTEGRITY ANOMALY — AVAILABLE job expected volume absent (non-eligible)', {
        jobId,
        artifactState: 'AVAILABLE',
        artifactVolume,
        status,
      });
      if (result.integrityAnomalySamples.length < SAMPLE_BOUND) {
        result.integrityAnomalySamples.push({ jobId, artifactVolume });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// LANE B — Incomplete Evidence Classification
// ---------------------------------------------------------------------------

/** Terminal failure / CANCELLED statuses (Lane B legitimate failure candidates). */
const TERMINAL_FAILURE_STATUSES = new Set([
  'FAILED_PRECONDITION', 'FAILED_POLICY', 'FAILED_AGENT',
  'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED',
]);

/** Lane A success-disposition statuses. */
const SUCCESS_DISPOSITION_STATUSES = new Set(['APPLIED', 'DISCARDED']);

function emptyCategory(): LaneBCategoryReport {
  return { count: 0, samples: [], suppressed: 0 };
}

function addToCategory(
  cat: LaneBCategoryReport,
  id: string,
): void {
  cat.count++;
  if (cat.samples.length < SAMPLE_BOUND) {
    cat.samples.push(id);
  } else {
    cat.suppressed++;
  }
}

/**
 * Lane B: classify and report retained evidence volumes that are not Lane A
 * candidates. ALL Lane B outcomes are RETAIN + REPORT — no automatic deletion.
 *
 * Discovery path A: Docker volumes with exact bridge ownership labels
 *   (managed=true, resource=evidence, valid job label).
 *
 * Discovery path B: Docker volumes matching the evidence name prefix
 *   io-mcp-ide-bridge-evidence- that do NOT satisfy exact ownership labels.
 *   → AMBIGUOUS_LABELS, always.
 *
 * Classification (for path-A volumes not already handled by Lane A):
 *   LEGITIMATE_FAILURE_EVIDENCE  — terminal failure/CANCELLED, valid ownership
 *   ORPHANED_DB_MISSING          — valid labels, no DB job row
 *   INCONSISTENT_STATE           — impossible DB/Docker lifecycle combination
 *   LEGACY_RETENTION_UNKNOWN     — retained job missing required v5 retention fields
 *   AMBIGUOUS_LABELS             — prefix match only, no valid ownership
 *
 * Global failures propagate to caller.
 * Per-volume errors: classify as AMBIGUOUS_LABELS, RETAIN + REPORT, continue.
 */
export async function classifyIncompleteEvidence(
  store: AgentJobStore,
): Promise<ClassifyIncompleteResult> {
  const result: ClassifyIncompleteResult = {
    totalScanned: 0,
    byClassification: {
      LEGITIMATE_FAILURE_EVIDENCE: emptyCategory(),
      ORPHANED_DB_MISSING: emptyCategory(),
      AMBIGUOUS_LABELS: emptyCategory(),
      INCONSISTENT_STATE: emptyCategory(),
      LEGACY_RETENTION_UNKNOWN: emptyCategory(),
    },
  };

  // ---- Discovery path A: exact ownership labels ----
  let exactOwned: VolumeSummary[] = [];
  try {
    exactOwned = await listVolumesByFilter({
      label: [
        `${LABEL_MANAGED}=true`,
        `${LABEL_RESOURCE}=evidence`,
      ],
    });
  } catch (e) {
    throw new BridgeError(
      'DOCKER_UNAVAILABLE',
      `Lane B: failed to list bridge-owned evidence volumes: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
      503,
    );
  }

  // Track volumes classified via path A to avoid double-counting in path B.
  const classifiedVolumeNames = new Set<string>();

  for (const vol of exactOwned) {
    result.totalScanned++;
    classifiedVolumeNames.add(vol.Name);

    const labels = vol.Labels ?? {};
    const jobId = labels[LABEL_JOB] ?? null;

    // Missing/malformed job label → AMBIGUOUS_LABELS.
    if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
      addToCategory(result.byClassification.AMBIGUOUS_LABELS, vol.Name);
      logWarn('Lane B: AMBIGUOUS_LABELS (missing job label)', { volumeName: vol.Name });
      continue;
    }

    // Fetch DB row for this job.
    const dbJob = store.getJobForClassification(jobId);

    if (!dbJob) {
      // Volume has valid ownership labels but no matching DB row.
      addToCategory(result.byClassification.ORPHANED_DB_MISSING, jobId);
      logWarn('Lane B: ORPHANED_DB_MISSING', { volumeName: vol.Name, jobId });
      continue;
    }

    const { status, artifactState, artifactVolume } = dbJob;

    // Already EXPIRED — Lane A/reconcile handled or is handling this.
    // Not a Lane B concern; skip but count as scanned.
    if (artifactState === 'EXPIRED') {
      continue;
    }

    // INCONSISTENT_STATE: AVAILABLE + artifact_volume null
    if (artifactState === 'AVAILABLE' && artifactVolume === null) {
      addToCategory(result.byClassification.INCONSISTENT_STATE, jobId);
      logWarn('Lane B: INCONSISTENT_STATE (AVAILABLE + null artifact_volume)', { jobId, volumeName: vol.Name });
      continue;
    }

    // INCONSISTENT_STATE: APPLIED/DISCARDED + artifact_state is NONE or null
    if (SUCCESS_DISPOSITION_STATUSES.has(status) &&
        (artifactState === 'NONE' || artifactState === null)) {
      addToCategory(result.byClassification.INCONSISTENT_STATE, jobId);
      logWarn('Lane B: INCONSISTENT_STATE (APPLIED/DISCARDED + no artifact_state)', { jobId, volumeName: vol.Name });
      continue;
    }

    // LEGACY_RETENTION_UNKNOWN: retained job missing v5 retention snapshot
    // (any required field NULL) — cannot prove automatic expiry eligibility.
    if (
      dbJob.retentionClass === null ||
      dbJob.retentionDurationMs === null
    ) {
      addToCategory(result.byClassification.LEGACY_RETENTION_UNKNOWN, jobId);
      logWarn('Lane B: LEGACY_RETENTION_UNKNOWN (missing v5 retention snapshot)', { jobId, volumeName: vol.Name });
      continue;
    }

    // AVAILABLE + APPLIED/DISCARDED: this job reached a success disposition
    // and passed the "legacy snapshot absent" check above, so it has a
    // non-NULL retention_class/retention_duration_ms. It must still prove
    // the rest of its retention snapshot is internally consistent before it
    // is trusted as a genuine "healthy, just not yet time-eligible" Lane A
    // job — otherwise a malformed/corrupted snapshot would silently vanish
    // from the report instead of being retained and reported.
    if (artifactState === 'AVAILABLE' && SUCCESS_DISPOSITION_STATUSES.has(status)) {
      let inconsistencyReason: string | null = null;
      if (!isValidRetentionClass(dbJob.retentionClass)) {
        inconsistencyReason = `invalid retention_class: "${String(dbJob.retentionClass)}"`;
      } else {
        const rdmsErr = checkRetentionDurationMs(dbJob.retentionDurationMs);
        if (rdmsErr) {
          inconsistencyReason = rdmsErr;
        } else if (dbJob.dispositionAt === null) {
          inconsistencyReason = 'disposition_at is NULL after success disposition';
        } else if (dbJob.retainUntil === null) {
          inconsistencyReason = 'retain_until is NULL after success disposition';
        } else if (!Number.isFinite(Date.parse(dbJob.retainUntil))) {
          inconsistencyReason = `retain_until is malformed/unparsable: "${dbJob.retainUntil}"`;
        }
      }

      if (inconsistencyReason) {
        addToCategory(result.byClassification.INCONSISTENT_STATE, jobId);
        logWarn('Lane B: INCONSISTENT_STATE (malformed/inconsistent retention snapshot)', {
          jobId, volumeName: vol.Name, reason: inconsistencyReason,
        });
        continue;
      }

      // Retention snapshot present and internally consistent: a genuine
      // Lane A success job not yet time-eligible (or just processed this
      // pass). Not reported merely for waiting.
      continue;
    }

    // Healthy COMPLETED + AVAILABLE: the job finished successfully and its
    // artifact is retained pending the caller's apply/discard decision. This is
    // a legitimate normal state, not an anomaly — never reported as an
    // inconsistency, never deleted, and never expired merely for waiting
    // (retain_until is only anchored at disposition, so Lane A cannot consider
    // it at all).
    //
    // Deliberately placed here, not earlier: a COMPLETED job with a missing
    // artifact_volume is still INCONSISTENT_STATE, and a COMPLETED job missing
    // its v5 retention snapshot is still reported LEGACY_RETENTION_UNKNOWN —
    // it can never become expiry-eligible even after disposition, so it is not
    // "healthy" in the sense this exemption means.
    if (status === 'COMPLETED' && artifactState === 'AVAILABLE') {
      continue;
    }

    // LEGITIMATE_FAILURE_EVIDENCE: terminal failure/CANCELLED
    // Note: FAILED_INFRASTRUCTURE after startup recovery does NOT prove
    // crash provenance — use only the current terminal status.
    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      addToCategory(result.byClassification.LEGITIMATE_FAILURE_EVIDENCE, jobId);
      log('Lane B: LEGITIMATE_FAILURE_EVIDENCE', { jobId, status, volumeName: vol.Name });
      continue;
    }

    // Anything else: INCONSISTENT_STATE (impossible or unrecognised combination).
    addToCategory(result.byClassification.INCONSISTENT_STATE, jobId);
    logWarn('Lane B: INCONSISTENT_STATE (unrecognised lifecycle combination)', {
      jobId, status, artifactState, volumeName: vol.Name,
    });
  }

  // ---- Discovery path B: prefix-based scan for malformed-label volumes ----
  let allPrefixVols: VolumeSummary[] = [];
  try {
    // Docker volume list doesn't support prefix filtering natively; list all
    // and filter client-side by name prefix. Bounded by the single API call.
    const managed = await listVolumesByFilter({ label: [`${LABEL_MANAGED}=true`] });
    // Also check volumes that match the evidence prefix but may lack the
    // managed label — use a name filter via Docker's filter API if available,
    // or fall back to listing all (Docker list is always bounded in practice).
    // We list all volumes and filter by prefix to catch truly malformed ones.
    const allVols = await listVolumesByFilter({});
    allPrefixVols = allVols.filter(
      (v) => v.Name.startsWith(EVIDENCE_VOLUME_PREFIX) && !classifiedVolumeNames.has(v.Name),
    );
    // Subtract any that came up in the managed list already classified above.
    void managed; // already iterated above
  } catch (e) {
    // Path B failure is non-fatal: log warn and proceed.
    logWarn('Lane B: path B prefix discovery failed (non-fatal)', {
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    allPrefixVols = [];
  }

  for (const vol of allPrefixVols) {
    result.totalScanned++;
    // Prefix match alone is NEVER deletion authority. Classify as AMBIGUOUS_LABELS.
    addToCategory(result.byClassification.AMBIGUOUS_LABELS, vol.Name);
    logWarn('Lane B: AMBIGUOUS_LABELS (prefix match, malformed/missing labels)', { volumeName: vol.Name });
  }

  // Emit bounded summary report.
  const summary: Record<string, { count: number; suppressed: number }> = {};
  for (const [cls, cat] of Object.entries(result.byClassification)) {
    if (cat.count > 0) {
      summary[cls] = { count: cat.count, suppressed: cat.suppressed };
    }
  }
  log('Lane B: classification complete', {
    totalScanned: result.totalScanned,
    summary,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Convenience wrapper — primary entry point for index.ts
// ---------------------------------------------------------------------------

/**
 * Run the full A6 startup evidence lifecycle in the required order:
 *   1. reconcileExpiredEvidence  — crash-recovery deletes for durable EXPIRED jobs
 *   2. collectExpiredEvidence    — Lane A: new AVAILABLE→EXPIRED + physical delete
 *   3. classifyIncompleteEvidence — Lane B: classify + report, no auto-delete
 *
 * Global failures at any step propagate and FAIL STARTUP CLOSED.
 * Per-resource failures inside each step are retained and reported.
 */
export async function runStartupEvidenceLifecycle(
  store: AgentJobStore,
): Promise<StartupEvidenceLifecycleResult> {
  const reconcile = await reconcileExpiredEvidence(store);
  const collect = await collectExpiredEvidence(store);
  const classify = await classifyIncompleteEvidence(store);

  log('evidence lifecycle: startup pass complete', {
    reconcileDeleted: reconcile.deleteSuccessCount,
    reconcileAlreadyAbsent: reconcile.alreadyAbsentCount,
    reconcileRetained: reconcile.retainedCount,
    laneAExpired: collect.expiredCount,
    laneARetained: collect.retainedCount,
    integrityAnomalies: collect.integrityAnomalyCount,
    laneBScanned: classify.totalScanned,
  });

  return { reconcile, collect, classify };
}
