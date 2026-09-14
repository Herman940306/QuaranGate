/**
 * Agent session continuity store — Phase A8 R1.
 *
 * Durable session rows bind an opaque QuaranGate session identity to one
 * provider session plus the exact principal/project/backend/profile context.
 * Session state is identity/lifecycle only; it is NEVER authorization.
 *
 * R1 lifecycle:
 *   ACTIVE -> RESERVED(job) -> CONSUMED   (successful continuation)
 *                         \-> EXPIRED    (provider may have advanced / crash)
 *   RESERVED(job) -> ACTIVE              (safe release before provider use)
 *
 * Provider-private fields (`provider_session_id`, `provider_state_ref`) are
 * available only through narrow trusted accessors and are never returned by
 * getSession(). `provider_state_ref` is a backend-owned persistent state
 * reference (for Kiro: a managed Docker volume containing only
 * $KIRO_HOME/sessions/cli).
 */
import { DatabaseSync } from 'node:sqlite';
import { BridgeError } from '../../shared/errors.js';

export const SESSION_ID_PREFIX = 'sess_';
export const SESSION_ID_PATTERN = /^sess_[0-9a-f]{32}$/;

export type AgentSessionState = 'ACTIVE' | 'RESERVED' | 'CONSUMED' | 'EXPIRED';

export interface AgentSessionRow {
  sessionId: string;
  principalId: string;
  project: string;
  backend: string;
  profile: string;
  state: AgentSessionState;
  createdAt: string;
  lastUsedAt: string;
  consumedByJobId: string | null;
  reservedByJobId: string | null;
  reservedAt: string | null;
  /** Reserved for a future approved TTL policy; A8 does not auto-expire by wall clock. */
  expiresAt: string | null;
}

export interface NewAgentSession {
  sessionId: string;
  principalId: string;
  project: string;
  backend: string;
  profile: string;
  providerSessionId: string;
  /** Backend-private durable state reference. Never exposed by getSession(). */
  providerStateRef?: string | null;
}

export interface ReservedProviderSessionContext {
  providerSessionId: string;
  providerStateRef: string | null;
}

const REQUIRED_SESSIONS_COLUMNS: Record<string, string> = {
  session_id: 'TEXT',
  principal_id: 'TEXT',
  project: 'TEXT',
  backend: 'TEXT',
  profile: 'TEXT',
  provider_session_id: 'TEXT',
  provider_state_ref: 'TEXT',
  state: 'TEXT',
  created_at: 'TEXT',
  last_used_at: 'TEXT',
  consumed_by_job_id: 'TEXT',
  reserved_by_job_id: 'TEXT',
  reserved_at: 'TEXT',
  expires_at: 'TEXT',
};

export class AgentSessionStore {
  constructor(private readonly db: DatabaseSync) {}

  createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id          TEXT PRIMARY KEY,
        principal_id        TEXT NOT NULL,
        project             TEXT NOT NULL,
        backend             TEXT NOT NULL,
        profile             TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        provider_state_ref  TEXT,
        state               TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at          TEXT NOT NULL,
        last_used_at        TEXT NOT NULL,
        consumed_by_job_id  TEXT,
        reserved_by_job_id  TEXT,
        reserved_at         TEXT,
        expires_at          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_binding
        ON agent_sessions(principal_id, project, backend, profile, state);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_reservation
        ON agent_sessions(reserved_by_job_id, state);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_provider_state
        ON agent_sessions(provider_state_ref, state);
    `);
  }

  assertSchemaShape(): void {
    const tableExists = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'`,
    ).get() !== undefined;
    if (!tableExists) {
      throw new BridgeError('INTERNAL', 'agent sessions DB is stamped schema v6 but table agent_sessions is missing', 500);
    }
    const info = this.db.prepare(`PRAGMA table_info(agent_sessions)`).all() as { name: string; type: string }[];
    const missing: string[] = [];
    for (const [column, affinity] of Object.entries(REQUIRED_SESSIONS_COLUMNS)) {
      const got = info.find((c) => c.name === column);
      if (!got) { missing.push(`agent_sessions.${column}`); continue; }
      if (String(got.type).toUpperCase() !== affinity) {
        missing.push(`agent_sessions.${column} has type ${String(got.type)}, expected ${affinity}`);
      }
    }
    if (missing.length > 0) {
      throw new BridgeError('INTERNAL', `agent_sessions table is missing or has wrong columns: ${missing.join(', ')}`, 500);
    }
  }

  insertSession(session: NewAgentSession): AgentSessionRow {
    if (!SESSION_ID_PATTERN.test(session.sessionId)) {
      throw new BridgeError('MALFORMED_REQUEST', `invalid session ID format: ${session.sessionId}`, 400);
    }
    if (!session.providerSessionId || session.providerSessionId.trim() === '') {
      throw new BridgeError('MALFORMED_REQUEST', `providerSessionId must not be empty for session ${session.sessionId}`, 400);
    }
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO agent_sessions
        (session_id, principal_id, project, backend, profile,
         provider_session_id, provider_state_ref, state, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(
      session.sessionId, session.principalId, session.project, session.backend,
      session.profile, session.providerSessionId, session.providerStateRef ?? null,
      now, now,
    );
    return this.getSession(session.sessionId)!;
  }

  /** Atomic CAS used by AgentJobStore while it owns BEGIN IMMEDIATE. */
  reserveSession(sessionId: string, jobId: string): boolean {
    const now = nowIso();
    const res = this.db.prepare(`
      UPDATE agent_sessions
      SET state = 'RESERVED', reserved_by_job_id = ?, reserved_at = ?, last_used_at = ?
      WHERE session_id = ? AND state = 'ACTIVE'
    `).run(jobId, now, now, sessionId);
    return Number(res.changes) === 1;
  }

  /** Safe release is allowed only for the exact reservation owner. */
  releaseReservation(sessionId: string, jobId: string): boolean {
    const res = this.db.prepare(`
      UPDATE agent_sessions
      SET state = 'ACTIVE', reserved_by_job_id = NULL, reserved_at = NULL, last_used_at = ?
      WHERE session_id = ? AND state = 'RESERVED' AND reserved_by_job_id = ?
    `).run(nowIso(), sessionId, jobId);
    return Number(res.changes) === 1;
  }

  /** Fail-closed invalidation after provider use may have advanced state. */
  expireReservation(sessionId: string, jobId: string): boolean {
    const res = this.db.prepare(`
      UPDATE agent_sessions
      SET state = 'EXPIRED', reserved_by_job_id = NULL, reserved_at = NULL, last_used_at = ?
      WHERE session_id = ? AND state = 'RESERVED' AND reserved_by_job_id = ?
    `).run(nowIso(), sessionId, jobId);
    return Number(res.changes) === 1;
  }

  /** Success transition; intended to be invoked inside JobStore finalization txn. */
  consumeReservedSession(sessionId: string, jobId: string): boolean {
    const res = this.db.prepare(`
      UPDATE agent_sessions
      SET state = 'CONSUMED', consumed_by_job_id = ?, reserved_by_job_id = NULL,
          reserved_at = NULL, last_used_at = ?
      WHERE session_id = ? AND state = 'RESERVED' AND reserved_by_job_id = ?
    `).run(jobId, nowIso(), sessionId, jobId);
    return Number(res.changes) === 1;
  }

  /** Legacy/admin helper retained for existing direct store tests. */
  consumeSession(sessionId: string, consumedByJobId: string): boolean {
    const res = this.db.prepare(`
      UPDATE agent_sessions
      SET state = 'CONSUMED', consumed_by_job_id = ?, last_used_at = ?
      WHERE session_id = ? AND state = 'ACTIVE'
    `).run(consumedByJobId, nowIso(), sessionId);
    return Number(res.changes) === 1;
  }

  expireSession(sessionId: string): boolean {
    const res = this.db.prepare(`
      UPDATE agent_sessions
      SET state = 'EXPIRED', reserved_by_job_id = NULL, reserved_at = NULL, last_used_at = ?
      WHERE session_id = ? AND state IN ('ACTIVE','RESERVED')
    `).run(nowIso(), sessionId);
    return Number(res.changes) === 1;
  }

  touchSession(sessionId: string): boolean {
    const res = this.db.prepare(`
      UPDATE agent_sessions SET last_used_at = ? WHERE session_id = ? AND state = 'ACTIVE'
    `).run(nowIso(), sessionId);
    return Number(res.changes) === 1;
  }

  getSession(sessionId: string): AgentSessionRow | undefined {
    const r = this.db.prepare(`
      SELECT session_id, principal_id, project, backend, profile, state,
             created_at, last_used_at, consumed_by_job_id, reserved_by_job_id,
             reserved_at, expires_at
      FROM agent_sessions WHERE session_id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;
    return r ? rowToSession(r) : undefined;
  }

  /** ACTIVE-only narrow read retained for diagnostics/tests. */
  getProviderSessionId(sessionId: string): string | null {
    const r = this.db.prepare(`
      SELECT provider_session_id FROM agent_sessions
      WHERE session_id = ? AND state = 'ACTIVE'
    `).get(sessionId) as { provider_session_id: string } | undefined;
    return r?.provider_session_id ?? null;
  }

  /**
   * Execution authority: provider identity/state can be obtained only by the
   * exact job that durably RESERVED this session at dispatch.
   */
  getReservedProviderContext(sessionId: string, jobId: string): ReservedProviderSessionContext | null {
    const r = this.db.prepare(`
      SELECT provider_session_id, provider_state_ref FROM agent_sessions
      WHERE session_id = ? AND state = 'RESERVED' AND reserved_by_job_id = ?
    `).get(sessionId, jobId) as { provider_session_id: string; provider_state_ref: string | null } | undefined;
    return r ? {
      providerSessionId: r.provider_session_id,
      providerStateRef: r.provider_state_ref ?? null,
    } : null;
  }

  findActiveSession(principalId: string, project: string, backend: string, profile: string): AgentSessionRow | undefined {
    const r = this.db.prepare(`
      SELECT session_id, principal_id, project, backend, profile, state,
             created_at, last_used_at, consumed_by_job_id, reserved_by_job_id,
             reserved_at, expires_at
      FROM agent_sessions
      WHERE principal_id = ? AND project = ? AND backend = ? AND profile = ?
        AND state = 'ACTIVE'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(principalId, project, backend, profile) as Record<string, unknown> | undefined;
    return r ? rowToSession(r) : undefined;
  }

  countActiveSessions(principalId: string, project: string, backend: string, profile: string): number {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS n FROM agent_sessions
      WHERE principal_id = ? AND project = ? AND backend = ? AND profile = ?
        AND state = 'ACTIVE'
    `).get(principalId, project, backend, profile) as { n: number };
    return Number(r.n);
  }

  /**
   * Startup reconciliation after AgentJobStore.recoverActive():
   * - reservation owned by a still-QUEUED job is valid and kept;
   * - every other leaked reservation is EXPIRED, never reactivated, because
   *   provider use may have occurred before the crash.
   */
  recoverReservations(): { kept: string[]; expired: string[] } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`
        SELECT s.session_id, s.reserved_by_job_id, j.status AS job_status
        FROM agent_sessions s
        LEFT JOIN agent_jobs j ON j.job_id = s.reserved_by_job_id
        WHERE s.state = 'RESERVED'
      `).all() as { session_id: string; reserved_by_job_id: string | null; job_status: string | null }[];
      const kept: string[] = [];
      const expired: string[] = [];
      for (const row of rows) {
        if (row.reserved_by_job_id && row.job_status === 'QUEUED') {
          kept.push(row.session_id);
          continue;
        }
        const res = this.db.prepare(`
          UPDATE agent_sessions
          SET state = 'EXPIRED', reserved_by_job_id = NULL, reserved_at = NULL, last_used_at = ?
          WHERE session_id = ? AND state = 'RESERVED'
        `).run(nowIso(), row.session_id);
        if (Number(res.changes) === 1) expired.push(row.session_id);
      }
      this.db.exec('COMMIT');
      return { kept, expired };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Exact backend-state refs that must survive generic orphan sweeping. */
  listProtectedProviderStateRefs(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT provider_state_ref AS ref
      FROM agent_sessions
      WHERE provider_state_ref IS NOT NULL
        AND state IN ('ACTIVE','RESERVED')
      ORDER BY ref
    `).all() as { ref: string }[];
    return rows.map((r) => r.ref);
  }

  /**
   * Backend state references become cleanup-eligible only when NO ACTIVE or
   * RESERVED session still references them. This prevents cleanup of shared
   * provider state while a successor session remains usable.
   */
  listCleanupEligibleProviderStateRefs(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT s.provider_state_ref AS ref
      FROM agent_sessions s
      WHERE s.provider_state_ref IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_sessions live
          WHERE live.provider_state_ref = s.provider_state_ref
            AND live.state IN ('ACTIVE','RESERVED')
        )
      ORDER BY ref
    `).all() as { ref: string }[];
    return rows.map((r) => r.ref);
  }
}

function nowIso(): string { return new Date().toISOString(); }

function rowToSession(r: Record<string, unknown>): AgentSessionRow {
  return {
    sessionId: String(r.session_id),
    principalId: String(r.principal_id),
    project: String(r.project),
    backend: String(r.backend),
    profile: String(r.profile),
    state: String(r.state) as AgentSessionState,
    createdAt: String(r.created_at),
    lastUsedAt: String(r.last_used_at),
    consumedByJobId: (r.consumed_by_job_id ?? null) as string | null,
    reservedByJobId: (r.reserved_by_job_id ?? null) as string | null,
    reservedAt: (r.reserved_at ?? null) as string | null,
    expiresAt: (r.expires_at ?? null) as string | null,
  };
}
