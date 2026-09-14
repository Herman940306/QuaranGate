/**
 * Backend-neutral authenticated companion request contract (P7 B3).
 *
 * Pure source foundation only: no listener, socket, credential persistence,
 * provider/model call, host path, or writer authority. A trusted transport
 * supplies secret bytes out-of-band, verifies one bounded auth envelope, then
 * hands the authenticated identity to the Plane-B registry for replay and
 * authorization checks.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  IDE_REVIEW_BASE_CAPABILITIES,
  assertIdeCapability,
  assertIdeConnectionGeneration,
  assertIdeControllerLeaseId,
  assertIdeEnrollmentId,
  assertIdeInstanceId,
  assertIdeOperationId,
  assertIdeSessionId,
  type IdeCapability,
} from './ideSessions.js';

export const IDE_COMPANION_PROTOCOL_VERSION = 1 as const;
export const IDE_COMPANION_MAX_AUTH_FRAME_BYTES = 4 * 1024;
export const IDE_COMPANION_MIN_SECRET_BYTES = 32;
export const IDE_COMPANION_MAX_SECRET_BYTES = 64;
export const IDE_COMPANION_MAX_LIFETIME_MS = 30_000;
export const IDE_COMPANION_MAX_CLOCK_SKEW_MS = 5_000;

const AUTH_DOMAIN = 'quarangate.ide.companion.request.v1';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAC_PATTERN = /^[0-9a-f]{64}$/;

export const IDE_COMPANION_AUTH_CAPABILITIES: readonly IdeCapability[] = [
  ...IDE_REVIEW_BASE_CAPABILITIES,
  'read_bounded_editor_context',
  // P7 B9 extends the already-authenticated envelope to the implementation
  // capability. Writer authority is still separately required and is never
  // granted by possession of a valid B3/B9 MAC alone.
  'request_implementation',
] as const;
/** Historical internal alias retained for B3 evidence/tests; current policy is AUTH_CAPABILITIES. */
export const IDE_COMPANION_B3_CAPABILITIES = IDE_COMPANION_AUTH_CAPABILITIES;
const AUTH_CAPABILITY_SET = new Set<IdeCapability>(IDE_COMPANION_AUTH_CAPABILITIES);

export type IdeCompanionAuthErrorCode =
  | 'IDE_COMPANION_FRAME_SIZE'
  | 'IDE_COMPANION_INVALID_JSON'
  | 'IDE_COMPANION_INVALID_SCHEMA'
  | 'IDE_COMPANION_UNSUPPORTED_VERSION'
  | 'IDE_COMPANION_CAPABILITY_DENIED'
  | 'IDE_COMPANION_TIME_WINDOW'
  | 'IDE_COMPANION_AUTH_DENIED';

export class IdeCompanionAuthError extends Error {
  constructor(public readonly code: IdeCompanionAuthErrorCode, message: string) {
    super(message);
    this.name = 'IdeCompanionAuthError';
  }
}

export interface IdeCompanionUnsignedEnvelope {
  version: typeof IDE_COMPANION_PROTOCOL_VERSION;
  enrollmentId: string;
  ideInstanceId: string;
  sessionId: string;
  connectionGeneration: number;
  controllerLeaseId: string;
  operationId: string;
  capability: IdeCapability;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  payloadSha256: string;
}

export interface IdeCompanionAuthEnvelope extends IdeCompanionUnsignedEnvelope {
  mac: string;
}

export interface VerifyIdeCompanionAuthInput {
  envelope: IdeCompanionAuthEnvelope;
  secret: Uint8Array;
  payload: Uint8Array | string;
  nowMs: number;
}

const EXACT_KEYS = [
  'version', 'enrollmentId', 'ideInstanceId', 'sessionId', 'connectionGeneration',
  'controllerLeaseId', 'operationId', 'capability', 'nonce', 'issuedAtMs',
  'expiresAtMs', 'payloadSha256', 'mac',
] as const;

function fail(code: IdeCompanionAuthErrorCode, message: string): never {
  throw new IdeCompanionAuthError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSafeTime(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('IDE_COMPANION_INVALID_SCHEMA', `${field} is invalid`);
  }
}

function assertAuthenticatedCapability(value: unknown): asserts value is IdeCapability {
  try { assertIdeCapability(value); } catch { fail('IDE_COMPANION_CAPABILITY_DENIED', 'capability is unsupported'); }
  if (!AUTH_CAPABILITY_SET.has(value as IdeCapability)) {
    fail('IDE_COMPANION_CAPABILITY_DENIED', 'capability is outside authenticated companion policy');
  }
}

