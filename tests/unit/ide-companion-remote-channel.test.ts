import { describe, expect, it } from 'vitest';
import { hashIdeCompanionPayload, signIdeCompanionEnvelope } from '../../src/shared/ideCompanionAuth.js';
import { serializeIdeCompanionReviewPayload } from '../../src/shared/ideCompanionOperations.js';
import { serializeIdeRemoteClientFrame, type IdeRemoteServerFrame } from '../../src/shared/ideCompanionRemoteTransport.js';
import { serializeIdeWorkspaceAttestation } from '../../src/shared/ideWorkspaceAttestation.js';
import { IdeCompanionRemoteChannel, IdeCompanionRemoteChannelError } from '../../src/executor/ide/ideCompanionRemoteChannel.js';
import { deriveIdeEnvironmentIdentity, deriveIdeFilesystemIdentity } from '../../src/shared/ideWorkspaceAttestation.js';

const sessionId=`ides_${'1'.repeat(32)}`;const operationId=`ideo_${'2'.repeat(32)}`;const lease=`idectl_${'3'.repeat(32)}`;
const secret=Buffer.alloc(32,0x41);
const workspace=serializeIdeWorkspaceAttestation({
  version:1,enrollmentId:`iden_${'4'.repeat(32)}`,ideInstanceId:`ide_${'5'.repeat(32)}`,runtimeInstanceId:`iderun_${'6'.repeat(32)}`,
  ideProduct:'vscode',adapterId:'quarangate-vscode-companion',adapterVersion:'1.2.3',sessionId,connectionGeneration:7,
  workspace:{workspaceFolderCount:1,remoteKind:'wsl',environmentIdentity:deriveIdeEnvironmentIdentity('wsl','stable'),pathFlavor:'posix',caseMode:'case-sensitive',canonicalization:'realpath-exact',workspaceUri:'file:///srv/qg',canonicalPath:'/srv/qg',filesystemIdentity:deriveIdeFilesystemIdentity('posix','1','2'),git:{kind:'none'}},
});
function auth(prompt='review'){return signIdeCompanionEnvelope(secret,{version:1,enrollmentId:`iden_${'4'.repeat(32)}`,ideInstanceId:`ide_${'5'.repeat(32)}`,sessionId,connectionGeneration:7,controllerLeaseId:lease,operationId,capability:'request_review',nonce:Buffer.alloc(32,0x42).toString('base64url'),issuedAtMs:1_800_000_000_000,expiresAtMs:1_800_000_020_000,payloadSha256:hashIdeCompanionPayload(serializeIdeCompanionReviewPayload(prompt,workspace))});}
function harness(){const sent:IdeRemoteServerFrame[]=[];let closed=false;const ch=new IdeCompanionRemoteChannel({sessionId,connectionGeneration:7,send:(f)=>{sent.push(f);return true;},close:()=>{closed=true;},isOperationAdmitted:()=>true,authorizationTimeoutMs:1000});ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'transport_ready',sessionId,connectionGeneration:7}));return{ch,sent,get closed(){return closed;}};}
function authorizedFrame(prompt='review',over:Record<string,unknown>={}){return serializeIdeRemoteClientFrame({version:1,type:'operation_authorized',sessionId,connectionGeneration:7,commandSequence:1,operationId,auth:auth(prompt),workspaceAttestation:workspace,...over} as never);}

