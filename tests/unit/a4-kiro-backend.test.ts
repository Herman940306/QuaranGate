/**
 * A4 Kiro backend tests — profile enforcement, per-job agent identity, model
 * mapping, and the hardened `docker run` argv (constructed from trusted policy
 * only; no caller-controlled Docker fields).
 */
import { describe, it, expect } from 'vitest';
import {
  KiroBackend, buildRunnerCreateBody, resolveModel, bridgeAgentConfig, parseRunnerResult,
  type KiroBackendJobInput, type KiroBackendOptions,
} from '../../src/executor/agents/kiroBackend.js';
import { CredentialManager } from '../../src/executor/agents/credentialManager.js';
import { RunnerSandbox } from '../../src/executor/agents/sandboxRunner.js';
import { ACP_AGENT_NAME_PATTERN } from '../../src/executor/agents/acpDriver.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const testPolicy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast', maxRuntimeMs: 600_000, maxCpuMillicores: 1000,
  maxMemoryBytes: 1_073_741_824, maxPids: 128, maxOutputBytes: 262_144,
  maxEvidenceBytes: 10_485_760, networkPolicy: 'backend-only', retentionClass: 'ephemeral',
};

function makeJob(overrides: Partial<KiroBackendJobInput> = {}): KiroBackendJobInput {
  return {
    jobId: 'job_' + '0'.repeat(32), backend: 'kiro', project: 'test-project',
    profile: 'audit', prompt: 'Analyze the codebase.', hostPath: '/tmp/test-project',
    policy: testPolicy, model: 'claude-haiku-4.5', ...overrides,
  };
}

function makeOpts(): KiroBackendOptions {
  return {
    runnerImage: 'mcp-ide-bridge-kiro-runner:test',
    helperImage: 'alpine',
    proxyImage: 'node:24-alpine',
    proxyCmd: ['node', '/app/dist/executor/agents/egressProxyMain.js'],
    credentialManager: {} as unknown as CredentialManager,
    sandbox: {} as unknown as RunnerSandbox,
  };
}

describe('KiroBackend — profile enforcement', () => {
  for (const p of ['audit', 'plan', 'review'] as const) {
    it(`allows construction with ${p}`, () => {
      expect(() => new KiroBackend(makeJob({ profile: p }), makeOpts())).not.toThrow();
    });
  }
  it('DENIES implement (write capability — A5)', () => {
    expect(() => new KiroBackend(makeJob({ profile: 'implement' }), makeOpts())).toThrow(/write capability/);
    try { new KiroBackend(makeJob({ profile: 'implement' }), makeOpts()); } catch (e: any) {
      expect(e.code).toBe('FORBIDDEN_PROFILE');
      expect(e.httpStatus).toBe(403);
    }
  });
});

describe('KiroBackend — identity + interface', () => {
  it('assigns an unguessable per-job agent name', () => {
    const b = new KiroBackend(makeJob(), makeOpts());
    expect(ACP_AGENT_NAME_PATTERN.test(b.getAgentName())).toBe(true);
    const b2 = new KiroBackend(makeJob(), makeOpts());
    expect(b.getAgentName()).not.toBe(b2.getAgentName());
  });

  it('exposes prepare/run/validate/isAgentFailure/cleanup', () => {
    const b = new KiroBackend(makeJob(), makeOpts());
    for (const m of ['prepare', 'run', 'validate', 'isAgentFailure', 'cleanup'] as const) {
      expect(typeof (b as any)[m]).toBe('function');
    }
  });
});

describe('model class mapping', () => {
  it('maps to models ADVERTISED by Kiro 2.5.0 session/new (never haiku)', () => {
    // availableModels observed live: claude-sonnet-4, claude-sonnet-4.5.
    expect(resolveModel('fast')).toBe('claude-sonnet-4');
    expect(resolveModel('standard')).toBe('claude-sonnet-4.5');
    expect(resolveModel('deep')).toBe('claude-sonnet-4.5');
    expect(resolveModel('unknown')).toBe('claude-sonnet-4');
    for (const c of ['fast', 'standard', 'deep', 'unknown']) {
      expect(resolveModel(c)).not.toContain('haiku');
    }
  });
});

describe('bridgeAgentConfig capability lock', () => {
  it('is read-only with no MCP/hooks/wildcard/model', () => {
    const c = bridgeAgentConfig('mcp_ro_' + 'a'.repeat(32));
    expect(c.tools).toEqual(['read', 'grep', 'glob']);
    expect(c.mcpServers).toEqual({});
    expect(c.includeMcpJson).toBe(false);
    expect(c.hooks).toEqual({});
    expect(c.model).toBeNull();
  });
});

