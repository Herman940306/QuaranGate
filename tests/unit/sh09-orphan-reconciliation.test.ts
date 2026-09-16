import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LABEL_ATTEMPT, LABEL_JOB, LABEL_MANAGED, LABEL_RESOURCE,
} from '../../src/executor/agents/sandboxSpec.js';

const dockerStub = vi.hoisted(() => ({
  listContainersByFilter: vi.fn(),
  listVolumesByFilter: vi.fn(),
  listNetworksByFilter: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
  removeVolume: vi.fn(),
  removeNetwork: vi.fn(),
}));

vi.mock('../../src/executor/docker.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/executor/docker.js')>('../../src/executor/docker.js');
  return { ...actual, ...dockerStub };
});

import { RunnerSandbox } from '../../src/executor/agents/sandboxRunner.js';

const JOB = `job_${'a'.repeat(32)}`;
const ATTEMPT = `att_${'b'.repeat(32)}`;
const managed = (resource: string) => ({
  [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: resource, [LABEL_JOB]: JOB,
  ...(resource === 'applier' ? { [LABEL_ATTEMPT]: ATTEMPT } : {}),
});

function sandbox(): RunnerSandbox { return new RunnerSandbox({ image: 'sha256:' + '1'.repeat(64) }); }

beforeEach(() => {
  vi.clearAllMocks();
  dockerStub.listContainersByFilter.mockResolvedValue([]);
  dockerStub.listVolumesByFilter.mockResolvedValue([]);
  dockerStub.listNetworksByFilter.mockResolvedValue([]);
  dockerStub.stopContainer.mockResolvedValue(undefined);
  dockerStub.removeContainer.mockResolvedValue(undefined);
  dockerStub.removeVolume.mockResolvedValue(undefined);
  dockerStub.removeNetwork.mockResolvedValue(undefined);
});

describe('SH-09 crash recovery: fail-closed orphan reconciliation', () => {
  it('removes a crash-orphaned applier container and control volume before reporting them reconciled', async () => {
    dockerStub.listContainersByFilter.mockResolvedValueOnce([{
      Id: 'applier-cid', Names: ['/applier'], Image: 'sha256:x', State: 'running', Status: 'Up', Labels: managed('applier'),
    }]);
    dockerStub.listVolumesByFilter.mockResolvedValueOnce([{
      Name: 'applier-control', Labels: managed('applier'),
    }]);
    const result = await sandbox().reconcileOrphans();
    expect(dockerStub.removeContainer).toHaveBeenCalledWith('applier-cid', true);
    expect(dockerStub.removeVolume).toHaveBeenCalledWith('applier-control', true);
    expect(result.removedContainers).toContain('applier-cid');
    expect(result.removedVolumes).toContain('applier-control');
  });

  it('fails startup recovery when managed-container enumeration cannot be proven', async () => {
    dockerStub.listContainersByFilter.mockRejectedValueOnce(new Error('broker unavailable'));
    await expect(sandbox().reconcileOrphans()).rejects.toThrow('broker unavailable');
    expect(dockerStub.removeContainer).not.toHaveBeenCalled();
  });

  it('does not report an applier removed when Docker removal fails', async () => {
    dockerStub.listContainersByFilter.mockResolvedValueOnce([{
      Id: 'applier-cid', Names: ['/applier'], Image: 'sha256:x', State: 'running', Status: 'Up', Labels: managed('applier'),
    }]);
    dockerStub.removeContainer.mockRejectedValueOnce(new Error('remove refused'));
    await expect(sandbox().reconcileOrphans()).rejects.toThrow('remove refused');
  });

  it('allows stop failure only when forced removal succeeds', async () => {
    dockerStub.listContainersByFilter.mockResolvedValueOnce([{
      Id: 'applier-cid', Names: ['/applier'], Image: 'sha256:x', State: 'exited', Status: 'Exited', Labels: managed('applier'),
    }]);
    dockerStub.stopContainer.mockRejectedValueOnce(new Error('already stopped'));
    const result = await sandbox().reconcileOrphans();
    expect(dockerStub.removeContainer).toHaveBeenCalledWith('applier-cid', true);
    expect(result.removedContainers).toContain('applier-cid');
  });

  it('fails startup recovery when an applier control volume cannot be removed', async () => {
    dockerStub.listVolumesByFilter.mockResolvedValueOnce([{ Name: 'applier-control', Labels: managed('applier') }]);
    dockerStub.removeVolume.mockRejectedValueOnce(new Error('volume still attached'));
    await expect(sandbox().reconcileOrphans()).rejects.toThrow('volume still attached');
  });

  it('fails startup recovery when managed-volume enumeration cannot be proven', async () => {
    dockerStub.listVolumesByFilter.mockRejectedValueOnce(new Error('volume inventory unavailable'));
    await expect(sandbox().reconcileOrphans()).rejects.toThrow('volume inventory unavailable');
  });

  it('fails startup recovery when managed-network enumeration/removal cannot be proven', async () => {
    dockerStub.listNetworksByFilter.mockRejectedValueOnce(new Error('network inventory unavailable'));
    await expect(sandbox().reconcileOrphans()).rejects.toThrow('network inventory unavailable');

    dockerStub.listNetworksByFilter.mockReset();
    dockerStub.listNetworksByFilter.mockResolvedValue([]);
    dockerStub.listNetworksByFilter.mockResolvedValueOnce([{
      Id: 'net-id', Name: 'net', Labels: managed('net'), Containers: {},
    }]);
    dockerStub.removeNetwork.mockRejectedValueOnce(new Error('network remove refused'));
    await expect(sandbox().reconcileOrphans()).rejects.toThrow('network remove refused');
  });
});
