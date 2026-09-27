import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentControlPlaneConfig } from '../../src/executor/agentConfig.js';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import {
  SecurityAssessmentOperationalService,
  UnavailableSecurityAssessmentCapabilityRegistry,
} from '../../src/executor/securityAssessment/service.js';
import type {
  AssessmentSourceStageReceipt,
  AssessmentSourceStager,
  StagedAssessmentSource,
} from '../../src/executor/securityAssessment/sourceStaging.js';
import { BridgeError } from '../../src/shared/errors.js';

const REV = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const IMAGE = `sha256:${'c'.repeat(64)}`;
const ASSESSMENT = `assessment_${'d'.repeat(24)}`;

const stores: AgentJobStore[] = [];
function store(): AgentJobStore {
  const value = new AgentJobStore(join(mkdtempSync(join(tmpdir(), 'be9-operational-')), 'agents.db'));
  stores.push(value);
  return value;
}

afterEach(() => {
  for (const value of stores.splice(0)) value.close();
});

function config(): AgentControlPlaneConfig {
  return {
    backends: [],
    profiles: [],
    resourcePolicies: [],
    projects: [{
      id: 'project-a',
      hostPath: '/trusted/project-a',
      gitRequired: true,
      guardedPaths: [],
      sensitiveReadGlobs: [],
      worktreeId: 'project-a-worktree',
      executionResources: [{ category: 'database', id: 'shared-a' }],
      globalExclusive: false,
    }],
  };
}

function receipt(mode: 'stage' | 'verify' = 'verify'): AssessmentSourceStageReceipt {
  return {
    schemaVersion: 'BE9_SOURCE_STAGE_V1',
    mode,
    assessmentId: ASSESSMENT,
    projectId: 'project-a',
    sourceRevision: REV,
    sourceTree: TREE,
    fileCount: 5,
    totalBytes: 500,
    manifestBytes: 300,
    manifestDigest: 'e'.repeat(64),
    stagerImageId: IMAGE,
    stagingPolicyVersion: 'BE9_SOURCE_STAGING_POLICY_V1',
    createdAt: '2026-09-27T20:00:00.000Z',
  };
}

function fakeStager(overrides: Partial<AssessmentSourceStager> = {}): AssessmentSourceStager {
  const staged: StagedAssessmentSource = {
    assessmentId: ASSESSMENT,
    projectId: 'project-a',
    executionId: `job_${'f'.repeat(32)}`,
    sourceVolume: 'qg-be9-source-test',
    receipt: receipt('stage'),
  };
  return {
    probe: async () => receipt('verify'),
    stage: async () => staged,
    revalidateBeforeRun: async () => receipt('verify'),
    recover: async () => receipt('verify'),
    remove: async () => {},
    ...overrides,
  } as AssessmentSourceStager;
}

function request() {
  return {
    assessmentId: ASSESSMENT,
    projectId: 'project-a',
    expectedSourceRevision: REV,
    requireRunningTarget: false,
    requestedCapabilityClasses: ['SAST'],
  };
}

function service(
  db: AgentJobStore,
  stager: AssessmentSourceStager = fakeStager(),
  targetResolver = async (id: string) => ({ id, running: true }),
) {
  return new SecurityAssessmentOperationalService(
    config(),
    db,
    stager,
    IMAGE,
    targetResolver,
    new UnavailableSecurityAssessmentCapabilityRegistry(),
  );
}

