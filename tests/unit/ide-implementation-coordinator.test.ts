import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashIdeCompanionPayload, signIdeCompanionEnvelope, type IdeCompanionAuthEnvelope } from '../../src/shared/ideCompanionAuth.js';
import { serializeIdeCompanionImplementationPayload } from '../../src/shared/ideCompanionOperations.js';
import {
  deriveIdeEnvironmentIdentity, deriveIdeFilesystemIdentity, deriveIdeWorkspaceFingerprint,
  serializeIdeWorkspaceAttestation, type IdeWorkspacePhysicalIdentity,
} from '../../src/shared/ideWorkspaceAttestation.js';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { createIdeCompanionRuntime, readIdeCompanionSecret } from '../../src/executor/ide/ideCompanionRuntime.js';
import {
  IdeImplementationCoordinator, type IdeImplementationAdapterInput,
  type IdeImplementationAdapterOutcome, type IdeImplementationOperationAdapter,
} from '../../src/executor/ide/ideImplementationCoordinator.js';
import { IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';

const nowMs=1_800_000_000_000;
let ideStore:IdeSessionStore;
let writerStore:AgentJobStore;
let runtimeRoot:string;
let nonce=1;

function workspace():IdeWorkspacePhysicalIdentity{
  const canonicalPath='/srv/projects/quarangate-forward';
  return{workspaceFolderCount:1,remoteKind:'wsl',environmentIdentity:deriveIdeEnvironmentIdentity('wsl','stable'),pathFlavor:'posix',caseMode:'case-sensitive',canonicalization:'realpath-exact',workspaceUri:pathToFileURL(canonicalPath).href,canonicalPath,filesystemIdentity:deriveIdeFilesystemIdentity('posix','10','20'),git:{kind:'worktree',worktreeRoot:canonicalPath,commonDir:'/srv/projects/QuaranGate/.git',commonDirIdentity:deriveIdeFilesystemIdentity('posix','10','30'),headRevision:'a'.repeat(40)}};
}
function fixture(adapter:IdeImplementationOperationAdapter){
  const w=workspace(); const fingerprint=deriveIdeWorkspaceFingerprint({projectId:'quarangate',worktreeId:'forward',workspace:w});
  const e=ideStore.createEnrollment({principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',ideProduct:'vscode',ideInstanceId:`ide_${'1'.repeat(32)}`,workspaceFingerprint:fingerprint,baseRevision:'a'.repeat(40),capabilities:['request_implementation','cancel','observe_response']});
  const s=ideStore.openSession({enrollmentId:e.enrollmentId,principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,baseRevision:e.baseRevision,sessionId:`ides_${'2'.repeat(32)}`});
  const key={principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,baseRevision:e.baseRevision,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration} as const;
  ideStore.markAvailable(key); const controllerLeaseId=ideStore.acquireController(key);
  const runtime=createIdeCompanionRuntime({runtimeRoot,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,ideProduct:e.ideProduct,adapterVersion:'1.2.3'});
  const workspaceAttestation=serializeIdeWorkspaceAttestation({version:1,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,runtimeInstanceId:runtime.runtimeInstanceId,ideProduct:e.ideProduct,adapterId:runtime.adapterId,adapterVersion:runtime.adapterVersion,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,workspace:w});
  const prompt='perform bounded implementation'; const payload=serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation); const operationId=`ideo_${'3'.repeat(32)}`;
  const secret=readIdeCompanionSecret(runtime).secret;
  const envelope=signIdeCompanionEnvelope(secret,{version:1,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,controllerLeaseId,operationId,capability:'request_implementation',nonce:Buffer.alloc(32,nonce++).toString('base64url'),issuedAtMs:nowMs,expiresAtMs:nowMs+20_000,payloadSha256:hashIdeCompanionPayload(payload)}); secret.fill(0);
  const coordinator=new IdeImplementationCoordinator({store:ideStore,writerStore,runtime,adapter,nowMs:()=>nowMs});
  return{e,s,key,controllerLeaseId,runtime,workspaceAttestation,prompt,operationId,envelope,coordinator};
}
function cancelEnvelope(ctx:ReturnType<typeof fixture>):IdeCompanionAuthEnvelope{
  const secret=readIdeCompanionSecret(ctx.runtime).secret;
  const result=signIdeCompanionEnvelope(secret,{version:1,enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,connectionGeneration:ctx.s.connectionGeneration,controllerLeaseId:ctx.controllerLeaseId,operationId:ctx.operationId,capability:'cancel',nonce:Buffer.alloc(32,nonce++).toString('base64url'),issuedAtMs:nowMs,expiresAtMs:nowMs+20_000,payloadSha256:hashIdeCompanionPayload('')}); secret.fill(0); return result;
}
async function flush(){await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));}
function controlled(){
  let input:IdeImplementationAdapterInput|undefined; let resolve!:(value:{outcome:IdeImplementationAdapterOutcome})=>void; let reject!:(reason?:unknown)=>void;
  const promise=new Promise<{outcome:IdeImplementationAdapterOutcome}>((res,rej)=>{resolve=res;reject=rej;});
  const adapter:IdeImplementationOperationAdapter={run(value){input=value;return promise;}};
  return{adapter,get input(){return input;},resolve,reject};
}

