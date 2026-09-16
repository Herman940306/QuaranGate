import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCopilotStartupPolicy } from '../../src/executor/copilotConfig.js';
import {
  assertCopilotReadonlyResult,
  assertCopilotRunnerExecution,
  buildCopilotRunnerCreateBody,
  CopilotBackend,
  copilotProxyContainerName,
  copilotRunnerContainerName,
  parseCopilotRunnerResult,
} from '../../src/executor/agents/copilotBackend.js';
import { buildCopilotAcpArgs, COPILOT_RESULT_MARKER, runCopilotAcpJob } from '../../src/executor/agents/copilotRunnerMain.js';
import { CopilotCredentialManager } from '../../src/executor/agents/copilotCredentialManager.js';
import { createCopilotBackendFactory } from '../../src/executor/agents/copilotFactory.js';
import { composeRuntimeBackendFactories } from '../../src/executor/agents/backendFactoryChain.js';
import { AgentJobEngine } from '../../src/executor/agents/jobEngine.js';
import { AgentJobStore, type AgentJobRow } from '../../src/executor/agents/jobStore.js';
import type { AgentControlPlaneConfig } from '../../src/executor/agentConfig.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';
import { authorizeAgentTool } from '../../src/gateway/agentAuthz.js';

const dockerMocks = vi.hoisted(() => ({
  removeVolume: vi.fn(),
  removeContainer: vi.fn(async () => {}),
  killContainer: vi.fn(async () => {}),
}));
vi.mock('../../src/executor/docker.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/executor/docker.js')>(),
  removeVolume: dockerMocks.removeVolume,
  removeContainer: dockerMocks.removeContainer,
  killContainer: dockerMocks.killContainer,
}));

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mockAcp = join(root, 'tests', 'fixtures', 'mock-acp-server.mjs');
const jobId = `job_${'7'.repeat(32)}`;
const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast', maxRuntimeMs: 10_000,
  maxCpuMillicores: 1000, maxMemoryBytes: 256 * 1024 * 1024, maxPids: 64,
  maxOutputBytes: 65_536, maxEvidenceBytes: 1_048_576,
  networkPolicy: 'backend-only', retentionClass: 'ephemeral',
};

function startup(overrides: Record<string, string | undefined> = {}) {
  return {
    runnerImage: 'copilot-runner:1.0.56',
    helperImage: 'quarangate-helper:a7',
    proxyImage: 'quarangate-proxy:a7',
    credentialPath: '/run/secrets/copilot',
    model: 'gpt-5.4',
    egressHosts: 'api.github.com,copilot-proxy.githubusercontent.com',
    ...overrides,
  };
}

function createBody() {
  return buildCopilotRunnerCreateBody({
    jobId, image: 'sha256:runner', workspaceVolume: 'ws', secretVolume: 'secret',
    homeVolume: 'home', controlVolume: 'control', internalNetwork: 'internal',
    proxyUrl: 'http://egress-proxy:8080', memoryBytes: 1024, nanoCpus: 1000,
    pidsLimit: 32,
  });
}

describe('A7 startup/config fail-closed policy', () => {
  it('A7-C1 disabled Copilot requires no runtime authority', () => {
    expect(resolveCopilotStartupPolicy(false, ['audit'], {})).toEqual({ enabled: false });
  });

  it.each([
    'runnerImage', 'helperImage', 'proxyImage', 'credentialPath', 'model', 'egressHosts',
  ])('A7-C2 enabled Copilot rejects missing %s', (field) => {
    expect(() => resolveCopilotStartupPolicy(true, ['audit'], startup({ [field]: '' }))).toThrow();
  });

  it('rejects mutable images, wildcard egress, host-like model args, and implement profile', () => {
    expect(() => resolveCopilotStartupPolicy(true, ['audit'], startup({ runnerImage: 'copilot:latest' }))).toThrow(/latest/i);
    expect(() => resolveCopilotStartupPolicy(true, ['audit'], startup({ runnerImage: 'registry:5000/copilot' }))).toThrow(/implicit|latest/i);
    expect(() => resolveCopilotStartupPolicy(true, ['audit'], startup({ egressHosts: '*.githubcopilot.com' }))).toThrow(/exact hostname/);
    expect(() => resolveCopilotStartupPolicy(true, ['audit'], startup({ model: '--allow-all' }))).toThrow(/model/i);
    expect(() => resolveCopilotStartupPolicy(true, ['implement'], startup())).toThrow(/does not support profile implement/);
  });
});

