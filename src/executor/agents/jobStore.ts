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
 * - the bounded raw prompt is stored ONLY while execution/recovery may still
 *   require it. It is never logged or returned by status/result routes, and P3
 *   purges it immediately when a job reaches an execution-terminal outcome;
 *   prompt_hash remains as durable audit identity.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { BridgeError } from '../../shared/errors.js';
import {
  assertLiveWriterLeaseId,
  assertLiveWriterLogicalId,
  assertLiveWriterOwner,
  assertLiveWriterPrincipalId,
  LIVE_WRITER_LEASE_ID_PATTERN,
  LIVE_WRITER_LEASE_STATES,
  LIVE_WRITER_OWNER_KINDS,
  type LiveWriterLeaseState,
  type LiveWriterOwnerKind,
} from '../../shared/liveWriter.js';
import { AgentSessionStore } from './sessionStore.js';
import {
  assertAgentJobTransition,
  assertApplyAttemptTransition,
  isAgentFailureStatus,
  MAX_AGENT_PROMPT_CHARS,
  MAX_AGENT_QUEUED_JOBS,
  PROVIDER_BACKOFF_BASE_MS,
  PROVIDER_BACKOFF_MAX_MS,
  PROVIDER_BACKOFF_JITTER_FRACTION,
  PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
  PROVIDER_CIRCUIT_OPEN_MS,
  MAX_PROVIDER_RETRY_AFTER_MS,
  AGENT_APPLY_ATTEMPT_ACTIVE_STATES,
  AGENT_RETENTION_CLASSES,
  type AgentJobStatus,
  type AgentFailureCode,
  type AgentApplyAttemptState,
  type AgentProjectApplyState,
  type ArtifactState,
  type AgentRetentionClass,
} from '../../shared/agents.js';

export const AGENT_JOB_SCHEMA_VERSION = 9;

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

/**
 * The exact schema shape a database claiming the current schema version MUST have.
 * Used by {@link AgentJobStore.assertSchemaShape} to fail closed rather than
 * trust the bare version stamp. Declared here (not inline) so the fresh-install
 * DDL and the acceptance check stay reviewable side by side.
 */
const REQUIRED_SCHEMA_TABLES = [
  'agent_jobs',
  'agent_project_apply_state',
  'agent_apply_attempts',
  'agent_apply_journal',
  'agent_sessions',
  'agent_provider_state',
  'live_writer_leases',
] as const;

/** Required column -> declared SQLite affinity, per table. */
const REQUIRED_SCHEMA_COLUMNS: Record<string, Record<string, string>> = {
  agent_jobs: {
    job_id: 'TEXT', principal_id: 'TEXT', backend: 'TEXT', project: 'TEXT',
    profile: 'TEXT', resource_policy: 'TEXT', status: 'TEXT',
    failure_code: 'TEXT', failure_reason: 'TEXT', created_at: 'TEXT',
    started_at: 'TEXT', completed_at: 'TEXT', prompt_hash: 'TEXT',
    prompt: 'TEXT', summary: 'TEXT', exit_code: 'INTEGER',
    backend_session_id: 'TEXT', session_policy: 'TEXT', writer: 'INTEGER',
    base_commit: 'TEXT', applied_at: 'TEXT', disposition_at: 'TEXT',
    artifact_hash: 'TEXT', change_set_hash: 'TEXT', artifact_state: 'TEXT',
    artifact_content_complete: 'INTEGER', artifact_applicable: 'INTEGER',
    artifact_reason: 'TEXT', artifact_volume: 'TEXT', artifact_bytes: 'INTEGER',
    artifact_op_count: 'INTEGER',
    // v5 durable retention snapshot — the fields the whole A6 lifecycle rests on.
    retention_class: 'TEXT', retention_duration_ms: 'INTEGER', retain_until: 'TEXT',
  },
  agent_project_apply_state: {
    project_id: 'TEXT', state: 'TEXT', quarantined_at: 'TEXT',
    quarantine_causing_job_id: 'TEXT', quarantine_causing_attempt_id: 'TEXT',
    quarantine_reason: 'TEXT',
  },
  agent_apply_attempts: {
    attempt_id: 'TEXT', job_id: 'TEXT', project_id: 'TEXT', principal_id: 'TEXT',
    expected_artifact_hash: 'TEXT', base_commit: 'TEXT', state: 'TEXT',
    reason: 'TEXT', started_at: 'TEXT', finished_at: 'TEXT',
    success_evidence: 'TEXT', rollback_evidence: 'TEXT',
    mutated_path_count: 'INTEGER', applier_image: 'TEXT',
    worktree_id: 'TEXT', writer_lease_id: 'TEXT',
  },
  agent_apply_journal: {
    id: 'INTEGER', attempt_id: 'TEXT', op_index: 'INTEGER', path: 'TEXT',
    op: 'TEXT', before_existed: 'INTEGER', before_content_hash: 'TEXT',
    before_mode: 'INTEGER', created_dirs: 'TEXT', completed_at: 'TEXT',
  },
  // v6: A8 session continuity table
  agent_sessions: {
    session_id: 'TEXT', principal_id: 'TEXT', project: 'TEXT',
    backend: 'TEXT', profile: 'TEXT', provider_session_id: 'TEXT',
    provider_state_ref: 'TEXT', state: 'TEXT', created_at: 'TEXT', last_used_at: 'TEXT',
    consumed_by_job_id: 'TEXT', reserved_by_job_id: 'TEXT', reserved_at: 'TEXT', expires_at: 'TEXT',
    source_revision: 'TEXT',
  },
  // v7: P3 provider admission / cooldown state. Never stores provider payloads.
  agent_provider_state: {
    backend: 'TEXT', consecutive_failures: 'INTEGER', last_failure_at: 'TEXT',
    last_failure_code: 'TEXT', last_success_at: 'TEXT', cooldown_until: 'TEXT',
    circuit_state: 'TEXT', updated_at: 'TEXT',
  },
  live_writer_leases: {
    writer_lease_id: 'TEXT', project_id: 'TEXT', worktree_id: 'TEXT',
    owner_kind: 'TEXT', owner_id: 'TEXT', principal_id: 'TEXT', state: 'TEXT',
    acquired_at: 'TEXT', finished_at: 'TEXT', reason: 'TEXT',
  },
};

/** Partial unique indexes that ARE the active-attempt exclusion authority. */
const REQUIRED_SCHEMA_INDEXES = [
  'idx_apply_attempts_active_job',
  'idx_apply_attempts_active_project',
] as const;

const LIVE_WRITER_TABLE_SQL = `CREATE TABLE live_writer_leases (
  writer_lease_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('agent_apply','ide')),
  owner_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','RELEASED','UNCERTAIN')),
  acquired_at TEXT NOT NULL,
  finished_at TEXT,
  reason TEXT
)`;

const LIVE_WRITER_INDEX_DEFINITIONS = {
  idx_live_writer_one_held_target: {
    columns: ['project_id', 'worktree_id'],
    unique: 1,
    partial: 1,
    sql: `CREATE UNIQUE INDEX idx_live_writer_one_held_target
      ON live_writer_leases(project_id, worktree_id)
      WHERE state IN ('ACTIVE','UNCERTAIN')`,
  },
  idx_live_writer_owner_once: {
    columns: ['owner_kind', 'owner_id'],
    unique: 1,
    partial: 0,
    sql: `CREATE UNIQUE INDEX idx_live_writer_owner_once
      ON live_writer_leases(owner_kind, owner_id)`,
  },
} as const;

export type ProviderCircuitState = 'CLOSED' | 'OPEN';

export interface ProviderAdmissionState {
  backend: string;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  lastSuccessAt: string | null;
  cooldownUntil: string | null;
  circuitState: ProviderCircuitState;
  updatedAt: string | null;
}

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
  // A6 durable retention snapshot (schema v5). All three fields NULL for
  // jobs created before v5. GC MUST use persisted values — never re-resolve
  // from current config/AGENT_RETENTION_DURATION_MS.
  // -------------------------------------------------------------------------

  /**
   * Retention class snapshot persisted at job creation. NULL for pre-v5 jobs
   * (legacy). Never backfilled or inferred from current resource policy config.
   */
  retentionClass: AgentRetentionClass | null;
  /**
   * Resolved duration (milliseconds) persisted at job creation from
   * AGENT_RETENTION_DURATION_MS[retentionClass]. NULL for pre-v5 jobs.
   * GC uses this persisted value; never re-resolves from the live map.
   */
  retentionDurationMs: number | null;
  /**
   * Absolute ISO 8601 expiry timestamp. NULL until final disposition
   * (APPLIED or DISCARDED). Computed as disposition_at + retention_duration_ms
   * in the SAME atomic transaction as the disposition transition.
   */
  retainUntil: string | null;

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
  /** B8 trusted logical worktree identity. NULL only for pre-B8 historical attempts. */
  worktreeId: string | null;
  /** B8 shared live-writer lease. NULL only for pre-B8 historical attempts. */
  writerLeaseId: string | null;
}

