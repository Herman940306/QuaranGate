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
  hashIdeCompanionNonce,
  hashIdeCompanionPayload,
  parseIdeCompanionAuthFrame,
  signIdeCompanionEnvelope,
  verifyIdeCompanionEnvelope,
} from '../../src/shared/ideCompanionAuth.js';
import {
  IDE_MAX_ACTIVE_AUTH_REPLAYS,
  IDE_REGISTRY_SCHEMA_VERSION,
  IdeRegistryStoreError,
  IdeSessionStore,
  type IdeAuthReplayClaim,
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

function companionRequest(
  e: ReturnType<IdeSessionStore['createEnrollment']>,
  s: ReturnType<IdeSessionStore['openSession']>,
  lease: string,
  over: Partial<IdeAuthReplayClaim> = {},
): IdeAuthReplayClaim {
  const nowMs = 1_800_000_000_000;
  return {
    enrollmentId: e.enrollmentId,
    ideInstanceId: e.ideInstanceId,
    sessionId: s.sessionId,
    connectionGeneration: s.connectionGeneration,
    controllerLeaseId: lease,
    operationId: `ideo_${'5'.repeat(32)}`,
    capability: 'request_review',
    nonceHash: '6'.repeat(64),
    nowMs,
    expiresAtMs: nowMs + 20_000,
    ...over,
  };
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'qg-ide-registry-')), 'ide.db');
  store = new IdeSessionStore(dbPath);
});