describe('buildRunnerCreateBody — hardened Docker Engine API body (no CLI)', () => {
  const body = buildRunnerCreateBody({
    jobId: 'job_' + '0'.repeat(32),
    image: 'mcp-ide-bridge-kiro-runner:test',
    workspaceVolume: 'ws-vol', secretVolume: 'sec-vol', homeVolume: 'home-vol',
    controlVolume: 'ctl-vol',
    internalNetwork: 'jobnet-int', proxyUrl: 'http://egress-proxy:8080',
    memoryBytes: 1_073_741_824, nanoCpus: 1_000_000_000, pidsLimit: 128,
  }) as any;
  const hc = body.HostConfig;
  const env: string[] = body.Env;
  const mounts = hc.Mounts as { Source: string; Target: string; ReadOnly: boolean }[];
  const mount = (target: string) => mounts.find((m) => m.Target === target)!;

  it('is non-root, non-privileged, cap-drop ALL, no-new-privileges, read-only rootfs', () => {
    expect(body.User).toBe('1000:1000');
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Privileged).toBe(false);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.SecurityOpt).toContain('no-new-privileges');
  });

  it('never shares host namespaces or devices', () => {
    expect(hc.PidMode).toBe('');
    expect(hc.IpcMode).toBe('private');
    expect(hc.Devices).toEqual([]);
    expect(hc.CapAdd).toEqual([]);
  });

  it('mounts workspace READ-ONLY, secret READ-ONLY, control READ-ONLY, home read-write', () => {
    expect(mount('/workspace')).toMatchObject({ Source: 'ws-vol', ReadOnly: true });
    expect(mount('/run/secrets')).toMatchObject({ Source: 'sec-vol', ReadOnly: true });
    expect(mount('/run/control')).toMatchObject({ Source: 'ctl-vol', ReadOnly: true });
    expect(mount('/home/runner')).toMatchObject({ Source: 'home-vol', ReadOnly: false });
  });

  it('uses the internal job network and the egress proxy (backend-only)', () => {
    expect(hc.NetworkMode).toBe('jobnet-int');
    expect(env).toContain('HTTPS_PROXY=http://egress-proxy:8080');
    expect(env).toContain('ALL_PROXY=http://egress-proxy:8080');
  });

  it('does NOT place the API key in Env and does not trust all tools', () => {
    const joined = JSON.stringify(body);
    expect(joined).not.toContain('KIRO_API_KEY');
    expect(joined).not.toContain('--trust-all-tools');
    expect(joined).not.toContain('--yolo');
    expect(joined).not.toContain('/var/run/docker.sock');
  });

  it('carries ownership labels + isolates HOME/KIRO_HOME/XDG', () => {
    expect(body.Labels['io.mcp-ide-bridge.managed']).toBe('true');
    expect(body.Labels['io.mcp-ide-bridge.resource']).toBe('runner');
    expect(env).toContain('HOME=/home/runner');
    expect(env).toContain('KIRO_HOME=/home/runner/.kiro');
    expect(env).toContain('XDG_STATE_HOME=/home/runner/.local/state');
  });

  it('applies memory + pids + cpu limits and runs the runner-internal driver (node), NOT an attached CLI', () => {
    expect(hc.Memory).toBe(1_073_741_824);
    expect(hc.PidsLimit).toBe(128);
    expect(hc.NanoCpus).toBe(1_000_000_000);
    // The container command is the runner-internal ACP driver, not `kiro-cli`
    // driven over an interactive docker attach.
    expect(body.Cmd).toEqual(['node', '/run/control/executor/agents/runnerMain.js', '/run/control/control.json']);
    expect(body.Cmd).not.toContain('kiro-cli');
    expect(body.Cmd).not.toContain('acp');
  });
});

describe('parseRunnerResult — bounded result-line extraction', () => {
  it('parses the last __ACP_RESULT__ line and ignores other stdout', () => {
    const stdout = 'noise line\n__ACP_RESULT__{"ok":true,"dryRun":true,"toolCalls":[],'
      + '"assistantText":"","stopReason":"dry_run","refusedRequestCount":0,"sessionId":"s1"}\n';
    const r = parseRunnerResult(stdout);
    expect(r?.ok).toBe(true);
    expect(r?.sessionId).toBe('s1');
    expect(r?.stopReason).toBe('dry_run');
  });

  it('returns null when no result marker is present', () => {
    expect(parseRunnerResult('just some logs\n')).toBeNull();
  });
});
