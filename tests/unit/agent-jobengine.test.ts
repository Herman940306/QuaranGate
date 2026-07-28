import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { AgentJobEngine, type DispatchRequest } from '../../src/executor/agents/jobEngine.js';
import { parseAgentConfigYaml, type AgentControlPlaneConfig } from '../../src/executor/agentConfig.js';
import type { FakeBackendOptions } from '../../src/executor/agents/fakeBackend.js';
import { BridgeError } from '../../src/shared/errors.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Trusted test config: uses the shipped example (kiro enabled, copilot disabled). */
function testConfig(): AgentControlPlaneConfig {
  const cfg = parseAgentConfigYaml(readFileSync(join(repoRoot, 'config', 'agents.example.yaml'), 'utf8'));
  // Tighten the economy runtime so timeout tests stay fast — still trusted
  // config, never a caller-controlled field.
  const eco = cfg.resourcePolicies.find((r) => r.id === 'economy')!;
  (eco as { maxRuntimeMs: number }).maxRuntimeMs = 10_000;
  return cfg;
}

let store: AgentJobStore;
let engine: AgentJobEngine;
let backendOpts: FakeBackendOptions;
let dbPath: string;

function makeEngine(cfg = testConfig()): AgentJobEngine {
  return new AgentJobEngine(store, cfg, () => backendOpts);
}

function dispatch(over: Partial<DispatchRequest> = {}) {
  return engine.dispatch({
    principal: 'owner',
    backend: 'kiro',
    project: 'example-project',
    profile: 'audit',
    prompt: 'Describe the repository. Do not modify files.',
    ...over,
  });
}

async function waitFor(jobId: string, done: (s: string) => boolean, ms = 5000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const s = store.get(jobId)!.status;
    if (done(s)) return s;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${jobId}, still ${s}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-engine-')), 'agents.db');
  store = new AgentJobStore(dbPath);
  backendOpts = { prepareMs: 1, runMs: 5, validateMs: 1 };
  engine = makeEngine();
});

afterEach(() => {
  engine.shutdown();
  try { store.close(); } catch { /* closed by test */ }
});

describe('agent job engine — dispatch validation (trusted config)', () => {
  it('rejects unknown project', () => {
    expect(() => dispatch({ project: 'nope' })).toThrow(BridgeError);
    try { dispatch({ project: 'nope' }); } catch (e) { expect((e as BridgeError).code).toBe('UNKNOWN_PROJECT'); }
  });

  it('rejects disabled backend', () => {
    try {
      dispatch({ backend: 'copilot', project: 'example-docs' });
      expect.unreachable();
    } catch (e) { expect((e as BridgeError).code).toBe('FORBIDDEN_BACKEND'); }
  });

  it('rejects backend not allowed for the project', () => {
    // example-project allows only kiro
    try {
      dispatch({ backend: 'copilot' });
      expect.unreachable();
    } catch (e) { expect((e as BridgeError).code).toBe('FORBIDDEN_BACKEND'); }
  });

  it('rejects profile not allowed for the project', () => {
    try {
      dispatch({ project: 'example-docs', profile: 'implement' }); // docs allows audit/plan only
      expect.unreachable();
    } catch (e) { expect((e as BridgeError).code).toBe('FORBIDDEN_PROFILE'); }
  });

  it('rejects unknown resource policy strings at the executor boundary', () => {
    expect(() => dispatch({ resourcePolicy: 'unlimited' })).toThrow(BridgeError);
  });

  it('rejects sessionPolicy resume explicitly (A8 feature)', () => {
    try {
      dispatch({ sessionPolicy: 'resume' });
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe('MALFORMED_REQUEST');
      expect((e as BridgeError).message).toContain('A8');
    }
  });

  it('no rejected dispatch persists a job', () => {
    for (const bad of [
      () => dispatch({ project: 'nope' }),
      () => dispatch({ backend: 'copilot' }),
      () => dispatch({ sessionPolicy: 'resume' as const }),
    ]) {
      try { bad(); } catch { /* expected */ }
    }
    expect(store.hasQueued()).toBe(false);
    expect(store.countActive()).toBe(0);
  });

  it('classifies writers from the trusted profile contract, not the prompt', () => {
    const w = dispatch({ profile: 'implement', prompt: 'read-only sounding prompt' });
    expect(w.writer).toBe(true);
    const r = dispatch({ profile: 'audit', prompt: 'please write files everywhere' });
    expect(r.writer).toBe(false);
  });

  it('applies the profile default resource policy when none is given', () => {
    const j = dispatch({ profile: 'audit' });
    expect(j.resourcePolicy).toBe('economy');
    const k = dispatch({ profile: 'review', resourcePolicy: 'deep' });
    expect(k.resourcePolicy).toBe('deep');
  });

  it('generates opaque conforming job ids with no embedded metadata', () => {
    const j = dispatch();
    expect(j.jobId).toMatch(/^job_[0-9a-f]{32}$/);
    expect(j.jobId).not.toContain('owner');
    expect(j.jobId).not.toContain('example');
  });
});

