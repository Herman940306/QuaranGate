import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { admitIdeCompanionRequest } from '../../src/executor/ide/ideCompanionAdmission.js';
import { IdeRegistryStoreError, IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';
import {
  IdeCompanionAuthError,
  hashIdeCompanionPayload,
  signIdeCompanionEnvelope,
  type IdeCompanionAuthEnvelope,
} from '../../src/shared/ideCompanionAuth.js';
import { IdeSessionContractError } from '../../src/shared/ideSessions.js';

const secret=Buffer.alloc(32,0x71);
const payload=Buffer.from('bounded review payload','utf8');
const nowMs=1_800_000_000_000;
let store:IdeSessionStore;

function errorCode(fn:()=>unknown):string {
  try{fn();return 'NO_ERROR';}catch(error){
    if(error instanceof IdeCompanionAuthError||error instanceof IdeRegistryStoreError||error instanceof IdeSessionContractError)return error.code;
    return 'OTHER_ERROR';
  }
}

function setup() {
  const e=store.createEnrollment({
    principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',ideProduct:'vscode',
    ideInstanceId:`ide_${'1'.repeat(32)}`,workspaceFingerprint:'a'.repeat(64),baseRevision:'b'.repeat(40),
    capabilities:['prompt','cancel','observe_response','request_review'],
  });
  const s=store.openSession({
    enrollmentId:e.enrollmentId,principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,
    ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,
    baseRevision:e.baseRevision,sessionId:`ides_${'2'.repeat(32)}`,
  });
  const key={
    principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,
    ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,baseRevision:e.baseRevision,
    sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,
  } as const;
  store.markAvailable(key); const lease=store.acquireController(key);
  return {e,s,key,lease};
}

function frame(ctx:ReturnType<typeof setup>, capability:'request_review'|'prompt'|'cancel'='request_review', over:Partial<IdeCompanionAuthEnvelope>={}):IdeCompanionAuthEnvelope {
  const base=signIdeCompanionEnvelope(secret,{
    version:1,enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,
    connectionGeneration:ctx.s.connectionGeneration,controllerLeaseId:ctx.lease,
    operationId:`ideo_${'3'.repeat(32)}`,capability,nonce:'D'.repeat(43),issuedAtMs:nowMs-1_000,
    expiresAtMs:nowMs+20_000,payloadSha256:hashIdeCompanionPayload(payload),
  });
  return {...base,...over};
}

beforeEach(()=>{store=new IdeSessionStore(join(mkdtempSync(join(tmpdir(),'qg-ide-admit-')),'ide.db'));});

describe('P7 B3 canonical companion admission funnel',()=>{
  it('admits one signed review request and returns only bounded authenticated identity metadata',()=>{
    const ctx=setup(); const admitted=admitIdeCompanionRequest({store,envelope:frame(ctx),secret,payload,nowMs});
    expect(admitted).toEqual({
      enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,
      connectionGeneration:ctx.s.connectionGeneration,controllerLeaseId:ctx.lease,
      operationId:`ideo_${'3'.repeat(32)}`,capability:'request_review',payloadSha256:hashIdeCompanionPayload(payload),
    });
    expect(Object.keys(admitted).sort()).not.toContain('mac');
    expect(Object.keys(admitted).sort()).not.toContain('nonce');
    expect(Object.keys(admitted).sort()).not.toContain('secret');
  });

  it('rejects replay of an otherwise valid admitted frame',()=>{
    const ctx=setup(); const envelope=frame(ctx);
    admitIdeCompanionRequest({store,envelope,secret,payload,nowMs});
    expect(errorCode(()=>admitIdeCompanionRequest({store,envelope,secret,payload,nowMs}))).toBe('IDE_AUTH_REPLAY');
  });

  it('does not consume replay identity when cryptographic authentication fails',()=>{
    const ctx=setup(); const envelope=frame(ctx);
    expect(errorCode(()=>admitIdeCompanionRequest({store,envelope,secret:Buffer.alloc(32,0x72),payload,nowMs}))).toBe('IDE_COMPANION_AUTH_DENIED');
    expect(()=>admitIdeCompanionRequest({store,envelope,secret,payload,nowMs})).not.toThrow();
  });

  it('consumes a valid signed frame before lifecycle denial so it cannot become authorized later',()=>{
    const ctx=setup(); store.markOperationActive(ctx.key,ctx.lease); const envelope=frame(ctx,'request_review');
    expect(errorCode(()=>admitIdeCompanionRequest({store,envelope,secret,payload,nowMs}))).toBe('IDE_SESSION_STATE_DENIED');
    store.markOperationSettled(ctx.key,ctx.lease);
    expect(errorCode(()=>admitIdeCompanionRequest({store,envelope,secret,payload,nowMs}))).toBe('IDE_AUTH_REPLAY');
  });

  it('invalidates a signed frame after controller turnover even though its MAC remains valid',()=>{
    const ctx=setup(); const envelope=frame(ctx);
    store.releaseController(ctx.key,ctx.lease); const newLease=store.acquireController(ctx.key);
    expect(newLease).not.toBe(ctx.lease);
    expect(errorCode(()=>admitIdeCompanionRequest({store,envelope,secret,payload,nowMs}))).toBe('IDE_CONTROLLER_LEASE_MISMATCH');
  });

  it('invalidates a signed frame after reconnect advances the current generation',()=>{
    const ctx=setup(); const envelope=frame(ctx);
    store.releaseController(ctx.key,ctx.lease);
    const current=store.getEnrollment(ctx.e.enrollmentId)!;
    store.openSession({
      enrollmentId:current.enrollmentId,principalId:current.principalId,projectId:current.projectId,worktreeId:current.worktreeId,
      ideProduct:current.ideProduct,ideInstanceId:current.ideInstanceId,workspaceFingerprint:current.workspaceFingerprint,
      baseRevision:current.baseRevision,sessionId:`ides_${'4'.repeat(32)}`,
    });
    expect(errorCode(()=>admitIdeCompanionRequest({store,envelope,secret,payload,nowMs}))).toBe('IDE_SESSION_BINDING_MISMATCH');
  });
});
