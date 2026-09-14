/**
 * P7 B6 pre-controller local companion handshake.
 *
 * This is deliberately distinct from B3 operation admission: no controller
 * lease or IDE capability exists until an authenticated workspace connection
 * has been established and promoted to AVAILABLE.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  assertIdeConnectionGeneration,
  assertIdeEnrollmentId,
  assertIdeInstanceId,
  assertIdeSessionId,
} from './ideSessions.js';
import {
  IDE_WORKSPACE_ADAPTER_ID_PATTERN,
  IDE_WORKSPACE_ATTESTATION_MAX_BYTES,
  IDE_WORKSPACE_RUNTIME_ID_PATTERN,
} from './ideWorkspaceAttestation.js';

export const IDE_COMPANION_HANDSHAKE_VERSION = 1 as const;
export const IDE_COMPANION_HANDSHAKE_MAX_FRAME_BYTES = 32 * 1024;
export const IDE_COMPANION_HANDSHAKE_SECRET_BYTES = 32;
export const IDE_COMPANION_HANDSHAKE_MAX_LIFETIME_MS = 15_000;
export const IDE_COMPANION_HANDSHAKE_MAX_CLOCK_SKEW_MS = 5_000;
export const IDE_COMPANION_HANDSHAKE_NONCE_BYTES = 32;

const DOMAIN = 'quarangate.ide.companion-handshake.v1';
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAC = /^[0-9a-f]{64}$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type IdeCompanionHandshakeErrorCode =
  | 'IDE_HANDSHAKE_FRAME_SIZE'
  | 'IDE_HANDSHAKE_INVALID_JSON'
  | 'IDE_HANDSHAKE_INVALID_SCHEMA'
  | 'IDE_HANDSHAKE_UNSUPPORTED_VERSION'
  | 'IDE_HANDSHAKE_TIME_WINDOW'
  | 'IDE_HANDSHAKE_AUTH_DENIED';

export class IdeCompanionHandshakeError extends Error {
  constructor(public readonly code: IdeCompanionHandshakeErrorCode, message: string) {
    super(message);
    this.name = 'IdeCompanionHandshakeError';
  }
}

export interface IdeCompanionHelloFrame {
  version: typeof IDE_COMPANION_HANDSHAKE_VERSION;
  type: 'hello';
  enrollmentId: string;
  ideInstanceId: string;
  runtimeInstanceId: string;
  adapterId: string;
  adapterVersion: string;
  sessionId: string;
  clientNonce: string;
}

export interface IdeCompanionAttestUnsignedFrame {
  version: typeof IDE_COMPANION_HANDSHAKE_VERSION;
  type: 'attest';
  enrollmentId: string;
  ideInstanceId: string;
  runtimeInstanceId: string;
  adapterId: string;
  adapterVersion: string;
  sessionId: string;
  connectionGeneration: number;
  clientNonce: string;
  serverChallenge: string;
  issuedAtMs: number;
  expiresAtMs: number;
  payloadSha256: string;
  workspaceAttestation: string;
}

export interface IdeCompanionAttestFrame extends IdeCompanionAttestUnsignedFrame {
  mac: string;
}

const HELLO_KEYS = [
  'adapterId', 'adapterVersion', 'clientNonce', 'enrollmentId', 'ideInstanceId',
  'runtimeInstanceId', 'sessionId', 'type', 'version',
] as const;
const ATTEST_KEYS = [
  'adapterId', 'adapterVersion', 'clientNonce', 'connectionGeneration', 'enrollmentId',
  'expiresAtMs', 'ideInstanceId', 'issuedAtMs', 'mac', 'payloadSha256', 'runtimeInstanceId',
  'serverChallenge', 'sessionId', 'type', 'version', 'workspaceAttestation',
] as const;

function fail(code: IdeCompanionHandshakeErrorCode, message: string): never {
  throw new IdeCompanionHandshakeError(code, message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const got = Object.keys(record).sort();
  const want = [...expected].sort();
  if (got.length !== want.length || got.some((key, i) => key !== want[i])) {
    fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'handshake frame fields are invalid');
  }
}
function safeTime(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('IDE_HANDSHAKE_INVALID_SCHEMA', `${field} is invalid`);
}
function exactNonce(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !NONCE.test(value)) fail('IDE_HANDSHAKE_INVALID_SCHEMA', `${field} is invalid`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== IDE_COMPANION_HANDSHAKE_NONCE_BYTES || decoded.toString('base64url') !== value) {
    fail('IDE_HANDSHAKE_INVALID_SCHEMA', `${field} is invalid`);
  }
}
function validateCommon(value: {
  version: unknown; enrollmentId: unknown; ideInstanceId: unknown; runtimeInstanceId: unknown;
  adapterId: unknown; adapterVersion: unknown; sessionId: unknown; clientNonce: unknown;
}): void {
  if (value.version !== IDE_COMPANION_HANDSHAKE_VERSION) fail('IDE_HANDSHAKE_UNSUPPORTED_VERSION', 'handshake version is unsupported');
  try {
    assertIdeEnrollmentId(value.enrollmentId);
    assertIdeInstanceId(value.ideInstanceId);
    assertIdeSessionId(value.sessionId);
  } catch { fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'handshake logical identity is invalid'); }
  if (typeof value.runtimeInstanceId !== 'string' || !IDE_WORKSPACE_RUNTIME_ID_PATTERN.test(value.runtimeInstanceId)) fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'runtimeInstanceId is invalid');
  if (typeof value.adapterId !== 'string' || !IDE_WORKSPACE_ADAPTER_ID_PATTERN.test(value.adapterId)) fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'adapterId is invalid');
  if (typeof value.adapterVersion !== 'string' || value.adapterVersion.length > 64 || !SEMVER.test(value.adapterVersion)) fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'adapterVersion is invalid');
  exactNonce(value.clientNonce, 'clientNonce');
}
function parseCanonical(frame: Uint8Array | string, expectedType: 'hello' | 'attest'): Record<string, unknown> {
  const bytes = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame);
  if (bytes.byteLength === 0 || bytes.byteLength > IDE_COMPANION_HANDSHAKE_MAX_FRAME_BYTES) fail('IDE_HANDSHAKE_FRAME_SIZE', 'handshake frame size is invalid');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('IDE_HANDSHAKE_INVALID_JSON', 'handshake frame is not valid UTF-8'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { fail('IDE_HANDSHAKE_INVALID_JSON', 'handshake frame is not valid JSON'); }
  if (!isRecord(parsed) || parsed.type !== expectedType) fail('IDE_HANDSHAKE_INVALID_SCHEMA', `expected ${expectedType} handshake frame`);
  return parsed;
}

export function serializeIdeCompanionHello(frame: IdeCompanionHelloFrame): string {
  validateCommon(frame);
  if (frame.type !== 'hello') fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'hello type is invalid');
  return JSON.stringify({
    adapterId: frame.adapterId, adapterVersion: frame.adapterVersion, clientNonce: frame.clientNonce,
    enrollmentId: frame.enrollmentId, ideInstanceId: frame.ideInstanceId, runtimeInstanceId: frame.runtimeInstanceId,
    sessionId: frame.sessionId, type: frame.type, version: frame.version,
  });
}

export function parseIdeCompanionHello(frame: Uint8Array | string): IdeCompanionHelloFrame {
  const value = parseCanonical(frame, 'hello'); exactKeys(value, HELLO_KEYS);
  const typed = value as unknown as IdeCompanionHelloFrame; validateCommon(typed);
  if (serializeIdeCompanionHello(typed) !== (typeof frame === 'string' ? frame : Buffer.from(frame).toString('utf8'))) fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'hello frame is not canonical JSON');
  return typed;
}

export function hashIdeCompanionWorkspaceAttestation(payload: Uint8Array | string): string {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (bytes.byteLength === 0 || bytes.byteLength > IDE_WORKSPACE_ATTESTATION_MAX_BYTES) fail('IDE_HANDSHAKE_FRAME_SIZE', 'workspace attestation payload size is invalid');
  return createHash('sha256').update(bytes).digest('hex');
}

function validateUnsignedAttest(frame: IdeCompanionAttestUnsignedFrame): void {
  validateCommon(frame);
  if (frame.type !== 'attest') fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'attest type is invalid');
  try { assertIdeConnectionGeneration(frame.connectionGeneration); } catch { fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'connectionGeneration is invalid'); }
  exactNonce(frame.serverChallenge, 'serverChallenge');
  safeTime(frame.issuedAtMs, 'issuedAtMs'); safeTime(frame.expiresAtMs, 'expiresAtMs');
  if (!SHA256.test(frame.payloadSha256)) fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'payloadSha256 is invalid');
  if (typeof frame.workspaceAttestation !== 'string' || Buffer.byteLength(frame.workspaceAttestation, 'utf8') === 0
    || Buffer.byteLength(frame.workspaceAttestation, 'utf8') > IDE_WORKSPACE_ATTESTATION_MAX_BYTES) fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'workspaceAttestation is invalid');
  if (hashIdeCompanionWorkspaceAttestation(frame.workspaceAttestation) !== frame.payloadSha256) fail('IDE_HANDSHAKE_AUTH_DENIED', 'authentication denied');
}

export function validateIdeCompanionHandshakeTime(frame: Pick<IdeCompanionAttestUnsignedFrame, 'issuedAtMs'|'expiresAtMs'>, nowMs: number): void {
  safeTime(nowMs, 'nowMs'); safeTime(frame.issuedAtMs, 'issuedAtMs'); safeTime(frame.expiresAtMs, 'expiresAtMs');
  const lifetime = frame.expiresAtMs - frame.issuedAtMs;
  if (lifetime <= 0 || lifetime > IDE_COMPANION_HANDSHAKE_MAX_LIFETIME_MS) fail('IDE_HANDSHAKE_TIME_WINDOW', 'handshake lifetime is invalid');
  if (frame.issuedAtMs - nowMs > IDE_COMPANION_HANDSHAKE_MAX_CLOCK_SKEW_MS) fail('IDE_HANDSHAKE_TIME_WINDOW', 'handshake is not yet valid');
  if (frame.expiresAtMs <= nowMs) fail('IDE_HANDSHAKE_TIME_WINDOW', 'handshake has expired');
}

function key(secret: Uint8Array): Buffer {
  const out = Buffer.from(secret);
  if (out.byteLength !== IDE_COMPANION_HANDSHAKE_SECRET_BYTES) fail('IDE_HANDSHAKE_AUTH_DENIED', 'authentication denied');
  return out;
}

export function canonicalIdeCompanionHandshakeMacInput(frame: IdeCompanionAttestUnsignedFrame): Buffer {
  validateUnsignedAttest(frame);
  return Buffer.from(JSON.stringify([
    DOMAIN, frame.version, frame.enrollmentId, frame.ideInstanceId, frame.runtimeInstanceId,
    frame.adapterId, frame.adapterVersion, frame.sessionId, frame.connectionGeneration,
    frame.clientNonce, frame.serverChallenge, frame.issuedAtMs, frame.expiresAtMs, frame.payloadSha256,
  ]), 'utf8');
}

export function computeIdeCompanionHandshakeMac(secret: Uint8Array, frame: IdeCompanionAttestUnsignedFrame): string {
  return createHmac('sha256', key(secret)).update(canonicalIdeCompanionHandshakeMacInput(frame)).digest('hex');
}
export function signIdeCompanionAttestFrame(secret: Uint8Array, frame: IdeCompanionAttestUnsignedFrame): IdeCompanionAttestFrame {
  return { ...frame, mac: computeIdeCompanionHandshakeMac(secret, frame) };
}

export function serializeIdeCompanionAttest(frame: IdeCompanionAttestFrame): string {
  validateUnsignedAttest(frame);
  if (!MAC.test(frame.mac)) fail('IDE_HANDSHAKE_AUTH_DENIED', 'authentication denied');
  return JSON.stringify({
    adapterId: frame.adapterId, adapterVersion: frame.adapterVersion, clientNonce: frame.clientNonce,
    connectionGeneration: frame.connectionGeneration, enrollmentId: frame.enrollmentId, expiresAtMs: frame.expiresAtMs,
    ideInstanceId: frame.ideInstanceId, issuedAtMs: frame.issuedAtMs, mac: frame.mac, payloadSha256: frame.payloadSha256,
    runtimeInstanceId: frame.runtimeInstanceId, serverChallenge: frame.serverChallenge, sessionId: frame.sessionId,
    type: frame.type, version: frame.version, workspaceAttestation: frame.workspaceAttestation,
  });
}

export function parseIdeCompanionAttest(frame: Uint8Array | string): IdeCompanionAttestFrame {
  const value = parseCanonical(frame, 'attest'); exactKeys(value, ATTEST_KEYS);
  const typed = value as unknown as IdeCompanionAttestFrame; validateUnsignedAttest(typed);
  if (typeof typed.mac !== 'string' || !MAC.test(typed.mac)) fail('IDE_HANDSHAKE_AUTH_DENIED', 'authentication denied');
  if (serializeIdeCompanionAttest(typed) !== (typeof frame === 'string' ? frame : Buffer.from(frame).toString('utf8'))) fail('IDE_HANDSHAKE_INVALID_SCHEMA', 'attest frame is not canonical JSON');
  return typed;
}

export function verifyIdeCompanionAttest(input: { frame: IdeCompanionAttestFrame; secret: Uint8Array; nowMs: number }): IdeCompanionAttestFrame {
  validateUnsignedAttest(input.frame); validateIdeCompanionHandshakeTime(input.frame, input.nowMs);
  if (!MAC.test(input.frame.mac)) fail('IDE_HANDSHAKE_AUTH_DENIED', 'authentication denied');
  const expected = Buffer.from(computeIdeCompanionHandshakeMac(input.secret, input.frame), 'hex');
  const supplied = Buffer.from(input.frame.mac, 'hex');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) fail('IDE_HANDSHAKE_AUTH_DENIED', 'authentication denied');
  return input.frame;
}
