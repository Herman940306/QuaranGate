/**
 * P7 I2.2 direction-separated transport frames for a QuaranGate-originated
 * VS Code companion operation over an already authenticated B6 connection.
 *
 * Pure protocol only. These frames do not grant controller/writer authority.
 * QuaranGate must admit the returned B3 authorization through accepted B7/B9
 * before it sends execute_operation.
 */
import {
  parseIdeCompanionAuthFrame,
  type IdeCompanionAuthEnvelope,
} from './ideCompanionAuth.js';
import { IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES } from './ideCompanionOperations.js';
import {
  MAX_IDE_EVENT_MESSAGE_BYTES,
  assertIdeConnectionGeneration,
  assertIdeControllerLeaseId,
  assertIdeOperationId,
  assertIdeSessionId,
} from './ideSessions.js';
import { IDE_WORKSPACE_ATTESTATION_MAX_BYTES } from './ideWorkspaceAttestation.js';

export const IDE_REMOTE_TRANSPORT_VERSION = 1 as const;
export const IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES = 48 * 1024;

export const IDE_REMOTE_ADAPTER_EVENT_TYPES = ['assistant_chunk', 'tool_activity', 'status'] as const;
export type IdeRemoteAdapterEventType = (typeof IDE_REMOTE_ADAPTER_EVENT_TYPES)[number];

export const IDE_REMOTE_REVIEW_RESULTS = ['completed', 'failed', 'cancelled', 'indeterminate'] as const;
export type IdeRemoteReviewResult = (typeof IDE_REMOTE_REVIEW_RESULTS)[number];

export const IDE_REMOTE_IMPLEMENTATION_OUTCOMES = [
  'completed',
  'failed_no_mutation',
  'failed_rolled_back',
  'cancelled_no_mutation',
  'cancelled_rolled_back',
  'indeterminate',
] as const;
export type IdeRemoteImplementationOutcome = (typeof IDE_REMOTE_IMPLEMENTATION_OUTCOMES)[number];

export type IdeRemoteOperationCapability = 'request_review' | 'request_implementation';

export interface IdeRemoteAuthorizeOperationCommand {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'authorize_operation';
  sessionId: string;
  connectionGeneration: number;
  commandSequence: number;
  operationId: string;
  controllerLeaseId: string;
  capability: IdeRemoteOperationCapability;
  prompt: string;
}

export interface IdeRemoteExecuteOperationCommand {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'execute_operation';
  sessionId: string;
  connectionGeneration: number;
  commandSequence: number;
  operationId: string;
  capability: IdeRemoteOperationCapability;
}

export interface IdeRemoteCancelOperationCommand {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'cancel_operation';
  sessionId: string;
  connectionGeneration: number;
  commandSequence: number;
  operationId: string;
}

export type IdeRemoteServerFrame =
  | IdeRemoteAuthorizeOperationCommand
  | IdeRemoteExecuteOperationCommand
  | IdeRemoteCancelOperationCommand;

export interface IdeRemoteTransportReadyFrame {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'transport_ready';
  sessionId: string;
  connectionGeneration: number;
}

export interface IdeRemoteOperationAuthorizedFrame {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'operation_authorized';
  sessionId: string;
  connectionGeneration: number;
  commandSequence: number;
  operationId: string;
  auth: IdeCompanionAuthEnvelope;
  workspaceAttestation: string;
}

export interface IdeRemoteAdapterEventFrame {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'adapter_event';
  sessionId: string;
  connectionGeneration: number;
  operationId: string;
  eventSequence: number;
  eventType: IdeRemoteAdapterEventType;
  message?: string;
}

export interface IdeRemoteReviewResultFrame {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'review_result';
  sessionId: string;
  connectionGeneration: number;
  operationId: string;
  eventSequence: number;
  result: IdeRemoteReviewResult;
}

export interface IdeRemoteImplementationResultFrame {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'implementation_result';
  sessionId: string;
  connectionGeneration: number;
  operationId: string;
  eventSequence: number;
  outcome: IdeRemoteImplementationOutcome;
}

export interface IdeRemoteCancelAcknowledgedFrame {
  version: typeof IDE_REMOTE_TRANSPORT_VERSION;
  type: 'cancel_ack';
  sessionId: string;
  connectionGeneration: number;
  commandSequence: number;
  operationId: string;
}

export type IdeRemoteClientFrame =
  | IdeRemoteTransportReadyFrame
  | IdeRemoteOperationAuthorizedFrame
  | IdeRemoteAdapterEventFrame
  | IdeRemoteReviewResultFrame
  | IdeRemoteImplementationResultFrame
  | IdeRemoteCancelAcknowledgedFrame;

