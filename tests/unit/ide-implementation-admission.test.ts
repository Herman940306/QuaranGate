import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeError } from '../../src/shared/errors.js';
import { hashIdeCompanionPayload, signIdeCompanionEnvelope } from '../../src/shared/ideCompanionAuth.js';
import { serializeIdeCompanionImplementationPayload } from '../../src/shared/ideCompanionOperations.js';
import {
  deriveIdeEnvironmentIdentity, deriveIdeFilesystemIdentity, deriveIdeWorkspaceFingerprint,
  serializeIdeWorkspaceAttestation, type IdeWorkspacePhysicalIdentity,
} from '../../src/shared/ideWorkspaceAttestation.js';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { createIdeCompanionRuntime, readIdeCompanionSecret } from '../../src/executor/ide/ideCompanionRuntime.js';
import { admitIdeImplementation } from '../../src/executor/ide/ideImplementationAdmission.js';
import { IdeRegistryStoreError, IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';
import { IdeSessionContractError } from '../../src/shared/ideSessions.js';

const nowMs=1_800_000_000_000;
let ideStore:IdeSessionStore;
let writerStore:AgentJobStore;
let runtimeRoot:string;
let nonceSeq=1;

function workspace(path='/srv/projects/quarangate-forward'):IdeWorkspacePhysicalIdentity{
  return {workspaceFolderCount:1,remoteKind:'wsl',environmentIdentity:deriveIdeEnvironmentIdentity('wsl','stable'),pathFlavor:'posix',caseMode:'case-sensitive',canonicalization:'realpath-exact',workspaceUri:pathToFileURL(path).href,canonicalPath:path,filesystemIdentity:deriveIdeFilesystemIdentity('posix','10','20'),git:{kind:'worktree',worktreeRoot:path,commonDir:'/srv/projects/QuaranGate/.git',commonDirIdentity:deriveIdeFilesystemIdentity('posix','10','30'),headRevision:'a'.repeat(40)}};
}
function failureCode(fn:()=>unknown):string{
  try{fn();return'NO_ERROR';}catch(e){
    if(e instanceof IdeRegistryStoreError||e instanceof IdeSessionContractError||e instanceof BridgeError)return e.code;
    return (e as {code?:string}).code??'OTHER_ERROR';
  }
}
function fixture(over:{workspace?:IdeWorkspacePhysicalIdentity;operationHex?:string}={}){
  const enrolledWorkspace=workspace();
  const fingerprint=deriveIdeWorkspaceFingerprint({projectId:'quarangate',worktreeId:'forward',workspace:enrolledWorkspace});
  const e=ideStore.createEnrollment({principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',ideProduct:'vscode',ideInstanceId:`ide_${'1'.repeat(32)}`,workspaceFingerprint:fingerprint,baseRevision:'a'.repeat(40),capabilities:['request_implementation','cancel','observe_response']});
  const s=ideStore.openSession({enrollmentId:e.enrollmentId,principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,baseRevision:e.baseRevision,sessionId:`ides_${'2'.repeat(32)}`});
  const key={principalId:e.principalId,projectId:e.projectId,worktreeId:e.worktreeId,ideProduct:e.ideProduct,ideInstanceId:e.ideInstanceId,workspaceFingerprint:e.workspaceFingerprint,baseRevision:e.baseRevision,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration} as const;
  ideStore.markAvailable(key); const controllerLeaseId=ideStore.acquireController(key);
  const runtime=createIdeCompanionRuntime({runtimeRoot,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,ideProduct:e.ideProduct,adapterVersion:'1.2.3'});
  const attestedWorkspace=over.workspace??enrolledWorkspace;
  const workspaceAttestation=serializeIdeWorkspaceAttestation({version:1,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,runtimeInstanceId:runtime.runtimeInstanceId,ideProduct:e.ideProduct,adapterId:runtime.adapterId,adapterVersion:runtime.adapterVersion,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,workspace:attestedWorkspace});
  const prompt='implement bounded change'; const payload=serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation);
  const operationId=`ideo_${(over.operationHex??'3').repeat(32)}`;
  const secret=readIdeCompanionSecret(runtime).secret;
  const nonce=Buffer.alloc(32,nonceSeq++).toString('base64url');
  const envelope=signIdeCompanionEnvelope(secret,{version:1,enrollmentId:e.enrollmentId,ideInstanceId:e.ideInstanceId,sessionId:s.sessionId,connectionGeneration:s.connectionGeneration,controllerLeaseId,operationId,capability:'request_implementation',nonce,issuedAtMs:nowMs,expiresAtMs:nowMs+20_000,payloadSha256:hashIdeCompanionPayload(payload)}); secret.fill(0);
  return{e,s,key,controllerLeaseId,runtime,workspaceAttestation,prompt,envelope,operationId};
}
function release(ctx:{e:{principalId:string;projectId:string;worktreeId:string};operationId:string},writerLeaseId:string){
  writerStore.releaseLiveWriterLease({projectId:ctx.e.projectId,worktreeId:ctx.e.worktreeId,ownerKind:'ide',ownerId:ctx.operationId,principalId:ctx.e.principalId,writerLeaseId,reason:'test cleanup'});
}

beforeEach(()=>{
  nonceSeq=1;
  ideStore=new IdeSessionStore(join(mkdtempSync(join(tmpdir(),'qg-b91-ide-')),'ide.db'));
  writerStore=new AgentJobStore(join(mkdtempSync(join(tmpdir(),'qg-b91-writer-')),'agents.db'));
  const base=mkdtempSync(join(tmpdir(),'qg-b91-runtime-')); chmodSync(base,0o700); runtimeRoot=join(base,'runtime'); mkdirSync(runtimeRoot,{mode:0o700}); chmodSync(runtimeRoot,0o700);
});

describe('P7 B9.1 implementation admission foundation',()=>{
  it('authenticates, re-attests, acquires one exact B8 IDE lease, and stops before B7 operation creation',()=>{
    const ctx=fixture();
    const admitted=admitIdeImplementation({ideStore,writerStore,runtime:ctx.runtime,envelope:ctx.envelope,prompt:ctx.prompt,workspaceAttestation:ctx.workspaceAttestation,nowMs});
    expect(admitted).toMatchObject({operationId:ctx.operationId,capability:'request_implementation',principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward'});
    expect(writerStore.getLiveWriterLease(admitted.writerLeaseId)).toMatchObject({state:'ACTIVE',ownerKind:'ide',ownerId:ctx.operationId,projectId:'quarangate',worktreeId:'forward'});
    expect(ideStore.getOperation(ctx.operationId)).toBeUndefined();
    expect(ideStore.getSession(ctx.s.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
    release(ctx,admitted.writerLeaseId);
  });

  it('writerless companion authority still rejects request_implementation',()=>{
    const ctx=fixture();
    expect(failureCode(()=>ideStore.assertCompanionAuthority({enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,connectionGeneration:ctx.s.connectionGeneration,controllerLeaseId:ctx.controllerLeaseId,operationId:ctx.operationId,capability:'request_implementation'}))).toBe('IDE_WRITER_LEASE_REQUIRED');
  });

  it('fails B5 workspace mismatch before consuming a live-writer owner identity',()=>{
    const ctx=fixture({workspace:workspace('/srv/projects/wrong-worktree')});
    expect(failureCode(()=>admitIdeImplementation({ideStore,writerStore,runtime:ctx.runtime,envelope:ctx.envelope,prompt:ctx.prompt,workspaceAttestation:ctx.workspaceAttestation,nowMs}))).toBe('IDE_WORKSPACE_FINGERPRINT_MISMATCH');
    const lease=writerStore.acquireLiveWriterLease({projectId:'quarangate',worktreeId:'forward',ownerKind:'ide',ownerId:ctx.operationId,principalId:'chatgpt-browser'});
    expect(lease.state).toBe('ACTIVE'); release(ctx,lease.writerLeaseId);
  });

  it('B8 contention blocks implementation admission for the same logical project/worktree',()=>{
    const held=writerStore.acquireLiveWriterLease({projectId:'quarangate',worktreeId:'forward',ownerKind:'ide',ownerId:`ideo_${'9'.repeat(32)}`,principalId:'other'});
    const ctx=fixture();
    expect(failureCode(()=>admitIdeImplementation({ideStore,writerStore,runtime:ctx.runtime,envelope:ctx.envelope,prompt:ctx.prompt,workspaceAttestation:ctx.workspaceAttestation,nowMs}))).toBe('LIVE_WRITER_BUSY');
    writerStore.releaseLiveWriterLease({projectId:'quarangate',worktreeId:'forward',ownerKind:'ide',ownerId:`ideo_${'9'.repeat(32)}`,principalId:'other',writerLeaseId:held.writerLeaseId,reason:'test cleanup'});
  });

  it('releases a newly acquired B8 lease when full B1 start authority fails before durable operation creation',()=>{
    const ctx=fixture();
    ideStore.markOperationActive(ctx.key,ctx.controllerLeaseId);
    expect(failureCode(()=>admitIdeImplementation({ideStore,writerStore,runtime:ctx.runtime,envelope:ctx.envelope,prompt:ctx.prompt,workspaceAttestation:ctx.workspaceAttestation,nowMs}))).toBe('IDE_SESSION_STATE_DENIED');
    const probe=writerStore.acquireLiveWriterLease({projectId:'quarangate',worktreeId:'forward',ownerKind:'ide',ownerId:`ideo_${'8'.repeat(32)}`,principalId:'chatgpt-browser'});
    expect(probe.state).toBe('ACTIVE');
    writerStore.releaseLiveWriterLease({projectId:'quarangate',worktreeId:'forward',ownerKind:'ide',ownerId:`ideo_${'8'.repeat(32)}`,principalId:'chatgpt-browser',writerLeaseId:probe.writerLeaseId,reason:'test cleanup'});
  });

  it('writer-aware authority re-reads durable B8 state and rejects a lease bound to another target',()=>{
    const ctx=fixture();
    const wrong=writerStore.acquireLiveWriterLease({projectId:'other',worktreeId:'forward',ownerKind:'ide',ownerId:ctx.operationId,principalId:'chatgpt-browser'});
    const request={enrollmentId:ctx.e.enrollmentId,ideInstanceId:ctx.e.ideInstanceId,sessionId:ctx.s.sessionId,connectionGeneration:ctx.s.connectionGeneration,controllerLeaseId:ctx.controllerLeaseId,operationId:ctx.operationId,capability:'request_implementation' as const};
    expect(failureCode(()=>ideStore.assertCompanionAuthorityWithWriter(request,writerStore,wrong.writerLeaseId))).toBe('IDE_OPERATION_BINDING_MISMATCH');
    writerStore.releaseLiveWriterLease({projectId:'other',worktreeId:'forward',ownerKind:'ide',ownerId:ctx.operationId,principalId:'chatgpt-browser',writerLeaseId:wrong.writerLeaseId,reason:'test cleanup'});
  });

  it('outer implementation MAC binds prompt plus exact nested workspace bytes before any B8 acquisition',()=>{
    const ctx=fixture();
    expect(failureCode(()=>admitIdeImplementation({ideStore,writerStore,runtime:ctx.runtime,envelope:ctx.envelope,prompt:`${ctx.prompt} tampered`,workspaceAttestation:ctx.workspaceAttestation,nowMs}))).toBe('IDE_COMPANION_AUTH_DENIED');
    const lease=writerStore.acquireLiveWriterLease({projectId:'quarangate',worktreeId:'forward',ownerKind:'ide',ownerId:ctx.operationId,principalId:'chatgpt-browser'});
    expect(lease.state).toBe('ACTIVE'); release(ctx,lease.writerLeaseId);
  });
});
