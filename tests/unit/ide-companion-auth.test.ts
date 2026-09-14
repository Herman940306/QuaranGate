import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IDE_COMPANION_B3_CAPABILITIES,
  IDE_COMPANION_MAX_AUTH_FRAME_BYTES,
  IDE_COMPANION_MAX_CLOCK_SKEW_MS,
  IDE_COMPANION_MAX_LIFETIME_MS,
  IdeCompanionAuthError,
  canonicalIdeCompanionMacInput,
  computeIdeCompanionMac,
  hashIdeCompanionNonce,
  hashIdeCompanionPayload,
  parseIdeCompanionAuthFrame,
  signIdeCompanionEnvelope,
  validateIdeCompanionTimeWindow,
  verifyIdeCompanionEnvelope,
  type IdeCompanionAuthEnvelope,
  type IdeCompanionUnsignedEnvelope,
} from '../../src/shared/ideCompanionAuth.js';

const secret = Buffer.alloc(32, 0x5a);
const payload = Buffer.from('bounded review request payload', 'utf8');
const nowMs = 1_800_000_000_000;

function unsigned(over: Partial<IdeCompanionUnsignedEnvelope> = {}): IdeCompanionUnsignedEnvelope {
  return {
    version: 1,
    enrollmentId: `iden_${'1'.repeat(32)}`,
    ideInstanceId: `ide_${'2'.repeat(32)}`,
    sessionId: `ides_${'3'.repeat(32)}`,
    connectionGeneration: 7,
    controllerLeaseId: `idectl_${'4'.repeat(32)}`,
    operationId: `ideo_${'5'.repeat(32)}`,
    capability: 'request_review',
    nonce: 'A'.repeat(43),
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 20_000,
    payloadSha256: hashIdeCompanionPayload(payload),
    ...over,
  };
}

function signed(over: Partial<IdeCompanionUnsignedEnvelope> = {}): IdeCompanionAuthEnvelope {
  return signIdeCompanionEnvelope(secret, unsigned(over));
}

function code(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; } catch (error) {
    return error instanceof IdeCompanionAuthError ? error.code : 'OTHER_ERROR';
  }
}

