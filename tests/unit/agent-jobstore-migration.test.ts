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

/** Build a realistic A3/A5 (v2) DB by hand: the exact v2 table + user_version=2. */
function seedV2Db(path: string, rows: number): string[] {
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
      writer             INTEGER NOT NULL DEFAULT 0,
      base_commit        TEXT
    );
    CREATE INDEX idx_agent_jobs_status ON agent_jobs(status);
    CREATE INDEX idx_agent_jobs_principal ON agent_jobs(principal_id);
  `);
  const ids: string[] = [];
  for (let i = 0; i < rows; i++) {
    const id = `job_${i.toString(16).padStart(32, '0')}`;
    ids.push(id);
    db.prepare(`INSERT INTO agent_jobs (job_id, principal_id, backend, project, profile, resource_policy, status, created_at, prompt_hash, prompt, session_policy, writer, base_commit)
      VALUES (?, 'p', 'kiro', 'proj', 'implement', 'economy', 'COMPLETED', ?, 'hash', 'legacy v2 prompt', 'new', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`)
      .run(id, new Date().toISOString());
  }
  db.exec('PRAGMA user_version=2');
  db.close();
  return ids;
}

describe('A6-B1 job store migration v2 -> v3', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-migrate-v2-')), 'agents.db');
  });

  it('migrates a populated v2 DB to v3, preserving all records including base_commit', () => {
    const ids = seedV2Db(dbPath, 12);

    const store = new AgentJobStore(dbPath);
    expect(store.schemaVersion).toBe(4);

    for (const id of ids) {
      const got = store.get(id);
      expect(got, `record ${id} preserved`).toBeTruthy();
      expect(got!.status).toBe('COMPLETED');
      expect(got!.prompt).toBe('legacy v2 prompt');
      expect(got!.baseCommit).toBe('a'.repeat(40)); // v2 provenance survives migration
      expect(got!.appliedAt).toBeNull(); // new v3 column defaults NULL for legacy rows
      expect(got!.dispositionAt).toBeNull(); // new v3 column defaults NULL for legacy rows
      expect(got!.writer).toBe(true);
    }
    store.close();
  });

  it('creates empty apply-state tables on migration (no pre-existing quarantine/attempts)', () => {
    const [id] = seedV2Db(dbPath, 1);
    const store = new AgentJobStore(dbPath);
    expect(store.isProjectApplyAllowed('proj')).toBe(true);
    expect(store.listApplyAttemptsForJob(id!)).toEqual([]);
    store.close();
  });

  it('is idempotent: reopening a migrated v3 DB does not disturb records', () => {
    const ids = seedV2Db(dbPath, 3);
    new AgentJobStore(dbPath).close(); // v2 -> v3
    const reopened = new AgentJobStore(dbPath); // v3 -> v3 (no-op)
    expect(reopened.schemaVersion).toBe(4);
    for (const id of ids) expect(reopened.get(id)).toBeTruthy();
    reopened.close();
  });
});

describe('A3 job store migration v1 -> current (v3)', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-migrate-')), 'agents.db');
  });

  it('migrates a populated v1 DB straight to the current schema, preserving all records', () => {
    const ids = seedV1Db(dbPath, 12); // >10 A2 records, per A3 requirement

    const store = new AgentJobStore(dbPath); // opening runs migrate() cumulatively (v1 -> v2 -> v3)
    expect(store.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
    expect(store.schemaVersion).toBe(4);

    for (const id of ids) {
      const got = store.get(id);
      expect(got, `record ${id} preserved`).toBeTruthy();
      expect(got!.status).toBe('COMPLETED');
      expect(got!.prompt).toBe('legacy prompt');
      expect(got!.baseCommit).toBeNull(); // v2 column defaults NULL for legacy rows
      expect(got!.appliedAt).toBeNull(); // v3 column defaults NULL for legacy rows
      expect(got!.dispositionAt).toBeNull(); // v3 column defaults NULL for legacy rows
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

  it('is idempotent: reopening a current-schema DB does not disturb records', () => {
    const ids = seedV1Db(dbPath, 3);
    new AgentJobStore(dbPath).close(); // v1 -> v3
    const reopened = new AgentJobStore(dbPath); // v3 -> v3 (no-op)
    expect(reopened.schemaVersion).toBe(4);
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

// =============================================================================
// A6-B1 Remediation: artifact cache/index metadata columns (schema v3)
// =============================================================================

const ARTIFACT_COLUMNS = [
  'artifact_hash',
  'change_set_hash',
  'artifact_state',
  'artifact_content_complete',
  'artifact_applicable',
  'artifact_reason',
  'artifact_volume',
  'artifact_bytes',
  'artifact_op_count',
] as const;

describe('A6-B1 artifact metadata columns — fresh v3 schema', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-artifact-fresh-')), 'agents.db');
  });

  it('fresh v3 DB contains all nine required artifact metadata columns', () => {
    const store = new AgentJobStore(dbPath);
    expect(store.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
    expect(store.schemaVersion).toBe(4);
    store.close();

    const db = new DatabaseSync(dbPath);
    const cols = (db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    for (const col of ARTIFACT_COLUMNS) {
      expect(cols, `column '${col}' must be present in fresh v3 schema`).toContain(col);
    }
  });

  it('artifact_hash and change_set_hash are separate, independent nullable TEXT columns', () => {
    new AgentJobStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    const info = db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string; type: string; notnull: number }[];
    db.close();

    const ah = info.find((c) => c.name === 'artifact_hash');
    const csh = info.find((c) => c.name === 'change_set_hash');
    expect(ah, 'artifact_hash column must exist').toBeTruthy();
    expect(csh, 'change_set_hash column must exist').toBeTruthy();
    expect(ah!.type.toUpperCase()).toContain('TEXT');
    expect(csh!.type.toUpperCase()).toContain('TEXT');
    expect(ah!.notnull).toBe(0); // nullable
    expect(csh!.notnull).toBe(0); // nullable
    expect(ah!.name).not.toBe(csh!.name); // distinct columns
  });

  it('agent_jobs schema contains no BLOB column (artifact payload must not be stored in SQLite)', () => {
    new AgentJobStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    const cols = db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string; type: string }[];
    db.close();
    for (const col of cols) {
      expect(col.type.toUpperCase(), `column '${col.name}' must not be BLOB`).not.toContain('BLOB');
    }
  });

  it('all nine artifact metadata columns on a freshly inserted row are NULL (no fabricated state)', () => {
    const store = new AgentJobStore(dbPath);
    const id = 'job_' + 'a'.repeat(32);
    store.insert({
      jobId: id,
      principalId: 'owner',
      backend: 'kiro',
      project: 'proj',
      profile: 'audit',
      resourcePolicy: 'economy',
      promptHash: 'b'.repeat(64),
      prompt: 'test',
      sessionPolicy: 'new',
      writer: false,
    });
    store.close();

    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(id) as Record<string, unknown>;
    db.close();
    for (const col of ARTIFACT_COLUMNS) {
      expect(row[col], `'${col}' on a freshly inserted row must be NULL`).toBeNull();
    }
  });
});

describe('A6-B1 artifact metadata columns — v2→v3 migration', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-artifact-v2-')), 'agents.db');
  });

  it('v2→v3 migration adds all nine artifact metadata columns', () => {
    seedV2Db(dbPath, 3);
    const store = new AgentJobStore(dbPath);
    expect(store.schemaVersion).toBe(4);
    store.close();

    const db = new DatabaseSync(dbPath);
    const cols = (db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    for (const col of ARTIFACT_COLUMNS) {
      expect(cols, `column '${col}' must be present after v2→v3 migration`).toContain(col);
    }
  });

  it('historical v2 rows migrate with NULL for all artifact metadata columns (no fabrication)', () => {
    const ids = seedV2Db(dbPath, 5);
    new AgentJobStore(dbPath).close();

    const db = new DatabaseSync(dbPath);
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(id) as Record<string, unknown>;
      for (const col of ARTIFACT_COLUMNS) {
        expect(row[col], `'${col}' for migrated v2 row ${id} must be NULL`).toBeNull();
      }
    }
    db.close();
  });

  it('artifact_state for migrated v2 rows is NULL (never AVAILABLE or EXPIRED)', () => {
    const ids = seedV2Db(dbPath, 4);
    new AgentJobStore(dbPath).close();

    const db = new DatabaseSync(dbPath);
    for (const id of ids) {
      const row = db.prepare('SELECT artifact_state FROM agent_jobs WHERE job_id = ?').get(id) as { artifact_state: string | null };
      const v = row.artifact_state;
      expect(v, `artifact_state for ${id} must be NULL`).toBeNull();
      expect(v).not.toBe('AVAILABLE');
      expect(v).not.toBe('EXPIRED');
      expect(v).not.toBe('NONE'); // NULL, not a fabricated sentinel
    }
    db.close();
  });

  it('artifact_content_complete for migrated v2 rows is NULL, never 1', () => {
    const ids = seedV2Db(dbPath, 3);
    new AgentJobStore(dbPath).close();

    const db = new DatabaseSync(dbPath);
    for (const id of ids) {
      const row = db.prepare('SELECT artifact_content_complete FROM agent_jobs WHERE job_id = ?').get(id) as { artifact_content_complete: number | null };
      expect(row.artifact_content_complete, `artifact_content_complete for ${id} must be NULL`).toBeNull();
      expect(row.artifact_content_complete).not.toBe(1);
    }
    db.close();
  });

  it('artifact_applicable for migrated v2 rows is NULL, never 1', () => {
    const ids = seedV2Db(dbPath, 3);
    new AgentJobStore(dbPath).close();

    const db = new DatabaseSync(dbPath);
    for (const id of ids) {
      const row = db.prepare('SELECT artifact_applicable FROM agent_jobs WHERE job_id = ?').get(id) as { artifact_applicable: number | null };
      expect(row.artifact_applicable, `artifact_applicable for ${id} must be NULL`).toBeNull();
      expect(row.artifact_applicable).not.toBe(1);
    }
    db.close();
  });

  it('v2→v3 migration preserves all pre-existing v2 job fields intact', () => {
    const ids = seedV2Db(dbPath, 3);
    const store = new AgentJobStore(dbPath);
    for (const id of ids) {
      const got = store.get(id)!;
      expect(got, `record ${id} preserved`).toBeTruthy();
      expect(got.status).toBe('COMPLETED');
      expect(got.prompt).toBe('legacy v2 prompt');
      expect(got.baseCommit).toBe('a'.repeat(40));
      expect(got.writer).toBe(true);
      expect(got.principalId).toBe('p');
      expect(got.backend).toBe('kiro');
      expect(got.project).toBe('proj');
      // All artifact fields NULL — never fabricated
      expect(got.artifactHash).toBeNull();
      expect(got.changeSetHash).toBeNull();
      expect(got.artifactState).toBeNull();
      expect(got.artifactContentComplete).toBeNull();
      expect(got.artifactApplicable).toBeNull();
      expect(got.artifactReason).toBeNull();
      expect(got.artifactVolume).toBeNull();
      expect(got.artifactBytes).toBeNull();
      expect(got.artifactOpCount).toBeNull();
    }
    store.close();
  });

  it('base_commit is preserved as provenance through v2→v3 migration', () => {
    const [id] = seedV2Db(dbPath, 1);
    const store = new AgentJobStore(dbPath);
    expect(store.get(id!)!.baseCommit).toBe('a'.repeat(40));
    store.close();
  });
});

describe('A6-B1 artifact metadata columns — v1→v3 migration', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-artifact-v1-')), 'agents.db');
  });

  it('v1→v3 migration adds all nine artifact metadata columns', () => {
    seedV1Db(dbPath, 3);
    const store = new AgentJobStore(dbPath);
    expect(store.schemaVersion).toBe(4);
    store.close();

    const db = new DatabaseSync(dbPath);
    const cols = (db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    for (const col of ARTIFACT_COLUMNS) {
      expect(cols, `column '${col}' must be present after v1→v3 migration`).toContain(col);
    }
  });

  it('historical v1 rows migrate with NULL for all artifact metadata columns (no fabrication)', () => {
    const ids = seedV1Db(dbPath, 5);
    new AgentJobStore(dbPath).close();

    const db = new DatabaseSync(dbPath);
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(id) as Record<string, unknown>;
      for (const col of ARTIFACT_COLUMNS) {
        expect(row[col], `'${col}' for migrated v1 row ${id} must be NULL`).toBeNull();
      }
    }
    db.close();
  });
});

describe('A6-B1 artifact metadata columns — fresh-v3 and migrated-v3 schema equivalence', () => {
  it('fresh v3 and migrated-v3 (from v2) have identical agent_jobs column sets', () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'mcpb-fresh-eq-'));
    const migratedDir = mkdtempSync(join(tmpdir(), 'mcpb-migrated-eq-'));
    const freshPath = join(freshDir, 'agents.db');
    const migratedPath = join(migratedDir, 'agents.db');

    new AgentJobStore(freshPath).close();
    seedV2Db(migratedPath, 1);
    new AgentJobStore(migratedPath).close();

    const dbFresh = new DatabaseSync(freshPath);
    const dbMigrated = new DatabaseSync(migratedPath);
    const freshCols = (dbFresh.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name).sort();
    const migratedCols = (dbMigrated.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name).sort();
    dbFresh.close();
    dbMigrated.close();

    expect(freshCols).toEqual(migratedCols);
  });

  it('migration v3→v3 re-open is idempotent for artifact metadata columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-idem2-'));
    const p = join(dir, 'agents.db');
    seedV2Db(p, 2);
    new AgentJobStore(p).close(); // v2→v3
    const reopened = new AgentJobStore(p); // v3→v3 (no-op)
    expect(reopened.schemaVersion).toBe(4);
    reopened.close();

    const db = new DatabaseSync(p);
    const cols = (db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    for (const col of ARTIFACT_COLUMNS) {
      expect(cols, `column '${col}' preserved after idempotent re-open`).toContain(col);
    }
  });
});
