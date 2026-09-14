import { describe, expect, it, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  IDE_CONTROLLER_LEASE_ID_PATTERN,
  IDE_ENROLLMENT_ID_PATTERN,
  IdeSessionContractError,
  type IdeCapability,
  type IdeSessionAuthorityRequest,
} from '../../src/shared/ideSessions.js';
import {
  IDE_REGISTRY_SCHEMA_VERSION,
  IdeRegistryStoreError,
  IdeSessionStore,
  type IdeEnrollmentKey,
  type IdeSessionRegistryKey,
  type NewIdeEnrollment,
} from '../../src/executor/ide/ideSessionStore.js';

let dbPath: string;
let store: IdeSessionStore;

const enrollment = (over: Partial<NewIdeEnrollment> = {}): NewIdeEnrollment => ({
  principalId: 'chatgpt-browser', projectId: 'quarangate', worktreeId: 'forward', ideProduct: 'vscode',
  ideInstanceId: `ide_${'1'.repeat(32)}`, workspaceFingerprint: 'a'.repeat(64), baseRevision: 'b'.repeat(40),
  capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'], ...over,
});

function errorCode(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; } catch (error) {
    if (error instanceof IdeRegistryStoreError || error instanceof IdeSessionContractError) return error.code;
    return 'OTHER_ERROR';
  }
}

function keyFor(row: ReturnType<IdeSessionStore['createEnrollment']>): IdeEnrollmentKey {
  return { enrollmentId: row.enrollmentId, principalId: row.principalId, projectId: row.projectId,
    worktreeId: row.worktreeId, ideProduct: row.ideProduct, ideInstanceId: row.ideInstanceId,
    workspaceFingerprint: row.workspaceFingerprint, baseRevision: row.baseRevision };
}

function sessionKey(row: ReturnType<IdeSessionStore['openSession']>, e: ReturnType<IdeSessionStore['createEnrollment']>): IdeSessionRegistryKey {
  return { principalId: e.principalId, projectId: e.projectId, worktreeId: e.worktreeId, ideProduct: e.ideProduct,
    ideInstanceId: e.ideInstanceId, workspaceFingerprint: e.workspaceFingerprint, baseRevision: e.baseRevision,
    sessionId: row.sessionId, connectionGeneration: row.connectionGeneration };
}

function open(e: ReturnType<IdeSessionStore['createEnrollment']>, sessionId = `ides_${'2'.repeat(32)}`) {
  return store.openSession({ ...keyFor(e), sessionId });
}
function mode(path: string): number { return statSync(path).mode & 0o777; }

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'qg-ide-registry-')), 'ide.db');
  store = new IdeSessionStore(dbPath);
});

