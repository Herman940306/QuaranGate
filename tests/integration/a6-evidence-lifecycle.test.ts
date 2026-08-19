/**
 * Integration tests for A6 retained-resource lifecycle.
 *
 * These tests exercise the real AgentJobStore (SQLite on disk), real
 * evidenceCollector functions, and Docker-stub fakes injected at module
 * boundary. They do NOT require a live Docker daemon or network.
 *
 * The highest-value real integration behavior covered:
 *   - v5 full lifecycle: new job → APPLIED/DISCARDED → retain_until elapsed
 *     → startup collection → EXPIRED → volume removed → metadata preserved
 *   - Crash consistency: EXPIRED in DB, volume exists → reconcile removes it
 *   - Crash consistency: EXPIRED in DB, volume already absent → idempotent
 *   - Integrity anomaly: AVAILABLE in DB, volume manually missing → reports
 *     anomaly, does NOT set EXPIRED
 *   - Startup ordering: reconcile → Lane A → Lane B all fire before readiness
 *   - Per-resource failure does not block unrelated processing
 *   - Global lifecycle failure (simulated Docker unavailability) prevents startup
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { AGENT_RETENTION_DURATION_MS } from '../../src/shared/agents.js';
import {
  evidenceVolumeName,
  reconcileExpiredEvidence,
  collectExpiredEvidence,
  classifyIncompleteEvidence,
  runStartupEvidenceLifecycle,
  LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB,
} from '../../src/executor/agents/evidenceCollector.js';
import type { VolumeSummary } from '../../src/executor/docker.js';

// ---------------------------------------------------------------------------
// Docker stub
// ---------------------------------------------------------------------------

const mockListVolumesByFilter = vi.fn<
  Parameters<typeof import('../../src/executor/docker.js').listVolumesByFilter>,
  ReturnType<typeof import('../../src/executor/docker.js').listVolumesByFilter>
>();
const mockRemoveVolume = vi.fn<
  Parameters<typeof import('../../src/executor/docker.js').removeVolume>,
  ReturnType<typeof import('../../src/executor/docker.js').removeVolume>
>();

vi.mock('../../src/executor/docker.js', () => ({
  listVolumesByFilter: (...a: unknown[]) =>
    mockListVolumesByFilter(...(a as Parameters<typeof mockListVolumesByFilter>)),
  removeVolume: (...a: unknown[]) =>
    mockRemoveVolume(...(a as Parameters<typeof mockRemoveVolume>)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jid(n: number): string {
  return `job_${n.toString(16).padStart(32, '0')}`;
}
function aid(n: number): string {
  return `att_${n.toString(16).padStart(32, '0')}`;
}

function ownedVol(jobId: string): VolumeSummary {
  return {
    Name: evidenceVolumeName(jobId),
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_RESOURCE]: 'evidence',
      [LABEL_JOB]: jobId,
    },
  };
}

let dbPath: string;
let store: AgentJobStore;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-itest-')), 'agents.db');
  store = new AgentJobStore(dbPath);
  vi.clearAllMocks();
  mockListVolumesByFilter.mockResolvedValue([]);
  mockRemoveVolume.mockResolvedValue(undefined);
});

afterEach(() => {
  try { store.close(); } catch { /* may be already closed */ }
});

function insertJob(n: number, cls: 'ephemeral' | 'short' | 'audit' = 'ephemeral'): string {
  const id = jid(n);
  store.insert({
    jobId: id, principalId: 'owner', backend: 'kiro', project: 'proj',
    profile: 'audit', resourcePolicy: 'economy',
    promptHash: 'a'.repeat(64), prompt: 'test', sessionPolicy: 'new', writer: false,
    retentionClass: cls, retentionDurationMs: AGENT_RETENTION_DURATION_MS[cls],
  });
  return id;
}

function driveToCompleted(id: string): void {
  const now = new Date().toISOString();
  store.transition(id, 'QUEUED', 'PREPARING', { startedAt: now });
  store.transition(id, 'PREPARING', 'RUNNING');
  store.transition(id, 'RUNNING', 'VALIDATING');
  store.publishArtifact(id, {
    artifactHash: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
    contentComplete: true, applicable: true, reason: null,
    artifactVolume: evidenceVolumeName(id), artifactBytes: 100, opCount: 1,
  });
  store.transition(id, 'VALIDATING', 'COMPLETED', { completedAt: now });
}

function driveToApplied(id: string, attN: number): void {
  driveToCompleted(id);
  const attId = aid(attN);
  store.startApplyAttempt({ attemptId: attId, jobId: id });
  store.transitionApplyAttempt(attId, 'STARTED', 'VERIFYING');
  store.transitionApplyAttempt(attId, 'VERIFYING', 'APPLYING');
  store.markApplySuccess(attId, id);
}

