import { describe, expect, it } from 'vitest';
import { hashIdeCompanionPayload, signIdeCompanionEnvelope } from '../../src/shared/ideCompanionAuth.js';
import {
  IDE_COMPANION_OPERATION_MAX_FRAME_BYTES,
  IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES,
  IdeCompanionOperationProtocolError,
  parseIdeCompanionOperationControlFrame,
  serializeIdeCompanionOperationControlFrame,
  serializeIdeCompanionReviewPayload,
  type IdeCompanionOperationControlFrame,
} from '../../src/shared/ideCompanionOperations.js';

const secret=Buffer.alloc(32,0x71);
const workspaceAttestation='workspace-attestation-bytes';
function auth(capability:'request_review'|'cancel'|'request_implementation'='request_review',payload='review this'){
  return signIdeCompanionEnvelope(secret,{
    version:1,enrollmentId:`iden_${'1'.repeat(32)}`,ideInstanceId:`ide_${'2'.repeat(32)}`,
    sessionId:`ides_${'3'.repeat(32)}`,connectionGeneration:1,controllerLeaseId:`idectl_${'4'.repeat(32)}`,
    operationId:`ideo_${'5'.repeat(32)}`,capability,nonce:Buffer.alloc(32,0x61).toString('base64url'),
    issuedAtMs:1_800_000_000_000,expiresAtMs:1_800_000_020_000,payloadSha256:hashIdeCompanionPayload(payload),
  });
}
function code(fn:()=>unknown):string{try{fn();return'NO_ERROR';}catch(error){return error instanceof IdeCompanionOperationProtocolError?error.code:'OTHER_ERROR';}}

describe('P7 B7 companion operation-control protocol',()=>{
  it('round-trips exact controller acquire/release frames',()=>{
    for(const type of ['acquire_controller','release_controller'] as const){
      const text=serializeIdeCompanionOperationControlFrame({version:1,type});
      expect(parseIdeCompanionOperationControlFrame(text)).toEqual({version:1,type});
    }
  });

  it('round-trips one canonical authenticated request_review start',()=>{
    const prompt='bounded review request';
    const frame:IdeCompanionOperationControlFrame={version:1,type:'start_review',auth:auth('request_review',serializeIdeCompanionReviewPayload(prompt,workspaceAttestation)),prompt,workspaceAttestation};
    const text=serializeIdeCompanionOperationControlFrame(frame);
    expect(parseIdeCompanionOperationControlFrame(text)).toEqual(frame);
    expect(Buffer.byteLength(text)).toBeLessThan(IDE_COMPANION_OPERATION_MAX_FRAME_BYTES);
  });

  it('round-trips exact-operation cancel with empty authenticated payload',()=>{
    const frame:IdeCompanionOperationControlFrame={version:1,type:'cancel_operation',auth:auth('cancel','')};
    expect(parseIdeCompanionOperationControlFrame(serializeIdeCompanionOperationControlFrame(frame))).toEqual(frame);
  });

  it('denies generic prompt and request_implementation as B7 start authorities',()=>{
    const prompt='x';
    const payload=serializeIdeCompanionReviewPayload(prompt,workspaceAttestation);
    const promptAuth={...auth('request_review',payload),capability:'prompt' as const};
    expect(code(()=>serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth:promptAuth,prompt,workspaceAttestation}))).toBe('IDE_OPERATION_CAPABILITY_DENIED');
    const writer={...auth('request_review',payload),capability:'request_implementation' as const};
    // B3 itself excludes request_implementation, so B7 never gets a writer-capable auth envelope.
    expect(code(()=>serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth:writer,prompt,workspaceAttestation}))).toBe('IDE_OPERATION_INVALID_SCHEMA');
  });

  it('enforces non-empty 16 KiB prompt and 24 KiB frame bounds',()=>{
    expect(code(()=>serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth:auth('request_review',''),prompt:'',workspaceAttestation}))).toBe('IDE_OPERATION_INVALID_SCHEMA');
    const tooLarge='é'.repeat(Math.floor(IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES/2)+1);
    expect(Buffer.byteLength(tooLarge)).toBeGreaterThan(IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES);
    expect(code(()=>serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth:auth('request_review',tooLarge),prompt:tooLarge,workspaceAttestation}))).toBe('IDE_OPERATION_INVALID_SCHEMA');
    expect(code(()=>parseIdeCompanionOperationControlFrame(Buffer.alloc(IDE_COMPANION_OPERATION_MAX_FRAME_BYTES+1,0x61)))).toBe('IDE_OPERATION_FRAME_SIZE');
  });

  it('rejects noncanonical outer or nested auth encoding, unknown fields and future versions',()=>{
    const prompt='review'; const payload=serializeIdeCompanionReviewPayload(prompt,workspaceAttestation); const canonical=serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth:auth('request_review',payload),prompt,workspaceAttestation});
    expect(code(()=>parseIdeCompanionOperationControlFrame(` ${canonical}`))).toBe('IDE_OPERATION_INVALID_SCHEMA');
    const parsed=JSON.parse(canonical) as Record<string,unknown>;
    const authObj=parsed.auth as Record<string,unknown>;
    const reorderedAuth={mac:authObj.mac,...authObj};
    expect(code(()=>parseIdeCompanionOperationControlFrame(JSON.stringify({...parsed,auth:reorderedAuth})))).toBe('IDE_OPERATION_INVALID_SCHEMA');
    expect(code(()=>parseIdeCompanionOperationControlFrame(JSON.stringify({...parsed,extra:true})))).toBe('IDE_OPERATION_INVALID_SCHEMA');
    expect(code(()=>parseIdeCompanionOperationControlFrame(JSON.stringify({...parsed,version:2})))).toBe('IDE_OPERATION_UNSUPPORTED_VERSION');
  });

  it('requires cancel capability for cancel frames and rejects malformed JSON',()=>{
    expect(code(()=>serializeIdeCompanionOperationControlFrame({version:1,type:'cancel_operation',auth:auth('request_review','')}))).toBe('IDE_OPERATION_CAPABILITY_DENIED');
    expect(code(()=>parseIdeCompanionOperationControlFrame('{'))).toBe('IDE_OPERATION_INVALID_JSON');
  });
});