describe('agent job engine — execution lifecycle', () => {
  it('runs the fake backend to COMPLETED with an honest result', async () => {
    const j = dispatch();
    await waitFor(j.jobId, (s) => s === 'COMPLETED');
    const done = store.get(j.jobId)!;
    expect(done.summary).toContain('Fake backend completed successfully');
    expect(done.summary).toContain('No files were changed');
    expect(done.exitCode).toBe(0);
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();
  });

  it('maps injected backend failure to FAILED_AGENT', async () => {
    backendOpts = { prepareMs: 1, runMs: 1, validateMs: 1, failAt: 'run', failureMessage: 'deterministic agent crash' };
    const j = dispatch();
    await waitFor(j.jobId, (s) => s === 'FAILED_AGENT');
    const failed = store.get(j.jobId)!;
    expect(failed.failureCode).toBe('FAILED_AGENT');
    expect(failed.failureReason).toContain('deterministic agent crash');
  });

  it('enforces maxRuntimeMs as FAILED_TIMEOUT', async () => {
    const cfg = testConfig();
    (cfg.resourcePolicies.find((r) => r.id === 'economy')! as { maxRuntimeMs: number }).maxRuntimeMs = 10_000;
    // Store-level bounds allow >=10s policies; shrink via engine test seam instead:
    // run phase far longer than policy by overriding backend runMs and policy.
    (cfg.resourcePolicies.find((r) => r.id === 'economy')! as { maxRuntimeMs: number }).maxRuntimeMs = 50;
    engine = makeEngine(cfg);
    backendOpts = { prepareMs: 1, runMs: 5_000, validateMs: 1 };
    const j = dispatch();
    await waitFor(j.jobId, (s) => s === 'FAILED_TIMEOUT');
    expect(store.get(j.jobId)!.failureCode).toBe('FAILED_TIMEOUT');
  });

  it('serializes jobs: second job waits until the first finishes', async () => {
    backendOpts = { prepareMs: 1, runMs: 100, validateMs: 1 };
    const a = dispatch();
    const b = dispatch();
    await new Promise((r) => setTimeout(r, 30));
    expect(store.get(a.jobId)!.status).not.toBe('QUEUED');
    expect(store.get(b.jobId)!.status).toBe('QUEUED'); // waits, not rejected
    await waitFor(b.jobId, (s) => s === 'COMPLETED');
    expect(store.get(a.jobId)!.status).toBe('COMPLETED');
  });

  it('serializes writer jobs per project through the persisted lock', async () => {
    backendOpts = { prepareMs: 1, runMs: 80, validateMs: 1 };
    const w1 = dispatch({ profile: 'implement' });
    const w2 = dispatch({ profile: 'implement' });
    await new Promise((r) => setTimeout(r, 30));
    expect(store.countActiveWriters('example-project')).toBe(1);
    expect(store.get(w2.jobId)!.status).toBe('QUEUED');
    await waitFor(w2.jobId, (s) => s === 'COMPLETED');
    await waitFor(w1.jobId, (s) => s === 'COMPLETED');
  });
});

