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
  const startupPolicyCalls: Array<[boolean, Record<string, unknown>]> = [];
  const orphanArgs: unknown[] = [];
  const imageInspectRefs: string[] = [];
  const imageIdentity = { value: `sha256:${'a'.repeat(64)}` };
  /** Record a stage, and throw from it when this test asked that stage to fail. */
  const stage = (name: string): void => {
    order.push(name);
    if (fail.stage === name) throw new Error(`simulated global failure in ${name}`);
  };
  return { order, fail, startupPolicyCalls, orphanArgs, imageInspectRefs, imageIdentity, stage };
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
  inspectImage: async (ref: string) => {
    h.imageInspectRefs.push(ref);
    return { Id: h.imageIdentity.value };
  },
}));

vi.mock('../../src/executor/agentConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/executor/agentConfig.js')>()),
  loadAgentConfig: () => ({ projects: [], backends: [], profiles: [], resourcePolicies: [] }),
}));

vi.mock('../../src/executor/startupPolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/startupPolicy.js')>();
  return {
    ...actual,
    resolveExecutorStartupPolicy: (
      ollamaEnabled: boolean,
      env: Parameters<typeof actual.resolveExecutorStartupPolicy>[1],
    ) => {
      h.startupPolicyCalls.push([ollamaEnabled, { ...env }]);
      return actual.resolveExecutorStartupPolicy(ollamaEnabled, env);
    },
  };
});

vi.mock('../../src/executor/agents/jobStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/agents/jobStore.js')>();
  class FakeStore {
    constructor(_path: string) { h.stage('jobStore:construct+migrate'); }
    get schemaVersion(): number { return 5; }
    recoverApplyAttempts(_reason: string) {
      h.stage('recoverApplyAttempts');
      return { abortedNoMutation: [], uncertain: [] };
    }
    listSecurityAssessmentPrepared() { return []; }
    listSecurityAssessmentPreparedIds(): string[] { return []; }
    executionLeaseSummary(): [] { return []; }
    markExecutionLeasesUncertainForOwner(): void {}
    close(): void {}
  }
  return { ...actual, AgentJobStore: FakeStore };
});

vi.mock('../../src/executor/agents/jobEngine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/agents/jobEngine.js')>();
  class FakeEngine {
    constructor(..._args: unknown[]) {}
    recover(): string[] { h.stage('recoverActive'); return []; }
    protectedProviderStateRefs(): string[] { return ['provider-state-active']; }
    kick(): void { h.stage('queueRestart'); }
    shutdown(): void {}
  }
  return { ...actual, AgentJobEngine: FakeEngine };
});

vi.mock('../../src/executor/agents/sandboxRunner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/executor/agents/sandboxRunner.js')>();
  class FakeSandbox {
    constructor(_opts: unknown) {}
    async reconcileOrphans(opts?: unknown) {
      h.orphanArgs.push(opts);
      h.stage('sandbox.reconcileOrphans');
      return { removedContainers: [], removedVolumes: [], removedNetworks: [] };
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
  'queueRestart',
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
  h.startupPolicyCalls.length = 0;
  h.orphanArgs.length = 0;
  h.imageInspectRefs.length = 0;
  h.imageIdentity.value = `sha256:${'a'.repeat(64)}`;
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
  delete process.env.AGENT_STAGER_IMAGE;

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
    expect(h.order[listenAt + 1]).toBe('queueRestart');
    for (const s of FROZEN_ORDER.filter((x) => x !== 'listen' && x !== 'queueRestart')) {
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

  it('P3 restarts recovered queued work only after successful listen', async () => {
    await runStartup();
    expect(h.order.indexOf('queueRestart')).toBeGreaterThan(h.order.indexOf('listen'));
    expect(h.order.indexOf('queueRestart')).toBeGreaterThan(h.order.indexOf('evidenceLifecycle'));
  });

  it('A8 R1 passes ACTIVE/RESERVED provider state refs into orphan preservation before sweep', async () => {
    await runStartup();
    expect(h.orphanArgs).toHaveLength(1);
    const arg = h.orphanArgs[0] as { preserveManagedVolumeNames?: Set<string> };
    expect(arg.preserveManagedVolumeNames).toBeInstanceOf(Set);
    expect(arg.preserveManagedVolumeNames?.has('provider-state-active')).toBe(true);
  });

  it('passes the trusted AGENT_STAGER_IMAGE through the real production startup boundary', async () => {
    process.env.AGENT_STAGER_IMAGE = 'qualified-o1-stager:v1';

    await runStartup();

    expect(h.startupPolicyCalls).toHaveLength(1);
    expect(h.startupPolicyCalls[0]?.[1]).toMatchObject({
      agentStagerImage: 'qualified-o1-stager:v1',
    });
  });

  it('does not source the O1 stager image from runner/helper values and resolves configured runtime refs to immutable IDs', async () => {
    process.env.AGENT_RUNNER_IMAGE = 'kiro-runner:v1';
    process.env.AGENT_HELPER_IMAGE = 'o1-read-helper:v1';
    delete process.env.AGENT_STAGER_IMAGE;

    await runStartup();

    expect(h.startupPolicyCalls).toHaveLength(1);
    expect(h.startupPolicyCalls[0]?.[1]).toMatchObject({
      agentRunnerImage: 'kiro-runner:v1',
      agentHelperImage: 'o1-read-helper:v1',
      agentStagerImage: '',
    });
    expect(h.imageInspectRefs).toEqual(['kiro-runner:v1', 'o1-read-helper:v1']);
    expect(h.order.indexOf('jobStore:construct+migrate')).toBeLessThan(h.order.indexOf('sandbox.reconcileOrphans'));
  });

  it('fails closed before listen when a configured runtime image does not resolve to a sha256 Docker image ID', async () => {
    process.env.AGENT_RUNNER_IMAGE = 'kiro-runner:v1';
    h.imageIdentity.value = 'not-an-immutable-image-id';

    await runStartup();

    expect(h.imageInspectRefs).toEqual(['kiro-runner:v1']);
    expect(h.order).toContain('jobStore:construct+migrate');
    expect(h.order).not.toContain('sandbox.reconcileOrphans');
    expect(h.order).not.toContain('listen');
    expect(exitCodes).toEqual([1]);
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