export interface LiveWriterLeaseRow {
  writerLeaseId: string;
  projectId: string;
  worktreeId: string;
  ownerKind: LiveWriterOwnerKind;
  ownerId: string;
  principalId: string;
  state: LiveWriterLeaseState;
  acquiredAt: string;
  finishedAt: string | null;
  reason: string | null;
}

export interface AcquireLiveWriterLeaseInput {
  projectId: string;
  worktreeId: string;
  ownerKind: LiveWriterOwnerKind;
  ownerId: string;
  principalId: string;
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
  /** Trusted project-registry worktree identity; never accepted from MCP input. */
  worktreeId: string;
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
  /** Retention class resolved from the resource policy at dispatch time (v5+). */
  retentionClass: AgentRetentionClass;
  /** Duration in ms resolved from AGENT_RETENTION_DURATION_MS at dispatch time (v5+). */
  retentionDurationMs: number;
}

export interface TransitionExtras {
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  exitCode?: number;
  failureCode?: AgentFailureCode;
  failureReason?: string;
}

/** Trusted A8 binding used only for atomic session reservation at dispatch. */
export interface SessionReservationBinding {
  principalId: string;
  project: string;
  backend: string;
  profile: string;
}

/** Successor identity committed atomically with job completion. */
export interface SessionSuccessorInput {
  sessionId: string;
  principalId: string;
  project: string;
  backend: string;
  profile: string;
  providerSessionId: string;
  providerStateRef?: string | null;
  /** Trusted committed source revision observed by this successful turn. */
  sourceRevision?: string | null;
}

