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
import { AGENT_RETENTION_DURATION_MS } from '../../src/shared/agents.js';
import { BridgeError } from '../../src/shared/errors.js';

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
    expect(store.schemaVersion).toBe(5);

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
    expect(reopened.schemaVersion).toBe(5);
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
    expect(store.schemaVersion).toBe(5);

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
    expect(reopened.schemaVersion).toBe(5);
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
    expect(store.schemaVersion).toBe(5);
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
      retentionClass: 'ephemeral',
      retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral,
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
    expect(store.schemaVersion).toBe(5);
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
    expect(store.schemaVersion).toBe(5);
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
    expect(reopened.schemaVersion).toBe(5);
    reopened.close();

    const db = new DatabaseSync(p);
    const cols = (db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    for (const col of ARTIFACT_COLUMNS) {
      expect(cols, `column '${col}' preserved after idempotent re-open`).toContain(col);
    }
  });
});

// =============================================================================
// A6 v4→v5 migration: durable retention snapshot columns
// =============================================================================

/** Build a realistic v4 DB by hand: exact v4 shape (includes apply journal) + user_version=4. */
function seedV4Db(path: string, rows: number): string[] {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  // v4 agent_jobs: includes all v3 columns + nothing else (no retention columns).
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
      base_commit        TEXT,
      applied_at         TEXT,
      disposition_at     TEXT,
      artifact_hash      TEXT,
      change_set_hash    TEXT,
      artifact_state     TEXT,
      artifact_content_complete INTEGER,
      artifact_applicable       INTEGER,
      artifact_reason    TEXT,
      artifact_volume    TEXT,
      artifact_bytes     INTEGER,
      artifact_op_count  INTEGER
    );
    CREATE INDEX idx_agent_jobs_status ON agent_jobs(status);
    CREATE INDEX idx_agent_jobs_principal ON agent_jobs(principal_id);
    CREATE TABLE IF NOT EXISTS agent_project_apply_state (
      project_id                   TEXT PRIMARY KEY,
      state                        TEXT NOT NULL DEFAULT 'NORMAL',
      quarantined_at               TEXT,
      quarantine_causing_job_id    TEXT,
      quarantine_causing_attempt_id TEXT,
      quarantine_reason            TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_apply_attempts (
      attempt_id             TEXT PRIMARY KEY,
      job_id                 TEXT NOT NULL REFERENCES agent_jobs(job_id),
      project_id             TEXT NOT NULL,
      principal_id           TEXT,
      expected_artifact_hash TEXT,
      base_commit            TEXT,
      state                  TEXT NOT NULL,
      reason                 TEXT,
      started_at             TEXT NOT NULL,
      finished_at            TEXT,
      success_evidence       TEXT,
      rollback_evidence      TEXT,
      mutated_path_count     INTEGER,
      applier_image          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_apply_attempts_job ON agent_apply_attempts(job_id);
    CREATE INDEX IF NOT EXISTS idx_apply_attempts_project ON agent_apply_attempts(project_id);
    -- The partial unique indexes ARE the active-attempt exclusion authority and
    -- are created by the real v3 migration, so every genuine v4 database has
    -- them. Reproduce them here or this fixture is not a realistic v4 DB.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apply_attempts_active_job
      ON agent_apply_attempts(job_id) WHERE state IN ('STARTED','VERIFYING','APPLYING');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apply_attempts_active_project
      ON agent_apply_attempts(project_id) WHERE state IN ('STARTED','VERIFYING','APPLYING');
    CREATE TABLE IF NOT EXISTS agent_apply_journal (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id          TEXT NOT NULL REFERENCES agent_apply_attempts(attempt_id),
      op_index            INTEGER NOT NULL,
      path                TEXT NOT NULL,
      op                  TEXT NOT NULL,
      before_existed      INTEGER,
      before_content_hash TEXT,
      before_mode         INTEGER,
      created_dirs        TEXT,
      completed_at        TEXT NOT NULL,
      UNIQUE(attempt_id, op_index)
    );
    CREATE INDEX IF NOT EXISTS idx_apply_journal_attempt ON agent_apply_journal(attempt_id);
  `);
  const ids: string[] = [];
  for (let i = 0; i < rows; i++) {
    const id = `job_${i.toString(16).padStart(32, '0')}`;
    ids.push(id);
    db.prepare(`
      INSERT INTO agent_jobs
        (job_id, principal_id, backend, project, profile, resource_policy,
         status, created_at, prompt_hash, prompt, session_policy, writer,
         base_commit, applied_at, disposition_at, artifact_state)
      VALUES (?, 'p', 'kiro', 'proj', 'implement', 'economy',
              'APPLIED', ?, 'hash', 'v4 prompt', 'new', 1,
              ?, ?, ?, 'AVAILABLE')
    `).run(
      id, new Date().toISOString(),
      'b'.repeat(40),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }
  db.exec('PRAGMA user_version=4');
  db.close();
  return ids;
}

const RETENTION_COLUMNS = ['retention_class', 'retention_duration_ms', 'retain_until'] as const;

describe('A6 job store migration v4 → v5 (durable retention snapshot)', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-migrate-v4-')), 'agents.db');
  });

  it('migrates a populated v4 DB to v5 and reaches user_version=5', () => {
    seedV4Db(dbPath, 5);
    const store = new AgentJobStore(dbPath);
    expect(store.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
    expect(store.schemaVersion).toBe(5);
    store.close();
  });

  it('v4→v5 migration adds all three retention columns', () => {
    seedV4Db(dbPath, 3);
    const store = new AgentJobStore(dbPath);
    store.close();

    const db = new DatabaseSync(dbPath);
    const cols = (db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    for (const col of RETENTION_COLUMNS) {
      expect(cols, `column '${col}' must be present after v4→v5`).toContain(col);
    }
  });

  it('legacy v4 rows have NULL for all three retention columns after migration (no backfill)', () => {
    const ids = seedV4Db(dbPath, 6);
    new AgentJobStore(dbPath).close();

    const db = new DatabaseSync(dbPath);
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(id) as Record<string, unknown>;
      for (const col of RETENTION_COLUMNS) {
        expect(row[col], `'${col}' for migrated v4 row ${id} must be NULL (no backfill)`).toBeNull();
      }
    }
    db.close();
  });

  it('legacy v4 rows retain_until is NULL specifically (no fabricated expiry)', () => {
    const ids = seedV4Db(dbPath, 4);
    new AgentJobStore(dbPath).close();

    const db = new DatabaseSync(dbPath);
    for (const id of ids) {
      const row = db.prepare('SELECT retain_until FROM agent_jobs WHERE job_id = ?').get(id) as { retain_until: string | null };
      expect(row.retain_until, `retain_until for ${id} must be NULL`).toBeNull();
    }
    db.close();
  });

  it('v4→v5 migration preserves all pre-existing v4 job fields intact', () => {
    const ids = seedV4Db(dbPath, 4);
    const store = new AgentJobStore(dbPath);
    for (const id of ids) {
      const got = store.get(id)!;
      expect(got).toBeTruthy();
      expect(got.status).toBe('APPLIED');
      expect(got.prompt).toBe('v4 prompt');
      expect(got.baseCommit).toBe('b'.repeat(40));
      expect(got.appliedAt).not.toBeNull();
      expect(got.dispositionAt).not.toBeNull();
      expect(got.artifactState).toBe('AVAILABLE');
      expect(got.writer).toBe(true);
      // Retention columns NULL — never fabricated
      expect(got.retentionClass).toBeNull();
      expect(got.retentionDurationMs).toBeNull();
      expect(got.retainUntil).toBeNull();
    }
    store.close();
  });

  it('migration v4→v5 is idempotent (re-open does not disturb records)', () => {
    const ids = seedV4Db(dbPath, 3);
    new AgentJobStore(dbPath).close(); // v4 → v5
    const reopened = new AgentJobStore(dbPath); // v5 → v5 (no-op)
    expect(reopened.schemaVersion).toBe(5);
    for (const id of ids) expect(reopened.get(id)).toBeTruthy();
    reopened.close();
  });
});

describe('A6 fresh-v5 vs migrated-v5 schema equivalence', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-fresh-v5-shape-')), 'agents.db');
  });

  it('fresh-v5 and migrated-v5 (from v4) have identical agent_jobs column sets', () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'mcpb-fresh-v5-'));
    const migratedDir = mkdtempSync(join(tmpdir(), 'mcpb-migrated-v5-'));
    const freshPath = join(freshDir, 'agents.db');
    const migratedPath = join(migratedDir, 'agents.db');

    // Fresh v5 install.
    new AgentJobStore(freshPath).close();

    // Migrate a v4 DB to v5.
    seedV4Db(migratedPath, 2);
    new AgentJobStore(migratedPath).close();

    const dbFresh = new DatabaseSync(freshPath);
    const dbMigrated = new DatabaseSync(migratedPath);
    const freshCols = (dbFresh.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name).sort();
    const migratedCols = (dbMigrated.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name).sort();
    dbFresh.close();
    dbMigrated.close();

    expect(freshCols).toEqual(migratedCols);
  });

  it('fresh-v5 includes all three retention columns as nullable', () => {
    const store = new AgentJobStore(dbPath);
    store.close();

    const db = new DatabaseSync(dbPath);
    const info = db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string; type: string; notnull: number }[];
    db.close();

    for (const col of RETENTION_COLUMNS) {
      const c = info.find((r) => r.name === col);
      expect(c, `column '${col}' must exist in fresh v5 schema`).toBeTruthy();
      expect(c!.notnull, `column '${col}' must be nullable`).toBe(0);
    }
  });

  it('retention_class is TEXT, retention_duration_ms is INTEGER, retain_until is TEXT', () => {
    const store = new AgentJobStore(dbPath);
    store.close();

    const db = new DatabaseSync(dbPath);
    const info = db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string; type: string }[];
    db.close();

    const rc = info.find((c) => c.name === 'retention_class');
    const rdms = info.find((c) => c.name === 'retention_duration_ms');
    const ru = info.find((c) => c.name === 'retain_until');

    expect(rc!.type.toUpperCase()).toBe('TEXT');
    expect(rdms!.type.toUpperCase()).toBe('INTEGER');
    expect(ru!.type.toUpperCase()).toBe('TEXT');
  });
});

describe('A6 v4→v5 migration atomicity', () => {
  it('migration failure leaves DB at v4 (transaction rolls back)', () => {
    // Simulate a partially migrated DB: v4 schema but one column already
    // exists. The columnExists() guard ensures the migration is additive
    // and idempotent — re-running on a partially migrated DB does not fail.
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-partial-'));
    const p = join(dir, 'agents.db');
    seedV4Db(p, 2);

    // Manually add one of the three columns so it "already exists".
    const db = new DatabaseSync(p);
    db.exec('ALTER TABLE agent_jobs ADD COLUMN retention_class TEXT');
    // Leave user_version at 4 to simulate a partial migration that crashed.
    db.close();

    // Opening should complete the migration cleanly (columnExists guard skips
    // the already-added column and adds the remaining two).
    const store = new AgentJobStore(p);
    expect(store.schemaVersion).toBe(5);
    store.close();

    const db2 = new DatabaseSync(p);
    const cols = (db2.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name);
    db2.close();
    for (const col of RETENTION_COLUMNS) {
      expect(cols).toContain(col);
    }
  });
});

// =============================================================================
// A6 remediation F5: a bare `user_version = 5` stamp is NOT proof of a v5 DB.
//
// The live jobs database was stamped v5 by an out-of-tree runtime, so the
// store must verify the real schema shape before accepting a database that
// claims the supported version — and must never repair or backfill it.
// =============================================================================

describe('A6 v5 schema shape validation (stamp is not proof)', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-v5-shape-')), 'agents.db');
  });

  /** A v4 database stamped v5 without ever gaining the v5 columns. */
  function seedFalselyStampedV5(path: string, rows = 2): string[] {
    const ids = seedV4Db(path, rows);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=5');
    db.close();
    return ids;
  }

  it('accepts a genuine fresh v5 DB on re-open (positive control)', () => {
    new AgentJobStore(dbPath).close();
    const reopened = new AgentJobStore(dbPath);
    expect(reopened.schemaVersion).toBe(AGENT_JOB_SCHEMA_VERSION);
    reopened.close();
  });

  it('accepts a genuine migrated v5 DB on re-open (positive control)', () => {
    seedV4Db(dbPath, 3);
    new AgentJobStore(dbPath).close(); // v4 -> v5
    const reopened = new AgentJobStore(dbPath);
    expect(reopened.schemaVersion).toBe(5);
    reopened.close();
  });

  it('user_version=5 with NO retention columns → fails closed', () => {
    seedFalselyStampedV5(dbPath, 2);
    expect(() => new AgentJobStore(dbPath)).toThrow(BridgeError);
    expect(() => new AgentJobStore(dbPath)).toThrow(/stamped schema v5 but its schema is incomplete/);
  });

  it('the fail-closed error names every missing retention column', () => {
    seedFalselyStampedV5(dbPath, 1);
    let msg = '';
    try { new AgentJobStore(dbPath); } catch (e) { msg = (e as Error).message; }
    for (const col of RETENTION_COLUMNS) {
      expect(msg, `error must name agent_jobs.${col}`).toContain(`agent_jobs.${col}`);
    }
  });

  it.each(RETENTION_COLUMNS)('user_version=5 missing only %s → fails closed', (missingCol) => {
    seedV4Db(dbPath, 1);
    const db = new DatabaseSync(dbPath);
    // Add the other two retention columns, leave `missingCol` absent, stamp v5.
    for (const col of RETENTION_COLUMNS) {
      if (col === missingCol) continue;
      db.exec(`ALTER TABLE agent_jobs ADD COLUMN ${col} ${col === 'retention_duration_ms' ? 'INTEGER' : 'TEXT'}`);
    }
    db.exec('PRAGMA user_version=5');
    db.close();

    expect(() => new AgentJobStore(dbPath)).toThrow(BridgeError);
    let msg = '';
    try { new AgentJobStore(dbPath); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(`agent_jobs.${missingCol}`);
  });

  it('user_version=5 with a retention column of the WRONG affinity → fails closed', () => {
    seedV4Db(dbPath, 1);
    const db = new DatabaseSync(dbPath);
    db.exec('ALTER TABLE agent_jobs ADD COLUMN retention_class TEXT');
    // retention_duration_ms declared TEXT instead of INTEGER.
    db.exec('ALTER TABLE agent_jobs ADD COLUMN retention_duration_ms TEXT');
    db.exec('ALTER TABLE agent_jobs ADD COLUMN retain_until TEXT');
    db.exec('PRAGMA user_version=5');
    db.close();

    let msg = '';
    try { new AgentJobStore(dbPath); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('retention_duration_ms has type TEXT, expected INTEGER');
  });

  it('user_version=5 missing a required apply-lifecycle table → fails closed', () => {
    seedV4Db(dbPath, 1);
    const db = new DatabaseSync(dbPath);
    for (const col of RETENTION_COLUMNS) {
      db.exec(`ALTER TABLE agent_jobs ADD COLUMN ${col} ${col === 'retention_duration_ms' ? 'INTEGER' : 'TEXT'}`);
    }
    db.exec('DROP TABLE agent_apply_journal');
    db.exec('PRAGMA user_version=5');
    db.close();

    let msg = '';
    try { new AgentJobStore(dbPath); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('table agent_apply_journal');
  });

  it('user_version=5 missing the active-attempt exclusion indexes → fails closed', () => {
    seedV4Db(dbPath, 1);
    const db = new DatabaseSync(dbPath);
    for (const col of RETENTION_COLUMNS) {
      db.exec(`ALTER TABLE agent_jobs ADD COLUMN ${col} ${col === 'retention_duration_ms' ? 'INTEGER' : 'TEXT'}`);
    }
    db.exec('DROP INDEX idx_apply_attempts_active_job');
    db.exec('PRAGMA user_version=5');
    db.close();

    let msg = '';
    try { new AgentJobStore(dbPath); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('index idx_apply_attempts_active_job');
  });

  it('a rejected malformed v5 DB is NOT repaired, backfilled, or re-stamped', () => {
    const ids = seedFalselyStampedV5(dbPath, 3);
    expect(() => new AgentJobStore(dbPath)).toThrow(BridgeError);

    const db = new DatabaseSync(dbPath);
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const cols = (db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get() as { n: number };
    const sample = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(ids[0]!) as Record<string, unknown>;
    db.close();

    expect(uv.user_version).toBe(5);            // untouched — no re-stamp
    expect(Number(rows.n)).toBe(3);             // no rows destroyed
    expect(sample.prompt).toBe('v4 prompt');    // historical data intact
    for (const col of RETENTION_COLUMNS) {
      expect(cols, `${col} must NOT be silently added`).not.toContain(col);
    }
  });
});

// =============================================================================
// A6 remediation: downgrade / newer-than-supported schema
// =============================================================================

describe('A6 newer-than-supported schema fails closed (no downgrade)', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'mcpb-newer-')), 'agents.db');
  });

  it('user_version = AGENT_JOB_SCHEMA_VERSION + 1 → constructor throws', () => {
    seedV4Db(dbPath, 2);
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version=${AGENT_JOB_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => new AgentJobStore(dbPath)).toThrow(BridgeError);
    expect(() => new AgentJobStore(dbPath)).toThrow(/newer than supported/);
  });

  it('a newer-schema DB is never downgraded or destructively migrated', () => {
    const ids = seedV4Db(dbPath, 4);
    const db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version=${AGENT_JOB_SCHEMA_VERSION + 1}`);
    db.close();

    expect(() => new AgentJobStore(dbPath)).toThrow(/newer than supported/);

    const after = new DatabaseSync(dbPath);
    const uv = after.prepare('PRAGMA user_version').get() as { user_version: number };
    const rows = after.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get() as { n: number };
    const sample = after.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(ids[0]!) as Record<string, unknown>;
    after.close();

    expect(uv.user_version).toBe(AGENT_JOB_SCHEMA_VERSION + 1); // NOT downgraded
    expect(Number(rows.n)).toBe(4);                             // nothing wiped
    expect(sample.prompt).toBe('v4 prompt');
  });

  it('a far-future schema version also fails closed', () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE agent_jobs (job_id TEXT PRIMARY KEY)');
    db.exec('PRAGMA user_version=9999');
    db.close();
    expect(() => new AgentJobStore(dbPath)).toThrow(/newer than supported/);
  });
});