describe('A7 provider argv and runner boundary', () => {
  it('uses official stdio ACP with fixed read-only capability controls', () => {
    const args = buildCopilotAcpArgs('gpt-5.4');
    expect(args).toContain('--acp');
    expect(args).toContain('--stdio');
    expect(args).toContain('--available-tools=view,grep,glob');
    expect(args).toContain('--deny-tool=write');
    expect(args).toContain('--deny-tool=shell');
    expect(args).toContain('--disable-builtin-mcps');
    expect(args).toContain('--no-remote');
    expect(args).toContain('--no-remote-export');
    expect(args).not.toContain('--allow-all');
    expect(args).not.toContain('--allow-all-paths');
    expect(args).not.toContain('--allow-all-urls');
  });

  it('A7-C7/C8/C13/C14/C15 uses RO volume-only workspace and no socket/host path/credential env', () => {
    const body = createBody() as any;
    const serialized = JSON.stringify(body);
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.CapDrop).toEqual(['ALL']);
    expect(body.HostConfig.NetworkMode).toBe('internal');
    expect(body.HostConfig.Mounts.every((mount: any) => mount.Type === 'volume')).toBe(true);
    expect(body.HostConfig.Mounts.find((mount: any) => mount.Target === '/workspace').ReadOnly).toBe(true);
    expect(serialized).not.toContain('docker.sock');
    expect(serialized).not.toContain('/home/herman');
    expect(serialized).not.toContain('COPILOT_GITHUB_TOKEN=');
  });

  it('A7-C16/C17 gives every job a distinct managed runner identity', () => {
    expect(copilotRunnerContainerName(jobId)).not.toBe(copilotRunnerContainerName(`job_${'8'.repeat(32)}`));
  });

  it('A7-C18/C19 rejects crash/partial/spoofed output and accepts only one normalized result frame', () => {
    expect(parseCopilotRunnerResult('partial provider output')).toBeNull();
    expect(parseCopilotRunnerResult(`${COPILOT_RESULT_MARKER}{bad`)).toBeNull();
    const good = `${COPILOT_RESULT_MARKER}${JSON.stringify({
      ok: true, dryRun: false, toolCalls: [], assistantText: 'bounded', stopReason: 'end_turn', refusedRequestCount: 0,
    })}\n`;
    expect(parseCopilotRunnerResult(good)?.ok).toBe(true);
    expect(parseCopilotRunnerResult(`noise\n${good}`)).toBeNull();
    expect(parseCopilotRunnerResult(`${good}${good}`)).toBeNull();
    expect(parseCopilotRunnerResult(`${COPILOT_RESULT_MARKER}${JSON.stringify({
      ok: true, dryRun: false, toolCalls: [], assistantText: 'bounded', stopReason: 'end_turn', refusedRequestCount: 0, authority: 'admin',
    })}\n`)).toBeNull();
  });

  it('rejects non-zero container exit even when stdout contains an ok marker', () => {
    const stdout = `${COPILOT_RESULT_MARKER}${JSON.stringify({
      ok: true, dryRun: false, toolCalls: [], assistantText: 'looks valid', stopReason: 'end_turn', refusedRequestCount: 0,
    })}\n`;
    expect(() => assertCopilotRunnerExecution(
      { statusCode: 17, timedOut: false }, { stdout, truncated: false },
    )).toThrow(/exited unsuccessfully/i);
  });

  it('rejects privileged ACP request attempts even when the provider later finishes', () => {
    expect(() => assertCopilotReadonlyResult({
      ok: true, dryRun: false, toolCalls: [], assistantText: 'done', stopReason: 'end_turn', refusedRequestCount: 1,
    })).toThrow(/privileged ACP client request/i);
  });

  it('rejects incomplete or empty non-dry-run provider completion', () => {
    expect(() => assertCopilotReadonlyResult({
      ok: true, dryRun: false, toolCalls: [], assistantText: 'partial', stopReason: 'max_tokens', refusedRequestCount: 0,
    })).toThrow(/did not complete normally/i);
    expect(() => assertCopilotReadonlyResult({
      ok: true, dryRun: false, toolCalls: [], assistantText: '   ', stopReason: 'end_turn', refusedRequestCount: 0,
    })).toThrow(/usable assistant response/i);
  });

  it('rejects malformed aggregate tool counts and oversized assistant data at the result boundary', () => {
    const malformed = `${COPILOT_RESULT_MARKER}${JSON.stringify({
      ok: true, dryRun: false, toolCalls: [{ kind: 'read', count: 0 }], assistantText: 'x', stopReason: 'end_turn', refusedRequestCount: 0,
    })}\n`;
    expect(parseCopilotRunnerResult(malformed)).toBeNull();
    const oversized = `${COPILOT_RESULT_MARKER}${JSON.stringify({
      ok: true, dryRun: false, toolCalls: [], assistantText: 'x'.repeat(16 * 1024 + 1), stopReason: 'end_turn', refusedRequestCount: 0,
    })}\n`;
    expect(parseCopilotRunnerResult(oversized)).toBeNull();
  });

  it('drives deterministic ACP without provider and emits bounded public data', async () => {
    const result = await runCopilotAcpJob({
      model: 'gpt-5.4', cwd: root, prompt: 'A7-MOCK', dryRun: false,
      maxAssistantBytes: 10, acpCommand: process.execPath, acpPrefixArgs: [mockAcp],
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.assistantText).toBe('MARKER:A7-');
    expect(result.toolCalls).toEqual([{ kind: 'read', status: 'completed', count: 1 }]);
  });

  it('A7-C12 provider failure omits raw stderr/protocol/credential', async () => {
    const marker = 'github_pat_NEVER_RETURN_THIS_A7';
    const previous = process.env.COPILOT_GITHUB_TOKEN;
    process.env.COPILOT_GITHUB_TOKEN = marker;
    try {
      const result = await runCopilotAcpJob({
        model: 'gpt-5.4', cwd: root, prompt: marker, dryRun: false,
        acpCommand: '/nonexistent/copilot-a7',
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(result.error).toBe('Copilot ACP initialize failed');
    } finally {
      if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
      else process.env.COPILOT_GITHUB_TOKEN = previous;
    }
  });

  it('A7-C16 timeout closes bounded ACP subprocess', async () => {
    const started = Date.now();
    const result = await runCopilotAcpJob({
      model: 'gpt-5.4', cwd: root, prompt: 'SLOW', dryRun: false,
      promptTimeoutMs: 20, acpCommand: process.execPath, acpPrefixArgs: [mockAcp],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Copilot ACP prompt failed');
    expect(Date.now() - started).toBeLessThan(6_000);
  });
});

describe('A7 authorization remains client/profile-owned', () => {
  const principal = {
    id: 'client', name: 'Client', keyHash: 'a'.repeat(64), enabled: true,
    scopes: ['agents:dispatch'], targets: [], projects: ['p'],
    agentBackends: ['copilot'], agentProfiles: ['audit'],
  } as any;

  it('A7-C5 missing dispatch scope denies Copilot', () => {
    expect(authorizeAgentTool({
      tool: 'agent_dispatch', principal: { ...principal, scopes: [] },
      project: 'p', backend: 'copilot', profile: 'audit',
    })).toMatchObject({ allowed: false, code: 'FORBIDDEN_SCOPE' });
  });

  it('A7-C6 backend selection cannot upgrade profile grant', () => {
    expect(authorizeAgentTool({
      tool: 'agent_dispatch', principal, project: 'p', backend: 'copilot', profile: 'implement',
    })).toMatchObject({ allowed: false, code: 'FORBIDDEN_PROFILE' });
  });
});

describe('A7 credential and factory boundaries', () => {
  afterEach(() => {
    dockerMocks.removeVolume.mockReset();
    dockerMocks.removeContainer.mockClear();
    dockerMocks.killContainer.mockClear();
  });

  it('A7-C10/C11 missing credential fails without value disclosure', () => {
    const manager = new CopilotCredentialManager({ credentialPath: '/definitely/missing/copilot', helperImage: 'helper:a7' });
    expect(() => manager.verifyCredentialFile()).toThrow('Copilot credential file not found');
  });

  it('re-reads credential bytes for every use so rotation/revocation takes effect without restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-a7-rotate-'));
    const path = join(dir, 'token');
    writeFileSync(path, 'github_pat_FIRST_ROTATED_TOKEN', { mode: 0o600 });
    const manager = new CopilotCredentialManager({ credentialPath: path, helperImage: 'helper:a7' });
    expect((manager as any).readToken()).toBe('github_pat_FIRST_ROTATED_TOKEN');
    writeFileSync(path, 'github_pat_SECOND_ROTATED_TOKEN', { mode: 0o600 });
    expect((manager as any).readToken()).toBe('github_pat_SECOND_ROTATED_TOKEN');
  });

  it('rejects permissive credential metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-a7-'));
    const path = join(dir, 'token');
    writeFileSync(path, 'github_pat_not_a_real_token');
    chmodSync(path, 0o644);
    const manager = new CopilotCredentialManager({ credentialPath: path, helperImage: 'helper:a7' });
    expect(() => manager.verifyCredentialFile()).toThrow(/unsafe permissions/);
  });

  it('rejects a credential symlink before reading secret bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-a7-link-'));
    const target = join(dir, 'target');
    const path = join(dir, 'token');
    writeFileSync(target, 'github_pat_not_a_real_token', { mode: 0o600 });
    symlinkSync(target, path);
    const manager = new CopilotCredentialManager({ credentialPath: path, helperImage: 'helper:a7' });
    expect(() => manager.verifyCredentialFile()).toThrow(/not a regular file/);
  });

  it('retries secret revocation and exposes no Docker error detail', async () => {
    const manager = new CopilotCredentialManager({ credentialPath: '/unused', helperImage: 'helper:a7' });
    dockerMocks.removeVolume.mockRejectedValue(new Error('sensitive daemon detail'));
    await expect(manager.revokeSecret(jobId)).rejects.toThrow('Copilot credential volume revocation failed after 3 attempts: Error');
    expect(dockerMocks.removeVolume).toHaveBeenCalledTimes(3);
    await expect(manager.revokeSecret(jobId)).rejects.not.toThrow('sensitive daemon detail');
  });

  it('A7-C3/C4 factory selects only Copilot and never Kiro/Ollama', () => {
    const deps = {
      runnerImage: 'sha256:r', helperImage: 'sha256:h', proxyImage: 'sha256:p', proxyCmd: ['node'],
      egressHosts: ['api.github.com'], credentialManager: {} as any, sandbox: {} as any,
    };
    const factory = createCopilotBackendFactory([{ id: 'p', hostPath: '/trusted/p' }], 'gpt-5.4', deps);
    const row = (backend: string) => ({
      jobId, principalId: 'owner', backend, project: 'p', profile: 'audit', prompt: 'x',
    } as AgentJobRow);
    expect(factory(row('kiro'), policy)).toBeNull();
    expect(factory(row('ollama'), policy)).toBeNull();
    expect(factory(row('copilot'), policy)).toBeInstanceOf(CopilotBackend);
  });

  it('attempts deterministic runner and proxy name cleanup when create returned no container id', async () => {
    dockerMocks.removeContainer.mockResolvedValue(undefined);
    dockerMocks.killContainer.mockResolvedValue(undefined);
    const backend = new CopilotBackend({
      jobId, principalId: 'owner', backend: 'copilot', project: 'p', profile: 'audit',
      prompt: 'x', hostPath: '/trusted/p', policy, model: 'gpt-5.4',
    }, {
      runnerImage: 'sha256:r', helperImage: 'sha256:h', proxyImage: 'sha256:p', proxyCmd: ['node'],
      egressHosts: ['api.github.com'], credentialManager: {} as any, sandbox: {} as any,
    });
    await backend.cleanup();
    expect(dockerMocks.removeContainer).toHaveBeenCalledWith(copilotRunnerContainerName(jobId), true);
    expect(dockerMocks.removeContainer).toHaveBeenCalledWith(copilotProxyContainerName(jobId), true);
  });

  it('rejects tracked symlinks before provisioning a Copilot secret', async () => {
    let stageRequest: any;
    const backend = new CopilotBackend({
      jobId, principalId: 'owner', backend: 'copilot', project: 'p', profile: 'audit',
      prompt: 'x', hostPath: '/trusted/p', policy, model: 'gpt-5.4',
    }, {
      runnerImage: 'sha256:r', helperImage: 'sha256:h', proxyImage: 'sha256:p', proxyCmd: ['node'],
      egressHosts: ['api.github.com'],
      credentialManager: { provisionSecret: async () => { throw new Error('stop'); } } as any,
      sandbox: {
        stageWorkspace: async (request: any) => {
          stageRequest = request;
          return { volumeName: 'ws', baseCommit: 'a'.repeat(40) };
        },
        disposeWorkspace: async () => {},
      } as any,
    });
    await expect(backend.prepare(new AbortController().signal)).rejects.toThrow('stop');
    expect(stageRequest.rejectTrackedSymlinks).toBe(true);
  });
});

