/**
 * P7 B7 authenticated companion operation-control frames.
 *
 * This protocol is intentionally narrower than the B1 capability vocabulary:
 * B7 executes only request_review. Generic prompt and request_implementation
 * are not operation starts here because prompt text is not a read-only policy
 * boundary and writer arbitration is not yet accepted.
 */
import { IDE_WORKSPACE_ATTESTATION_MAX_BYTES } from './ideWorkspaceAttestation.js';
import {
  IDE_COMPANION_MAX_AUTH_FRAME_BYTES,
  parseIdeCompanionAuthFrame,
  type IdeCompanionAuthEnvelope,
} from './ideCompanionAuth.js';

export const IDE_COMPANION_OPERATION_PROTOCOL_VERSION = 1 as const;
export const IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES = 16 * 1024;
export const IDE_COMPANION_OPERATION_MAX_AUTHENTICATED_PAYLOAD_BYTES = 40 * 1024;
export const IDE_COMPANION_OPERATION_MAX_FRAME_BYTES = 48 * 1024;
const REVIEW_PAYLOAD_DOMAIN = 'quarangate.ide.review.payload.v1';

export type IdeCompanionOperationControlFrame =
  | { version: 1; type: 'acquire_controller' }
  | { version: 1; type: 'release_controller' }
  | { version: 1; type: 'start_review'; auth: IdeCompanionAuthEnvelope; prompt: string; workspaceAttestation: string }
  | { version: 1; type: 'cancel_operation'; auth: IdeCompanionAuthEnvelope };

export type IdeCompanionOperationProtocolErrorCode =
  | 'IDE_OPERATION_FRAME_SIZE'
  | 'IDE_OPERATION_INVALID_JSON'
  | 'IDE_OPERATION_INVALID_SCHEMA'
  | 'IDE_OPERATION_UNSUPPORTED_VERSION'
  | 'IDE_OPERATION_CAPABILITY_DENIED';

export class IdeCompanionOperationProtocolError extends Error {
  constructor(public readonly code: IdeCompanionOperationProtocolErrorCode, message: string) {
    super(message);
    this.name = 'IdeCompanionOperationProtocolError';
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function fail(code: IdeCompanionOperationProtocolErrorCode, message: string): never {
  throw new IdeCompanionOperationProtocolError(code, message);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseAuth(value: unknown): IdeCompanionAuthEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('IDE_OPERATION_INVALID_SCHEMA', 'auth must be an object');
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > IDE_COMPANION_MAX_AUTH_FRAME_BYTES) {
    fail('IDE_OPERATION_INVALID_SCHEMA', 'auth envelope exceeds bound');
  }
  try {
    const auth=parseIdeCompanionAuthFrame(text);
    return {
      version:auth.version,
      enrollmentId:auth.enrollmentId,
      ideInstanceId:auth.ideInstanceId,
      sessionId:auth.sessionId,
      connectionGeneration:auth.connectionGeneration,
      controllerLeaseId:auth.controllerLeaseId,
      operationId:auth.operationId,
      capability:auth.capability,
      nonce:auth.nonce,
      issuedAtMs:auth.issuedAtMs,
      expiresAtMs:auth.expiresAtMs,
      payloadSha256:auth.payloadSha256,
      mac:auth.mac,
    };
  } catch {
    fail('IDE_OPERATION_INVALID_SCHEMA', 'auth envelope is invalid');
  }
}

function validateFrame(value: unknown): IdeCompanionOperationControlFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('IDE_OPERATION_INVALID_SCHEMA', 'operation frame must be an object');
  }
  const row = value as Record<string, unknown>;
  if (row.version !== IDE_COMPANION_OPERATION_PROTOCOL_VERSION) {
    fail('IDE_OPERATION_UNSUPPORTED_VERSION', 'unsupported operation protocol version');
  }
  if (row.type === 'acquire_controller' || row.type === 'release_controller') {
    if (!exactKeys(row, ['version', 'type'])) fail('IDE_OPERATION_INVALID_SCHEMA', 'controller frame keys are invalid');
    return { version: 1, type: row.type };
  }
  if (row.type === 'start_review') {
    if (!exactKeys(row, ['version', 'type', 'auth', 'prompt', 'workspaceAttestation'])) fail('IDE_OPERATION_INVALID_SCHEMA', 'start frame keys are invalid');
    if (typeof row.prompt !== 'string') fail('IDE_OPERATION_INVALID_SCHEMA', 'prompt must be a string');
    const promptBytes = Buffer.byteLength(row.prompt, 'utf8');
    if (promptBytes < 1 || promptBytes > IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES) {
      fail('IDE_OPERATION_INVALID_SCHEMA', 'prompt exceeds bounded review envelope');
    }
    if (typeof row.workspaceAttestation !== 'string' || Buffer.byteLength(row.workspaceAttestation, 'utf8') < 1
      || Buffer.byteLength(row.workspaceAttestation, 'utf8') > IDE_WORKSPACE_ATTESTATION_MAX_BYTES) {
      fail('IDE_OPERATION_INVALID_SCHEMA', 'workspace attestation exceeds bound');
    }
    const auth = parseAuth(row.auth);
    if (auth.capability !== 'request_review') fail('IDE_OPERATION_CAPABILITY_DENIED', 'B7 starts only request_review');
    return { version: 1, type: 'start_review', auth, prompt: row.prompt, workspaceAttestation: row.workspaceAttestation };
  }
  if (row.type === 'cancel_operation') {
    if (!exactKeys(row, ['version', 'type', 'auth'])) fail('IDE_OPERATION_INVALID_SCHEMA', 'cancel frame keys are invalid');
    const auth = parseAuth(row.auth);
    if (auth.capability !== 'cancel') fail('IDE_OPERATION_CAPABILITY_DENIED', 'cancel frame requires cancel capability');
    return { version: 1, type: 'cancel_operation', auth };
  }
  fail('IDE_OPERATION_INVALID_SCHEMA', 'operation frame type is invalid');
}