export type IdeRemoteTransportErrorCode =
  | 'IDE_REMOTE_FRAME_SIZE'
  | 'IDE_REMOTE_INVALID_UTF8'
  | 'IDE_REMOTE_INVALID_JSON'
  | 'IDE_REMOTE_INVALID_SCHEMA'
  | 'IDE_REMOTE_UNSUPPORTED_VERSION';

export class IdeRemoteTransportError extends Error {
  constructor(public readonly code: IdeRemoteTransportErrorCode, message: string) {
    super(message);
    this.name = 'IdeRemoteTransportError';
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const SERVER_AUTHORIZE_KEYS = [
  'capability', 'commandSequence', 'connectionGeneration', 'controllerLeaseId',
  'operationId', 'prompt', 'sessionId', 'type', 'version',
] as const;
const SERVER_EXECUTE_KEYS = [
  'capability', 'commandSequence', 'connectionGeneration', 'operationId', 'sessionId', 'type', 'version',
] as const;
const SERVER_CANCEL_KEYS = [
  'commandSequence', 'connectionGeneration', 'operationId', 'sessionId', 'type', 'version',
] as const;
const CLIENT_READY_KEYS = ['connectionGeneration', 'sessionId', 'type', 'version'] as const;
const CLIENT_AUTHORIZED_KEYS = [
  'auth', 'commandSequence', 'connectionGeneration', 'operationId', 'sessionId', 'type', 'version', 'workspaceAttestation',
] as const;
const CLIENT_EVENT_KEYS = [
  'connectionGeneration', 'eventSequence', 'eventType', 'message', 'operationId', 'sessionId', 'type', 'version',
] as const;
const CLIENT_EVENT_KEYS_NO_MESSAGE = [
  'connectionGeneration', 'eventSequence', 'eventType', 'operationId', 'sessionId', 'type', 'version',
] as const;
const CLIENT_REVIEW_RESULT_KEYS = [
  'connectionGeneration', 'eventSequence', 'operationId', 'result', 'sessionId', 'type', 'version',
] as const;
const CLIENT_IMPLEMENTATION_RESULT_KEYS = [
  'connectionGeneration', 'eventSequence', 'operationId', 'outcome', 'sessionId', 'type', 'version',
] as const;
const CLIENT_CANCEL_ACK_KEYS = [
  'commandSequence', 'connectionGeneration', 'operationId', 'sessionId', 'type', 'version',
] as const;

function fail(code: IdeRemoteTransportErrorCode, message: string): never {
  throw new IdeRemoteTransportError(code, message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport frame fields are invalid');
  }
}
function safePositive(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('IDE_REMOTE_INVALID_SCHEMA', `${field} is invalid`);
}
function safeNonNegative(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('IDE_REMOTE_INVALID_SCHEMA', `${field} is invalid`);
}
function validateBinding(value: { sessionId: unknown; connectionGeneration: unknown; operationId: unknown }): void {
  try {
    assertIdeSessionId(value.sessionId);
    assertIdeConnectionGeneration(value.connectionGeneration);
    assertIdeOperationId(value.operationId);
  } catch {
    fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport operation binding is invalid');
  }
}
function validateCapability(value: unknown): asserts value is IdeRemoteOperationCapability {
  if (value !== 'request_review' && value !== 'request_implementation') {
    fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport capability is invalid');
  }
}
function validatePrompt(value: unknown): asserts value is string {
  if (typeof value !== 'string') fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport prompt is invalid');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES) {
    fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport prompt exceeds bound');
  }
}
function validateMessage(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_IDE_EVENT_MESSAGE_BYTES) {
    fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport event message exceeds bound');
  }
}
function normalizeAuth(value: unknown): IdeCompanionAuthEnvelope {
  if (!isRecord(value)) fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport auth must be an object');
  let parsed: IdeCompanionAuthEnvelope;
  try { parsed = parseIdeCompanionAuthFrame(JSON.stringify(value)); }
  catch { fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport auth envelope is invalid'); }
  return {
    version: parsed.version,
    enrollmentId: parsed.enrollmentId,
    ideInstanceId: parsed.ideInstanceId,
    sessionId: parsed.sessionId,
    connectionGeneration: parsed.connectionGeneration,
    controllerLeaseId: parsed.controllerLeaseId,
    operationId: parsed.operationId,
    capability: parsed.capability,
    nonce: parsed.nonce,
    issuedAtMs: parsed.issuedAtMs,
    expiresAtMs: parsed.expiresAtMs,
    payloadSha256: parsed.payloadSha256,
    mac: parsed.mac,
  };
}
function parseJson(bytes: Uint8Array | string): { text: string; value: Record<string, unknown> } {
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  if (raw.byteLength < 1 || raw.byteLength > IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES) {
    fail('IDE_REMOTE_FRAME_SIZE', 'remote transport frame exceeds bound');
  }
  let text: string;
  try { text = decoder.decode(raw); } catch { fail('IDE_REMOTE_INVALID_UTF8', 'remote transport frame is not valid UTF-8'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { fail('IDE_REMOTE_INVALID_JSON', 'remote transport frame is not valid JSON'); }
  if (!isRecord(parsed)) fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport frame must be an object');
  return { text, value: parsed };
}
function commonSession(value: Record<string, unknown>): void {
  if (value.version !== IDE_REMOTE_TRANSPORT_VERSION) fail('IDE_REMOTE_UNSUPPORTED_VERSION', 'remote transport version is unsupported');
  try {
    assertIdeSessionId(value.sessionId);
    assertIdeConnectionGeneration(value.connectionGeneration);
  } catch { fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport session binding is invalid'); }
}
function commonOperation(value: Record<string, unknown>): void {
  commonSession(value);
  try { assertIdeOperationId(value.operationId); }
  catch { fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport operation identity is invalid'); }
}
function validateServerFrame(value: Record<string, unknown>): IdeRemoteServerFrame {
  commonOperation(value);
  safePositive(value.commandSequence, 'commandSequence');
  if (value.type === 'authorize_operation') {
    exactKeys(value, SERVER_AUTHORIZE_KEYS);
    validateCapability(value.capability);
    validatePrompt(value.prompt);
    try { assertIdeControllerLeaseId(value.controllerLeaseId); }
    catch { fail('IDE_REMOTE_INVALID_SCHEMA', 'controllerLeaseId is invalid'); }
    return value as unknown as IdeRemoteAuthorizeOperationCommand;
  }
  if (value.type === 'execute_operation') {
    exactKeys(value, SERVER_EXECUTE_KEYS);
    validateCapability(value.capability);
    return value as unknown as IdeRemoteExecuteOperationCommand;
  }
  if (value.type === 'cancel_operation') {
    exactKeys(value, SERVER_CANCEL_KEYS);
    return value as unknown as IdeRemoteCancelOperationCommand;
  }
  fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport server frame type is invalid');
}
function validateClientFrame(value: Record<string, unknown>): IdeRemoteClientFrame {
  if (value.type === 'transport_ready') {
    exactKeys(value, CLIENT_READY_KEYS);
    commonSession(value);
    return value as unknown as IdeRemoteTransportReadyFrame;
  }
  commonOperation(value);
  if (value.type === 'operation_authorized') {
    exactKeys(value, CLIENT_AUTHORIZED_KEYS);
    safePositive(value.commandSequence, 'commandSequence');
    if (typeof value.workspaceAttestation !== 'string') fail('IDE_REMOTE_INVALID_SCHEMA', 'workspaceAttestation is invalid');
    const bytes = Buffer.byteLength(value.workspaceAttestation, 'utf8');
    if (bytes < 1 || bytes > IDE_WORKSPACE_ATTESTATION_MAX_BYTES) fail('IDE_REMOTE_INVALID_SCHEMA', 'workspaceAttestation exceeds bound');
    return { ...(value as unknown as Omit<IdeRemoteOperationAuthorizedFrame, 'auth'>), auth: normalizeAuth(value.auth) };
  }
  if (value.type === 'adapter_event') {
    const hasMessage = Object.prototype.hasOwnProperty.call(value, 'message');
    exactKeys(value, hasMessage ? CLIENT_EVENT_KEYS : CLIENT_EVENT_KEYS_NO_MESSAGE);
    safeNonNegative(value.eventSequence, 'eventSequence');
    if (!(IDE_REMOTE_ADAPTER_EVENT_TYPES as readonly unknown[]).includes(value.eventType)) fail('IDE_REMOTE_INVALID_SCHEMA', 'adapter event type is invalid');
    if (hasMessage) validateMessage(value.message);
    return value as unknown as IdeRemoteAdapterEventFrame;
  }
  if (value.type === 'review_result') {
    exactKeys(value, CLIENT_REVIEW_RESULT_KEYS);
    safeNonNegative(value.eventSequence, 'eventSequence');
    if (!(IDE_REMOTE_REVIEW_RESULTS as readonly unknown[]).includes(value.result)) fail('IDE_REMOTE_INVALID_SCHEMA', 'review result is invalid');
    return value as unknown as IdeRemoteReviewResultFrame;
  }
  if (value.type === 'implementation_result') {
    exactKeys(value, CLIENT_IMPLEMENTATION_RESULT_KEYS);
    safeNonNegative(value.eventSequence, 'eventSequence');
    if (!(IDE_REMOTE_IMPLEMENTATION_OUTCOMES as readonly unknown[]).includes(value.outcome)) fail('IDE_REMOTE_INVALID_SCHEMA', 'implementation outcome is invalid');
    return value as unknown as IdeRemoteImplementationResultFrame;
  }
  if (value.type === 'cancel_ack') {
    exactKeys(value, CLIENT_CANCEL_ACK_KEYS);
    safePositive(value.commandSequence, 'commandSequence');
    return value as unknown as IdeRemoteCancelAcknowledgedFrame;
  }
  fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport client frame type is invalid');
}

function canonicalServer(frame: IdeRemoteServerFrame): Record<string, unknown> {
  if (frame.type === 'authorize_operation') return {
    capability: frame.capability,
    commandSequence: frame.commandSequence,
    connectionGeneration: frame.connectionGeneration,
    controllerLeaseId: frame.controllerLeaseId,
    operationId: frame.operationId,
    prompt: frame.prompt,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
  };
  if (frame.type === 'execute_operation') return {
    capability: frame.capability,
    commandSequence: frame.commandSequence,
    connectionGeneration: frame.connectionGeneration,
    operationId: frame.operationId,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
  };
  return {
    commandSequence: frame.commandSequence,
    connectionGeneration: frame.connectionGeneration,
    operationId: frame.operationId,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
  };
}
function canonicalClient(frame: IdeRemoteClientFrame): Record<string, unknown> {
  if (frame.type === 'transport_ready') return {
    connectionGeneration: frame.connectionGeneration,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
  };
  if (frame.type === 'operation_authorized') return {
    auth: normalizeAuth(frame.auth),
    commandSequence: frame.commandSequence,
    connectionGeneration: frame.connectionGeneration,
    operationId: frame.operationId,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
    workspaceAttestation: frame.workspaceAttestation,
  };
  if (frame.type === 'adapter_event') return {
    connectionGeneration: frame.connectionGeneration,
    eventSequence: frame.eventSequence,
    eventType: frame.eventType,
    ...(frame.message === undefined ? {} : { message: frame.message }),
    operationId: frame.operationId,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
  };
  if (frame.type === 'review_result') return {
    connectionGeneration: frame.connectionGeneration,
    eventSequence: frame.eventSequence,
    operationId: frame.operationId,
    result: frame.result,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
  };
  if (frame.type === 'implementation_result') return {
    connectionGeneration: frame.connectionGeneration,
    eventSequence: frame.eventSequence,
    operationId: frame.operationId,
    outcome: frame.outcome,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
  };
  return {
    commandSequence: frame.commandSequence,
    connectionGeneration: frame.connectionGeneration,
    operationId: frame.operationId,
    sessionId: frame.sessionId,
    type: frame.type,
    version: frame.version,
  };
}

export function serializeIdeRemoteServerFrame(frame: IdeRemoteServerFrame): string {
  const valid = validateServerFrame(canonicalServer(frame));
  return JSON.stringify(canonicalServer(valid));
}
export function parseIdeRemoteServerFrame(bytes: Uint8Array | string): IdeRemoteServerFrame {
  const { text, value } = parseJson(bytes);
  const valid = validateServerFrame(value);
  if (JSON.stringify(canonicalServer(valid)) !== text) fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport server frame must be canonical JSON');
  return valid;
}
export function serializeIdeRemoteClientFrame(frame: IdeRemoteClientFrame): string {
  const valid = validateClientFrame(canonicalClient(frame));
  return JSON.stringify(canonicalClient(valid));
}
export function parseIdeRemoteClientFrame(bytes: Uint8Array | string): IdeRemoteClientFrame {
  const { text, value } = parseJson(bytes);
  const valid = validateClientFrame(value);
  if (JSON.stringify(canonicalClient(valid)) !== text) fail('IDE_REMOTE_INVALID_SCHEMA', 'remote transport client frame must be canonical JSON');
  return valid;
}