function forceRetainUntilPast(id: string): void {
  const past = new Date(Date.now() - 2 * AGENT_RETENTION_DURATION_MS.ephemeral).toISOString();
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE agent_jobs SET retain_until = ?, disposition_at = ? WHERE job_id = ?')
    .run(past, past, id);
  raw.close();
}

function forceRetainUntilFuture(id: string): void {
  const future = new Date(Date.now() + 2 * AGENT_RETENTION_DURATION_MS.ephemeral).toISOString();
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE agent_jobs SET retain_until = ?, disposition_at = ? WHERE job_id = ?')
    .run(future, future, id);
  raw.close();
}

// ---------------------------------------------------------------------------
// Full v5 lifecycle: new → APPLIED/DISCARDED → elapsed → EXPIRED → removed
// ---------------------------------------------------------------------------

describe('v5 lifecycle — end-to-end APPLIED path', () => {
  it('job reaches APPLIED, retain_until elapsed → collectExpiredEvidence sets EXPIRED and deletes volume', async () => {
    const id = insertJob(1);
    driveToApplied(id, 1);
    forceRetainUntilPast(id);

    mockListVolumesByFilter.mockResolvedValue([ownedVol(id)]);

    const result = await collectExpiredEvidence(store);

    expect(result.expiredCount).toBe(1);
    expect(store.get(id)!.artifactState).toBe('EXPIRED');
    // Job metadata preserved — status is still APPLIED.
    expect(store.get(id)!.status).toBe('APPLIED');
    expect(mockRemoveVolume).toHaveBeenCalledWith(evidenceVolumeName(id), true);
  });

  it('job reaches APPLIED, retain_until in future → collectExpiredEvidence does NOT expire', async () => {
    const id = insertJob(1);
    driveToApplied(id, 1);
    forceRetainUntilFuture(id);

    mockListVolumesByFilter.mockResolvedValue([ownedVol(id)]);

    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(0);
    expect(store.get(id)!.artifactState).toBe('AVAILABLE');
  });

  it('job reaches DISCARDED, retain_until elapsed → EXPIRED + volume deleted', async () => {
    const id = insertJob(2);
    driveToCompleted(id);
    store.discardJob(id);
    forceRetainUntilPast(id);

    mockListVolumesByFilter.mockResolvedValue([ownedVol(id)]);

    const result = await collectExpiredEvidence(store);
    expect(result.expiredCount).toBe(1);
    expect(store.get(id)!.artifactState).toBe('EXPIRED');
    expect(store.get(id)!.status).toBe('DISCARDED');
  });
});

// ---------------------------------------------------------------------------
// Crash consistency: EXPIRED already in DB
// ---------------------------------------------------------------------------

