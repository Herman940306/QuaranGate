/**
 * A5 implement-profile policy tests.
 *
 * Proves the trusted, code-only capability separation that A5 introduces:
 *   - audit/plan/review keep the EXACT A4 read-only capability,
 *   - implement (and only implement) gains a writable workspace + the single
 *     fsWrite mutation tool under a distinct unguessable mcp_impl_ identity,
 *   - no lane grants shell/web/mcp/aws/delegation/hooks/wildcards,
 *   - the capability is keyed on the profile id — never on prompt text,
 *   - workspace-supplied MCP/hooks cannot widen the agent (empty + disabled).
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  resolveProfileCapability, assertKiroProfile, isWriteProfile,
  ACP_READONLY_TOOLS, ACP_IMPLEMENT_TOOLS, ACP_IMPLEMENT_TRUST_TOOLS_FLAG,
  ACP_TRUST_TOOLS_FLAG, ACP_AGENT_NAME_PATTERN, ACP_IMPL_AGENT_NAME_PATTERN,
  READONLY_TOOL_KINDS, WRITE_TOOL_KINDS,
  isFailedToolStatus, failedMutationToolCalls, FAILED_TOOL_STATUSES,
} from '../../src/executor/agents/acpDriver.js';
import { AcpDriver } from '../../src/executor/agents/acpDriver.js';
import { bridgeAgentConfig, buildRunnerCreateBody } from '../../src/executor/agents/kiroBackend.js';
import { buildStagerCreateBody, GIT_STAGING_SCRIPT } from '../../src/executor/agents/sandboxSpec.js';
import { runAcpJob, type RunnerControl } from '../../src/executor/agents/runnerMain.js';

const IMPL_MOCK = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mock-acp-impl-server.mjs');

const FORBIDDEN_TOOLS = [
  'shell', 'terminal', 'executeCmd', 'execute_bash', 'bash',
  'web', 'web_search', 'webSearch', 'web_fetch', 'fetch',
  'mcp', 'use_aws', 'useAws', 'aws', 'delegate', 'agent_crew', 'agentCrew',
  'use_subagent', 'useSubagent', '*',
];

describe('assertKiroProfile / isWriteProfile', () => {
  it('accepts the four Kiro-servable profiles', () => {
    for (const p of ['audit', 'plan', 'review', 'implement']) {
      expect(() => assertKiroProfile(p)).not.toThrow();
    }
  });
  it('rejects non-Kiro profiles (fail closed, FORBIDDEN_PROFILE)', () => {
    for (const p of ['', 'root', 'admin', 'shell', 'exec']) {
      expect(() => assertKiroProfile(p)).toThrow();
      try { assertKiroProfile(p); } catch (e: any) { expect(e.code).toBe('FORBIDDEN_PROFILE'); }
    }
  });
  it('classifies ONLY implement as a writer', () => {
    expect(isWriteProfile('implement')).toBe(true);
    for (const p of ['audit', 'plan', 'review']) expect(isWriteProfile(p)).toBe(false);
  });
});

describe('resolveProfileCapability — read-only profiles preserve A4', () => {
  for (const p of ['audit', 'plan', 'review'] as const) {
    it(`${p} is read-only: no writable workspace, read/grep/glob only, mcp_ro_ identity`, () => {
      const cap = resolveProfileCapability(p);
      expect(cap.workspaceWritable).toBe(false);
      expect([...cap.agentTools]).toEqual([...ACP_READONLY_TOOLS]);
      expect(cap.trustTools).toBe(ACP_TRUST_TOOLS_FLAG);
      expect(cap.agentNamePattern).toBe(ACP_AGENT_NAME_PATTERN);
      // Read-only tool-kind allowlist has no mutation kinds.
      expect(cap.allowedToolKinds.has('edit')).toBe(false);
      expect(cap.allowedToolKinds.has('read')).toBe(true);
    });
  }
});

describe('resolveProfileCapability — implement write lane', () => {
  const cap = resolveProfileCapability('implement');

  it('is writable, adds ONLY the canonical `write` tool, keeps read/grep/glob', () => {
    expect(cap.workspaceWritable).toBe(true);
    expect([...cap.agentTools]).toEqual(['read', 'grep', 'glob', 'write']);
    expect([...ACP_IMPLEMENT_TOOLS]).toEqual(['read', 'grep', 'glob', 'write']);
  });
  it('uses a distinct unguessable mcp_impl_ identity', () => {
    expect(cap.agentNamePattern).toBe(ACP_IMPL_AGENT_NAME_PATTERN);
    const n = `mcp_impl_${randomBytes(16).toString('hex')}`;
    expect(cap.agentNamePattern.test(n)).toBe(true);
    expect(ACP_AGENT_NAME_PATTERN.test(n)).toBe(false); // never the mcp_ro_ shape
  });
  it('trust-tools = read,grep,glob (write is NEVER globally trusted; path-scoped instead)', () => {
    expect(cap.trustTools).toBe('read,grep,glob');
    expect(ACP_IMPLEMENT_TRUST_TOOLS_FLAG).toBe('read,grep,glob');
    // Same upfront-trust set as the read-only lane — write is not trusted here.
    expect(cap.trustTools).toBe(ACP_TRUST_TOOLS_FLAG);
    expect(cap.trustTools).not.toContain('*');
    // No write alias may appear in the upfront trust set.
    for (const alias of ['write', 'fsWrite', 'fs_write']) {
      expect(cap.trustTools.split(',')).not.toContain(alias);
    }
  });
  it('allows read + mutation tool kinds but NOT shell/web/mcp kinds', () => {
    for (const k of ['read', 'grep', 'glob', 'edit', 'create', 'delete', 'move']) {
      expect(cap.allowedToolKinds.has(k)).toBe(true);
    }
    for (const k of ['execute', 'shell', 'bash', 'terminal', 'fetch', 'mcp', 'aws', 'delegate']) {
      expect(cap.allowedToolKinds.has(k)).toBe(false);
    }
  });
  it('grants no forbidden capability in its agent tool set', () => {
    for (const t of FORBIDDEN_TOOLS) expect([...cap.agentTools]).not.toContain(t);
  });
});

describe('read/write tool-kind sets are disjoint on mutation', () => {
  it('write kinds are not part of the read-only set', () => {
    for (const k of WRITE_TOOL_KINDS) expect(READONLY_TOOL_KINDS.has(k)).toBe(false);
  });
});

describe('A5 tool OUTCOME semantics — a CALLED write is not a SUCCEEDED write', () => {
  it('isFailedToolStatus recognises failure statuses (case-insensitive) and not success/none', () => {
    for (const s of FAILED_TOOL_STATUSES) {
      expect(isFailedToolStatus(s)).toBe(true);
      expect(isFailedToolStatus(s.toUpperCase())).toBe(true);
    }
    for (const s of ['completed', 'pending', 'in_progress', undefined, null, '']) {
      expect(isFailedToolStatus(s as any)).toBe(false);
    }
  });

  it('a mutation-kind tool call that FAILED is flagged (root cause of the two real failures)', () => {
    // The real failures emitted toolCallKinds=["read","edit"] with zero
    // mutations: an `edit` tool that FAILED. That must be detectable.
    const failed = failedMutationToolCalls([
      { kind: 'read', status: 'completed' },
      { kind: 'edit', status: 'failed' },
    ]);
    expect(failed.map((t) => t.kind)).toEqual(['edit']);
  });

  it('does NOT flag when mutation tool calls SUCCEEDED', () => {
    expect(failedMutationToolCalls([
      { kind: 'read', status: 'completed' },
      { kind: 'edit', status: 'completed' },
      { kind: 'create', status: 'completed' },
    ])).toEqual([]);
  });

  it('does NOT flag a failed READ (only mutation kinds gate the implement job)', () => {
    // A failed read is not a failed write; it must not, by itself, be treated
    // as a failed mutation (change detection / allowlist handle the rest).
    expect(failedMutationToolCalls([{ kind: 'read', status: 'failed' }])).toEqual([]);
  });

  it('does NOT flag when there are no tool calls at all (zero diff is not auto-fail)', () => {
    expect(failedMutationToolCalls([])).toEqual([]);
  });
});

describe('A5 outcome evidence survives the runner boundary (runAcpJob, no provider)', () => {
  function implControl(overrides: Partial<RunnerControl> = {}): RunnerControl {
    return {
      acpCommand: process.execPath,
      acpPrefixArgs: [IMPL_MOCK],
      agent: 'mcp_impl_' + randomBytes(16).toString('hex'),
      model: 'claude-sonnet-4.5',
      trustTools: ACP_IMPLEMENT_TRUST_TOOLS_FLAG,
      cwd: process.cwd(),
      prompt: 'unused',
      dryRun: false,
      ...overrides,
    };
  }

  it('carries the FAILED edit status through RunnerResult.toolCalls, and the backend rule flags it', async () => {
    // The mock CALLS an `edit` tool that FAILS (permission denied) but the turn
    // still reaches end_turn with a confident "success" message. Evidence must
    // reflect the failure, and the decision must NOT read the prose.
    const r = await runAcpJob(implControl({ prompt: 'FAIL to write despite claiming success' }));
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe('end_turn');
    const edit = r.toolCalls.find((t) => t.kind === 'edit');
    expect(edit?.status).toBe('failed');
    // The exact backend gate: a failed mutation kind => non-empty => FAILED_AGENT.
    expect(failedMutationToolCalls(r.toolCalls).map((t) => t.kind)).toEqual(['edit']);
  });

  it('a SUCCESSFUL implement turn carries completed statuses and is NOT flagged', async () => {
    const r = await runAcpJob(implControl({ prompt: 'IMPLEMENT the feature' }));
    expect(r.ok).toBe(true);
    expect(r.toolCalls.map((t) => t.kind).sort()).toEqual(['edit', 'read']);
    for (const t of r.toolCalls) expect(t.status).toBe('completed');
    expect(failedMutationToolCalls(r.toolCalls)).toEqual([]);
  });
});

describe('bridgeAgentConfig — implement write variant lock', () => {
  const cfg = bridgeAgentConfig('mcp_impl_' + 'a'.repeat(32), { write: true });

  it('grants read/grep/glob + the canonical `write` tool and nothing else', () => {
    expect(cfg.tools).toEqual(['read', 'grep', 'glob', 'write']);
    for (const t of FORBIDDEN_TOOLS) expect(JSON.stringify(cfg.tools)).not.toContain(`"${t}"`);
  });
  it('pre-approves ONLY the read-only set in allowedTools; write is NOT globally pre-approved', () => {
    // Documented Agent Configuration Reference: allowedTools OVERRIDES
    // toolsSettings allowable patterns. Including `write` there would nullify
    // the /workspace path scoping, so write MUST be absent from allowedTools.
    expect(cfg.allowedTools).toEqual(['read', 'grep', 'glob']);
  });
  it('has NO write alias anywhere in allowedTools', () => {
    const allowed = cfg.allowedTools as string[];
    for (const alias of ['write', 'fsWrite', 'fs_write']) {
      expect(allowed).not.toContain(alias);
    }
  });
  it('confines write to /workspace and denies non-workspace locations via toolsSettings', () => {
    const ws = (cfg.toolsSettings as any)?.write;
    expect(ws?.allowedPaths).toEqual(['/workspace']);
    expect(ws?.deniedPaths).toEqual(['/home/runner', '/tmp', '/run/secrets', '/run/control']);
    // The scoping lives ONLY under the canonical `write` key (no fsWrite key).
    expect((cfg.toolsSettings as any)?.fsWrite).toBeUndefined();
  });
  it('cannot be widened by workspace MCP or hooks', () => {
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.includeMcpJson).toBe(false);
    expect(cfg.hooks).toEqual({});
    expect(cfg.resources).toEqual([]);
    expect(cfg.model).toBeNull();
  });
  it('is prompt-independent: the tool set is fixed policy regardless of caller text', () => {
    // Whatever a prompt might say, the effective agent grants the same tools.
    const a = bridgeAgentConfig('mcp_impl_' + 'b'.repeat(32), { write: true });
    expect(a.tools).toEqual(cfg.tools);
    expect(a.allowedTools).toEqual(cfg.allowedTools);
  });
});

describe('bridgeAgentConfig — default remains read-only (A4)', () => {
  it('has NO fsWrite when write is not requested', () => {
    const ro = bridgeAgentConfig('mcp_ro_' + 'c'.repeat(32));
    expect(ro.tools).toEqual(['read', 'grep', 'glob']);
    expect(JSON.stringify(ro.tools)).not.toContain('fsWrite');
  });
});

describe('buildRunnerCreateBody — workspace mount mode', () => {
  const base = {
    jobId: 'job_' + '0'.repeat(32),
    image: 'runner:test', workspaceVolume: 'ws', secretVolume: 'sec',
    homeVolume: 'home', controlVolume: 'ctl', internalNetwork: 'net',
    proxyUrl: 'http://egress-proxy:8080',
    memoryBytes: 1_073_741_824, nanoCpus: 1_000_000_000, pidsLimit: 128,
  };
  const mounts = (b: any) => b.HostConfig.Mounts as { Target: string; ReadOnly: boolean }[];
  const mount = (b: any, t: string) => mounts(b).find((m) => m.Target === t)!;

  it('implement mounts /workspace WRITABLE while all other mounts stay locked', () => {
    const b = buildRunnerCreateBody({ ...base, workspaceReadOnly: false }) as any;
    expect(mount(b, '/workspace').ReadOnly).toBe(false);
    // Everything else remains hardened / read-only.
    expect(mount(b, '/run/secrets').ReadOnly).toBe(true);
    expect(mount(b, '/run/control').ReadOnly).toBe(true);
    expect(b.HostConfig.ReadonlyRootfs).toBe(true);
    expect(b.HostConfig.CapDrop).toEqual(['ALL']);
    expect(b.User).toBe('1000:1000');
    const joined = JSON.stringify(b);
    expect(joined).not.toContain('--trust-all-tools');
    expect(joined).not.toContain('--yolo');
    expect(joined).not.toContain('/var/run/docker.sock');
    // No host project bind: no Binds entry at all.
    expect(b.HostConfig.Binds ?? []).toEqual([]);
  });

  it('read-only profiles keep /workspace READ-ONLY (A4 parity)', () => {
    const b = buildRunnerCreateBody({ ...base, workspaceReadOnly: true }) as any;
    expect(mount(b, '/workspace').ReadOnly).toBe(true);
  });
});

describe('ACP --trust-tools argv for the implement lane', () => {
  const cap = resolveProfileCapability('implement');
  const driver = new AcpDriver({
    command: 'kiro-cli',
    cwd: '/workspace',
    env: {},
    agent: 'mcp_impl_' + 'a'.repeat(32),
    trustTools: cap.trustTools,
    model: 'claude-sonnet-4.5',
  });
  const args = driver.buildArgs();

  it('passes --trust-tools=read,grep,glob (write is path-scoped, never globally trusted)', () => {
    const i = args.indexOf('--trust-tools');
    expect(i).toBeGreaterThanOrEqual(0);
    const value = args[i + 1];
    expect(value).toBe('read,grep,glob');
    const trusted = value.split(',');
    for (const alias of ['write', 'fsWrite', 'fs_write']) {
      expect(trusted).not.toContain(alias);
    }
  });

  it('never uses a wildcard or trust-all escape hatch', () => {
    const joined = args.join(' ');
    expect(joined).not.toContain('--trust-all-tools');
    expect(joined).not.toContain('--yolo');
    expect(args).not.toContain('-a');
    expect(joined).not.toContain('*');
  });
});

describe('A5 tracked-symlink staging precondition (fail closed for implement)', () => {
  it('the shared staging script scans HEAD for Git mode 120000 only when REJECT_SYMLINKS is set', () => {
    expect(GIT_STAGING_SCRIPT).toContain('REJECT_SYMLINKS');
    expect(GIT_STAGING_SCRIPT).toContain('ls-files -s');
    expect(GIT_STAGING_SCRIPT).toContain('120000');
    expect(GIT_STAGING_SCRIPT).toContain('exit 6');
  });

  it('implement staging sets REJECT_SYMLINKS=1 in the stager env', () => {
    const b = buildStagerCreateBody({
      image: 'stager:test', jobId: 'job_' + '0'.repeat(32),
      hostPath: '/trusted/src', volumeName: 'ws', rejectTrackedSymlinks: true,
    });
    expect(b.Env).toContain('REJECT_SYMLINKS=1');
  });

  it('read-only staging does NOT set REJECT_SYMLINKS (A4 parity)', () => {
    const b = buildStagerCreateBody({
      image: 'stager:test', jobId: 'job_' + '0'.repeat(32),
      hostPath: '/trusted/src', volumeName: 'ws',
    });
    expect(b.Env).not.toContain('REJECT_SYMLINKS=1');
    expect(b.Env.some((e) => e.startsWith('REJECT_SYMLINKS'))).toBe(false);
  });
});
