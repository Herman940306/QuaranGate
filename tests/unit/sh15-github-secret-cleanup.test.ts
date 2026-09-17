import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  docker: {
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    waitContainer: vi.fn(),
    getContainerLogs: vi.fn(),
    removeContainer: vi.fn(),
    removeVolume: vi.fn(),
    listContainersByFilter: vi.fn(),
    listVolumesByFilter: vi.fn(),
  },
  broker: {
    repository: vi.fn(),
    branch: vi.fn(),
    pushToken: vi.fn(),
  },
  populateVolume: vi.fn(),
}));

vi.mock('../../src/executor/docker.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/executor/docker.js')>(),
  ...h.docker,
}));
vi.mock('../../src/executor/githubBrokerClient.js', () => ({ githubBroker: h.broker }));
vi.mock('../../src/executor/agents/runnerAssets.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/executor/agents/runnerAssets.js')>(),
  populateVolume: h.populateVolume,
}));

import { GitHubControl } from '../../src/executor/githubControl.js';

const HEAD = 'a'.repeat(40);

function control(): GitHubControl {
  return new GitHubControl({
    config: {
      accounts: [{ owner: 'ExampleOwner' }],
      repositories: [{ project: 'proj', owner: 'ExampleOwner', repo: 'Repo', protectedBranches: ['main'] }],
    },
    agents: {
      projects: [{ id: 'proj', gitRequired: true, hostPath: '/trusted/proj' }],
    },
    helperImage: 'quarangate:git-helper-abc123',
    controlNetwork: 'quarangate-github-control',
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.docker.createContainer.mockResolvedValueOnce('head-cid').mockResolvedValueOnce('push-cid');
  h.docker.startContainer.mockResolvedValue(undefined);
  h.docker.waitContainer.mockResolvedValue({ statusCode: 0, timedOut: false });
  h.docker.getContainerLogs.mockResolvedValue({ stdout: `${HEAD}\n`, stderr: '', bytes: 41, truncated: false });
  h.docker.removeContainer.mockResolvedValue(undefined);
  h.docker.removeVolume.mockResolvedValue(undefined);
  h.docker.listContainersByFilter.mockResolvedValue([]);
  h.docker.listVolumesByFilter.mockResolvedValue([]);
  h.populateVolume.mockResolvedValue(undefined);
  h.broker.repository.mockResolvedValue({
    full_name: 'ExampleOwner/Repo', default_branch: 'main', private: true, archived: false, disabled: false,
  });
  h.broker.branch.mockResolvedValueOnce(null).mockResolvedValueOnce({ protected: false, commit: { sha: HEAD } });
  h.broker.pushToken.mockResolvedValue({ token: 'synthetic-installation-token', expiresAt: '2099-01-01T00:00:00Z' });
});

describe('SH-15 GitHub operational secret cleanup', () => {
  it('fails closed instead of reporting a successful push when the temporary token volume cannot be removed', async () => {
    h.docker.removeVolume.mockRejectedValue(new Error('sensitive daemon detail'));

    await expect(control().pushBranch('proj', HEAD, 'feature/test'))
      .rejects.toMatchObject({ code: 'GITHUB_PUSH_FAILED' });

    expect(h.docker.removeVolume).toHaveBeenCalled();
  });

  it('fails startup reconciliation when an orphan GitHub secret volume cannot be removed', async () => {
    h.docker.listVolumesByFilter.mockResolvedValue([{ Name: 'quarangate-github-secret-gh_orphan', Labels: {} }]);
    h.docker.removeVolume.mockRejectedValue(new Error('remove refused'));

    await expect(control().reconcileOrphans()).rejects.toMatchObject({ code: 'GITHUB_PUSH_FAILED' });
  });
});
