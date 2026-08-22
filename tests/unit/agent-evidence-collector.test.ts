/**
 * Unit tests for src/executor/agents/evidenceCollector.ts (Phase A6).
 *
 * All Docker I/O is replaced with lightweight stubs injected via vi.mock.
 * All DB I/O uses real in-memory SQLite via AgentJobStore(':memory:').
 * No real sleeps. No real Docker daemon required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentJobStore, AGENT_JOB_SCHEMA_VERSION, type NewAgentJob } from '../../src/executor/agents/jobStore.js';
import { AGENT_RETENTION_DURATION_MS } from '../../src/shared/agents.js';
import {
  evidenceVolumeName,
  reconcileExpiredEvidence,
  collectExpiredEvidence,
  classifyIncompleteEvidence,
  LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB,
} from '../../src/executor/agents/evidenceCollector.js';
import { isAcceptedEvidenceVolumeName } from '../../src/executor/agents/sandboxSpec.js';
import type { VolumeSummary } from '../../src/executor/docker.js';

// ---------------------------------------------------------------------------
// Mock Docker module — all tests control Docker via these stubs
// ---------------------------------------------------------------------------

const mockListVolumesByFilter = vi.fn<Parameters<typeof import('../../src/executor/docker.js').listVolumesByFilter>, ReturnType<typeof import('../../src/executor/docker.js').listVolumesByFilter>>();
const mockRemoveVolume = vi.fn<Parameters<typeof import('../../src/executor/docker.js').removeVolume>, ReturnType<typeof import('../../src/executor/docker.js').removeVolume>>();

vi.mock('../../src/executor/docker.js', () => ({
  listVolumesByFilter: (...args: unknown[]) => mockListVolumesByFilter(...(args as Parameters<typeof mockListVolumesByFilter>)),
  removeVolume: (...args: unknown[]) => mockRemoveVolume(...(args as Parameters<typeof mockRemoveVolume>)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobId(n: number): string {
  return `job_${n.toString(16).padStart(32, '0')}`;
}

function makeAttId(n: number): string {
  return `att_${n.toString(16).padStart(32, '0')}`;
}

function ownedLabels(jobId: string): Record<string, string> {
  return {
    [LABEL_MANAGED]: 'true',
    [LABEL_RESOURCE]: 'evidence',
    [LABEL_JOB]: jobId,
  };
}

function makeVolume(jobId: string, labelOverrides: Record<string, string> = {}): VolumeSummary {
  return {
    Name: evidenceVolumeName(jobId),
    Labels: { ...ownedLabels(jobId), ...labelOverrides },
  };
}

let store: AgentJobStore;
let dbPath: string;

/** Drive a job to COMPLETED with a published AVAILABLE artifact. */
function driveToCompleted(cls: 'ephemeral' | 'short' | 'audit' = 'ephemeral', n = 1): string {
  const rdms = AGENT_RETENTION_DURATION_MS[cls];
  const jid = makeJobId(n);
  const now = new Date().toISOString();
  store.insert({
    jobId: jid, principalId: 'owner', backend: 'kiro', project: 'proj',
    profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
    prompt: 'test', sessionPolicy: 'new', writer: false,
    retentionClass: cls, retentionDurationMs: rdms,
  });
  store.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now });
  store.transition(jid, 'PREPARING', 'RUNNING');
  store.transition(jid, 'RUNNING', 'VALIDATING');
  store.publishArtifact(jid, {
    artifactHash: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
    contentComplete: true, applicable: true, reason: null,
    artifactVolume: evidenceVolumeName(jid),
    artifactBytes: 100, opCount: 1,
  });
  store.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now });
  return jid;
}

/** Drive a job all the way to APPLIED with retain_until set to pastTs. */
function driveToAppliedWithRetainUntil(pastTs: string, n = 1): string {
  const jid = driveToCompleted('ephemeral', n);
  const attId = makeAttId(n);
  store.startApplyAttempt({ attemptId: attId, jobId: jid });
  store.transitionApplyAttempt(attId, 'STARTED', 'VERIFYING');
  store.transitionApplyAttempt(attId, 'VERIFYING', 'APPLYING');
  store.markApplySuccess(attId, jid);
  // Override retain_until to a deterministic past value.
  const rawDb = new DatabaseSync(dbPath);
  rawDb.prepare('UPDATE agent_jobs SET retain_until = ?, disposition_at = ? WHERE job_id = ?')
    .run(pastTs, pastTs, jid);
  rawDb.close();
  return jid;
}

