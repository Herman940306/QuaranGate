import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, existsSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentJobStore, AGENT_JOB_SCHEMA_VERSION, type NewAgentJob } from '../../src/executor/agents/jobStore.js';
import { BridgeError } from '../../src/shared/errors.js';
import { MAX_AGENT_PROMPT_CHARS, AGENT_RETENTION_DURATION_MS } from '../../src/shared/agents.js';

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
    retentionClass: 'ephemeral',
    retentionDurationMs: 86_400_000,
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
    expect(store.schemaVersion).toBe(5);
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

// =============================================================================
// A6 v5 — Retention snapshot persistence and disposition timestamp tests
// =============================================================================

import { describe as describeV5, it as itV5, expect as expectV5, beforeEach as beforeEachV5 } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_RETENTION_DURATION_MS } from '../../src/shared/agents.js';

describeV5('A6 retention snapshot — constants', () => {
  itV5('ephemeral maps to exactly 86_400_000 ms (24 hours)', () => {
    expectV5(AGENT_RETENTION_DURATION_MS['ephemeral']).toBe(86_400_000);
  });

  itV5('short maps to exactly 1_209_600_000 ms (14 days)', () => {
    expectV5(AGENT_RETENTION_DURATION_MS['short']).toBe(1_209_600_000);
  });

  itV5('audit maps to exactly 15_552_000_000 ms (180 days)', () => {
    expectV5(AGENT_RETENTION_DURATION_MS['audit']).toBe(15_552_000_000);
  });

  itV5('all values are positive safe integers', () => {
    for (const [cls, ms] of Object.entries(AGENT_RETENTION_DURATION_MS)) {
      expectV5(Number.isSafeInteger(ms), `${cls}: must be safe integer`).toBe(true);
      expectV5(ms > 0, `${cls}: must be > 0`).toBe(true);
    }
  });
});

describeV5('A6 retention snapshot — persistence at job creation', () => {
  let s: AgentJobStore;
  let p: string;

  beforeEachV5(() => {
    p = join(mkdtempSync(join(tmpdir(), 'mcpb-ret-')), 'agents.db');
    s = new AgentJobStore(p);
  });

  function makeJob(cls: 'ephemeral' | 'short' | 'audit'): ReturnType<typeof s.insert> {
    return s.insert(newJob({
      retentionClass: cls,
      retentionDurationMs: AGENT_RETENTION_DURATION_MS[cls],
    }));
  }

  itV5('ephemeral job persists retention_class=ephemeral, retention_duration_ms=86400000', () => {
    const j = makeJob('ephemeral');
    expectV5(j.retentionClass).toBe('ephemeral');
    expectV5(j.retentionDurationMs).toBe(86_400_000);
    expectV5(j.retainUntil).toBeNull(); // NULL until disposition
  });

  itV5('short job persists retention_class=short, retention_duration_ms=1209600000', () => {
    const j = makeJob('short');
    expectV5(j.retentionClass).toBe('short');
    expectV5(j.retentionDurationMs).toBe(1_209_600_000);
    expectV5(j.retainUntil).toBeNull();
  });

  itV5('audit job persists retention_class=audit, retention_duration_ms=15552000000', () => {
    const j = makeJob('audit');
    expectV5(j.retentionClass).toBe('audit');
    expectV5(j.retentionDurationMs).toBe(15_552_000_000);
    expectV5(j.retainUntil).toBeNull();
  });

  itV5('persist values are immutable in DB — reopening returns same values', () => {
    const j = makeJob('short');
    s.close();
    const s2 = new AgentJobStore(p);
    const got = s2.get(j.jobId)!;
    expectV5(got.retentionClass).toBe('short');
    expectV5(got.retentionDurationMs).toBe(1_209_600_000);
    s2.close();
  });

  itV5('insert rejects invalid retentionClass', () => {
    expectV5(() => s.insert(newJob({ retentionClass: 'invalid' as never, retentionDurationMs: 1000 }))).toThrow(BridgeError);
  });

  itV5('insert rejects negative retentionDurationMs', () => {
    expectV5(() => s.insert(newJob({ retentionClass: 'ephemeral', retentionDurationMs: -1 }))).toThrow(BridgeError);
  });

  itV5('insert rejects zero retentionDurationMs', () => {
    expectV5(() => s.insert(newJob({ retentionClass: 'ephemeral', retentionDurationMs: 0 }))).toThrow(BridgeError);
  });

  itV5('insert rejects non-integer retentionDurationMs', () => {
    expectV5(() => s.insert(newJob({ retentionClass: 'ephemeral', retentionDurationMs: 1.5 }))).toThrow(BridgeError);
  });
});

