/**
 * A6 Decision R5 — executor startup ordering, proven by execution.
 *
 * The frozen requirement is that NO externally reachable request can race the
 * retained-evidence lifecycle pass: the executor must finish recovery and the
 * lifecycle pass BEFORE `server.listen()`, and must fail closed (never listen)
 * if any of it throws.
 *
 * This file drives the real `src/executor/index.ts` startup sequence with its
 * collaborators replaced by recorders, and asserts the observed order. It is
 * deliberately NOT source-line inspection.
 *
 * Coverage split (the two together prove all 8 frozen stages):
 *   - here:  store construct → recoverActive → recoverApplyAttempts →
 *            reconcileOrphans → evidence lifecycle → listen
 *   - agent-evidence-collector.test.ts ("stage ordering"): the internal
 *     reconcileExpired → Lane A → Lane B order inside the evidence lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared recorder — hoisted so the vi.mock factories below can close over it.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const order: string[] = [];
  const fail: { stage: string | null } = { stage: null };
  /** Record a stage, and throw from it when this test asked that stage to fail. */
  const stage = (name: string): void => {
    order.push(name);
    if (fail.stage === name) throw new Error(`simulated global failure in ${name}`);
  };
  return { order, fail, stage };
});

// ---------------------------------------------------------------------------
// Express — records listen() without binding a real socket.
// ---------------------------------------------------------------------------

vi.mock('express', () => {
  const app = {
    use: () => app,
    get: () => app,
    post: () => app,
    listen: (_port: number, _host: string, cb?: () => void) => {
      h.stage('listen');
      cb?.();
      return { close: (done?: () => void) => done?.() };
    },
  };
  const express = Object.assign(() => app, { json: () => (_r: unknown, _s: unknown, next: () => void) => next() });
  return { default: express };
});

// ---------------------------------------------------------------------------
// Executor collaborators. Every mock spreads the real module so only the
// startup-relevant symbol is replaced and nothing else in the graph breaks.
// ---------------------------------------------------------------------------

vi.mock('../../src/executor/targets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/executor/targets.js')>()),
  loadTargetConfig: () => {},
  listTargets: async () => [],
  invalidateCache: () => {},
}));

vi.mock('../../src/executor/docker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/executor/docker.js')>()),
  ping: async () => true,
}));

vi.mock('../../src/executor/agentConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/executor/agentConfig.js')>()),
  loadAgentConfig: () => ({ projects: [], backends: [], profiles: [], resourcePolicies: [] }),
}));

vi.mock('../../src/executor/agents/jobStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/agents/jobStore.js')>();
  class FakeStore {
    constructor(_path: string) { h.stage('jobStore:construct+migrate'); }
    get schemaVersion(): number { return 5; }
    recoverApplyAttempts(_reason: string) {
      h.stage('recoverApplyAttempts');
      return { abortedNoMutation: [], uncertain: [] };
    }
    close(): void {}
  }
  return { ...actual, AgentJobStore: FakeStore };
});

vi.mock('../../src/executor/agents/jobEngine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/agents/jobEngine.js')>();
  class FakeEngine {
    constructor(..._args: unknown[]) {}
    recover(): string[] { h.stage('recoverActive'); return []; }
    shutdown(): void {}
  }
  return { ...actual, AgentJobEngine: FakeEngine };
});

vi.mock('../../src/executor/agents/sandboxRunner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/agents/sandboxRunner.js')>();
  class FakeSandbox {
    constructor(_opts: unknown) {}
    async reconcileOrphans() {
      h.stage('sandbox.reconcileOrphans');
      return { removedContainers: [], removedVolumes: [] };
    }
  }
  return { ...actual, RunnerSandbox: FakeSandbox };
});

vi.mock('../../src/executor/agents/evidenceCollector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/agents/evidenceCollector.js')>();
  return {
    ...actual,
    runStartupEvidenceLifecycle: async () => {
      h.stage('evidenceLifecycle');
      return {
        reconcile: { deleteSuccessCount: 0, alreadyAbsentCount: 0, retainedCount: 0, retainedSamples: [] },
        collect: { expiredCount: 0, retainedCount: 0, integrityAnomalyCount: 0, retainedSamples: [], integrityAnomalySamples: [] },
        classify: { totalScanned: 0, byClassification: {} },
      };
    },
  };
});

