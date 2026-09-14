import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IDE_COMPANION_HANDSHAKE_MAX_FRAME_BYTES,
  IdeCompanionHandshakeError,
  hashIdeCompanionWorkspaceAttestation,
  parseIdeCompanionAttest,
  parseIdeCompanionHello,
  serializeIdeCompanionAttest,
  serializeIdeCompanionHello,
  signIdeCompanionAttestFrame,
  verifyIdeCompanionAttest,
  type IdeCompanionAttestUnsignedFrame,
  type IdeCompanionHelloFrame,
} from '../../src/shared/ideCompanionHandshake.js';

const secret = Buffer.alloc(32, 0x61);
const otherSecret = Buffer.alloc(32, 0x62);
const nowMs = 1_800_000_000_000;
const workspaceAttestation = '{"bounded":"workspace-evidence"}';

function hello(over: Partial<IdeCompanionHelloFrame> = {}): IdeCompanionHelloFrame {
  return {
    version: 1,
    type: 'hello',
    enrollmentId: `iden_${'1'.repeat(32)}`,
    ideInstanceId: `ide_${'2'.repeat(32)}`,
    runtimeInstanceId: `iderun_${'3'.repeat(32)}`,
    adapterId: 'quarangate-vscode-companion',
    adapterVersion: '1.2.3',
    sessionId: `ides_${'4'.repeat(32)}`,
    clientNonce: Buffer.alloc(32, 0x41).toString('base64url'),
    ...over,
  };
}

function unsigned(over: Partial<IdeCompanionAttestUnsignedFrame> = {}): IdeCompanionAttestUnsignedFrame {
  const h = hello();
  return {
    version: 1,
    type: 'attest',
    enrollmentId: h.enrollmentId,
    ideInstanceId: h.ideInstanceId,
    runtimeInstanceId: h.runtimeInstanceId,
    adapterId: h.adapterId,
    adapterVersion: h.adapterVersion,
    sessionId: h.sessionId,
    connectionGeneration: 1,
    clientNonce: h.clientNonce,
    serverChallenge: Buffer.alloc(32, 0x42).toString('base64url'),
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 10_000,
    payloadSha256: hashIdeCompanionWorkspaceAttestation(workspaceAttestation),
    workspaceAttestation,
    ...over,
  };
}

function code(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; }
  catch (error) { return error instanceof IdeCompanionHandshakeError ? error.code : 'OTHER_ERROR'; }
}