describe('agent job engine — cancellation', () => {
  it('cancels a QUEUED job directly', async () => {
    backendOpts = { prepareMs: 1, runMs: 300, validateMs: 1 };
    dispatch(); // occupies the engine
    const queued = dispatch();
    expect(store.get(queued.jobId)!.status).toBe('QUEUED');
    const cancelled = engine.cancel(queued.jobId, 'owner');
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.failureCode).toBe('CANCELLED');
  });

  it('cancels an ACTIVE job cooperatively via AbortSignal', async () => {
    backendOpts = { prepareMs: 1, runMs: 5_000, validateMs: 1 };
    const j = dispatch();
    await waitFor(j.jobId, (s) => s === 'RUNNING');
    const t0 = Date.now();
    const cancelled = engine.cancel(j.jobId, 'owner');
    expect(cancelled.status).toBe('CANCELLED');
    expect(Date.now() - t0).toBeLessThan(1000); // no waiting out the fake run
    await new Promise((r) => setTimeout(r, 50));
    expect(store.get(j.jobId)!.status).toBe('CANCELLED'); // stays cancelled
  });

  it('cancelling a terminal job returns its status unchanged', async () => {
    const j = dispatch();
    await waitFor(j.jobId, (s) => s === 'COMPLETED');
    const res = engine.cancel(j.jobId, 'owner');
    expect(res.status).toBe('COMPLETED');
  });

  it('after cancel, the engine proceeds to the next queued job', async () => {
    backendOpts = { prepareMs: 1, runMs: 5_000, validateMs: 1 };
    const a = dispatch();
    await waitFor(a.jobId, (s) => s === 'RUNNING');
    backendOpts = { prepareMs: 1, runMs: 5, validateMs: 1 };
    const b = dispatch();
    engine.cancel(a.jobId, 'owner');
    await waitFor(b.jobId, (s) => s === 'COMPLETED');
  });
});

describe('agent job engine — ownership', () => {
  it('denies status/result access to non-owners', () => {
    const j = dispatch();
    expect(() => engine.getOwnedJob(j.jobId, 'someone-else')).toThrow(BridgeError);
    try { engine.getOwnedJob(j.jobId, 'someone-else'); } catch (e) {
      expect((e as BridgeError).code).toBe('FORBIDDEN_JOB');
    }
    expect(engine.getOwnedJob(j.jobId, 'owner').jobId).toBe(j.jobId);
  });

  it('denies cancellation to non-owners without changing the job', async () => {
    backendOpts = { prepareMs: 1, runMs: 500, validateMs: 1 };
    const j = dispatch();
    expect(() => engine.cancel(j.jobId, 'intruder')).toThrow(BridgeError);
    expect(['QUEUED', 'PREPARING', 'RUNNING', 'VALIDATING']).toContain(store.get(j.jobId)!.status);
    engine.cancel(j.jobId, 'owner');
  });

  it('unknown job ids yield UNKNOWN_JOB', () => {
    try {
      engine.getOwnedJob('job_' + 'e'.repeat(32), 'owner');
      expect.unreachable();
    } catch (e) { expect((e as BridgeError).code).toBe('UNKNOWN_JOB'); }
  });
});

describe('agent job engine — startup recovery', () => {
  it('fails active jobs closed and resumes queued jobs after restart', async () => {
    backendOpts = { prepareMs: 1, runMs: 60_000, validateMs: 1 };
    const active = dispatch();
    const queued = dispatch();
    await waitFor(active.jobId, (s) => s === 'RUNNING');
    // Simulate a hard restart: no shutdown bookkeeping, fresh store + engine.
    const store2 = new AgentJobStore(dbPath);
    backendOpts = { prepareMs: 1, runMs: 5, validateMs: 1 };
    const engine2 = new AgentJobEngine(store2, testConfig(), () => backendOpts);
    const recovered = engine2.recover();
    expect(recovered).toContain(active.jobId);
    const failed = store2.get(active.jobId)!;
    expect(failed.status).toBe('FAILED_INFRASTRUCTURE');
    expect(failed.failureReason).toBe('executor restarted during active fake execution');
    // The queued job survived and now completes under the new engine.
    const start = Date.now();
    for (;;) {
      if (store2.get(queued.jobId)!.status === 'COMPLETED') break;
      if (Date.now() - start > 5000) throw new Error('queued job did not run after recovery');
      await new Promise((r) => setTimeout(r, 10));
    }
    engine2.shutdown();
    store2.close();
  });
});

describe('agent job engine — log safety', () => {
  it('never emits the prompt into log lines', async () => {
    const secretishPrompt = 'UNIQUE_PROMPT_MARKER_9137 do sensitive-sounding work';
    const spy = vi.spyOn(console, 'log');
    const j = dispatch({ prompt: secretishPrompt });
    await waitFor(j.jobId, (s) => s === 'COMPLETED');
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('UNIQUE_PROMPT_MARKER_9137');
    expect(logged).toContain(j.jobId); // bounded metadata is logged
    spy.mockRestore();
  });
});