describe('P7 B2 IDE registry schema and privacy', () => {
  it('creates a dedicated v1 schema with private SQLite files', () => {
    expect(store.schemaVersion).toBe(IDE_REGISTRY_SCHEMA_VERSION);
    const e = store.createEnrollment(enrollment()); open(e);
    expect(mode(dbPath)).toBe(0o600);
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(sidecar)) expect(mode(sidecar) & 0o077).toBe(0);
  });

  it('tightens a pre-existing registry DB without recreating durable records', () => {
    const e = store.createEnrollment(enrollment()); store.close(); chmodSync(dbPath, 0o644);
    const reopened = new IdeSessionStore(dbPath);
    expect(mode(dbPath)).toBe(0o600); expect(reopened.getEnrollment(e.enrollmentId)?.principalId).toBe('chatgpt-browser');
    reopened.close();
  });

  it('fails closed on a future schema version and never downgrades it', () => {
    store.close(); const db = new DatabaseSync(dbPath); db.exec(`PRAGMA user_version=${IDE_REGISTRY_SCHEMA_VERSION + 1}`); db.close();
    expect(errorCode(() => new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
    const after = new DatabaseSync(dbPath); expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2); after.close();
  });

  it('fails closed on a falsely stamped current DB and does not repair it', () => {
    store.close(); const db = new DatabaseSync(dbPath); db.exec('DROP TABLE ide_sessions; PRAGMA user_version=1'); db.close();
    expect(errorCode(() => new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
    const after = new DatabaseSync(dbPath); expect(after.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ide_sessions'`).get()).toBeUndefined(); after.close();
  });

  it('fails closed when a security-critical index keeps its name but weakens its predicate', () => {
    store.close(); const db = new DatabaseSync(dbPath);
    db.exec(`DROP INDEX idx_ide_sessions_one_live_enrollment;
      CREATE UNIQUE INDEX idx_ide_sessions_one_live_enrollment
      ON ide_sessions(enrollment_id) WHERE state='AVAILABLE';`);
    db.close();
    expect(errorCode(() => new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
    const after = new DatabaseSync(dbPath);
    const sql = (after.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_ide_sessions_one_live_enrollment'`).get() as { sql: string }).sql;
    expect(sql).toContain("WHERE state='AVAILABLE'");
    after.close();
  });

  it('refuses an unstamped non-empty database instead of adopting unknown state', () => {
    store.close(); const db = new DatabaseSync(dbPath);
    db.exec('DROP TABLE ide_sessions; DROP TABLE ide_enrollments; PRAGMA user_version=0; CREATE TABLE mystery(x TEXT)'); db.close();
    expect(errorCode(() => new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
  });
});

describe('P7 B2 trusted enrollment', () => {
  it('creates opaque enrollment identity and canonical least-authority capabilities', () => {
    const e = store.createEnrollment(enrollment({ capabilities: ['request_review', 'prompt', 'cancel'] }));
    expect(e.enrollmentId).toMatch(IDE_ENROLLMENT_ID_PATTERN); expect(e.capabilities).toEqual(['prompt', 'cancel', 'request_review']);
    expect(e.state).toBe('ACTIVE'); expect(e.currentGeneration).toBe(0);
  });

  it('allows bounded editor context only when explicitly enrolled', () => {
    expect(store.createEnrollment(enrollment({ capabilities: ['prompt', 'read_bounded_editor_context'] })).capabilities)
      .toEqual(['prompt', 'read_bounded_editor_context']);
  });

  it('refuses implementation enrollment and unknown/duplicate/empty capabilities', () => {
    expect(errorCode(() => store.createEnrollment(enrollment({ capabilities: ['request_implementation'] })))).toBe('IDE_REGISTRY_POLICY_DENIED');
    expect(errorCode(() => store.createEnrollment(enrollment({ capabilities: [] })))).toBe('IDE_REGISTRY_POLICY_DENIED');
    expect(errorCode(() => store.createEnrollment(enrollment({ capabilities: ['prompt', 'prompt'] })))).toBe('INVALID_IDE_IDENTITY');
    expect(errorCode(() => store.createEnrollment(enrollment({ capabilities: ['prompt', 'other' as IdeCapability] })))).toBe('IDE_CAPABILITY_DENIED');
  });

  it('enforces one ACTIVE enrollment per exact binding but permits a different worktree', () => {
    store.createEnrollment(enrollment()); expect(() => store.createEnrollment(enrollment())).toThrow();
    expect(() => store.createEnrollment(enrollment({ worktreeId: 'review' }))).not.toThrow();
  });

  it('revoke requires exact binding, stales live session, and prevents reconnect', () => {
    const e = store.createEnrollment(enrollment()); const s = open(e);
    expect(errorCode(() => store.revokeEnrollment({ ...keyFor(e), projectId: 'other' }))).toBe('IDE_ENROLLMENT_BINDING_MISMATCH');
    expect(store.revokeEnrollment(keyFor(e))).toBe(true); expect(store.getEnrollment(e.enrollmentId)?.state).toBe('REVOKED');
    expect(store.getSession(s.sessionId)?.state).toBe('STALE');
    expect(errorCode(() => open(e, `ides_${'3'.repeat(32)}`))).toBe('IDE_ENROLLMENT_NOT_ACTIVE');
  });
});

describe('P7 B2 generations and exact binding', () => {
  it('assigns generation 1 and atomically stales prior generation on reconnect', () => {
    const e = store.createEnrollment(enrollment()); const first = open(e); expect(first.connectionGeneration).toBe(1);
    const second = open(store.getEnrollment(e.enrollmentId)!, `ides_${'3'.repeat(32)}`);
    expect(second.connectionGeneration).toBe(2); expect(store.getSession(first.sessionId)?.state).toBe('STALE');
    expect(store.getEnrollment(e.enrollmentId)?.currentGeneration).toBe(2);
  });

  it('refuses reuse of a historical session ID', () => {
    const e = store.createEnrollment(enrollment()); const first = open(e);
    expect(errorCode(() => open(store.getEnrollment(e.enrollmentId)!, first.sessionId))).toBe('IDE_SESSION_ID_REUSED');
  });

  it('rejects cross-binding session open before generation changes', () => {
    const changes = [ { principalId: 'other' }, { projectId: 'other' }, { worktreeId: 'other' },
      { ideProduct: 'cursor' as const }, { ideInstanceId: `ide_${'9'.repeat(32)}` },
      { workspaceFingerprint: 'c'.repeat(64) }, { baseRevision: 'c'.repeat(40) } ];
    changes.forEach((changed, i) => {
      const hex=(i+2).toString(16); const e=store.createEnrollment(enrollment({ ideInstanceId:`ide_${hex.repeat(32)}` }));
      expect(errorCode(() => store.openSession({ ...keyFor(e), ...changed, sessionId:`ides_${hex.repeat(32)}` }))).toBe('IDE_ENROLLMENT_BINDING_MISMATCH');
      expect(store.getEnrollment(e.enrollmentId)?.currentGeneration).toBe(0);
    });
  });

  it('rejects stale/future generation keys for lifecycle mutations', () => {
    const e=store.createEnrollment(enrollment()); const s=open(e); const k=sessionKey(s,e);
    expect(errorCode(() => store.markAvailable({ ...k, connectionGeneration: 2 }))).toBe('IDE_SESSION_BINDING_MISMATCH');
    expect(store.markAvailable(k)).toBe(true); expect(errorCode(() => store.markAvailable(k))).toBe('IDE_SESSION_STATE_MISMATCH');
  });

  it('refuses a corrupted historical generation even when its row is made live-looking', () => {
    const e=store.createEnrollment(enrollment()); const first=open(e); const current1=store.getEnrollment(e.enrollmentId)!;
    const second=store.openSession({...keyFor(current1),sessionId:`ides_${'3'.repeat(32)}`}); const current2=store.getEnrollment(e.enrollmentId)!;
    expect(second.connectionGeneration).toBe(2); expect(store.disconnect(sessionKey(second,current2))).toBe(true); store.close();
    const db=new DatabaseSync(dbPath);
    db.prepare(`UPDATE ide_sessions SET state='AVAILABLE',controller_lease_id=NULL,ended_at=NULL WHERE session_id=?`).run(first.sessionId);
    db.close();
    const reopened=new IdeSessionStore(dbPath);
    expect(errorCode(() => reopened.acquireController(sessionKey(first,e)))).toBe('IDE_SESSION_BINDING_MISMATCH');
    expect(reopened.getEnrollment(e.enrollmentId)?.currentGeneration).toBe(2);
    reopened.close();
  });
});

describe('P7 B2 controller lease and authority', () => {
  it('admits exactly one controller lease and requires exact lease ownership', () => {
    const e=store.createEnrollment(enrollment()); const s=open(e); const k=sessionKey(s,e); store.markAvailable(k);
    const lease=store.acquireController(k); expect(lease).toMatch(IDE_CONTROLLER_LEASE_ID_PATTERN);
    expect(errorCode(() => store.acquireController(k))).toBe('IDE_SESSION_STATE_MISMATCH');
    expect(errorCode(() => store.releaseController(k,`idectl_${'f'.repeat(32)}`))).toBe('IDE_CONTROLLER_LEASE_MISMATCH');
    expect(store.releaseController(k,lease)).toBe(true); expect(store.getSession(s.sessionId)?.state).toBe('AVAILABLE');
  });

  it('enforces start-vs-active lifecycle and exact controller lease through B1 authority', () => {
    const e=store.createEnrollment(enrollment()); const s=open(e); const k=sessionKey(s,e); store.markAvailable(k); const lease=store.acquireController(k);
    const base:IdeSessionAuthorityRequest={...k,capability:'request_review'}; expect(() => store.assertAuthority(base,lease)).not.toThrow();
    expect(errorCode(() => store.assertAuthority(base,`idectl_${'f'.repeat(32)}`))).toBe('IDE_CONTROLLER_LEASE_MISMATCH');
    expect(store.markOperationActive(k,lease)).toBe(true); expect(errorCode(() => store.assertAuthority(base,lease))).toBe('IDE_SESSION_STATE_DENIED');
    expect(() => store.assertAuthority({...base,capability:'cancel'},lease)).not.toThrow(); expect(store.markOperationSettled(k,lease)).toBe(true);
  });

  it('cannot independently authorize implementation', () => {
    const e=store.createEnrollment(enrollment()); const s=open(e); const k=sessionKey(s,e); store.markAvailable(k); const lease=store.acquireController(k);
    expect(errorCode(() => store.assertAuthority({...k,capability:'request_implementation'},lease))).toBe('IDE_CAPABILITY_DENIED');
  });

  it('disconnect clears controller authority and is terminal for that generation', () => {
    const e=store.createEnrollment(enrollment()); const s=open(e); const k=sessionKey(s,e); store.markAvailable(k); const lease=store.acquireController(k); store.markOperationActive(k,lease);
    expect(store.disconnect(k)).toBe(true); expect(store.getSession(s.sessionId)).toMatchObject({state:'DISCONNECTED',controllerLeaseId:null});
    expect(errorCode(() => store.assertAuthority({...k,capability:'cancel'},lease))).toBe('IDE_CONTROLLER_LEASE_MISMATCH');
    expect(errorCode(() => store.markAvailable(k))).toBe('IDE_SESSION_STATE_MISMATCH');
  });
});

describe('P7 B2 restart recovery', () => {
  it('stales every live generation and clears controller leases after restart reconciliation', () => {
    const e=store.createEnrollment(enrollment()); const s=open(e); const k=sessionKey(s,e); store.markAvailable(k); const lease=store.acquireController(k); store.markOperationActive(k,lease);
    expect(store.recoverAfterRestart().staledSessionIds).toEqual([s.sessionId]);
    expect(store.getSession(s.sessionId)).toMatchObject({state:'STALE',controllerLeaseId:null});
    expect(errorCode(() => store.assertAuthority({...k,capability:'cancel'},lease))).toBe('IDE_CONTROLLER_LEASE_MISMATCH');
  });

  it('preserves history across reopen and advances generation only on explicit reconnect', () => {
    const e=store.createEnrollment(enrollment()); const first=open(e); const k=sessionKey(first,e); store.markAvailable(k); store.close();
    const reopened=new IdeSessionStore(dbPath); expect(reopened.getSession(first.sessionId)?.state).toBe('AVAILABLE');
    expect(reopened.recoverAfterRestart().staledSessionIds).toEqual([first.sessionId]); const live=reopened.getEnrollment(e.enrollmentId)!;
    const second=reopened.openSession({...keyFor(live),sessionId:`ides_${'4'.repeat(32)}`}); expect(second.connectionGeneration).toBe(2);
    expect(reopened.getSession(first.sessionId)?.state).toBe('STALE'); reopened.close();
  });

  it('detects corrupted durable row lifecycle state rather than fabricating authority', () => {
    const e=store.createEnrollment(enrollment()); const s=open(e); store.close();
    const db=new DatabaseSync(dbPath); db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare(`UPDATE ide_sessions SET state='CONTROLLER_ACQUIRED',controller_lease_id=NULL WHERE session_id=?`).run(s.sessionId); db.close();
    const reopened=new IdeSessionStore(dbPath); expect(errorCode(() => reopened.getSession(s.sessionId))).toBe('IDE_REGISTRY_SCHEMA'); reopened.close();
  });
});