export interface CompleteJobWithSessionInput {
  jobId: string;
  sourceSessionId?: string | null;
  successor?: SessionSuccessorInput | null;
  completedAt: string;
  summary: string;
  exitCode: number;
  requireArtifact: boolean;
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
  /** A8: session continuity store — shares the same DB connection. */
  private _sessionStore!: AgentSessionStore;

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
    this._sessionStore = new AgentSessionStore(this.db);
    this.migrate();
  }

  private columnExists(table: string, column: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some((c) => c.name === column);
  }

  /**
   * Verify the real schema shape before trusting a `user_version` stamp.
   *
   * `PRAGMA user_version` is only an integer. It does not prove that the
   * tables, columns, affinities, or durable exclusion indexes required by the
   * stamped version actually exist. P3 also uses this verifier as the v6→v7
   * preflight, excluding only the new v7 provider-state table, so malformed v6
   * databases fail before any v7 mutation is attempted.
   *
   * Fail closed instead of repairing or inferring missing historical state.
   */
  private assertSchemaShape(options: { includeProviderState?: boolean; includeLiveWriter?: boolean; includeSessionSourceRevision?: boolean; stampedVersion?: number } = {}): void {
    const includeProviderState = options.includeProviderState ?? true;
    const includeLiveWriter = options.includeLiveWriter ?? true;
    const includeSessionSourceRevision = options.includeSessionSourceRevision ?? true;
    const stampedVersion = options.stampedVersion ?? AGENT_JOB_SCHEMA_VERSION;
    const missing: string[] = [];

    const tableExists = (t: string): boolean =>
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !== undefined;
    const indexExists = (i: string): boolean =>
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(i) !== undefined;

    for (const t of REQUIRED_SCHEMA_TABLES) {
      if (!includeProviderState && t === 'agent_provider_state') continue;
      if (!includeLiveWriter && t === 'live_writer_leases') continue;
      if (!tableExists(t)) missing.push(`table ${t}`);
    }

    // Column presence + declared affinity for every table that exists. A
    // missing table is already reported above; do not double-report its columns.
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
      if (!includeProviderState && table === 'agent_provider_state') continue;
      if (!includeLiveWriter && table === 'live_writer_leases') continue;
      if (!tableExists(table)) continue;
      const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
      for (const [column, affinity] of Object.entries(columns)) {
        if (!includeSessionSourceRevision && table === 'agent_sessions' && column === 'source_revision') continue;
        if (!includeLiveWriter && table === 'agent_apply_attempts' && (column === 'worktree_id' || column === 'writer_lease_id')) continue;
        const got = info.find((c) => c.name === column);
        if (!got) { missing.push(`${table}.${column}`); continue; }
        if (String(got.type).toUpperCase() !== affinity) {
          missing.push(`${table}.${column} has type ${String(got.type)}, expected ${affinity}`);
        }
      }
    }

    // The per-job / per-project active-attempt exclusion is enforced by these
    // partial unique indexes, not by any in-memory lock. Without them a v5 DB
    // would silently permit two concurrently active apply attempts.
    if (tableExists('agent_apply_attempts')) {
      for (const idx of REQUIRED_SCHEMA_INDEXES) {
        if (!indexExists(idx)) missing.push(`index ${idx}`);
      }
    }

    if (includeLiveWriter && tableExists('live_writer_leases')) {
      const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();
      const tableSql = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='live_writer_leases'`).get() as { sql: string | null } | undefined;
      if (!tableSql?.sql || normalizeSql(tableSql.sql) !== normalizeSql(LIVE_WRITER_TABLE_SQL)) {
        missing.push('table live_writer_leases definition');
      }
      const writerFk = (this.db.prepare(`PRAGMA foreign_key_list(agent_apply_attempts)`).all() as Array<{table:string;from:string;to:string}>)
        .find((row) => row.from === 'writer_lease_id');
      if (!writerFk || writerFk.table !== 'live_writer_leases' || writerFk.to !== 'writer_lease_id') {
        missing.push('agent_apply_attempts.writer_lease_id foreign key');
      }
      for (const [name, expected] of Object.entries(LIVE_WRITER_INDEX_DEFINITIONS)) {
        const list = this.db.prepare(`PRAGMA index_list(live_writer_leases)`).all() as Array<{ name: string; unique: number; partial: number }>;
        const entry = list.find((row) => row.name === name);
        if (!entry || entry.unique !== expected.unique || entry.partial !== expected.partial) {
          missing.push(`index ${name} uniqueness/partial shape`); continue;
        }
        const cols = (this.db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ seqno: number; name: string }>)
          .sort((a,b) => a.seqno-b.seqno).map((row) => row.name);
        if (JSON.stringify(cols) !== JSON.stringify(expected.columns)) { missing.push(`index ${name} columns`); continue; }
        const stored = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`).get(name) as { sql: string | null } | undefined;
        if (!stored?.sql || normalizeSql(stored.sql) !== normalizeSql(expected.sql)) missing.push(`index ${name} definition`);
      }
    }

    if (missing.length > 0) {
      throw new BridgeError(
        'INTERNAL',
        `agent job DB is stamped schema v${stampedVersion} but its schema is incomplete/incompatible ` +
        `(missing or malformed: ${missing.join(', ')}); refusing to open — no automatic repair or retention backfill is performed`,
        500,
      );
    }
    if (includeLiveWriter) this.assertLiveWriterCoherence();
    // v6+: verify the session store shape using its own dedicated check.
    this._sessionStore.assertSchemaShape({ includeSourceRevision: includeSessionSourceRevision, stampedVersion });
  }

  private assertLiveWriterCoherence(): void {
    const allLeases=this.db.prepare(`SELECT * FROM live_writer_leases ORDER BY writer_lease_id`).all() as Array<Record<string,unknown>>;
    for (const raw of allLeases) rowToLiveWriterLease(raw);

    const attempts=this.db.prepare(`SELECT attempt_id,project_id,principal_id,state,worktree_id,writer_lease_id
      FROM agent_apply_attempts WHERE worktree_id IS NOT NULL OR writer_lease_id IS NOT NULL`).all() as Array<Record<string,unknown>>;
    for(const row of attempts){
      const attemptId=String(row.attempt_id), projectId=String(row.project_id), principalId=row.principal_id==null?null:String(row.principal_id);
      const worktreeId=row.worktree_id==null?null:String(row.worktree_id), writerLeaseId=row.writer_lease_id==null?null:String(row.writer_lease_id);
      if(!worktreeId||!writerLeaseId||!principalId) throw new BridgeError('INTERNAL',`apply attempt ${attemptId} has incomplete live-writer provenance`,500);
      const raw=this.db.prepare('SELECT * FROM live_writer_leases WHERE writer_lease_id=?').get(writerLeaseId) as Record<string,unknown>|undefined;
      if(!raw) throw new BridgeError('INTERNAL',`apply attempt ${attemptId} references missing live-writer lease`,500);
      const lease=rowToLiveWriterLease(raw);
      if(lease.ownerKind!=='agent_apply'||lease.ownerId!==attemptId||lease.projectId!==projectId||lease.worktreeId!==worktreeId||lease.principalId!==principalId){
        throw new BridgeError('INTERNAL',`apply attempt ${attemptId} live-writer binding is inconsistent`,500);
      }
      const state=String(row.state) as AgentApplyAttemptState;
      const expected:LiveWriterLeaseState=(AGENT_APPLY_ATTEMPT_ACTIVE_STATES as readonly string[]).includes(state)?'ACTIVE':state==='UNCERTAIN'?'UNCERTAIN':'RELEASED';
      if(lease.state!==expected) throw new BridgeError('INTERNAL',`apply attempt ${attemptId} and live-writer states disagree`,500);
    }
    const unlinkedAgent=this.db.prepare(`SELECT l.writer_lease_id FROM live_writer_leases l
      LEFT JOIN agent_apply_attempts a ON a.attempt_id=l.owner_id AND l.owner_kind='agent_apply'
      WHERE l.owner_kind='agent_apply' AND a.attempt_id IS NULL`).all() as Array<{writer_lease_id:string}>;
    if(unlinkedAgent.length>0) throw new BridgeError('INTERNAL','agent_apply live-writer lease has no matching apply attempt',500);
  }

  /** P3 v7 additive durable provider-admission state. */
  private createProviderAdmissionSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_provider_state (
        backend              TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_failure_at      TEXT,
        last_failure_code    TEXT,
        last_success_at      TEXT,
        cooldown_until       TEXT,
        circuit_state        TEXT NOT NULL DEFAULT 'CLOSED',
        updated_at           TEXT NOT NULL
      );
    `);
  }

  /** P7 B8 shared live-writer arbitration schema. */
  private createLiveWriterSchema(): void {
    this.db.exec(`${LIVE_WRITER_TABLE_SQL};
      CREATE UNIQUE INDEX idx_live_writer_one_held_target
        ON live_writer_leases(project_id, worktree_id)
        WHERE state IN ('ACTIVE','UNCERTAIN');
      CREATE UNIQUE INDEX idx_live_writer_owner_once
        ON live_writer_leases(owner_kind, owner_id);
    `);
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
    if (version === AGENT_JOB_SCHEMA_VERSION) {
      // Already at the supported version — but the stamp alone proves nothing.
      // Verify the real schema shape before accepting the database.
      this.assertSchemaShape();
      return;
    }
    if (version > AGENT_JOB_SCHEMA_VERSION) {
      throw new BridgeError('INTERNAL', `agent job DB schema v${version} is newer than supported v${AGENT_JOB_SCHEMA_VERSION}`, 500);
    }
    // P3 v7 safety boundary: a database stamped v6 must prove the complete
    // pre-v7 schema BEFORE any v7 table creation, prompt scrub, or version
    // update occurs. A malformed v6 database is rejected byte-preservingly
    // (apart from SQLite's normal open/journal bookkeeping); it is never
    // partially repaired or privacy-migrated before the failure is reported.
    if (version === 6) {
      this.assertSchemaShape({ includeProviderState: false, includeLiveWriter: false, includeSessionSourceRevision: false, stampedVersion: 6 });
    }
    if (version === 7) {
      this.assertSchemaShape({ includeLiveWriter: false, includeSessionSourceRevision: false, stampedVersion: 7 });
    }
    if (version === 8) {
      this.assertSchemaShape({ includeSessionSourceRevision: false, stampedVersion: 8 });
    }
    // ODR-2 v9 safety boundary: no older schema may already contain the v9
    // revision-binding column. Adopting such a column could trust provenance
    // written by an interrupted/out-of-tree migration, so reject before any
    // migration mutation rather than attempting repair or backfill.
    if (version < 9 && this.columnExists('agent_sessions', 'source_revision')) {
      throw new BridgeError('INTERNAL', `agent job DB schema v${version} contains partial v9 session source-revision state; refusing automatic repair`, 500);
    }
    // B8 safety boundary: no historical schema may already contain any v8
    // live-writer objects or columns. Treat that as an interrupted/out-of-tree
    // migration and fail before beginning our transaction; never adopt or repair
    // partial writer authority because doing so could fabricate provenance.
    if (version < 8) {
      const partialWriter = this.db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('live_writer_leases','idx_live_writer_one_held_target','idx_live_writer_owner_once') ORDER BY name`).all() as { name: string }[];
      if (partialWriter.length > 0 || this.columnExists('agent_apply_attempts','worktree_id') || this.columnExists('agent_apply_attempts','writer_lease_id')) {
        throw new BridgeError('INTERNAL', `agent job DB schema v${version} contains partial v8 live-writer state; refusing automatic repair`, 500);
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (version < 1) {
        // Fresh install → create at the latest shape (base_commit, applied_at,
        // disposition_at, all A6 artifact metadata columns, and v5 retention
        // snapshot columns included).
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
            artifact_op_count  INTEGER,
            retention_class    TEXT,
            retention_duration_ms INTEGER,
            retain_until       TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status);
          CREATE INDEX IF NOT EXISTS idx_agent_jobs_principal ON agent_jobs(principal_id);
        `);
        // v6/v7: fresh install also creates session and provider-admission state.
        this._sessionStore.createSchema();
        this.createProviderAdmissionSchema();
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
      if (version < 5) {
        // v4 (A6-B5) → v5 (A6 retention lifecycle): durable per-job retention
        // snapshot. Additive only — all three columns NULL for every pre-v5 row.
        // Never backfilled from current config. GC eligibility proof requires all
        // three to be non-NULL; legacy rows fail closed (RETAIN + REPORT).
        if (!this.columnExists('agent_jobs', 'retention_class')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN retention_class TEXT');
        }
        if (!this.columnExists('agent_jobs', 'retention_duration_ms')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN retention_duration_ms INTEGER');
        }
        if (!this.columnExists('agent_jobs', 'retain_until')) {
          this.db.exec('ALTER TABLE agent_jobs ADD COLUMN retain_until TEXT');
        }
      }
      if (version < 6) {
        // v5 (A6 retention) → v6 (A8 session continuity).
        this._sessionStore.createSchema();
      }
      if (version < 7) {
        // v6 (A8) → v7 (P3): sanitized provider admission state plus the new
        // raw-prompt minimization policy. Historical active/queued prompts are
        // preserved because restartable work still needs them; terminal prompt
        // bodies are intentionally scrubbed while prompt_hash and every other
        // historical fact remain unchanged.
        this.createProviderAdmissionSchema();
        this.db.exec(`
          UPDATE agent_jobs SET prompt = ''
          WHERE status NOT IN ('QUEUED','PREPARING','RUNNING','VALIDATING')
            AND prompt <> ''
        `);
      }
      if (version < 8) {
        // v7 (P3) → v8 (P7 B8): one durable shared live-worktree writer authority.
        // Historical apply rows retain NULL worktree/lease fields; provenance is
        // never fabricated from current configuration during migration.
        this.createLiveWriterSchema();
        if (!this.columnExists('agent_apply_attempts', 'worktree_id')) {
          this.db.exec('ALTER TABLE agent_apply_attempts ADD COLUMN worktree_id TEXT');
        }
        if (!this.columnExists('agent_apply_attempts', 'writer_lease_id')) {
          this.db.exec('ALTER TABLE agent_apply_attempts ADD COLUMN writer_lease_id TEXT REFERENCES live_writer_leases(writer_lease_id)');
        }
      }
      if (version < 9) {
        // v8 (P7 B8) → v9 (A8 ODR-2): bind resumable provider sessions to the
        // trusted committed source revision they last observed. Historical
        // sessions remain NULL rather than fabricating provenance from current
        // source. Writer resume fails closed on NULL/drift; read-only resume
        // may continue only after fresh staging attests the current revision.
        if (!this.columnExists('agent_sessions', 'source_revision')) {
          this.db.exec('ALTER TABLE agent_sessions ADD COLUMN source_revision TEXT');
        }
      }
      this.db.exec(`PRAGMA user_version=${AGENT_JOB_SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    // A forward migration that stamped the current version must also have
    // PRODUCED the current shape. Verify it so an incomplete
    // migration can never be accepted just because it reached the stamp.
    this.assertSchemaShape();
  }

  get schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return Number(row.user_version);
  }

  /** A8: access the session store (shares same DB connection). */
  get sessionStore(): AgentSessionStore {
    return this._sessionStore;
  }

  private validateNewJob(job: NewAgentJob): void {
    if (job.prompt.length > MAX_AGENT_PROMPT_CHARS) {
      throw new BridgeError('MALFORMED_REQUEST', `prompt exceeds ${MAX_AGENT_PROMPT_CHARS} chars`, 400);
    }
    if (!(AGENT_RETENTION_CLASSES as readonly string[]).includes(job.retentionClass)) {
      throw new BridgeError('MALFORMED_REQUEST', `invalid retentionClass: ${String(job.retentionClass)}`, 400);
    }
    if (!Number.isSafeInteger(job.retentionDurationMs) || job.retentionDurationMs <= 0) {
      throw new BridgeError('MALFORMED_REQUEST', `retentionDurationMs must be a positive safe integer (got ${job.retentionDurationMs})`, 400);
    }
  }

  /** Must be called while holding BEGIN IMMEDIATE for race-free admission. */
  private assertQueueCapacity(): void {
    const queued = this.countQueued();
    if (queued >= MAX_AGENT_QUEUED_JOBS) {
      throw new BridgeError(
        'CONCURRENCY_LIMIT',
        `agent queue is full (${queued}/${MAX_AGENT_QUEUED_JOBS}); retry after queued work completes`,
        429,
      );
    }
  }

  private insertRow(job: NewAgentJob, backendSessionId: string | null = null, createdAt: string = nowIso()): void {
    this.db.prepare(`
      INSERT INTO agent_jobs (job_id, principal_id, backend, project, profile, resource_policy,
        status, created_at, prompt_hash, prompt, session_policy, writer, backend_session_id,
        retention_class, retention_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.jobId, job.principalId, job.backend, job.project, job.profile, job.resourcePolicy,
      createdAt, job.promptHash, job.prompt, job.sessionPolicy, job.writer ? 1 : 0, backendSessionId,
      job.retentionClass, job.retentionDurationMs);
  }

  private queuedRow(job: NewAgentJob, createdAt: string, backendSessionId: string | null = null): AgentJobRow {
    return {
      jobId: job.jobId,
      principalId: job.principalId,
      backend: job.backend,
      project: job.project,
      profile: job.profile,
      resourcePolicy: job.resourcePolicy,
      status: 'QUEUED',
      failureCode: null,
      failureReason: null,
      createdAt,
      startedAt: null,
      completedAt: null,
      promptHash: job.promptHash,
      prompt: job.prompt,
      summary: null,
      exitCode: null,
      backendSessionId,
      sessionPolicy: job.sessionPolicy,
      writer: job.writer,
      baseCommit: null,
      appliedAt: null,
      dispositionAt: null,
      retentionClass: job.retentionClass,
      retentionDurationMs: job.retentionDurationMs,
      retainUntil: null,
      artifactHash: null,
      changeSetHash: null,
      artifactState: null,
      artifactContentComplete: null,
      artifactApplicable: null,
      artifactReason: null,
      artifactVolume: null,
      artifactBytes: null,
      artifactOpCount: null,
    };
  }

  insert(job: NewAgentJob): AgentJobRow {
    this.validateNewJob(job);
    const createdAt = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertQueueCapacity();
      this.insertRow(job, null, createdAt);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.queuedRow(job, createdAt);
  }

  /**
   * A8 R1 atomic resume admission. The job row and ACTIVE -> RESERVED session
   * transition commit together under BEGIN IMMEDIATE. Two dispatches can never
   * reserve the same provider session, and a failed INSERT cannot leak a lease.
   *
   * A8 R2 post-COMMIT invariant: COMMIT is the authoritative success boundary
   * for this atomic transition. Once COMMIT succeeds, this method returns only
   * deterministic data known from the transaction/input; no diagnostic SELECT
   * may convert the committed RESERVED + QUEUED state into dispatch failure.
   */
  insertWithSessionReservation(job: NewAgentJob, binding: SessionReservationBinding): AgentJobRow {
    this.validateNewJob(job);
    const createdAt = nowIso();
    let reservedSessionId: string | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertQueueCapacity();
      const session = this._sessionStore.findActiveSession(
        binding.principalId, binding.project, binding.backend, binding.profile,
      );
      if (!session) {
        throw new BridgeError(
          'SESSION_NOT_RESUMABLE',
          `no active session found for the current authorized context (principal=${binding.principalId}, project=${binding.project}, backend=${binding.backend}, profile=${binding.profile})`,
          409,
        );
      }
      if (!this._sessionStore.reserveSession(session.sessionId, job.jobId)) {
        throw new BridgeError('SESSION_NOT_RESUMABLE', `session ${session.sessionId} could not be reserved`, 409);
      }
      reservedSessionId = session.sessionId;
      this.insertRow(job, reservedSessionId, createdAt);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.queuedRow(job, createdAt, reservedSessionId);
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
    // P3 privacy boundary: once execution is over, raw prompt text has no
    // remaining authority or recovery purpose. Keep prompt_hash, purge body.
    if (to === 'COMPLETED' || to === 'CANCELLED' || isAgentFailureStatus(to)) {
      sets.push("prompt = ''");
    }
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

  /**
   * Persist the opaque QuaranGate session ID returned by the backend after a
   * job completes (A8). Stores the QUARANGATE session id (sess_…), NOT the
   * raw provider session id. The provider session id is kept in
   * `agent_sessions.provider_session_id` and never written here.
   *
   * Called once per job, after the backend's `validate()` returns a sessionId.
   * Independent of status CAS — provenance, set at most once.
   */
  setBackendSessionId(jobId: string, sessionId: string): boolean {
    const res = this.db.prepare(
      'UPDATE agent_jobs SET backend_session_id = ? WHERE job_id = ?',
    ).run(sessionId, jobId);
    return Number(res.changes) === 1;
  }

  /**
   * A8 R1 atomic success boundary. Source-session consumption, successor
   * creation, job session pointer, and VALIDATING -> COMPLETED commit in ONE
   * SQLite transaction. If any statement fails, no session lifecycle change
   * survives. Artifact publication (when required) must already be AVAILABLE.
   *
   * A8 R2 post-COMMIT invariant: COMMIT is the authoritative success boundary
   * for this atomic transition. Once COMMIT succeeds, this method returns a
   * completed row derived from the pre-COMMIT job row and deterministic input;
   * no diagnostic/readback SELECT may convert committed success into failure or
   * trigger provider/session invalidation in the caller.
   */
  finalizeCompletedWithSession(input: CompleteJobWithSessionInput): AgentJobRow {
    let completed: AgentJobRow | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        'SELECT * FROM agent_jobs WHERE job_id = ?',
      ).get(input.jobId) as Record<string, unknown> | undefined;
      if (!row) {
        throw new BridgeError('INVALID_JOB_TRANSITION', `job ${input.jobId} is not VALIDATING at atomic completion`, 409);
      }
      const existing = rowToJob(row);
      if (existing.status !== 'VALIDATING') {
        throw new BridgeError('INVALID_JOB_TRANSITION', `job ${input.jobId} is not VALIDATING at atomic completion`, 409);
      }
      if (input.requireArtifact && existing.artifactState !== 'AVAILABLE') {
        throw new BridgeError('ARTIFACT_REQUIRED', `job ${input.jobId} lacks AVAILABLE artifact at atomic completion`, 500);
      }

      if (input.sourceSessionId) {
        if (existing.sessionPolicy !== 'resume' || existing.backendSessionId !== input.sourceSessionId) {
          throw new BridgeError('SESSION_NOT_RESUMABLE', `job ${input.jobId} source session identity changed before completion`, 409);
        }
        if (!this._sessionStore.consumeReservedSession(input.sourceSessionId, input.jobId)) {
          throw new BridgeError('SESSION_NOT_RESUMABLE', `source session ${input.sourceSessionId} is not reserved by job ${input.jobId}`, 409);
        }
      }

      let successorId: string | null = null;
      if (input.successor) {
        this._sessionStore.insertSession(input.successor);
        successorId = input.successor.sessionId;
      }

      const res = this.db.prepare(`
        UPDATE agent_jobs
        SET status = 'COMPLETED', completed_at = ?, summary = ?, exit_code = ?,
            backend_session_id = ?, prompt = ''
        WHERE job_id = ? AND status = 'VALIDATING'
      `).run(input.completedAt, input.summary, input.exitCode, successorId, input.jobId);
      if (Number(res.changes) !== 1) {
        throw new BridgeError('INVALID_JOB_TRANSITION', `job ${input.jobId} lost VALIDATING state during atomic completion`, 409);
      }
      completed = {
        ...existing,
        status: 'COMPLETED',
        completedAt: input.completedAt,
        summary: input.summary,
        exitCode: input.exitCode,
        backendSessionId: successorId,
        prompt: '',
      };
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return completed!;
  }

  /**
   * Cancel a QUEUED job and safely release its un-used A8 reservation in the
   * same transaction. Active jobs are handled by the normal cancellation path
   * because provider use may already have begun.
   */
  cancelQueuedWithSessionRelease(jobId: string, completedAt: string, reason: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        'SELECT status, session_policy, backend_session_id FROM agent_jobs WHERE job_id = ?',
      ).get(jobId) as { status: AgentJobStatus; session_policy: string; backend_session_id: string | null } | undefined;
      if (!row || row.status !== 'QUEUED') { this.db.exec('COMMIT'); return false; }
      if (row.session_policy === 'resume' && row.backend_session_id) {
        this._sessionStore.releaseReservation(row.backend_session_id, jobId);
      }
      const res = this.db.prepare(`
        UPDATE agent_jobs SET status = 'CANCELLED', completed_at = ?,
          failure_code = 'CANCELLED', failure_reason = ?, prompt = ''
        WHERE job_id = ? AND status = 'QUEUED'
      `).run(completedAt, reason.slice(0, 500), jobId);
      this.db.exec('COMMIT');
      return Number(res.changes) === 1;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
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

  countQueued(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs WHERE status = 'QUEUED'`).get() as { n: number };
    return Number(r.n);
  }

  /** P3 durable provider admission state. No provider payloads are stored. */
  getProviderAdmissionState(backend: string): ProviderAdmissionState {
    const row = this.db.prepare(`
      SELECT backend, consecutive_failures, last_failure_at, last_failure_code,
             last_success_at, cooldown_until, circuit_state, updated_at
      FROM agent_provider_state WHERE backend = ?
    `).get(backend) as Record<string, unknown> | undefined;
    if (!row) {
      return {
        backend, consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
        lastSuccessAt: null, cooldownUntil: null, circuitState: 'CLOSED', updatedAt: null,
      };
    }
    const failures = Number(row.consecutive_failures);
    const circuit = String(row.circuit_state);
    if (!Number.isSafeInteger(failures) || failures < 0 || (circuit !== 'CLOSED' && circuit !== 'OPEN')) {
      throw new BridgeError('INTERNAL', `provider admission state for ${backend} is malformed`, 500);
    }
    const optText = (v: unknown): string | null => v === null || v === undefined ? null : String(v);
    return {
      backend: String(row.backend),
      consecutiveFailures: failures,
      lastFailureAt: optText(row.last_failure_at),
      lastFailureCode: optText(row.last_failure_code),
      lastSuccessAt: optText(row.last_success_at),
      cooldownUntil: optText(row.cooldown_until),
      circuitState: circuit as ProviderCircuitState,
      updatedAt: optText(row.updated_at),
    };
  }

  /** Reject provider work while a persisted cooldown/circuit window is active. */
  assertProviderAdmissible(backend: string, nowMs: number = Date.now()): void {
    const state = this.getProviderAdmissionState(backend);
    if (!state.cooldownUntil) return;
    const untilMs = Date.parse(state.cooldownUntil);
    if (!Number.isFinite(untilMs)) {
      throw new BridgeError('INTERNAL', `provider admission cooldown for ${backend} is malformed`, 500);
    }
    if (untilMs <= nowMs) return;
    const retryAfterMs = Math.max(1, Math.ceil(untilMs - nowMs));
    throw new BridgeError(
      'RATE_LIMITED',
      `backend ${backend} is cooling down (${state.circuitState.toLowerCase()} circuit)`,
      429,
      retryAfterMs,
    );
  }

  /**
   * Persist a sanitized provider failure and compute the next bounded cooldown.
   * `jitterUnit` is an injectable [0,1] test seam; production uses crypto RNG.
   */
  recordProviderFailure(
    backend: string,
    failureCode: string,
    retryAfterMs?: number,
    nowMs: number = Date.now(),
    jitterUnit?: number,
  ): ProviderAdmissionState {
    if (!/^[A-Z0-9_:-]{1,64}$/.test(failureCode)) {
      throw new BridgeError('INTERNAL', 'invalid provider failure code', 500);
    }
    const current = this.getProviderAdmissionState(backend);
    const failures = current.consecutiveFailures + 1;
    const exponent = Math.min(20, Math.max(0, failures - 1));
    const base = Math.min(PROVIDER_BACKOFF_MAX_MS, PROVIDER_BACKOFF_BASE_MS * (2 ** exponent));
    const jitterMax = Math.floor(base * PROVIDER_BACKOFF_JITTER_FRACTION);
    const boundedUnit = jitterUnit === undefined
      ? (jitterMax > 0 ? randomInt(jitterMax + 1) / jitterMax : 0)
      : Math.min(1, Math.max(0, jitterUnit));
    const jitter = Math.floor(jitterMax * boundedUnit);
    const backoff = Math.min(PROVIDER_BACKOFF_MAX_MS, base + jitter);
    const providerHint = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.ceil(retryAfterMs))
      : 0;
    const circuitState: ProviderCircuitState = failures >= PROVIDER_CIRCUIT_FAILURE_THRESHOLD ? 'OPEN' : 'CLOSED';
    const cooldownMs = Math.max(
      backoff,
      providerHint,
      circuitState === 'OPEN' ? PROVIDER_CIRCUIT_OPEN_MS : 0,
    );
    const at = new Date(nowMs).toISOString();
    const cooldownUntil = new Date(nowMs + cooldownMs).toISOString();
    this.db.prepare(`
      INSERT INTO agent_provider_state
        (backend, consecutive_failures, last_failure_at, last_failure_code, last_success_at, cooldown_until, circuit_state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backend) DO UPDATE SET
        consecutive_failures = excluded.consecutive_failures,
        last_failure_at = excluded.last_failure_at,
        last_failure_code = excluded.last_failure_code,
        last_success_at = excluded.last_success_at,
        cooldown_until = excluded.cooldown_until,
        circuit_state = excluded.circuit_state,
        updated_at = excluded.updated_at
    `).run(
      backend, failures, at, failureCode, current.lastSuccessAt, cooldownUntil, circuitState, at,
    );
    return this.getProviderAdmissionState(backend);
  }

  /** A successful real provider completion closes the circuit and clears cooldown. */
  recordProviderSuccess(backend: string, nowMs: number = Date.now()): ProviderAdmissionState {
    const at = new Date(nowMs).toISOString();
    this.db.prepare(`
      INSERT INTO agent_provider_state
        (backend, consecutive_failures, last_failure_at, last_failure_code, last_success_at, cooldown_until, circuit_state, updated_at)
      VALUES (?, 0, NULL, NULL, ?, NULL, 'CLOSED', ?)
      ON CONFLICT(backend) DO UPDATE SET
        consecutive_failures = 0,
        last_failure_at = NULL,
        last_failure_code = NULL,
        last_success_at = excluded.last_success_at,
        cooldown_until = NULL,
        circuit_state = 'CLOSED',
        updated_at = excluded.updated_at
    `).run(backend, at, at);
    return this.getProviderAdmissionState(backend);
  }

  hasQueued(): boolean {
    return this.countQueued() > 0;
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
  // P7 B8: shared live-worktree writer arbitration
  // -------------------------------------------------------------------------

  getLiveWriterLease(writerLeaseId: string): LiveWriterLeaseRow | undefined {
    assertLiveWriterLeaseId(writerLeaseId);
    const row = this.db.prepare('SELECT * FROM live_writer_leases WHERE writer_lease_id=?').get(writerLeaseId) as Record<string, unknown> | undefined;
    return row ? rowToLiveWriterLease(row) : undefined;
  }

  acquireLiveWriterLease(input: AcquireLiveWriterLeaseInput): LiveWriterLeaseRow {
    this.validateLiveWriterInput(input);
    if (input.ownerKind === 'agent_apply') throw new BridgeError('PRECONDITION_FAILED','agent_apply writer leases must be acquired atomically by startApplyAttempt',409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.acquireLiveWriterLeaseTx(input);
      this.db.exec('COMMIT');
      return lease;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  releaseLiveWriterLease(input: AcquireLiveWriterLeaseInput & { writerLeaseId: string; reason?: string }): boolean {
    this.validateLiveWriterInput(input); assertLiveWriterLeaseId(input.writerLeaseId);
    if (input.ownerKind === 'agent_apply') throw new BridgeError('PRECONDITION_FAILED','agent_apply writer leases are released only by apply terminalization',409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.finishLiveWriterLeaseTx(input, input.writerLeaseId, 'RELEASED', input.reason ?? 'writer completed safely');
      this.db.exec('COMMIT');
      return changed;
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }

  markLiveWriterUncertain(input: AcquireLiveWriterLeaseInput & { writerLeaseId: string; reason: string }): boolean {
    this.validateLiveWriterInput(input); assertLiveWriterLeaseId(input.writerLeaseId);
    if (input.ownerKind === 'agent_apply') throw new BridgeError('PRECONDITION_FAILED','agent_apply uncertainty is coupled to project quarantine',409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.finishLiveWriterLeaseTx(input, input.writerLeaseId, 'UNCERTAIN', input.reason);
      this.db.exec('COMMIT');
      return changed;
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }

  private validateLiveWriterInput(input: AcquireLiveWriterLeaseInput): void {
    assertLiveWriterLogicalId(input.projectId, 'projectId');
    assertLiveWriterLogicalId(input.worktreeId, 'worktreeId');
    if (!(LIVE_WRITER_OWNER_KINDS as readonly string[]).includes(input.ownerKind)) {
      throw new BridgeError('MALFORMED_REQUEST', 'invalid live-writer owner kind', 400);
    }
    assertLiveWriterOwner(input.ownerKind, input.ownerId);
    assertLiveWriterPrincipalId(input.principalId);
  }

  private acquireLiveWriterLeaseTx(input: AcquireLiveWriterLeaseInput): LiveWriterLeaseRow {
    this.validateLiveWriterInput(input);
    const projectState = this.db.prepare('SELECT state FROM agent_project_apply_state WHERE project_id=?').get(input.projectId) as { state: string } | undefined;
    if (projectState?.state === 'QUARANTINED') {
      throw new BridgeError('PROJECT_QUARANTINED', `project ${input.projectId} is quarantined and cannot accept a live writer`, 409);
    }
    const existingOwner = this.db.prepare('SELECT * FROM live_writer_leases WHERE owner_kind=? AND owner_id=?').get(input.ownerKind,input.ownerId) as Record<string,unknown>|undefined;
    if (existingOwner) {
      throw new BridgeError('LIVE_WRITER_BINDING_MISMATCH', `live-writer owner ${input.ownerKind}/${input.ownerId} has already been used`, 409);
    }
    const writerLeaseId = `wrl_${randomBytes(16).toString('hex')}`;
    const acquiredAt = nowIso();
    try {
      this.db.prepare(`INSERT INTO live_writer_leases
        (writer_lease_id,project_id,worktree_id,owner_kind,owner_id,principal_id,state,acquired_at)
        VALUES (?,?,?,?,?,?,'ACTIVE',?)`).run(
        writerLeaseId,input.projectId,input.worktreeId,input.ownerKind,input.ownerId,input.principalId,acquiredAt,
      );
    } catch (e) {
      if (isUniqueConstraintViolation(e)) {
        const held = this.db.prepare(`SELECT writer_lease_id,state,owner_kind,owner_id FROM live_writer_leases
          WHERE project_id=? AND worktree_id=? AND state IN ('ACTIVE','UNCERTAIN')`).get(input.projectId,input.worktreeId) as Record<string,unknown>|undefined;
        if (held) throw new BridgeError('LIVE_WRITER_BUSY', `live writer already held for ${input.projectId}/${input.worktreeId}`, 409);
        throw new BridgeError('LIVE_WRITER_BINDING_MISMATCH', 'live-writer owner identity has already been used', 409);
      }
      throw e;
    }
    return this.getLiveWriterLease(writerLeaseId)!;
  }

  private requireExactLiveWriterTx(input: AcquireLiveWriterLeaseInput, writerLeaseId: string): LiveWriterLeaseRow {
    const row = this.db.prepare('SELECT * FROM live_writer_leases WHERE writer_lease_id=?').get(writerLeaseId) as Record<string,unknown>|undefined;
    if (!row) throw new BridgeError('LIVE_WRITER_BINDING_MISMATCH', 'live-writer lease does not exist', 409);
    const lease = rowToLiveWriterLease(row);
    if (lease.projectId!==input.projectId || lease.worktreeId!==input.worktreeId || lease.ownerKind!==input.ownerKind
      || lease.ownerId!==input.ownerId || lease.principalId!==input.principalId) {
      throw new BridgeError('LIVE_WRITER_BINDING_MISMATCH', 'live-writer lease binding mismatch', 409);
    }
    return lease;
  }

  private finishLiveWriterLeaseTx(
    input: AcquireLiveWriterLeaseInput,
    writerLeaseId: string,
    to: 'RELEASED'|'UNCERTAIN',
    reason: string,
  ): boolean {
    const lease = this.requireExactLiveWriterTx(input, writerLeaseId);
    if (lease.state === 'UNCERTAIN') {
      if (to === 'UNCERTAIN') return false;
      throw new BridgeError('LIVE_WRITER_UNCERTAIN', 'uncertain live-writer lease cannot be released automatically', 409);
    }
    if (lease.state === 'RELEASED') return false;
    const bounded = reason.slice(0, MAX_APPLY_ATTEMPT_REASON_CHARS);
    const result = this.db.prepare(`UPDATE live_writer_leases SET state=?,finished_at=?,reason=?
      WHERE writer_lease_id=? AND state='ACTIVE'`).run(to,nowIso(),bounded,writerLeaseId);
    if (Number(result.changes)!==1) throw new BridgeError('LIVE_WRITER_BINDING_MISMATCH','live-writer transition lost CAS race',409);
    return true;
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
    assertLiveWriterLogicalId(attempt.worktreeId, 'worktreeId');
    // Production apply attempt IDs are the live-writer owner identity too.
    assertLiveWriterOwner('agent_apply', attempt.attemptId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(attempt.jobId) as Record<string, unknown> | undefined;
      if (!job) throw new BridgeError('UNKNOWN_JOB', `job ${attempt.jobId} does not exist`, 404);
      if (String(job.status) !== 'COMPLETED') {
        throw new BridgeError('PRECONDITION_FAILED', `job ${attempt.jobId} is ${String(job.status)}, not COMPLETED; apply attempts may only be started for COMPLETED jobs`, 409);
      }
      const existingAttempt = this.db.prepare('SELECT 1 FROM agent_apply_attempts WHERE attempt_id = ?').get(attempt.attemptId);
      if (existingAttempt) throw new BridgeError('DUPLICATE_ATTEMPT_ID', `apply attempt ${attempt.attemptId} already exists`, 409);

      // Derived durable provenance. project/principal come only from the job;
      // worktreeId comes only from trusted Agent project config above this store.
      const projectId = String(job.project);
      const principalId = String(job.principal_id);
      assertLiveWriterLogicalId(projectId, 'projectId');
      assertLiveWriterPrincipalId(principalId);
      const baseCommit = (job.base_commit ?? null) as string | null;
      const expectedArtifactHash = (job.artifact_hash ?? null) as string | null;

      const proj = this.db.prepare('SELECT state FROM agent_project_apply_state WHERE project_id = ?').get(projectId) as { state: string } | undefined;
      if (proj?.state === 'QUARANTINED') throw new BridgeError('PROJECT_QUARANTINED', `project ${projectId} is quarantined and cannot accept new apply attempts`, 409);

      // Preserve A6's more-specific same-apply-lane conflict before asking the
      // shared B8 arbiter. BEGIN IMMEDIATE makes this check+insert serialized;
      // the historical partial unique indexes remain a second hard authority.
      const activeAttempt = this.db.prepare(`SELECT 1 FROM agent_apply_attempts
        WHERE (job_id=? OR project_id=?) AND state IN (${ACTIVE_ATTEMPT_SQL_LIST}) LIMIT 1`).get(attempt.jobId,projectId);
      if (activeAttempt) throw new BridgeError('APPLY_ATTEMPT_ACTIVE', `an apply attempt is already active for job ${attempt.jobId} or project ${projectId}`, 409);

      const lease = this.acquireLiveWriterLeaseTx({
        projectId, worktreeId: attempt.worktreeId, ownerKind: 'agent_apply', ownerId: attempt.attemptId, principalId,
      });
      try {
        this.db.prepare(`INSERT INTO agent_apply_attempts
          (attempt_id,job_id,project_id,principal_id,expected_artifact_hash,base_commit,state,started_at,worktree_id,writer_lease_id)
          VALUES (?,?,?,?,?,?,'STARTED',?,?,?)`).run(
          attempt.attemptId,attempt.jobId,projectId,principalId,expectedArtifactHash,baseCommit,nowIso(),attempt.worktreeId,lease.writerLeaseId,
        );
      } catch (e) {
        if (isUniqueConstraintViolation(e)) throw new BridgeError('APPLY_ATTEMPT_ACTIVE', `an apply attempt is already active for job ${attempt.jobId} or project ${projectId}`, 409);
        throw e;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
    return this.getApplyAttempt(attempt.attemptId)!;
  }

  private finishApplyWriterLeaseTx(attemptId: string, to: 'RELEASED'|'UNCERTAIN', reason: string): boolean {
    const row = this.db.prepare(`SELECT project_id,principal_id,worktree_id,writer_lease_id FROM agent_apply_attempts WHERE attempt_id=?`).get(attemptId) as
      {project_id:string; principal_id:string|null; worktree_id:string|null; writer_lease_id:string|null}|undefined;
    if (!row) throw new BridgeError('LIVE_WRITER_BINDING_MISMATCH', `apply attempt ${attemptId} disappeared while settling its writer lease`, 500);
    // Historical pre-B8 attempts legitimately have neither field. Startup
    // recovery still quarantines any historical APPLYING attempt before new
    // writer admission, so no authority is fabricated here.
    if (row.worktree_id===null && row.writer_lease_id===null) return false;
    if (row.worktree_id===null || row.writer_lease_id===null || row.principal_id===null) {
      throw new BridgeError('LIVE_WRITER_BINDING_MISMATCH', `apply attempt ${attemptId} has incomplete B8 writer provenance`, 500);
    }
    const input:AcquireLiveWriterLeaseInput={projectId:row.project_id,worktreeId:row.worktree_id,ownerKind:'agent_apply',ownerId:attemptId,principalId:row.principal_id};
    return this.finishLiveWriterLeaseTx(input,row.writer_lease_id,to,reason);
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
      throw new BridgeError('INVALID_ATTEMPT_TRANSITION', `apply attempt transition to ${to} must go through its dedicated atomic primitive, not the generic transition`, 409);
    }
    assertApplyAttemptTransition(from, to);
    const safeTerminal = to === 'PRECONDITION_FAILED' || to === 'ARTIFACT_INVALID' || to === 'FAILED_ROLLED_BACK' || to === 'ABORTED_NO_MUTATION';
    const sets: string[] = ['state = ?'];
    const args: (string | number | null)[] = [to];
    if (safeTerminal && extras.finishedAt === undefined) { sets.push('finished_at = ?'); args.push(nowIso()); }
    else if (extras.finishedAt !== undefined) { sets.push('finished_at = ?'); args.push(extras.finishedAt); }
    if (extras.reason !== undefined) { sets.push('reason = ?'); args.push(extras.reason.slice(0, MAX_APPLY_ATTEMPT_REASON_CHARS)); }
    if (extras.successEvidence !== undefined) { sets.push('success_evidence = ?'); args.push(extras.successEvidence.slice(0, MAX_APPLY_ATTEMPT_EVIDENCE_CHARS)); }
    if (extras.rollbackEvidence !== undefined) { sets.push('rollback_evidence = ?'); args.push(extras.rollbackEvidence.slice(0, MAX_APPLY_ATTEMPT_EVIDENCE_CHARS)); }
    if (extras.mutatedPathCount !== undefined) { sets.push('mutated_path_count = ?'); args.push(extras.mutatedPathCount); }
    if (extras.applierImage !== undefined) { sets.push('applier_image = ?'); args.push(extras.applierImage); }
    args.push(attemptId, from);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db.prepare(`UPDATE agent_apply_attempts SET ${sets.join(', ')} WHERE attempt_id = ? AND state = ?`).run(...args);
      if (Number(res.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }
      if (safeTerminal) this.finishApplyWriterLeaseTx(attemptId,'RELEASED',extras.reason ?? `apply attempt ended ${to}`);
      this.db.exec('COMMIT');
      return true;
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }

  /**
   * Atomically commit a verified successful apply: in ONE DB transaction,
   * attempt APPLYING -> VERIFIED_SUCCESS AND job COMPLETED -> APPLIED with
   * applied_at = disposition_at = T and retain_until = T + retention_duration_ms.
   *
   * Generates ONE canonical timestamp T for applied_at, disposition_at, and
   * retain_until derivation — never calls nowIso() independently for each.
   *
   * Fails closed if retention_duration_ms is missing/invalid on a new post-v5
   * row. Legacy rows (NULL retention_duration_ms) receive NULL retain_until —
   * they are not eligible for automatic GC (RETAIN + REPORT by the collector).
   *
   * Neither half is ever persisted without the other — a restart mid-transaction
   * rolls back to the pre-success state entirely (SQLite transaction durability).
   */
  markApplySuccess(
    attemptId: string,
    jobId: string,
    extras: { successEvidence?: string; mutatedPathCount?: number } = {},
  ): boolean {
    assertApplyAttemptTransition('APPLYING', 'VERIFIED_SUCCESS');
    assertAgentJobTransition('COMPLETED', 'APPLIED');
    // ONE canonical timestamp — applied_at and disposition_at receive the SAME value.
    const T = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const a = this.db.prepare(`
        UPDATE agent_apply_attempts
        SET state = 'VERIFIED_SUCCESS', finished_at = ?, success_evidence = ?, mutated_path_count = ?
        WHERE attempt_id = ? AND job_id = ? AND state = 'APPLYING'
      `).run(
        T,
        extras.successEvidence !== undefined ? extras.successEvidence.slice(0, MAX_APPLY_ATTEMPT_EVIDENCE_CHARS) : null,
        extras.mutatedPathCount ?? null,
        attemptId, jobId,
      );
      if (Number(a.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }

      // Compute retain_until from the persisted retention_duration_ms of this
      // exact job row. Fail closed if the value is invalid: never fabricate a
      // retention anchor for a post-v5 job that is missing its snapshot.
      const jobRow = this.db.prepare(
        'SELECT retention_duration_ms FROM agent_jobs WHERE job_id = ?',
      ).get(jobId) as { retention_duration_ms: number | null } | undefined;
      let retainUntil: string | null = null;
      if (jobRow?.retention_duration_ms !== null && jobRow?.retention_duration_ms !== undefined) {
        const rdms = jobRow.retention_duration_ms;
        if (!Number.isSafeInteger(rdms) || rdms <= 0) {
          // Throw only — the catch below owns the single ROLLBACK for this
          // transaction. Rolling back here as well would leave no active
          // transaction for the catch, and SQLite's resulting
          // "cannot rollback - no transaction is active" error would replace
          // this BridgeError as the error the caller sees.
          throw new BridgeError(
            'MALFORMED_REQUEST',
            `job ${jobId} has invalid retention_duration_ms (${rdms}); refusing to produce APPLIED state with fabricated retention metadata`,
            500,
          );
        }
        retainUntil = new Date(Date.parse(T) + rdms).toISOString();
      }

      const j = this.db.prepare(`
        UPDATE agent_jobs
        SET status = 'APPLIED', applied_at = ?, disposition_at = ?, retain_until = ?, prompt = ''
        WHERE job_id = ? AND status = 'COMPLETED'
      `).run(T, T, retainUntil, jobId);
      if (Number(j.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.finishApplyWriterLeaseTx(attemptId, 'RELEASED', 'agent_apply verified success');
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Atomically discard a completed job: in ONE DB transaction, job
   * COMPLETED -> DISCARDED with disposition_at = T and
   * retain_until = T + retention_duration_ms (when available).
   *
   * Generates ONE canonical timestamp T. Fails closed if retention_duration_ms
   * is invalid on a post-v5 row. Legacy rows (NULL retention_duration_ms)
   * receive NULL retain_until — not eligible for automatic GC.
   *
   * Denies the discard (no mutation) if:
   * - an apply attempt is currently active (STARTED/VERIFYING/APPLYING) for
   *   this job — throws APPLY_ATTEMPT_ACTIVE.
   * - ANY apply attempt for this job is UNCERTAIN — throws
   *   APPLY_ATTEMPT_UNCERTAIN.
   * Discarding a job never clears any project quarantine.
   */
  discardJob(jobId: string): boolean {
    assertAgentJobTransition('COMPLETED', 'DISCARDED');
    // ONE canonical timestamp.
    const T = nowIso();
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

      // Compute retain_until from the persisted retention_duration_ms.
      const jobRow = this.db.prepare(
        'SELECT retention_duration_ms FROM agent_jobs WHERE job_id = ?',
      ).get(jobId) as { retention_duration_ms: number | null } | undefined;
      let retainUntil: string | null = null;
      if (jobRow?.retention_duration_ms !== null && jobRow?.retention_duration_ms !== undefined) {
        const rdms = jobRow.retention_duration_ms;
        if (!Number.isSafeInteger(rdms) || rdms <= 0) {
          // Throw only — see markApplySuccess: the catch below is the single
          // ROLLBACK owner, and a second rollback here would mask this error.
          throw new BridgeError(
            'MALFORMED_REQUEST',
            `job ${jobId} has invalid retention_duration_ms (${rdms}); refusing to produce DISCARDED state with fabricated retention metadata`,
            500,
          );
        }
        retainUntil = new Date(Date.parse(T) + rdms).toISOString();
      }

      const res = this.db.prepare(
        `UPDATE agent_jobs SET status = 'DISCARDED', disposition_at = ?, retain_until = ?, prompt = '' WHERE job_id = ? AND status = 'COMPLETED'`,
      ).run(T, retainUntil, jobId);
      this.db.exec('COMMIT');
      return Number(res.changes) === 1;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // A6 evidence lifecycle: expiry and retention queries
  // -------------------------------------------------------------------------

  /**
   * Atomically transition artifact_state AVAILABLE -> EXPIRED for a single
   * job. This is the durable authorization step (Proof A) — physical volume
   * deletion (Proof B, delete completion) follows after this succeeds.
   *
   * The UPDATE predicate mirrors the full Lane A admission proof:
   *   - artifact_state = AVAILABLE
   *   - status IN ('APPLIED', 'DISCARDED')
   *   - all retention snapshot fields present and retain_until elapsed
   *   - no active apply attempt (STARTED/VERIFYING/APPLYING)
   *   - no UNCERTAIN apply attempt
   *   - job is not the quarantine_causing_job_id for any QUARANTINED project
   *
   * `nowIso` is the collector's single canonical timestamp for the pass.
   * Returns true if the transition succeeded (rows_changed === 1).
   * Returns false if any predicate failed (race lost, already EXPIRED, etc.).
   * Never transitions back from EXPIRED to AVAILABLE.
   */
  markExpired(jobId: string, nowIso: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db.prepare(`
        UPDATE agent_jobs
        SET artifact_state = 'EXPIRED'
        WHERE job_id = ?
          AND artifact_state = 'AVAILABLE'
          AND status IN ('APPLIED', 'DISCARDED')
          AND disposition_at IS NOT NULL
          AND retention_class IS NOT NULL
          AND retention_duration_ms IS NOT NULL
          AND retain_until IS NOT NULL
          AND julianday(retain_until) <= julianday(?)
          AND NOT EXISTS (
            SELECT 1 FROM agent_apply_attempts
            WHERE job_id = agent_jobs.job_id
              AND state IN (${ACTIVE_ATTEMPT_SQL_LIST})
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_apply_attempts
            WHERE job_id = agent_jobs.job_id
              AND state = 'UNCERTAIN'
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_project_apply_state
            WHERE quarantine_causing_job_id = agent_jobs.job_id
              AND state = 'QUARANTINED'
          )
      `).run(jobId, nowIso);
      this.db.exec('COMMIT');
      return Number(res.changes) === 1;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Query all Lane A candidates: jobs with artifact_state=AVAILABLE,
   * terminal success disposition, and all retention snapshot fields populated,
   * where retain_until <= nowIso (by julianday comparison).
   *
   * Returns only the fields needed by the collector. Caller must perform
   * full ownership/safety proof before calling markExpired().
   */
  queryRetentionEligible(nowIso: string): Array<{
    jobId: string;
    artifactVolume: string;
    retentionClass: string;
    retentionDurationMs: number;
    retainUntil: string;
    dispositionAt: string;
    status: string;
  }> {
    const rows = this.db.prepare(`
      SELECT job_id, artifact_volume, retention_class, retention_duration_ms,
             retain_until, disposition_at, status
      FROM agent_jobs
      WHERE artifact_state = 'AVAILABLE'
        AND status IN ('APPLIED', 'DISCARDED')
        AND artifact_volume IS NOT NULL
        AND disposition_at IS NOT NULL
        AND retention_class IS NOT NULL
        AND retention_duration_ms IS NOT NULL
        AND retain_until IS NOT NULL
        AND julianday(retain_until) <= julianday(?)
    `).all(nowIso) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      jobId: String(r.job_id),
      artifactVolume: String(r.artifact_volume),
      retentionClass: String(r.retention_class),
      retentionDurationMs: Number(r.retention_duration_ms),
      retainUntil: String(r.retain_until),
      dispositionAt: String(r.disposition_at),
      status: String(r.status),
    }));
  }

  /**
   * Query all jobs where artifact_state=EXPIRED and artifact_volume is
   * recorded (for delete-completion reconciliation at startup).
   */
  queryExpiredWithVolume(): Array<{ jobId: string; artifactVolume: string }> {
    const rows = this.db.prepare(`
      SELECT job_id, artifact_volume
      FROM agent_jobs
      WHERE artifact_state = 'EXPIRED'
        AND artifact_volume IS NOT NULL
    `).all() as Array<{ job_id: string; artifact_volume: string }>;
    return rows.map((r) => ({ jobId: String(r.job_id), artifactVolume: String(r.artifact_volume) }));
  }

  /**
   * Query all jobs that could be Lane B candidates: jobs whose artifact_state
   * is NULL (no artifact lifecycle started), NONE, or has a published artifact
   * but with anomalous state combinations. Returns a representative sample
   * of the full job population for the classifier to inspect.
   *
   * The collector uses Docker volume discovery (not this query) as the primary
   * Lane B discovery path. This query provides the DB-side view for
   * cross-referencing volume labels against persisted job state.
   */
  getJobForClassification(jobId: string): {
    jobId: string;
    status: string;
    artifactState: string | null;
    artifactVolume: string | null;
    retentionClass: string | null;
    retentionDurationMs: number | null;
    retainUntil: string | null;
    dispositionAt: string | null;
  } | undefined {
    const r = this.db.prepare(`
      SELECT job_id, status, artifact_state, artifact_volume,
             retention_class, retention_duration_ms, retain_until, disposition_at
      FROM agent_jobs WHERE job_id = ?
    `).get(jobId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      jobId: String(r.job_id),
      status: String(r.status),
      artifactState: (r.artifact_state ?? null) as string | null,
      artifactVolume: (r.artifact_volume ?? null) as string | null,
      retentionClass: (r.retention_class ?? null) as string | null,
      retentionDurationMs: r.retention_duration_ms === null || r.retention_duration_ms === undefined
        ? null : Number(r.retention_duration_ms),
      retainUntil: (r.retain_until ?? null) as string | null,
      dispositionAt: (r.disposition_at ?? null) as string | null,
    };
  }

  /**
   * Query jobs where artifact_state=AVAILABLE but the volume is expected to be
   * absent (for integrity anomaly detection). Returns jobs that have an
   * AVAILABLE artifact_state and a recorded artifact_volume — the collector
   * then checks Docker to see which volumes are missing.
   */
  queryAvailableWithVolume(): Array<{ jobId: string; artifactVolume: string; status: string }> {
    const rows = this.db.prepare(`
      SELECT job_id, artifact_volume, status
      FROM agent_jobs
      WHERE artifact_state = 'AVAILABLE'
        AND artifact_volume IS NOT NULL
    `).all() as Array<{ job_id: string; artifact_volume: string; status: string }>;
    return rows.map((r) => ({
      jobId: String(r.job_id),
      artifactVolume: String(r.artifact_volume),
      status: String(r.status),
    }));
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
  recoverApplyAttempts(reason: string): { abortedNoMutation: string[]; uncertain: string[]; uncertainWriterLeaseIds: string[] } {
    const abortedNoMutation: string[] = [];
    const uncertain: string[] = [];
    const uncertainWriterLeaseIds: string[] = [];
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
        if (Number(res.changes) === 1) {
          abortedNoMutation.push(row.attempt_id);
          this.finishApplyWriterLeaseTx(row.attempt_id, 'RELEASED', boundedReason);
        }
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
        this.finishApplyWriterLeaseTx(row.attempt_id, 'UNCERTAIN', boundedReason);
      }

      // Any ACTIVE lease not consumed by the coherent apply-attempt recovery
      // above is fail-closed after process restart. This includes future IDE
      // writers: no automatic release is allowed when mutation outcome is not
      // durably proven. UNCERTAIN remains inside the held-target unique index.
      const orphanWriters=this.db.prepare(`SELECT writer_lease_id FROM live_writer_leases WHERE state='ACTIVE' ORDER BY writer_lease_id`).all() as {writer_lease_id:string}[];
      for(const row of orphanWriters){
        const changed=this.db.prepare(`UPDATE live_writer_leases SET state='UNCERTAIN',finished_at=?,reason=? WHERE writer_lease_id=? AND state='ACTIVE'`).run(now,boundedReason,row.writer_lease_id);
        if(Number(changed.changes)===1) uncertainWriterLeaseIds.push(row.writer_lease_id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { abortedNoMutation, uncertain, uncertainWriterLeaseIds };
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
      const durable = this.db.prepare(`SELECT project_id FROM agent_apply_attempts WHERE attempt_id=? AND job_id=? AND state='APPLYING'`)
        .get(attemptId, jobId) as { project_id: string } | undefined;
      if (!durable) { this.db.exec('ROLLBACK'); return false; }
      if (durable.project_id !== projectId) {
        throw new BridgeError('LIVE_WRITER_BINDING_MISMATCH', `apply attempt ${attemptId} belongs to project ${durable.project_id}, not ${projectId}`, 409);
      }
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

      this.finishApplyWriterLeaseTx(attemptId, 'UNCERTAIN', boundedReason);
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
    retentionClass: (r.retention_class ?? null) as AgentRetentionClass | null,
    retentionDurationMs: r.retention_duration_ms === null || r.retention_duration_ms === undefined
      ? null : Number(r.retention_duration_ms),
    retainUntil: (r.retain_until ?? null) as string | null,
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

function rowToLiveWriterLease(r: Record<string, unknown>): LiveWriterLeaseRow {
  const writerLeaseId=String(r.writer_lease_id), projectId=String(r.project_id), worktreeId=String(r.worktree_id);
  const ownerKind=String(r.owner_kind) as LiveWriterOwnerKind, ownerId=String(r.owner_id), principalId=String(r.principal_id);
  const state=String(r.state) as LiveWriterLeaseState;
  assertLiveWriterLeaseId(writerLeaseId); assertLiveWriterLogicalId(projectId,'projectId'); assertLiveWriterLogicalId(worktreeId,'worktreeId');
  if (!(LIVE_WRITER_OWNER_KINDS as readonly string[]).includes(ownerKind)) throw new BridgeError('INTERNAL','live-writer owner kind is invalid',500);
  assertLiveWriterOwner(ownerKind,ownerId); assertLiveWriterPrincipalId(principalId);
  if (!(LIVE_WRITER_LEASE_STATES as readonly string[]).includes(state)) throw new BridgeError('INTERNAL','live-writer lease state is invalid',500);
  const finishedAt=(r.finished_at??null) as string|null;
  if ((state==='ACTIVE') !== (finishedAt===null)) throw new BridgeError('INTERNAL','live-writer state/timestamp fields are inconsistent',500);
  return {writerLeaseId,projectId,worktreeId,ownerKind,ownerId,principalId,state,acquiredAt:String(r.acquired_at),finishedAt,reason:(r.reason??null) as string|null};
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
    worktreeId: (r.worktree_id ?? null) as string | null,
    writerLeaseId: (r.writer_lease_id ?? null) as string | null,
  };
}
