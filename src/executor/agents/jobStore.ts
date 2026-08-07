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
  assertApplyAttemptTransition,
  MAX_AGENT_PROMPT_CHARS,
  AGENT_APPLY_ATTEMPT_ACTIVE_STATES,
  type AgentJobStatus,
  type AgentFailureCode,
  type AgentApplyAttemptState,
  type AgentProjectApplyState,
  type ArtifactState,
} from '../../shared/agents.js';

export const AGENT_JOB_SCHEMA_VERSION = 4;

/**
 * Concurrency admission counts EXECUTING jobs only. QUEUED jobs are "active"
 * in the A1 lifecycle sense (they occupy the queue) but hold no execution
 * capacity and no writer lock until claimed.
 */
const EXECUTING_STATUSES = ['PREPARING', 'RUNNING', 'VALIDATING'] as const;
const ACTIVE_SQL_LIST = EXECUTING_STATUSES.map((s) => `'${s}'`).join(',');

/** apply-attempt states during which the attempt owns exclusive admission (see shared/agents.ts). */
const ACTIVE_ATTEMPT_SQL_LIST = AGENT_APPLY_ATTEMPT_ACTIVE_STATES.map((s) => `'${s}'`).join(',');

/**
 * Bounded persistence-only evidence fields (Phase A6). These never hold raw
 * artifact bytes — the canonical apply authority is the verified
 * manifest.json + content-addressed blobs (outside SQLite); these columns
 * are cache/index/status/audit only, per the locked A6 architecture.
 */
export const MAX_APPLY_ATTEMPT_REASON_CHARS = 2000;
export const MAX_APPLY_ATTEMPT_EVIDENCE_CHARS = 4000;

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
  /**
   * Set atomically with attempt VERIFIED_SUCCESS and status APPLIED, in the
   * SAME transaction (Phase A6). Never set independently of status.
   */
  appliedAt: string | null;
  /**
   * Set atomically with status DISCARDED, in the SAME transaction
   * (Phase A6). Never set independently of status.
   */
  dispositionAt: string | null;

  // -------------------------------------------------------------------------
  // A6 artifact cache/index lifecycle metadata (schema v3 foundation).
  // SQLite is cache/index only; canonical authority is the verified
  // manifest.json + content-addressed blobs (outside SQLite).
  // All fields NULL before an A6 artifact lifecycle begins.
  // -------------------------------------------------------------------------

  /**
   * A6 canonical approval artifact hash (sha256 of verified manifest bytes).
   * This is NOT the A5 ChangeSet.diffHash (path/operation identity evidence).
   * NULL before an A6 artifact exists for this job.
   */
  artifactHash: string | null;
  /**
   * A5 change-set identity evidence (ChangeSet.diffHash from changeDetection.ts).
   * Persisted here as a durable cache of the runtime value. Never used to
   * substitute for artifactHash. NULL until change detection result is persisted.
   */
  changeSetHash: string | null;
  /**
   * Internal artifact cache/index lifecycle state. NONE before any artifact
   * is produced; AVAILABLE when an artifact is indexed; EXPIRED when
   * invalidated. Never returned as a public job status.
   */
  artifactState: ArtifactState | null;
  /**
   * Cache/index indication of whether complete certification evidence exists.
   * NULL (not false/0) for all historical pre-A6 rows — no artifact lifecycle
   * has ever begun for them, so "complete" is unknown/inapplicable rather
   * than "known to be incomplete". Re-verification is required at apply time
   * regardless of this cached flag.
   */
  artifactContentComplete: boolean | null;
  /**
   * Cache/index indication of whether the current artifact is considered
   * eligible for apply. NULL (not false/0) for historical rows — the same
   * unknown/inapplicable distinction as {@link artifactContentComplete}. NOT
   * authoritative at apply time — future apply must re-verify manifest,
   * blobs, base, and host preconditions.
   */
  artifactApplicable: boolean | null;
  /**
   * Bounded internal reason for uncertifiable, non-applicable, or expired
   * artifact outcomes. NULL when no reason applies (no artifact or artifact
   * is AVAILABLE and applicable). Not an unbounded error/log field.
   */
  artifactReason: string | null;
  /**
   * Identity of the bridge-owned per-job artifact volume. Never caller/model
   * supplied. No host artifact path. NULL until an artifact volume is
   * provisioned.
   */
  artifactVolume: string | null;
  /**
   * Stored artifact byte accounting (not source bytes). NULL until an
   * artifact is indexed.
   */
  artifactBytes: number | null;
  /**
   * Canonical operation-count accounting from the artifact manifest. NULL
   * until an artifact is indexed.
   */
  artifactOpCount: number | null;
}

/**
 * Project apply-admission state (Phase A6). NORMAL is the implicit default
 * for any project with no row; QUARANTINED is durable and permanent within
 * A6-B1 — no store method ever clears it.
 */
