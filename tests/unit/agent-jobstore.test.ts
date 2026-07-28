import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentJobStore, AGENT_JOB_SCHEMA_VERSION, type NewAgentJob } from '../../src/executor/agents/jobStore.js';
import { BridgeError } from '../../src/shared/errors.js';
import { MAX_AGENT_PROMPT_CHARS } from '../../src/shared/agents.js';

let store: AgentJobStore;
let dbPath: string;

function newJob(over: Partial<NewAgentJob> = {}): NewAgentJob {
  const id = `job_${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}`;
  return {
    jobId: id,
    principalId: 'owner',
    backend: 'kiro',
    project: 'example-project',
    profile: 'audit',
    resourcePolicy: 'economy',
    promptHash: 'a'.repeat(64),
    prompt: 'do the thing',
    sessionPolicy: 'new',
    writer: false,
    ...over,
  };
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-jobs-')), 'agents.db');
  store = new AgentJobStore(dbPath);
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe('agent job store', () => {
  it('initializes the schema at the expected version', () => {
    expect(store.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
    expect(store.schemaVersion).toBe(2);
  });

  it('creates SQLite files private to the runtime identity (0600, no group/other)', () => {
    // A write forces WAL activity so the -wal/-shm sidecars exist for the check.
    store.insert(newJob());
    expect(mode(dbPath)).toBe(0o600);
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(sidecar)) {
        expect(mode(sidecar) & 0o077, `${sidecar} must not be group/world accessible`).toBe(0);
      }
    }
  });

  it('tightens a pre-existing world-readable database without recreating it', () => {
    const j = store.insert(newJob());
    store.close();
    // Simulate a legacy 0644 database file left by an earlier build.
    chmodSync(dbPath, 0o644);
    expect(mode(dbPath)).toBe(0o644);
    const reopened = new AgentJobStore(dbPath);
    expect(mode(dbPath)).toBe(0o600); // hardened on open
    expect(reopened.get(j.jobId)!.prompt).toBe('do the thing'); // durable state preserved
    reopened.close();
  });

  it('reopening an existing DB preserves records and version', () => {
    const j = store.insert(newJob());
    store.close();
    const reopened = new AgentJobStore(dbPath);
    expect(reopened.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
    const got = reopened.get(j.jobId)!;
    expect(got.status).toBe('QUEUED');
    expect(got.prompt).toBe('do the thing');
    reopened.close();
  });

  it('inserts as QUEUED and queries back all fields', () => {
    const j = store.insert(newJob({ writer: true, profile: 'implement' }));
    expect(j.status).toBe('QUEUED');
    expect(j.writer).toBe(true);
    expect(j.principalId).toBe('owner');
    expect(j.createdAt).toMatch(/^\d{4}-/);
    expect(j.startedAt).toBeNull();
    expect(store.get('job_' + 'f'.repeat(32))).toBeUndefined();
  });

  it('rejects oversized prompts at the store boundary too', () => {
    expect(() => store.insert(newJob({ prompt: 'x'.repeat(MAX_AGENT_PROMPT_CHARS + 1) }))).toThrow(BridgeError);
  });

  it('performs atomic valid transitions and reports raced CAS as false', () => {
    const j = store.insert(newJob());
    expect(store.transition(j.jobId, 'QUEUED', 'PREPARING', { startedAt: new Date().toISOString() })).toBe(true);
    expect(store.get(j.jobId)!.status).toBe('PREPARING');
    // CAS with stale expected state fails without changing anything.
    expect(store.transition(j.jobId, 'QUEUED', 'CANCELLED')).toBe(false);
    expect(store.get(j.jobId)!.status).toBe('PREPARING');
  });

  it('rejects invalid transitions via the shared state machine', () => {
    const j = store.insert(newJob());
    expect(() => store.transition(j.jobId, 'QUEUED', 'COMPLETED')).toThrow(BridgeError);
    expect(() => store.transition(j.jobId, 'QUEUED', 'APPLIED')).toThrow(BridgeError);
    expect(store.get(j.jobId)!.status).toBe('QUEUED');
  });

  it('claims the oldest queued job and moves it to PREPARING atomically', () => {
    const a = store.insert(newJob());
    store.insert(newJob());
    const claimed = store.claimNext()!;
    expect(claimed.jobId).toBe(a.jobId);
    expect(claimed.status).toBe('PREPARING');
    expect(claimed.startedAt).not.toBeNull();
  });

  it('enforces global serialization: no claim while any job is active', () => {
    store.insert(newJob());
    store.insert(newJob());
    expect(store.claimNext()).toBeDefined();
    expect(store.claimNext()).toBeUndefined(); // one active blocks all claims
    expect(store.countActive()).toBe(1);
  });

  it('writer counters: global and per-project', () => {
    const w = store.insert(newJob({ writer: true, project: 'proj-a' }));
    store.insert(newJob({ writer: true, project: 'proj-b' }));
    expect(store.countActiveWriters()).toBe(0);
    store.transition(w.jobId, 'QUEUED', 'PREPARING');
    expect(store.countActiveWriters()).toBe(1);
    expect(store.countActiveWriters('proj-a')).toBe(1);
    expect(store.countActiveWriters('proj-b')).toBe(0);
  });

  it('writer serialization persists across restart (no double admission)', () => {
    const w1 = store.insert(newJob({ writer: true, project: 'proj-a' }));
    store.insert(newJob({ writer: true, project: 'proj-a' }));
    expect(store.claimNext()!.jobId).toBe(w1.jobId);
    store.close();
    // Simulated restart: a new store instance over the same DB still sees the
    // active writer and refuses to admit the second one.
    store = new AgentJobStore(dbPath);
    expect(store.countActiveWriters('proj-a')).toBe(1);
    expect(store.claimNext()).toBeUndefined();
  });

  it('startup recovery fails active jobs closed and leaves QUEUED eligible', () => {
    const active = store.insert(newJob());
    const queued = store.insert(newJob());
    store.transition(active.jobId, 'QUEUED', 'PREPARING');
    const recovered = store.recoverActive('executor restarted during active fake execution');
    expect(recovered).toEqual([active.jobId]);
    const a = store.get(active.jobId)!;
    expect(a.status).toBe('FAILED_INFRASTRUCTURE');
    expect(a.failureCode).toBe('FAILED_INFRASTRUCTURE');
    expect(a.failureReason).toContain('restarted');
    expect(store.get(queued.jobId)!.status).toBe('QUEUED');
    // Recovery released writer/serialization authority: claims work again.
    expect(store.claimNext()!.jobId).toBe(queued.jobId);
  });

  it('recovery does not resurrect terminal jobs', () => {
    const j = store.insert(newJob());
    store.transition(j.jobId, 'QUEUED', 'CANCELLED', { failureCode: 'CANCELLED' });
    expect(store.recoverActive('x')).toEqual([]);
    expect(store.get(j.jobId)!.status).toBe('CANCELLED');
  });
});