beforeEach(()=>{
  nonce=1; ideStore=new IdeSessionStore(join(mkdtempSync(join(tmpdir(),'qg-b92-ide-')),'ide.db')); writerStore=new AgentJobStore(join(mkdtempSync(join(tmpdir(),'qg-b92-writer-')),'agents.db'));
  const base=mkdtempSync(join(tmpdir(),'qg-b92-runtime-'));chmodSync(base,0o700);runtimeRoot=join(base,'runtime');mkdirSync(runtimeRoot,{mode:0o700});chmodSync(runtimeRoot,0o700);
});

describe('P7 B9.2 implementation operation + B8 settlement',()=>{
  it('durably binds writer and mutation boundary before adapter invocation, then safe completion releases both authorities',async()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const events:string[]=[];
    const started=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,e=>events.push(e.type));
    expect(ctl.input).toBeDefined(); expect(started.capability).toBe('request_implementation'); expect(started.writerSettlement).toBe('HELD'); expect(started.writerLeaseId).toMatch(/^wrl_/); expect(started.mutationStartedAt).not.toBeNull();
    expect(writerStore.getLiveWriterLease(started.writerLeaseId!)?.state).toBe('ACTIVE'); expect(events).toEqual(['operation_started']);
    ctl.resolve({outcome:'completed'}); await flush();
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'COMPLETED',writerSettlement:'RELEASED'});
    expect(writerStore.getLiveWriterLease(started.writerLeaseId!)?.state).toBe('RELEASED'); expect(ideStore.getSession(ctx.s.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
    expect(events).toEqual(['operation_started','completed']);
  });

  it.each(['failed_no_mutation','failed_rolled_back'] as const)('%s is a proven safe FAILED and releases the writer',async(outcome)=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    ctl.resolve({outcome});await flush();
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'FAILED',writerSettlement:'RELEASED'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('RELEASED');
  });

  it('adapter throw is never treated as ordinary FAILED: operation becomes INDETERMINATE and writer UNCERTAIN',async()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    ctl.reject(new Error('ambiguous transport loss after possible mutation'));await flush();
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'INDETERMINATE',writerSettlement:'UNCERTAIN'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
  });

  it('malformed adapter result is INDETERMINATE + UNCERTAIN rather than fabricated success/failure',async()=>{
    const adapter={async run(){return {outcome:'unknown'} as never;}};const ctx=fixture(adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});await flush();
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'INDETERMINATE',writerSettlement:'UNCERTAIN'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
  });

  it('authenticated cancellation releases only after adapter proves cancelled rollback/no-mutation',async()=>{
    let captured:IdeImplementationAdapterInput|undefined;
    const adapter:IdeImplementationOperationAdapter={run(input){captured=input;return new Promise(resolve=>input.signal.addEventListener('abort',()=>resolve({outcome:'cancelled_rolled_back'}),{once:true}));}};
    const ctx=fixture(adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    expect(ctx.coordinator.cancel(cancelEnvelope(ctx))).toBe('accepted');expect(captured?.signal.aborted).toBe(true);await flush();
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'CANCELLED',writerSettlement:'RELEASED'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('RELEASED');
  });

  it('disconnect is terminal DISCONNECTED and keeps writer blocked as UNCERTAIN',async()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    ctx.coordinator.connectionClosed(ctx.s.sessionId,ctx.s.connectionGeneration);
    expect(ctl.input?.signal.aborted).toBe(true);expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'DISCONNECTED',writerSettlement:'UNCERTAIN'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
  });

  it('restart terminalizes durable implementation operation INDETERMINATE and reconciles writer UNCERTAIN',()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    const fresh=new IdeImplementationCoordinator({store:ideStore,writerStore,runtime:ctx.runtime,adapter:{async run(){return{outcome:'indeterminate'};}}});
    const recovered=fresh.recoverAfterRestart();
    expect(recovered.indeterminateOperationIds).toContain(ctx.operationId);expect(recovered.writerReconciledOperationIds).toContain(ctx.operationId);
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'INDETERMINATE',writerSettlement:'UNCERTAIN'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');expect(ideStore.getSession(ctx.s.sessionId)?.state).toBe('STALE');
  });

  it('external revocation/disconnect terminalization is reconciled to UNCERTAIN without needing the in-process handle',()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    expect(ideStore.revokeEnrollment({enrollmentId:ctx.e.enrollmentId,principalId:ctx.e.principalId,projectId:ctx.e.projectId,worktreeId:ctx.e.worktreeId,ideProduct:ctx.e.ideProduct,ideInstanceId:ctx.e.ideInstanceId,workspaceFingerprint:ctx.e.workspaceFingerprint,baseRevision:ctx.e.baseRevision})).toBe(true);
    const fresh=new IdeImplementationCoordinator({store:ideStore,writerStore,runtime:ctx.runtime,adapter:{async run(){return{outcome:'indeterminate'};}}});
    expect(fresh.reconcileTerminalWriterSettlements()).toContain(ctx.operationId);
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'DISCONNECTED',writerSettlement:'UNCERTAIN'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
  });

  it('B8 release failure can never produce COMPLETED: safe intent falls back to INDETERMINATE + UNCERTAIN',async()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const events:string[]=[];
    const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,event=>events.push(event.type));
    Object.defineProperty(writerStore,'releaseLiveWriterLease',{value:()=>{throw new Error('injected release failure');}});
    ctl.resolve({outcome:'completed'});await flush();
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'INDETERMINATE',writerSettlement:'UNCERTAIN',safeTerminalIntent:'COMPLETED'});
    expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
    expect(events).toEqual(['operation_started','indeterminate']);
    expect(ideStore.getOperationAudit(ctx.operationId).map(row=>row.eventType)).toEqual(['operation_started','indeterminate']);
  });

  it('refuses safe terminal finalization until the exact external B8 lease is proven RELEASED',()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    ideStore.prepareImplementationSafeTerminal(ctx.operationId,op.writerLeaseId!,ctx.controllerLeaseId,'COMPLETED');
    expect(()=>ideStore.finalizeImplementationSafeTerminal(ctx.operationId,writerStore,op.writerLeaseId!,ctx.controllerLeaseId)).toThrow('external B8 writer authority is not exact RELEASED');
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'RUNNING',writerSettlement:'HELD',safeTerminalIntent:'COMPLETED'});
    expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('ACTIVE');
    ctx.coordinator.connectionClosed(ctx.s.sessionId,ctx.s.connectionGeneration);
  });

  it('restart after safe intent but before B8 release is conservative INDETERMINATE + UNCERTAIN',()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    ideStore.prepareImplementationSafeTerminal(ctx.operationId,op.writerLeaseId!,ctx.controllerLeaseId,'COMPLETED');
    const fresh=new IdeImplementationCoordinator({store:ideStore,writerStore,runtime:ctx.runtime,adapter:{async run(){return{outcome:'indeterminate'};}}});
    fresh.recoverAfterRestart();
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'INDETERMINATE',writerSettlement:'UNCERTAIN',safeTerminalIntent:'COMPLETED'});
    expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
  });

  it('restart after external B8 RELEASED but before Plane-B safe finalization never fabricates COMPLETED',()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    ideStore.prepareImplementationSafeTerminal(ctx.operationId,op.writerLeaseId!,ctx.controllerLeaseId,'COMPLETED');
    writerStore.releaseLiveWriterLease({projectId:op.projectId,worktreeId:op.worktreeId,ownerKind:'ide',ownerId:op.operationId,principalId:op.principalId,writerLeaseId:op.writerLeaseId!,reason:'simulated crash window after release'});
    const fresh=new IdeImplementationCoordinator({store:ideStore,writerStore,runtime:ctx.runtime,adapter:{async run(){return{outcome:'indeterminate'};}}});
    fresh.recoverAfterRestart();
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'INDETERMINATE',writerSettlement:'RELEASED',safeTerminalIntent:'COMPLETED'});
    expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('RELEASED');
    expect(ideStore.getOperationAudit(ctx.operationId).at(-1)?.eventType).toBe('indeterminate');
  });

  it('generic B7 terminal append cannot bypass the B9 writer-settlement finalizer',()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);const op=ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    expect(()=>ideStore.appendOperationEvent({version:1,operationId:op.operationId,sessionId:op.sessionId,connectionGeneration:op.connectionGeneration,origin:'machine',sequence:op.nextSequence,type:'completed'},ctx.controllerLeaseId)).toThrow('implementation terminal events require the B9 writer-settlement finalizer');
    expect(ideStore.getOperation(ctx.operationId)).toMatchObject({state:'RUNNING',writerSettlement:'HELD'});
    ctx.coordinator.connectionClosed(ctx.s.sessionId,ctx.s.connectionGeneration);
  });

  it('adapter input exposes no host path, credential, writer store, or writer lease authority',()=>{
    const ctl=controlled();const ctx=fixture(ctl.adapter);ctx.coordinator.startImplementation(ctx.envelope,ctx.prompt,ctx.workspaceAttestation,()=>{});
    expect(Object.keys(ctl.input!).sort()).toEqual(['connectionGeneration','emit','operationId','prompt','sessionId','signal'].sort());
    ctl.reject(new Error('cleanup')); 
  });
});
