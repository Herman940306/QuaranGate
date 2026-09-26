import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentJobStore, type NewAgentJob } from '../../src/executor/agents/jobStore.js';
import { AgentJobEngine, type DispatchRequest } from '../../src/executor/agents/jobEngine.js';
import { parseAgentConfigYaml, type AgentControlPlaneConfig } from '../../src/executor/agentConfig.js';
import { BridgeError } from '../../src/shared/errors.js';
import { projectExecutionFabricForPrincipal } from '../../src/gateway/controlCenterTools.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stores: AgentJobStore[] = [];
const engines: AgentJobEngine[] = [];

function db(): AgentJobStore {
  const store = new AgentJobStore(join(mkdtempSync(join(tmpdir(), 'be1a-')), 'agents.db'));
  stores.push(store);
  return store;
}

function config(projectIds = ['proj-a', 'proj-b', 'proj-c', 'proj-d']): AgentControlPlaneConfig {
  const cfg = parseAgentConfigYaml(readFileSync(join(repoRoot, 'config', 'agents.example.yaml'), 'utf8'));
  const source = cfg.projects.find((p) => p.id === 'example-project')!;
  cfg.projects = projectIds.map((id) => ({
    ...source,
    id,
    hostPath: `/trusted/${id}`,
    worktreeId: `${id}-worktree`,
    guardedPaths: [...source.guardedPaths],
    sensitiveReadGlobs: [...source.sensitiveReadGlobs],
  }));
  cfg.execution = { maxConcurrency: 4, maxQueuedPerProject: 16 };
  return cfg;
}

function job(id: number, project: string, resources: string[] = [], globalExclusive = false): NewAgentJob {
  return {
    jobId: `job_${id.toString(16).padStart(32, '0')}`,
    principalId: 'owner',
    backend: 'kiro',
    project,
    profile: 'audit',
    resourcePolicy: 'economy',
    promptHash: 'a'.repeat(64),
    prompt: 'bounded test job',
    sessionPolicy: 'new',
    writer: false,
    retentionClass: 'ephemeral',
    retentionDurationMs: 86_400_000,
    executionResources: resources,
    globalExclusive,
  };
}

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for BE1A condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function dispatch(engine: AgentJobEngine, project: string): ReturnType<AgentJobEngine['dispatch']> {
  const req: DispatchRequest = {
    principal: 'owner',
    backend: 'kiro',
    project,
    profile: 'audit',
    prompt: `inspect ${project}`,
  };
  return engine.dispatch(req);
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.shutdown();
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
});

