/**
 * Durable IDE Session Control enrollment/registry store (P7 B2).
 *
 * Plane B is deliberately separate from the Agent Control Plane database.
 * This store contains no prompt/response bodies, credentials, provider state,
 * host paths, model selections, or writer authority. It persists trusted
 * enrollment/session identity plus B7 operation attribution/lifecycle and
 * metadata-only event audit (message digest + byte count, never message body).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  IDE_CAPABILITIES,
  IDE_CONTROLLER_LEASE_ID_PATTERN,
  IDE_REVIEW_BASE_CAPABILITIES,
  IDE_SESSION_STATES,
  IDE_OPERATION_STATES,
  IdeSessionContractError,
  assertIdeCapability,
  assertIdeConnectionGeneration,
  assertIdeControllerLeaseId,
  assertIdeEnrollmentId,
  assertIdeInstanceId,
  assertIdeOperationId,
  assertIdeOperationTransition,
  assertIdeLogicalId,
  assertIdePrincipalId,
  assertIdeProduct,
  assertIdeSessionAuthority,
  assertIdeSessionId,
  assertIdeSessionTransition,
  assertIdeWorkspaceFingerprint,
  validateIdeOperationEvent,
  type IdeCapability,
  type IdeOperationEvent,
  type IdeOperationState,
  type IdeProductId,
  type IdeSessionAuthorityRequest,
  type IdeSessionBinding,
  type IdeSessionState,
} from '../../shared/ideSessions.js';
import { IDE_COMPANION_MAX_CLOCK_SKEW_MS, IDE_COMPANION_MAX_LIFETIME_MS } from '../../shared/ideCompanionAuth.js';
import { IDE_COMPANION_OPERATION_MAX_AUTHENTICATED_PAYLOAD_BYTES } from '../../shared/ideCompanionOperations.js';
import { LIVE_WRITER_LEASE_ID_PATTERN } from '../../shared/liveWriter.js';

export const IDE_REGISTRY_SCHEMA_VERSION = 4;
export const IDE_MAX_ACTIVE_AUTH_REPLAYS = 4096;
export const IDE_MAX_OPERATION_EVENTS = 4096;

const IDE_ENROLLMENT_CAPABILITIES = new Set<IdeCapability>([
  ...IDE_REVIEW_BASE_CAPABILITIES,
  'read_bounded_editor_context',
  // B9 permits an explicit implementation grant at enrollment, but the grant
  // is inert until the exact B8 live-writer lease is also proven.
  'request_implementation',
]);

const LIVE_SESSION_STATES: readonly IdeSessionState[] = [
  'CONNECTED', 'AVAILABLE', 'CONTROLLER_ACQUIRED', 'OPERATION_ACTIVE',
] as const;
const LIVE_SESSION_SQL = LIVE_SESSION_STATES.map((s) => `'${s}'`).join(',');

const ACTIVE_OPERATION_STATES: readonly IdeOperationState[] = ['RUNNING', 'CANCELLING'] as const;
const TERMINAL_OPERATION_STATES: readonly IdeOperationState[] = ['COMPLETED','CANCELLED','FAILED','DISCONNECTED','INDETERMINATE'] as const;
const ACTIVE_OPERATION_SQL = ACTIVE_OPERATION_STATES.map((s) => `'${s}'`).join(',');

const REQUIRED_TABLES = ['ide_enrollments', 'ide_sessions', 'ide_auth_replays', 'ide_operations', 'ide_operation_events'] as const;
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
  idx_ide_operations_one_active_session: {
    table: 'ide_operations',
    columns: ['session_id'],
    sql: `CREATE UNIQUE INDEX idx_ide_operations_one_active_session
          ON ide_operations(session_id) WHERE state IN (${ACTIVE_OPERATION_SQL})`,
  },
  idx_ide_operations_writer_lease: {
    table: 'ide_operations',
    columns: ['writer_lease_id'],
    sql: `CREATE UNIQUE INDEX idx_ide_operations_writer_lease
          ON ide_operations(writer_lease_id) WHERE writer_lease_id IS NOT NULL`,
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
  ide_operations: {
    operation_id: 'TEXT', enrollment_id: 'TEXT', session_id: 'TEXT', connection_generation: 'INTEGER',
    principal_id: 'TEXT', project_id: 'TEXT', worktree_id: 'TEXT', workspace_fingerprint: 'TEXT', base_revision: 'TEXT',
    ide_product: 'TEXT', ide_instance_id: 'TEXT', runtime_instance_id: 'TEXT', adapter_id: 'TEXT', adapter_version: 'TEXT',
    capability: 'TEXT', controller_lease_hash: 'TEXT', payload_sha256: 'TEXT', payload_bytes: 'INTEGER',
    writer_lease_id: 'TEXT', writer_settlement: 'TEXT', mutation_started_at: 'TEXT', writer_settled_at: 'TEXT', safe_terminal_intent: 'TEXT', safe_terminal_intent_at: 'TEXT',
    state: 'TEXT', next_sequence: 'INTEGER', started_at: 'TEXT', updated_at: 'TEXT', finished_at: 'TEXT', cancellation_requested_at: 'TEXT',
  },
  ide_operation_events: {
    operation_id: 'TEXT', sequence: 'INTEGER', event_type: 'TEXT', message_sha256: 'TEXT', message_bytes: 'INTEGER', created_at: 'TEXT',
  },
};

const REQUIRED_PRIMARY_KEYS: Record<string, readonly string[]> = {
  ide_enrollments: ['enrollment_id'],
  ide_sessions: ['session_id'],
  ide_auth_replays: ['nonce_hash'],
  ide_operations: ['operation_id'],
  ide_operation_events: ['operation_id', 'sequence'],
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
  | 'IDE_AUTH_REPLAY_CAPACITY'
  | 'IDE_OPERATION_ID_REUSED'
  | 'IDE_OPERATION_NOT_FOUND'
  | 'IDE_OPERATION_BINDING_MISMATCH'
  | 'IDE_OPERATION_STATE_MISMATCH'
  | 'IDE_OPERATION_EVENT_LIMIT';

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

export interface IdeLiveWriterAuthorityRow {
  writerLeaseId: string;
  projectId: string;
  worktreeId: string;
  ownerKind: 'agent_apply' | 'ide';
  ownerId: string;
  principalId: string;
  state: 'ACTIVE' | 'RELEASED' | 'UNCERTAIN';
}

export interface IdeLiveWriterAuthorityReader {
  getLiveWriterLease(writerLeaseId: string): IdeLiveWriterAuthorityRow | undefined;
}

export interface IdeAuthReplayClaim extends IdeCompanionRegistryRequest {
  nonceHash: string;
  expiresAtMs: number;
  nowMs: number;
}

export interface StartIdeOperationInput extends IdeCompanionRegistryRequest {
  runtimeInstanceId: string;
  adapterId: string;
  adapterVersion: string;
  payloadSha256: string;
  payloadBytes: number;
}

export interface StartIdeImplementationOperationInput extends StartIdeOperationInput {
  writerLeaseId: string;
}

export type IdeOperationWriterSettlement = 'HELD' | 'RELEASED' | 'UNCERTAIN';
export type IdeImplementationSafeTerminalIntent = 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface IdeOperationRow {
  operationId: string;
  enrollmentId: string;
  sessionId: string;
  connectionGeneration: number;
  principalId: string;
  projectId: string;
  worktreeId: string;
  workspaceFingerprint: string;
  baseRevision?: string;
  ideProduct: IdeProductId;
  ideInstanceId: string;
  runtimeInstanceId: string;
  adapterId: string;
  adapterVersion: string;
  capability: IdeCapability;
  controllerLeaseHash: string;
  payloadSha256: string;
  payloadBytes: number;
  writerLeaseId: string | null;
  writerSettlement: IdeOperationWriterSettlement | null;
  mutationStartedAt: string | null;
  writerSettledAt: string | null;
  safeTerminalIntent: IdeImplementationSafeTerminalIntent | null;
  safeTerminalIntentAt: string | null;
  state: IdeOperationState;
  nextSequence: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  cancellationRequestedAt: string | null;
}

export interface IdeOperationAuditRow {
  operationId: string;
  sequence: number;
  eventType: IdeOperationEvent['type'];
  messageSha256: string | null;
  messageBytes: number;
  createdAt: string;
}

function nowIso(): string { return new Date().toISOString(); }
function opaqueId(prefix: 'iden_' | 'idectl_'): string { return `${prefix}${randomBytes(16).toString('hex')}`; }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
const RUNTIME_INSTANCE_PATTERN = /^iderun_[0-9a-f]{32}$/;
const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ADAPTER_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
    if (!IDE_ENROLLMENT_CAPABILITIES.has(capability)) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', `capability ${capability} is outside current P7 enrollment policy`);
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

function validateOperationStartInput(input: StartIdeOperationInput): void {
  assertIdeEnrollmentId(input.enrollmentId);
  assertIdeInstanceId(input.ideInstanceId);
  assertIdeSessionId(input.sessionId);
  assertIdeConnectionGeneration(input.connectionGeneration);
  assertIdeControllerLeaseId(input.controllerLeaseId);
  assertIdeOperationId(input.operationId);
  assertIdeCapability(input.capability);
  if (!RUNTIME_INSTANCE_PATTERN.test(input.runtimeInstanceId)) throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'runtime instance identity is invalid');
  if (!ADAPTER_ID_PATTERN.test(input.adapterId)) throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'adapter identity is invalid');
  if (!ADAPTER_VERSION_PATTERN.test(input.adapterVersion)) throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'adapter version is invalid');
  if (!SHA256_PATTERN.test(input.payloadSha256)) throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'operation payload hash is invalid');
  if (!Number.isSafeInteger(input.payloadBytes) || input.payloadBytes < 1 || input.payloadBytes > IDE_COMPANION_OPERATION_MAX_AUTHENTICATED_PAYLOAD_BYTES) {
    throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'operation payload bytes are outside bounded operation envelope');
  }
}

function validateReviewOperationStartInput(input: StartIdeOperationInput): void {
  validateOperationStartInput(input);
  if (input.capability !== 'request_review') {
    throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'review operation start requires request_review');
  }
}

function validateImplementationOperationStartInput(input: StartIdeImplementationOperationInput): void {
  validateOperationStartInput(input);
  if (input.capability !== 'request_implementation') {
    throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'implementation operation start requires request_implementation');
  }
  if (!LIVE_WRITER_LEASE_ID_PATTERN.test(input.writerLeaseId)) {
    throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH', 'implementation writer lease identity is invalid');
  }
}

function terminalStateForEvent(type: IdeOperationEvent['type']): IdeOperationState | null {
  if (type === 'completed') return 'COMPLETED';
  if (type === 'cancelled') return 'CANCELLED';
  if (type === 'failed') return 'FAILED';
  if (type === 'disconnected') return 'DISCONNECTED';
  if (type === 'indeterminate') return 'INDETERMINATE';
  return null;
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

    if (version === 3) {
      this.assertSchemaShape({ includeWriter: false, stampedVersion: 3 });
      const columns=(this.db.prepare(`PRAGMA table_info(ide_operations)`).all() as Array<{name:string}>).map((row)=>row.name);
      const partialColumns=['writer_lease_id','writer_settlement','mutation_started_at','writer_settled_at','safe_terminal_intent','safe_terminal_intent_at'].filter((name)=>columns.includes(name));
      const partialIndex=this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ide_operations_writer_lease'`).get()!==undefined;
      if(partialColumns.length>0||partialIndex){
        throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE registry v3 contains partial v4 writer state: ${[...partialColumns,...(partialIndex?['idx_ide_operations_writer_lease']:[])].join(', ')}`);
      }
      const impossible=this.db.prepare(`SELECT operation_id FROM ide_operations WHERE capability='request_implementation' LIMIT 1`).get() as {operation_id:string}|undefined;
      if(impossible) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`historical v3 implementation operation ${impossible.operation_id} lacks B8 writer provenance`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`ALTER TABLE ide_operations ADD COLUMN writer_lease_id TEXT;
          ALTER TABLE ide_operations ADD COLUMN writer_settlement TEXT CHECK(writer_settlement IN ('HELD','RELEASED','UNCERTAIN'));
          ALTER TABLE ide_operations ADD COLUMN mutation_started_at TEXT;
          ALTER TABLE ide_operations ADD COLUMN writer_settled_at TEXT;
          ALTER TABLE ide_operations ADD COLUMN safe_terminal_intent TEXT CHECK(safe_terminal_intent IN ('COMPLETED','FAILED','CANCELLED'));
          ALTER TABLE ide_operations ADD COLUMN safe_terminal_intent_at TEXT;
          CREATE UNIQUE INDEX idx_ide_operations_writer_lease ON ide_operations(writer_lease_id) WHERE writer_lease_id IS NOT NULL;
          PRAGMA user_version=4;`);
        this.db.exec('COMMIT');
      } catch(error){this.db.exec('ROLLBACK');throw error;}
      this.assertSchemaShape();
      restrictSqliteFileModes(this.path);
      return;
    }

    if (version === 2) {
      this.assertSchemaShape({ includeOperations: false, stampedVersion: 2 });
      const partial = ['ide_operations', 'ide_operation_events', 'idx_ide_operations_one_active_session']
        .filter((name) => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name=?`).get(name) !== undefined);
      if (partial.length > 0) {
        throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA', `IDE registry v2 contains partial v3 operation state: ${partial.join(', ')}`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.createOperationSchema();
        this.db.exec(`PRAGMA user_version=${IDE_REGISTRY_SCHEMA_VERSION}`);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.assertSchemaShape();
      restrictSqliteFileModes(this.path);
      return;
    }

    if (version === 1) {
      this.assertSchemaShape({ includeReplay: false, includeOperations: false, stampedVersion: 1 });
      const unexpected = ['ide_auth_replays', 'idx_ide_auth_replays_expiry', 'ide_operations', 'ide_operation_events', 'idx_ide_operations_one_active_session']
        .filter((name) => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name=?`).get(name) !== undefined);
      if (unexpected.length > 0) {
        throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA', `IDE registry v1 contains partial later-schema state: ${unexpected.join(', ')}`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.createReplaySchema();
        this.createOperationSchema();
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
      this.createOperationSchema();
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

  private createOperationSchema(): void {
    this.db.exec(`
      CREATE TABLE ide_operations (
        operation_id TEXT PRIMARY KEY,
        enrollment_id TEXT NOT NULL REFERENCES ide_enrollments(enrollment_id),
        session_id TEXT NOT NULL REFERENCES ide_sessions(session_id),
        connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
        principal_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        workspace_fingerprint TEXT NOT NULL,
        base_revision TEXT,
        ide_product TEXT NOT NULL,
        ide_instance_id TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        capability TEXT NOT NULL,
        controller_lease_hash TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
        writer_lease_id TEXT,
        writer_settlement TEXT CHECK(writer_settlement IN ('HELD','RELEASED','UNCERTAIN')),
        mutation_started_at TEXT,
        writer_settled_at TEXT,
        safe_terminal_intent TEXT CHECK(safe_terminal_intent IN ('COMPLETED','FAILED','CANCELLED')),
        safe_terminal_intent_at TEXT,
        state TEXT NOT NULL CHECK(state IN ('RUNNING','CANCELLING','COMPLETED','CANCELLED','FAILED','DISCONNECTED','INDETERMINATE')),
        next_sequence INTEGER NOT NULL CHECK(next_sequence >= 1),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        cancellation_requested_at TEXT
      );
      CREATE UNIQUE INDEX idx_ide_operations_one_active_session
        ON ide_operations(session_id) WHERE state IN (${ACTIVE_OPERATION_SQL});
      CREATE UNIQUE INDEX idx_ide_operations_writer_lease
        ON ide_operations(writer_lease_id) WHERE writer_lease_id IS NOT NULL;
      CREATE TABLE ide_operation_events (
        operation_id TEXT NOT NULL REFERENCES ide_operations(operation_id),
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        event_type TEXT NOT NULL,
        message_sha256 TEXT,
        message_bytes INTEGER NOT NULL CHECK(message_bytes >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY(operation_id, sequence)
      );
    `);
  }

  private assertSchemaShape(options: { includeReplay?: boolean; includeOperations?: boolean; includeWriter?: boolean; stampedVersion?: number } = {}): void {
    const includeReplay = options.includeReplay ?? true;
    const includeOperations = options.includeOperations ?? true;
    const includeWriter = options.includeWriter ?? true;
    const stampedVersion = options.stampedVersion ?? IDE_REGISTRY_SCHEMA_VERSION;
    const missing: string[] = [];
    const tableExists = (name: string): boolean => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
    const indexExists = (name: string): boolean => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name) !== undefined;
    for (const table of REQUIRED_TABLES) {
      if (!includeReplay && table === 'ide_auth_replays') continue;
      if (!includeOperations && (table === 'ide_operations' || table === 'ide_operation_events')) continue;
      if (!tableExists(table)) missing.push(`table ${table}`);
    }
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      if (!includeReplay && table === 'ide_auth_replays') continue;
      if (!includeOperations && (table === 'ide_operations' || table === 'ide_operation_events')) continue;
      if (!tableExists(table)) continue;
      const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; pk: number }[];
      for (const [column, affinity] of Object.entries(columns)) {
        if (!includeWriter && table === 'ide_operations' && ['writer_lease_id','writer_settlement','mutation_started_at','writer_settled_at','safe_terminal_intent','safe_terminal_intent_at'].includes(column)) continue;
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
      if (!includeOperations && (index === 'idx_ide_operations_one_active_session' || index === 'idx_ide_operations_writer_lease')) continue;
      if (!includeWriter && index === 'idx_ide_operations_writer_lease') continue;
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
    if(includeOperations)this.assertDurableOperationCoherence(!includeWriter);
  }

  private assertDurableOperationCoherence(legacyWriterFields = false): void {
    const rows=this.db.prepare(`SELECT * FROM ide_operations ORDER BY operation_id`).all() as Record<string,unknown>[];
    const terminalEvent:Partial<Record<IdeOperationState,IdeOperationEvent['type']>>={COMPLETED:'completed',CANCELLED:'cancelled',FAILED:'failed',DISCONNECTED:'disconnected',INDETERMINATE:'indeterminate'};
    for(const raw of rows){
      const op=this.rowToOperation(raw, legacyWriterFields);
      const events=this.getOperationAudit(op.operationId);
      if(events.length!==op.nextSequence)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE operation ${op.operationId} audit length/next sequence mismatch`);
      if(events.length<1||events[0]?.sequence!==0||events[0]?.eventType!=='operation_started')throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE operation ${op.operationId} lacks canonical start event`);
      for(let i=0;i<events.length;i+=1)if(events[i]?.sequence!==i)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE operation ${op.operationId} audit sequence is not contiguous`);
      const expectedTerminal=terminalEvent[op.state];
      const last=events.at(-1)!;
      if(expectedTerminal!==undefined&&last.eventType!==expectedTerminal)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE operation ${op.operationId} terminal state/event mismatch`);
      if(expectedTerminal===undefined&&['completed','cancelled','failed','disconnected','indeterminate'].includes(last.eventType))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE active operation ${op.operationId} has terminal audit event`);
      if(op.state==='CANCELLED'&&op.cancellationRequestedAt===null)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE cancelled operation ${op.operationId} lacks cancellation request attribution`);
      if(ACTIVE_OPERATION_STATES.includes(op.state)){
        const sessionRaw=this.db.prepare(`SELECT * FROM ide_sessions WHERE session_id=?`).get(op.sessionId) as Record<string,unknown>|undefined;
        if(!sessionRaw)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE active operation ${op.operationId} session is missing`);
        const session=this.rowToSession(sessionRaw);
        if(session.enrollmentId!==op.enrollmentId||session.connectionGeneration!==op.connectionGeneration||session.state!=='OPERATION_ACTIVE'||session.controllerLeaseId===null||sha256(session.controllerLeaseId)!==op.controllerLeaseHash){
          throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE active operation ${op.operationId} session/controller binding is incoherent`);
        }
        const enrollment=this.requireEnrollment(op.enrollmentId);
        if(enrollment.currentGeneration!==op.connectionGeneration)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA',`IDE active operation ${op.operationId} is not current generation`);
      }
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


  getOperation(operationId: string): IdeOperationRow | undefined {
    assertIdeOperationId(operationId);
    const row = this.db.prepare(`SELECT * FROM ide_operations WHERE operation_id=?`).get(operationId) as Record<string, unknown>|undefined;
    return row ? this.rowToOperation(row) : undefined;
  }

  getOperationAudit(operationId: string): IdeOperationAuditRow[] {
    assertIdeOperationId(operationId);
    const rows = this.db.prepare(`SELECT * FROM ide_operation_events WHERE operation_id=? ORDER BY sequence`).all(operationId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToOperationAudit(row));
  }

  /** B9.2 recovery seam: terminal implementation operations whose B8 settlement is not yet locally recorded. */
  listImplementationOperationsWithHeldWriter(): IdeOperationRow[] {
    const rows=this.db.prepare(`SELECT * FROM ide_operations
      WHERE capability='request_implementation' AND writer_settlement='HELD'
      ORDER BY operation_id`).all() as Record<string,unknown>[];
    return rows.map((row)=>this.rowToOperation(row));
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
      const live=this.db.prepare(`SELECT session_id,connection_generation FROM ide_sessions WHERE enrollment_id=? AND state IN (${LIVE_SESSION_SQL})`).all(key.enrollmentId) as Array<{session_id:string;connection_generation:number}>;
      for(const row of live)this.terminalizeActiveOperationForSessionTx(row.session_id,Number(row.connection_generation),'disconnected');
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
      const priorLive=this.db.prepare(`SELECT session_id,connection_generation FROM ide_sessions WHERE enrollment_id=? AND state IN (${LIVE_SESSION_SQL})`).all(input.enrollmentId) as Array<{session_id:string;connection_generation:number}>;
      for(const row of priorLive)this.terminalizeActiveOperationForSessionTx(row.session_id,Number(row.connection_generation),'disconnected');
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


  /** B7: atomically bind one authenticated review operation to the current controller/session. */
  startOperation(input: StartIdeOperationInput): IdeOperationRow {
    validateReviewOperationStartInput(input);
    return this.startOperationInternal(input, null);
  }

  /** B9.2: durably attribute the exact B8 lease before any implementation adapter may run. */
  startImplementationOperation(input: StartIdeImplementationOperationInput): IdeOperationRow {
    validateImplementationOperationStartInput(input);
    return this.startOperationInternal(input, input.writerLeaseId);
  }

  private startOperationInternal(input: StartIdeOperationInput, writerLeaseId: string | null): IdeOperationRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare(`SELECT 1 FROM ide_operations WHERE operation_id=?`).get(input.operationId)!==undefined) {
        throw new IdeRegistryStoreError('IDE_OPERATION_ID_REUSED','IDE operation ID has already been used');
      }
      const {session,enrollment}=this.requireCompanionContext(input);
      if(session.state!=='CONTROLLER_ACQUIRED') throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE session is not ready to start an operation');
      const isImplementation=input.capability==='request_implementation';
      if(isImplementation!== (writerLeaseId!==null)) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','IDE operation writer provenance is incomplete');
      const now=nowIso();
      const controllerLeaseHash=sha256(input.controllerLeaseId);
      this.db.prepare(`INSERT INTO ide_operations
        (operation_id,enrollment_id,session_id,connection_generation,principal_id,project_id,worktree_id,workspace_fingerprint,base_revision,
         ide_product,ide_instance_id,runtime_instance_id,adapter_id,adapter_version,capability,controller_lease_hash,payload_sha256,payload_bytes,
         writer_lease_id,writer_settlement,mutation_started_at,writer_settled_at,safe_terminal_intent,safe_terminal_intent_at,state,next_sequence,started_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,'RUNNING',1,?,?)`).run(
        input.operationId,enrollment.enrollmentId,session.sessionId,session.connectionGeneration,enrollment.principalId,enrollment.projectId,enrollment.worktreeId,
        enrollment.workspaceFingerprint,enrollment.baseRevision??null,enrollment.ideProduct,enrollment.ideInstanceId,input.runtimeInstanceId,input.adapterId,input.adapterVersion,
        input.capability,controllerLeaseHash,input.payloadSha256,input.payloadBytes,writerLeaseId,isImplementation?'HELD':null,now,now,
      );
      const moved=this.db.prepare(`UPDATE ide_sessions SET state='OPERATION_ACTIVE',updated_at=?
        WHERE session_id=? AND connection_generation=? AND state='CONTROLLER_ACQUIRED' AND controller_lease_id=?`).run(
        now,session.sessionId,session.connectionGeneration,input.controllerLeaseId,
      );
      if(Number(moved.changes)!==1) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE operation start lost session CAS race');
      this.db.prepare(`INSERT INTO ide_operation_events(operation_id,sequence,event_type,message_sha256,message_bytes,created_at)
        VALUES (?,0,'operation_started',NULL,0,?)`).run(input.operationId,now);
      this.db.exec('COMMIT');
    } catch(error){try{this.db.exec('ROLLBACK');}catch{} throw error;}
    return this.getOperation(input.operationId)!;
  }

  /** Mark the conservative durable mutation boundary before invoking a mutation-capable adapter. */
  markImplementationMutationStarted(operationId:string, writerLeaseId:string, controllerLeaseId:string): IdeOperationRow {
    assertIdeOperationId(operationId); assertIdeControllerLeaseId(controllerLeaseId);
    if(!LIVE_WRITER_LEASE_ID_PATTERN.test(writerLeaseId)) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation writer lease identity is invalid');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const raw=this.db.prepare(`SELECT * FROM ide_operations WHERE operation_id=?`).get(operationId) as Record<string,unknown>|undefined;
      if(!raw) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
      const op=this.rowToOperation(raw);
      if(op.capability!=='request_implementation'||op.writerLeaseId!==writerLeaseId||op.writerSettlement!=='HELD') throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation writer provenance mismatch');
      if(op.controllerLeaseHash!==sha256(controllerLeaseId)) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','IDE operation controller lease mismatch');
      if(op.state!=='RUNNING'||op.mutationStartedAt!==null) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation mutation boundary is not startable');
      const now=nowIso();
      const changed=this.db.prepare(`UPDATE ide_operations SET mutation_started_at=?,updated_at=? WHERE operation_id=? AND state='RUNNING' AND writer_settlement='HELD' AND mutation_started_at IS NULL`).run(now,now,operationId);
      if(Number(changed.changes)!==1) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation mutation boundary lost CAS race');
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
    return this.getOperation(operationId)!;
  }

  /** Persist a safe adapter outcome before any external B8 release is attempted. */
  prepareImplementationSafeTerminal(
    operationId:string,
    writerLeaseId:string,
    controllerLeaseId:string,
    intent:IdeImplementationSafeTerminalIntent,
  ): IdeOperationRow {
    assertIdeOperationId(operationId); assertIdeControllerLeaseId(controllerLeaseId);
    if(!LIVE_WRITER_LEASE_ID_PATTERN.test(writerLeaseId)) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation writer lease identity is invalid');
    if(!['COMPLETED','FAILED','CANCELLED'].includes(intent)) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation safe-terminal intent is invalid');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const raw=this.db.prepare(`SELECT * FROM ide_operations WHERE operation_id=?`).get(operationId) as Record<string,unknown>|undefined;
      if(!raw) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
      const op=this.rowToOperation(raw);
      if(op.capability!=='request_implementation'||op.writerLeaseId!==writerLeaseId||op.writerSettlement!=='HELD') throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation writer provenance mismatch');
      if(op.controllerLeaseHash!==sha256(controllerLeaseId)) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','IDE operation controller lease mismatch');
      if(!ACTIVE_OPERATION_STATES.includes(op.state)) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation operation is already terminal');
      assertIdeOperationTransition(op.state,intent);
      if(op.safeTerminalIntent!==null){
        if(op.safeTerminalIntent!==intent) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation safe-terminal intent is already different');
        this.db.exec('COMMIT'); return op;
      }
      const now=nowIso();
      const changed=this.db.prepare(`UPDATE ide_operations SET safe_terminal_intent=?,safe_terminal_intent_at=?,updated_at=?
        WHERE operation_id=? AND writer_lease_id=? AND writer_settlement='HELD' AND safe_terminal_intent IS NULL AND state=?`).run(
        intent,now,now,operationId,writerLeaseId,op.state,
      );
      if(Number(changed.changes)!==1) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation safe-terminal intent lost CAS race');
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
    return this.getOperation(operationId)!;
  }

  /**
   * Finalize a safe terminal only after re-reading the exact immutable B8
   * lease as RELEASED. The terminal audit event, operation state, session
   * settlement and local writer-settlement mirror commit in one Plane-B txn.
   */
  finalizeImplementationSafeTerminal(
    operationId:string,
    writerAuthority:IdeLiveWriterAuthorityReader,
    writerLeaseId:string,
    controllerLeaseId:string,
  ): IdeOperationRow {
    assertIdeOperationId(operationId); assertIdeControllerLeaseId(controllerLeaseId);
    const snapshot=this.getOperation(operationId);
    if(!snapshot) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
    this.assertExternalImplementationWriter(snapshot,writerAuthority,writerLeaseId,'RELEASED');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const raw=this.db.prepare(`SELECT * FROM ide_operations WHERE operation_id=?`).get(operationId) as Record<string,unknown>|undefined;
      if(!raw) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
      const op=this.rowToOperation(raw);
      if(op.capability!=='request_implementation'||op.writerLeaseId!==writerLeaseId||op.writerSettlement!=='HELD'||op.safeTerminalIntent===null) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation safe terminal lacks exact writer/intention provenance');
      if(op.controllerLeaseHash!==sha256(controllerLeaseId)) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','IDE operation controller lease mismatch');
      if(!ACTIVE_OPERATION_STATES.includes(op.state)) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation operation is already terminal');
      assertIdeOperationTransition(op.state,op.safeTerminalIntent);
      const type=op.safeTerminalIntent==='COMPLETED'?'completed':op.safeTerminalIntent==='FAILED'?'failed':'cancelled';
      const now=nowIso();
      const event:IdeOperationEvent={version:1,operationId:op.operationId,sessionId:op.sessionId,connectionGeneration:op.connectionGeneration,origin:'machine',sequence:op.nextSequence,type};
      this.insertOperationAuditEventTx(event,now);
      const changed=this.db.prepare(`UPDATE ide_operations SET state=?,next_sequence=?,finished_at=?,writer_settlement='RELEASED',writer_settled_at=?,updated_at=?
        WHERE operation_id=? AND state=? AND next_sequence=? AND writer_lease_id=? AND writer_settlement='HELD' AND safe_terminal_intent=?`).run(
        op.safeTerminalIntent,op.nextSequence+1,now,now,now,op.operationId,op.state,op.nextSequence,writerLeaseId,op.safeTerminalIntent,
      );
      if(Number(changed.changes)!==1) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation safe terminal lost operation CAS race');
      this.settleOperationSessionTx(op,controllerLeaseId,now);
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
    return this.getOperation(operationId)!;
  }

  /** Finalize an unsafe/ambiguous terminal only after exact B8 UNCERTAIN proof. */
  finalizeImplementationUncertainTerminal(
    operationId:string,
    writerAuthority:IdeLiveWriterAuthorityReader,
    writerLeaseId:string,
    controllerLeaseId:string,
    type:'indeterminate'|'disconnected',
  ): IdeOperationRow {
    assertIdeOperationId(operationId); assertIdeControllerLeaseId(controllerLeaseId);
    const snapshot=this.getOperation(operationId);
    if(!snapshot) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
    this.assertExternalImplementationWriter(snapshot,writerAuthority,writerLeaseId,'UNCERTAIN');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const raw=this.db.prepare(`SELECT * FROM ide_operations WHERE operation_id=?`).get(operationId) as Record<string,unknown>|undefined;
      if(!raw) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
      const op=this.rowToOperation(raw);
      if(op.capability!=='request_implementation'||op.writerLeaseId!==writerLeaseId||op.writerSettlement!=='HELD') throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation uncertain terminal lacks exact writer provenance');
      if(op.controllerLeaseHash!==sha256(controllerLeaseId)) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','IDE operation controller lease mismatch');
      if(!ACTIVE_OPERATION_STATES.includes(op.state)) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation operation is already terminal');
      const target=type==='indeterminate'?'INDETERMINATE':'DISCONNECTED'; assertIdeOperationTransition(op.state,target);
      const now=nowIso();
      const event:IdeOperationEvent={version:1,operationId:op.operationId,sessionId:op.sessionId,connectionGeneration:op.connectionGeneration,origin:'machine',sequence:op.nextSequence,type};
      this.insertOperationAuditEventTx(event,now);
      const changed=this.db.prepare(`UPDATE ide_operations SET state=?,next_sequence=?,finished_at=?,writer_settlement='UNCERTAIN',writer_settled_at=?,updated_at=?
        WHERE operation_id=? AND state=? AND next_sequence=? AND writer_lease_id=? AND writer_settlement='HELD'`).run(
        target,op.nextSequence+1,now,now,now,op.operationId,op.state,op.nextSequence,writerLeaseId,
      );
      if(Number(changed.changes)!==1) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation uncertain terminal lost operation CAS race');
      this.settleOperationSessionTx(op,controllerLeaseId,now);
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
    return this.getOperation(operationId)!;
  }

  /** Mirror an already-terminal operation's writer state only after exact B8 proof. */
  markImplementationWriterSettlement(
    operationId:string,
    writerAuthority:IdeLiveWriterAuthorityReader,
    writerLeaseId:string,
    settlement:'RELEASED'|'UNCERTAIN',
  ): boolean {
    assertIdeOperationId(operationId);
    if(!LIVE_WRITER_LEASE_ID_PATTERN.test(writerLeaseId)) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation writer lease identity is invalid');
    const snapshot=this.getOperation(operationId);
    if(!snapshot) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
    this.assertExternalImplementationWriter(snapshot,writerAuthority,writerLeaseId,settlement);
    if(settlement==='RELEASED'&&snapshot.safeTerminalIntent===null) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','released implementation writer lacks prior safe-terminal proof');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const raw=this.db.prepare(`SELECT * FROM ide_operations WHERE operation_id=?`).get(operationId) as Record<string,unknown>|undefined;
      if(!raw) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
      const op=this.rowToOperation(raw);
      if(op.capability!=='request_implementation'||op.writerLeaseId!==writerLeaseId) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation writer settlement binding mismatch');
      if(ACTIVE_OPERATION_STATES.includes(op.state)) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','active implementation operation cannot mirror terminal writer authority');
      if(op.writerSettlement===settlement){this.db.exec('COMMIT');return false;}
      if(op.writerSettlement!=='HELD') throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH',`implementation writer is already ${op.writerSettlement}`);
      const now=nowIso();
      const changed=this.db.prepare(`UPDATE ide_operations SET writer_settlement=?,writer_settled_at=?,updated_at=? WHERE operation_id=? AND writer_lease_id=? AND writer_settlement='HELD'`).run(settlement,now,now,operationId,writerLeaseId);
      if(Number(changed.changes)!==1) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation writer settlement lost CAS race');
      this.db.exec('COMMIT');return true;
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  private assertExternalImplementationWriter(
    op:IdeOperationRow,
    writerAuthority:IdeLiveWriterAuthorityReader,
    writerLeaseId:string,
    expectedState:'RELEASED'|'UNCERTAIN',
  ): void {
    if(op.capability!=='request_implementation'||op.writerLeaseId!==writerLeaseId) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','implementation writer provenance mismatch');
    const writer=writerAuthority.getLiveWriterLease(writerLeaseId);
    if(!writer||writer.state!==expectedState||writer.ownerKind!=='ide'||writer.ownerId!==op.operationId||writer.principalId!==op.principalId||writer.projectId!==op.projectId||writer.worktreeId!==op.worktreeId){
      throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH',`external B8 writer authority is not exact ${expectedState}`);
    }
  }

  private settleOperationSessionTx(op:IdeOperationRow,controllerLeaseId:string,now:string):void{
    const session=this.db.prepare(`SELECT state,controller_lease_id FROM ide_sessions WHERE session_id=? AND connection_generation=?`).get(op.sessionId,op.connectionGeneration) as {state:string;controller_lease_id:string|null}|undefined;
    if(!session||session.state!=='OPERATION_ACTIVE'||session.controller_lease_id!==controllerLeaseId) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE implementation terminal cannot settle current session');
    const settled=this.db.prepare(`UPDATE ide_sessions SET state='CONTROLLER_ACQUIRED',updated_at=? WHERE session_id=? AND connection_generation=? AND state='OPERATION_ACTIVE' AND controller_lease_id=?`).run(now,op.sessionId,op.connectionGeneration,controllerLeaseId);
    if(Number(settled.changes)!==1) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE implementation settlement lost session CAS race');
  }

  requestOperationCancellation(request: IdeCompanionRegistryRequest): IdeOperationRow {
    assertIdeCapability(request.capability);
    if(request.capability!=='cancel') throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED','operation cancellation requires cancel capability');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const {session}=this.requireCompanionContext(request);
      if(session.state!=='OPERATION_ACTIVE') throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE session has no active operation');
      const row=this.db.prepare(`SELECT * FROM ide_operations WHERE operation_id=?`).get(request.operationId) as Record<string,unknown>|undefined;
      if(!row) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
      const op=this.rowToOperation(row);
      this.assertOperationRequestBinding(op,request);
      if(op.state==='CANCELLING'){this.db.exec('COMMIT');return op;}
      if(op.state!=='RUNNING') throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH',`IDE operation is ${op.state}, not RUNNING`);
      assertIdeOperationTransition('RUNNING','CANCELLING');
      const now=nowIso();
      const changed=this.db.prepare(`UPDATE ide_operations SET state='CANCELLING',cancellation_requested_at=?,updated_at=?
        WHERE operation_id=? AND state='RUNNING'`).run(now,now,op.operationId);
      if(Number(changed.changes)!==1) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','IDE operation cancellation lost CAS race');
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
    return this.getOperation(request.operationId)!;
  }

  /** Persist event metadata before the caller streams the event body. Raw message text is never stored. */
  appendOperationEvent(event: IdeOperationEvent, controllerLeaseId: string): IdeOperationRow {
    validateIdeOperationEvent(event);assertIdeControllerLeaseId(controllerLeaseId);
    if(event.type==='operation_started') throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','operation_started is emitted only by atomic start');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const raw=this.db.prepare(`SELECT * FROM ide_operations WHERE operation_id=?`).get(event.operationId) as Record<string,unknown>|undefined;
      if(!raw) throw new IdeRegistryStoreError('IDE_OPERATION_NOT_FOUND','IDE operation not found');
      const op=this.rowToOperation(raw);
      if(op.sessionId!==event.sessionId||op.connectionGeneration!==event.connectionGeneration) throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','IDE event operation binding mismatch');
      if(op.controllerLeaseHash!==sha256(controllerLeaseId)) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','IDE operation controller lease mismatch');
      if(event.sequence!==op.nextSequence) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','IDE operation event sequence is not the durable next sequence');
      if(!ACTIVE_OPERATION_STATES.includes(op.state)) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH',`IDE operation is terminal: ${op.state}`);
      const terminal=terminalStateForEvent(event.type);
      if(op.capability==='request_implementation'&&terminal!==null){
        throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','implementation terminal events require the B9 writer-settlement finalizer');
      }
      if(terminal===null && event.sequence>=IDE_MAX_OPERATION_EVENTS-1) throw new IdeRegistryStoreError('IDE_OPERATION_EVENT_LIMIT','IDE operation event limit reached; terminal slot reserved');
      if(event.sequence>=IDE_MAX_OPERATION_EVENTS) throw new IdeRegistryStoreError('IDE_OPERATION_EVENT_LIMIT','IDE operation event limit reached');
      if(terminal!==null) assertIdeOperationTransition(op.state,terminal);
      const now=nowIso();
      this.insertOperationAuditEventTx(event,now);
      if(terminal!==null){
        const changed=this.db.prepare(`UPDATE ide_operations SET state=?,next_sequence=?,finished_at=?,updated_at=? WHERE operation_id=? AND state=? AND next_sequence=?`).run(
          terminal,event.sequence+1,now,now,op.operationId,op.state,op.nextSequence,
        );
        if(Number(changed.changes)!==1) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','IDE terminal event lost CAS race');
        const session=this.db.prepare(`SELECT state,controller_lease_id FROM ide_sessions WHERE session_id=? AND connection_generation=?`).get(op.sessionId,op.connectionGeneration) as {state:string;controller_lease_id:string|null}|undefined;
        if(!session||session.state!=='OPERATION_ACTIVE'||session.controller_lease_id!==controllerLeaseId) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE terminal event cannot settle current session');
        const settled=this.db.prepare(`UPDATE ide_sessions SET state='CONTROLLER_ACQUIRED',updated_at=? WHERE session_id=? AND connection_generation=? AND state='OPERATION_ACTIVE' AND controller_lease_id=?`).run(now,op.sessionId,op.connectionGeneration,controllerLeaseId);
        if(Number(settled.changes)!==1) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE operation settlement lost session CAS race');
      }else{
        const changed=this.db.prepare(`UPDATE ide_operations SET next_sequence=?,updated_at=? WHERE operation_id=? AND state=? AND next_sequence=?`).run(event.sequence+1,now,op.operationId,op.state,op.nextSequence);
        if(Number(changed.changes)!==1) throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','IDE event append lost CAS race');
      }
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
    return this.getOperation(event.operationId)!;
  }

  disconnect(key: IdeSessionRegistryKey): boolean {
    validateSessionKey(key); this.db.exec('BEGIN IMMEDIATE');
    try {
      const {session}=this.requireExactSession(key); assertIdeSessionTransition(session.state,'DISCONNECTED'); const now=nowIso();
      this.terminalizeActiveOperationForSessionTx(session.sessionId,session.connectionGeneration,'disconnected');
      const res=this.db.prepare(`UPDATE ide_sessions SET state='DISCONNECTED',controller_lease_id=NULL,ended_at=?,updated_at=? WHERE session_id=? AND connection_generation=? AND state=?`).run(now,now,key.sessionId,key.connectionGeneration,session.state);
      if(Number(res.changes)!==1) throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','IDE disconnect lost CAS race');
      this.db.exec('COMMIT'); return true;
    } catch(error) { try{this.db.exec('ROLLBACK');}catch{} throw error; }
  }

  recoverAfterRestart(): {staledSessionIds:string[];indeterminateOperationIds:string[]} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=this.db.prepare(`SELECT session_id,connection_generation FROM ide_sessions WHERE state IN (${LIVE_SESSION_SQL}) ORDER BY session_id`).all() as Array<{session_id:string;connection_generation:number}>;
      const indeterminateOperationIds:string[]=[];
      for(const row of rows){const op=this.terminalizeActiveOperationForSessionTx(row.session_id,Number(row.connection_generation),'indeterminate');if(op)indeterminateOperationIds.push(op);}
      if(rows.length>0){const now=nowIso();this.db.prepare(`UPDATE ide_sessions SET state='STALE',controller_lease_id=NULL,ended_at=?,updated_at=? WHERE state IN (${LIVE_SESSION_SQL})`).run(now,now);}
      this.db.exec('COMMIT'); return {staledSessionIds:rows.map(r=>r.session_id),indeterminateOperationIds};
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

  /** B9: re-read and prove full B1 authority from the exact durable B8 IDE lease. */
  assertCompanionAuthorityWithWriter(
    request: IdeCompanionRegistryRequest,
    writerAuthority: IdeLiveWriterAuthorityReader,
    writerLeaseId: string,
  ): void {
    const { session, enrollment } = this.requireCompanionContext(request);
    if (request.capability !== 'request_implementation') {
      throw new IdeRegistryStoreError('IDE_REGISTRY_POLICY_DENIED', 'writer authority is valid only for request_implementation');
    }
    if (!LIVE_WRITER_LEASE_ID_PATTERN.test(writerLeaseId)) {
      throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH', 'IDE live-writer lease id is invalid');
    }
    const writer = writerAuthority.getLiveWriterLease(writerLeaseId);
    if (!writer
      || writer.ownerKind !== 'ide'
      || writer.ownerId !== request.operationId
      || writer.principalId !== enrollment.principalId
      || writer.projectId !== enrollment.projectId
      || writer.worktreeId !== enrollment.worktreeId
      || writer.state !== 'ACTIVE') {
      throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH', 'durable IDE live-writer authority does not match trusted operation binding');
    }
    const authority: IdeSessionAuthorityRequest = {
      principalId: enrollment.principalId, projectId: enrollment.projectId, worktreeId: enrollment.worktreeId,
      workspaceFingerprint: enrollment.workspaceFingerprint, baseRevision: enrollment.baseRevision, ideProduct: enrollment.ideProduct,
      ideInstanceId: enrollment.ideInstanceId, sessionId: session.sessionId, connectionGeneration: session.connectionGeneration,
      capability: request.capability,
    };
    const binding: IdeSessionBinding = {
      principalId: enrollment.principalId, projectId: enrollment.projectId, worktreeId: enrollment.worktreeId,
      workspaceFingerprint: enrollment.workspaceFingerprint, baseRevision: enrollment.baseRevision, ideProduct: enrollment.ideProduct,
      ideInstanceId: enrollment.ideInstanceId, sessionId: session.sessionId, connectionGeneration: session.connectionGeneration,
      capabilities: enrollment.capabilities, sessionState: session.state, controllerLease: 'acquired', writerLease: 'acquired',
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

  private assertOperationRequestBinding(op: IdeOperationRow, request: IdeCompanionRegistryRequest): void {
    if(op.enrollmentId!==request.enrollmentId||op.sessionId!==request.sessionId||op.connectionGeneration!==request.connectionGeneration||op.operationId!==request.operationId){
      throw new IdeRegistryStoreError('IDE_OPERATION_BINDING_MISMATCH','IDE operation request binding mismatch');
    }
    if(op.controllerLeaseHash!==sha256(request.controllerLeaseId)) throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','IDE operation controller lease mismatch');
  }

  private insertOperationAuditEventTx(event: IdeOperationEvent, createdAt: string): void {
    const messageBytes=event.message===undefined?0:Buffer.byteLength(event.message,'utf8');
    const messageSha256=event.message===undefined?null:sha256(event.message);
    this.db.prepare(`INSERT INTO ide_operation_events(operation_id,sequence,event_type,message_sha256,message_bytes,created_at)
      VALUES (?,?,?,?,?,?)`).run(event.operationId,event.sequence,event.type,messageSha256,messageBytes,createdAt);
  }

  private terminalizeActiveOperationForSessionTx(sessionId: string, connectionGeneration: number, eventType: 'disconnected'|'indeterminate'): string | null {
    const raw=this.db.prepare(`SELECT * FROM ide_operations WHERE session_id=? AND connection_generation=? AND state IN (${ACTIVE_OPERATION_SQL})`).get(sessionId,connectionGeneration) as Record<string,unknown>|undefined;
    if(!raw)return null;
    const op=this.rowToOperation(raw);
    const target=terminalStateForEvent(eventType);
    if(target===null)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','terminal recovery event is invalid');
    assertIdeOperationTransition(op.state,target);
    if(op.nextSequence>=IDE_MAX_OPERATION_EVENTS)throw new IdeRegistryStoreError('IDE_OPERATION_EVENT_LIMIT','terminal operation audit slot exhausted');
    const now=nowIso();
    const event:IdeOperationEvent={version:1,operationId:op.operationId,sessionId:op.sessionId,connectionGeneration:op.connectionGeneration,origin:'machine',sequence:op.nextSequence,type:eventType};
    this.insertOperationAuditEventTx(event,now);
    const changed=this.db.prepare(`UPDATE ide_operations SET state=?,next_sequence=?,finished_at=?,updated_at=? WHERE operation_id=? AND state=? AND next_sequence=?`).run(
      target,op.nextSequence+1,now,now,op.operationId,op.state,op.nextSequence,
    );
    if(Number(changed.changes)!==1)throw new IdeRegistryStoreError('IDE_OPERATION_STATE_MISMATCH','IDE recovery terminalization lost CAS race');
    return op.operationId;
  }

  private validateReplayClaim(claim: IdeAuthReplayClaim): void {
    assertIdeEnrollmentId(claim.enrollmentId);
    assertIdeInstanceId(claim.ideInstanceId);
    assertIdeSessionId(claim.sessionId);
    assertIdeConnectionGeneration(claim.connectionGeneration);
    assertIdeControllerLeaseId(claim.controllerLeaseId);
    assertIdeOperationId(claim.operationId);
    assertIdeCapability(claim.capability);
    if (!IDE_ENROLLMENT_CAPABILITIES.has(claim.capability)) {
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

  private rowToOperation(row: Record<string, unknown>, legacyWriterFields = false): IdeOperationRow {
    const operationId=String(row.operation_id),enrollmentId=String(row.enrollment_id),sessionId=String(row.session_id),connectionGeneration=Number(row.connection_generation);
    const principalId=String(row.principal_id),projectId=String(row.project_id),worktreeId=String(row.worktree_id),workspaceFingerprint=String(row.workspace_fingerprint),baseRevision=row.base_revision==null?undefined:String(row.base_revision);
    const ideProduct=String(row.ide_product) as IdeProductId,ideInstanceId=String(row.ide_instance_id),runtimeInstanceId=String(row.runtime_instance_id),adapterId=String(row.adapter_id),adapterVersion=String(row.adapter_version),capability=String(row.capability) as IdeCapability;
    const controllerLeaseHash=String(row.controller_lease_hash),payloadSha256=String(row.payload_sha256),payloadBytes=Number(row.payload_bytes),state=String(row.state) as IdeOperationState,nextSequence=Number(row.next_sequence);
    const writerLeaseId=legacyWriterFields||row.writer_lease_id==null?null:String(row.writer_lease_id);
    const writerSettlement=legacyWriterFields||row.writer_settlement==null?null:String(row.writer_settlement) as IdeOperationWriterSettlement;
    const mutationStartedAt=legacyWriterFields||row.mutation_started_at==null?null:String(row.mutation_started_at);
    const writerSettledAt=legacyWriterFields||row.writer_settled_at==null?null:String(row.writer_settled_at);
    const safeTerminalIntent=legacyWriterFields||row.safe_terminal_intent==null?null:String(row.safe_terminal_intent) as IdeImplementationSafeTerminalIntent;
    const safeTerminalIntentAt=legacyWriterFields||row.safe_terminal_intent_at==null?null:String(row.safe_terminal_intent_at);
    assertIdeOperationId(operationId);assertIdeEnrollmentId(enrollmentId);assertIdeSessionId(sessionId);assertIdeConnectionGeneration(connectionGeneration);
    assertIdePrincipalId(principalId);assertIdeLogicalId(projectId,'projectId');assertIdeLogicalId(worktreeId,'worktreeId');assertIdeWorkspaceFingerprint(workspaceFingerprint);assertBaseRevision(baseRevision);assertIdeProduct(ideProduct);assertIdeInstanceId(ideInstanceId);assertIdeCapability(capability);
    if(!RUNTIME_INSTANCE_PATTERN.test(runtimeInstanceId)||!ADAPTER_ID_PATTERN.test(adapterId)||!ADAPTER_VERSION_PATTERN.test(adapterVersion))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation runtime attribution is invalid');
    if(!SHA256_PATTERN.test(controllerLeaseHash)||!SHA256_PATTERN.test(payloadSha256))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation digest field is invalid');
    if(!Number.isSafeInteger(payloadBytes)||payloadBytes<1||payloadBytes>IDE_COMPANION_OPERATION_MAX_AUTHENTICATED_PAYLOAD_BYTES)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation payload size is invalid');
    if(!(IDE_OPERATION_STATES as readonly string[]).includes(state)||state==='PENDING')throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation state is invalid');
    if(!Number.isSafeInteger(nextSequence)||nextSequence<1||nextSequence>IDE_MAX_OPERATION_EVENTS)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation sequence is invalid');
    const finishedAt=row.finished_at==null?null:String(row.finished_at),cancellationRequestedAt=row.cancellation_requested_at==null?null:String(row.cancellation_requested_at);
    const terminal=TERMINAL_OPERATION_STATES.includes(state);
    if(terminal!==(finishedAt!==null))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation terminal fields are inconsistent');
    if(state==='CANCELLING'&&cancellationRequestedAt===null)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation cancellation fields are inconsistent');
    if(!legacyWriterFields){
      if(capability==='request_review'){
        if(writerLeaseId!==null||writerSettlement!==null||mutationStartedAt!==null||writerSettledAt!==null||safeTerminalIntent!==null||safeTerminalIntentAt!==null) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','review operation unexpectedly carries writer provenance');
      }else if(capability==='request_implementation'){
        if(writerLeaseId===null||!LIVE_WRITER_LEASE_ID_PATTERN.test(writerLeaseId)||writerSettlement===null||!['HELD','RELEASED','UNCERTAIN'].includes(writerSettlement)) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','implementation operation writer provenance is incomplete');
        if(writerSettlement==='HELD'&&writerSettledAt!==null) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','held implementation writer has settlement timestamp');
        if((safeTerminalIntent===null)!==(safeTerminalIntentAt===null)) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','implementation safe-terminal intent fields are inconsistent');
        if(safeTerminalIntent!==null&&!['COMPLETED','FAILED','CANCELLED'].includes(safeTerminalIntent)) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','implementation safe-terminal intent is invalid');
        if(writerSettlement!=='HELD'&&writerSettledAt===null) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','settled implementation writer lacks settlement timestamp');
        if(ACTIVE_OPERATION_STATES.includes(state)&&writerSettlement!=='HELD') throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','active implementation operation does not hold writer authority');
        if(writerSettlement!=='HELD'&&!TERMINAL_OPERATION_STATES.includes(state)) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','nonterminal implementation operation has settled writer authority');
        const safeTerminal=state==='COMPLETED'||state==='FAILED'||state==='CANCELLED';
        const unsafeTerminal=state==='DISCONNECTED'||state==='INDETERMINATE';
        if(safeTerminal&&(writerSettlement!=='RELEASED'||safeTerminalIntent!==state)) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','safe implementation terminal lacks matching RELEASED writer proof');
        if(safeTerminal&&writerSettledAt===null) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','safe implementation terminal lacks writer settlement timestamp');
        if(unsafeTerminal&&writerSettlement==='RELEASED'&&safeTerminalIntent===null) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','unsafe implementation terminal has RELEASED writer without prior safe intent');
        if(unsafeTerminal&&writerSettlement==='UNCERTAIN'&&writerSettledAt===null) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','unsafe implementation terminal lacks uncertainty timestamp');
        if(unsafeTerminal&&writerSettlement==='HELD'&&writerSettledAt!==null) throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','unreconciled unsafe implementation terminal has settlement timestamp');
      }else if(writerLeaseId!==null||writerSettlement!==null||mutationStartedAt!==null||writerSettledAt!==null||safeTerminalIntent!==null||safeTerminalIntentAt!==null){
        throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','non-implementation operation unexpectedly carries writer provenance');
      }
    }
    return{operationId,enrollmentId,sessionId,connectionGeneration,principalId,projectId,worktreeId,workspaceFingerprint,baseRevision,ideProduct,ideInstanceId,runtimeInstanceId,adapterId,adapterVersion,capability,controllerLeaseHash,payloadSha256,payloadBytes,writerLeaseId,writerSettlement,mutationStartedAt,writerSettledAt,safeTerminalIntent,safeTerminalIntentAt,state,nextSequence,startedAt:String(row.started_at),updatedAt:String(row.updated_at),finishedAt,cancellationRequestedAt};
  }

  private rowToOperationAudit(row: Record<string, unknown>): IdeOperationAuditRow {
    const operationId=String(row.operation_id),sequence=Number(row.sequence),eventType=String(row.event_type) as IdeOperationEvent['type'],messageSha256=row.message_sha256==null?null:String(row.message_sha256),messageBytes=Number(row.message_bytes);
    assertIdeOperationId(operationId);
    if(!Number.isSafeInteger(sequence)||sequence<0||sequence>=IDE_MAX_OPERATION_EVENTS)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation audit sequence is invalid');
    if(!['operation_started','assistant_chunk','tool_activity','status','completed','cancelled','failed','disconnected','indeterminate'].includes(eventType))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation audit type is invalid');
    if(messageSha256!==null&&!SHA256_PATTERN.test(messageSha256))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation audit message digest is invalid');
    if(!Number.isSafeInteger(messageBytes)||messageBytes<0||messageBytes>8*1024)throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation audit message size is invalid');
    if((messageSha256===null)!==(messageBytes===0))throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA','IDE operation audit message metadata is inconsistent');
    return{operationId,sequence,eventType,messageSha256,messageBytes,createdAt:String(row.created_at)};
  }

}