describe('BE9.2 Executor operational assessment service', () => {
  it('derives trusted project source facts and reports absent BE10 scanner truthfully unavailable', async () => {
    let observedHostPath = '';
    const stager = fakeStager({
      probe: async (input) => {
        observedHostPath = input.hostPath;
        return receipt('verify');
      },
    });
    const result = await service(store(), stager).preflight(request());

    expect(observedHostPath).toBe('/trusted/project-a');
    expect(result).toEqual({
      projectId: 'project-a',
      sourceRevision: REV,
      sourceTree: TREE,
      clean: true,
      gitRequired: true,
      resourceAvailable: true,
      capabilityStatus: 'UNAVAILABLE',
      capabilityCode: 'BE10_SCANNER_PLUGIN_UNAVAILABLE',
    });
  });

  it('does not accept caller-shaped host paths or resource keys because they are absent from the request contract', async () => {
    let observedHostPath = '';
    const stager = fakeStager({
      probe: async (input) => {
        observedHostPath = input.hostPath;
        return receipt('verify');
      },
    });
    await service(store(), stager).preflight({
      ...request(),
      hostPath: '/attacker',
      resourceKeys: ['machine:global-exclusive'],
    } as never);
    expect(observedHostPath).toBe('/trusted/project-a');
  });

  it('reports shared-resource conflict through the existing BE1A lease authority', async () => {
    const db = store();
    db.acquireExecutionLeasesForOwner({
      ownerKind: 'security-assessment',
      ownerId: `assessment_${'1'.repeat(24)}`,
      projectId: 'project-a',
      resourceKeys: ['worktree:project-a-worktree'],
    });
    const result = await service(db).preflight(request());
    expect(result.resourceAvailable).toBe(false);
  });

  it('fails closed on unregistered or offline required targets', async () => {
    await expect(service(store(), fakeStager(), async () => {
      throw new BridgeError('PRECONDITION_FAILED', 'target not registered', 412);
    }).preflight({ ...request(), targetId: 'target-a' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    await expect(service(store(), fakeStager(), async (id) => ({ id, running: false }))
      .preflight({ ...request(), targetId: 'target-a', requireRunningTarget: true }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('fails closed when exact source verification reports drift', async () => {
    const stager = fakeStager({
      probe: async () => ({ ...receipt('verify'), sourceRevision: '9'.repeat(40) }),
    });
    await expect(service(store(), stager).preflight(request()))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('acquires assessment leases before staging and releases them when staging fails', async () => {
    const db = store();
    const stager = fakeStager({
      stage: async () => {
        expect(db.executionLeaseSummary()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            ownerKind: 'security-assessment',
            ownerId: ASSESSMENT,
            state: 'ACTIVE',
          }),
        ]));
        throw new BridgeError('PRECONDITION_FAILED', 'synthetic dirty source', 412);
      },
    });

    await expect(service(db, stager).prepare(request()))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.executionLeaseSummary()).toEqual([]);
  });

  it('recovers an exact durable staged source after executor service restart without restaging', async () => {
    const db = store();
    await service(db).prepare(request());

    let recovered = 0;
    let stagedAgain = 0;
    const restarted = service(db, fakeStager({
      stage: async () => {
        stagedAgain++;
        throw new Error('must not restage during recovery');
      },
      recover: async (input) => {
        recovered++;
        expect(input.assessmentId).toBe(ASSESSMENT);
        expect(input.projectId).toBe('project-a');
        expect(input.sourceVolume).toBe('qg-be9-source-test');
        return receipt('verify');
      },
    }));
    await restarted.recoverPrepared();
    await expect(restarted.revalidateBeforeRun(ASSESSMENT)).resolves.toMatchObject({
      assessmentId: ASSESSMENT,
      projectId: 'project-a',
      manifestDigest: 'e'.repeat(64),
    });
    expect(recovered).toBe(1);
    expect(stagedAgain).toBe(0);
  });

  it('fails closed and marks leases UNCERTAIN when restart cannot prove the durable source volume', async () => {
    const db = store();
    await service(db).prepare(request());

    const restarted = service(db, fakeStager({
      recover: async () => {
        throw new BridgeError('PRECONDITION_FAILED', 'prepared volume missing', 412);
      },
    }));
    await expect(restarted.recoverPrepared())
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.executionLeaseSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ownerKind: 'security-assessment',
        ownerId: ASSESSMENT,
        state: 'UNCERTAIN',
      }),
    ]));
  });

  it('marks the shared resource lease uncertain when source cleanup cannot be proven', async () => {
    const db = store();
    const stager = fakeStager({
      remove: async () => {
        throw new BridgeError('DOCKER_UNAVAILABLE', 'synthetic cleanup failure', 503);
      },
    });
    const operational = service(db, stager);
    await operational.prepare(request());

    await expect(operational.cleanup(ASSESSMENT))
      .rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    expect(db.executionLeaseSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ownerKind: 'security-assessment',
        ownerId: ASSESSMENT,
        state: 'UNCERTAIN',
      }),
    ]));
  });
});