describe('A7 current-line integration contracts', () => {
  it('uses long-form executor-only Compose secret permissions and exact path', () => {
    const composeText = readFileSync(join(root, 'compose.copilot.yaml'), 'utf8');
    const compose = YAML.parse(composeText) as any;
    expect(compose.services.executor.environment.AGENT_COPILOT_KEY_PATH).toBe('/run/secrets/copilot-github-token');
    expect(compose.services.executor.secrets).toEqual([{
      source: 'copilot_github_token', target: 'copilot-github-token', uid: '1000', gid: '1000', mode: 400,
    }]);
    expect(composeText).toContain('mode: 0400');
    expect(String(compose.secrets.copilot_github_token.file)).toContain('AGENT_COPILOT_KEY_FILE');
  });

  it('forwards the exact A8 session context through composed backend factories', () => {
    const session = {
      sessionId: `sess_${'1'.repeat(32)}`,
      providerSessionId: 'provider-session',
      providerStateRef: 'io-quarangate-provider-state',
    };
    const seen: unknown[] = [];
    const backend = { prepare: async () => {}, run: async () => {}, validate: async () => ({ summary: 'x', exitCode: 0 }), isAgentFailure: () => false, isDryRun: () => false } as any;
    const first = vi.fn((_job, _policy, received) => { seen.push(received); return null; });
    const second = vi.fn((_job, _policy, received) => { seen.push(received); return backend; });
    const composed = composeRuntimeBackendFactories([first, second]);
    const row = { jobId, backend: 'kiro', project: 'p', profile: 'audit' } as AgentJobRow;
    expect(composed(row, policy, session)).toBe(backend);
    expect(seen).toEqual([session, session]);
  });

  it('refuses Copilot resume context until provider restoration is explicitly qualified', () => {
    const deps = {
      runnerImage: 'sha256:r', helperImage: 'sha256:h', proxyImage: 'sha256:p', proxyCmd: ['node'],
      egressHosts: ['api.github.com'], credentialManager: {} as any, sandbox: {} as any,
    };
    const factory = createCopilotBackendFactory([{ id: 'p', hostPath: '/trusted/p' }], 'gpt-5.4', deps);
    const row = { jobId, backend: 'copilot', project: 'p', profile: 'audit', prompt: 'x' } as AgentJobRow;
    expect(() => factory(row, policy, {
      sessionId: `sess_${'2'.repeat(32)}`,
      providerSessionId: 'unqualified-provider-session',
      providerStateRef: null,
    })).toThrow(/not qualified/i);
  });
});

