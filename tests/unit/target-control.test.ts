import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docker = vi.hoisted(() => ({
  listContainers: vi.fn(),
  inspectContainer: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  restartContainer: vi.fn(),
  getContainerLogs: vi.fn(),
}));

vi.mock('../../src/executor/docker.js', () => ({
  ...docker,
}));

import { loadTargetConfig, invalidateCache, resolveTargetForControl } from '../../src/executor/targets.js';
import { controlTarget, readTargetLogs } from '../../src/executor/targetControl.js';

const labels = {
  'com.docker.compose.project': 'approved-project',
  'com.docker.compose.service': 'work',
};

function c(state: 'running' | 'exited', id = 'container-1') {
  return {
    Id: id,
    Names: ['/approved-work'],
    Image: 'approved-image:1',
    State: state,
    Status: state === 'running' ? 'Up 1 minute' : 'Exited (0) 1 minute ago',
    Labels: labels,
  };
}

function loadConfig(extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'qg-target-control-'));
  const path = join(dir, 'bridge.yaml');
  writeFileSync(path, `discovery:\n  enabled: true\ntargets:\n  - id: approved\n    composeProject: approved-project\n    composeService: work\n    workspace: /workspace\n${extra}`);
  loadTargetConfig(path);
  invalidateCache();
}

beforeEach(() => {
  vi.clearAllMocks();
  loadConfig();
  docker.listContainers.mockResolvedValue([c('running')]);
  docker.inspectContainer.mockResolvedValue({ State: { Running: true, Status: 'running' }, Config: { Image: 'approved-image:1', Labels: labels } });
  docker.startContainer.mockResolvedValue(undefined);
  docker.stopContainer.mockResolvedValue(undefined);
  docker.restartContainer.mockResolvedValue(undefined);
  docker.getContainerLogs.mockResolvedValue({ stdout: 'hello', stderr: '', bytes: 5, truncated: false });
});

describe('bounded manual target lifecycle control', () => {
  it('resolves exactly one manually configured container without caller Docker identifiers', async () => {
    const target = await resolveTargetForControl('approved');
    expect(target.containerId).toBe('container-1');
    expect(target.source).toBe('manual');
    expect(target.workspace).toBe('/workspace');
  });

  it('fails closed when multiple containers match one manual target', async () => {
    docker.listContainers.mockResolvedValue([c('running', 'a'), c('exited', 'b')]);
    await expect(resolveTargetForControl('approved')).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' });
  });

  it('refuses discovery-only lifecycle control', async () => {
    docker.listContainers.mockResolvedValue([{
      ...c('running'),
      Labels: {
        'mcp.bridge.enabled': 'true',
        'mcp.bridge.workspace': '/workspace',
        'mcp.bridge.name': 'discovered-only',
      },
    }]);
    await expect(resolveTargetForControl('discovered-only')).rejects.toMatchObject({ code: 'TARGET_UNSUPPORTED' });
  });

  it('starts an existing stopped manual target and returns fresh state', async () => {
    docker.listContainers.mockResolvedValue([c('exited')]);
    docker.inspectContainer
      .mockResolvedValueOnce({ State: { Running: false, Status: 'exited' }, Config: { Image: 'approved-image:1', Labels: labels } })
      .mockResolvedValueOnce({ State: { Running: true, Status: 'running' }, Config: { Image: 'approved-image:1', Labels: labels } });
    const result = await controlTarget('approved', 'start');
    expect(docker.startContainer).toHaveBeenCalledWith('container-1');
    expect(result).toMatchObject({ ok: true, action: 'start', running: true, status: 'running' });
  });

  it('stops a running target and verifies the resulting stopped state', async () => {
    docker.inspectContainer
      .mockResolvedValueOnce({ State: { Running: true, Status: 'running' }, Config: { Image: 'approved-image:1', Labels: labels } })
      .mockResolvedValueOnce({ State: { Running: false, Status: 'exited' }, Config: { Image: 'approved-image:1', Labels: labels } });
    const result = await controlTarget('approved', 'stop');
    expect(docker.stopContainer).toHaveBeenCalledWith('container-1', 10);
    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, status: 'exited' });
  });

  it('stop is idempotent for an already stopped target', async () => {
    docker.listContainers.mockResolvedValue([c('exited')]);
    docker.inspectContainer.mockResolvedValue({ State: { Running: false, Status: 'exited' }, Config: { Image: 'approved-image:1', Labels: labels } });
    const result = await controlTarget('approved', 'stop');
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(result.running).toBe(false);
  });

  it('fails closed when Docker reports success but the requested final state is not reached', async () => {
    docker.listContainers.mockResolvedValue([c('exited')]);
    docker.inspectContainer
      .mockResolvedValueOnce({ State: { Running: false, Status: 'exited' }, Config: { Image: 'approved-image:1', Labels: labels } })
      .mockResolvedValueOnce({ State: { Running: false, Status: 'exited' }, Config: { Image: 'approved-image:1', Labels: labels } });
    await expect(controlTarget('approved', 'start')).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
  });

  it('restarts only a currently running target', async () => {
    const result = await controlTarget('approved', 'restart');
    expect(docker.restartContainer).toHaveBeenCalledWith('container-1', 10);
    expect(result.running).toBe(true);
  });

  it('restart refuses a stopped target instead of silently starting it', async () => {
    docker.listContainers.mockResolvedValue([c('exited')]);
    docker.inspectContainer.mockResolvedValue({ State: { Running: false, Status: 'exited' }, Config: { Image: 'approved-image:1', Labels: labels } });
    await expect(controlTarget('approved', 'restart')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(docker.restartContainer).not.toHaveBeenCalled();
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('reads only bounded logs for the configured target', async () => {
    const logs = await readTargetLogs('approved', 8192);
    expect(docker.getContainerLogs).toHaveBeenCalledWith('container-1', 8192);
    expect(logs).toEqual({ target: 'approved', stdout: 'hello', stderr: '', bytes: 5, truncated: false });
  });
});