describe('P7 B6 pre-controller companion handshake contract', () => {
  it('round-trips one exact canonical hello without a secret or authority claim', () => {
    const value = hello();
    const text = serializeIdeCompanionHello(value);
    expect(parseIdeCompanionHello(text)).toEqual(value);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('controllerLease');
    expect(text).not.toContain('capability');
    expect(text).not.toContain('projectId');
    expect(text).not.toContain('worktreeId');
  });

  it('fails closed on noncanonical, duplicate, unknown, future, malformed and oversized hello frames', () => {
    const text = serializeIdeCompanionHello(hello());
    expect(code(() => parseIdeCompanionHello(` ${text}`))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionHello(text.replace('{', '{"version":1,')))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionHello(text.replace('"version":1', '"extra":true,"version":1')))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionHello(text.replace('"version":1', '"version":2')))).toBe('IDE_HANDSHAKE_UNSUPPORTED_VERSION');
    expect(code(() => parseIdeCompanionHello('{'))).toBe('IDE_HANDSHAKE_INVALID_JSON');
    expect(code(() => parseIdeCompanionHello(Buffer.from([0xff, 0xfe])))).toBe('IDE_HANDSHAKE_INVALID_JSON');
    expect(code(() => parseIdeCompanionHello(Buffer.alloc(IDE_COMPANION_HANDSHAKE_MAX_FRAME_BYTES + 1, 0x61)))).toBe('IDE_HANDSHAKE_FRAME_SIZE');
  });

  it('rejects malformed hello identities, semver and noncanonical 32-byte nonce encoding', () => {
    expect(code(() => serializeIdeCompanionHello(hello({ enrollmentId: 'iden_bad' })))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
    expect(code(() => serializeIdeCompanionHello(hello({ runtimeInstanceId: 'iderun_bad' })))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
    expect(code(() => serializeIdeCompanionHello(hello({ adapterVersion: '1.2' })))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
    expect(code(() => serializeIdeCompanionHello(hello({ clientNonce: 'A'.repeat(42) })))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
  });

  it('signs, serializes, parses and verifies an exact attestation frame', () => {
    const frame = signIdeCompanionAttestFrame(secret, unsigned());
    const text = serializeIdeCompanionAttest(frame);
    expect(parseIdeCompanionAttest(text)).toEqual(frame);
    expect(verifyIdeCompanionAttest({ frame, secret, nowMs })).toEqual(frame);
    expect(text).not.toContain(secret.toString('base64url'));
    expect(frame.mac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds every security-critical attestation field into the MAC', () => {
    const original = signIdeCompanionAttestFrame(secret, unsigned());
    const changes: Array<Partial<typeof original>> = [
      { enrollmentId: `iden_${'a'.repeat(32)}` },
      { ideInstanceId: `ide_${'b'.repeat(32)}` },
      { runtimeInstanceId: `iderun_${'c'.repeat(32)}` },
      { adapterId: 'quarangate-cursor-companion' },
      { adapterVersion: '1.2.4' },
      { sessionId: `ides_${'d'.repeat(32)}` },
      { connectionGeneration: 2 },
      { clientNonce: randomBytes(32).toString('base64url') },
      { serverChallenge: randomBytes(32).toString('base64url') },
      { issuedAtMs: original.issuedAtMs - 1 },
      { expiresAtMs: original.expiresAtMs - 1 },
    ];
    for (const change of changes) {
      const changed = { ...original, ...change };
      expect(code(() => verifyIdeCompanionAttest({ frame: changed, secret, nowMs }))).toBe('IDE_HANDSHAKE_AUTH_DENIED');
    }
  });

  it('rejects wrong secret and payload substitution with one generic auth denial', () => {
    const original = signIdeCompanionAttestFrame(secret, unsigned());
    expect(code(() => verifyIdeCompanionAttest({ frame: original, secret: otherSecret, nowMs }))).toBe('IDE_HANDSHAKE_AUTH_DENIED');
    const changedPayload = '{"bounded":"different"}';
    const changed = { ...original, workspaceAttestation: changedPayload };
    expect(code(() => verifyIdeCompanionAttest({ frame: changed, secret, nowMs }))).toBe('IDE_HANDSHAKE_AUTH_DENIED');
  });

  it('fails closed on expired, future, zero/overlong and unsafe time windows', () => {
    const cases: Array<Partial<IdeCompanionAttestUnsignedFrame>> = [
      { issuedAtMs: nowMs - 20_000, expiresAtMs: nowMs - 1 },
      { issuedAtMs: nowMs + 6_000, expiresAtMs: nowMs + 10_000 },
      { issuedAtMs: nowMs, expiresAtMs: nowMs },
      { issuedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 20_000 },
    ];
    for (const change of cases) {
      const frame = signIdeCompanionAttestFrame(secret, unsigned(change));
      expect(code(() => verifyIdeCompanionAttest({ frame, secret, nowMs }))).toBe('IDE_HANDSHAKE_TIME_WINDOW');
    }
  });

  it('rejects noncanonical attestation JSON, unknown fields, malformed MAC and frame overflow', () => {
    const frame = signIdeCompanionAttestFrame(secret, unsigned());
    const text = serializeIdeCompanionAttest(frame);
    expect(code(() => parseIdeCompanionAttest(` ${text}`))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
    expect(code(() => parseIdeCompanionAttest(text.replace('"version":1', '"extra":true,"version":1')))).toBe('IDE_HANDSHAKE_INVALID_SCHEMA');
    expect(code(() => serializeIdeCompanionAttest({ ...frame, mac: 'z'.repeat(64) }))).toBe('IDE_HANDSHAKE_AUTH_DENIED');
    expect(code(() => parseIdeCompanionAttest(Buffer.alloc(IDE_COMPANION_HANDSHAKE_MAX_FRAME_BYTES + 1, 0x61)))).toBe('IDE_HANDSHAKE_FRAME_SIZE');
  });
});
