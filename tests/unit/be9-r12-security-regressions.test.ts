import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { SecurityAssessmentOperationalService } from '../../src/executor/securityAssessment/service.js';
import { AssessmentSourceStager } from '../../src/executor/securityAssessment/sourceStaging.js';
import type { AgentControlPlaneConfig } from '../../src/executor/agentConfig.js';
import { listVolumesByFilter } from '../../src/executor/docker.js';

vi.mock('../../src/executor/docker.js', () => ({
  listVolumesByFilter: vi.fn(),
}));

const ASSESSMENT = `assessment_${'a'.repeat(24)}`;
const IMAGE = `sha256:${'b'.repeat(64)}`;
const REV = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const project = {
  id: 'project-a', hostPath: '/trusted/project-a', gitRequired: true,
  guardedPaths: [], sensitiveReadGlobs: [], worktreeId: 'wt-a',
  executionResources: [{ category: 'database' as const, id: 'shared' }],
  globalExclusive: false,
};
const config: AgentControlPlaneConfig = { backends: [], profiles: [], resourcePolicies: [], projects: [project] };
const request = { assessmentId: ASSESSMENT, projectId: 'project-a', expectedSourceRevision: REV,
  requestedCapabilityClasses: ['SAST'], requireRunningTarget: false };
const receipt = {
  schemaVersion: 'BE9_SOURCE_STAGE_V1' as const, mode: 'stage' as const,
  assessmentId: ASSESSMENT, projectId: 'project-a', sourceRevision: REV,
  sourceTree: TREE, fileCount: 1, totalBytes: 10, manifestBytes: 4,
  manifestDigest: 'e'.repeat(64), stagerImageId: IMAGE,
  stagingPolicyVersion: 'BE9_SOURCE_STAGING_POLICY_V1' as const,
  createdAt: '2026-10-10T01:00:00.000Z',
};
const opened: AgentJobStore[] = [];
function store() {
  const db = new AgentJobStore(join(mkdtempSync(join(tmpdir(), 'be9-r12-')), 'db.sqlite'));
  opened.push(db);
  return db;
}
afterEach(() => { for (const db of opened.splice(0)) db.close(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function operational(
  db: AgentJobStore,
  remove: (x: any) => Promise<void> = async () => {},
  stageGate?: Promise<void>,
) {
  const stager = {
    stage: async (input: any) => {
      if (stageGate) await stageGate;
      return {
        assessmentId: ASSESSMENT, projectId: 'project-a', executionId: input.executionId,
        sourceVolume: `qg-be9-source-${input.executionId}`, receipt,
      };
    },
    probe: async () => ({ ...receipt, mode: 'verify' }),
    remove, recover: async () => ({ ...receipt, mode: 'verify' }),
    revalidateBeforeRun: async () => ({ ...receipt, mode: 'verify' }), reconcileOrphan: async () => 0,
  } as unknown as AssessmentSourceStager;
  return new SecurityAssessmentOperationalService(config, db, stager, IMAGE,
    async (id) => ({ id, running: true }));
}

describe('BE9 R12 regression: allocation and recovery generation boundaries', () => {
  it('rejects 129 total leases before durable allocation, including global exclusive', () => {
    const db = store();
    const keys = Array.from({ length: 128 }, (_, i) => `database:r12-${i}`);
    expect(() => db.acquireExecutionLeasesForOwner({
      ownerKind: 'security-assessment', ownerId: ASSESSMENT, projectId: 'project-a',
      resourceKeys: keys, globalExclusive: true,
    })).toThrowError(expect.objectContaining({ code: 'MALFORMED_REQUEST' }));
    expect(db.executionLeaseSummary()).toHaveLength(0);
  });

  it('persists no global-exclusive lease after rejected 129-key allocation and database reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'be9-r12-reopen-')), 'db.sqlite');
    const first = new AgentJobStore(path);
    const keys = Array.from({ length: 128 }, (_, i) => `database:r12-reopen-${i}`);
    expect(() => first.acquireExecutionLeasesForOwner({
      ownerKind: 'security-assessment', ownerId: ASSESSMENT,
      projectId: 'project-a', resourceKeys: keys, globalExclusive: true,
    })).toThrowError(expect.objectContaining({ code: 'MALFORMED_REQUEST' }));
    first.close();
    const reopened = new AgentJobStore(path);
    try {
      expect(reopened.executionLeaseSummary()).toHaveLength(0);
      expect(reopened.assessmentAllocationExecutionId.bind(reopened, ASSESSMENT))
        .toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
    } finally {
      reopened.close();
    }
  });

  it('allows exactly 128 total keys while rejecting duplicate global-exclusive requests', () => {
    const db = store();
    const keys = Array.from({ length: 127 }, (_, i) => `database:r12-edge-${i}`);
    db.acquireExecutionLeasesForOwner({
      ownerKind: 'security-assessment', ownerId: ASSESSMENT, projectId: 'project-a',
      resourceKeys: keys, globalExclusive: true,
    });
    expect(db.executionLeaseSummary()).toHaveLength(128);
    db.releaseExecutionLeasesForOwner('security-assessment', ASSESSMENT);
    expect(db.executionLeaseSummary()).toHaveLength(0);
    expect(() => db.acquireExecutionLeasesForOwner({
      ownerKind: 'security-assessment', ownerId: ASSESSMENT, projectId: 'project-a',
      resourceKeys: ['machine:global-exclusive'], globalExclusive: true,
    })).toThrowError(expect.objectContaining({ code: 'MALFORMED_REQUEST' }));
    expect(db.executionLeaseSummary()).toHaveLength(0);
  });

  it('rejects oversized valid project configuration at both service boundaries before Docker or durable writes', async () => {
    const db = store();
    let called = 0;
    const cfg: AgentControlPlaneConfig = { ...config, projects: [{
      ...project, globalExclusive: true,
      executionResources: Array.from({ length: 127 }, (_, i) =>
        ({ category: 'database' as const, id: `r12-proj-${i}` })),
    }] };
    const stage = {
      probe: async () => { called++; return receipt; },
      stage: async () => { called++; throw new Error('must not stage'); },
    } as unknown as AssessmentSourceStager;
    const svc = new SecurityAssessmentOperationalService(cfg, db, stage, IMAGE,
      async (id) => ({ id, running: true }));
    await expect(svc.preflight(request)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(svc.prepare(request)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(called).toBe(0);
    expect(db.executionLeaseSummary()).toHaveLength(0);
  });

  it('rejects stale A cleanup delivered after B prepare without touching B ownership', async () => {
    const db = store();
    const removed: string[] = [];
    const svc = operational(db, async (item) => { removed.push(item.executionId); });
    const first = await svc.prepare(request);
    const a = first.executionId;
    await svc.cleanup(ASSESSMENT, a);
    const second = await svc.prepare(request);
    const b = second.executionId;
    expect(a).not.toBe(b);
    await expect(svc.cleanup(ASSESSMENT, a)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(removed).toEqual([a]);
    expect(db.assessmentAllocationExecutionId(ASSESSMENT)).toBe(b);
    expect(db.getSecurityAssessmentPrepared(ASSESSMENT)?.executionId).toBe(b);
    expect(db.executionLeaseSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: ASSESSMENT, state: 'ACTIVE' }),
    ]));
  });

  it('stale A cleanup cannot quarantine or remove B while B is still staging', async () => {
    const db = store();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const removed: string[] = [];
    const firstSvc = operational(db, async (item) => { removed.push(item.executionId); });
    const a = (await firstSvc.prepare(request)).executionId;
    await firstSvc.cleanup(ASSESSMENT, a);
    const secondSvc = operational(db, async (item) => { removed.push(item.executionId); }, gate);
    const preparing = secondSvc.prepare(request);
    const b = db.assessmentAllocationExecutionId(ASSESSMENT);
    expect(b).not.toBe(a);
    await expect(secondSvc.cleanup(ASSESSMENT, a))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.assessmentAllocationExecutionId(ASSESSMENT)).toBe(b);
    expect(db.executionLeaseSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: ASSESSMENT, state: 'ACTIVE' }),
    ]));
    resume();
    expect((await preparing).executionId).toBe(b);
    expect(removed).toEqual([a]);
  });

  it('missing and malformed generation identity cause no cleanup or lease mutation', async () => {
    const db = store();
    const removed: string[] = [];
    const svc = operational(db, async (item) => { removed.push(item.executionId); });
    const b = (await svc.prepare(request)).executionId;
    await expect(svc.cleanup(ASSESSMENT, undefined as never))
      .rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    await expect(svc.cleanup(ASSESSMENT, 'job_invalid'))
      .rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
    expect(db.assessmentAllocationExecutionId(ASSESSMENT)).toBe(b);
    expect(removed).toHaveLength(0);
    expect(db.getSecurityAssessmentPrepared(ASSESSMENT)?.executionId).toBe(b);
  });

  it('prepared recovery always requests the strict four-label ownership inventory', async () => {
    const mock = vi.mocked(listVolumesByFilter);
    mock.mockResolvedValueOnce([{ Name: 'expected-volume', Labels: {
      'io.quarangate.managed': 'true',
      'io.quarangate.resource': 'assessment-source',
      'io.quarangate.job': `job_${'f'.repeat(32)}`,
      'io.quarangate.assessment': ASSESSMENT,
    } }]);
    const stager = new AssessmentSourceStager();
    vi.spyOn(stager, 'revalidateBeforeRun').mockResolvedValue({ ...receipt, mode: 'verify' });
    const input = {
      assessmentId: ASSESSMENT, projectId: 'project-a',
      executionId: `job_${'f'.repeat(32)}`, sourceVolume: 'expected-volume',
      receipt, expectedSourceRevision: REV, stagerImageId: IMAGE, hostPath: '/trusted/project-a',
    };
    await stager.recover(input);
    expect(mock).toHaveBeenCalledWith({ label: [
      'io.quarangate.managed=true', 'io.quarangate.resource=assessment-source',
      `io.quarangate.assessment=${ASSESSMENT}`,
      `io.quarangate.job=${input.executionId}`,
    ] });
  });
});
