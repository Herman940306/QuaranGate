import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { IdeCompanionListener } from '../../src/executor/ide/ideCompanionListener.js';
import { IdeCompanionRemoteChannel } from '../../src/executor/ide/ideCompanionRemoteChannel.js';
import { createIdeCompanionRuntime } from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeImplementationCoordinator } from '../../src/executor/ide/ideImplementationCoordinator.js';
import { IdeOperationCoordinator } from '../../src/executor/ide/ideOperationCoordinator.js';
import { IdeSessionStore, type IdeEnrollmentRow } from '../../src/executor/ide/ideSessionStore.js';
import {
  deriveIdeEnvironmentIdentity,
  deriveIdeFilesystemIdentity,
  deriveIdeWorkspaceFingerprint,
  type IdeWorkspacePhysicalIdentity,
} from '../../src/shared/ideWorkspaceAttestation.js';
import { connectVsCodeCompanion, type VsCodeCompanionConnection } from '../../src/ide-adapters/vscode/vscodeCompanionConnection.js';
import { readVsCodeCompanionCredential, type VsCodeCompanionCredential } from '../../src/ide-adapters/vscode/vscodeCompanionCredential.js';
import { VsCodeCommandChannel } from '../../src/ide-adapters/vscode/vscodeCommandChannel.js';
import {
  VsCodeModelAccessController,
  VsCodePublicApiReviewHandler,
  type VsCodeCancellationToken,
  type VsCodeLanguageModelMessage,
  type VsCodePublicLanguageModelApi,
} from '../../src/ide-adapters/vscode/vscodePublicApiModelExecution.js';

const nowMs=1_800_000_000_000;
const baseRevision='a'.repeat(40);
let store:IdeSessionStore;
let writerStore:AgentJobStore;
let runtimeRoot:string;
let listener:IdeCompanionListener|undefined;
let connection:VsCodeCompanionConnection|undefined;
let clientChannel:VsCodeCommandChannel|undefined;

function physical():IdeWorkspacePhysicalIdentity{
  const canonicalPath='/srv/projects/quarangate-forward';
  return{workspaceFolderCount:1,remoteKind:'wsl',environmentIdentity:deriveIdeEnvironmentIdentity('wsl','ubuntu-24.04:stable-id'),pathFlavor:'posix',caseMode:'case-sensitive',canonicalization:'realpath-exact',workspaceUri:pathToFileURL(canonicalPath).href,canonicalPath,filesystemIdentity:deriveIdeFilesystemIdentity('posix','100','200'),git:{kind:'worktree',worktreeRoot:canonicalPath,commonDir:'/srv/projects/QuaranGate/.git',commonDirIdentity:deriveIdeFilesystemIdentity('posix','100','300'),headRevision:baseRevision}};
}
function binding(credential:VsCodeCompanionCredential):Omit<VsCodeCompanionCredential,'secret'>{
  const {secret:_secret,...rest}=credential;return rest;
}
function sessionKey(enrollment:IdeEnrollmentRow,sessionId:string,generation:number){return{principalId:enrollment.principalId,projectId:enrollment.projectId,worktreeId:enrollment.worktreeId,workspaceFingerprint:enrollment.workspaceFingerprint,baseRevision:enrollment.baseRevision,ideProduct:enrollment.ideProduct,ideInstanceId:enrollment.ideInstanceId,sessionId,connectionGeneration:generation};}
async function waitFor(fn:()=>boolean,timeout=1000):Promise<void>{const start=Date.now();while(!fn()){if(Date.now()-start>timeout)throw new Error('timed out');await new Promise(r=>setTimeout(r,5));}}