describe('crash consistency — reconcileExpiredEvidence', () => {
  it('EXPIRED in DB + volume present → reconcile removes it (Proof B completion)', async () => {
    const id = insertJob(1);
    // Force artifact_state=EXPIRED directly (simulating crash after markExpired but before delete).
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(evidenceVolumeName(id), id);
    raw.close();

    mockListVolumesByFilter.mockResolvedValue([ownedVol(id)]);

    const result = await reconcileExpiredEvidence(store);
    expect(result.deleteSuccessCount).toBe(1);
    expect(mockRemoveVolume).toHaveBeenCalledWith(evidenceVolumeName(id), true);
  });

  it('EXPIRED in DB + volume already absent → idempotent success', async () => {
    const id = insertJob(2);
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='DISCARDED'
      WHERE job_id=?`).run(evidenceVolumeName(id), id);
    raw.close();

    mockListVolumesByFilter.mockResolvedValue([]); // volume gone

    const result = await reconcileExpiredEvidence(store);
    expect(result.alreadyAbsentCount).toBe(1);
    expect(result.deleteSuccessCount).toBe(0);
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });

  it('EXPIRED in DB + restarted twice → second restart is idempotent no-op', async () => {
    const id = insertJob(3);
    const raw = new DatabaseSync(dbPath);
    raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
      WHERE job_id=?`).run(evidenceVolumeName(id), id);
    raw.close();

    // First restart: volume present → delete succeeds.
    mockListVolumesByFilter.mockResolvedValueOnce([ownedVol(id)]);
    const r1 = await reconcileExpiredEvidence(store);
    expect(r1.deleteSuccessCount).toBe(1);

    // Second restart: volume gone → idempotent.
    mockListVolumesByFilter.mockResolvedValue([]);
    const r2 = await reconcileExpiredEvidence(store);
    expect(r2.alreadyAbsentCount).toBe(1);
    expect(r2.deleteSuccessCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integrity anomaly: AVAILABLE in DB, volume manually missing
// ---------------------------------------------------------------------------

describe('integrity anomaly — AVAILABLE job, volume absent', () => {
  it('reports anomaly, does NOT set EXPIRED, artifact_state remains AVAILABLE', async () => {
    const id = insertJob(1);
    driveToApplied(id, 1);
    forceRetainUntilPast(id);

    // Volume absent from Docker (simulates manual deletion).
    mockListVolumesByFilter.mockResolvedValue([]);

    const result = await collectExpiredEvidence(store);
    expect(result.integrityAnomalyCount).toBeGreaterThanOrEqual(1);
    expect(result.expiredCount).toBe(0);
    expect(store.get(id)!.artifactState).toBe('AVAILABLE');
    expect(store.get(id)!.status).toBe('APPLIED');
    expect(mockRemoveVolume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Startup ordering: all three steps fire in order before readiness
// ---------------------------------------------------------------------------

describe('startup ordering — runStartupEvidenceLifecycle', () => {
  it('runs reconcile → collectExpired → classify in order, returns combined result', async () => {
    const callOrder: string[] = [];

    // Spy on console.log to detect the log calls from each phase.
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      try {
        const parsed = JSON.parse(msg) as { msg?: string };
        if (parsed.msg?.includes('reconcile previously EXPIRED')) callOrder.push('reconcile');
        else if (parsed.msg?.includes('Lane A candidates')) callOrder.push('laneA');
        else if (parsed.msg?.includes('classification complete')) callOrder.push('laneB');
      } catch { /* not JSON */ }
    });

    const result = await runStartupEvidenceLifecycle(store);

    spy.mockRestore();

    // All three phases must have run.
    expect(callOrder).toContain('reconcile');
    expect(callOrder).toContain('laneA');
    expect(callOrder).toContain('laneB');
    // Ordering: reconcile before laneA before laneB.
    expect(callOrder.indexOf('reconcile')).toBeLessThan(callOrder.indexOf('laneA'));
    expect(callOrder.indexOf('laneA')).toBeLessThan(callOrder.indexOf('laneB'));

    // Combined result object has all three sections.
    expect(result).toHaveProperty('reconcile');
    expect(result).toHaveProperty('collect');
    expect(result).toHaveProperty('classify');
  });

  it('per-resource delete failure does not block other volumes being processed', async () => {
    // Two jobs both EXPIRED; first delete fails, second succeeds.
    const id1 = insertJob(1);
    const id2 = insertJob(2);

    const raw = new DatabaseSync(dbPath);
    for (const id of [id1, id2]) {
      raw.prepare(`UPDATE agent_jobs SET artifact_state='EXPIRED', artifact_volume=?, status='APPLIED'
        WHERE job_id=?`).run(evidenceVolumeName(id), id);
    }
    raw.close();

    mockListVolumesByFilter.mockImplementation(async (filters) => {
      const nameFilter = (filters.name ?? []) as string[];
      if (nameFilter[0] === evidenceVolumeName(id1)) return [ownedVol(id1)];
      if (nameFilter[0] === evidenceVolumeName(id2)) return [ownedVol(id2)];
      return [ownedVol(id1), ownedVol(id2)];
    });

    // First remove fails; second succeeds.
    mockRemoveVolume
      .mockRejectedValueOnce(new Error('simulated delete failure for id1'))
      .mockResolvedValueOnce(undefined);

    const result = await reconcileExpiredEvidence(store);

    // Both processed: one failed (retained/reported), one succeeded.
    const total = result.deleteSuccessCount + result.retainedCount + result.alreadyAbsentCount;
    expect(total).toBe(2);
    // The function did not throw — per-resource failure is contained.
  });

  it('global Docker failure in classifyIncompleteEvidence propagates (fail startup closed)', async () => {
    mockListVolumesByFilter.mockRejectedValue(new Error('Docker unavailable'));
    // classifyIncompleteEvidence propagates Docker errors as global failures.
    await expect(classifyIncompleteEvidence(store)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Service readiness: verify lifecycle steps run before listen() equivalent
// ---------------------------------------------------------------------------

describe('lifecycle before service readiness', () => {
  it('runStartupEvidenceLifecycle completes before returning (no fire-and-forget)', async () => {
    let lifecycleCompleted = false;
    // Insert a job that will be processed.
    const id = insertJob(1);
    driveToApplied(id, 1);
    forceRetainUntilPast(id);
    mockListVolumesByFilter.mockResolvedValue([ownedVol(id)]);

    const promise = runStartupEvidenceLifecycle(store).then((r) => {
      lifecycleCompleted = true;
      return r;
    });

    // Not yet complete synchronously.
    expect(lifecycleCompleted).toBe(false);

    await promise;
    // Now complete.
    expect(lifecycleCompleted).toBe(true);
    expect(store.get(id)!.artifactState).toBe('EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

describe('schema version', () => {
  it('store opens at v5', () => {
    expect(store.schemaVersion).toBe(5);
  });
});
