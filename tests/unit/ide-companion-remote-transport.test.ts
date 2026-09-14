import { describe, expect, it } from 'vitest';
import { signIdeCompanionEnvelope } from '../../src/shared/ideCompanionAuth.js';
import {
  IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES,
  IdeRemoteTransportError,
  parseIdeRemoteClientFrame,
  parseIdeRemoteServerFrame,
  serializeIdeRemoteClientFrame,
  serializeIdeRemoteServerFrame,
  type IdeRemoteClientFrame,
  type IdeRemoteServerFrame,
} from '../../src/shared/ideCompanionRemoteTransport.js';

const sessionId=`ides_${'1'.repeat(32)}`;
const operationId=`ideo_${'2'.repeat(32)}`;
const controllerLeaseId=`idectl_${'3'.repeat(32)}`;
const secret=Buffer.alloc(32,0x44);
function auth(){return signIdeCompanionEnvelope(secret,{
  version:1,enrollmentId:`iden_${'4'.repeat(32)}`,ideInstanceId:`ide_${'5'.repeat(32)}`,sessionId,
  connectionGeneration:7,controllerLeaseId,operationId,capability:'request_review',nonce:Buffer.alloc(32,0x66).toString('base64url'),
  issuedAtMs:1_800_000_000_000,expiresAtMs:1_800_000_020_000,payloadSha256:'a'.repeat(64),
});}
function server(over:Partial<IdeRemoteServerFrame>={}):IdeRemoteServerFrame{return{
  version:1,type:'authorize_operation',sessionId,connectionGeneration:7,commandSequence:1,operationId,controllerLeaseId,
  capability:'request_review',prompt:'review this',...over,
} as IdeRemoteServerFrame;}
function client(over:Partial<IdeRemoteClientFrame>={}):IdeRemoteClientFrame{return{
  version:1,type:'operation_authorized',sessionId,connectionGeneration:7,commandSequence:1,operationId,auth:auth(),
  workspaceAttestation:'{"x":"bounded-attestation-placeholder"}',...over,
} as IdeRemoteClientFrame;}
function code(fn:()=>unknown):string{try{fn();throw new Error('expected error');}catch(error){if(error instanceof IdeRemoteTransportError)return error.code;throw error;}}

