/**
 * Durable IDE Session Control enrollment/registry store (P7 B2).
 *
 * Plane B is deliberately separate from the Agent Control Plane database.
 * This store contains no prompt/response bodies, credentials, provider state,
 * host paths, model selections, or writer authority. It persists only trusted
 * logical enrollment identity, connection generations, lifecycle state, and
 * opaque controller-lease identity.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  IDE_CAPABILITIES,
  IDE_CONTROLLER_LEASE_ID_PATTERN,
  IDE_REVIEW_BASE_CAPABILITIES,
  IDE_SESSION_STATES,
  IdeSessionContractError,
  assertIdeCapability,
  assertIdeConnectionGeneration,
  assertIdeControllerLeaseId,
  assertIdeEnrollmentId,
  assertIdeInstanceId,
  assertIdeOperationId,
  assertIdeLogicalId,
  assertIdePrincipalId,
  assertIdeProduct,
  assertIdeSessionAuthority,
  assertIdeSessionId,
  assertIdeSessionTransition,
  assertIdeWorkspaceFingerprint,
  type IdeCapability,
  type IdeProductId,
  type IdeSessionAuthorityRequest,
  type IdeSessionBinding,
  type IdeSessionState,
} from '../../shared/ideSessions.js';
import { IDE_COMPANION_MAX_CLOCK_SKEW_MS, IDE_COMPANION_MAX_LIFETIME_MS } from '../../shared/ideCompanionAuth.js';

export const IDE_REGISTRY_SCHEMA_VERSION = 2;
export const IDE_MAX_ACTIVE_AUTH_REPLAYS = 4096;

const B2_ENROLLMENT_CAPABILITIES = new Set<IdeCapability>([
  ...IDE_REVIEW_BASE_CAPABILITIES,
  'read_bounded_editor_context',
]);

const LIVE_SESSION_STATES: readonly IdeSessionState[] = [
  'CONNECTED', 'AVAILABLE', 'CONTROLLER_ACQUIRED', 'OPERATION_ACTIVE',
] as const;
const LIVE_SESSION_SQL = LIVE_SESSION_STATES.map((s) => `'${s}'`).join(',');

const REQUIRED_TABLES = ['ide_enrollments', 'ide_sessions', 'ide_auth_replays'] as const;
const REQUIRED_INDEXES = {
  idx_ide_enrollments_one_active_binding: {
    table: 'ide_enrollments',
    columns: ['principal_id', 'project_id', 'worktree_id', 'ide_product', 'ide_instance_id'],
    sql: `CREATE UNIQUE INDEX idx_ide_enrollments_one_active_binding
          ON ide_enrollments(principal_id, project_id, worktree_id, ide_product, ide_instance_id)
          WHERE state='ACTIVE'`,
  },
  idx_ide_sessions_one_live_enrollment: {
    table: 'ide_sessions',
    columns: ['enrollment_id'],
    sql: `CREATE UNIQUE INDEX idx_ide_sessions_one_live_enrollment
          ON ide_sessions(enrollment_id) WHERE state IN (${LIVE_SESSION_SQL})`,
  },
  idx_ide_sessions_controller_lease: {
    table: 'ide_sessions',
    columns: ['controller_lease_id'],
    sql: `CREATE UNIQUE INDEX idx_ide_sessions_controller_lease
          ON ide_sessions(controller_lease_id) WHERE controller_lease_id IS NOT NULL`,
  },
} as const;
const REQUIRED_COLUMNS: Record<string, Record<string, string>> = {
  ide_enrollments: {
    enrollment_id: 'TEXT', principal_id: 'TEXT', project_id: 'TEXT', worktree_id: 'TEXT',
    ide_product: 'TEXT', ide_instance_id: 'TEXT', workspace_fingerprint: 'TEXT',
    base_revision: 'TEXT', capabilities_json: 'TEXT', state: 'TEXT',
    current_generation: 'INTEGER', created_at: 'TEXT', updated_at: 'TEXT', revoked_at: 'TEXT',
  },
  ide_sessions: {
    session_id: 'TEXT', enrollment_id: 'TEXT', connection_generation: 'INTEGER',
    state: 'TEXT', controller_lease_id: 'TEXT', created_at: 'TEXT', updated_at: 'TEXT', ended_at: 'TEXT',
  },
  ide_auth_replays: {
    nonce_hash: 'TEXT', enrollment_id: 'TEXT', session_id: 'TEXT', connection_generation: 'INTEGER',
    controller_lease_id: 'TEXT', operation_id: 'TEXT', capability: 'TEXT', expires_at_ms: 'INTEGER', claimed_at: 'TEXT',
  },
};

const REQUIRED_PRIMARY_KEYS: Record<string, readonly string[]> = {
  ide_enrollments: ['enrollment_id'],
  ide_sessions: ['session_id'],
  ide_auth_replays: ['nonce_hash'],
};

export type IdeEnrollmentState = 'ACTIVE' | 'REVOKED';
export type IdeRegistryErrorCode =
  | 'IDE_REGISTRY_SCHEMA'
  | 'IDE_REGISTRY_POLICY_DENIED'
  | 'IDE_ENROLLMENT_NOT_FOUND'
  | 'IDE_ENROLLMENT_NOT_ACTIVE'
  | 'IDE_ENROLLMENT_BINDING_MISMATCH'
  | 'IDE_SESSION_NOT_FOUND'
  | 'IDE_SESSION_ID_REUSED'
  | 'IDE_SESSION_BINDING_MISMATCH'
  | 'IDE_SESSION_STATE_MISMATCH'
  | 'IDE_CONTROLLER_LEASE_MISMATCH'
  | 'IDE_AUTH_REPLAY'
  | 'IDE_AUTH_REPLAY_CAPACITY';

export class IdeRegistryStoreError extends Error {
  constructor(public readonly code: IdeRegistryErrorCode, message: string) {
    super(message);
    this.name = 'IdeRegistryStoreError';
  }
}

export interface NewIdeEnrollment {
  principalId: string;
  projectId: string;
  worktreeId: string;
  ideProduct: IdeProductId;
  ideInstanceId: string;
  workspaceFingerprint: string;
  baseRevision?: string;
  capabilities: readonly IdeCapability[];
}

export interface IdeEnrollmentRow extends NewIdeEnrollment {
  enrollmentId: string;
  state: IdeEnrollmentState;
  currentGeneration: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface IdeEnrollmentKey {
  enrollmentId: string;
  principalId: string;
  projectId: string;
  worktreeId: string;
  ideProduct: IdeProductId;
  ideInstanceId: string;
  workspaceFingerprint: string;
  baseRevision?: string;
}

export interface OpenIdeSession extends IdeEnrollmentKey { sessionId: string; }

export interface IdeSessionRegistryKey extends Omit<IdeEnrollmentKey, 'enrollmentId'> {
  sessionId: string;
  connectionGeneration: number;
}

export interface IdeSessionRegistryRow {
  sessionId: string;
  enrollmentId: string;
  connectionGeneration: number;
  state: IdeSessionState;
  controllerLeaseId: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface IdeCompanionRegistryRequest {
  enrollmentId: string;
  ideInstanceId: string;
  sessionId: string;
  connectionGeneration: number;
  controllerLeaseId: string;
  operationId: string;
  capability: IdeCapability;
}

export interface IdeAuthReplayClaim extends IdeCompanionRegistryRequest {
  nonceHash: string;
  expiresAtMs: number;
  nowMs: number;
}

function nowIso(): string { return new Date().toISOString(); }
function opaqueId(prefix: 'iden_' | 'idectl_'): string { return `${prefix}${randomBytes(16).toString('hex')}`; }

function restrictSqliteFileModes(path: string): void {
  if (path === ':memory:' || path === '') return;
  for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) chmodSync(p, 0o600);
}

function assertBaseRevision(value: string | undefined): void {
  if (value !== undefined && !/^[0-9a-f]{40}$/.test(value)) {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'baseRevision is invalid');
  }
}

function canonicalCapabilities(capabilities: readonly IdeCapability[]): IdeCapability[] {
  const seen = new Set<IdeCapability>();
  for (const capability of capabilities) {
    assertIdeCapability(capability);
    if (!B2_ENROLLMENT_CAPABILITIES.has(capability)) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', `capability ${capability} is outside P7 B2 read-only policy`);
    }
    if (seen.has(capability)) throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'duplicate IDE capability');
    seen.add(capability);
  }
  if (seen.size === 0) throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'IDE enrollment must grant at least one capability');
  return IDE_CAPABILITIES.filter((capability) => seen.has(capability));
}

interface IdeEnrollmentIdentityLike {
  enrollmentId?: string;
  principalId: string;
  projectId: string;
  worktreeId: string;
  ideProduct: IdeProductId;
  ideInstanceId: string;
  workspaceFingerprint: string;
  baseRevision?: string;
}

function validateEnrollmentIdentity(value: IdeEnrollmentIdentityLike): void {
  assertIdePrincipalId(value.principalId);
  assertIdeLogicalId(value.projectId, 'projectId');
  assertIdeLogicalId(value.worktreeId, 'worktreeId');
  assertIdeProduct(value.ideProduct);
  assertIdeInstanceId(value.ideInstanceId);
  assertIdeWorkspaceFingerprint(value.workspaceFingerprint);
  assertBaseRevision(value.baseRevision);
  if (value.enrollmentId !== undefined) assertIdeEnrollmentId(value.enrollmentId);
}

function validateSessionKey(key: IdeSessionRegistryKey): void {
  validateEnrollmentIdentity(key);
  assertIdeSessionId(key.sessionId);
  assertIdeConnectionGeneration(key.connectionGeneration);
}

function exactEnrollmentMismatch(row: IdeEnrollmentRow, key: Omit<IdeEnrollmentKey, 'enrollmentId'>): string | null {
  const fields: Array<[string, unknown, unknown]> = [
    ['principalId', key.principalId, row.principalId], ['projectId', key.projectId, row.projectId],
    ['worktreeId', key.worktreeId, row.worktreeId], ['ideProduct', key.ideProduct, row.ideProduct],
    ['ideInstanceId', key.ideInstanceId, row.ideInstanceId],
    ['workspaceFingerprint', key.workspaceFingerprint, row.workspaceFingerprint],
    ['baseRevision', key.baseRevision, row.baseRevision],
  ];
  return fields.find(([, requested, current]) => requested !== current)?.[0] ?? null;
}

export class IdeSessionStore {
  private readonly db: DatabaseSync;

  constructor(private readonly path: string) {
    const prevUmask = process.umask(0o077);
    try {
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA busy_timeout=5000');
      this.db.exec('PRAGMA foreign_keys=ON');
    } finally { process.umask(prevUmask); }
    restrictSqliteFileModes(path);
    this.initializeSchema();
  }

  get schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  }
  close(): void { this.db.close(); }

  private initializeSchema(): void {
    const version = this.schemaVersion;
    if (version > IDE_REGISTRY_SCHEMA_VERSION) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA', `IDE registry schema v${version} is newer than supported v${IDE_REGISTRY_SCHEMA_VERSION}`);
    }
    if (version === IDE_REGISTRY_SCHEMA_VERSION) { this.assertSchemaShape(); return; }

    if (version === 1) {
      // B3 v2 is additive. A v1 DB must prove the exact accepted B2 shape
      // before any replay table/version mutation is attempted. A partially
      // present v2 replay table/index under a v1 stamp is ambiguous and is
      // refused rather than repaired.
      this.assertSchemaShape({ includeReplay: false, stampedVersion: 1 });
      const replayTable = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ide_auth_replays'`).get();
      const replayIndex = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ide_auth_replays_expiry'`).get();
      if (replayTable !== undefined || replayIndex !== undefined) {
        throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA', 'IDE registry v1 contains partial v2 replay state; refusing automatic repair');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.createReplaySchema();
        this.db.exec(`PRAGMA user_version=${IDE_REGISTRY_SCHEMA_VERSION}`);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.assertSchemaShape();
      restrictSqliteFileModes(this.path);
      return;
    }

    if (version !== 0) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA', `unsupported IDE registry schema v${version}`);

    const existing = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
    if (existing.length > 0) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA', `unstamped IDE registry contains unexpected table(s): ${existing.map((r) => r.name).join(', ')}`);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE ide_enrollments (
          enrollment_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
          worktree_id TEXT NOT NULL, ide_product TEXT NOT NULL, ide_instance_id TEXT NOT NULL,
          workspace_fingerprint TEXT NOT NULL, base_revision TEXT, capabilities_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
          current_generation INTEGER NOT NULL DEFAULT 0 CHECK(current_generation >= 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT
        );
        CREATE TABLE ide_sessions (
          session_id TEXT PRIMARY KEY,
          enrollment_id TEXT NOT NULL REFERENCES ide_enrollments(enrollment_id),
          connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
          state TEXT NOT NULL, controller_lease_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
          UNIQUE(enrollment_id, connection_generation)
        );
        CREATE UNIQUE INDEX idx_ide_enrollments_one_active_binding
          ON ide_enrollments(principal_id, project_id, worktree_id, ide_product, ide_instance_id)
          WHERE state='ACTIVE';
        CREATE UNIQUE INDEX idx_ide_sessions_one_live_enrollment
          ON ide_sessions(enrollment_id) WHERE state IN (${LIVE_SESSION_SQL});
        CREATE UNIQUE INDEX idx_ide_sessions_controller_lease
          ON ide_sessions(controller_lease_id) WHERE controller_lease_id IS NOT NULL;
      `);
      this.createReplaySchema();
      this.db.exec(`PRAGMA user_version=${IDE_REGISTRY_SCHEMA_VERSION}`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.assertSchemaShape();
    restrictSqliteFileModes(this.path);
  }

  private createReplaySchema(): void {
    this.db.exec(`
      CREATE TABLE ide_auth_replays (
        nonce_hash TEXT NOT NULL PRIMARY KEY,
        enrollment_id TEXT NOT NULL REFERENCES ide_enrollments(enrollment_id),
        session_id TEXT NOT NULL REFERENCES ide_sessions(session_id),
        connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
        controller_lease_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        claimed_at TEXT NOT NULL
      );
      CREATE INDEX idx_ide_auth_replays_expiry
        ON ide_auth_replays(enrollment_id, connection_generation, expires_at_ms);
    `);
  }

  private assertSchemaShape(options: { includeReplay?: boolean; stampedVersion?: number } = {}): void {
    const includeReplay = options.includeReplay ?? true;
    const stampedVersion = options.stampedVersion ?? IDE_REGISTRY_SCHEMA_VERSION;
    const missing: string[] = [];
    const tableExists = (name: string): boolean => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
    const indexExists = (name: string): boolean => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name) !== undefined;
    for (const table of REQUIRED_TABLES) {
      if (!includeReplay && table === 'ide_auth_replays') continue;
      if (!tableExists(table)) missing.push(`table ${table}`);
    }
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      if (!includeReplay && table === 'ide_auth_replays') continue;
      if (!tableExists(table)) continue;
      const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number }[];
      for (const [column, affinity] of Object.entries(columns)) {
        const got = info.find((c) => c.name === column);
        if (!got) missing.push(`${table}.${column}`);
        else if (String(got.type).toUpperCase() !== affinity) missing.push(`${table}.${column} has type ${String(got.type)}, expected ${affinity}`);
      }
      const expectedPk = REQUIRED_PRIMARY_KEYS[table];
      if (expectedPk) {
        const gotPk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        if (JSON.stringify(gotPk) !== JSON.stringify(expectedPk)) missing.push(`${table} primary key is incompatible`);
      }
    }
    const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();
    for (const [index, expected] of Object.entries(REQUIRED_INDEXES)) {
      if (!indexExists(index)) { missing.push(`index ${index}`); continue; }
      const indexList = this.db.prepare(`PRAGMA index_list(${expected.table})`).all() as Array<{ name: string; unique: number; partial: number }>;
      const listed = indexList.find((row) => row.name === index);
      if (!listed || listed.unique !== 1 || listed.partial !== 1) {
        missing.push(`index ${index} must be UNIQUE and partial`);
        continue;
      }
      const columns = (this.db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ seqno: number; name: string }>)
        .sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
      if (JSON.stringify(columns) !== JSON.stringify(expected.columns)) {
        missing.push(`index ${index} columns are incompatible`);
        continue;
      }
      const stored = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`).get(index) as { sql: string | null } | undefined;
      if (!stored?.sql || normalizeSql(stored.sql) !== normalizeSql(expected.sql)) missing.push(`index ${index} definition is incompatible`);
    }
    if (includeReplay) {
      if (!indexExists('idx_ide_auth_replays_expiry')) missing.push('index idx_ide_auth_replays_expiry');
      else {
        const columns = (this.db.prepare(`PRAGMA index_info(idx_ide_auth_replays_expiry)`).all() as Array<{ seqno: number; name: string }>)
          .sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
        if (JSON.stringify(columns) !== JSON.stringify(['enrollment_id', 'connection_generation', 'expires_at_ms'])) {
          missing.push('index idx_ide_auth_replays_expiry columns are incompatible');
        }
      }
    }
    if (missing.length > 0) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA', `IDE registry is stamped schema v${stampedVersion} but incomplete/incompatible: ${missing.join(', ')}`);
    }
  }

  createEnrollment(input: NewIdeEnrollment): IdeEnrollmentRow {
    validateEnrollmentIdentity(input);
    const capabilities = canonicalCapabilities(input.capabilities);
    const enrollmentId = opaqueId('iden_');
    const now = nowIso();
    this.db.prepare(`INSERT INTO ide_enrollments
      (enrollment_id,principal_id,project_id,worktree_id,ide_product,ide_instance_id,workspace_fingerprint,base_revision,capabilities_json,state,current_generation,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',0,?,?)`).run(
      enrollmentId,input.principalId,input.projectId,input.worktreeId,input.ideProduct,input.ideInstanceId,
      input.workspaceFingerprint,input.baseRevision??null,JSON.stringify(capabilities),now,now,
    );
    return this.getEnrollment(enrollmentId)!;
  }

  getEnrollment(enrollmentId: string): IdeEnrollmentRow | undefined {
    assertIdeEnrollmentId(enrollmentId);
    const row = this.db.prepare(`SELECT * FROM ide_enrollments WHERE enrollment_id=?`).get(enrollmentId) as Record<string, unknown>|undefined;
    return row ? this.rowToEnrollment(row) : undefined;
  }

  getSession(sessionId: string): IdeSessionRegistryRow | undefined {
    assertIdeSessionId(sessionId);
    const row = this.db.prepare(`SELECT * FROM ide_sessions WHERE session_id=?`).get(sessionId) as Record<string, unknown>|undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  revokeEnrollment(key: IdeEnrollmentKey): boolean {
    validateEnrollmentIdentity(key);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const enrollment=this.requireEnrollment(key.enrollmentId); this.assertEnrollmentKey(enrollment,key);
      if (enrollment.state!=='ACTIVE') { this.db.exec('ROLLBACK'); return false; }
      const now=nowIso();
      const changed=this.db.prepare(`UPDATE ide_enrollments SET state='REVOKED',revoked_at=?,updated_at=? WHERE enrollment_id=? AND state='ACTIVE'`).run(now,now,key.enrollmentId);
      if (Number(changed.changes)!==1) { this.db.exec('ROLLBACK'); return false; }
      this.db.prepare(`UPDATE ide_sessions SET state='STALE',controller_lease_id=NULL,ended_at=?,updated_at=? WHERE enrollment_id=? AND state IN (${LIVE_SESSION_SQL})`).run(now,now,key.enrollmentId);
      this.db.exec('COMMIT'); return true;
    } catch(error) { try{this.db.exec('ROLLBACK');}catch{} throw error; }
  }

  openSession(input: OpenIdeSession): IdeSessionRegistryRow {
    return this.openSessionInternal(input);
  }

  /**
   * B6 pre-controller handshake CAS: an unauthenticated hello may observe the
   * current generation but must not mutate it. Only after MAC verification may
   * the listener open a session, and only if the enrollment generation is still
   * exactly the one challenged. A stale concurrent handshake therefore cannot
   * stale a newer authenticated connection.
   */
  openSessionIfCurrent(input: OpenIdeSession, expectedCurrentGeneration: number): IdeSessionRegistryRow {
    if (!Number.isSafeInteger(expectedCurrentGeneration) || expectedCurrentGeneration < 0) {
      throw new IdeRegistryStoreError('IDE_SESSION_BINDING_MISMATCH', 'expected IDE enrollment generation is invalid');
    }
    return this.openSessionInternal(input, expectedCurrentGeneration);
  }

  private openSessionInternal(input: OpenIdeSession, expectedCurrentGeneration?: number): IdeSessionRegistryRow {
    validateEnrollmentIdentity(input); assertIdeSessionId(input.sessionId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare(`SELECT 1 FROM ide_sessions WHERE session_id=?`).get(input.sessionId)!==undefined) throw new IdeRegistryStoreError('IDE_SESSION_ID_REUSED','IDE session ID has already been used');
      const enrollment=this.requireEnrollment(input.enrollmentId); this.assertEnrollmentKey(enrollment,input);
      if (enrollment.state!=='ACTIVE') throw new IdeRegistryStoreError('IDE_ENROLLMENT_NOT_ACTIVE','IDE enrollment is not active');
      if (expectedCurrentGeneration!==undefined && enrollment.currentGeneration!==expectedCurrentGeneration) {
        throw new IdeRegistryStoreError('IDE_SESSION_BINDING_MISMATCH','IDE enrollment generation changed after handshake challenge');
      }
      const next=enrollment.currentGeneration+1;
      if (!Number.isSafeInteger(next)||next<1) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE connection generation exhausted safe integer range');
      const now=nowIso();
      this.db.prepare(`UPDATE ide_sessions SET state='STALE',controller_lease_id=NULL,ended_at=?,updated_at=? WHERE enrollment_id=? AND state IN (${LIVE_SESSION_SQL})`).run(now,now,input.enrollmentId);
      const updated=this.db.prepare(`UPDATE ide_enrollments SET current_generation=?,updated_at=? WHERE enrollment_id=? AND state='ACTIVE' AND current_generation=?`).run(next,now,input.enrollmentId,enrollment.currentGeneration);
      if(Number(updated.changes)!==1) throw new IdeRegistryStoreError('IDE_ENROLLMENT_NOT_ACTIVE','IDE enrollment changed while opening session');
      this.db.prepare(`INSERT INTO ide_sessions(session_id,enrollment_id,connection_generation,state,created_at,updated_at) VALUES (?,?,?,'CONNECTED',?,?)`).run(input.sessionId,input.enrollmentId,next,now,now);
      this.db.exec('COMMIT'); return this.getSession(input.sessionId)!;
    } catch(error) { try{this.db.exec('ROLLBACK');}catch{} throw error; }
  }

  markAvailable(key: IdeSessionRegistryKey): boolean { return this.transitionExact(key,'CONNECTED','AVAILABLE',null); }

  acquireController(key: IdeSessionRegistryKey): string {
    validateSessionKey(key); const leaseId=opaqueId('idectl_'); this.db.exec('BEGIN IMMEDIATE');
    try {
      const {session}=this.requireExactSession(key);
      if(session.state!=='AVAILABLE'||session.controllerLeaseId!==null) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE session is not available for controller acquisition');
      const res=this.db.prepare(`UPDATE ide_sessions SET state='CONTROLLER_ACQUIRED',controller_lease_id=?,updated_at=? WHERE session_id=? AND connection_generation=? AND state='AVAILABLE' AND controller_lease_id IS NULL`).run(leaseId,nowIso(),key.sessionId,key.connectionGeneration);
      if(Number(res.changes)!==1) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE controller acquisition lost CAS race');
      this.db.exec('COMMIT'); return leaseId;
    } catch(error) { try{this.db.exec('ROLLBACK');}catch{} throw error; }
  }

  releaseController(key: IdeSessionRegistryKey,leaseId:string): boolean { assertIdeControllerLeaseId(leaseId); return this.transitionExact(key,'CONTROLLER_ACQUIRED','AVAILABLE',leaseId,true); }
  markOperationActive(key: IdeSessionRegistryKey,leaseId:string): boolean { assertIdeControllerLeaseId(leaseId); return this.transitionExact(key,'CONTROLLER_ACQUIRED','OPERATION_ACTIVE',leaseId); }
  markOperationSettled(key: IdeSessionRegistryKey,leaseId:string): boolean { assertIdeControllerLeaseId(leaseId); return this.transitionExact(key,'OPERATION_ACTIVE','CONTROLLER_ACQUIRED',leaseId); }

  disconnect(key: IdeSessionRegistryKey): boolean {
    validateSessionKey(key); this.db.exec('BEGIN IMMEDIATE');
    try {
      const {session}=this.requireExactSession(key); assertIdeSessionTransition(session.state,'DISCONNECTED'); const now=nowIso();
      const res=this.db.prepare(`UPDATE ide_sessions SET state='DISCONNECTED',controller_lease_id=NULL,ended_at=?,updated_at=? WHERE session_id=? AND connection_generation=? AND state=?`).run(now,now,key.sessionId,key.connectionGeneration,session.state);
      if(Number(res.changes)!==1) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE disconnect lost CAS race');
      this.db.exec('COMMIT'); return true;
    } catch(error) { try{this.db.exec('ROLLBACK');}catch{} throw error; }
  }

  recoverAfterRestart(): {staledSessionIds:string[]} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=this.db.prepare(`SELECT session_id FROM ide_sessions WHERE state IN (${LIVE_SESSION_SQL}) ORDER BY session_id`).all() as {session_id:string}[];
      if(rows.length>0){const now=nowIso();this.db.prepare(`UPDATE ide_sessions SET state='STALE',controller_lease_id=NULL,ended_at=?,updated_at=? WHERE state IN (${LIVE_SESSION_SQL})`).run(now,now);}
      this.db.exec('COMMIT'); return {staledSessionIds:rows.map(r=>r.session_id)};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  assertAuthority(request:IdeSessionAuthorityRequest,leaseId:string):void {
    assertIdeControllerLeaseId(leaseId);
    const key:IdeSessionRegistryKey={principalId:request.principalId,projectId:request.projectId,worktreeId:request.worktreeId,workspaceFingerprint:request.workspaceFingerprint,baseRevision:request.baseRevision,ideProduct:request.ideProduct,ideInstanceId:request.ideInstanceId,sessionId:request.sessionId,connectionGeneration:request.connectionGeneration};
    const {session,enrollment}=this.requireExactSession(key);
    if(enrollment.state!=='ACTIVE') throw new IdeRegistryStoreError('IDE_ENROLLMENT_NOT_ACTIVE','IDE enrollment is not active');
    if(session.controllerLeaseId!==leaseId) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','IDE controller lease does not match current session');
    const binding:IdeSessionBinding={principalId:enrollment.principalId,projectId:enrollment.projectId,worktreeId:enrollment.worktreeId,workspaceFingerprint:enrollment.workspaceFingerprint,baseRevision:enrollment.baseRevision,ideProduct:enrollment.ideProduct,ideInstanceId:enrollment.ideInstanceId,sessionId:session.sessionId,connectionGeneration:session.connectionGeneration,capabilities:enrollment.capabilities,sessionState:session.state,controllerLease:'acquired',writerLease:'none'};
    assertIdeSessionAuthority(binding,request);
  }


  /**
   * Companion-facing authority derivation. The machine frame supplies only
   * opaque enrolled/session identities; project/worktree/workspace authority
   * is re-derived from the durable trusted enrollment, never restated by the
   * caller. B3 still supplies writerLease=none through the B1 contract.
   */
  assertCompanionAuthority(request: IdeCompanionRegistryRequest): void {
    const { session, enrollment } = this.requireCompanionContext(request);
    const authority: IdeSessionAuthorityRequest = {
      principalId: enrollment.principalId,
      projectId: enrollment.projectId,
      worktreeId: enrollment.worktreeId,
      workspaceFingerprint: enrollment.workspaceFingerprint,
      baseRevision: enrollment.baseRevision,
      ideProduct: enrollment.ideProduct,
      ideInstanceId: enrollment.ideInstanceId,
      sessionId: session.sessionId,
      connectionGeneration: session.connectionGeneration,
      capability: request.capability,
    };
    const binding: IdeSessionBinding = {
      principalId: enrollment.principalId,
      projectId: enrollment.projectId,
      worktreeId: enrollment.worktreeId,
      workspaceFingerprint: enrollment.workspaceFingerprint,
      baseRevision: enrollment.baseRevision,
      ideProduct: enrollment.ideProduct,
      ideInstanceId: enrollment.ideInstanceId,
      sessionId: session.sessionId,
      connectionGeneration: session.connectionGeneration,
      capabilities: enrollment.capabilities,
      sessionState: session.state,
      controllerLease: 'acquired',
      writerLease: 'none',
    };
    assertIdeSessionAuthority(binding, authority);
  }

  /**
   * Atomically claim one already-authenticated B3 nonce digest. Raw nonce,
   * secret, MAC and payload bytes are never persisted. Replay state survives
   * executor/store restart for the complete authenticated validity window.
   */
  claimAuthReplay(claim: IdeAuthReplayClaim): void {
    this.validateReplayClaim(claim);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireCompanionContext(claim);
      this.db.prepare(`DELETE FROM ide_auth_replays WHERE expires_at_ms <= ?`).run(claim.nowMs);
      const existing = this.db.prepare(`SELECT 1 FROM ide_auth_replays WHERE nonce_hash=?`).get(claim.nonceHash);
      if (existing !== undefined) throw new IdeRegistryStoreError('IDE_AUTH_REPLAY', 'companion request nonce was already used');
      const count = this.db.prepare(`SELECT COUNT(*) AS n FROM ide_auth_replays WHERE enrollment_id=? AND connection_generation=? AND expires_at_ms>?`)
        .get(claim.enrollmentId, claim.connectionGeneration, claim.nowMs) as { n: number };
      if (Number(count.n) >= IDE_MAX_ACTIVE_AUTH_REPLAYS) {
        throw new IdeRegistryStoreError('IDE_AUTH_REPLAY_CAPACITY', 'companion replay capacity reached');
      }
      this.db.prepare(`INSERT INTO ide_auth_replays
        (nonce_hash,enrollment_id,session_id,connection_generation,controller_lease_id,operation_id,capability,expires_at_ms,claimed_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        claim.nonceHash, claim.enrollmentId, claim.sessionId, claim.connectionGeneration,
        claim.controllerLeaseId, claim.operationId, claim.capability, claim.expiresAtMs, nowIso(),
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      if (!(error instanceof IdeRegistryStoreError)) {
        const found = this.db.prepare(`SELECT 1 FROM ide_auth_replays WHERE nonce_hash=?`).get(claim.nonceHash);
        if (found !== undefined) throw new IdeRegistryStoreError('IDE_AUTH_REPLAY', 'companion request nonce was already used');
      }
      throw error;
    }
  }

  private validateReplayClaim(claim: IdeAuthReplayClaim): void {
    assertIdeEnrollmentId(claim.enrollmentId);
    assertIdeInstanceId(claim.ideInstanceId);
    assertIdeSessionId(claim.sessionId);
    assertIdeConnectionGeneration(claim.connectionGeneration);
    assertIdeControllerLeaseId(claim.controllerLeaseId);
    assertIdeOperationId(claim.operationId);
    assertIdeCapability(claim.capability);
    if (!B2_ENROLLMENT_CAPABILITIES.has(claim.capability)) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'companion capability is outside read-only IDE policy');
    }
    if (!/^[0-9a-f]{64}$/.test(claim.nonceHash)) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'companion nonce digest is invalid');
    }
    if (!Number.isSafeInteger(claim.nowMs) || claim.nowMs < 0 || !Number.isSafeInteger(claim.expiresAtMs)) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'companion replay time is invalid');
    }
    const remainingMs = claim.expiresAtMs - claim.nowMs;
    if (remainingMs <= 0 || remainingMs > IDE_COMPANION_MAX_LIFETIME_MS + IDE_COMPANION_MAX_CLOCK_SKEW_MS) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'companion replay expiry is outside the accepted window');
    }
  }

  private requireCompanionContext(request: IdeCompanionRegistryRequest): { session: IdeSessionRegistryRow; enrollment: IdeEnrollmentRow } {
    assertIdeEnrollmentId(request.enrollmentId);
    assertIdeInstanceId(request.ideInstanceId);
    assertIdeSessionId(request.sessionId);
    assertIdeConnectionGeneration(request.connectionGeneration);
    assertIdeControllerLeaseId(request.controllerLeaseId);
    assertIdeOperationId(request.operationId);
    assertIdeCapability(request.capability);
    const enrollment = this.requireEnrollment(request.enrollmentId);
    if (enrollment.state !== 'ACTIVE') throw new IdeRegistryStoreError('IDE_ENROLLMENT_NOT_ACTIVE', 'IDE enrollment is not active');
    if (enrollment.ideInstanceId !== request.ideInstanceId) throw new IdeRegistryStoreError('IDE_ENROLLMENT_BINDING_MISMATCH', 'IDE companion instance mismatch');
    if (!enrollment.capabilities.includes(request.capability)) throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'IDE companion capability is not enrolled');
    const session = this.getSession(request.sessionId);
    if (!session) throw new IdeRegistryStoreError('IDE_SESSION_NOT_FOUND', 'IDE session not found');
    if (session.enrollmentId !== enrollment.enrollmentId || session.connectionGeneration !== request.connectionGeneration || session.connectionGeneration !== enrollment.currentGeneration) {
      throw new IdeRegistryStoreError('IDE_SESSION_BINDING_MISMATCH', 'IDE companion session binding is stale or mismatched');
    }
    if (session.controllerLeaseId !== request.controllerLeaseId) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH', 'IDE companion controller lease mismatch');
    return { session, enrollment };
  }

  private transitionExact(key:IdeSessionRegistryKey,from:IdeSessionState,to:IdeSessionState,leaseId:string|null,clear=false):boolean {
    validateSessionKey(key); assertIdeSessionTransition(from,to); this.db.exec('BEGIN IMMEDIATE');
    try {
      const {session}=this.requireExactSession(key);
      if(session.state!==from) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH',`IDE session is ${session.state}, expected ${from}`);
      if(leaseId!==null&&session.controllerLeaseId!==leaseId) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','IDE controller lease mismatch');
      if(leaseId===null&&session.controllerLeaseId!==null) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','unexpected IDE controller lease present');
      const res=this.db.prepare(`UPDATE ide_sessions SET state=?,controller_lease_id=?,updated_at=? WHERE session_id=? AND connection_generation=? AND state=?`).run(to,clear?null:session.controllerLeaseId,nowIso(),key.sessionId,key.connectionGeneration,from);
      if(Number(res.changes)!==1) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE session transition lost CAS race');
      this.db.exec('COMMIT'); return true;
    } catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  private requireEnrollment(id:string):IdeEnrollmentRow {const e=this.getEnrollment(id);if(!e)throw new IdeRegistryStoreError('IDE_ENROLLMENT_NOT_FOUND','IDE enrollment not found');return e;}
  private assertEnrollmentKey(e:IdeEnrollmentRow,key:IdeEnrollmentKey):void {if(e.enrollmentId!==key.enrollmentId)throw new IdeRegistryStoreError('IDE_ENROLLMENT_BINDING_MISMATCH','IDE enrollment ID mismatch');const m=exactEnrollmentMismatch(e,key);if(m)throw new IdeRegistryStoreError('IDE_ENROLLMENT_BINDING_MISMATCH',`IDE enrollment binding mismatch: ${m}`);}
  private requireExactSession(key:IdeSessionRegistryKey):{session:IdeSessionRegistryRow;enrollment:IdeEnrollmentRow}{validateSessionKey(key);const session=this.getSession(key.sessionId);if(!session)throw new IdeRegistryStoreError('IDE_SESSION_NOT_FOUND','IDE session not found');if(session.connectionGeneration!==key.connectionGeneration)throw new IdeRegistryStoreError('IDE_SESSION_BINDING_MISMATCH','IDE session generation mismatch');const enrollment=this.requireEnrollment(session.enrollmentId);if(session.connectionGeneration!==enrollment.currentGeneration)throw new IdeRegistryStoreError('IDE_SESSION_BINDING_MISMATCH','IDE session is not the enrollment current generation');const m=exactEnrollmentMismatch(enrollment,key);if(m)throw new IdeRegistryStoreError('IDE_SESSION_BINDING_MISMATCH',`IDE session binding mismatch: ${m}`);return{session,enrollment};}

  private rowToEnrollment(row:Record<string,unknown>):IdeEnrollmentRow {
    const enrollmentId=String(row.enrollment_id),principalId=String(row.principal_id),projectId=String(row.project_id),worktreeId=String(row.worktree_id),ideProduct=String(row.ide_product) as IdeProductId,ideInstanceId=String(row.ide_instance_id),workspaceFingerprint=String(row.workspace_fingerprint),baseRevision=row.base_revision==null?undefined:String(row.base_revision);
    assertIdeEnrollmentId(enrollmentId); validateEnrollmentIdentity({principalId,projectId,worktreeId,ideProduct,ideInstanceId,workspaceFingerprint,baseRevision});
    let parsed:unknown;try{parsed=JSON.parse(String(row.capabilities_json));}catch{throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE enrollment capabilities are invalid JSON');}
    if(!Array.isArray(parsed))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE enrollment capabilities are not an array');
    const capabilities=canonicalCapabilities(parsed as IdeCapability[]);if(JSON.stringify(capabilities)!==JSON.stringify(parsed))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE enrollment capabilities are not canonical');
    const state=String(row.state) as IdeEnrollmentState;if(state!=='ACTIVE'&&state!=='REVOKED')throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE enrollment state is invalid');
    const currentGeneration=Number(row.current_generation);if(!Number.isSafeInteger(currentGeneration)||currentGeneration<0)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE enrollment generation is invalid');
    const revokedAt=row.revoked_at==null?null:String(row.revoked_at);if((state==='REVOKED')!==(revokedAt!==null))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE enrollment revocation fields are inconsistent');
    return{enrollmentId,principalId,projectId,worktreeId,ideProduct,ideInstanceId,workspaceFingerprint,baseRevision,capabilities,state,currentGeneration,createdAt:String(row.created_at),updatedAt:String(row.updated_at),revokedAt};
  }

  private rowToSession(row:Record<string,unknown>):IdeSessionRegistryRow {
    const sessionId=String(row.session_id),enrollmentId=String(row.enrollment_id),connectionGeneration=Number(row.connection_generation),state=String(row.state) as IdeSessionState,controllerLeaseId=row.controller_lease_id==null?null:String(row.controller_lease_id);
    assertIdeSessionId(sessionId);assertIdeEnrollmentId(enrollmentId);assertIdeConnectionGeneration(connectionGeneration);
    if(!(IDE_SESSION_STATES as readonly string[]).includes(state))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE session state is invalid');
    if(controllerLeaseId!==null&&!IDE_CONTROLLER_LEASE_ID_PATTERN.test(controllerLeaseId))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE controller lease identity is invalid');
    const shouldHave=state==='CONTROLLER_ACQUIRED'||state==='OPERATION_ACTIVE';if((controllerLeaseId!==null)!==shouldHave)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE session controller/state fields are inconsistent');
    const endedAt=row.ended_at==null?null:String(row.ended_at);if((state==='DISCONNECTED'||state==='STALE')!==(endedAt!==null))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE session terminal fields are inconsistent');
    return{sessionId,enrollmentId,connectionGeneration,state,controllerLeaseId,createdAt:String(row.created_at),updatedAt:String(row.updated_at),endedAt};
  }
}