describe('P7 I2.2 QuaranGate remote channel state machine',()=>{
  it('does not send authorization until client transport_ready removes post-B6 startup race',async()=>{
    const sent:IdeRemoteServerFrame[]=[];const ch=new IdeCompanionRemoteChannel({sessionId,connectionGeneration:7,send:(f)=>{sent.push(f);return true;},close:()=>{},isOperationAdmitted:()=>true,authorizationTimeoutMs:1000});
    const pending=ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});expect(sent).toEqual([]);
    ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'transport_ready',sessionId,connectionGeneration:7}));await new Promise(r=>setTimeout(r,0));expect(sent[0]).toMatchObject({type:'authorize_operation',commandSequence:1});
    ch.handleClientFrame(authorizedFrame());await pending;
  });

  it('requires two phases: authorize first, then execute through adapter',async()=>{
    const h=harness();const p=h.ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});
    expect(h.sent).toHaveLength(1);expect(h.sent[0]).toMatchObject({type:'authorize_operation',commandSequence:1,operationId});
    h.ch.handleClientFrame(authorizedFrame());await expect(p).resolves.toMatchObject({operationId,commandSequence:1});
    const events:string[]=[];const run=h.ch.reviewAdapter().run({operationId,sessionId,connectionGeneration:7,prompt:'review',signal:new AbortController().signal,emit:(t)=>events.push(t)});
    expect(h.sent[1]).toMatchObject({type:'execute_operation',commandSequence:2,operationId});
    h.ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'adapter_event',sessionId,connectionGeneration:7,operationId,eventSequence:0,eventType:'status'}));
    h.ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'review_result',sessionId,connectionGeneration:7,operationId,eventSequence:1,result:'completed'}));
    await expect(run).resolves.toBeUndefined();expect(events).toEqual(['status']);expect(h.closed).toBe(false);
  });
  it('rejects execution without exact prior authorization',async()=>{
    const h=harness();await expect(h.ch.reviewAdapter().run({operationId,sessionId,connectionGeneration:7,prompt:'review',signal:new AbortController().signal,emit:()=>{}})).rejects.toMatchObject({code:'IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID'});
    expect(h.sent).toEqual([]);
  });
  it('rejects returned authorization that does not bind exact prompt hash and closes fail-closed',async()=>{
    const h=harness();const p=h.ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'expected'});
    h.ch.handleClientFrame(authorizedFrame('other'));
    await expect(p).rejects.toBeInstanceOf(IdeCompanionRemoteChannelError);expect(h.closed).toBe(true);
  });
  it('rejects replay/gap event sequence and closes channel',async()=>{
    const h=harness();const p=h.ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});h.ch.handleClientFrame(authorizedFrame());await p;
    const run=h.ch.reviewAdapter().run({operationId,sessionId,connectionGeneration:7,prompt:'review',signal:new AbortController().signal,emit:()=>{}});
    h.ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'adapter_event',sessionId,connectionGeneration:7,operationId,eventSequence:1,eventType:'status'}));
    await expect(run).rejects.toMatchObject({code:'IDE_REMOTE_CHANNEL_SEQUENCE'});expect(h.closed).toBe(true);
  });
  it('maps AbortSignal to one exact cancel command and requires exact cancel ack',async()=>{
    const h=harness();const p=h.ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});h.ch.handleClientFrame(authorizedFrame());await p;
    const ctl=new AbortController();const run=h.ch.reviewAdapter().run({operationId,sessionId,connectionGeneration:7,prompt:'review',signal:ctl.signal,emit:()=>{}});ctl.abort();
    expect(h.sent[2]).toMatchObject({type:'cancel_operation',commandSequence:3,operationId});
    h.ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'cancel_ack',sessionId,connectionGeneration:7,commandSequence:3,operationId}));
    h.ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'review_result',sessionId,connectionGeneration:7,operationId,eventSequence:0,result:'cancelled'}));
    await expect(run).rejects.toBeInstanceOf(IdeCompanionRemoteChannelError);expect(h.closed).toBe(false);
  });
  it('refuses remote adapter execution when Plane-B durable admission reread is absent',async()=>{
    const sent:IdeRemoteServerFrame[]=[];const ch=new IdeCompanionRemoteChannel({sessionId,connectionGeneration:7,send:(f)=>{sent.push(f);return true;},close:()=>{},isOperationAdmitted:()=>false,authorizationTimeoutMs:1000});
    ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'transport_ready',sessionId,connectionGeneration:7}));
    const p=ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});ch.handleClientFrame(authorizedFrame());await p;
    await expect(ch.reviewAdapter().run({operationId,sessionId,connectionGeneration:7,prompt:'review',signal:new AbortController().signal,emit:()=>{}})).rejects.toMatchObject({code:'IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID'});
    expect(sent).toHaveLength(1);
    expect(ch.discardAuthorization(operationId)).toBe(true);
  });

  it('orders execute before cancel when adapter signal is already aborted',async()=>{
    const h=harness();const p=h.ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});h.ch.handleClientFrame(authorizedFrame());await p;
    const ctl=new AbortController();ctl.abort();const run=h.ch.reviewAdapter().run({operationId,sessionId,connectionGeneration:7,prompt:'review',signal:ctl.signal,emit:()=>{}});
    expect(h.sent[1]).toMatchObject({type:'execute_operation',commandSequence:2});
    expect(h.sent[2]).toMatchObject({type:'cancel_operation',commandSequence:3});
    h.ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'cancel_ack',sessionId,connectionGeneration:7,commandSequence:3,operationId}));
    h.ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'review_result',sessionId,connectionGeneration:7,operationId,eventSequence:0,result:'cancelled'}));
    await expect(run).rejects.toBeInstanceOf(IdeCompanionRemoteChannelError);
  });

  it('bounds transport_ready wait and closes if the authenticated client never upgrades to I2.2 transport',async()=>{
    let closed=false;const ch=new IdeCompanionRemoteChannel({sessionId,connectionGeneration:7,send:()=>true,close:()=>{closed=true;},isOperationAdmitted:()=>true,authorizationTimeoutMs:10});
    const pending=ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});
    await expect(pending).rejects.toMatchObject({code:'IDE_REMOTE_CHANNEL_TIMEOUT'});
    expect(closed).toBe(true);
  });

  it('treats a thrown/failed server send as fail-closed instead of leaving reusable authorization state',async()=>{
    let closed=false;const ch=new IdeCompanionRemoteChannel({sessionId,connectionGeneration:7,send:()=>{throw new Error('write failed');},close:()=>{closed=true;},isOperationAdmitted:()=>true,authorizationTimeoutMs:1000});
    ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'transport_ready',sessionId,connectionGeneration:7}));
    await expect(ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'})).rejects.toMatchObject({code:'IDE_REMOTE_CHANNEL_SEND_FAILED'});
    expect(closed).toBe(true);
    expect(()=>ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'})).toThrowError(/closed/);
  });

  it('rejects cross-session authorization reflection and closes the exact channel',async()=>{
    const h=harness();const pending=h.ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});
    const otherSession=`ides_${'a'.repeat(32)}`;
    h.ch.handleClientFrame(authorizedFrame('review',{sessionId:otherSession}));
    await expect(pending).rejects.toMatchObject({code:'IDE_REMOTE_CHANNEL_BINDING_MISMATCH'});expect(h.closed).toBe(true);
  });

  it('cancel send failure rejects the active adapter immediately without relying on a later socket close callback',async()=>{
    const sent:IdeRemoteServerFrame[]=[];let closed=false;
    const ch=new IdeCompanionRemoteChannel({sessionId,connectionGeneration:7,send:(f)=>{sent.push(f);return f.type!=='cancel_operation';},close:()=>{closed=true;},isOperationAdmitted:()=>true,authorizationTimeoutMs:1000});
    ch.handleClientFrame(serializeIdeRemoteClientFrame({version:1,type:'transport_ready',sessionId,connectionGeneration:7}));
    const p=ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});ch.handleClientFrame(authorizedFrame());await p;
    const ctl=new AbortController();const run=ch.reviewAdapter().run({operationId,sessionId,connectionGeneration:7,prompt:'review',signal:ctl.signal,emit:()=>{}});
    ctl.abort();
    expect(sent.at(-1)).toMatchObject({type:'cancel_operation',operationId});
    await expect(run).rejects.toMatchObject({code:'IDE_REMOTE_CHANNEL_CLOSED'});
    expect(closed).toBe(true);
  });

  it('connection close rejects pending authorization and active execution',async()=>{
    const h=harness();const pending=h.ch.authorizeOperation({operationId,controllerLeaseId:lease,capability:'request_review',prompt:'review'});h.ch.connectionClosed();await expect(pending).rejects.toMatchObject({code:'IDE_REMOTE_CHANNEL_CLOSED'});
  });
});