describe('P7 I2.2 direction-separated remote transport protocol',()=>{
  it('round-trips canonical authorize/execute/cancel server frames',()=>{
    const a=server();expect(parseIdeRemoteServerFrame(serializeIdeRemoteServerFrame(a))).toEqual(a);
    const e:IdeRemoteServerFrame={version:1,type:'execute_operation',sessionId,connectionGeneration:7,commandSequence:2,operationId,capability:'request_review'};
    expect(parseIdeRemoteServerFrame(serializeIdeRemoteServerFrame(e))).toEqual(e);
    const c:IdeRemoteServerFrame={version:1,type:'cancel_operation',sessionId,connectionGeneration:7,commandSequence:3,operationId};
    expect(parseIdeRemoteServerFrame(serializeIdeRemoteServerFrame(c))).toEqual(c);
  });
  it('round-trips canonical authorization/event/result/cancel-ack client frames',()=>{
    const ready:IdeRemoteClientFrame={version:1,type:'transport_ready',sessionId,connectionGeneration:7};expect(parseIdeRemoteClientFrame(serializeIdeRemoteClientFrame(ready))).toEqual(ready);
    const a=client();expect(parseIdeRemoteClientFrame(serializeIdeRemoteClientFrame(a))).toEqual(a);
    const ev:IdeRemoteClientFrame={version:1,type:'adapter_event',sessionId,connectionGeneration:7,operationId,eventSequence:0,eventType:'status',message:'working'};
    expect(parseIdeRemoteClientFrame(serializeIdeRemoteClientFrame(ev))).toEqual(ev);
    const rr:IdeRemoteClientFrame={version:1,type:'review_result',sessionId,connectionGeneration:7,operationId,eventSequence:1,result:'completed'};
    expect(parseIdeRemoteClientFrame(serializeIdeRemoteClientFrame(rr))).toEqual(rr);
    const ir:IdeRemoteClientFrame={version:1,type:'implementation_result',sessionId,connectionGeneration:7,operationId,eventSequence:1,outcome:'indeterminate'};
    expect(parseIdeRemoteClientFrame(serializeIdeRemoteClientFrame(ir))).toEqual(ir);
    const ack:IdeRemoteClientFrame={version:1,type:'cancel_ack',sessionId,connectionGeneration:7,commandSequence:3,operationId};
    expect(parseIdeRemoteClientFrame(serializeIdeRemoteClientFrame(ack))).toEqual(ack);
  });
  it('rejects noncanonical key order and unknown fields in both directions',()=>{
    const text=serializeIdeRemoteServerFrame(server());const parsed=JSON.parse(text) as Record<string,unknown>;
    expect(code(()=>parseIdeRemoteServerFrame(JSON.stringify({version:parsed.version,...parsed})))).toBe('IDE_REMOTE_INVALID_SCHEMA');
    expect(code(()=>parseIdeRemoteServerFrame(JSON.stringify({...parsed,extra:true})))).toBe('IDE_REMOTE_INVALID_SCHEMA');
    const c=JSON.parse(serializeIdeRemoteClientFrame(client())) as Record<string,unknown>;
    expect(code(()=>parseIdeRemoteClientFrame(JSON.stringify({...c,extra:true})))).toBe('IDE_REMOTE_INVALID_SCHEMA');
  });
  it('rejects unsupported versions, bad IDs, nonpositive command sequence and wrong capability',()=>{
    expect(code(()=>parseIdeRemoteServerFrame(JSON.stringify({...JSON.parse(serializeIdeRemoteServerFrame(server())),version:2})))).toBe('IDE_REMOTE_UNSUPPORTED_VERSION');
    expect(code(()=>serializeIdeRemoteServerFrame(server({operationId:'bad'} as Partial<IdeRemoteServerFrame>)))).toBe('IDE_REMOTE_INVALID_SCHEMA');
    expect(code(()=>serializeIdeRemoteServerFrame(server({commandSequence:0} as Partial<IdeRemoteServerFrame>)))).toBe('IDE_REMOTE_INVALID_SCHEMA');
    expect(code(()=>serializeIdeRemoteServerFrame(server({capability:'prompt'} as unknown as Partial<IdeRemoteServerFrame>)))).toBe('IDE_REMOTE_INVALID_SCHEMA');
  });
  it('enforces prompt, attestation, event-message and total frame bounds',()=>{
    expect(code(()=>serializeIdeRemoteServerFrame(server({prompt:'x'.repeat(16*1024+1)} as Partial<IdeRemoteServerFrame>)))).toBe('IDE_REMOTE_INVALID_SCHEMA');
    expect(code(()=>serializeIdeRemoteClientFrame(client({workspaceAttestation:'x'.repeat(16*1024+1)} as Partial<IdeRemoteClientFrame>)))).toBe('IDE_REMOTE_INVALID_SCHEMA');
    const ev:IdeRemoteClientFrame={version:1,type:'adapter_event',sessionId,connectionGeneration:7,operationId,eventSequence:0,eventType:'status',message:'x'.repeat(8*1024+1)};
    expect(code(()=>serializeIdeRemoteClientFrame(ev))).toBe('IDE_REMOTE_INVALID_SCHEMA');
    expect(code(()=>parseIdeRemoteServerFrame('x'.repeat(IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES+1)))).toBe('IDE_REMOTE_FRAME_SIZE');
  });
  it('rejects invalid nested auth instead of treating a structurally shaped object as authority',()=>{
    const row=JSON.parse(serializeIdeRemoteClientFrame(client())) as Record<string,unknown>;
    row.auth={...(row.auth as Record<string,unknown>),mac:'0'.repeat(63)};
    expect(code(()=>parseIdeRemoteClientFrame(JSON.stringify(row)))).toBe('IDE_REMOTE_INVALID_SCHEMA');
  });
  it('rejects direction reflection so client frames cannot parse as QuaranGate commands and server frames cannot parse as client events',()=>{
    expect(code(()=>parseIdeRemoteServerFrame(serializeIdeRemoteClientFrame(client())))).toBe('IDE_REMOTE_INVALID_SCHEMA');
    expect(code(()=>parseIdeRemoteClientFrame(serializeIdeRemoteServerFrame(server())))).toBe('IDE_REMOTE_INVALID_SCHEMA');
  });
  it('rejects invalid UTF-8 before JSON parsing',()=>{
    expect(code(()=>parseIdeRemoteClientFrame(Buffer.from([0xc3,0x28])))).toBe('IDE_REMOTE_INVALID_UTF8');
  });
});