describe('BE1A cross-project execution fabric', () => {
  it('runs four unrelated registered projects concurrently and a long A does not stall B/C/D', async () => {
    const store = db();
    const cfg = config();
    const engine = new AgentJobEngine(store, cfg, () => ({ prepareMs: 10, runMs: 180, validateMs: 10 }));
    engines.push(engine);

    const jobs = ['proj-a', 'proj-b', 'proj-c', 'proj-d'].map((p) => dispatch(engine, p));
    await waitUntil(() => store.countActive() === 4);

    expect(store.countActive()).toBe(4);
    expect(jobs.map((j) => store.get(j.jobId)!.project).sort()).toEqual(['proj-a', 'proj-b', 'proj-c', 'proj-d']);
    await waitUntil(() => jobs.every((j) => store.get(j.jobId)!.status === 'COMPLETED'));
  });

  it('serializes the same protected resource but admits non-overlapping resources', () => {
    const store = db();
    store.insert(job(1, 'proj-a', ['temp-root:q']));
    store.insert(job(2, 'proj-b', ['temp-root:q']));
    store.insert(job(3, 'proj-c', ['temp-root:c']));

    expect(store.claimNext(4)!.project).toBe('proj-a');
    expect(store.claimNext(4)!.project).toBe('proj-c');
    expect(store.claimNext(4)).toBeUndefined();
    expect(store.executionWaitingResourceSummary()).toEqual([{ projectId: 'proj-b', resourceKey: 'temp-root:q', waitingJobs: 1 }]);
  });

  it('resists starvation under repeated project-A load', () => {
    const store = db();
    store.insert(job(1, 'proj-a'));
    store.insert(job(2, 'proj-a'));
    store.insert(job(3, 'proj-a'));
    store.insert(job(4, 'proj-b'));
    store.insert(job(5, 'proj-c'));
    store.insert(job(6, 'proj-d'));
    const firstWave = [store.claimNext(4), store.claimNext(4), store.claimNext(4), store.claimNext(4)]
      .map((j) => j!.project).sort();
    expect(firstWave).toEqual(['proj-a', 'proj-b', 'proj-c', 'proj-d']);
  });

  it('allows non-conflicting owner-host scopes but serializes the same owner-host scope', () => {
    const store = db();
    store.insert(job(1, 'proj-a', ['owner-host:scope-a']));
    store.insert(job(2, 'proj-b', ['owner-host:scope-b']));
    store.insert(job(3, 'proj-c', ['owner-host:scope-a']));
    expect(store.claimNext(4)!.project).toBe('proj-a');
    expect(store.claimNext(4)!.project).toBe('proj-b');
    expect(store.claimNext(4)).toBeUndefined();
  });

  it('keeps global-exclusive work serialized against all active work', () => {
    const store = db();
    store.insert(job(1, 'proj-a', ['temp-root:a']));
    store.insert(job(2, 'proj-b', [], true));
    expect(store.claimNext(4)!.project).toBe('proj-a');
    expect(store.claimNext(4)).toBeUndefined();
    store.releaseExecutionLeases('job_' + '1'.padStart(32, '0'));
    expect(store.transition('job_' + '1'.padStart(32, '0'), 'PREPARING', 'FAILED_INFRASTRUCTURE', {
      completedAt: new Date().toISOString(), failureCode: 'FAILED_INFRASTRUCTURE', failureReason: 'test settled',
    })).toBe(true);
    expect(store.claimNext(4)!.project).toBe('proj-b');
    expect(store.executionLeaseSummary().some((l) => l.resourceKey === 'machine:global-exclusive')).toBe(true);
  });

  it('fails crash recovery closed: uncertain resource blocks conflict until explicit evidence-bound settlement', () => {
    const store = db();
    const shared = 'database:shared-schema';
    store.insert(job(1, 'proj-a', [shared]));
    store.insert(job(2, 'proj-b', [shared]));
    expect(store.claimNext(4)!.project).toBe('proj-a');

    expect(store.recoverActive('synthetic scheduler crash')).toHaveLength(1);
    expect(store.executionLeaseSummary()).toEqual([
      expect.objectContaining({ resourceKey: shared, projectId: 'proj-a', state: 'UNCERTAIN' }),
    ]);
    expect(store.claimNext(4)).toBeUndefined();

    expect(store.settleUncertainExecutionLease(
      'job_' + '1'.padStart(32, '0'), shared, 'recovery inspection proved no mutation remains',
    )).toBe(true);
    expect(store.claimNext(4)!.project).toBe('proj-b');
  });

  it('cancels one project without affecting unrelated active work', async () => {
    const store = db();
    const cfg = config(['proj-a', 'proj-b']);
    const engine = new AgentJobEngine(store, cfg, () => ({ prepareMs: 10, runMs: 250, validateMs: 10 }));
    engines.push(engine);
    const a = dispatch(engine, 'proj-a');
    const b = dispatch(engine, 'proj-b');
    await waitUntil(() => store.countActive() === 2);
    engine.cancel(a.jobId, 'owner');
    await waitUntil(() => store.get(a.jobId)!.status === 'CANCELLED');
    expect(['PREPARING', 'RUNNING', 'VALIDATING', 'COMPLETED']).toContain(store.get(b.jobId)!.status);
    await waitUntil(() => store.get(b.jobId)!.status === 'COMPLETED');
  });

  it('rejects arbitrary/path-shaped resource identities at the store boundary', () => {
    const store = db();
    expect(() => store.insert(job(1, 'proj-a', ['worktree:../../escape']))).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_REQUEST' }),
    );
    expect(() => store.insert(job(2, 'proj-a', ['worktree:C:\\host\\path']))).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_REQUEST' }),
    );
  });

  it('uses trusted project resource claims and ignores caller-shaped extra fields', () => {
    const store = db();
    const cfg = config(['proj-a']);
    cfg.projects[0]!.executionResources = [{ category: 'shared-cache', id: 'registry' }];
    const engine = new AgentJobEngine(store, cfg, () => ({ prepareMs: 1, runMs: 40, validateMs: 1 }));
    engines.push(engine);

    const req = {
      principal: 'owner', backend: 'kiro', project: 'proj-a', profile: 'audit', prompt: 'test',
      executionResources: [{ category: 'machine', id: 'caller-owned' }],
      maxConcurrency: 999,
    } as unknown as DispatchRequest;
    const created = engine.dispatch(req);
    expect(created.executionResources).toEqual(['shared-cache:registry']);
    expect(created.globalExclusive).toBe(false);
  });

  it('invalidates the bounded safe snapshot cache after mutation', () => {
    const store = db();
    const cfg = config(['proj-a']);
    const engine = new AgentJobEngine(store, cfg, () => ({ prepareMs: 50, runMs: 50, validateMs: 50 }));
    engines.push(engine);

    const first = engine.executionFabricSnapshot();
    const cached = engine.executionFabricSnapshot();
    expect(first.cached).toBe(false);
    expect(cached.cached).toBe(true);
    expect(cached.generation).toBe(first.generation);

    dispatch(engine, 'proj-a');
    const after = engine.executionFabricSnapshot();
    expect(after.cached).toBe(false);
    expect(after.generation).toBeGreaterThan(first.generation);
    expect(JSON.stringify(after)).not.toContain('/trusted/');
    expect(JSON.stringify(after)).not.toContain('inspect proj-a');
  });

  it('bounds each project queue independently using trusted server configuration', () => {
    const store = db();
    const cfg = config(['proj-a']);
    cfg.execution = { maxConcurrency: 4, maxQueuedPerProject: 1 };
    const engine = new AgentJobEngine(store, cfg, () => ({ prepareMs: 500, runMs: 500, validateMs: 500 }));
    engines.push(engine);
    engine.shutdown(); // stop claiming so queue-cap behavior is deterministic
    dispatch(engine, 'proj-a');
    expect(() => dispatch(engine, 'proj-a')).toThrowError(expect.objectContaining({
      code: 'CONCURRENCY_LIMIT',
    }));
  });

  it('atomically settles ACTIVE execution leases with durable COMPLETED commit', () => {
    const store = db();
    const j = store.insert(job(20, 'proj-a', ['database:atomic-complete']));
    expect(store.claimNext(4)!.jobId).toBe(j.jobId);
    expect(store.transition(j.jobId, 'PREPARING', 'RUNNING')).toBe(true);
    expect(store.transition(j.jobId, 'RUNNING', 'VALIDATING')).toBe(true);
    expect(store.executionLeaseSummary()).toHaveLength(1);

    const completed = store.finalizeCompletedWithSession({
      jobId: j.jobId,
      completedAt: new Date().toISOString(),
      summary: 'done',
      exitCode: 0,
      requireArtifact: false,
    });
    expect(completed.status).toBe('COMPLETED');
    expect(store.executionLeaseSummary()).toEqual([]);
  });

  it('reconciles historical COMPLETED + ACTIVE lease to RELEASED and unblocks conflicting work', () => {
    const store = db();
    const shared = 'database:historical-complete';
    const a = store.insert(job(21, 'proj-a', [shared]));
    const b = store.insert(job(22, 'proj-b', [shared]));
    expect(store.claimNext(4)!.jobId).toBe(a.jobId);
    expect(store.transition(a.jobId, 'PREPARING', 'RUNNING')).toBe(true);
    expect(store.transition(a.jobId, 'RUNNING', 'VALIDATING')).toBe(true);
    // Simulate a pre-R1 binary crashing after durable terminal status but
    // before its finally() lease release.
    expect(store.transition(a.jobId, 'VALIDATING', 'COMPLETED', {
      completedAt: new Date().toISOString(), summary: 'legacy completion', exitCode: 0,
    })).toBe(true);
    expect(store.claimNext(4)).toBeUndefined();

    const first = store.reconcileTerminalExecutionLeases('startup repair');
    expect(first.released).toHaveLength(1);
    expect(first.uncertain).toEqual([]);
    expect(store.claimNext(4)!.jobId).toBe(b.jobId);

    // Idempotent replay cannot re-release or disturb the now-active B lease.
    const second = store.reconcileTerminalExecutionLeases('startup repair replay');
    expect(second).toEqual({ released: [], uncertain: [] });
    expect(store.executionLeaseSummary()).toEqual([
      expect.objectContaining({ jobId: b.jobId, projectId: 'proj-b', resourceKey: shared, state: 'ACTIVE' }),
    ]);
  });

  it('reconciles proof-safe FAILED_AGENT + ACTIVE lease without cross-job release', () => {
    const store = db();
    const a = store.insert(job(23, 'proj-a', ['temp-root:a']));
    const b = store.insert(job(24, 'proj-b', ['temp-root:b']));
    expect(store.claimNext(4)!.jobId).toBe(a.jobId);
    expect(store.claimNext(4)!.jobId).toBe(b.jobId);
    expect(store.transition(a.jobId, 'PREPARING', 'RUNNING')).toBe(true);
    expect(store.transition(a.jobId, 'RUNNING', 'FAILED_AGENT', {
      completedAt: new Date().toISOString(),
      failureCode: 'FAILED_AGENT',
      failureReason: 'synthetic provider failure',
    })).toBe(true);

    const result = store.reconcileTerminalExecutionLeases('startup repair');
    expect(result.released).toHaveLength(1);
    expect(result.uncertain).toEqual([]);
    expect(store.executionLeaseSummary()).toEqual([
      expect.objectContaining({ jobId: b.jobId, resourceKey: 'temp-root:b', state: 'ACTIVE' }),
    ]);
  });

  it('preserves UNCERTAIN and classifies ambiguous CANCELLED terminal ACTIVE lease as UNCERTAIN', () => {
    const store = db();
    const a = store.insert(job(25, 'proj-a', ['owner-host:scope-a']));
    expect(store.claimNext(4)!.jobId).toBe(a.jobId);
    expect(store.transition(a.jobId, 'PREPARING', 'CANCELLED', {
      completedAt: new Date().toISOString(),
      failureCode: 'CANCELLED',
      failureReason: 'synthetic cancel crash window',
    })).toBe(true);
    const result = store.reconcileTerminalExecutionLeases('startup repair');
    expect(result.released).toEqual([]);
    expect(result.uncertain).toHaveLength(1);
    expect(store.executionLeaseSummary()).toEqual([
      expect.objectContaining({ jobId: a.jobId, resourceKey: 'owner-host:scope-a', state: 'UNCERTAIN' }),
    ]);
    expect(store.reconcileTerminalExecutionLeases('startup repair replay')).toEqual({ released: [], uncertain: [] });
    expect(store.executionLeaseSummary()[0]!.state).toBe('UNCERTAIN');
  });

  it('keeps active crash recovery FAILED_INFRASTRUCTURE + UNCERTAIN semantics unchanged', () => {
    const store = db();
    const a = store.insert(job(26, 'proj-a', ['database:active-crash']));
    expect(store.claimNext(4)!.jobId).toBe(a.jobId);
    expect(store.recoverActive('synthetic active crash')).toEqual([a.jobId]);
    expect(store.get(a.jobId)!.status).toBe('FAILED_INFRASTRUCTURE');
    expect(store.executionLeaseSummary()).toEqual([
      expect.objectContaining({ jobId: a.jobId, resourceKey: 'database:active-crash', state: 'UNCERTAIN' }),
    ]);
    expect(store.reconcileTerminalExecutionLeases('startup repair')).toEqual({ released: [], uncertain: [] });
  });

  it('keeps project rows private while preserving machine-global exclusive truth', () => {
    const raw = {
      generation: 7,
      cached: false,
      capacity: { maxConcurrency: 4, maxQueuedPerProject: 16 },
      projects: [
        { projectId: 'visible', queued: 1, active: 0 },
        { projectId: 'hidden', queued: 0, active: 1 },
      ],
      heldResources: [
        { resourceKey: 'shared-cache:visible', jobId: 'job_visible', projectId: 'visible', state: 'ACTIVE' as const },
        { resourceKey: 'machine:global-exclusive', jobId: 'job_hidden', projectId: 'hidden', state: 'ACTIVE' as const },
      ],
      waitingResources: [
        { projectId: 'visible', resourceKey: 'shared-cache:visible', waitingJobs: 1 },
        { projectId: 'hidden', resourceKey: 'machine:global-exclusive', waitingJobs: 1 },
      ],
      globalExclusiveHeld: true,
    };
    const projected = projectExecutionFabricForPrincipal(raw, new Set(['visible']));
    expect(projected.projects).toEqual([{ projectId: 'visible', queued: 1, active: 0 }]);
    expect(projected.heldResources).toEqual([
      { resourceKey: 'shared-cache:visible', jobId: 'job_visible', projectId: 'visible', state: 'ACTIVE' },
    ]);
    expect(projected.waitingResources).toEqual([
      { projectId: 'visible', resourceKey: 'shared-cache:visible', waitingJobs: 1 },
    ]);
    expect(projected.globalExclusiveHeld).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('hidden');
    expect(JSON.stringify(projected)).not.toContain('job_hidden');
  });

  it('preserves true/false global-exclusive truth independent of project visibility', () => {
    const base = {
      generation: 1,
      cached: false,
      capacity: { maxConcurrency: 4, maxQueuedPerProject: 16 },
      projects: [{ projectId: 'visible', queued: 0, active: 1 }],
      heldResources: [
        { resourceKey: 'machine:global-exclusive', jobId: 'job_visible', projectId: 'visible', state: 'ACTIVE' as const },
      ],
      waitingResources: [],
      globalExclusiveHeld: true,
    };
    expect(projectExecutionFabricForPrincipal(base, new Set(['visible'])).globalExclusiveHeld).toBe(true);
    expect(projectExecutionFabricForPrincipal({ ...base, heldResources: [], globalExclusiveHeld: false }, new Set(['visible'])).globalExclusiveHeld).toBe(false);
  });

  it('fails trusted configuration closed for caller-dangerous resource ids and invalid concurrency', () => {
    const text = readFileSync(join(repoRoot, 'config', 'agents.example.yaml'), 'utf8');
    const raw = text + '\nexecution:\n  maxConcurrency: 999\n  maxQueuedPerProject: 16\n';
    expect(() => parseAgentConfigYaml(raw)).toThrow(BridgeError);

    const badResource = text.replace(
      '    gitRequired: true',
      '    gitRequired: true\n    executionResources:\n      - category: worktree\n        id: ../../escape',
    );
    expect(() => parseAgentConfigYaml(badResource)).toThrow(BridgeError);
  });
});