describe('A7 engine registration and no-fallback', () => {
  let store: AgentJobStore | undefined;
  afterEach(() => { try { store?.close(); } catch {} });

  function config(): AgentControlPlaneConfig {
    return {
      backends: [{ id: 'copilot', enabled: true, profiles: ['audit'], defaultResourcePolicy: 'economy' }],
      projects: [{ id: 'p', hostPath: '/trusted/p', gitRequired: true, backends: ['copilot'], profiles: ['audit'], guardedPaths: [], sensitiveReadGlobs: [] }],
      profiles: [{ id: 'audit', workspaceAccess: 'read-only', shellPolicy: 'none', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'economy' }],
      resourcePolicies: [policy],
    };
  }

  it('A7-C3/C4 requested Copilot never falls back to fake backend', async () => {
    store = new AgentJobStore(join(mkdtempSync(join(tmpdir(), 'qg-a7-engine-')), 'agents.db'));
    const engine = new AgentJobEngine(
      store, config(), undefined, undefined, undefined, undefined, undefined,
      new Set(['copilot']),
    );
    const job = engine.dispatch({ principal: 'owner', backend: 'copilot', project: 'p', profile: 'audit', prompt: 'x' });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !store.get(job.jobId)!.status.startsWith('FAILED')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(store.get(job.jobId)?.status).toBe('FAILED_PRECONDITION');
    expect(store.get(job.jobId)?.summary ?? '').not.toContain('Fake backend');
    engine.shutdown();
  });

  it('MCP availability follows trusted runtime set, not schema membership', () => {
    store = new AgentJobStore(join(mkdtempSync(join(tmpdir(), 'qg-a7-list-')), 'agents.db'));
    const unavailable = new AgentJobEngine(store, config(), undefined, undefined, undefined, undefined, undefined, new Set());
    expect(unavailable.listBackends()).toEqual([{ id: 'copilot', available: false, profiles: ['audit'] }]);
    unavailable.shutdown();
  });
});
