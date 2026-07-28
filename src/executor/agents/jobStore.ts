/**
 * Durable agent job store (Phase A2). Executor-owned SQLite persistence via
 * the built-in `node:sqlite` binding (no external dependency).
 *
 * The database is the durable source of job state:
 * - every transition is an atomic compare-and-set (UPDATE ... WHERE status =
 *   expected) validated against the shared A1 state machine first;
 * - claim admission (QUEUED -> PREPARING) runs inside BEGIN IMMEDIATE with
 *   the concurrency checks in the same transaction, so a restart can never
 *   double-admit writers;
 * - the bounded raw prompt is stored ONLY here (queued jobs must survive the
 *   MCP request and executor restarts). It is never logged, never returned by
 *   status/result routes, and its long-term retention is a future
 *   retention-policy concern (A1 retention classes).
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { BridgeError } from '../../shared/errors.js';
import {
  assertAgentJobTransition,
  MAX_AGENT_PROMPT_CHARS,
  type AgentJobStatus,
  type AgentFailureCode,
} from '../../shared/agents.js';

export const AGENT_JOB_SCHEMA_VERSION = 2;

/**
 * Concurrency admission counts EXECUTING jobs only. QUEUED jobs are "active"
 * in the A1 lifecycle sense (they occupy the queue) but hold no execution
 * capacity and no writer lock until claimed.
 */
const EXECUTING_STATUSES = ['PREPARING', 'RUNNING', 'VALIDATING'] as const;
const ACTIVE_SQL_LIST = EXECUTING_STATUSES.map((s) => `'${s}'`).join(',');

export interface AgentJobRow {
  jobId: string;
  principalId: string;
  backend: string;
  project: string;
  profile: string;
  resourcePolicy: string;
  status: AgentJobStatus;
  failureCode: AgentFailureCode | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  promptHash: string;
  prompt: string;
  summary: string | null;
  exitCode: number | null;
  backendSessionId: string | null;
  sessionPolicy: string;
  writer: boolean;
  /** Trusted source base commit for a staged sandbox workspace (A3+). */
  baseCommit: string | null;
}

export interface NewAgentJob {
  jobId: string;
  principalId: string;
  backend: string;
  project: string;
  profile: string;
  resourcePolicy: string;
  promptHash: string;
  prompt: string;
  sessionPolicy: string;
  writer: boolean;
}

export interface TransitionExtras {
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  exitCode?: number;
  failureCode?: AgentFailureCode;
  failureReason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The job DB may hold bounded raw agent prompts, so the SQLite files must be
 * private to the executor runtime identity — not merely protected by the
 * parent directory's mode. SQLite creates the main DB, the `-wal` and the
 * `-shm` files under the process umask (default 022 -> world-readable 0644).
 * Force 0600 on any that exist (idempotent; fixes pre-existing 0644 files
 * without recreating the durable database). Skipped for in-memory DBs.
 */
function restrictSqliteFileModes(path: string): void {
  if (path === ':memory:' || path === '') return;
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(p)) chmodSync(p, 0o600);
  }
}

export class AgentJobStore {
  private db: DatabaseSync;

  constructor(path: string) {
    // Create the DB (and, via WAL, the -wal/-shm sidecars) under a restrictive
    // umask so they are private from creation. Scope is this synchronous
    // constructor only (restored in finally); it never affects other executor
    // runtime file behavior. On every restart/recreation this path runs again,
    // so newly created sidecars are always private.
    const prevUmask = process.umask(0o077);
    try {
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout=5000');
      this.db.exec('PRAGMA foreign_keys=ON');
    } finally {
      process.umask(prevUmask);
    }
    restrictSqliteFileModes(path);
    this.migrate();
  }

  private columnExists(table: string, column: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some((c) => c.name === column);
  }