function validateSecret(secret: Uint8Array): Buffer {
  const buf = Buffer.from(secret);
  if (buf.byteLength < IDE_COMPANION_MIN_SECRET_BYTES || buf.byteLength > IDE_COMPANION_MAX_SECRET_BYTES) {
    fail('IDE_COMPANION_AUTH_DENIED', 'authentication denied');
  }
  return buf;
}

function validateUnsigned(envelope: IdeCompanionUnsignedEnvelope): void {
  if (envelope.version !== IDE_COMPANION_PROTOCOL_VERSION) {
    fail('IDE_COMPANION_UNSUPPORTED_VERSION', 'unsupported companion protocol version');
  }
  try {
    assertIdeEnrollmentId(envelope.enrollmentId);
    assertIdeInstanceId(envelope.ideInstanceId);
    assertIdeSessionId(envelope.sessionId);
    assertIdeConnectionGeneration(envelope.connectionGeneration);
    assertIdeControllerLeaseId(envelope.controllerLeaseId);
    assertIdeOperationId(envelope.operationId);
  } catch {
    fail('IDE_COMPANION_INVALID_SCHEMA', 'companion identity field is invalid');
  }
  assertAuthenticatedCapability(envelope.capability);
  if (typeof envelope.nonce !== 'string' || !NONCE_PATTERN.test(envelope.nonce)) {
    fail('IDE_COMPANION_INVALID_SCHEMA', 'nonce is invalid');
  }
  assertSafeTime(envelope.issuedAtMs, 'issuedAtMs');
  assertSafeTime(envelope.expiresAtMs, 'expiresAtMs');
  if (typeof envelope.payloadSha256 !== 'string' || !SHA256_PATTERN.test(envelope.payloadSha256)) {
    fail('IDE_COMPANION_INVALID_SCHEMA', 'payloadSha256 is invalid');
  }
}

export function validateIdeCompanionTimeWindow(
  envelope: Pick<IdeCompanionUnsignedEnvelope, 'issuedAtMs' | 'expiresAtMs'>,
  nowMs: number,
): void {
  assertSafeTime(nowMs, 'nowMs');
  assertSafeTime(envelope.issuedAtMs, 'issuedAtMs');
  assertSafeTime(envelope.expiresAtMs, 'expiresAtMs');
  const lifetime = envelope.expiresAtMs - envelope.issuedAtMs;
  if (lifetime <= 0 || lifetime > IDE_COMPANION_MAX_LIFETIME_MS) {
    fail('IDE_COMPANION_TIME_WINDOW', 'companion authentication lifetime is invalid');
  }
  const issuedLeadMs = envelope.issuedAtMs - nowMs;
  if (issuedLeadMs > IDE_COMPANION_MAX_CLOCK_SKEW_MS) {
    fail('IDE_COMPANION_TIME_WINDOW', 'companion request is not yet valid');
  }
  if (envelope.expiresAtMs <= nowMs) {
    fail('IDE_COMPANION_TIME_WINDOW', 'companion request has expired');
  }
}

/** Hash exact payload bytes. No prompt/context bytes are retained by this module. */
export function hashIdeCompanionPayload(payload: Uint8Array | string): string {
  return createHash('sha256').update(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload)).digest('hex');
}

/** Hash the public nonce before durable replay persistence; raw nonce need not be stored. */
export function hashIdeCompanionNonce(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) fail('IDE_COMPANION_INVALID_SCHEMA', 'nonce is invalid');
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

/**
 * Canonical MAC input. A fixed JSON array avoids object-key ambiguity and is
 * domain-separated from every other HMAC use in QuaranGate.
 */
export function canonicalIdeCompanionMacInput(envelope: IdeCompanionUnsignedEnvelope): Buffer {
  validateUnsigned(envelope);
  return Buffer.from(JSON.stringify([
    AUTH_DOMAIN,
    envelope.version,
    envelope.enrollmentId,
    envelope.ideInstanceId,
    envelope.sessionId,
    envelope.connectionGeneration,
    envelope.controllerLeaseId,
    envelope.operationId,
    envelope.capability,
    envelope.nonce,
    envelope.issuedAtMs,
    envelope.expiresAtMs,
    envelope.payloadSha256,
  ]), 'utf8');
}