export function serializeIdeCompanionReviewPayload(prompt: string, workspaceAttestation: string): string {
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') < 1 || Buffer.byteLength(prompt, 'utf8') > IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES) {
    fail('IDE_OPERATION_INVALID_SCHEMA', 'prompt exceeds bounded review envelope');
  }
  if (typeof workspaceAttestation !== 'string' || Buffer.byteLength(workspaceAttestation, 'utf8') < 1
    || Buffer.byteLength(workspaceAttestation, 'utf8') > IDE_WORKSPACE_ATTESTATION_MAX_BYTES) {
    fail('IDE_OPERATION_INVALID_SCHEMA', 'workspace attestation exceeds bound');
  }
  const text=JSON.stringify([REVIEW_PAYLOAD_DOMAIN,prompt,workspaceAttestation]);
  if(Buffer.byteLength(text,'utf8')>IDE_COMPANION_OPERATION_MAX_AUTHENTICATED_PAYLOAD_BYTES) {
    fail('IDE_OPERATION_FRAME_SIZE','authenticated review payload exceeds bound');
  }
  return text;
}

export function serializeIdeCompanionOperationControlFrame(frame: IdeCompanionOperationControlFrame): string {
  const valid = validateFrame(frame);
  const text = JSON.stringify(valid);
  if (Buffer.byteLength(text, 'utf8') > IDE_COMPANION_OPERATION_MAX_FRAME_BYTES) {
    fail('IDE_OPERATION_FRAME_SIZE', 'operation frame exceeds bound');
  }
  return text;
}

export function parseIdeCompanionOperationControlFrame(bytes: Uint8Array | string): IdeCompanionOperationControlFrame {
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  if (raw.byteLength < 1 || raw.byteLength > IDE_COMPANION_OPERATION_MAX_FRAME_BYTES) {
    fail('IDE_OPERATION_FRAME_SIZE', 'operation frame exceeds bound');
  }
  let text: string;
  try { text = decoder.decode(raw); }
  catch { fail('IDE_OPERATION_INVALID_JSON', 'operation frame is not valid UTF-8'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { fail('IDE_OPERATION_INVALID_JSON', 'operation frame is not valid JSON'); }
  const valid = validateFrame(parsed);
  const canonical = JSON.stringify(valid);
  if (canonical !== text) fail('IDE_OPERATION_INVALID_SCHEMA', 'operation frame is not canonical JSON');
  return valid;
}

export function assertIdeCompanionPayloadHash(value: string): void {
  if (!SHA256_PATTERN.test(value)) fail('IDE_OPERATION_INVALID_SCHEMA', 'payload hash is invalid');
}
