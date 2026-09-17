/**
 * A8 R1 — Kiro provider-session persistence contract.
 * Offline unit tests with a fully mocked Docker API: no daemon, network,
 * credentials, project mounts, or real provider process.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const docker = vi.hoisted(() => ({
  createNetwork: vi.fn(), removeNetwork: vi.fn(), connectNetwork: vi.fn(),
  createContainer: vi.fn(), startContainer: vi.fn(), waitContainer: vi.fn(),
  getContainerLogs: vi.fn(), inspectContainerFull: vi.fn(), killContainer: vi.fn(),
  removeContainer: vi.fn(), removeVolume: vi.fn(), createVolume: vi.fn(),
  listVolumesByFilter: vi.fn(), getArchive: vi.fn(), putArchive: vi.fn(),
}));
vi.mock('../../src/executor/docker.js', () => docker);

import {
  KiroBackend,
  providerSessionVolumeName,
  providerBindingHash,
  PROVIDER_BINDING_LABEL,
  type KiroBackendJobInput,
  type KiroBackendOptions,
} from '../../src/executor/agents/kiroBackend.js';
import { LABEL_MANAGED, LABEL_RESOURCE } from '../../src/executor/agents/sandboxSpec.js';
import type { CredentialManager } from '../../src/executor/agents/credentialManager.js';
import type { RunnerSandbox } from '../../src/executor/agents/sandboxRunner.js';

const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast', maxRuntimeMs: 60_000, maxCpuMillicores: 1000,
  maxMemoryBytes: 1_073_741_824, maxPids: 128, maxOutputBytes: 65_536,
  maxEvidenceBytes: 1_048_576, networkPolicy: 'backend-only', retentionClass: 'short',
};

function job(overrides: Partial<KiroBackendJobInput> = {}): KiroBackendJobInput {
  return {
    jobId: `job_${'1'.repeat(32)}`,
    principalId: 'principal-alice', backend: 'kiro', project: 'proj-a', profile: 'audit',
    prompt: 'test', hostPath: '/trusted/proj-a', policy, model: 'claude-sonnet-4',
    ...overrides,
  };
}
function opts(): KiroBackendOptions {
  return {
    runnerImage: 'runner:test', helperImage: 'helper:test', proxyImage: 'proxy:test',
    proxyCmd: ['node', 'proxy.js'],
    credentialManager: {} as CredentialManager,
    sandbox: {} as RunnerSandbox,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  docker.createVolume.mockResolvedValue(undefined);
  docker.removeVolume.mockResolvedValue(undefined);
  docker.killContainer.mockResolvedValue(undefined);
  docker.removeContainer.mockResolvedValue(undefined);
  docker.removeNetwork.mockResolvedValue(undefined);
});

describe('A8 R1 Kiro provider state persistence', () => {
  it('fresh session gets a dedicated managed volume bound to the trusted 4-tuple', async () => {
    const input = job();
    const backend = new KiroBackend(input, opts());
    await (backend as any).provisionProviderSessionState();
    const expected = providerSessionVolumeName(input.jobId);
    expect(docker.createVolume).toHaveBeenCalledWith(expected, expect.objectContaining({
      [LABEL_MANAGED]: 'true',
      [LABEL_RESOURCE]: 'provider-session',
      [PROVIDER_BINDING_LABEL]: providerBindingHash(input),
    }));
    expect((backend as any).providerStateVolume).toBe(expected);
  });

  it('ACTIVE successor handoff preserves provider state during ordinary cleanup', async () => {
    const input = job();
    const backend = new KiroBackend(input, opts());
    await (backend as any).provisionProviderSessionState();
    const stateVolume = (backend as any).providerStateVolume as string;
    (backend as any).providerStateHandedOff = true;
    await backend.cleanup();
    expect(docker.removeVolume).not.toHaveBeenCalledWith(stateVolume, true);
    expect((backend as any).providerStateVolume).toBe(stateVolume);
  });

  it('failed fresh session removes unhanded provider state during cleanup', async () => {
    const input = job();
    const backend = new KiroBackend(input, opts());
    await (backend as any).provisionProviderSessionState();
    const stateVolume = (backend as any).providerStateVolume as string;
    await backend.cleanup();
    expect(docker.removeVolume).toHaveBeenCalledWith(stateVolume, true);
  });

  it('ambiguous provider-state invalidation fails closed and retains the handle when removal is unverified', async () => {
    const backend = new KiroBackend(job({
      providerSessionId: 'provider-session', providerStateVolume: 'state-volume',
    }), opts());
    docker.removeVolume.mockRejectedValueOnce(new Error('sensitive daemon detail'));

    await expect(backend.discardSessionState()).rejects.toThrow();
    expect(docker.removeVolume).toHaveBeenCalledWith('state-volume', true);
    expect((backend as any).providerStateVolume).toBe('state-volume');
    expect((backend as any).providerStateHandedOff).toBe(false);
  });


  it('ODR-2 rejects mutating source drift immediately after trusted staging and before credential/provider-state restore', async () => {
    const provisionSecret = vi.fn().mockResolvedValue('secret-volume');
    const sandbox = {
      stageWorkspace: vi.fn().mockResolvedValue({ volumeName: 'workspace-volume', baseCommit: 'b'.repeat(40) }),
      disposeWorkspace: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunnerSandbox;
    const credentialManager = {
      provisionSecret,
      revokeSecret: vi.fn().mockResolvedValue(undefined),
    } as unknown as CredentialManager;
    const backend = new KiroBackend(job({
      profile: 'implement',
      providerSessionId: 'provider-session',
      providerStateVolume: 'state-volume',
      sessionSourceRevision: 'a'.repeat(40),
    }), { ...opts(), sandbox, credentialManager });

    await expect(backend.prepare(new AbortController().signal))
      .rejects.toMatchObject({ code: 'SESSION_NOT_RESUMABLE' });
    expect((sandbox as any).stageWorkspace).toHaveBeenCalledTimes(1);
    expect(provisionSecret).not.toHaveBeenCalled();
    expect(docker.listVolumesByFilter).not.toHaveBeenCalled();
    expect((sandbox as any).disposeWorkspace).toHaveBeenCalledWith('workspace-volume');
  });

  it('ODR-2 permits read-only drift as context-only continuity after fresh staging', async () => {
    const credentialBoundary = new Error('credential-boundary');
    const provisionSecret = vi.fn().mockRejectedValue(credentialBoundary);
    const sandbox = {
      stageWorkspace: vi.fn().mockResolvedValue({ volumeName: 'workspace-volume', baseCommit: 'b'.repeat(40) }),
      disposeWorkspace: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunnerSandbox;
    const credentialManager = {
      provisionSecret,
      revokeSecret: vi.fn().mockResolvedValue(undefined),
    } as unknown as CredentialManager;
    const backend = new KiroBackend(job({
      profile: 'audit',
      providerSessionId: 'provider-session',
      providerStateVolume: 'state-volume',
      sessionSourceRevision: 'a'.repeat(40),
    }), { ...opts(), sandbox, credentialManager });

    await expect(backend.prepare(new AbortController().signal)).rejects.toBe(credentialBoundary);
    expect(provisionSecret).toHaveBeenCalledTimes(1);
    expect(docker.listVolumesByFilter).not.toHaveBeenCalled();
    expect((sandbox as any).disposeWorkspace).toHaveBeenCalledWith('workspace-volume');
  });

  it('database state ref with missing Docker volume fails closed', async () => {
    docker.listVolumesByFilter.mockResolvedValue([]);
    const backend = new KiroBackend(job({
      providerSessionId: 'provider-session', providerStateVolume: 'missing-state-volume',
    }), opts());
    await expect((backend as any).provisionProviderSessionState())
      .rejects.toMatchObject({ code: 'SESSION_NOT_RESUMABLE' });
  });

  it('state volume bound to another principal/project/profile fails closed even if name matches', async () => {
    const input = job({ providerSessionId: 'provider-session', providerStateVolume: 'state-volume' });
    docker.listVolumesByFilter.mockResolvedValue([{
      Name: 'state-volume',
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_RESOURCE]: 'provider-session',
        [PROVIDER_BINDING_LABEL]: providerBindingHash(job({ principalId: 'principal-bob' })),
      },
    }]);
    const backend = new KiroBackend(input, opts());
    await expect((backend as any).provisionProviderSessionState())
      .rejects.toMatchObject({ code: 'SESSION_NOT_RESUMABLE' });
  });

  it('correctly bound existing state volume is reused without creating a new volume', async () => {
    const input = job({ providerSessionId: 'provider-session', providerStateVolume: 'state-volume' });
    docker.listVolumesByFilter.mockResolvedValue([{
      Name: 'state-volume',
      Labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_RESOURCE]: 'provider-session',
        [PROVIDER_BINDING_LABEL]: providerBindingHash(input),
      },
    }]);
    const backend = new KiroBackend(input, opts());
    await (backend as any).provisionProviderSessionState();
    expect(docker.createVolume).not.toHaveBeenCalled();
    expect((backend as any).providerStateVolume).toBe('state-volume');
  });
});