vi.mock('../../src/executor/agents/routes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/executor/agents/routes.js')>()),
  registerAgentRoutes: () => {},
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The frozen order the executor must follow before it becomes reachable. */
const FROZEN_ORDER = [
  'jobStore:construct+migrate',
  'recoverActive',
  'recoverApplyAttempts',
  'sandbox.reconcileOrphans',
  'evidenceLifecycle',
  'listen',
] as const;

let exitCodes: number[] = [];
let exitSpy: { mockRestore(): void };
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let agentsConfigPath: string;

/** Import src/executor/index.ts fresh and wait for its async startup to settle. */
async function runStartup(): Promise<void> {
  vi.resetModules();
  await import('../../src/executor/index.js');
  // The startup IIFE resolves on a later microtask than the import itself.
  for (let i = 0; i < 200; i++) {
    if (h.order.includes('listen') || exitCodes.length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  h.order.length = 0;
  h.fail.stage = null;
  exitCodes = [];

  const dir = mkdtempSync(join(tmpdir(), 'mcpb-startup-'));
  agentsConfigPath = join(dir, 'agents.yaml');
  writeFileSync(agentsConfigPath, 'projects: []\n');

  process.env.INTERNAL_TOKEN = 'test-internal-token';
  process.env.AGENTS_CONFIG = agentsConfigPath;
  process.env.JOBS_DB = join(dir, 'agents.db');
  process.env.EXECUTOR_PORT = '0';
  // Keep the real Kiro backend unwired: this test is about ordering only.
  delete process.env.AGENT_RUNNER_IMAGE;
  delete process.env.AGENT_PROXY_IMAGE;
  delete process.env.AGENT_KIRO_KEY_PATH;
  delete process.env.AGENT_HELPER_IMAGE;

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(Number(code ?? 0));
    return undefined as never;
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

// ---------------------------------------------------------------------------
// SUCCESS PATH
// ---------------------------------------------------------------------------

describe('executor startup ordering — success path', () => {
  it('executes every stage exactly once, in the frozen order', async () => {
    await runStartup();
    expect(h.order).toEqual([...FROZEN_ORDER]);
    expect(exitCodes).toEqual([]);
  });

  it('listen() happens strictly after every lifecycle stage', async () => {
    await runStartup();
    const listenAt = h.order.indexOf('listen');
    expect(listenAt).toBe(h.order.length - 1);
    for (const s of FROZEN_ORDER.filter((x) => x !== 'listen')) {
      expect(h.order.indexOf(s), `${s} must precede listen`).toBeLessThan(listenAt);
    }
  });

  it('awaits reconcileOrphans before the evidence lifecycle (not fire-and-forget)', async () => {
    await runStartup();
    expect(h.order.indexOf('sandbox.reconcileOrphans'))
      .toBeLessThan(h.order.indexOf('evidenceLifecycle'));
  });

  it('recovery completes before any reconciliation work begins', async () => {
    await runStartup();
    expect(h.order.indexOf('recoverActive')).toBeLessThan(h.order.indexOf('sandbox.reconcileOrphans'));
    expect(h.order.indexOf('recoverApplyAttempts')).toBeLessThan(h.order.indexOf('sandbox.reconcileOrphans'));
  });
});

// ---------------------------------------------------------------------------
// GLOBAL FAILURE — startup must fail closed, never listen
// ---------------------------------------------------------------------------

describe('executor startup ordering — global failure fails closed', () => {
  const failableStages = [
    'jobStore:construct+migrate',
    'recoverActive',
    'recoverApplyAttempts',
    'sandbox.reconcileOrphans',
    'evidenceLifecycle',
  ] as const;

  it.each(failableStages)('a global failure in %s prevents listen and exits non-zero', async (failing) => {
    h.fail.stage = failing;
    await runStartup();

    expect(h.order, 'server must never listen after a global lifecycle failure').not.toContain('listen');
    expect(h.order[h.order.length - 1]).toBe(failing);
    expect(exitCodes).toEqual([1]);
  });

  it('an evidence-lifecycle failure still leaves the service unreachable', async () => {
    h.fail.stage = 'evidenceLifecycle';
    await runStartup();
    // Everything before the lifecycle ran; nothing after it did.
    expect(h.order).toEqual([
      'jobStore:construct+migrate',
      'recoverActive',
      'recoverApplyAttempts',
      'sandbox.reconcileOrphans',
      'evidenceLifecycle',
    ]);
    expect(exitCodes).toEqual([1]);
  });
});