describe('P7 B3 authenticated companion envelope', () => {
  it('freezes least-authority B3 capabilities and excludes implementation', () => {
    expect(IDE_COMPANION_B3_CAPABILITIES).toEqual([
      'prompt', 'cancel', 'observe_response', 'request_review', 'read_bounded_editor_context',
    ]);
    expect(IDE_COMPANION_B3_CAPABILITIES).not.toContain('request_implementation');
  });

  it('hashes exact payload bytes and nonce without persisting raw content', () => {
    expect(hashIdeCompanionPayload(payload)).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(hashIdeCompanionPayload('é')).not.toBe(hashIdeCompanionPayload('e'));
    expect(hashIdeCompanionNonce('A'.repeat(43))).toBe(createHash('sha256').update('A'.repeat(43)).digest('hex'));
  });

  it('uses a deterministic domain-separated fixed-order HMAC input', () => {
    const u = unsigned();
    const expectedInput = Buffer.from(JSON.stringify([
      'quarangate.ide.companion.request.v1', 1, u.enrollmentId, u.ideInstanceId, u.sessionId,
      u.connectionGeneration, u.controllerLeaseId, u.operationId, u.capability, u.nonce,
      u.issuedAtMs, u.expiresAtMs, u.payloadSha256,
    ]), 'utf8');
    expect(canonicalIdeCompanionMacInput(u)).toEqual(expectedInput);
    expect(computeIdeCompanionMac(secret, u)).toBe(createHmac('sha256', secret).update(expectedInput).digest('hex'));
  });

  it('signs, strictly parses, and verifies a valid envelope without a raw secret field', () => {
    const envelope = signed();
    const json = JSON.stringify(envelope);
    expect(json).not.toContain('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
    const parsed = parseIdeCompanionAuthFrame(json);
    expect(parsed).toEqual(envelope);
    expect(verifyIdeCompanionEnvelope({ envelope: parsed, secret, payload, nowMs })).toEqual(envelope);
  });

  it('authenticates every authority/replay/time/payload field against tampering', () => {
    const base = signed();
    const mutations: Array<Partial<IdeCompanionAuthEnvelope>> = [
      { enrollmentId: `iden_${'9'.repeat(32)}` },
      { ideInstanceId: `ide_${'9'.repeat(32)}` },
      { sessionId: `ides_${'9'.repeat(32)}` },
      { connectionGeneration: 8 },
      { controllerLeaseId: `idectl_${'9'.repeat(32)}` },
      { operationId: `ideo_${'9'.repeat(32)}` },
      { capability: 'prompt' },
      { nonce: 'B'.repeat(43) },
      { issuedAtMs: base.issuedAtMs + 1 },
      { expiresAtMs: base.expiresAtMs + 1 },
      { payloadSha256: '9'.repeat(64) },
    ];
    for (const mutation of mutations) {
      const tampered = { ...base, ...mutation } as IdeCompanionAuthEnvelope;
      expect(code(() => verifyIdeCompanionEnvelope({ envelope: tampered, secret, payload, nowMs })), JSON.stringify(mutation))
        .toBe('IDE_COMPANION_AUTH_DENIED');
    }
  });

  it('returns uniform authentication denial for wrong secret, payload, or MAC', () => {
    const envelope = signed();
    expect(code(() => verifyIdeCompanionEnvelope({ envelope, secret: Buffer.alloc(32, 0x42), payload, nowMs }))).toBe('IDE_COMPANION_AUTH_DENIED');
    expect(code(() => verifyIdeCompanionEnvelope({ envelope, secret, payload: Buffer.from('tampered'), nowMs }))).toBe('IDE_COMPANION_AUTH_DENIED');
    expect(code(() => verifyIdeCompanionEnvelope({ envelope: { ...envelope, mac: 'f'.repeat(64) }, secret, payload, nowMs }))).toBe('IDE_COMPANION_AUTH_DENIED');
  });

  it('rejects short/oversized secrets without exposing secret material', () => {
    const u=unsigned();
    expect(code(() => computeIdeCompanionMac(Buffer.alloc(31, 1), u))).toBe('IDE_COMPANION_AUTH_DENIED');
    expect(code(() => computeIdeCompanionMac(Buffer.alloc(65, 1), u))).toBe('IDE_COMPANION_AUTH_DENIED');
    try { computeIdeCompanionMac(Buffer.alloc(31, 0x78), u); } catch (error) {
      expect(String((error as Error).message)).not.toContain('xxxxx');
    }
  });

  it('rejects implementation at the protocol boundary even with a syntactically valid capability', () => {
    expect(code(() => canonicalIdeCompanionMacInput(unsigned({ capability: 'request_implementation' })))).toBe('IDE_COMPANION_CAPABILITY_DENIED');
  });

  it('enforces bounded issue/expiry lifetime and clock skew', () => {
    expect(() => validateIdeCompanionTimeWindow(unsigned(), nowMs)).not.toThrow();
    expect(code(() => validateIdeCompanionTimeWindow(unsigned({ expiresAtMs: nowMs }), nowMs))).toBe('IDE_COMPANION_TIME_WINDOW');
    expect(code(() => validateIdeCompanionTimeWindow(unsigned({ issuedAtMs: nowMs, expiresAtMs: nowMs + IDE_COMPANION_MAX_LIFETIME_MS + 1 }), nowMs))).toBe('IDE_COMPANION_TIME_WINDOW');
    expect(code(() => validateIdeCompanionTimeWindow(unsigned({ issuedAtMs: nowMs + IDE_COMPANION_MAX_CLOCK_SKEW_MS + 1, expiresAtMs: nowMs + IDE_COMPANION_MAX_CLOCK_SKEW_MS + 2 }), nowMs))).toBe('IDE_COMPANION_TIME_WINDOW');
    expect(() => validateIdeCompanionTimeWindow(unsigned({ issuedAtMs: nowMs + IDE_COMPANION_MAX_CLOCK_SKEW_MS, expiresAtMs: nowMs + IDE_COMPANION_MAX_CLOCK_SKEW_MS + 1 }), nowMs)).not.toThrow();
  });

  it('strict parser rejects unknown, missing, duplicate and raw-secret fields', () => {
    const envelope=signed();
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify({ ...envelope, extra: true })))).toBe('IDE_COMPANION_INVALID_SCHEMA');
    const { mac: _mac, ...missing } = envelope;
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify(missing)))).toBe('IDE_COMPANION_INVALID_SCHEMA');
    const text=JSON.stringify(envelope);
    expect(code(() => parseIdeCompanionAuthFrame(text.replace('{', '{"version":1,')))).toBe('IDE_COMPANION_INVALID_JSON');
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify({ ...envelope, secret: 'must-not-be-in-frame' })))).toBe('IDE_COMPANION_INVALID_SCHEMA');
  });

  it('strict parser rejects malformed JSON, non-object and oversized auth frames', () => {
    expect(code(() => parseIdeCompanionAuthFrame('{'))).toBe('IDE_COMPANION_INVALID_JSON');
    expect(code(() => parseIdeCompanionAuthFrame('[]'))).toBe('IDE_COMPANION_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionAuthFrame('x'.repeat(IDE_COMPANION_MAX_AUTH_FRAME_BYTES + 1)))).toBe('IDE_COMPANION_FRAME_SIZE');
    expect(code(() => parseIdeCompanionAuthFrame(''))).toBe('IDE_COMPANION_FRAME_SIZE');
  });

  it('strict parser fails closed on unsupported version and malformed identity/time/hash fields', () => {
    const e=signed();
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify({ ...e, version: 2 })))).toBe('IDE_COMPANION_UNSUPPORTED_VERSION');
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify({ ...e, sessionId: 'bad' })))).toBe('IDE_COMPANION_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify({ ...e, connectionGeneration: 0 })))).toBe('IDE_COMPANION_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify({ ...e, nonce: 'short' })))).toBe('IDE_COMPANION_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify({ ...e, payloadSha256: 'A'.repeat(64) })))).toBe('IDE_COMPANION_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionAuthFrame(JSON.stringify({ ...e, mac: 'A'.repeat(64) })))).toBe('IDE_COMPANION_AUTH_DENIED');
  });

  it('canonical MAC changes when payload byte representation changes', () => {
    const a=unsigned({payloadSha256:hashIdeCompanionPayload(Buffer.from([0x00,0x01]))});
    const b=unsigned({payloadSha256:hashIdeCompanionPayload(Buffer.from([0x00,0x02]))});
    expect(computeIdeCompanionMac(secret,a)).not.toBe(computeIdeCompanionMac(secret,b));
  });


  it('handles clock-skew validation near Number.MAX_SAFE_INTEGER without unsafe addition', () => {
    const near=Number.MAX_SAFE_INTEGER;
    expect(() => validateIdeCompanionTimeWindow(unsigned({issuedAtMs:near-5,expiresAtMs:near}),near-10)).not.toThrow();
    expect(code(() => validateIdeCompanionTimeWindow(unsigned({issuedAtMs:near,expiresAtMs:near}),near-10))).toBe('IDE_COMPANION_TIME_WINDOW');
  });
});