  /**
   * Explicit, stepwise, forward-only migration. A fresh DB is created directly
   * at the latest shape; an existing A2 (v1) DB is migrated in place with
   * `ALTER TABLE ... ADD COLUMN` so every historical job record is preserved
   * (the durable A2 state is never wiped/recreated).
   */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    const version = Number(row?.user_version ?? 0);
    if (version === AGENT_JOB_SCHEMA_VERSION) return;
    if (version > AGENT_JOB_SCHEMA_VERSION) {
      throw new BridgeError('INTERNAL', `agent job DB schema v${version} is newer than supported v${AGENT_JOB_SCHEMA_VERSION}`, 500);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (version < 1) {
        // Fresh install → create at the latest shape (base_commit included).
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agent_jobs (
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
          CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status);
          CREATE INDEX IF NOT EXISTS idx_agent_jobs_principal ON agent_jobs(principal_id);
        `);
      }
      if (version < 2) {
        // v1 (A2) → v2 (A3): record the trusted base commit of a staged sandbox
        // workspace. Additive; preserves all existing A2 job records.
        if (!this.columnExists('agent_jobs', 'base_commit')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN base_commit TEXT');
        }
      }
      this.db.exec(`PRAGMA user_version=${AGENT_JOB_SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return Number(row.user_version);
  }

  insert(job: NewAgentJob): AgentJobRow {
    if (job.prompt.length > MAX_AGENT_PROMPT_CHARS) {
      throw new BridgeError('MALFORMED_REQUEST', `prompt exceeds ${MAX_AGENT_PROMPT_CHARS} chars`, 400);
    }
    this.db.prepare(`
      INSERT INTO agent_jobs (job_id, principal_id, backend, project, profile, resource_policy,
        status, created_at, prompt_hash, prompt, session_policy, writer)
      VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)
    `).run(job.jobId, job.principalId, job.backend, job.project, job.profile, job.resourcePolicy,
      nowIso(), job.promptHash, job.prompt, job.sessionPolicy, job.writer ? 1 : 0);
    return this.get(job.jobId)!;
  }

  get(jobId: string): AgentJobRow | undefined {
    const r = this.db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(jobId) as Record<string, unknown> | undefined;
    return r ? rowToJob(r) : undefined;
  }

  /**
   * Atomic validated transition. Checks the A1 state machine, then performs a
   * compare-and-set UPDATE keyed on the expected current status. Returns
   * false when the row was not in `from` anymore (a concurrent transition —
   * e.g. cancellation — won the race).
   */
  transition(jobId: string, from: AgentJobStatus, to: AgentJobStatus, extras: TransitionExtras = {}): boolean {
    assertAgentJobTransition(from, to);
    const sets: string[] = ['status = ?'];
    const args: (string | number)[] = [to];
    if (extras.startedAt !== undefined) { sets.push('started_at = ?'); args.push(extras.startedAt); }
    if (extras.completedAt !== undefined) { sets.push('completed_at = ?'); args.push(extras.completedAt); }
    if (extras.summary !== undefined) { sets.push('summary = ?'); args.push(extras.summary); }
    if (extras.exitCode !== undefined) { sets.push('exit_code = ?'); args.push(extras.exitCode); }
    if (extras.failureCode !== undefined) { sets.push('failure_code = ?'); args.push(extras.failureCode); }
    if (extras.failureReason !== undefined) { sets.push('failure_reason = ?'); args.push(extras.failureReason.slice(0, 500)); }
    args.push(jobId, from);
    const res = this.db.prepare(`UPDATE agent_jobs SET ${sets.join(', ')} WHERE job_id = ? AND status = ?`).run(...args);
    return Number(res.changes) === 1;
  }

  /**
   * Record the trusted source base commit for a staged sandbox workspace (A3+).
   * Independent of the status CAS: base state is provenance, set once when a
   * workspace is staged, and must not be re-inferred later from host HEAD.
   */
  setBaseCommit(jobId: string, baseCommit: string): boolean {
    const res = this.db.prepare('UPDATE agent_jobs SET base_commit = ? WHERE job_id = ?').run(baseCommit, jobId);
    return Number(res.changes) === 1;
  }

  countActive(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs WHERE status IN (${ACTIVE_SQL_LIST})`).get() as { n: number };
    return Number(r.n);
  }

  countActiveWriters(project?: string): number {
    const sql = `SELECT COUNT(*) AS n FROM agent_jobs WHERE writer = 1 AND status IN (${ACTIVE_SQL_LIST})` +
      (project !== undefined ? ' AND project = ?' : '');
    const r = (project !== undefined
      ? this.db.prepare(sql).get(project)
      : this.db.prepare(sql).get()) as { n: number };
    return Number(r.n);
  }

  hasQueued(): boolean {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs WHERE status = 'QUEUED'`).get() as { n: number };
    return Number(r.n) > 0;
  }

  /**
   * Claim the next eligible QUEUED job (oldest first) and atomically move it
   * to PREPARING. Admission rules — all persisted, all inside one
   * BEGIN IMMEDIATE transaction (restart-safe, no double admission):
   * - A2 executes jobs serially: no claim while ANY job is active (this
   *   subsumes the writer rules below, which are still checked explicitly so
   *   later phases can relax global serialization without losing them);
   * - max active writer jobs globally: 1;
   * - max active writer jobs per project: 1.
   */
  claimNext(): AgentJobRow | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.countActive() > 0) { this.db.exec('COMMIT'); return undefined; }
      const candidate = this.db.prepare(
        `SELECT job_id, project, writer FROM agent_jobs WHERE status = 'QUEUED' ORDER BY created_at, rowid LIMIT 1`,
      ).get() as { job_id: string; project: string; writer: number } | undefined;
      if (!candidate) { this.db.exec('COMMIT'); return undefined; }
      if (candidate.writer === 1 &&
        (this.countActiveWriters() >= 1 || this.countActiveWriters(candidate.project) >= 1)) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const res = this.db.prepare(
        `UPDATE agent_jobs SET status = 'PREPARING', started_at = ? WHERE job_id = ? AND status = 'QUEUED'`,
      ).run(nowIso(), candidate.job_id);
      this.db.exec('COMMIT');
      if (Number(res.changes) !== 1) return undefined;
      return this.get(candidate.job_id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Startup reconciliation: there is no attachable runner in A2, so any job
   * found in an active execution state after a restart fails closed to
   * FAILED_INFRASTRUCTURE. QUEUED jobs remain QUEUED and eligible.
   * Returns the reconciled job IDs.
   */
  recoverActive(reason: string): string[] {
    const rows = this.db.prepare(
      `SELECT job_id, status FROM agent_jobs WHERE status IN ('PREPARING','RUNNING','VALIDATING')`,
    ).all() as { job_id: string; status: AgentJobStatus }[];
    const recovered: string[] = [];
    for (const r of rows) {
      if (this.transition(r.job_id, r.status, 'FAILED_INFRASTRUCTURE', {
        completedAt: nowIso(),
        failureCode: 'FAILED_INFRASTRUCTURE',
        failureReason: reason,
      })) recovered.push(r.job_id);
    }
    return recovered;
  }

  close(): void {
    this.db.close();
  }
}

function rowToJob(r: Record<string, unknown>): AgentJobRow {
  return {
    jobId: String(r.job_id),
    principalId: String(r.principal_id),
    backend: String(r.backend),
    project: String(r.project),
    profile: String(r.profile),
    resourcePolicy: String(r.resource_policy),
    status: String(r.status) as AgentJobStatus,
    failureCode: (r.failure_code ?? null) as AgentFailureCode | null,
    failureReason: (r.failure_reason ?? null) as string | null,
    createdAt: String(r.created_at),
    startedAt: (r.started_at ?? null) as string | null,
    completedAt: (r.completed_at ?? null) as string | null,
    promptHash: String(r.prompt_hash),
    prompt: String(r.prompt),
    summary: (r.summary ?? null) as string | null,
    exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
    backendSessionId: (r.backend_session_id ?? null) as string | null,
    sessionPolicy: String(r.session_policy),
    writer: Number(r.writer) === 1,
    baseCommit: (r.base_commit ?? null) as string | null,
  };
}