export interface AgentProjectApplyRow {
  projectId: string;
  state: AgentProjectApplyState;
  quarantinedAt: string | null;
  quarantineCausingJobId: string | null;
  quarantineCausingAttemptId: string | null;
  quarantineReason: string | null;
}

/**
 * A durable apply attempt (Phase A6-B1). The `expectedArtifactHash` is the
 * A6 approval-artifact identity and is DELIBERATELY distinct from A5's
 * `ChangeSet.diffHash` (change-set identity, computed in changeDetection.ts)
 * — the two must never be conflated. SQLite here is cache/index/status/audit
 * only; the canonical apply authority remains the verified manifest.json +
 * content-addressed blobs (outside SQLite, later batches).
 */
export interface AgentApplyAttemptRow {
  attemptId: string;
  jobId: string;
  projectId: string;
  principalId: string | null;
  /** A6 approval-artifact hash (NOT the A5 change-set diffHash). */
  expectedArtifactHash: string | null;
  baseCommit: string | null;
  state: AgentApplyAttemptState;
  /** Bounded human-readable reason (precondition failure, rollback cause, etc). */
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Bounded JSON/text evidence of a verified successful apply. */
  successEvidence: string | null;
  /** Bounded JSON/text evidence of a verified rollback. */
  rollbackEvidence: string | null;
  mutatedPathCount: number | null;
  /** Applier container/image identity, for durable evidence (later batches). */
  applierImage: string | null;
}

/**
 * Caller-supplied identity for a new apply attempt (Phase A6-B1
 * remediation). DELIBERATELY minimal: the caller supplies only the attempt's
 * own identity and the job it applies. All provenance (project, principal,
 * base commit, artifact hash) is derived from the durable agent_jobs row
 * inside {@link AgentJobStore.startApplyAttempt} — a caller can never
 * restate or override it, which is what prevents a job belonging to a
 * quarantined project from being relabelled under a different project
 * string.
 */
export interface NewApplyAttempt {
  attemptId: string;
  jobId: string;
}

export interface ApplyAttemptTransitionExtras {
  finishedAt?: string;
  reason?: string;
  successEvidence?: string;
  rollbackEvidence?: string;
  mutatedPathCount?: number;
  applierImage?: string;
}

/**
 * One completed mutation-op record for an apply attempt (Phase A6-B5). Never
 * holds source bytes — the canonical apply authority remains the verified
 * artifact manifest + content-addressed blobs (outside SQLite). `opIndex` is
 * the operation's position in the canonical sorted change list, so rollback
 * can process journal rows in exact reverse order without re-deriving it
 * from the artifact.
 */
export interface AgentApplyJournalRow {
  id: number;
  attemptId: string;
  opIndex: number;
  path: string;
  op: string;
  beforeExisted: boolean | null;
  beforeContentHash: string | null;
  beforeMode: number | null;
  /** Directory paths this op created, shallowest-first (JSON array), or null. */
  createdDirs: string[] | null;
  completedAt: string;
}

