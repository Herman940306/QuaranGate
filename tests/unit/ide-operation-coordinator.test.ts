import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashIdeCompanionPayload, signIdeCompanionEnvelope } from '../../src/shared/ideCompanionAuth.js';
import { serializeIdeCompanionReviewPayload } from '../../src/shared/ideCompanionOperations.js';
import {
  deriveIdeEnvironmentIdentity, deriveIdeFilesystemIdentity, deriveIdeWorkspaceFingerprint,
  serializeIdeWorkspaceAttestation, type IdeWorkspacePhysicalIdentity,
} from '../../src/shared/ideWorkspaceAttestation.js';
import { createIdeCompanionRuntime, readIdeCompanionSecret } from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeOperationCoordinator, type IdeReviewOperationAdapter } from '../../src/executor/ide/ideOperationCoordinator.js';
import { IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';

const nowMs=1_800_000_000_000;
let store:IdeSessionStore;
let runtimeRoot:string;
function workspace():IdeWorkspacePhysicalIdentity{
  const canonicalPath='/srv/projects/quarangate-forward';
  return{workspaceFolderCount:1,remoteKind:'wsl',environmentIdentity:deriveIdeEnvironmentIdentity('wsl','stable'),pathFlavor:'posix',caseMode:'case-sensitive',canonicalization:'realpath-exact',workspaceUri:pathToFileURL(canonicalPath).href,canonicalPath,filesystemIdentity:deriveIdeFilesystemIdentity('posix','10','20'),git:{kind:'worktree',worktreeRoot:canonicalPath,commonDir:'/srv/projects/QuaranGate/.git',commonDirIdentity:deriveIdeFilesystemIdentity('posix','10','30'),headRevision:'a'.repeat(40)}};
}
function fixture(adapter:IdeReviewOperationAdapter){
  const w=workspace();const fingerprint=deriveIdeWorkspaceFingerprint({projectId:'quarangate',worktreeId:'forward',workspace:w});
  const e=store.createEnrollment({principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',ideProduct:'vscode',ideInstanceId:`ide_${'1'.repeat(32)}`,workspaceFingerprint:fingerprint,baseRevision:'a'.repeat(40),capabilities:['request_review','cancel','observe_response']});
  const s=store.openSession({enrollmentId:e.enrollmentId,principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,baseRevision:e.baseRevision,sessionId:`ides_${'2'.repeat(32)}`});
  const key={principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,baseRevision:e.baseRevision,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration} as const;
  store.markAvailable(key);const lease=store.acquireController(key);
  const runtime=createIdeCompanionRuntime({runtimeRoot,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,ideProduct:e.ideProduct,adapterVersion:'1.2.3'});
  const attestation=serializeIdeWorkspaceAttestation({version:1,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,runtimeInstanceId:runtime.runtimeInstanceId,ideProduct:e.ideProduct,adapterId:runtime.adapterId,adapterVersion:runtime.adapterVersion,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,workspace:w});
  const prompt='bounded review';const payload=serializeIdeCompanionReviewPayload(prompt,attestation);const secret=readIdeCompanionSecret(runtime).secret;
  const auth=signIdeCompanionEnvelope(secret,{version:1,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,controllerLeaseId:lease,operationId:`ideo_${'3'.repeat(32)}`,capability:'request_review',nonce:Buffer.alloc(32,0x61).toString('base64url'),issuedAtMs:nowMs,expiresAtMs:nowMs+20_000,payloadSha256:hashIdeCompanionPayload(payload)});secret.fill(0);
  return{e,s,key,lease,runtime,attestation,prompt,auth,coordinator:new IdeOperationCoordinator({store,runtime,adapter,nowMs:()=>nowMs})};
}
beforeEach(()=>{store=new IdeSessionStore(join(mkdtempSync(join(tmpdir(),'qg-b7-coord-')),'ide.db'));const base=mkdtempSync(join(tmpdir(),'qg-b7-runtime-'));chmodSync(base,0o700);runtimeRoot=join(base,'runtime');mkdirSync(runtimeRoot,{mode:0o700});chmodSync(runtimeRoot,0o700);});

describe('P7 B7 operation coordinator fail-closed seams',()=>{
  it('terminalizes INDETERMINATE before surfacing an initial event-sink failure and never invokes adapter',()=>{
    let called=false;const ctx=fixture({async run(){called=true;}});
    expect(()=>ctx.coordinator.startReview(ctx.auth,ctx.prompt,ctx.attestation,()=>{throw new Error('sink failed');})).toThrow('sink failed');
    expect(called).toBe(false);expect(store.getOperation(ctx.auth.operationId)?.state).toBe('INDETERMINATE');expect(store.getSession(ctx.s.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
    expect(store.getOperationAudit(ctx.auth.operationId).map(r=>r.eventType)).toEqual(['operation_started','indeterminate']);
  });

  it('maps adapter failure to bounded FAILED without persisting raw exception text',async()=>{
    const events:string[]=[];const ctx=fixture({async run(){throw new Error('SECRET_ADAPTER_EXCEPTION_BODY');}});
    ctx.coordinator.startReview(ctx.auth,ctx.prompt,ctx.attestation,event=>events.push(event.type));
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(events).toEqual(['operation_started','failed']);expect(store.getOperation(ctx.auth.operationId)?.state).toBe('FAILED');
    expect(store.getOperationAudit(ctx.auth.operationId).at(-1)).toMatchObject({eventType:'failed',messageSha256:hashIdeCompanionPayload('operation failed')});
  });

  it('turns an over-bound adapter event into INDETERMINATE rather than streaming or persisting it',async()=>{
    const events:string[]=[];const ctx=fixture({async run(input){input.emit('assistant_chunk','x'.repeat(9*1024));}});
    ctx.coordinator.startReview(ctx.auth,ctx.prompt,ctx.attestation,event=>events.push(event.type));
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(events).toEqual(['operation_started','indeterminate']);expect(store.getOperation(ctx.auth.operationId)?.state).toBe('INDETERMINATE');
    expect(store.getOperationAudit(ctx.auth.operationId).map(r=>r.eventType)).toEqual(['operation_started','indeterminate']);
  });
});