/** Drive a job to DISCARDED with retain_until set to pastTs. */
function driveToDiscardedWithRetainUntil(pastTs: string, n = 2): string {
  const jid = driveToCompleted('ephemeral', n);
  store.discardJob(jid);
  // Override retain_until.
  const rawDb = new DatabaseSync(dbPath);
  rawDb.prepare('UPDATE agent_jobs SET retain_until = ?, disposition_at = ? WHERE job_id = ?')
    .run(pastTs, pastTs, jid);
  rawDb.close();
  return jid;
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-col-')), 'agents.db');
  store = new AgentJobStore(dbPath);
  vi.clearAllMocks();
  mockListVolumesByFilter.mockResolvedValue([]);
  mockRemoveVolume.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// evidenceVolumeName
// ---------------------------------------------------------------------------

describe('evidenceVolumeName', () => {
  it('produces a deterministic name with the expected prefix', () => {
    const jid = makeJobId(1);
    const name = evidenceVolumeName(jid);
    expect(name).toBe(`io-quarangate-evidence-${jid}`);
    expect(name.startsWith('io-quarangate-evidence-')).toBe(true);
  });

  // N1D: the assertion above changed because new WRITES moved prefix. The
  // legacy prefix must remain a valid deterministic name on READ, or every
  // pre-cutover job fails its identity proof and its evidence is stranded.
  it('N1D: still accepts the legacy prefix as a valid name for the same job', () => {
    const jid = makeJobId(1);
    expect(isAcceptedEvidenceVolumeName(`io-mcp-ide-bridge-evidence-${jid}`, jid)).toBe(true);
    expect(isAcceptedEvidenceVolumeName(`io-quarangate-evidence-${jid}`, jid)).toBe(true);
    // Still job-scoped: another job's name is never accepted.
    expect(isAcceptedEvidenceVolumeName(`io-mcp-ide-bridge-evidence-${makeJobId(2)}`, jid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N1D legacy-evidence compatibility, exercised through the REAL collector
// ---------------------------------------------------------------------------

describe('N1D: pre-cutover evidence remains fully serviceable', () => {
  function insertExpiredWithVolume(jid: string, volumeName: string): void {
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(volumeName, jid);
    raw.close();
  }

  it('expires a legacy-named, legacy-labelled evidence volume', async () => {
    const jid = makeJobId(41);
    const legacyName = `io-mcp-ide-bridge-evidence-${jid}`;
    insertExpiredWithVolume(jid, legacyName);

    mockListVolumesByFilter.mockResolvedValue([{
      Name: legacyName,
      Labels: {
        'io.mcp-ide-bridge.managed': 'true',
        'io.mcp-ide-bridge.resource': 'evidence',
        'io.mcp-ide-bridge.job': jid,
      },
    }]);
    const result = await reconcileExpiredEvidence(store);

    expect(result.deleteSuccessCount).toBe(1);
    expect(result.retainedCount).toBe(0);
    // The DB-recorded legacy name is deleted — never a re-derived new-prefix one.
    expect(mockRemoveVolume).toHaveBeenCalledWith(legacyName, true);
  });

  it('expires a new-prefix volume too (both families coexist)', async () => {
    const jid = makeJobId(42);
    insertExpiredWithVolume(jid, evidenceVolumeName(jid));

    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await reconcileExpiredEvidence(store);

    expect(result.deleteSuccessCount).toBe(1);
    expect(mockRemoveVolume).toHaveBeenCalledWith(evidenceVolumeName(jid), true);
  });

  it('still refuses a legacy volume whose job label points elsewhere', async () => {
    const jid = makeJobId(43);
    const legacyName = `io-mcp-ide-bridge-evidence-${jid}`;
    insertExpiredWithVolume(jid, legacyName);

    mockListVolumesByFilter.mockResolvedValue([{
      Name: legacyName,
      Labels: {
        'io.mcp-ide-bridge.managed': 'true',
        'io.mcp-ide-bridge.resource': 'evidence',
        'io.mcp-ide-bridge.job': makeJobId(999),
      },
    }]);
    const result = await reconcileExpiredEvidence(store);

    expect(result.retainedCount).toBe(1);
    expect(result.deleteSuccessCount).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('is FAIL-SAFE when a volume carries contradictory namespaces', async () => {
    const jid = makeJobId(44);
    const legacyName = `io-mcp-ide-bridge-evidence-${jid}`;
    insertExpiredWithVolume(jid, legacyName);

    // Both namespaces present but disagreeing on job identity → unproven.
    mockListVolumesByFilter.mockResolvedValue([{
      Name: legacyName,
      Labels: {
        'io.mcp-ide-bridge.managed': 'true',
        'io.mcp-ide-bridge.resource': 'evidence',
        'io.mcp-ide-bridge.job': jid,
        'io.quarangate.managed': 'true',
        'io.quarangate.resource': 'evidence',
        'io.quarangate.job': makeJobId(998),
      },
    }]);
    const result = await reconcileExpiredEvidence(store);

    expect(result.retainedCount).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reconcileExpiredEvidence — delete completion (Proof B)
// ---------------------------------------------------------------------------

describe('reconcileExpiredEvidence', () => {
  it('no EXPIRED jobs → returns zero counts without calling Docker', async () => {
    const result = await reconcileExpiredEvidence(store);
    expect(result.deleteSuccessCount).toBe(0);
    expect(result.alreadyAbsentCount).toBe(0);
    expect(result.retainedCount).toBe(0);
    expect(mockListVolumesByFilter).not.toHaveBeenCalled();
  });

  it('EXPIRED + correct volume present → deletes and increments deleteSuccessCount', async () => {
    const jid = makeJobId(1);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    // Manually force artifact_state=EXPIRED and artifact_volume set.
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(evidenceVolumeName(jid), jid);
    raw.close();

    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await reconcileExpiredEvidence(store);
    expect(result.deleteSuccessCount).toBe(1);
    expect(result.alreadyAbsentCount).toBe(0);
    expect(mockRemoveVolume).toHaveBeenCalledWith(evidenceVolumeName(jid), true);
  });

  it('EXPIRED + volume already absent → idempotent success (alreadyAbsentCount++)', async () => {
    const jid = makeJobId(2);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(evidenceVolumeName(jid), jid);
    raw.close();

    // Docker returns empty list → volume not found.
    mockListVolumesByFilter.mockResolvedValue([]);
    const result = await reconcileExpiredEvidence(store);
    expect(result.alreadyAbsentCount).toBe(1);
    expect(result.deleteSuccessCount).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('EXPIRED + wrong managed label → refuses delete, retainedCount++', async () => {
    const jid = makeJobId(3);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(evidenceVolumeName(jid), jid);
    raw.close();

    mockListVolumesByFilter.mockResolvedValue([{
      Name: evidenceVolumeName(jid),
      Labels: { [LABEL_MANAGED]: 'false', [LABEL_RESOURCE]: 'evidence', [LABEL_JOB]: jid },
    }]);
    const result = await reconcileExpiredEvidence(store);
    expect(result.retainedCount).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('EXPIRED + wrong resource label → refuses delete', async () => {
    const jid = makeJobId(4);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(evidenceVolumeName(jid), jid);
    raw.close();

    mockListVolumesByFilter.mockResolvedValue([{
      Name: evidenceVolumeName(jid),
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'workspace', [LABEL_JOB]: jid },
    }]);
    const result = await reconcileExpiredEvidence(store);
    expect(result.retainedCount).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('EXPIRED + wrong job label → refuses delete (cross-job identity failure)', async () => {
    const jid = makeJobId(5);
    const otherId = makeJobId(999);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(evidenceVolumeName(jid), jid);
    raw.close();

    // Volume name matches but job label points at a different job.
    mockListVolumesByFilter.mockResolvedValue([{
      Name: evidenceVolumeName(jid),
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'evidence', [LABEL_JOB]: otherId },
    }]);
    const result = await reconcileExpiredEvidence(store);
    expect(result.retainedCount).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('EXPIRED + artifact_volume != deterministic expected name → refuses delete', async () => {
    const jid = makeJobId(6);
    const wrongVolume = 'some-other-volume-not-ours';
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(wrongVolume, jid);
    raw.close();

    const result = await reconcileExpiredEvidence(store);
    expect(result.retainedCount).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// collectExpiredEvidence — Lane A
// ---------------------------------------------------------------------------

describe('collectExpiredEvidence — Lane A eligibility', () => {
  const PAST = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const FUTURE = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const NOW_ISO = new Date().toISOString();

  it('APPLIED before retain_until → retain (not expired)', async () => {
    const jid = driveToAppliedWithRetainUntil(FUTURE, 1);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(0);
    expect(result.retainedCount).toBeGreaterThanOrEqual(0);
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('APPLIED == retain_until (exact boundary) → eligible', async () => {
    // Exact equality: julianday(retain_until) <= julianday(now) → eligible.
    const jid = driveToAppliedWithRetainUntil(NOW_ISO, 1);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(1);
    expect(store.get(jid)!.artifactState).toBe('EXPIRED');
  });

  it('APPLIED after retain_until → eligible', async () => {
    const jid = driveToAppliedWithRetainUntil(PAST, 1);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(1);
    expect(store.get(jid)!.artifactState).toBe('EXPIRED');
  });

  it('DISCARDED before retain_until → retain', async () => {
    const jid = driveToDiscardedWithRetainUntil(FUTURE, 2);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(0);
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('DISCARDED == retain_until → eligible', async () => {
    const jid = driveToDiscardedWithRetainUntil(NOW_ISO, 2);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(1);
    expect(store.get(jid)!.artifactState).toBe('EXPIRED');
  });

  it('DISCARDED after retain_until → eligible', async () => {
    const jid = driveToDiscardedWithRetainUntil(PAST, 2);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(1);
    expect(store.get(jid)!.artifactState).toBe('EXPIRED');
  });

  it('COMPLETED regardless of age → retain (awaiting disposition)', async () => {
    const jid = driveToCompleted('ephemeral', 1);
    // Force retain_until in the past to ensure the COMPLETED guard holds.
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare('UPDATE agent_jobs SET retain_until = ?, disposition_at = ? WHERE job_id = ?')
      .run(PAST, PAST, jid);
    rawDb.close();
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(0);
    expect(store.get(jid)!.status).toBe('COMPLETED');
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('legacy job with NULL retention fields → retain/report (LEGACY_RETENTION_UNKNOWN path)', async () => {
    // A job that has APPLIED+AVAILABLE but no v5 retention fields (legacy).
    const jid = makeJobId(10);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    // Wipe retention fields to simulate a legacy pre-v5 row.
    raw.prepare(`UPDATE agent_jobs SET
      artifact_state='AVAILABLE', artifact_volume=?,
      status='APPLIED', applied_at=?, disposition_at=?,
      retention_class=NULL, retention_duration_ms=NULL, retain_until=NULL
      WHERE job_id=?`).run(evidenceVolumeName(jid), PAST, PAST, jid);
    raw.close();
    // Even if retain_until were in the past, the SQL predicate requires it non-NULL.
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(0);
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('malformed retain_until → retain/report', async () => {
    const jid = driveToAppliedWithRetainUntil(PAST, 1);
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE agent_jobs SET retain_until = ? WHERE job_id = ?')
      .run('NOT-A-DATE', jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    // julianday('NOT-A-DATE') returns NULL in SQLite → predicate fails → not eligible.
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(0);
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');

    // "report" must actually be asserted, not merely inferred from no delete:
    // Lane B must surface this row as INCONSISTENT_STATE (malformed retain_until
    // after a successful disposition), never silently drop it.
    const classify = await classifyIncompleteEvidence(store);
    expect(classify.byClassification.INCONSISTENT_STATE.count).toBe(1);
    expect(classify.byClassification.INCONSISTENT_STATE.samples).toContain(jid);
    expect(classify.byClassification.LEGACY_RETENTION_UNKNOWN.count).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('malformed retention_duration_ms (non-positive) → retain/report', async () => {
    // Job passes SQL query (retain_until elapsed, non-NULL rdms) but fails
    // the per-resource validation in the collector.
    const jid = driveToAppliedWithRetainUntil(PAST, 1);
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE agent_jobs SET retention_duration_ms = -1 WHERE job_id = ?').run(jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await collectExpiredEvidence(store);
    // Either retained by SQL predicate (rdms=-1, rdms>0 fails) or by per-resource check.
    expect(result.expiredCount).toBe(0);
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// collectExpiredEvidence — quarantine and UNCERTAIN holds
// ---------------------------------------------------------------------------

describe('collectExpiredEvidence — quarantine and UNCERTAIN holds', () => {
  const PAST = new Date(Date.now() - 2 * 86_400_000).toISOString();

  it('job with UNCERTAIN apply attempt → retain', async () => {
    const jid = driveToCompleted('ephemeral', 1);
    const attId = makeAttId(1);
    store.startApplyAttempt({ attemptId: attId, jobId: jid });
    store.transitionApplyAttempt(attId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attId, 'VERIFYING', 'APPLYING');
    store.markApplyUncertain(attId, jid, 'proj', 'test uncertain');
    // Force to APPLIED with past retain_until via raw SQL so the test exercises the hold.
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET status='APPLIED', artifact_state='AVAILABLE',
      applied_at=?, disposition_at=?, retain_until=? WHERE job_id=?`)
      .run(PAST, PAST, PAST, jid);
    raw.close();
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(0);
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  // -------------------------------------------------------------------------
  // Requirement 6.5 — an ACTIVE apply attempt blocks deletion eligibility.
  //
  // Under the frozen job state machine an active attempt can only coexist with
  // an APPLIED/DISCARDED job through corrupt/manually-edited state, which is
  // exactly what this defensive predicate exists for. Each active state is
  // proven separately; the terminal states are proven NOT to block.
  // -------------------------------------------------------------------------
  const ACTIVE_ATTEMPT_STATES = ['STARTED', 'VERIFYING', 'APPLYING'] as const;

  /**
   * Build an otherwise fully Lane-A-eligible APPLIED job that also carries one
   * apply attempt pinned to `state`. All transitions go through the store's own
   * primitives; only the final job status/timestamps are forced, because the
   * state machine deliberately forbids reaching this combination legitimately.
   */
  function eligibleJobWithAttemptInState(state: string, n = 1): string {
    const jid = driveToCompleted('ephemeral', n);
    const attId = makeAttId(n);
    store.startApplyAttempt({ attemptId: attId, jobId: jid });
    if (state === 'VERIFYING' || state === 'APPLYING') {
      store.transitionApplyAttempt(attId, 'STARTED', 'VERIFYING');
    }
    if (state === 'APPLYING') {
      store.transitionApplyAttempt(attId, 'VERIFYING', 'APPLYING');
    }
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET status='APPLIED', artifact_state='AVAILABLE',
      applied_at=?, disposition_at=?, retain_until=? WHERE job_id=?`)
      .run(PAST, PAST, PAST, jid);
    raw.close();
    return jid;
  }

  it.each(ACTIVE_ATTEMPT_STATES)(
    'active apply attempt in %s → evidence is NOT deletion-eligible (retained)',
    async (state) => {
      const jid = eligibleJobWithAttemptInState(state, 1);
      mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

      // The DB-side candidate query may surface it, but the atomic admission
      // predicate must refuse, and no volume may be deleted.
      expect(store.markExpired(jid, new Date().toISOString())).toBe(false);
      const result = await collectExpiredEvidence(store);
      expect(result.expiredCount).toBe(0);
      expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
      expect(mockRemoveVolume).not.toHaveBeenCalled();
    },
  );

  it('attempt that reached a zero-mutation terminal state does NOT block eligibility', async () => {
    // Control case: proves the block is specific to ACTIVE states and the
    // collector has not simply been made unconditionally inert.
    const jid = eligibleJobWithAttemptInState('STARTED', 1);
    const attId = makeAttId(1);
    store.transitionApplyAttempt(attId, 'STARTED', 'ABORTED_NO_MUTATION', {
      finishedAt: new Date().toISOString(), reason: 'test',
    });
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(1);
    expect(store.get(jid)!.artifactState).toBe('EXPIRED');
  });

  it('quarantine_causing_job_id → retain', async () => {
    const jid = driveToAppliedWithRetainUntil(PAST, 1);
    // Insert a quarantine row pointing at this job.
    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare(`INSERT INTO agent_project_apply_state
      (project_id, state, quarantined_at, quarantine_causing_job_id, quarantine_causing_attempt_id, quarantine_reason)
      VALUES ('proj', 'QUARANTINED', ?, ?, 'att_x', 'test')`)
      .run(PAST, jid);
    rawDb.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(0);
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('unrelated job in quarantined project → normal Lane A eligibility', async () => {
    // Job 1: quarantine cause — should be retained.
    const causeId = driveToAppliedWithRetainUntil(PAST, 1);
    // Job 2: unrelated job in same project, not the quarantine cause.
    const otherId = driveToAppliedWithRetainUntil(PAST, 2);

    const rawDb = new DatabaseSync(dbPath);
    rawDb.prepare(`INSERT INTO agent_project_apply_state
      (project_id, state, quarantined_at, quarantine_causing_job_id, quarantine_causing_attempt_id, quarantine_reason)
      VALUES ('proj', 'QUARANTINED', ?, ?, 'att_x', 'test')`)
      .run(PAST, causeId);
    rawDb.close();

    // Both volumes present and correctly labelled.
    mockListVolumesByFilter.mockImplementation(async (filters) => {
      const filterStr = JSON.stringify(filters);
      if (filterStr.includes('name')) {
        // Single-volume lookup — return by name.
        const name = Object.values(filters)[0]?.[0] as string | undefined;
        if (!name) return [];
        if (name === evidenceVolumeName(causeId)) return [makeVolume(causeId)];
        if (name === evidenceVolumeName(otherId)) return [makeVolume(otherId)];
        return [];
      }
      return [makeVolume(causeId), makeVolume(otherId)];
    });

    const result = await collectExpiredEvidence(store);
    // causeId is blocked; otherId is eligible.
    expect(result.expiredCount).toBe(1);
    expect(store.get(causeId)!.artifactState).toBe('AVAILABLE');
    expect(store.get(otherId)!.artifactState).toBe('EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// collectExpiredEvidence — delete completion after Lane A authorization
// ---------------------------------------------------------------------------

describe('collectExpiredEvidence — delete completion', () => {
  const PAST = new Date(Date.now() - 2 * 86_400_000).toISOString();

  it('EXPIRED after Lane A + correct volume → delete called', async () => {
    const jid = driveToAppliedWithRetainUntil(PAST, 1);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    await collectExpiredEvidence(store);
    expect(mockRemoveVolume).toHaveBeenCalledWith(evidenceVolumeName(jid), true);
  });

  it('volume absent after Lane A authorization → idempotent (already-absent)', async () => {
    const jid = driveToAppliedWithRetainUntil(PAST, 1);
    // listVolumesByFilter returns the volume for the label check but then
    // removeVolume would normally be called. Here we simulate Docker not-found
    // on the delete step by having remove throw a 404-like error.
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const { BridgeError } = await import('../../src/shared/errors.js');
    mockRemoveVolume.mockRejectedValueOnce(new BridgeError('DOCKER_UNAVAILABLE', 'not found', 404));
    // Should not throw — not-found on delete is idempotent success.
    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(1);
    expect(store.get(jid)!.artifactState).toBe('EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// collectExpiredEvidence — integrity anomalies
// ---------------------------------------------------------------------------

describe('collectExpiredEvidence — integrity anomalies', () => {
  it('AVAILABLE + recorded volume absent → integrity anomaly, artifact_state remains AVAILABLE', async () => {
    const jid = driveToCompleted('ephemeral', 1);
    // Force to APPLIED+AVAILABLE with a past retain_until.
    const PAST = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET status='APPLIED', applied_at=?, disposition_at=?,
      retain_until=? WHERE job_id=?`).run(PAST, PAST, PAST, jid);
    raw.close();

    // Docker: volume not found (simulates manual deletion without lifecycle path).
    mockListVolumesByFilter.mockResolvedValue([]);

    const result = await collectExpiredEvidence(store);
    expect(result.integrityAnomalyCount).toBeGreaterThanOrEqual(1);
    // artifact_state MUST remain AVAILABLE — no fabricated expiry.
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
    expect(store.get(jid)!.status).toBe('APPLIED');
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// classifyIncompleteEvidence — Lane B
// ---------------------------------------------------------------------------

describe('classifyIncompleteEvidence — Lane B', () => {
  it('no volumes → zero classifications', async () => {
    mockListVolumesByFilter.mockResolvedValue([]);
    const result = await classifyIncompleteEvidence(store);
    expect(result.totalScanned).toBe(0);
    for (const cat of Object.values(result.byClassification)) {
      expect(cat.count).toBe(0);
    }
  });

  it('FAILED_AGENT + evidence volume → LEGITIMATE_FAILURE_EVIDENCE, no delete', async () => {
    const jid = makeJobId(1);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    store.transition(jid, 'QUEUED', 'PREPARING', { startedAt: new Date().toISOString() });
    store.transition(jid, 'PREPARING', 'RUNNING');
    store.transition(jid, 'RUNNING', 'FAILED_AGENT', { failureCode: 'FAILED_AGENT', failureReason: 'crash' });

    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.LEGITIMATE_FAILURE_EVIDENCE.count).toBe(1);
    expect(result.byClassification.LEGITIMATE_FAILURE_EVIDENCE.samples).toContain(jid);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('FAILED_TIMEOUT evidence → LEGITIMATE_FAILURE_EVIDENCE, does NOT claim crash provenance', async () => {
    const jid = makeJobId(2);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    store.transition(jid, 'QUEUED', 'PREPARING', { startedAt: new Date().toISOString() });
    store.transition(jid, 'PREPARING', 'RUNNING');
    store.transition(jid, 'RUNNING', 'FAILED_TIMEOUT', { failureCode: 'FAILED_TIMEOUT' });

    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.LEGITIMATE_FAILURE_EVIDENCE.count).toBe(1);
    // Classification uses the stored terminal status — does not claim crash provenance.
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('FAILED_INFRASTRUCTURE evidence → LEGITIMATE_FAILURE_EVIDENCE, NOT CRASHED_OR_INTERRUPTED', async () => {
    const jid = makeJobId(3);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    store.transition(jid, 'QUEUED', 'PREPARING', { startedAt: new Date().toISOString() });
    store.transition(jid, 'PREPARING', 'FAILED_INFRASTRUCTURE', { failureCode: 'FAILED_INFRASTRUCTURE' });

    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.LEGITIMATE_FAILURE_EVIDENCE.count).toBe(1);
    // No CRASHED_OR_INTERRUPTED classification exists — frozen architecture.
    expect('CRASHED_OR_INTERRUPTED' in result.byClassification).toBe(false);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('valid job label but no DB row → ORPHANED_DB_MISSING, no delete', async () => {
    const missingId = makeJobId(100);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(missingId)]);
    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.ORPHANED_DB_MISSING.count).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('volume with prefix but missing managed label → AMBIGUOUS_LABELS via path B, no delete', async () => {
    const jid = makeJobId(4);
    const ambigName = `io-mcp-ide-bridge-evidence-${jid}`;
    // Path A: no exact-ownership volumes.
    // Path B: this volume has the prefix but wrong labels.
    mockListVolumesByFilter.mockImplementation(async (filters) => {
      const labelFilter = (filters.label ?? []) as string[];
      if (labelFilter.some((l) => l.includes('resource=evidence'))) {
        return []; // path A returns nothing
      }
      if (Object.keys(filters).length === 0) {
        // All volumes — return the prefix-matching one.
        return [{ Name: ambigName, Labels: { [LABEL_MANAGED]: 'true' /* missing resource */ } }];
      }
      return [];
    });
    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.AMBIGUOUS_LABELS.count).toBeGreaterThanOrEqual(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('AVAILABLE + null artifact_volume → INCONSISTENT_STATE', async () => {
    const jid = makeJobId(5);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    // Manually set artifact_state=AVAILABLE but leave artifact_volume NULL.
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='AVAILABLE', artifact_volume=NULL WHERE job_id=?`).run(jid);
    raw.close();
    // Volume present via exact labels.
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('APPLIED + artifact_state=NONE → INCONSISTENT_STATE, no delete', async () => {
    const jid = makeJobId(6);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET status='APPLIED', artifact_state='NONE', artifact_volume=?
      WHERE job_id=?`).run(evidenceVolumeName(jid), jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('legacy job with NULL retention_class → LEGACY_RETENTION_UNKNOWN, no delete', async () => {
    const jid = makeJobId(7);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    // Wipe retention fields to simulate legacy row.
    raw.prepare(`UPDATE agent_jobs SET retention_class=NULL, retention_duration_ms=NULL,
      artifact_state=NULL, artifact_volume=? WHERE job_id=?`)
      .run(evidenceVolumeName(jid), jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.count).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Healthy COMPLETED + AVAILABLE is a legitimate normal state: the job
  // finished and its artifact waits for the caller's apply/discard decision.
  // It must never be reported as an inconsistency, never deleted, and never
  // expired merely for waiting.
  // -------------------------------------------------------------------------

  it('healthy COMPLETED + AVAILABLE → NOT INCONSISTENT_STATE and NOT deleted', async () => {
    const jid = driveToCompleted('ephemeral', 1);
    expect(store.get(jid)!.status).toBe('COMPLETED');
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');

    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);
    const result = await classifyIncompleteEvidence(store);

    // Scanned, but classified into NO anomaly category at all.
    expect(result.totalScanned).toBe(1);
    for (const [cls, cat] of Object.entries(result.byClassification)) {
      expect(cat.count, `${cls} must be empty for a healthy COMPLETED job`).toBe(0);
      expect(cat.samples, `${cls} must not name a healthy COMPLETED job`).not.toContain(jid);
    }
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('healthy COMPLETED + AVAILABLE survives a full startup lifecycle pass unchanged', async () => {
    const jid = driveToCompleted('ephemeral', 1);
    // Even with a long-elapsed retain_until forced in, a COMPLETED job has no
    // disposition and must not be expired merely for waiting.
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE agent_jobs SET retain_until = ? WHERE job_id = ?')
      .run(new Date(Date.now() - 365 * 86_400_000).toISOString(), jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    await reconcileExpiredEvidence(store);
    const collect = await collectExpiredEvidence(store);
    const classify = await classifyIncompleteEvidence(store);

    expect(collect.expiredCount).toBe(0);
    expect(classify.byClassification.INCONSISTENT_STATE.count).toBe(0);
    const after = store.get(jid)!;
    expect(after.status).toBe('COMPLETED');
    expect(after.artifactState).toBe('AVAILABLE');
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('COMPLETED + AVAILABLE but NULL artifact_volume is still INCONSISTENT_STATE', async () => {
    // The healthy-state exemption must not weaken detection of genuinely
    // inconsistent resources.
    const jid = driveToCompleted('ephemeral', 1);
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE agent_jobs SET artifact_volume=NULL WHERE job_id=?').run(jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(1);
    expect(result.byClassification.INCONSISTENT_STATE.samples).toContain(jid);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('legacy COMPLETED + AVAILABLE (no v5 retention) is still LEGACY_RETENTION_UNKNOWN', async () => {
    // The healthy-state exemption must not hide legacy rows: a COMPLETED job
    // with no durable retention snapshot can never become expiry-eligible even
    // after disposition, so it must stay visible in the report.
    const jid = driveToCompleted('ephemeral', 1);
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE agent_jobs SET retention_class=NULL, retention_duration_ms=NULL WHERE job_id=?').run(jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.count).toBe(1);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.samples).toContain(jid);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('COMPLETED with artifact_state NONE is still classified (not silently exempted)', async () => {
    const jid = makeJobId(8);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET status='COMPLETED', artifact_state='NONE', artifact_volume=?
      WHERE job_id=?`).run(evidenceVolumeName(jid), jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(1);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('all Lane B outcomes: no delete called for any classification', async () => {
    // Create one volume of each failing category.
    const jobs = [1, 2, 3, 4, 5].map((n) => makeJobId(n));
    const vols: VolumeSummary[] = jobs.map((jid) => makeVolume(jid));
    mockListVolumesByFilter.mockResolvedValue(vols);
    await classifyIncompleteEvidence(store);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// classifyIncompleteEvidence — R2 remediation: legacy / malformed retention
// must RETAIN + REPORT, never be silently skipped by the
// AVAILABLE+APPLIED/DISCARDED early-continue.
// ---------------------------------------------------------------------------

describe('classifyIncompleteEvidence — R2: legacy/malformed AVAILABLE success-disposition rows', () => {
  const PAST = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const FUTURE = new Date(Date.now() + 2 * 86_400_000).toISOString();

  function legacyDisposedJob(jid: string, status: 'APPLIED' | 'DISCARDED'): void {
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: 86_400_000,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET
      artifact_state='AVAILABLE', artifact_volume=?,
      status=?, applied_at=?, disposition_at=?,
      retention_class=NULL, retention_duration_ms=NULL, retain_until=NULL
      WHERE job_id=?`).run(evidenceVolumeName(jid), status, PAST, PAST, jid);
    raw.close();
  }

  it('A: APPLIED + AVAILABLE + legacy NULL retention snapshot → LEGACY_RETENTION_UNKNOWN, no delete', async () => {
    const jid = makeJobId(50);
    legacyDisposedJob(jid, 'APPLIED');
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.count).toBe(1);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.samples).toContain(jid);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('B: DISCARDED + AVAILABLE + legacy NULL retention snapshot → LEGACY_RETENTION_UNKNOWN, no delete', async () => {
    const jid = makeJobId(51);
    legacyDisposedJob(jid, 'DISCARDED');
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.count).toBe(1);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.samples).toContain(jid);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('C: APPLIED + AVAILABLE + malformed retain_until → INCONSISTENT_STATE, remains AVAILABLE, no delete', async () => {
    const jid = driveToAppliedWithRetainUntil(PAST, 20);
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE agent_jobs SET retain_until = ? WHERE job_id = ?').run('NOT-A-DATE', jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(1);
    expect(result.byClassification.INCONSISTENT_STATE.samples).toContain(jid);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.count).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('D: DISCARDED + AVAILABLE + malformed retain_until → INCONSISTENT_STATE, remains AVAILABLE, no delete', async () => {
    const jid = driveToDiscardedWithRetainUntil(PAST, 21);
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE agent_jobs SET retain_until = ? WHERE job_id = ?').run('NOT-A-DATE', jid);
    raw.close();
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    expect(result.byClassification.INCONSISTENT_STATE.count).toBe(1);
    expect(result.byClassification.INCONSISTENT_STATE.samples).toContain(jid);
    expect(result.byClassification.LEGACY_RETENTION_UNKNOWN.count).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('E: valid APPLIED + AVAILABLE with future retain_until → not reported, retained normally', async () => {
    const jid = driveToAppliedWithRetainUntil(FUTURE, 22);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    for (const [cls, cat] of Object.entries(result.byClassification)) {
      expect(cat.count, `${cls} must be empty for a valid, not-yet-eligible APPLIED job`).toBe(0);
      expect(cat.samples).not.toContain(jid);
    }
    expect(mockRemoveVolume).not.toHaveBeenCalled();
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('E: valid DISCARDED + AVAILABLE with future retain_until → not reported, retained normally', async () => {
    const jid = driveToDiscardedWithRetainUntil(FUTURE, 23);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    for (const [cls, cat] of Object.entries(result.byClassification)) {
      expect(cat.count, `${cls} must be empty for a valid, not-yet-eligible DISCARDED job`).toBe(0);
      expect(cat.samples).not.toContain(jid);
    }
    expect(mockRemoveVolume).not.toHaveBeenCalled();
    expect(store.get(jid)!.artifactState).toBe('AVAILABLE');
  });

  it('F: healthy COMPLETED + AVAILABLE regression — still not reported by any classification', async () => {
    const jid = driveToCompleted('ephemeral', 24);
    mockListVolumesByFilter.mockResolvedValue([makeVolume(jid)]);

    const result = await classifyIncompleteEvidence(store);
    for (const [cls, cat] of Object.entries(result.byClassification)) {
      expect(cat.count, `${cls} must be empty for a healthy COMPLETED job`).toBe(0);
      expect(cat.samples).not.toContain(jid);
    }
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lane B — bounded reporting
// ---------------------------------------------------------------------------

describe('classifyIncompleteEvidence — bounded reporting (max 10 per classification)', () => {
  it('emits at most 10 sample IDs per classification, records suppressed count', async () => {
    // Create 15 volumes all with no DB row → ORPHANED_DB_MISSING.
    const vols: VolumeSummary[] = Array.from({ length: 15 }, (_, i) => makeVolume(makeJobId(100 + i)));
    mockListVolumesByFilter.mockResolvedValue(vols);
    const result = await classifyIncompleteEvidence(store);
    const cat = result.byClassification.ORPHANED_DB_MISSING;
    expect(cat.count).toBe(15);
    expect(cat.samples.length).toBeLessThanOrEqual(10);
    expect(cat.suppressed).toBe(15 - cat.samples.length);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('exactly 10 samples → suppressed count is 0', async () => {
    const vols: VolumeSummary[] = Array.from({ length: 10 }, (_, i) => makeVolume(makeJobId(200 + i)));
    mockListVolumesByFilter.mockResolvedValue(vols);
    const result = await classifyIncompleteEvidence(store);
    const cat = result.byClassification.ORPHANED_DB_MISSING;
    expect(cat.count).toBe(10);
    expect(cat.samples.length).toBe(10);
    expect(cat.suppressed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runStartupEvidenceLifecycle — internal stage ordering (A6 Decision R5,
// startup steps 5 → 6 → 7). Proven from observable Docker traffic, not from
// reading the source: each stage issues a distinguishable volume query.
// ---------------------------------------------------------------------------

describe('runStartupEvidenceLifecycle — stage ordering', () => {
  /** Label a Docker call by which lifecycle stage could have produced it. */
  function stageOf(filters: Record<string, string[] | undefined>): string {
    const name = filters.name?.[0];
    if (name) return `by-name:${name}`;
    const labels = filters.label ?? [];
    if (labels.some((l) => l.includes('resource=evidence'))) return 'laneB:exact-labels';
    if (labels.length > 0) return 'laneB:managed';
    return 'laneB:all-volumes';
  }

  it('runs reconcile → Lane A → Lane B in exactly that order', async () => {
    // One already-EXPIRED job (reconcile's population) and one Lane A
    // candidate (APPLIED, retain_until elapsed).
    const expiredId = makeJobId(1);
    store.insert({
      jobId: expiredId, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral,
    });
    const rawSeed = new DatabaseSync(dbPath);
    rawSeed.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=? WHERE job_id=?`)
      .run(evidenceVolumeName(expiredId), expiredId);
    rawSeed.close();

    const PAST = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const laneAId = driveToAppliedWithRetainUntil(PAST, 2);

    const calls: string[] = [];
    mockListVolumesByFilter.mockImplementation(async (filters) => {
      const stage = stageOf(filters as Record<string, string[] | undefined>);
      calls.push(stage);
      const name = (filters as { name?: string[] }).name?.[0];
      if (name === evidenceVolumeName(expiredId)) return [makeVolume(expiredId)];
      if (name === evidenceVolumeName(laneAId)) return [makeVolume(laneAId)];
      if (name) return [];
      return [];
    });

    const { runStartupEvidenceLifecycle } = await import('../../src/executor/agents/evidenceCollector.js');
    const result = await runStartupEvidenceLifecycle(store);

    // Every stage ran, and each one's first Docker call is strictly ordered.
    const firstReconcile = calls.indexOf(`by-name:${evidenceVolumeName(expiredId)}`);
    const firstLaneA = calls.indexOf(`by-name:${evidenceVolumeName(laneAId)}`);
    const firstLaneB = calls.indexOf('laneB:exact-labels');
    expect(firstReconcile, 'reconcile stage must have run').toBeGreaterThanOrEqual(0);
    expect(firstLaneA, 'Lane A stage must have run').toBeGreaterThanOrEqual(0);
    expect(firstLaneB, 'Lane B stage must have run').toBeGreaterThanOrEqual(0);
    expect(firstReconcile).toBeLessThan(firstLaneA);
    expect(firstLaneA).toBeLessThan(firstLaneB);

    // Lane B's own discovery order: exact labels, then the prefix scan.
    expect(calls.indexOf('laneB:exact-labels')).toBeLessThan(calls.indexOf('laneB:all-volumes'));

    expect(result.reconcile.deleteSuccessCount).toBe(1);
    expect(result.collect.expiredCount).toBe(1);
  });

  it('a global Lane B failure propagates out of the lifecycle pass (fail closed)', async () => {
    mockListVolumesByFilter.mockImplementation(async (filters) => {
      const labels = (filters as { label?: string[] }).label ?? [];
      if (labels.some((l) => l.includes('resource=evidence'))) {
        throw new Error('docker daemon unreachable');
      }
      return [];
    });
    const { runStartupEvidenceLifecycle } = await import('../../src/executor/agents/evidenceCollector.js');
    await expect(runStartupEvidenceLifecycle(store)).rejects.toThrow(/failed to list bridge-owned evidence volumes/);
  });

  it('a per-resource failure is retained and reported, and the pass still completes', async () => {
    // An EXPIRED job whose volume carries a foreign job label: identity proof
    // fails for that one resource only.
    const jid = makeJobId(1);
    store.insert({
      jobId: jid, principalId: 'o', backend: 'kiro', project: 'p',
      profile: 'audit', resourcePolicy: 'economy', promptHash: 'a'.repeat(64),
      prompt: 't', sessionPolicy: 'new', writer: false,
      retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral,
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=? WHERE job_id=?`)
      .run(evidenceVolumeName(jid), jid);
    raw.close();

    mockListVolumesByFilter.mockImplementation(async (filters) => {
      const name = (filters as { name?: string[] }).name?.[0];
      if (name === evidenceVolumeName(jid)) {
        return [makeVolume(jid, { [LABEL_JOB]: makeJobId(999) })];
      }
      return [];
    });

    const { runStartupEvidenceLifecycle } = await import('../../src/executor/agents/evidenceCollector.js');
    const result = await runStartupEvidenceLifecycle(store);
    expect(result.reconcile.retainedCount).toBe(1);
    expect(result.reconcile.deleteSuccessCount).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
    // The pass completed: Lane B still ran and produced a report.
    expect(result.classify).toBeTruthy();
  });
});
