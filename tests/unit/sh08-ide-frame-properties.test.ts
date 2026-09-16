import { describe, expect, it } from 'vitest';
import {
  IdeCompanionAuthError, parseIdeCompanionAuthFrame, signIdeCompanionEnvelope,
  hashIdeCompanionPayload,
} from '../../src/shared/ideCompanionAuth.js';
import {
  IdeCompanionHandshakeError, parseIdeCompanionHello, parseIdeCompanionAttest,
  serializeIdeCompanionHello, serializeIdeCompanionAttest, signIdeCompanionAttestFrame,
  hashIdeCompanionWorkspaceAttestation,
  type IdeCompanionHelloFrame, type IdeCompanionAttestUnsignedFrame,
} from '../../src/shared/ideCompanionHandshake.js';
import {
  IdeRemoteTransportError, parseIdeRemoteClientFrame, parseIdeRemoteServerFrame,
  serializeIdeRemoteClientFrame, serializeIdeRemoteServerFrame,
  type IdeRemoteClientFrame, type IdeRemoteServerFrame,
} from '../../src/shared/ideCompanionRemoteTransport.js';
import { HOSTILE_CODEPOINTS, mutateOneCodePoint, runProperty, Sh08Prng } from '../helpers/sh08Property.js';

const nowMs = 1_800_000_000_000;
const secret = Buffer.alloc(32, 0x61);
const sid = `ides_${'1'.repeat(32)}`;
const oid = `ideo_${'2'.repeat(32)}`;
const lease = `idectl_${'3'.repeat(32)}`;

function hello(): IdeCompanionHelloFrame { return {
  version:1,type:'hello',enrollmentId:`iden_${'4'.repeat(32)}`,ideInstanceId:`ide_${'5'.repeat(32)}`,
  runtimeInstanceId:`iderun_${'6'.repeat(32)}`,adapterId:'quarangate-vscode-companion',adapterVersion:'1.2.3',
  sessionId:sid,clientNonce:Buffer.alloc(32,0x41).toString('base64url'),
}; }
function attest(): IdeCompanionAttestUnsignedFrame { const h=hello(); const workspaceAttestation='{"workspace":"bounded"}'; return {
  version:1,type:'attest',enrollmentId:h.enrollmentId,ideInstanceId:h.ideInstanceId,runtimeInstanceId:h.runtimeInstanceId,
  adapterId:h.adapterId,adapterVersion:h.adapterVersion,sessionId:h.sessionId,connectionGeneration:1,clientNonce:h.clientNonce,
  serverChallenge:Buffer.alloc(32,0x42).toString('base64url'),issuedAtMs:nowMs-1000,expiresAtMs:nowMs+10000,
  payloadSha256:hashIdeCompanionWorkspaceAttestation(workspaceAttestation),workspaceAttestation,
}; }
function auth() { const payload='review'; return signIdeCompanionEnvelope(secret,{
  version:1,enrollmentId:`iden_${'4'.repeat(32)}`,ideInstanceId:`ide_${'5'.repeat(32)}`,sessionId:sid,
  connectionGeneration:1,controllerLeaseId:lease,operationId:oid,capability:'request_review',nonce:Buffer.alloc(32,0x43).toString('base64url'),
  issuedAtMs:nowMs-1000,expiresAtMs:nowMs+10000,payloadSha256:hashIdeCompanionPayload(payload),
}); }
function server(): IdeRemoteServerFrame { return {version:1,type:'authorize_operation',sessionId:sid,connectionGeneration:1,commandSequence:1,operationId:oid,controllerLeaseId:lease,capability:'request_review',prompt:'review'}; }
function client(): IdeRemoteClientFrame { return {version:1,type:'operation_authorized',sessionId:sid,connectionGeneration:1,commandSequence:1,operationId:oid,auth:auth(),workspaceAttestation:'{"bounded":true}'}; }

function parseOrTypedReject<T>(fn: () => T, allowed: readonly (new (...args: any[]) => Error)[]): T | null {
  try { return fn(); }
  catch (error) {
    expect(allowed.some((Ctor) => error instanceof Ctor), `unexpected parser error: ${String(error)}`).toBe(true);
    return null;
  }
}

