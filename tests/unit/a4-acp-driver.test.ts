/**
 * A4 ACP driver tests.
 *
 * The protocol behaviour is proven END-TO-END against a deterministic mock ACP
 * server that speaks the REAL Kiro 2.5.0 line protocol (tests/fixtures/
 * mock-acp-server.mjs) and REJECTS wrong message shapes. No paid provider call.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AcpDriver,
  buildAcpEnvironment,
  ACP_READONLY_TOOLS,
  ACP_TRUST_TOOLS_FLAG,
  ACP_AGENT_NAME_PREFIX,
  ACP_AGENT_NAME_PATTERN,
  ACP_PROTOCOL_VERSION,
  newBridgeAgentName,
  isAllowedReadonlyTool,
  isReadonlyProfile,
  assertReadonlyProfile,
} from '../../src/executor/agents/acpDriver.js';
import { randomBytes } from 'node:crypto';

const MOCK = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mock-acp-server.mjs');

function makeDriver(overrides: Partial<ConstructorParameters<typeof AcpDriver>[0]> = {}): AcpDriver {
  return new AcpDriver({
    command: process.execPath,
    commandPrefixArgs: [MOCK],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    agent: newBridgeAgentName(() => randomBytes(16).toString('hex')),
    trustTools: ACP_TRUST_TOOLS_FLAG,
    model: 'claude-haiku-4.5',
    ...overrides,
  });
}

describe('ACP driver — argv construction', () => {
  it('builds acp argv with --agent, --model, --trust-tools and no --trust-all-tools', () => {
    const d = makeDriver({ agent: 'mcp_ro_deadbeef', model: 'claude-haiku-4.5' });
    const args = d.buildArgs();
    expect(args).toContain('acp');
    expect(args).toContain('--agent');
    expect(args[args.indexOf('--agent') + 1]).toBe('mcp_ro_deadbeef');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4.5');
    expect(args).toContain('--trust-tools');
    expect(args[args.indexOf('--trust-tools') + 1]).toBe('read,grep,glob');
    expect(args).not.toContain('--trust-all-tools');
    expect(args).not.toContain('-a');
    expect(args).not.toContain('--yolo');
  });
});

describe('ACP driver — protocol against mock Kiro', () => {
  it('initialize negotiates protocolVersion 1 (number)', async () => {
    const d = makeDriver();
    d.spawn();
    try {
      const init = await d.initialize();
      expect(init.protocolVersion).toBe(1);
      expect(init.agentInfo?.version).toBe('2.5.0');
    } finally { await d.shutdown(); }
  });

  it('session/new + session/prompt round-trip with the correct shapes', async () => {
    const d = makeDriver();
    d.spawn();
    try {
      await d.initialize();
      const s = await d.sessionNew('/workspace');
      expect(s.sessionId).toMatch(/^sess-/);
      expect(d.getSessionId()).toBe(s.sessionId);

      const turn = await d.prompt({ prompt: 'FIND-THE-UNIQUE-TOKEN-42', timeoutMs: 10_000 });
      expect(turn.stopReason).toBe('end_turn');
      // The mock only replies correctly if the driver sent {sessionId,
      // prompt:[{type:text,text}]} with NO model field.
      expect(turn.assistantText).toContain('MARKER:FIND-THE-UNIQUE-TOKEN-42');
      expect(turn.toolCalls.map((t) => t.kind)).toEqual(['read']);
      expect(turn.toolCalls[0]?.status).toBe('completed');
    } finally { await d.shutdown(); }
  });

  it('refuses server->client privileged requests (fail closed) without hanging', async () => {
    const d = makeDriver();
    d.spawn();
    try {
      await d.initialize();
      await d.sessionNew('/workspace');
      const turn = await d.prompt({ prompt: 'PRIV please write a file', timeoutMs: 10_000 });
      expect(turn.stopReason).toBe('end_turn');
      expect(d.getRefusedRequestCount()).toBe(1);
    } finally { await d.shutdown(); }
  });

  it('reports non-read-only tool kinds so the backend can reject them', async () => {
    const d = makeDriver();
    d.spawn();
    try {
      await d.initialize();
      await d.sessionNew('/workspace');
      const turn = await d.prompt({ prompt: 'WIDEN', timeoutMs: 10_000 });
      expect(turn.toolCalls.map((t) => t.kind)).toContain('bash');
    } finally { await d.shutdown(); }
  });

  it('times out a slow turn and surfaces a bounded error', async () => {
    const d = makeDriver();
    d.spawn();
    try {
      await d.initialize();
      await d.sessionNew('/workspace');
      await expect(d.prompt({ prompt: 'SLOW', timeoutMs: 300 })).rejects.toThrow(/timed out/);
    } finally { d.kill('test done'); }
  });

  it('cancels a turn cooperatively via AbortSignal', async () => {
    const d = makeDriver();
    d.spawn();
    try {
      await d.initialize();
      await d.sessionNew('/workspace');
      const ac = new AbortController();
      const p = d.prompt({ prompt: 'SLOW', signal: ac.signal, timeoutMs: 10_000 });
      setTimeout(() => ac.abort(new Error('cancelled')), 100);
      await expect(p).rejects.toBeTruthy();
    } finally { d.kill('test done'); }
  });
});

describe('ACP readonly tool + agent policy', () => {
  it('allows exactly read, grep, glob', () => {
    expect(ACP_READONLY_TOOLS).toEqual(['read', 'grep', 'glob']);
    expect(ACP_TRUST_TOOLS_FLAG).toBe('read,grep,glob');
  });

  it('isAllowedReadonlyTool rejects write/shell/web/mcp/wildcard', () => {
    for (const bad of ['write', 'shell', 'terminal', 'web_search', 'web_fetch', 'mcp', 'delegate', '*', '']) {
      expect(isAllowedReadonlyTool(bad)).toBe(false);
    }
    for (const good of ['read', 'grep', 'glob']) expect(isAllowedReadonlyTool(good)).toBe(true);
  });

  it('generates unguessable per-job agent names (mcp_ro_ + 32 hex)', () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = newBridgeAgentName(() => randomBytes(16).toString('hex'));
      expect(n.startsWith(ACP_AGENT_NAME_PREFIX)).toBe(true);
      expect(ACP_AGENT_NAME_PATTERN.test(n)).toBe(true);
      names.add(n);
    }
    expect(names.size).toBe(50); // all distinct
  });

  it('exposes the validated protocol version constant', () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });
});

describe('ACP read-only profile gating', () => {
  it('allows audit, plan, review; denies implement', () => {
    for (const ok of ['audit', 'plan', 'review']) expect(isReadonlyProfile(ok)).toBe(true);
    expect(isReadonlyProfile('implement')).toBe(false);
  });

  it('assertReadonlyProfile throws FORBIDDEN_PROFILE for implement', () => {
    expect(() => assertReadonlyProfile('implement')).toThrow(/write capability/);
    try { assertReadonlyProfile('implement'); } catch (e: any) {
      expect(e.code).toBe('FORBIDDEN_PROFILE');
      expect(e.httpStatus).toBe(403);
    }
  });
});

describe('ACP environment isolation', () => {
  it('builds fully isolated env with all six isolation vars, no host home', () => {
    const env = buildAcpEnvironment({ apiKey: 'k', home: '/home/runner', kiroHome: '/home/runner/.kiro', pathPrefix: '/opt/bin' });
    expect(env.HOME).toBe('/home/runner');
    expect(env.KIRO_HOME).toBe('/home/runner/.kiro');
    expect(env.XDG_CONFIG_HOME).toBe('/home/runner/.config');
    expect(env.XDG_DATA_HOME).toBe('/home/runner/.local/share');
    expect(env.XDG_STATE_HOME).toBe('/home/runner/.local/state');
    expect(env.XDG_CACHE_HOME).toBe('/home/runner/.cache');
    expect(env.KIRO_TELEMETRY).toBe('off');
    expect(env.KIRO_DISABLE_UPDATE).toBe('1');
    expect(env.PATH.startsWith('/opt/bin:')).toBe(true);
    for (const v of Object.values(env)) expect(v).not.toContain('/home/herman');
  });
});