export interface NewApplyJournalRow {
  attemptId: string;
  opIndex: number;
  path: string;
  op: string;
  beforeExisted: boolean | null;
  beforeContentHash: string | null;
  beforeMode: number | null;
  createdDirs: string[] | null;
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
        // Fresh install → create at the latest shape (base_commit, applied_at,
        // disposition_at, and all A6 artifact metadata columns included).
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
      if (version < 3) {
        // v2 (A3/A5) → v3 (A6-B1): apply-state and artifact cache/index
        // persistence foundation. Additive only; preserves every existing
        // agent_jobs record. A fresh v3 install creates agent_jobs directly
        // with all these columns (see the `version < 1` block, kept in lockstep).
        if (!this.columnExists('agent_jobs', 'applied_at')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN applied_at TEXT');
        }
        if (!this.columnExists('agent_jobs', 'disposition_at')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN disposition_at TEXT');
        }
        // A6 artifact cache/index lifecycle metadata. All NULL for historical
        // rows — never fabricate artifact state, hash, or accounting for jobs
        // that predate the A6 artifact lifecycle.
        if (!this.columnExists('agent_jobs', 'artifact_hash')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN artifact_hash TEXT');
        }
        if (!this.columnExists('agent_jobs', 'change_set_hash')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN change_set_hash TEXT');
        }
        if (!this.columnExists('agent_jobs', 'artifact_state')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN artifact_state TEXT');
        }
        if (!this.columnExists('agent_jobs', 'artifact_content_complete')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN artifact_content_complete INTEGER');
        }
        if (!this.columnExists('agent_jobs', 'artifact_applicable')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN artifact_applicable INTEGER');
        }
        if (!this.columnExists('agent_jobs', 'artifact_reason')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN artifact_reason TEXT');
        }
        if (!this.columnExists('agent_jobs', 'artifact_volume')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN artifact_volume TEXT');
        }
        if (!this.columnExists('agent_jobs', 'artifact_bytes')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN artifact_bytes INTEGER');
        }
        if (!this.columnExists('agent_jobs', 'artifact_op_count')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN artifact_op_count INTEGER');
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agent_project_apply_state (
            project_id                   TEXT PRIMARY KEY,
            state                        TEXT NOT NULL DEFAULT 'NORMAL',
            quarantined_at               TEXT,
            quarantine_causing_job_id    TEXT,
            quarantine_causing_attempt_id TEXT,
            quarantine_reason            TEXT
          );
        `);
        this.db.exec(`
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
          -- Durable per-job / per-project active-attempt exclusion: SQLite
          -- partial unique indexes are the enforcement authority, NOT an
          -- in-memory mutex (an in-memory mutex may be layered on later
          -- purely as an optimization). At most one row per job, and at most
          -- one row per project, may be in an active state at a time.
          CREATE UNIQUE INDEX IF NOT EXISTS idx_apply_attempts_active_job
            ON agent_apply_attempts(job_id) WHERE state IN (${ACTIVE_ATTEMPT_SQL_LIST});
          CREATE UNIQUE INDEX IF NOT EXISTS idx_apply_attempts_active_project
            ON agent_apply_attempts(project_id) WHERE state IN (${ACTIVE_ATTEMPT_SQL_LIST});
        `);
      }
      if (version < 4) {
        // v3 (A6-B1/B2/B3/B4) → v4 (A6-B5): per-attempt mutation journal.
        // Additive only; no column changes to agent_jobs or agent_apply_attempts.
        // Never holds source bytes — path/hash/mode metadata only (the canonical
        // apply authority remains the verified artifact manifest + blobs).
        this.db.exec(`
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
   *
   * DELIBERATELY refuses `to === 'APPLIED'` and `to === 'DISCARDED'`: both
   * remain legal edges in the public A1 state machine (COMPLETED ->
   * APPLIED/DISCARDED), but each carries a durable side effect — applied_at
   * coupled to a verified apply attempt, or disposition_at coupled to the
   * active-attempt/UNCERTAIN exclusion check — that only a dedicated atomic
   * primitive may commit: {@link markApplySuccess} and {@link discardJob}
   * respectively. This is enforced here at the API surface, not merely by
   * caller convention, so a future caller cannot silently desynchronize
   * applied_at/disposition_at or bypass the discard/apply invariants by
   * calling this generic method instead.
   */
  transition(jobId: string, from: AgentJobStatus, to: AgentJobStatus, extras: TransitionExtras = {}): boolean {
    if (to === 'APPLIED' || to === 'DISCARDED') {
      throw new BridgeError(
        'INVALID_JOB_TRANSITION',
        `job transition to ${to} must go through its dedicated atomic primitive (markApplySuccess/discardJob), not the generic transition`,
        409,
      );
    }
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

  // -------------------------------------------------------------------------
  // A6-B3: Atomic artifact publication
  // -------------------------------------------------------------------------

  /**
   * Atomically publish a finalized B3 artifact for a job. Inside
   * BEGIN IMMEDIATE, verifies:
   *   - job exists and is in VALIDATING state
   *   - artifact_state is currently NULL (never overwrite AVAILABLE)
   *
   * Then atomically sets ALL artifact metadata columns. If no row matches
   * the CAS predicate, throws ARTIFACT_PUBLICATION_FAILED (fail closed).
   *
   * Once AVAILABLE, B3 must never overwrite the artifact — repeated
   * publication fails closed.
   */
  publishArtifact(jobId: string, artifact: {
    artifactHash: string;
    changeSetHash: string;
    contentComplete: boolean;
    applicable: boolean;
    reason: string | null;
    artifactVolume: string;
    artifactBytes: number;
    opCount: number;
  }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db.prepare(`
        UPDATE agent_jobs
        SET artifact_hash = ?,
            change_set_hash = ?,
            artifact_state = 'AVAILABLE',
            artifact_content_complete = ?,
            artifact_applicable = ?,
            artifact_reason = ?,
            artifact_volume = ?,
            artifact_bytes = ?,
            artifact_op_count = ?
        WHERE job_id = ?
          AND status = 'VALIDATING'
          AND artifact_state IS NULL
      `).run(
        artifact.artifactHash,
        artifact.changeSetHash,
        artifact.contentComplete ? 1 : 0,
        artifact.applicable ? 1 : 0,
        artifact.reason,
        artifact.artifactVolume,
        artifact.artifactBytes,
        artifact.opCount,
        jobId,
      );
      if (Number(res.changes) !== 1) {
        throw new BridgeError(
          'ARTIFACT_PUBLICATION_FAILED',
          `atomic artifact publication failed for job ${jobId}: job not in VALIDATING state or artifact already published`,
          500,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
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

  // -------------------------------------------------------------------------
  // A6-B1: project apply-admission state
  // -------------------------------------------------------------------------

  getProjectApplyState(projectId: string): AgentProjectApplyRow | undefined {
    const r = this.db.prepare('SELECT * FROM agent_project_apply_state WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined;
    return r ? rowToProjectApplyState(r) : undefined;
  }

  /**
   * Narrow deterministic admission query for future dispatch/apply logic
   * (Phase A6). A project with no row has never been quarantined and is
   * NORMAL by default.
   */
  isProjectApplyAllowed(projectId: string): boolean {
    const row = this.getProjectApplyState(projectId);
    return !row || row.state === 'NORMAL';
  }

  // -------------------------------------------------------------------------
  // A6-B1: apply attempts
  // -------------------------------------------------------------------------

  getApplyAttempt(attemptId: string): AgentApplyAttemptRow | undefined {
    const r = this.db.prepare('SELECT * FROM agent_apply_attempts WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined;
    return r ? rowToApplyAttempt(r) : undefined;
  }

  listApplyAttemptsForJob(jobId: string): AgentApplyAttemptRow[] {
    const rows = this.db.prepare('SELECT * FROM agent_apply_attempts WHERE job_id = ? ORDER BY started_at, rowid').all(jobId) as Record<string, unknown>[];
    return rows.map(rowToApplyAttempt);
  }

  /**
   * Admit a new apply attempt in state STARTED. All provenance (project,
   * principal, base commit, artifact hash) is derived from the durable
   * agent_jobs row — the caller supplies only `attemptId` and `jobId` and
   * has no authority to restate or override it (Phase A6-B1 remediation,
   * D2). Durably enforces, inside ONE BEGIN IMMEDIATE transaction
   * (restart-safe, no TOCTOU race):
   * - the job exists (else throws UNKNOWN_JOB, no attempt inserted);
   * - the job is COMPLETED (else throws PRECONDITION_FAILED, no attempt
   *   inserted) — every other public status (QUEUED, PREPARING, RUNNING,
   *   VALIDATING, any failure code, APPLIED, DISCARDED) is rejected;
   * - the attemptId does not already exist (else throws
   *   DUPLICATE_ATTEMPT_ID, checked explicitly here rather than inferred
   *   from a UNIQUE constraint error, so it is never confused with the
   *   active-attempt collision below);
   * - the job's project (as derived from the row, never the caller) is not
   *   QUARANTINED (else throws PROJECT_QUARANTINED);
   * - no other attempt is currently active (STARTED/VERIFYING/APPLYING) for
   *   the same job OR the same derived project — enforced by the partial
   *   unique indexes created in the v3 migration, NOT by a preceding SELECT
   *   (throws APPLY_ATTEMPT_ACTIVE).
   */
  startApplyAttempt(attempt: NewApplyAttempt): AgentApplyAttemptRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(attempt.jobId) as Record<string, unknown> | undefined;
      if (!job) {
        throw new BridgeError('UNKNOWN_JOB', `job ${attempt.jobId} does not exist`, 404);
      }
      if (String(job.status) !== 'COMPLETED') {
        throw new BridgeError(
          'PRECONDITION_FAILED',
          `job ${attempt.jobId} is ${String(job.status)}, not COMPLETED; apply attempts may only be started for COMPLETED jobs`,
          409,
        );
      }
      const existingAttempt = this.db.prepare('SELECT 1 FROM agent_apply_attempts WHERE attempt_id = ?').get(attempt.attemptId);
      if (existingAttempt) {
        throw new BridgeError('DUPLICATE_ATTEMPT_ID', `apply attempt ${attempt.attemptId} already exists`, 409);
      }

      // Derived, durable provenance — never caller-supplied.
      const projectId = String(job.project);
      const principalId = String(job.principal_id);
      const baseCommit = (job.base_commit ?? null) as string | null;
      const expectedArtifactHash = (job.artifact_hash ?? null) as string | null;

      const proj = this.db.prepare('SELECT state FROM agent_project_apply_state WHERE project_id = ?').get(projectId) as { state: string } | undefined;
      if (proj?.state === 'QUARANTINED') {
        throw new BridgeError('PROJECT_QUARANTINED', `project ${projectId} is quarantined and cannot accept new apply attempts`, 409);
      }

      try {
        this.db.prepare(`
          INSERT INTO agent_apply_attempts
            (attempt_id, job_id, project_id, principal_id, expected_artifact_hash, base_commit, state, started_at)
          VALUES (?, ?, ?, ?, ?, ?, 'STARTED', ?)
        `).run(
          attempt.attemptId, attempt.jobId, projectId,
          principalId, expectedArtifactHash, baseCommit,
          nowIso(),
        );
      } catch (e) {
        if (isUniqueConstraintViolation(e)) {
          throw new BridgeError(
            'APPLY_ATTEMPT_ACTIVE',
            `an apply attempt is already active for job ${attempt.jobId} or project ${projectId}`,
            409,
          );
        }
        throw e;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      // Any failure ABOVE this point (including a failed COMMIT itself)
      // means the transaction never durably succeeded, so a ROLLBACK here is
      // always safe and always the right response.
      this.db.exec('ROLLBACK');
      throw e;
    }
    // The transaction already committed durably above. This read is
    // deliberately OUTSIDE the try/catch: if it throws for any reason, the
    // original error must propagate as-is and must NEVER trigger a ROLLBACK
    // — there is no open transaction left to roll back, and attempting one
    // here would mask the read failure behind a spurious SQLite error.
    return this.getApplyAttempt(attempt.attemptId)!;
  }

  /**
   * Atomic validated internal transition for an apply attempt. Same CAS
   * pattern as {@link transition} for jobs: validate against the shared A6
   * apply-attempt state machine, then UPDATE ... WHERE state = expected.
   * Returns false when the row was not in `from` anymore.
   *
   * DELIBERATELY refuses `to === 'VERIFIED_SUCCESS'` and `to === 'UNCERTAIN'`:
   * both are guarded edges that must only ever be committed by a dedicated
   * atomic primitive that couples the attempt state change to another durable
   * side effect in the SAME transaction —
   * {@link markApplySuccess} (attempt + job.status + job.applied_at) and
   * {@link recoverApplyAttempts} (attempt + project quarantine) respectively.
   * This is enforced here at the API surface, not merely by caller
   * convention, so a future caller cannot silently desynchronize the job row
   * or bypass project quarantine by calling this generic method instead.
   */
  transitionApplyAttempt(
    attemptId: string,
    from: AgentApplyAttemptState,
    to: AgentApplyAttemptState,
    extras: ApplyAttemptTransitionExtras = {},
  ): boolean {
    if (to === 'VERIFIED_SUCCESS' || to === 'UNCERTAIN') {
      throw new BridgeError(
        'INVALID_ATTEMPT_TRANSITION',
        `apply attempt transition to ${to} must go through its dedicated atomic primitive, not the generic transition`,
        409,
      );
    }
    assertApplyAttemptTransition(from, to);
    const sets: string[] = ['state = ?'];
    const args: (string | number)[] = [to];
    if (extras.finishedAt !== undefined) { sets.push('finished_at = ?'); args.push(extras.finishedAt); }
    if (extras.reason !== undefined) { sets.push('reason = ?'); args.push(extras.reason.slice(0, MAX_APPLY_ATTEMPT_REASON_CHARS)); }
    if (extras.successEvidence !== undefined) { sets.push('success_evidence = ?'); args.push(extras.successEvidence.slice(0, MAX_APPLY_ATTEMPT_EVIDENCE_CHARS)); }
    if (extras.rollbackEvidence !== undefined) { sets.push('rollback_evidence = ?'); args.push(extras.rollbackEvidence.slice(0, MAX_APPLY_ATTEMPT_EVIDENCE_CHARS)); }
    if (extras.mutatedPathCount !== undefined) { sets.push('mutated_path_count = ?'); args.push(extras.mutatedPathCount); }
    if (extras.applierImage !== undefined) { sets.push('applier_image = ?'); args.push(extras.applierImage); }
    args.push(attemptId, from);
    const res = this.db.prepare(`UPDATE agent_apply_attempts SET ${sets.join(', ')} WHERE attempt_id = ? AND state = ?`).run(...args);
    return Number(res.changes) === 1;
  }

  /**
   * Atomically commit a verified successful apply: in ONE DB transaction,
   * attempt APPLYING -> VERIFIED_SUCCESS AND job COMPLETED -> APPLIED with
   * applied_at set. Neither half is ever persisted without the other — a
   * restart mid-transaction rolls back to the pre-success state entirely
   * (SQLite transaction durability), so a job can never be seen as APPLIED
   * without its causing attempt being VERIFIED_SUCCESS, or vice versa.
   *
   * NOT called from any public runtime path in B1 (no applier exists yet);
   * exists so a future B6 applier has a single atomic primitive to call.
   */
  markApplySuccess(
    attemptId: string,
    jobId: string,
    extras: { successEvidence?: string; mutatedPathCount?: number } = {},
  ): boolean {
    assertApplyAttemptTransition('APPLYING', 'VERIFIED_SUCCESS');
    assertAgentJobTransition('COMPLETED', 'APPLIED');
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const a = this.db.prepare(`
        UPDATE agent_apply_attempts
        SET state = 'VERIFIED_SUCCESS', finished_at = ?, success_evidence = ?, mutated_path_count = ?
        WHERE attempt_id = ? AND job_id = ? AND state = 'APPLYING'
      `).run(
        now,
        extras.successEvidence !== undefined ? extras.successEvidence.slice(0, MAX_APPLY_ATTEMPT_EVIDENCE_CHARS) : null,
        extras.mutatedPathCount ?? null,
        attemptId, jobId,
      );
      if (Number(a.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }
      const j = this.db.prepare(`
        UPDATE agent_jobs SET status = 'APPLIED', applied_at = ? WHERE job_id = ? AND status = 'COMPLETED'
      `).run(now, jobId);
      if (Number(j.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Atomically discard a completed job: in ONE DB transaction, job
   * COMPLETED -> DISCARDED with disposition_at set. Denies the discard (no
   * mutation) if:
   * - an apply attempt is currently active (STARTED/VERIFYING/APPLYING) for
   *   this job — throws APPLY_ATTEMPT_ACTIVE. A job must never be discarded
   *   while an apply attempt may be mutating (or about to mutate) the host
   *   project.
   * - ANY apply attempt for this job is UNCERTAIN — throws
   *   APPLY_ATTEMPT_UNCERTAIN. UNCERTAIN means host mutation may have
   *   happened and the outcome is unknown; the job must stay COMPLETED with
   *   its evidence reviewable rather than being disposed of, and the owning
   *   project's quarantine (set by {@link recoverApplyAttempts}) must remain
   *   the sole path back to normal admission. This is independent of the
   *   active-attempt check above: UNCERTAIN is a terminal apply-attempt
   *   state, not an active one.
   * Discarding a job never clears any project quarantine (this method never
   * touches agent_project_apply_state).
   */
  discardJob(jobId: string): boolean {
    assertAgentJobTransition('COMPLETED', 'DISCARDED');
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(
        `SELECT COUNT(*) AS n FROM agent_apply_attempts WHERE job_id = ? AND state IN (${ACTIVE_ATTEMPT_SQL_LIST})`,
      ).get(jobId) as { n: number };
      if (Number(active.n) > 0) {
        throw new BridgeError('APPLY_ATTEMPT_ACTIVE', `job ${jobId} has an active apply attempt and cannot be discarded`, 409);
      }
      const uncertain = this.db.prepare(
        `SELECT COUNT(*) AS n FROM agent_apply_attempts WHERE job_id = ? AND state = 'UNCERTAIN'`,
      ).get(jobId) as { n: number };
      if (Number(uncertain.n) > 0) {
        throw new BridgeError('APPLY_ATTEMPT_UNCERTAIN', `job ${jobId} has an UNCERTAIN apply attempt and cannot be discarded`, 409);
      }
      const res = this.db.prepare(
        `UPDATE agent_jobs SET status = 'DISCARDED', disposition_at = ? WHERE job_id = ? AND status = 'COMPLETED'`,
      ).run(now, jobId);
      this.db.exec('COMMIT');
      return Number(res.changes) === 1;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Startup reconciliation for apply attempts (Phase A6-B1), mirroring
   * {@link recoverActive}'s discipline: this must run to completion and
   * COMMIT before the process reopens attempt admission, so a restart can
   * never leave a stale active attempt able to race a fresh one.
   *
   * Single transaction:
   * - orphaned STARTED/VERIFYING -> ABORTED_NO_MUTATION (host mutation never
   *   began; the project is NOT quarantined);
   * - orphaned APPLYING -> UNCERTAIN, AND the owning project is marked
   *   QUARANTINED in the SAME transaction (host mutation may have begun and
   *   its outcome is unknown; never auto-retried).
   * Idempotent: re-running against an already-recovered DB is a no-op, and
   * quarantining is idempotent (a project already QUARANTINED keeps its
   * original cause/timestamp rather than being overwritten).
   */
  recoverApplyAttempts(reason: string): { abortedNoMutation: string[]; uncertain: string[] } {
    const abortedNoMutation: string[] = [];
    const uncertain: string[] = [];
    const boundedReason = reason.slice(0, MAX_APPLY_ATTEMPT_REASON_CHARS);
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.db.prepare(
        `SELECT attempt_id FROM agent_apply_attempts WHERE state IN ('STARTED','VERIFYING')`,
      ).all() as { attempt_id: string }[];
      for (const row of pending) {
        const res = this.db.prepare(`
          UPDATE agent_apply_attempts SET state = 'ABORTED_NO_MUTATION', finished_at = ?, reason = ?
          WHERE attempt_id = ? AND state IN ('STARTED','VERIFYING')
        `).run(now, boundedReason, row.attempt_id);
        if (Number(res.changes) === 1) abortedNoMutation.push(row.attempt_id);
      }

      const applying = this.db.prepare(
        `SELECT attempt_id, job_id, project_id FROM agent_apply_attempts WHERE state = 'APPLYING'`,
      ).all() as { attempt_id: string; job_id: string; project_id: string }[];
      for (const row of applying) {
        const res = this.db.prepare(`
          UPDATE agent_apply_attempts SET state = 'UNCERTAIN', finished_at = ?, reason = ?
          WHERE attempt_id = ? AND state = 'APPLYING'
        `).run(now, boundedReason, row.attempt_id);
        if (Number(res.changes) !== 1) continue;
        uncertain.push(row.attempt_id);
        // Quarantine the project in the SAME transaction. Idempotent: if the
        // project is already QUARANTINED, its original cause/timestamp is
        // preserved (never overwritten by a later recovery pass).
        this.db.prepare(`
          INSERT INTO agent_project_apply_state
            (project_id, state, quarantined_at, quarantine_causing_job_id, quarantine_causing_attempt_id, quarantine_reason)
          VALUES (?, 'QUARANTINED', ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET
            state = 'QUARANTINED',
            quarantined_at = CASE WHEN agent_project_apply_state.state = 'QUARANTINED'
              THEN agent_project_apply_state.quarantined_at ELSE excluded.quarantined_at END,
            quarantine_causing_job_id = CASE WHEN agent_project_apply_state.state = 'QUARANTINED'
              THEN agent_project_apply_state.quarantine_causing_job_id ELSE excluded.quarantine_causing_job_id END,
            quarantine_causing_attempt_id = CASE WHEN agent_project_apply_state.state = 'QUARANTINED'
              THEN agent_project_apply_state.quarantine_causing_attempt_id ELSE excluded.quarantine_causing_attempt_id END,
            quarantine_reason = CASE WHEN agent_project_apply_state.state = 'QUARANTINED'
              THEN agent_project_apply_state.quarantine_reason ELSE excluded.quarantine_reason END
        `).run(row.project_id, now, row.job_id, row.attempt_id, boundedReason);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { abortedNoMutation, uncertain };
  }

  // -------------------------------------------------------------------------
  // A6-B5: apply-attempt mutation journal
  // -------------------------------------------------------------------------

  /**
   * Persist one completed mutation op for an attempt. Called by the applier
   * orchestration AFTER each op's exec-stream JSON line arrives (one op at a
   * time, each its own committed transaction) — so a crash between ops
   * leaves an exact, provable record of which ops actually landed. Throws on
   * a duplicate `(attempt_id, op_index)` pair (the UNIQUE constraint) rather
   * than silently overwriting — journal rows are append-only.
   */
  insertApplyJournalRow(row: NewApplyJournalRow): AgentApplyJournalRow {
    const completedAt = nowIso();
    try {
      this.db.prepare(`
        INSERT INTO agent_apply_journal
          (attempt_id, op_index, path, op, before_existed, before_content_hash, before_mode, created_dirs, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.attemptId, row.opIndex, row.path, row.op,
        row.beforeExisted === null ? null : (row.beforeExisted ? 1 : 0),
        row.beforeContentHash, row.beforeMode,
        row.createdDirs === null ? null : JSON.stringify(row.createdDirs),
        completedAt,
      );
    } catch (e) {
      if (isUniqueConstraintViolation(e)) {
        throw new BridgeError(
          'APPLY_MUTATION_FAILED',
          `duplicate journal entry for attempt ${row.attemptId} op ${row.opIndex}`,
          500,
        );
      }
      throw e;
    }
    const r = this.db.prepare(
      'SELECT * FROM agent_apply_journal WHERE attempt_id = ? AND op_index = ?',
    ).get(row.attemptId, row.opIndex) as Record<string, unknown>;
    return rowToApplyJournal(r);
  }

  /** All journal rows for one attempt, ordered by op_index ascending. */
  listApplyJournalForAttempt(attemptId: string): AgentApplyJournalRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_apply_journal WHERE attempt_id = ? ORDER BY op_index ASC',
    ).all(attemptId) as Record<string, unknown>[];
    return rows.map(rowToApplyJournal);
  }

  /**
   * Atomically commit a runtime (non-restart) UNCERTAIN outcome: in ONE DB
   * transaction, attempt APPLYING -> UNCERTAIN AND the owning project ->
   * QUARANTINED, exactly like {@link recoverApplyAttempts}'s startup path —
   * this method reuses the SAME idempotent quarantine upsert SQL so the two
   * call sites (runtime failure vs. restart recovery) can never produce
   * divergent durable outcomes. Called when rollback fails or cannot be
   * verified during a live apply attempt (never called for a restart-found
   * orphan — that path is {@link recoverApplyAttempts} exclusively).
   */
  markApplyUncertain(attemptId: string, jobId: string, projectId: string, reason: string): boolean {
    const boundedReason = reason.slice(0, MAX_APPLY_ATTEMPT_REASON_CHARS);
    const now = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db.prepare(`
        UPDATE agent_apply_attempts
        SET state = 'UNCERTAIN', finished_at = ?, reason = ?
        WHERE attempt_id = ? AND job_id = ? AND state = 'APPLYING'
      `).run(now, boundedReason, attemptId, jobId);
      if (Number(res.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }

      this.db.prepare(`
        INSERT INTO agent_project_apply_state
          (project_id, state, quarantined_at, quarantine_causing_job_id, quarantine_causing_attempt_id, quarantine_reason)
        VALUES (?, 'QUARANTINED', ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          state = 'QUARANTINED',
          quarantined_at = CASE WHEN agent_project_apply_state.state = 'QUARANTINED'
            THEN agent_project_apply_state.quarantined_at ELSE excluded.quarantined_at END,
          quarantine_causing_job_id = CASE WHEN agent_project_apply_state.state = 'QUARANTINED'
            THEN agent_project_apply_state.quarantine_causing_job_id ELSE excluded.quarantine_causing_job_id END,
          quarantine_causing_attempt_id = CASE WHEN agent_project_apply_state.state = 'QUARANTINED'
            THEN agent_project_apply_state.quarantine_causing_attempt_id ELSE excluded.quarantine_causing_attempt_id END,
          quarantine_reason = CASE WHEN agent_project_apply_state.state = 'QUARANTINED'
            THEN agent_project_apply_state.quarantine_reason ELSE excluded.quarantine_reason END
      `).run(projectId, now, jobId, attemptId, boundedReason);

      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** SQLite UNIQUE constraint violation (partial-unique-index admission race lost). */
function isUniqueConstraintViolation(e: unknown): boolean {
  const err = e as { code?: string; errcode?: number; message?: string };
  return err?.code === 'ERR_SQLITE_ERROR' &&
    (err?.errcode === 2067 || err?.errcode === 1555 || /UNIQUE constraint failed/.test(err?.message ?? ''));
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
    appliedAt: (r.applied_at ?? null) as string | null,
    dispositionAt: (r.disposition_at ?? null) as string | null,
    artifactHash: (r.artifact_hash ?? null) as string | null,
    changeSetHash: (r.change_set_hash ?? null) as string | null,
    artifactState: (r.artifact_state ?? null) as ArtifactState | null,
    artifactContentComplete: r.artifact_content_complete === null || r.artifact_content_complete === undefined
      ? null : Number(r.artifact_content_complete) === 1,
    artifactApplicable: r.artifact_applicable === null || r.artifact_applicable === undefined
      ? null : Number(r.artifact_applicable) === 1,
    artifactReason: (r.artifact_reason ?? null) as string | null,
    artifactVolume: (r.artifact_volume ?? null) as string | null,
    artifactBytes: r.artifact_bytes === null || r.artifact_bytes === undefined ? null : Number(r.artifact_bytes),
    artifactOpCount: r.artifact_op_count === null || r.artifact_op_count === undefined ? null : Number(r.artifact_op_count),
  };
}

function rowToProjectApplyState(r: Record<string, unknown>): AgentProjectApplyRow {
  return {
    projectId: String(r.project_id),
    state: String(r.state) as AgentProjectApplyState,
    quarantinedAt: (r.quarantined_at ?? null) as string | null,
    quarantineCausingJobId: (r.quarantine_causing_job_id ?? null) as string | null,
    quarantineCausingAttemptId: (r.quarantine_causing_attempt_id ?? null) as string | null,
    quarantineReason: (r.quarantine_reason ?? null) as string | null,
  };
}

function rowToApplyJournal(r: Record<string, unknown>): AgentApplyJournalRow {
  return {
    id: Number(r.id),
    attemptId: String(r.attempt_id),
    opIndex: Number(r.op_index),
    path: String(r.path),
    op: String(r.op),
    beforeExisted: r.before_existed === null || r.before_existed === undefined ? null : Number(r.before_existed) === 1,
    beforeContentHash: (r.before_content_hash ?? null) as string | null,
    beforeMode: r.before_mode === null || r.before_mode === undefined ? null : Number(r.before_mode),
    createdDirs: r.created_dirs ? (JSON.parse(String(r.created_dirs)) as string[]) : null,
    completedAt: String(r.completed_at),
  };
}

function rowToApplyAttempt(r: Record<string, unknown>): AgentApplyAttemptRow {
  return {
    attemptId: String(r.attempt_id),
    jobId: String(r.job_id),
    projectId: String(r.project_id),
    principalId: (r.principal_id ?? null) as string | null,
    expectedArtifactHash: (r.expected_artifact_hash ?? null) as string | null,
    baseCommit: (r.base_commit ?? null) as string | null,
    state: String(r.state) as AgentApplyAttemptState,
    reason: (r.reason ?? null) as string | null,
    startedAt: String(r.started_at),
    finishedAt: (r.finished_at ?? null) as string | null,
    successEvidence: (r.success_evidence ?? null) as string | null,
    rollbackEvidence: (r.rollback_evidence ?? null) as string | null,
    mutatedPathCount: r.mutated_path_count === null || r.mutated_path_count === undefined ? null : Number(r.mutated_path_count),
    applierImage: (r.applier_image ?? null) as string | null,
  };
}
