/**
 * A3 schema migration: an existing A2 (v1) durable DB must migrate to v2
 * IN PLACE, preserving every historical job record. The durable A2 state is
 * never wiped or recreated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentJobStore, AGENT_JOB_SCHEMA_VERSION } from '../../src/executor/agents/jobStore.js';

/** Build a realistic A2 (v1) DB by hand: the exact v1 table + user_version=1. */
function seedV1Db(path: string, rows: number): string[] {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE agent_jobs (
      job_id             TEXT PRIMARY KEY,
      principal_id       TEXT NOT NULL,
      backend            TEXT NOT NULL,
      project            TEXT NOT NULL,
      profile            TEXT NOT NULL,
      resource_policy    TEXT NOT NULL,
      status             TEXT NOT NULL,
      failure_code       TEXT,
      failure_reason     TEXT,
      created_at         TEXT NOT NULL,
      started_at         TEXT,
      completed_at       TEXT,
      prompt_hash        TEXT NOT NULL,
      prompt             TEXT NOT NULL,
      summary            TEXT,
      exit_code          INTEGER,
      backend_session_id TEXT,
      session_policy     TEXT NOT NULL DEFAULT 'new',
      writer             INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_agent_jobs_status ON agent_jobs(status);
    CREATE INDEX idx_agent_jobs_principal ON agent_jobs(principal_id);
  `);
  const ids: string[] = [];
  for (let i = 0; i < rows; i++) {
    const id = `job_${i.toString(16).padStart(32, '0')}`;
    ids.push(id);
    db.prepare(`INSERT INTO agent_jobs (job_id, principal_id, backend, project, profile, resource_policy, status, created_at, prompt_hash, prompt, session_policy, writer)
      VALUES (?, 'p', 'kiro', 'proj', 'audit', 'economy', 'COMPLETED', ?, 'hash', 'legacy prompt', 'new', 0)`)
      .run(id, new Date().toISOString());
  }
  db.exec('PRAGMA user_version=1');
  db.close();
  return ids;
}

describe('A3 job store migration v1 -> v2', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-migrate-')), 'agents.db');
  });

  it('migrates a populated v1 DB to v2, preserving all records', () => {
    const ids = seedV1Db(dbPath, 12); // >10 A2 records, per A3 requirement

    const store = new AgentJobStore(dbPath); // opening runs migrate()
    expect(store.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
    expect(store.schemaVersion).toBe(2);

    for (const id of ids) {
      const got = store.get(id);
      expect(got, `record ${id} preserved`).toBeTruthy();
      expect(got!.status).toBe('COMPLETED');
      expect(got!.prompt).toBe('legacy prompt');
      expect(got!.baseCommit).toBeNull(); // new column defaults NULL for legacy rows
    }
    store.close();
  });

  it('adds base_commit and lets it be set once as provenance', () => {
    const [id] = seedV1Db(dbPath, 1);
    const store = new AgentJobStore(dbPath);
    expect(store.get(id!)!.baseCommit).toBeNull();
    expect(store.setBaseCommit(id!, 'a'.repeat(40))).toBe(true);
    expect(store.get(id!)!.baseCommit).toBe('a'.repeat(40));
    store.close();
  });

  it('is idempotent: reopening a v2 DB does not disturb records', () => {
    const ids = seedV1Db(dbPath, 3);
    new AgentJobStore(dbPath).close(); // v1 -> v2
    const reopened = new AgentJobStore(dbPath); // v2 -> v2 (no-op)
    expect(reopened.schemaVersion).toBe(2);
    for (const id of ids) expect(reopened.get(id)).toBeTruthy();
    reopened.close();
  });

  it('refuses to open a DB from a newer future schema', () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE agent_jobs (job_id TEXT PRIMARY KEY)');
    db.exec('PRAGMA user_version=99');
    db.close();
    expect(() => new AgentJobStore(dbPath)).toThrow(/newer than supported/);
  });
});