export function computeIdeCompanionMac(secret: Uint8Array, envelope: IdeCompanionUnsignedEnvelope): string {
  const key = validateSecret(secret);
  return createHmac('sha256', key).update(canonicalIdeCompanionMacInput(envelope)).digest('hex');
}

export function signIdeCompanionEnvelope(secret: Uint8Array, envelope: IdeCompanionUnsignedEnvelope): IdeCompanionAuthEnvelope {
  return { ...envelope, mac: computeIdeCompanionMac(secret, envelope) };
}

/**
 * Verify schema/time/payload/MAC only. Replay claiming and B1/B2 authority are
 * deliberately separate trusted steps so this pure module cannot grant
 * session or writer authority.
 */
export function verifyIdeCompanionEnvelope(input: VerifyIdeCompanionAuthInput): IdeCompanionAuthEnvelope {
  const envelope = input.envelope;
  validateUnsigned(envelope);
  if (typeof envelope.mac !== 'string' || !MAC_PATTERN.test(envelope.mac)) {
    fail('IDE_COMPANION_AUTH_DENIED', 'authentication denied');
  }
  validateIdeCompanionTimeWindow(envelope, input.nowMs);

  const key = validateSecret(input.secret);
  const expected = createHmac('sha256', key).update(canonicalIdeCompanionMacInput(envelope)).digest();
  const supplied = Buffer.from(envelope.mac, 'hex');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    fail('IDE_COMPANION_AUTH_DENIED', 'authentication denied');
  }

  const actualPayload = Buffer.from(hashIdeCompanionPayload(input.payload), 'hex');
  const claimedPayload = Buffer.from(envelope.payloadSha256, 'hex');
  if (!timingSafeEqual(actualPayload, claimedPayload)) {
    fail('IDE_COMPANION_AUTH_DENIED', 'authentication denied');
  }
  return envelope;
}

/** Strict bounded parser for the auth envelope itself; payload framing is a later transport gate. */
export function parseIdeCompanionAuthFrame(frame: Uint8Array | string): IdeCompanionAuthEnvelope {
  const buf = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame);
  if (buf.byteLength === 0 || buf.byteLength > IDE_COMPANION_MAX_AUTH_FRAME_BYTES) {
    fail('IDE_COMPANION_FRAME_SIZE', 'companion auth frame size is invalid');
  }
  const text = buf.toString('utf8');
  rejectDuplicateTopLevelKeys(text);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { fail('IDE_COMPANION_INVALID_JSON', 'companion auth frame is not valid JSON'); }
  if (!isRecord(value)) fail('IDE_COMPANION_INVALID_SCHEMA', 'companion auth frame must be an object');
  const keys = Object.keys(value).sort();
  const expected = [...EXACT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    fail('IDE_COMPANION_INVALID_SCHEMA', 'companion auth frame fields are invalid');
  }
  const envelope = value as unknown as IdeCompanionAuthEnvelope;
  validateUnsigned(envelope);
  if (typeof envelope.mac !== 'string' || !MAC_PATTERN.test(envelope.mac)) {
    fail('IDE_COMPANION_AUTH_DENIED', 'authentication denied');
  }
  return envelope;
}

/** Reject duplicate top-level JSON fields before JSON.parse can collapse them. */
function rejectDuplicateTopLevelKeys(text: string): void {
  let i = 0;
  const ws = (): void => { while (i < text.length && /\s/u.test(text[i] ?? '')) i += 1; };
  ws();
  if (text[i] !== '{') return;
  i += 1;
  const seen = new Set<string>();
  while (i < text.length) {
    ws();
    if (text[i] === '}') return;
    if (text[i] !== '"') return;
    const start = i;
    i += 1;
    let escaped = false;
    while (i < text.length) {
      const ch = text[i];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') { i += 1; break; }
      i += 1;
    }
    let key: unknown;
    try { key = JSON.parse(text.slice(start, i)) as unknown; } catch { return; }
    if (typeof key !== 'string') return;
    if (seen.has(key)) fail('IDE_COMPANION_INVALID_JSON', 'duplicate companion auth frame field');
    seen.add(key);
    ws();
    if (text[i] !== ':') return;
    i += 1;
    let depth = 0, inString = false, escape = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        if (depth === 0 && ch === '}') return;
        depth -= 1;
      } else if (ch === ',' && depth === 0) { i += 1; break; }
    }
  }
}