describeV5('A6 retention snapshot — APPLIED disposition timestamps', () => {
  let s: AgentJobStore;
  let p: string;

  beforeEachV5(() => {
    p = join(mkdtempSync(join(tmpdir(), 'mcpb-applied-')), 'agents.db');
    s = new AgentJobStore(p);
  });

  /** Drive a job through QUEUED→PREPARING→RUNNING→VALIDATING→publishArtifact→COMPLETED→APPLIED. */
  function driveToApplied(cls: 'ephemeral' | 'short' | 'audit'): string {
    const rdms = AGENT_RETENTION_DURATION_MS[cls];
    const job = s.insert(newJob({ retentionClass: cls, retentionDurationMs: rdms }));
    const jid = job.jobId;
    const now = new Date().toISOString();
    s.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now });
    s.transition(jid, 'PREPARING', 'RUNNING');
    s.transition(jid, 'RUNNING', 'VALIDATING');
    // Publish a fake artifact so status can reach COMPLETED.
    s.publishArtifact(jid, {
      artifactHash: 'a'.repeat(64),
      changeSetHash: 'b'.repeat(64),
      contentComplete: true,
      applicable: true,
      reason: null,
      artifactVolume: `io-mcp-ide-bridge-evidence-${jid}`,
      artifactBytes: 100,
      opCount: 1,
    });
    s.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now });
    // Start + transition an apply attempt through to APPLYING so markApplySuccess works.
    const attId = `att_${'c'.repeat(32)}`;
    s.startApplyAttempt({ attemptId: attId, jobId: jid });
    s.transitionApplyAttempt(attId, 'STARTED', 'VERIFYING');
    s.transitionApplyAttempt(attId, 'VERIFYING', 'APPLYING');
    s.markApplySuccess(attId, jid);
    return jid;
  }

  itV5('applied_at === disposition_at (same timestamp)', () => {
    const jid = driveToApplied('ephemeral');
    const got = s.get(jid)!;
    expectV5(got.status).toBe('APPLIED');
    expectV5(got.appliedAt).not.toBeNull();
    expectV5(got.dispositionAt).not.toBeNull();
    expectV5(got.appliedAt).toBe(got.dispositionAt);
  });

  itV5('APPLIED retain_until = disposition_at + retention_duration_ms (exact arithmetic)', () => {
    const cls = 'short';
    const rdms = AGENT_RETENTION_DURATION_MS[cls];
    const jid = driveToApplied(cls);
    const got = s.get(jid)!;
    expectV5(got.retainUntil).not.toBeNull();
    const dispositionMs = Date.parse(got.dispositionAt!);
    const retainUntilMs = Date.parse(got.retainUntil!);
    expectV5(retainUntilMs).toBe(dispositionMs + rdms);
  });

  itV5('APPLIED retain_until is a valid ISO 8601 string', () => {
    const jid = driveToApplied('audit');
    const got = s.get(jid)!;
    expectV5(got.retainUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectV5(Number.isFinite(Date.parse(got.retainUntil!))).toBe(true);
  });

  itV5('markApplySuccess fails closed when retention_duration_ms is invalid in DB', () => {
    // Manually corrupt the retention_duration_ms after insert to simulate DB corruption.
    const job = s.insert(newJob({ retentionClass: 'ephemeral', retentionDurationMs: 86_400_000 }));
    const jid = job.jobId;
    const db = new DatabaseSync(p);
    db.prepare('UPDATE agent_jobs SET retention_duration_ms = -99 WHERE job_id = ?').run(jid);
    db.close();

    const now = new Date().toISOString();
    s.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now });
    s.transition(jid, 'PREPARING', 'RUNNING');
    s.transition(jid, 'RUNNING', 'VALIDATING');
    s.publishArtifact(jid, {
      artifactHash: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
      contentComplete: true, applicable: true, reason: null,
      artifactVolume: `io-mcp-ide-bridge-evidence-${jid}`,
      artifactBytes: 100, opCount: 1,
    });
    s.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now });
    const attId = `att_${'d'.repeat(32)}`;
    s.startApplyAttempt({ attemptId: attId, jobId: jid });
    s.transitionApplyAttempt(attId, 'STARTED', 'VERIFYING');
    s.transitionApplyAttempt(attId, 'VERIFYING', 'APPLYING');
    // Must fail closed — not produce a valid APPLIED state with fabricated metadata.
    expectV5(() => s.markApplySuccess(attId, jid)).toThrow(BridgeError);
    // Job must remain COMPLETED, not APPLIED.
    const after = s.get(jid)!;
    expectV5(after.status).toBe('COMPLETED');
    expectV5(after.retainUntil).toBeNull();
  });
});

