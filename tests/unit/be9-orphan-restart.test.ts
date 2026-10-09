import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const docker = vi.hoisted(() => ({
  listContainersByFilter: vi.fn(),
  listVolumesByFilter: vi.fn(),
  removeContainer: vi.fn(),
  removeVolume: vi.fn(),
}));
vi.mock('../../src/executor/docker.js', () => docker);

import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import type { AgentControlPlaneConfig } from '../../src/executor/agentConfig.js';
import { SecurityAssessmentOperationalService } from '../../src/executor/securityAssessment/service.js';
import { AssessmentSourceStager } from '../../src/executor/securityAssessment/sourceStaging.js';

const ASSESSMENT = `assessment_${'a'.repeat(24)}`;
const IMAGE = `sha256:${'b'.repeat(64)}`;
const config: AgentControlPlaneConfig = {
  backends: [], profiles: [], resourcePolicies: [],
  projects: [{ id: 'project-a', hostPath: '/trusted/project-a', gitRequired: true,
    guardedPaths: [], sensitiveReadGlobs: [], worktreeId: 'project-a-worktree',
    executionResources: [], globalExclusive: false }],
};
const stores: AgentJobStore[] = [];
function service(store: AgentJobStore): SecurityAssessmentOperationalService {
  return new SecurityAssessmentOperationalService(config, store, new AssessmentSourceStager(),
    IMAGE, async (id) => ({ id, running: true }));
}

describe('BE9 orphan recovery across durable restart', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    docker.listContainersByFilter.mockResolvedValue([]);
    docker.listVolumesByFilter.mockResolvedValue([]);
    docker.removeVolume.mockResolvedValue(undefined);
    docker.removeContainer.mockResolvedValue(undefined);
  });
  afterEach(() => { for (const store of stores.splice(0)) store.close(); });

  it.each(['probe', 'prepare'] as const)('reconciles an exact %s crash resource after store reopen', async (phase) => {
    const path = join(mkdtempSync(join(tmpdir(), 'be9-orphan-')), 'agents.db');
    const first = new AgentJobStore(path);
    first.acquireExecutionLeasesForOwner({ ownerKind: 'security-assessment', ownerId: ASSESSMENT,
      projectId: 'project-a', resourceKeys: ['worktree:project-a-worktree'] });
    const executionId = first.assessmentAllocationExecutionId(ASSESSMENT);
    const name = phase === 'probe' ? 'qg-be9-probe-owned' : 'qg-be9-source-owned';
    first.close();
    const labels = { 'io.quarangate.managed': 'true', 'io.quarangate.resource': 'assessment-source',
      'io.quarangate.assessment': ASSESSMENT, 'io.quarangate.job': executionId };
    docker.listVolumesByFilter.mockResolvedValueOnce([{ Name: name, Labels: labels }]).mockResolvedValueOnce([]);
    const reopened = new AgentJobStore(path);
    stores.push(reopened);
    await service(reopened).recoverPrepared();
    expect(docker.removeVolume).toHaveBeenCalledExactlyOnceWith(name, true);
    expect(docker.listVolumesByFilter).toHaveBeenCalledWith({ label: [
      'io.quarangate.managed=true', 'io.quarangate.resource=assessment-source',
      `io.quarangate.assessment=${ASSESSMENT}`, `io.quarangate.job=${executionId}`,
    ] });
    expect(reopened.executionLeaseSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: ASSESSMENT, state: 'UNCERTAIN' }),
    ]));
    await service(reopened).recoverPrepared();
    expect(docker.removeVolume).toHaveBeenCalledTimes(1);
  });

  it('quarantines a false execution label and leaves the resource untouched', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'be9-orphan-')), 'agents.db');
    const first = new AgentJobStore(path);
    first.acquireExecutionLeasesForOwner({ ownerKind: 'security-assessment', ownerId: ASSESSMENT,
      projectId: 'project-a', resourceKeys: ['worktree:project-a-worktree'] });
    first.close();
    const reopened = new AgentJobStore(path);
    stores.push(reopened);
    docker.listVolumesByFilter.mockResolvedValue([{ Name: 'qg-be9-source-foreign', Labels: {
      'io.quarangate.managed': 'true', 'io.quarangate.resource': 'assessment-source',
      'io.quarangate.assessment': ASSESSMENT, 'io.quarangate.job': `job_${'f'.repeat(32)}`,
    } }]);
    await service(reopened).recoverPrepared();
    expect(docker.removeVolume).not.toHaveBeenCalled();
    expect(reopened.executionLeaseSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: ASSESSMENT, state: 'UNCERTAIN' }),
    ]));
  });

  it('never records proven absence when exact post-deletion inventory fails', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'be9-orphan-')), 'agents.db');
    const first = new AgentJobStore(path);
    first.acquireExecutionLeasesForOwner({ ownerKind: 'security-assessment', ownerId: ASSESSMENT,
      projectId: 'project-a', resourceKeys: ['worktree:project-a-worktree'] });
    const executionId = first.assessmentAllocationExecutionId(ASSESSMENT);
    first.close();
    docker.listVolumesByFilter
      .mockResolvedValueOnce([{ Name: 'qg-be9-source-owned', Labels: {
        'io.quarangate.managed': 'true', 'io.quarangate.resource': 'assessment-source',
        'io.quarangate.assessment': ASSESSMENT, 'io.quarangate.job': executionId,
      } }])
      .mockRejectedValueOnce(new Error('Docker inspect failed with private response'));
    const reopened = new AgentJobStore(path);
    stores.push(reopened);
    await service(reopened).recoverPrepared();
    expect(docker.removeVolume).toHaveBeenCalledOnce();
    const raw = new DatabaseSync(path);
    const row = raw.prepare(`SELECT state, reason FROM execution_resource_leases
      WHERE owner_kind='security-assessment' AND owner_id=?`).get(ASSESSMENT) as { state: string; reason: string };
    raw.close();
    expect(row).toEqual({ state: 'UNCERTAIN',
      reason: 'assessment orphan resource cleanup or absence could not be proven' });
  });

  it('keeps a legacy lease without a durable job binding uncertain and untouched', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'be9-legacy-orphan-')), 'agents.db');
    const first = new AgentJobStore(path);
    first.acquireExecutionLeasesForOwner({ ownerKind: 'security-assessment', ownerId: ASSESSMENT,
      projectId: 'project-a', resourceKeys: ['worktree:project-a-worktree'] });
    first.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE execution_resource_leases SET lease_id=? WHERE owner_id=?")
      .run(`erl_${'1'.repeat(32)}`, ASSESSMENT);
    raw.close();
    const reopened = new AgentJobStore(path);
    stores.push(reopened);
    await service(reopened).recoverPrepared();
    expect(docker.listVolumesByFilter).not.toHaveBeenCalled();
    expect(docker.removeVolume).not.toHaveBeenCalled();
    expect(reopened.executionLeaseSummary()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: ASSESSMENT, state: 'UNCERTAIN' }),
    ]));
  });
});