describe('SH-08 IDE frame parser properties', () => {
  it('canonical valid frames round-trip exactly under deterministic identity mutations', () => {
    runProperty('ide-valid-roundtrip', { seed: 0x08c001, iterations: 1000 }, (rng) => {
      let hex=''; for(let i=0;i<32;i++) hex += rng.pick('0123456789abcdef'.split(''));
      const h={...hello(),sessionId:`ides_${hex}`,ideInstanceId:`ide_${hex}`,enrollmentId:`iden_${hex}`,runtimeInstanceId:`iderun_${hex}`};
      const hs=serializeIdeCompanionHello(h); expect(parseIdeCompanionHello(hs)).toEqual(h);
      const sf={...server(),sessionId:`ides_${hex}`,operationId:`ideo_${hex}`,controllerLeaseId:`idectl_${hex}`};
      const ss=serializeIdeRemoteServerFrame(sf); expect(serializeIdeRemoteServerFrame(parseIdeRemoteServerFrame(ss))).toBe(ss);
    });
  });

  it('mutated auth/hello/attest frames either remain valid canonical structures or fail with typed parser errors', () => {
    const rng = new Sh08Prng(0x08c002);
    const authText=JSON.stringify(auth());
    const helloText=serializeIdeCompanionHello(hello());
    const attestText=serializeIdeCompanionAttest(signIdeCompanionAttestFrame(secret,attest()));
    for(let i=0;i<3500;i++){
      const a=mutateOneCodePoint(authText,rng,HOSTILE_CODEPOINTS);
      const pa=parseOrTypedReject(()=>parseIdeCompanionAuthFrame(a),[IdeCompanionAuthError]);
      if(pa) expect(JSON.parse(a)).toEqual(pa);
      const h=mutateOneCodePoint(helloText,rng,HOSTILE_CODEPOINTS);
      const ph=parseOrTypedReject(()=>parseIdeCompanionHello(h),[IdeCompanionHandshakeError]);
      if(ph) expect(serializeIdeCompanionHello(ph)).toBe(h);
      const at=mutateOneCodePoint(attestText,rng,HOSTILE_CODEPOINTS);
      const pat=parseOrTypedReject(()=>parseIdeCompanionAttest(at),[IdeCompanionHandshakeError]);
      if(pat) expect(serializeIdeCompanionAttest(pat)).toBe(at);
    }
  });

  it('mutated remote frames either canonical-roundtrip or fail with IdeRemoteTransportError', () => {
    const rng = new Sh08Prng(0x08c003);
    const serverText=serializeIdeRemoteServerFrame(server());
    const clientText=serializeIdeRemoteClientFrame(client());
    for(let i=0;i<4000;i++){
      const s=mutateOneCodePoint(serverText,rng,HOSTILE_CODEPOINTS);
      const ps=parseOrTypedReject(()=>parseIdeRemoteServerFrame(s),[IdeRemoteTransportError]);
      if(ps) expect(serializeIdeRemoteServerFrame(ps)).toBe(s);
      const c=mutateOneCodePoint(clientText,rng,HOSTILE_CODEPOINTS);
      const pc=parseOrTypedReject(()=>parseIdeRemoteClientFrame(c),[IdeRemoteTransportError]);
      if(pc) expect(serializeIdeRemoteClientFrame(pc)).toBe(c);
    }
  });

  it('arbitrary bounded strings never escape the typed IDE parser failure domains', () => {
    runProperty('ide-arbitrary-parser-totality', { seed: 0x08c004, iterations: 3000 }, (rng) => {
      const raw=rng.string(HOSTILE_CODEPOINTS,128);
      parseOrTypedReject(()=>parseIdeCompanionAuthFrame(raw),[IdeCompanionAuthError]);
      parseOrTypedReject(()=>parseIdeCompanionHello(raw),[IdeCompanionHandshakeError]);
      parseOrTypedReject(()=>parseIdeCompanionAttest(raw),[IdeCompanionHandshakeError]);
      parseOrTypedReject(()=>parseIdeRemoteServerFrame(raw),[IdeRemoteTransportError]);
      parseOrTypedReject(()=>parseIdeRemoteClientFrame(raw),[IdeRemoteTransportError]);
    });
  });
});
