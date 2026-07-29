/**
 * A4 runner-internal ACP driver (runnerMain) tests.
 *
 * Proves the runner-side logic that the Executor delivers into the container:
 * it reuses the SAME AcpDriver and, given trusted control data, drives
 * initialize → session/new → (dryRun stop | prompt) and returns a bounded
 * normalized result. Exercised END-TO-END against the deterministic mock Kiro
 * ACP server (real 2.5.0 line shapes) — no paid provider call.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runAcpJob, type RunnerControl } from '../../src/executor/agents/runnerMain.js';
import { newBridgeAgentName } from '../../src/executor/agents/acpDriver.js';

const MOCK = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mock-acp-server.mjs');

function control(overrides: Partial<RunnerControl> = {}): RunnerControl {
  return {
    acpCommand: process.execPath,
    acpPrefixArgs: [MOCK],
    agent: newBridgeAgentName(() => randomBytes(16).toString('hex')),
    model: 'claude-sonnet-4',
    trustTools: 'read,grep,glob',
    // On the host the spawn cwd must exist; inside the real runner this is the
    // RO /workspace. Use the repo root here.
    cwd: process.cwd(),
    prompt: 'unused',
    dryRun: true,
    ...overrides,
  };
}

describe('runAcpJob — dry run (production-gate path)', () => {
  it('reaches initialize + session/new then STOPS (no prompt, no inference)', async () => {
    const r = await runAcpJob(control({ dryRun: true }));
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.protocolVersion).toBe(1);
    expect(r.agentInfo?.version).toBe('2.5.0');
    expect(r.sessionId).toMatch(/^sess-/);
    expect(r.stopReason).toBe('dry_run');
    expect(r.toolCalls).toEqual([]);
    expect(r.assistantText).toBe('');
  });
});

describe('runAcpJob — full turn (aggregation + bounds)', () => {
  it('drives a prompt and aggregates read-only tool calls', async () => {
    const r = await runAcpJob(control({ dryRun: false, prompt: 'FIND-THE-UNIQUE-TOKEN-42' }));
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe('end_turn');
    // toolCalls now carry the ACP terminal status alongside kind+count (A5
    // result-semantics evidence). The read tool completed successfully.
    expect(r.toolCalls).toEqual([{ kind: 'read', status: 'completed', count: 1 }]);
    expect(r.assistantText).toContain('MARKER:FIND-THE-UNIQUE-TOKEN-42');
  });

  it('bounds assistant text to maxAssistantBytes', async () => {
    const r = await runAcpJob(control({ dryRun: false, prompt: 'FIND', maxAssistantBytes: 4 }));
    expect(r.assistantText.length).toBeLessThanOrEqual(4);
  });

  it('reports non-read-only tool kinds so the backend can reject them', async () => {
    const r = await runAcpJob(control({ dryRun: false, prompt: 'WIDEN' }));
    expect(r.toolCalls.map((t) => t.kind)).toContain('bash');
  });

  it('records refused privileged server->client requests without hanging', async () => {
    const r = await runAcpJob(control({ dryRun: false, prompt: 'PRIV please write a file' }));
    expect(r.ok).toBe(true);
    expect(r.refusedRequestCount).toBe(1);
  });
});

describe('runAcpJob — failure surfaces cleanly', () => {
  it('returns ok:false with a bounded error when the ACP process cannot start', async () => {
    const r = await runAcpJob(control({ acpCommand: '/nonexistent/kiro-cli-xyz', acpPrefixArgs: [] }));
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.stopReason).toBe('error');
  });
});