describe('P7 B2 IDE registry schema and privacy', () => {
  it('creates the current dedicated schema with private SQLite files', () => {
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
    const after = new DatabaseSync(dbPath); expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(IDE_REGISTRY_SCHEMA_VERSION + 1); after.close();
  });

  it('fails closed on a falsely stamped current DB and does not repair it', () => {
    store.close(); const db = new DatabaseSync(dbPath); db.exec(`DROP TABLE ide_sessions; PRAGMA user_version=${IDE_REGISTRY_SCHEMA_VERSION}`); db.close();
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


  it('B6 opens a challenged session only when the enrollment generation is still exact', () => {
    const e=store.createEnrollment(enrollment());
    const s=store.openSessionIfCurrent({...keyFor(e),sessionId:`ides_${'7'.repeat(32)}`},0);
    expect(s.connectionGeneration).toBe(1);
    expect(store.getEnrollment(e.enrollmentId)?.currentGeneration).toBe(1);
  });

  it('B6 stale challenge CAS cannot stale or replace a newer authenticated generation', () => {
    const e=store.createEnrollment(enrollment());
    const winner=store.openSessionIfCurrent({...keyFor(e),sessionId:`ides_${'7'.repeat(32)}`},0);
    expect(winner.connectionGeneration).toBe(1);
    expect(errorCode(()=>store.openSessionIfCurrent({...keyFor(e),sessionId:`ides_${'8'.repeat(32)}`},0))).toBe('IDE_SESSION_BINDING_MISMATCH');
    expect(store.getEnrollment(e.enrollmentId)?.currentGeneration).toBe(1);
    expect(store.getSession(winner.sessionId)?.state).toBe('CONNECTED');
    expect(store.getSession(`ides_${'8'.repeat(32)}`)).toBeUndefined();
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


describe('P7 B3 durable authenticated replay foundation', () => {
  function controlled() {
    const e=store.createEnrollment(enrollment());
    const s=open(e); const k=sessionKey(s,e); store.markAvailable(k); const lease=store.acquireController(k);
    return { e, s, k, lease };
  }

  it('migrates exact B2 v1 state through current schema additively and preserves enrollment/session/controller state', () => {
    const {e,s,lease}=controlled(); store.close();
    const db=new DatabaseSync(dbPath); db.exec('DROP TABLE ide_operation_events; DROP TABLE ide_operations; DROP TABLE ide_auth_replays; PRAGMA user_version=1'); db.close();
    const reopened=new IdeSessionStore(dbPath);
    expect(reopened.schemaVersion).toBe(IDE_REGISTRY_SCHEMA_VERSION);
    expect(reopened.getEnrollment(e.enrollmentId)?.ideInstanceId).toBe(e.ideInstanceId);
    expect(reopened.getSession(s.sessionId)).toMatchObject({connectionGeneration:1,controllerLeaseId:lease,state:'CONTROLLER_ACQUIRED'});
    const check=new DatabaseSync(dbPath); expect(check.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ide_auth_replays'`).get()).toBeDefined(); check.close();
    reopened.close();
  });

  it('refuses malformed v1 before replay migration and leaves the v1 stamp/table absence untouched', () => {
    store.close(); const db=new DatabaseSync(dbPath);
    db.exec('DROP TABLE ide_operation_events; DROP TABLE ide_operations; DROP TABLE ide_auth_replays; DROP TABLE ide_sessions; PRAGMA user_version=1'); db.close();
    expect(errorCode(() => new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
    const after=new DatabaseSync(dbPath);
    expect((after.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(1);
    expect(after.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ide_auth_replays'`).get()).toBeUndefined();
    after.close();
  });

  it('refuses partial v2 replay state under a v1 stamp instead of silently repairing it', () => {
    store.close(); const db=new DatabaseSync(dbPath); db.exec('PRAGMA user_version=1'); db.close();
    expect(errorCode(() => new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
    const after=new DatabaseSync(dbPath); expect((after.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(1); after.close();
  });

  it('persists nonce replay denial across store reopen for the authenticated validity window', () => {
    const {e,s,lease}=controlled(); const claim=companionRequest(e,s,lease); store.claimAuthReplay(claim); store.close();
    const reopened=new IdeSessionStore(dbPath);
    expect(errorCode(() => reopened.claimAuthReplay(claim))).toBe('IDE_AUTH_REPLAY');
    reopened.close();
  });

  it('binds replay claims to exact enrollment/instance/session/generation/controller/capability', () => {
    const {e,s,lease}=controlled(); const claim=companionRequest(e,s,lease);
    expect(errorCode(() => store.claimAuthReplay({...claim,ideInstanceId:`ide_${'9'.repeat(32)}`}))).toBe('IDE_ENROLLMENT_BINDING_MISMATCH');
    expect(errorCode(() => store.claimAuthReplay({...claim,connectionGeneration:claim.connectionGeneration+1}))).toBe('IDE_SESSION_BINDING_MISMATCH');
    expect(errorCode(() => store.claimAuthReplay({...claim,controllerLeaseId:`idectl_${'9'.repeat(32)}`}))).toBe('IDE_CONTROLLER_LEASE_MISMATCH');
    expect(errorCode(() => store.claimAuthReplay({...claim,capability:'request_implementation'}))).toBe('IDE_REGISTRY_POLICY_DENIED');
    expect(() => store.claimAuthReplay(claim)).not.toThrow();
  });

  it('derives companion authority from trusted enrollment rather than caller project/worktree fields', () => {
    const {e,s,lease}=controlled(); const req=companionRequest(e,s,lease);
    expect(() => store.assertCompanionAuthority(req)).not.toThrow();
    expect(errorCode(() => store.assertCompanionAuthority({...req,ideInstanceId:`ide_${'9'.repeat(32)}`}))).toBe('IDE_ENROLLMENT_BINDING_MISMATCH');
    expect(errorCode(() => store.assertCompanionAuthority({...req,capability:'request_implementation'}))).toBe('IDE_REGISTRY_POLICY_DENIED');
    store.markOperationActive(sessionKey(s,e),lease);
    expect(() => store.assertCompanionAuthority({...req,capability:'cancel'})).not.toThrow();
  });

  it('prunes expired replay rows before claiming and permits safe nonce reuse only after old validity ended', () => {
    const {e,s,lease}=controlled(); const first=companionRequest(e,s,lease,{expiresAtMs:1_800_000_001_000});
    store.claimAuthReplay(first);
    const later=companionRequest(e,s,lease,{nowMs:1_800_000_002_000,expiresAtMs:1_800_000_010_000,operationId:`ideo_${'7'.repeat(32)}`});
    expect(() => store.claimAuthReplay(later)).not.toThrow();
  });

  it('rejects replay expiry outside the authenticated B3 time envelope before persistence', () => {
    const {e,s,lease}=controlled(); const base=companionRequest(e,s,lease);
    expect(errorCode(() => store.claimAuthReplay({...base,expiresAtMs:base.nowMs}))).toBe('IDE_REGISTRY_POLICY_DENIED');
    expect(errorCode(() => store.claimAuthReplay({...base,expiresAtMs:base.nowMs+40_000}))).toBe('IDE_REGISTRY_POLICY_DENIED');
  });

  it('fails closed specifically when replay nonce primary-key authority is removed', () => {
    store.close(); const db=new DatabaseSync(dbPath);
    db.exec(`ALTER TABLE ide_auth_replays RENAME TO bad_replays;
      CREATE TABLE ide_auth_replays (
        nonce_hash TEXT NOT NULL, enrollment_id TEXT NOT NULL, session_id TEXT NOT NULL,
        connection_generation INTEGER NOT NULL, controller_lease_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, capability TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, claimed_at TEXT NOT NULL
      );
      DROP TABLE bad_replays;
      CREATE INDEX idx_ide_auth_replays_expiry
        ON ide_auth_replays(enrollment_id, connection_generation, expires_at_ms);`);
    db.close();
    let message='';
    try { new IdeSessionStore(dbPath); } catch (error) {
      if (error instanceof IdeRegistryStoreError) message=error.message;
    }
    expect(message).toContain('ide_auth_replays primary key is incompatible');
  });


  it('flows signed request through parse/MAC/payload verification, durable replay claim and trusted B1/B2 authority', () => {
    const {e,s,lease}=controlled();
    const body=Buffer.from('review this bounded request','utf8');
    const issuedAtMs=1_800_000_000_000;
    const nonce='C'.repeat(43);
    const signed=signIdeCompanionEnvelope(Buffer.alloc(32,0x73),{
      version:1,
      enrollmentId:e.enrollmentId,
      ideInstanceId:e.ideInstanceId,
      sessionId:s.sessionId,
      connectionGeneration:s.connectionGeneration,
      controllerLeaseId:lease,
      operationId:`ideo_${'8'.repeat(32)}`,
      capability:'request_review',
      nonce,
      issuedAtMs,
      expiresAtMs:issuedAtMs+20_000,
      payloadSha256:hashIdeCompanionPayload(body),
    });
    const parsed=parseIdeCompanionAuthFrame(JSON.stringify(signed));
    const verified=verifyIdeCompanionEnvelope({envelope:parsed,secret:Buffer.alloc(32,0x73),payload:body,nowMs:issuedAtMs+1_000});
    const claim={
      enrollmentId:verified.enrollmentId, ideInstanceId:verified.ideInstanceId,
      sessionId:verified.sessionId, connectionGeneration:verified.connectionGeneration,
      controllerLeaseId:verified.controllerLeaseId, operationId:verified.operationId,
      capability:verified.capability, nonceHash:hashIdeCompanionNonce(verified.nonce),
      nowMs:issuedAtMs+1_000, expiresAtMs:verified.expiresAtMs,
    } as const;
    expect(() => store.claimAuthReplay(claim)).not.toThrow();
    expect(() => store.assertCompanionAuthority(verified)).not.toThrow();
    expect(errorCode(() => store.claimAuthReplay(claim))).toBe('IDE_AUTH_REPLAY');
  });

  it('fails closed at the durable per-generation replay-capacity bound without evicting live entries', () => {
    const {e,s,lease}=controlled(); const base=companionRequest(e,s,lease,{nonceHash:'f'.repeat(64)});
    store.close();
    const db=new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const insert=db.prepare(`INSERT INTO ide_auth_replays
      (nonce_hash,enrollment_id,session_id,connection_generation,controller_lease_id,operation_id,capability,expires_at_ms,claimed_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for(let i=0;i<IDE_MAX_ACTIVE_AUTH_REPLAYS;i+=1){
      insert.run(i.toString(16).padStart(64,'0'),e.enrollmentId,s.sessionId,s.connectionGeneration,lease,
        `ideo_${(i%16).toString(16).repeat(32)}`,'request_review',base.expiresAtMs,'2026-09-14T00:00:00.000Z');
    }
    db.exec('COMMIT'); db.close();
    const reopened=new IdeSessionStore(dbPath);
    expect(errorCode(() => reopened.claimAuthReplay(base))).toBe('IDE_AUTH_REPLAY_CAPACITY');
    const check=new DatabaseSync(dbPath);
    expect((check.prepare('SELECT COUNT(*) AS n FROM ide_auth_replays').get() as {n:number}).n).toBe(IDE_MAX_ACTIVE_AUTH_REPLAYS);
    check.close(); reopened.close();
  });
});

describe('P7 B7 durable non-mutating operation lifecycle and audit', () => {
  function controlled() {
    const e=store.createEnrollment(enrollment());
    const s=open(e); const k=sessionKey(s,e); store.markAvailable(k); const lease=store.acquireController(k);
    return {e,s,k,lease};
  }
  function start(over: Partial<Parameters<IdeSessionStore['startOperation']>[0]> = {}) {
    const ctx=controlled();
    const payload='review bounded source';
    const input={
      enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,
      connectionGeneration:ctx.s.connectionGeneration,controllerLeaseId:ctx.lease,
      operationId:`ideo_${'a'.repeat(32)}`,capability:'request_review' as const,
      runtimeInstanceId:`iderun_${'b'.repeat(32)}`,adapterId:'quarangate-vscode-companion',adapterVersion:'1.2.3',
      payloadSha256:hashIdeCompanionPayload(payload),payloadBytes:Buffer.byteLength(payload),...over,
    };
    const op=store.startOperation(input);
    return {...ctx,input,op,payload};
  }

  it('migrates an exact v2 registry to v3 additively and preserves current controller state', () => {
    const ctx=controlled(); store.close();
    const db=new DatabaseSync(dbPath);
    db.exec('DROP TABLE ide_operation_events; DROP TABLE ide_operations; PRAGMA user_version=2'); db.close();
    const reopened=new IdeSessionStore(dbPath);
    expect(reopened.schemaVersion).toBe(IDE_REGISTRY_SCHEMA_VERSION);
    expect(reopened.getSession(ctx.s.sessionId)).toMatchObject({state:'CONTROLLER_ACQUIRED',controllerLeaseId:ctx.lease});
    const check=new DatabaseSync(dbPath);
    expect(check.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ide_operations'`).get()).toBeDefined();
    expect(check.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ide_operation_events'`).get()).toBeDefined();
    check.close(); reopened.close();
  });

  it('refuses partial v3 operation state under a v2 stamp instead of silently repairing it', () => {
    store.close(); const db=new DatabaseSync(dbPath); db.exec('PRAGMA user_version=2'); db.close();
    expect(errorCode(()=>new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
    const check=new DatabaseSync(dbPath); expect((check.prepare('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2); check.close();
  });

  it('atomically starts one review operation, session and metadata-only audit at sequence zero', () => {
    const ctx=start();
    expect(ctx.op).toMatchObject({state:'RUNNING',nextSequence:1,principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',capability:'request_review'});
    expect(ctx.op.controllerLeaseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.op.controllerLeaseHash).not.toBe(ctx.lease);
    expect(store.getSession(ctx.s.sessionId)?.state).toBe('OPERATION_ACTIVE');
    expect(store.getOperationAudit(ctx.op.operationId)).toEqual([expect.objectContaining({sequence:0,eventType:'operation_started',messageSha256:null,messageBytes:0})]);
  });

  it('denies request_implementation at operation start even if an internal caller tries to construct it', () => {
    const ctx=controlled(); const payload='write';
    expect(errorCode(()=>store.startOperation({
      enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,connectionGeneration:ctx.s.connectionGeneration,
      controllerLeaseId:ctx.lease,operationId:`ideo_${'c'.repeat(32)}`,capability:'request_implementation',
      runtimeInstanceId:`iderun_${'d'.repeat(32)}`,adapterId:'quarangate-vscode-companion',adapterVersion:'1.2.3',
      payloadSha256:hashIdeCompanionPayload(payload),payloadBytes:payload.length,
    }))).toBe('IDE_REGISTRY_POLICY_DENIED');
    expect(store.getSession(ctx.s.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
  });

  it('persists only event body digest/size, enforces exact sequence, and settles completion atomically', () => {
    const ctx=start();
    const first={version:1 as const,operationId:ctx.op.operationId,sessionId:ctx.s.sessionId,connectionGeneration:1,origin:'machine' as const,sequence:1,type:'assistant_chunk' as const,message:'sensitive-response-fragment'};
    store.appendOperationEvent(first,ctx.lease);
    expect(errorCode(()=>store.appendOperationEvent({...first,sequence:3},ctx.lease))).toBe('IDE_OPERATION_STATE_MISMATCH');
    store.appendOperationEvent({...first,sequence:2,type:'status',message:'bounded-status'},ctx.lease);
    store.appendOperationEvent({...first,sequence:3,type:'completed',message:undefined},ctx.lease);
    expect(store.getOperation(ctx.op.operationId)).toMatchObject({state:'COMPLETED',nextSequence:4});
    expect(store.getSession(ctx.s.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
    const audit=store.getOperationAudit(ctx.op.operationId);
    expect(audit[1]).toMatchObject({sequence:1,eventType:'assistant_chunk',messageSha256:hashIdeCompanionPayload('sensitive-response-fragment'),messageBytes:27});
    const check=new DatabaseSync(dbPath);
    const opColumns=(check.prepare('PRAGMA table_info(ide_operations)').all() as Array<{name:string}>).map(r=>r.name);
    const eventColumns=(check.prepare('PRAGMA table_info(ide_operation_events)').all() as Array<{name:string}>).map(r=>r.name);
    expect(opColumns).not.toContain('prompt'); expect(opColumns).not.toContain('response');
    expect(eventColumns).not.toContain('message'); expect(eventColumns).toContain('message_sha256');
    check.close();
  });

  it('uses operation IDs once forever and does not resurrect a completed operation', () => {
    const ctx=start();
    store.appendOperationEvent({version:1,operationId:ctx.op.operationId,sessionId:ctx.s.sessionId,connectionGeneration:1,origin:'machine',sequence:1,type:'completed'},ctx.lease);
    expect(errorCode(()=>store.startOperation(ctx.input))).toBe('IDE_OPERATION_ID_REUSED');
    expect(store.getOperation(ctx.op.operationId)?.state).toBe('COMPLETED');
  });

  it('binds cancellation to exact current operation/session/generation/controller and terminalizes CANCELLED', () => {
    const ctx=start();
    const cancel={enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,connectionGeneration:1,controllerLeaseId:ctx.lease,operationId:ctx.op.operationId,capability:'cancel' as const};
    expect(store.requestOperationCancellation(cancel).state).toBe('CANCELLING');
    expect(store.requestOperationCancellation(cancel).state).toBe('CANCELLING');
    expect(errorCode(()=>store.requestOperationCancellation({...cancel,operationId:`ideo_${'e'.repeat(32)}`}))).toBe('IDE_OPERATION_NOT_FOUND');
    store.appendOperationEvent({version:1,operationId:ctx.op.operationId,sessionId:ctx.s.sessionId,connectionGeneration:1,origin:'machine',sequence:1,type:'cancelled'},ctx.lease);
    expect(store.getOperation(ctx.op.operationId)?.state).toBe('CANCELLED');
    expect(store.getSession(ctx.s.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
  });

  it('disconnect durably terminalizes an active operation as DISCONNECTED before clearing controller state', () => {
    const ctx=start();
    expect(store.disconnect(ctx.k)).toBe(true);
    expect(store.getOperation(ctx.op.operationId)?.state).toBe('DISCONNECTED');
    expect(store.getOperationAudit(ctx.op.operationId).at(-1)).toMatchObject({eventType:'disconnected',sequence:1});
    expect(store.getSession(ctx.s.sessionId)).toMatchObject({state:'DISCONNECTED',controllerLeaseId:null});
  });

  it('restart recovery marks active operations INDETERMINATE and sessions STALE without false completion', () => {
    const ctx=start();
    const result=store.recoverAfterRestart();
    expect(result.indeterminateOperationIds).toEqual([ctx.op.operationId]);
    expect(result.staledSessionIds).toEqual([ctx.s.sessionId]);
    expect(store.getOperation(ctx.op.operationId)?.state).toBe('INDETERMINATE');
    expect(store.getOperationAudit(ctx.op.operationId).at(-1)?.eventType).toBe('indeterminate');
    expect(store.getSession(ctx.s.sessionId)?.state).toBe('STALE');
  });

  it('authenticated reconnect stales the old generation and records its in-flight operation DISCONNECTED', () => {
    const ctx=start(); const current=store.getEnrollment(ctx.e.enrollmentId)!;
    const next=store.openSession({...keyFor(current),sessionId:`ides_${'f'.repeat(32)}`});
    expect(next.connectionGeneration).toBe(2);
    expect(store.getOperation(ctx.op.operationId)?.state).toBe('DISCONNECTED');
    expect(store.getSession(ctx.s.sessionId)?.state).toBe('STALE');
    expect(store.getOperationAudit(ctx.op.operationId).at(-1)?.eventType).toBe('disconnected');
  });

  it('fails closed on a falsely stamped current schema missing durable operation audit', () => {
    store.close(); const db=new DatabaseSync(dbPath); db.exec(`DROP TABLE ide_operation_events; PRAGMA user_version=${IDE_REGISTRY_SCHEMA_VERSION}`); db.close();
    expect(errorCode(()=>new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
  });
});

describe('P7 B7 durable operation coherence on reopen',()=>{
  function activeOperation(){
    const e=store.createEnrollment(enrollment()); const s=open(e); const k=sessionKey(s,e); store.markAvailable(k); const lease=store.acquireController(k);
    const payload='coherence-review';
    const op=store.startOperation({enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,
      controllerLeaseId:lease,operationId:`ideo_${'d'.repeat(32)}`,capability:'request_review',runtimeInstanceId:`iderun_${'e'.repeat(32)}`,
      adapterId:'quarangate-vscode-companion',adapterVersion:'1.2.3',payloadSha256:hashIdeCompanionPayload(payload),payloadBytes:payload.length});
    return{e,s,k,lease,op};
  }

  it('rejects an active operation whose session is no longer OPERATION_ACTIVE',()=>{
    const ctx=activeOperation(); store.close(); const db=new DatabaseSync(dbPath); db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare(`UPDATE ide_sessions SET state='CONTROLLER_ACQUIRED' WHERE session_id=?`).run(ctx.s.sessionId); db.close();
    expect(errorCode(()=>new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
  });

  it('rejects terminal state/event disagreement instead of trusting a forged success row',()=>{
    const ctx=activeOperation(); store.close(); const db=new DatabaseSync(dbPath);
    db.prepare(`UPDATE ide_operations SET state='COMPLETED',finished_at='2026-09-14T00:00:00.000Z' WHERE operation_id=?`).run(ctx.op.operationId); db.close();
    expect(errorCode(()=>new IdeSessionStore(dbPath))).toBe('IDE_REGISTRY_SCHEMA');
  });
});