async function ready(capabilities:('request_review'|'request_implementation'|'cancel'|'observe_response')[],handlers:{review?:ConstructorParameters<typeof VsCodeCommandChannel>[0]['reviewHandler'];implementation?:ConstructorParameters<typeof VsCodeCommandChannel>[0]['implementationHandler'];operationWorkspace?:IdeWorkspacePhysicalIdentity;collectWorkspace?:()=>Promise<IdeWorkspacePhysicalIdentity>}={}):Promise<{enrollment:NonNullable<ReturnType<IdeSessionStore['getEnrollment']>>;runtime:ReturnType<typeof createIdeCompanionRuntime>;remote:IdeCompanionRemoteChannel;workspace:IdeWorkspacePhysicalIdentity;controllerLeaseId:string}>{
  const workspace=physical();
  const enrollment=store.createEnrollment({principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',ideProduct:'vscode',ideInstanceId:`ide_${'1'.repeat(32)}`,workspaceFingerprint:deriveIdeWorkspaceFingerprint({projectId:'quarangate',worktreeId:'forward',workspace}),baseRevision,capabilities});
  const runtime=createIdeCompanionRuntime({runtimeRoot,enrollmentId:enrollment.enrollmentId,ideInstanceId:enrollment.ideInstanceId,ideProduct:'vscode',adapterVersion:'1.2.3'});
  let remote:IdeCompanionRemoteChannel|undefined;
  listener=new IdeCompanionListener({store,runtime,nowMs:()=>nowMs,challengeBytes:()=>Buffer.alloc(32,0x42),remoteChannelReady:(value)=>{remote=value;}});
  await listener.start();
  const credential=readVsCodeCompanionCredential(runtime.credentialPath,'1.2.3');
  const credentialBinding=binding(credential);
  connection=await connectVsCodeCompanion({credential,workspace,nowMs:()=>nowMs,randomBytes:(size)=>Buffer.alloc(size,size===16?0x31:0x32)});
  if(remote===undefined)throw new Error('remote channel not published');
  clientChannel=new VsCodeCommandChannel({connection,credentialBinding,collectWorkspace:handlers.collectWorkspace??(async()=>handlers.operationWorkspace??workspace),reviewHandler:handlers.review,implementationHandler:handlers.implementation,nowMs:()=>nowMs,randomBytes:(size)=>Buffer.alloc(size,0x55)});
  clientChannel.start();
  const controllerLeaseId=store.acquireController(sessionKey(enrollment,connection.sessionId,connection.connectionGeneration));
  return{enrollment,runtime,remote,workspace,controllerLeaseId};
}


async function readyUserReview(
  review: ConstructorParameters<typeof VsCodeCommandChannel>[0]['reviewHandler'],
  options: { collectWorkspace?:()=>Promise<IdeWorkspacePhysicalIdentity>; operationIdByte?:number } = {},
):Promise<{enrollment:NonNullable<ReturnType<IdeSessionStore['getEnrollment']>>;runtime:ReturnType<typeof createIdeCompanionRuntime>;workspace:IdeWorkspacePhysicalIdentity;sessionKey:ReturnType<typeof sessionKey>}>{
  const workspace=physical();
  const enrollment=store.createEnrollment({principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',ideProduct:'vscode',ideInstanceId:`ide_${'e'.repeat(32)}`,workspaceFingerprint:deriveIdeWorkspaceFingerprint({projectId:'quarangate',worktreeId:'forward',workspace}),baseRevision,capabilities:['request_review','cancel','observe_response']});
  const runtime=createIdeCompanionRuntime({runtimeRoot,enrollmentId:enrollment.enrollmentId,ideInstanceId:enrollment.ideInstanceId,ideProduct:'vscode',adapterVersion:'1.2.3'});
  listener=new IdeCompanionListener({
    store,runtime,nowMs:()=>nowMs,challengeBytes:()=>Buffer.alloc(32,0x42),
    userReviewIntents:true,
    userReviewIntentOperationIdBytes:(size)=>Buffer.alloc(size,options.operationIdByte??0x77),
  });
  await listener.start();
  const credential=readVsCodeCompanionCredential(runtime.credentialPath,'1.2.3');
  const credentialBinding=binding(credential);
  connection=await connectVsCodeCompanion({credential,workspace,nowMs:()=>nowMs,randomBytes:(size)=>Buffer.alloc(size,size===16?0x61:0x62)});
  clientChannel=new VsCodeCommandChannel({
    connection,credentialBinding,
    collectWorkspace:options.collectWorkspace??(async()=>workspace),
    reviewHandler:review,
    nowMs:()=>nowMs,randomBytes:(size)=>Buffer.alloc(size,0x55),
  });
  clientChannel.start();
  return{enrollment,runtime,workspace,sessionKey:sessionKey(enrollment,connection.sessionId,connection.connectionGeneration)};
}

beforeEach(()=>{
  store=new IdeSessionStore(join(mkdtempSync(join(tmpdir(),'qg-i22-ide-')),'ide.db'));
  writerStore=new AgentJobStore(join(mkdtempSync(join(tmpdir(),'qg-i22-writer-')),'agents.db'));
  const base=mkdtempSync(join(tmpdir(),'qg-i22-runtime-'));chmodSync(base,0o700);runtimeRoot=join(base,'r');mkdirSync(runtimeRoot,{mode:0o700});chmodSync(runtimeRoot,0o700);
});
afterEach(async()=>{clientChannel?.stop();connection?.close();if(listener)await listener.stop().catch(()=>undefined);store.close();writerStore.close();listener=undefined;connection=undefined;clientChannel=undefined;});

describe('P7 I2.2 QuaranGate-origin VS Code command/event transport',()=>{
  it('admits fresh client authorization through accepted B7 before a separate execute command runs review handler',async()=>{
    let runs=0;
    const ctx=await ready(['request_review','cancel','observe_response'],{review:{run:async(input)=>{runs+=1;input.emit('status','remote-review');}}});
    const operationId=`ideo_${'2'.repeat(32)}`;const prompt='review exact workspace';
    const authorizationPromise=ctx.remote.authorizeOperation({operationId,controllerLeaseId:ctx.controllerLeaseId,capability:'request_review',prompt});
    const authorization=await authorizationPromise;
    expect(runs).toBe(0);expect(store.getOperation(operationId)).toBeUndefined();
    const events:string[]=[];
    const coordinator=new IdeOperationCoordinator({store,runtime:ctx.runtime,adapter:ctx.remote.reviewAdapter(),nowMs:()=>nowMs});
    coordinator.startReview(authorization.auth,prompt,authorization.workspaceAttestation,(event)=>events.push(event.type));
    await waitFor(()=>store.getOperation(operationId)?.state==='COMPLETED');
    expect(runs).toBe(1);
    expect(store.getOperation(operationId)).toMatchObject({state:'COMPLETED',capability:'request_review'});
    expect(events).toEqual(['operation_started','status','completed']);
  });

  it('executes the supported public-API review model only after exact I2.2 authorization is durably admitted by B7',async()=>{
    let selected=0;let sends=0;let cancelled=false;
    const token:VsCodeCancellationToken={get isCancellationRequested(){return cancelled;}};
    const model={
      vendor:'approved-vendor',id:'approved-model',family:'approved-family',version:'2026-09',name:'Approved Model',maxInputTokens:4096,
      countTokens:async()=>5,
      sendRequest:async()=>{sends+=1;return{text:(async function*(){yield 'public-api-review';})()};},
    };
    const api:VsCodePublicLanguageModelApi={
      selectChatModels:async()=>{selected+=1;return[model];},
      canSendRequest:()=>true,
      createUserMessage:(prompt)=>({prompt} as unknown as VsCodeLanguageModelMessage),
      createCancellationTokenSource:()=>({token,cancel:()=>{cancelled=true;},dispose:()=>undefined}),
    };
    const access=new VsCodeModelAccessController(api,{vendor:model.vendor,id:model.id,family:model.family,version:model.version});
    expect(await access.prepareFromUserGesture()).toMatchObject({state:'MODEL_ACCESS_ALLOWED'});
    const publicApiHandler=new VsCodePublicApiReviewHandler({api,access:access.remoteAccess()});
    const ctx=await ready(['request_review','cancel','observe_response'],{review:publicApiHandler});
    const operationId=`ideo_${'a'.repeat(32)}`;const prompt='review through supported public api';
    const authorization=await ctx.remote.authorizeOperation({operationId,controllerLeaseId:ctx.controllerLeaseId,capability:'request_review',prompt});
    expect(selected).toBe(1);expect(sends).toBe(0);expect(store.getOperation(operationId)).toBeUndefined();
    const events:string[]=[];
    const coordinator=new IdeOperationCoordinator({store,runtime:ctx.runtime,adapter:ctx.remote.reviewAdapter(),nowMs:()=>nowMs});
    coordinator.startReview(authorization.auth,prompt,authorization.workspaceAttestation,(event)=>events.push(event.type));
    await waitFor(()=>store.getOperation(operationId)?.state==='COMPLETED');
    expect(sends).toBe(1);
    expect(events).toEqual(['operation_started','assistant_chunk','completed']);
    expect(store.getOperation(operationId)).toMatchObject({state:'COMPLETED',capability:'request_review'});
  });


  it('turns a user review intent into a QuaranGate-created B7 operation and sends the model only after durable admission starts',async()=>{
    let sends=0;let selected=0;let releaseWorkspace!:()=>void;let sawWorkspace!:()=>void;
    const workspaceGate=new Promise<void>((resolve)=>{releaseWorkspace=resolve;});
    const workspaceStarted=new Promise<void>((resolve)=>{sawWorkspace=resolve;});
    const token:VsCodeCancellationToken={isCancellationRequested:false};
    const model={
      vendor:'approved-vendor',id:'approved-model',family:'approved-family',version:'2026-09',name:'Approved Model',maxInputTokens:4096,
      countTokens:async()=>5,
      sendRequest:async()=>{sends+=1;return{text:(async function*(){yield 'governed-user-review';})()};},
    };
    const api:VsCodePublicLanguageModelApi={
      selectChatModels:async()=>{selected+=1;return[model];},canSendRequest:()=>true,
      createUserMessage:(prompt)=>({prompt} as unknown as VsCodeLanguageModelMessage),
      createCancellationTokenSource:()=>({token,cancel:()=>undefined,dispose:()=>undefined}),
    };
    const access=new VsCodeModelAccessController(api,{vendor:model.vendor,id:model.id,family:model.family,version:model.version});
    await access.prepareFromUserGesture();
    const handler=new VsCodePublicApiReviewHandler({api,access:access.remoteAccess()});
    const workspace=physical();
    const ctx=await readyUserReview(handler,{collectWorkspace:async()=>{sawWorkspace();await workspaceGate;return workspace;},operationIdByte:0x77});
    const output:string[]=[];
    const pending=clientChannel!.requestUserReview({prompt:'review user intent through B7',signal:new AbortController().signal,emit:(_type,message)=>output.push(message)});
    await workspaceStarted;
    const operationId=`ideo_${'77'.repeat(16)}`;
    expect(selected).toBe(1);
    expect(sends).toBe(0);
    expect(store.getOperation(operationId)).toBeUndefined();
    releaseWorkspace();
    await expect(pending).resolves.toEqual({operationId,terminalState:'COMPLETED'});
    expect(sends).toBe(1);
    expect(output).toEqual(['governed-user-review']);
    expect(store.getOperation(operationId)).toMatchObject({state:'COMPLETED',capability:'request_review',projectId:'quarangate',worktreeId:'forward'});
    expect(store.getSession(ctx.sessionKey.sessionId)).toMatchObject({state:'AVAILABLE',controllerLeaseId:null});
  });

  it('cancels a user review intent before B7 admission without creating a durable operation or sending the model',async()=>{
    let sends=0;let releaseWorkspace!:()=>void;let sawWorkspace!:()=>void;
    const workspaceGate=new Promise<void>((resolve)=>{releaseWorkspace=resolve;});
    const workspaceStarted=new Promise<void>((resolve)=>{sawWorkspace=resolve;});
    const model={vendor:'approved-vendor',id:'approved-model',family:'approved-family',version:'2026-09',name:'Approved Model',maxInputTokens:4096,countTokens:async()=>5,sendRequest:async()=>{sends+=1;return{text:(async function*(){yield 'never';})()};}};
    const api:VsCodePublicLanguageModelApi={selectChatModels:async()=>[model],canSendRequest:()=>true,createUserMessage:(prompt)=>({prompt} as unknown as VsCodeLanguageModelMessage),createCancellationTokenSource:()=>({token:{isCancellationRequested:false},cancel:()=>undefined,dispose:()=>undefined})};
    const access=new VsCodeModelAccessController(api,{vendor:model.vendor,id:model.id,family:model.family,version:model.version});await access.prepareFromUserGesture();
    const handler=new VsCodePublicApiReviewHandler({api,access:access.remoteAccess()});
    const workspace=physical();const ctx=await readyUserReview(handler,{collectWorkspace:async()=>{sawWorkspace();await workspaceGate;return workspace;},operationIdByte:0x78});
    const abort=new AbortController();
    const pending=clientChannel!.requestUserReview({prompt:'cancel before admission',signal:abort.signal,emit:()=>{}});
    await workspaceStarted;abort.abort();releaseWorkspace();
    await expect(pending).rejects.toMatchObject({code:'VSCODE_REMOTE_REVIEW_REJECTED'});
    expect(sends).toBe(0);
    expect(store.getOperation(`ideo_${'78'.repeat(16)}`)).toBeUndefined();
    await waitFor(()=>store.getSession(ctx.sessionKey.sessionId)?.state==='AVAILABLE');
  });

  it('rejects user review admission on fresh workspace drift and never sends the model',async()=>{
    let sends=0;
    const model={vendor:'approved-vendor',id:'approved-model',family:'approved-family',version:'2026-09',name:'Approved Model',maxInputTokens:4096,countTokens:async()=>5,sendRequest:async()=>{sends+=1;return{text:(async function*(){yield 'never';})()};}};
    const api:VsCodePublicLanguageModelApi={selectChatModels:async()=>[model],canSendRequest:()=>true,createUserMessage:(prompt)=>({prompt} as unknown as VsCodeLanguageModelMessage),createCancellationTokenSource:()=>({token:{isCancellationRequested:false},cancel:()=>undefined,dispose:()=>undefined})};
    const access=new VsCodeModelAccessController(api,{vendor:model.vendor,id:model.id,family:model.family,version:model.version});await access.prepareFromUserGesture();
    const handler=new VsCodePublicApiReviewHandler({api,access:access.remoteAccess()});
    const trusted=physical();const drifted={...trusted,filesystemIdentity:'f'.repeat(64)};
    const ctx=await readyUserReview(handler,{collectWorkspace:async()=>drifted,operationIdByte:0x79});
    const pending=clientChannel!.requestUserReview({prompt:'reject drift',signal:new AbortController().signal,emit:()=>{}});
    await expect(pending).rejects.toMatchObject({code:'VSCODE_REMOTE_REVIEW_REJECTED'});
    expect(sends).toBe(0);
    expect(store.getOperation(`ideo_${'79'.repeat(16)}`)).toBeUndefined();
    await waitFor(()=>store.getSession(ctx.sessionKey.sessionId)?.state==='AVAILABLE');
  });

  it('rejects user review admission when the authenticated session already has a controller and never sends the model',async()=>{
    let sends=0;
    const model={vendor:'approved-vendor',id:'approved-model',family:'approved-family',version:'2026-09',name:'Approved Model',maxInputTokens:4096,countTokens:async()=>5,sendRequest:async()=>{sends+=1;return{text:(async function*(){yield 'never';})()};}};
    const api:VsCodePublicLanguageModelApi={selectChatModels:async()=>[model],canSendRequest:()=>true,createUserMessage:(prompt)=>({prompt} as unknown as VsCodeLanguageModelMessage),createCancellationTokenSource:()=>({token:{isCancellationRequested:false},cancel:()=>undefined,dispose:()=>undefined})};
    const access=new VsCodeModelAccessController(api,{vendor:model.vendor,id:model.id,family:model.family,version:model.version});await access.prepareFromUserGesture();
    const ctx=await readyUserReview(new VsCodePublicApiReviewHandler({api,access:access.remoteAccess()}),{operationIdByte:0x7a});
    const outsideLease=store.acquireController(ctx.sessionKey);
    const pending=clientChannel!.requestUserReview({prompt:'controller conflict',signal:new AbortController().signal,emit:()=>{}});
    await expect(pending).rejects.toMatchObject({code:'VSCODE_REMOTE_REVIEW_REJECTED'});
    expect(sends).toBe(0);expect(store.getOperation(`ideo_${'7a'.repeat(16)}`)).toBeUndefined();
    store.releaseController(ctx.sessionKey,outsideLease);
  });

  it('cancels exactly the admitted user review during model streaming and emits no late completion',async()=>{
    let sends=0;let cancelled=false;let release!:()=>void;
    const gate=new Promise<void>((resolve)=>{release=resolve;});
    const token:VsCodeCancellationToken={get isCancellationRequested(){return cancelled;}};
    const model={vendor:'approved-vendor',id:'approved-model',family:'approved-family',version:'2026-09',name:'Approved Model',maxInputTokens:4096,countTokens:async()=>5,sendRequest:async()=>{sends+=1;return{text:(async function*(){yield 'before-cancel';await gate;if(!cancelled)yield 'late';})()};}};
    const api:VsCodePublicLanguageModelApi={selectChatModels:async()=>[model],canSendRequest:()=>true,createUserMessage:(prompt)=>({prompt} as unknown as VsCodeLanguageModelMessage),createCancellationTokenSource:()=>({token,cancel:()=>{cancelled=true;release();},dispose:()=>undefined})};
    const access=new VsCodeModelAccessController(api,{vendor:model.vendor,id:model.id,family:model.family,version:model.version});await access.prepareFromUserGesture();
    const ctx=await readyUserReview(new VsCodePublicApiReviewHandler({api,access:access.remoteAccess()}),{operationIdByte:0x7b});
    const abort=new AbortController();const output:string[]=[];
    const pending=clientChannel!.requestUserReview({prompt:'cancel exact governed review',signal:abort.signal,emit:(_type,message)=>{output.push(message);if(message==='before-cancel')abort.abort();}});
    await expect(pending).resolves.toEqual({operationId:`ideo_${'7b'.repeat(16)}`,terminalState:'CANCELLED'});
    expect(sends).toBe(1);expect(cancelled).toBe(true);expect(output).toEqual(['before-cancel']);
    expect(store.getOperation(`ideo_${'7b'.repeat(16)}`)?.state).toBe('CANCELLED');
    await waitFor(()=>store.getSession(ctx.sessionKey.sessionId)?.state==='AVAILABLE');
  });

  it('rejects a user review on a closed/stale authenticated channel before admission and never sends the model',async()=>{
    let sends=0;
    const handler={run:async()=>{sends+=1;}};
    await readyUserReview(handler,{operationIdByte:0x7c});
    const stale=clientChannel!;
    stale.stop();clientChannel=undefined;connection=undefined;
    await expect(stale.requestUserReview({prompt:'stale generation',signal:new AbortController().signal,emit:()=>{}})).rejects.toMatchObject({code:'VSCODE_REMOTE_CHANNEL_CLOSED'});
    expect(sends).toBe(0);
    expect(store.getOperation(`ideo_${'7c'.repeat(16)}`)).toBeUndefined();
  });

  it('admits implementation but treats remote completion as untrusted and retains exact writer uncertainty',async()=>{
    let runs=0;
    const ctx=await ready(['request_implementation','cancel','observe_response'],{implementation:{run:async(input)=>{runs+=1;input.emit('status','remote-implementation');return{outcome:'completed'};}}});
    const operationId=`ideo_${'3'.repeat(32)}`;const prompt='implement bounded change';
    const authorization=await ctx.remote.authorizeOperation({operationId,controllerLeaseId:ctx.controllerLeaseId,capability:'request_implementation',prompt});
    expect(runs).toBe(0);
    const probe=writerStore.acquireLiveWriterLease({projectId:'quarangate',worktreeId:'forward',ownerKind:'ide',ownerId:`ideo_${'9'.repeat(32)}`,principalId:'probe'});
    writerStore.releaseLiveWriterLease({projectId:'quarangate',worktreeId:'forward',ownerKind:'ide',ownerId:`ideo_${'9'.repeat(32)}`,principalId:'probe',writerLeaseId:probe.writerLeaseId,reason:'prove pre-execution writer is free'});
    const coordinator=new IdeImplementationCoordinator({store,writerStore,runtime:ctx.runtime,adapter:ctx.remote.implementationAdapter(),nowMs:()=>nowMs});
    coordinator.startImplementation(authorization.auth,prompt,authorization.workspaceAttestation,()=>{});
    await waitFor(()=>store.getOperation(operationId)?.state==='INDETERMINATE');
    const op=store.getOperation(operationId)!;
    expect(runs).toBe(1);expect(op).toMatchObject({state:'INDETERMINATE',capability:'request_implementation',writerSettlement:'UNCERTAIN'});
    expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
  });

  it('fresh operation authorization re-reads current B4 secret so rotation after connection invalidates the old bootstrap secret without reconnect',async()=>{
    const ctx=await ready(['request_review','cancel','observe_response'],{review:{run:async()=>{}}});
    const { rotateIdeCompanionSecret }=await import('../../src/executor/ide/ideCompanionRuntime.js');
    rotateIdeCompanionSecret(ctx.runtime);
    const operationId=`ideo_${'4'.repeat(32)}`;const prompt='review after rotation';
    const authorization=await ctx.remote.authorizeOperation({operationId,controllerLeaseId:ctx.controllerLeaseId,capability:'request_review',prompt});
    const coordinator=new IdeOperationCoordinator({store,runtime:ctx.runtime,adapter:ctx.remote.reviewAdapter(),nowMs:()=>nowMs});
    coordinator.startReview(authorization.auth,prompt,authorization.workspaceAttestation,()=>{});
    await waitFor(()=>store.getOperation(operationId)?.state==='COMPLETED');
    expect(store.getOperation(operationId)?.state).toBe('COMPLETED');
  });

  it('fresh per-operation workspace drift is denied by B5 before execute, so remote handler never runs',async()=>{
    let runs=0;const base=physical();const drift={...base,filesystemIdentity:'f'.repeat(64)};
    const ctx=await ready(['request_review','cancel','observe_response'],{review:{run:async()=>{runs+=1;}},operationWorkspace:drift});
    const operationId=`ideo_${'5'.repeat(32)}`;const prompt='deny drifted operation workspace';
    const authorization=await ctx.remote.authorizeOperation({operationId,controllerLeaseId:ctx.controllerLeaseId,capability:'request_review',prompt});
    const coordinator=new IdeOperationCoordinator({store,runtime:ctx.runtime,adapter:ctx.remote.reviewAdapter(),nowMs:()=>nowMs});
    expect(()=>coordinator.startReview(authorization.auth,prompt,authorization.workspaceAttestation,()=>{})).toThrow();
    expect(ctx.remote.discardAuthorization(operationId)).toBe(true);
    expect(store.getOperation(operationId)).toBeUndefined();expect(runs).toBe(0);
  });

  it('re-attests exact B5 workspace before implementation and keeps B8 writer uncertain when the remote client claims safe pre-mutation failure',async()=>{
    let runs=0;let current=physical();
    const ctx=await ready(['request_implementation','cancel','observe_response'],{
      collectWorkspace:async()=>current,
      implementation:{run:async()=>{runs+=1;return{outcome:'completed'};}},
    });
    const operationId=`ideo_${'8'.repeat(32)}`;const prompt='implementation must not cross workspace drift';
    const authorization=await ctx.remote.authorizeOperation({operationId,controllerLeaseId:ctx.controllerLeaseId,capability:'request_implementation',prompt});
    current={...current,filesystemIdentity:'f'.repeat(64)};
    const coordinator=new IdeImplementationCoordinator({store,writerStore,runtime:ctx.runtime,adapter:ctx.remote.implementationAdapter(),nowMs:()=>nowMs});
    coordinator.startImplementation(authorization.auth,prompt,authorization.workspaceAttestation,()=>{});
    await waitFor(()=>store.getOperation(operationId)?.state==='INDETERMINATE');
    const op=store.getOperation(operationId)!;
    expect(runs).toBe(0);
    expect(op).toMatchObject({state:'INDETERMINATE',writerSettlement:'UNCERTAIN'});
    expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
  });

  it('secret rotation after authorization but before B7 admission invalidates the stale operation MAC and never executes',async()=>{
    let runs=0;const ctx=await ready(['request_review','cancel','observe_response'],{review:{run:async()=>{runs+=1;}}});
    const operationId=`ideo_${'9'.repeat(32)}`;const prompt='stale authorization must fail';
    const authorization=await ctx.remote.authorizeOperation({operationId,controllerLeaseId:ctx.controllerLeaseId,capability:'request_review',prompt});
    const { rotateIdeCompanionSecret }=await import('../../src/executor/ide/ideCompanionRuntime.js');
    rotateIdeCompanionSecret(ctx.runtime);
    const coordinator=new IdeOperationCoordinator({store,runtime:ctx.runtime,adapter:ctx.remote.reviewAdapter(),nowMs:()=>nowMs});
    expect(()=>coordinator.startReview(authorization.auth,prompt,authorization.workspaceAttestation,()=>{})).toThrow();
    expect(ctx.remote.discardAuthorization(operationId)).toBe(true);
    expect(store.getOperation(operationId)).toBeUndefined();expect(runs).toBe(0);
  });

  it('B7 timeout aborts exactly the active remote operation and cannot become false completion',async()=>{
    let aborted=false;
    const ctx=await ready(['request_review','cancel','observe_response'],{review:{run:async(input)=>{await new Promise<void>(resolve=>{if(input.signal.aborted){aborted=true;resolve();return;}input.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});});}}});
    const operationId=`ideo_${'6'.repeat(32)}`;const prompt='bounded remote review';
    const authorization=await ctx.remote.authorizeOperation({operationId,controllerLeaseId:ctx.controllerLeaseId,capability:'request_review',prompt});
    const coordinator=new IdeOperationCoordinator({store,runtime:ctx.runtime,adapter:ctx.remote.reviewAdapter(),nowMs:()=>nowMs,maxRuntimeMs:20});
    coordinator.startReview(authorization.auth,prompt,authorization.workspaceAttestation,()=>{});
    await waitFor(()=>store.getOperation(operationId)?.state==='INDETERMINATE');
    await waitFor(()=>aborted);
    expect(store.getOperation(operationId)?.state).toBe('INDETERMINATE');
  });

  it('remote-mode listener refuses simultaneous client-origin operation adapter configuration',()=>{
    const workspace=physical();const enrollment=store.createEnrollment({principalId:'chatgpt-browser',projectId:'quarangate',worktreeId:'forward',ideProduct:'vscode',ideInstanceId:`ide_${'7'.repeat(32)}`,workspaceFingerprint:deriveIdeWorkspaceFingerprint({projectId:'quarangate',worktreeId:'forward',workspace}),baseRevision,capabilities:['request_review']});
    const runtime=createIdeCompanionRuntime({runtimeRoot,enrollmentId:enrollment.enrollmentId,ideInstanceId:enrollment.ideInstanceId,ideProduct:'vscode',adapterVersion:'1.2.3'});
    expect(()=>new IdeCompanionListener({store,runtime,operationAdapter:{run:async()=>{}},remoteChannelReady:()=>{}})).toThrowError(/cannot share one socket/);
  });
});