describeV5('A6 retention snapshot — DISCARDED disposition timestamps', () => {
  let s: AgentJobStore;
  let p: string;

  beforeEachV5(() => {
    p = join(mkdtempSync(join(tmpdir(), 'mcpb-discarded-')), 'agents.db');
    s = new AgentJobStore(p);
  });

  function driveToCompleted(cls: 'ephemeral' | 'short' | 'audit'): string {
    const rdms = AGENT_RETENTION_DURATION_MS[cls];
    const job = s.insert(newJob({ retentionClass: cls, retentionDurationMs: rdms }));
    const jid = job.jobId;
    const now = new Date().toISOString();
    s.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now });
    s.transition(jid, 'PREPARING', 'RUNNING');
    s.transition(jid, 'RUNNING', 'VALIDATING');
    s.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now });
    return jid;
  }

  itV5('DISCARDED retain_until = disposition_at + retention_duration_ms', () => {
    const cls = 'ephemeral';
    const rdms = AGENT_RETENTION_DURATION_MS[cls];
    const jid = driveToCompleted(cls);
    s.discardJob(jid);
    const got = s.get(jid)!;
    expectV5(got.status).toBe('DISCARDED');
    expectV5(got.dispositionAt).not.toBeNull();
    expectV5(got.retainUntil).not.toBeNull();
    const dispositionMs = Date.parse(got.dispositionAt!);
    const retainUntilMs = Date.parse(got.retainUntil!);
    expectV5(retainUntilMs).toBe(dispositionMs + rdms);
  });

  itV5('DISCARDED retain_until is a valid ISO 8601 string', () => {
    const jid = driveToCompleted('audit');
    s.discardJob(jid);
    const got = s.get(jid)!;
    expectV5(got.retainUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectV5(Number.isFinite(Date.parse(got.retainUntil!))).toBe(true);
  });

  itV5('all three retention_duration_ms values produce correct retain_until arithmetic', () => {
    for (const cls of ['ephemeral', 'short', 'audit'] as const) {
      const rdms = AGENT_RETENTION_DURATION_MS[cls];
      const thisp = join(mkdtempSync(join(tmpdir(), 'mcpb-ru-')), 'agents.db');
      const ts = new AgentJobStore(thisp);
      const jid = ts.insert(newJob({ retentionClass: cls, retentionDurationMs: rdms })).jobId;
      const now = new Date().toISOString();
      ts.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now });
      ts.transition(jid, 'PREPARING', 'RUNNING');
      ts.transition(jid, 'RUNNING', 'VALIDATING');
      ts.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now });
      ts.discardJob(jid);
      const got = ts.get(jid)!;
      const diff = Date.parse(got.retainUntil!) - Date.parse(got.dispositionAt!);
      expectV5(diff).toBe(rdms);
      ts.close();
    }
  });

  itV5('discardJob fails closed when retention_duration_ms is invalid in DB', () => {
    const jid = driveToCompleted('short');
    // Corrupt retention_duration_ms.
    const db = new DatabaseSync(p);
    db.prepare('UPDATE agent_jobs SET retention_duration_ms = 0 WHERE job_id = ?').run(jid);
    db.close();
    expectV5(() => s.discardJob(jid)).toThrow(BridgeError);
    // Job must remain COMPLETED.
    expectV5(s.get(jid)!.status).toBe('COMPLETED');
  });

  itV5('existing B6 active-apply exclusion still enforced after v5 changes', () => {
    const jid = driveToCompleted('ephemeral');
    const attId = `att_${'e'.repeat(32)}`;
    s.startApplyAttempt({ attemptId: attId, jobId: jid });
    // Active attempt → discard must be denied.
    expectV5(() => s.discardJob(jid)).toThrow(BridgeError);
    expectV5(s.get(jid)!.status).toBe('COMPLETED');
  });

  itV5('existing B6 UNCERTAIN exclusion still enforced after v5 changes', () => {
    const jid = driveToCompleted('ephemeral');
    const attId = `att_${'f'.repeat(32)}`;
    s.startApplyAttempt({ attemptId: attId, jobId: jid });
    s.transitionApplyAttempt(attId, 'STARTED', 'VERIFYING');
    s.transitionApplyAttempt(attId, 'VERIFYING', 'APPLYING');
    s.markApplyUncertain(attId, jid, 'example-project', 'test restart');
    expectV5(() => s.discardJob(jid)).toThrow(BridgeError);
    expectV5(s.get(jid)!.status).toBe('COMPLETED');
  });
});

describeV5('A6 retention snapshot — markExpired CAS primitive', () => {
  let s: AgentJobStore;

  beforeEachV5(() => {
    const p = join(mkdtempSync(join(tmpdir(), 'mcpb-expired-')), 'agents.db');
    s = new AgentJobStore(p);
  });

  function makeAppliedJobWithRetainUntil(retainUntil: string): string {
    const rdms = 86_400_000;
    const job = s.insert(newJob({ retentionClass: 'ephemeral', retentionDurationMs: rdms }));
    const jid = job.jobId;
    const now = new Date().toISOString();
    s.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now });
    s.transition(jid, 'PREPARING', 'RUNNING');
    s.transition(jid, 'RUNNING', 'VALIDATING');
    s.publishArtifact(jid, {
      artifactHash: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
      contentComplete: true, applicable: true, reason: null,
      artifactVolume: `io-mcp-ide-bridge-evidence-${jid}`,
      artifactBytes: 100, opCount: 1,
    });
    s.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now });
    const attId = `att_${'0'.repeat(31)}1`;
    s.startApplyAttempt({ attemptId: attId, jobId: jid });
    s.transitionApplyAttempt(attId, 'STARTED', 'VERIFYING');
    s.transitionApplyAttempt(attId, 'VERIFYING', 'APPLYING');
    s.markApplySuccess(attId, jid);
    // Override retain_until to a deterministic past/future value.
    const db = new DatabaseSync(s['db' as never] ? '' : ''); // can't access private db
    // Use raw DatabaseSync on the path instead.
    return jid;
  }

  itV5('markExpired transitions AVAILABLE→EXPIRED when retain_until has elapsed', () => {
    // Build a job via the store, then manually set retain_until to the past.
    const p2 = join(mkdtempSync(join(tmpdir(), 'mcpb-me-')), 'agents.db');
    const s2 = new AgentJobStore(p2);
    const rdms = 86_400_000;
    const job = s2.insert(newJob({ retentionClass: 'ephemeral', retentionDurationMs: rdms }));
    const jid = job.jobId;
    const pastTs = new Date(Date.now() - 2 * rdms).toISOString();
    const now2 = new Date().toISOString();
    s2.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now2 });
    s2.transition(jid, 'PREPARING', 'RUNNING');
    s2.transition(jid, 'RUNNING', 'VALIDATING');
    s2.publishArtifact(jid, {
      artifactHash: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
      contentComplete: true, applicable: true, reason: null,
      artifactVolume: `io-mcp-ide-bridge-evidence-${jid}`,
      artifactBytes: 100, opCount: 1,
    });
    s2.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now2 });
    const attId2 = `att_${'1'.repeat(32)}`;
    s2.startApplyAttempt({ attemptId: attId2, jobId: jid });
    s2.transitionApplyAttempt(attId2, 'STARTED', 'VERIFYING');
    s2.transitionApplyAttempt(attId2, 'VERIFYING', 'APPLYING');
    s2.markApplySuccess(attId2, jid);
    // Override retain_until to past via raw sqlite to simulate elapsed time.
    const rawDb = new DatabaseSync(p2);
    rawDb.prepare('UPDATE agent_jobs SET retain_until = ?, disposition_at = ? WHERE job_id = ?')
      .run(pastTs, pastTs, jid);
    rawDb.close();

    const nowIso = new Date().toISOString();
    const result = s2.markExpired(jid, nowIso);
    expectV5(result).toBe(true);
    expectV5(s2.get(jid)!.artifactState).toBe('EXPIRED');
    // Status remains APPLIED — never mutated by expiry.
    expectV5(s2.get(jid)!.status).toBe('APPLIED');
    s2.close();
  });

  itV5('markExpired returns false when retain_until has not elapsed', () => {
    const p3 = join(mkdtempSync(join(tmpdir(), 'mcpb-me3-')), 'agents.db');
    const s3 = new AgentJobStore(p3);
    const rdms = 86_400_000;
    const job = s3.insert(newJob({ retentionClass: 'ephemeral', retentionDurationMs: rdms }));
    const jid = job.jobId;
    const futureTs = new Date(Date.now() + 2 * rdms).toISOString();
    const now3 = new Date().toISOString();
    s3.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now3 });
    s3.transition(jid, 'PREPARING', 'RUNNING');
    s3.transition(jid, 'RUNNING', 'VALIDATING');
    s3.publishArtifact(jid, {
      artifactHash: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
      contentComplete: true, applicable: true, reason: null,
      artifactVolume: `io-mcp-ide-bridge-evidence-${jid}`,
      artifactBytes: 100, opCount: 1,
    });
    s3.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now3 });
    const attId3 = `att_${'2'.repeat(32)}`;
    s3.startApplyAttempt({ attemptId: attId3, jobId: jid });
    s3.transitionApplyAttempt(attId3, 'STARTED', 'VERIFYING');
    s3.transitionApplyAttempt(attId3, 'VERIFYING', 'APPLYING');
    s3.markApplySuccess(attId3, jid);
    const rawDb3 = new DatabaseSync(p3);
    rawDb3.prepare('UPDATE agent_jobs SET retain_until = ?, disposition_at = ? WHERE job_id = ?')
      .run(futureTs, futureTs, jid);
    rawDb3.close();

    const nowIso = new Date().toISOString();
    expectV5(s3.markExpired(jid, nowIso)).toBe(false);
    expectV5(s3.get(jid)!.artifactState).toBe('AVAILABLE');
    s3.close();
  });

  itV5('markExpired is idempotent — second call returns false (already EXPIRED)', () => {
    const p4 = join(mkdtempSync(join(tmpdir(), 'mcpb-me4-')), 'agents.db');
    const s4 = new AgentJobStore(p4);
    const rdms = 86_400_000;
    const job = s4.insert(newJob({ retentionClass: 'ephemeral', retentionDurationMs: rdms }));
    const jid = job.jobId;
    const pastTs = new Date(Date.now() - 2 * rdms).toISOString();
    const now4 = new Date().toISOString();
    s4.transition(jid, 'QUEUED', 'PREPARING', { startedAt: now4 });
    s4.transition(jid, 'PREPARING', 'RUNNING');
    s4.transition(jid, 'RUNNING', 'VALIDATING');
    s4.publishArtifact(jid, {
      artifactHash: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
      contentComplete: true, applicable: true, reason: null,
      artifactVolume: `io-mcp-ide-bridge-evidence-${jid}`,
      artifactBytes: 100, opCount: 1,
    });
    s4.transition(jid, 'VALIDATING', 'COMPLETED', { completedAt: now4 });
    const attId4 = `att_${'3'.repeat(32)}`;
    s4.startApplyAttempt({ attemptId: attId4, jobId: jid });
    s4.transitionApplyAttempt(attId4, 'STARTED', 'VERIFYING');
    s4.transitionApplyAttempt(attId4, 'VERIFYING', 'APPLYING');
    s4.markApplySuccess(attId4, jid);
    const rawDb4 = new DatabaseSync(p4);
    rawDb4.prepare('UPDATE agent_jobs SET retain_until = ?, disposition_at = ? WHERE job_id = ?')
      .run(pastTs, pastTs, jid);
    rawDb4.close();

    const nowIso = new Date().toISOString();
    expectV5(s4.markExpired(jid, nowIso)).toBe(true);
    expectV5(s4.markExpired(jid, nowIso)).toBe(false); // already EXPIRED
    expectV5(s4.get(jid)!.artifactState).toBe('EXPIRED');
    s4.close();
  });
});
