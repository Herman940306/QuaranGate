/**
 * Backend-neutral IDE Session Control contracts (P7 / I0 foundation).
 *
 * This module is deliberately pure. It does not discover IDEs, open sockets,
 * invoke providers, resolve host paths, or grant authority. Vendor adapters
 * and the executor must bind these logical identities to trusted enrollment
 * and project/worktree configuration before an operation is admitted.
 */

// ---------------------------------------------------------------------------
// Closed identifiers and capability vocabulary
// ---------------------------------------------------------------------------

export const IDE_PRODUCT_IDS = ['vscode', 'kiro', 'cursor', 'visual-studio', 'antigravity'] as const;
export type IdeProductId = (typeof IDE_PRODUCT_IDS)[number];

export const IDE_CAPABILITIES = [
  'prompt',
  'cancel',
  'observe_response',
  'read_bounded_editor_context',
  'request_review',
  'request_implementation',
] as const;
export type IdeCapability = (typeof IDE_CAPABILITIES)[number];

/** Initial safe profile. Editor-context access is a separate explicit grant. */
export const IDE_REVIEW_BASE_CAPABILITIES: readonly IdeCapability[] = [
  'prompt',
  'cancel',
  'observe_response',
  'request_review',
] as const;

export const IDE_INVOCATION_ORIGINS = ['human', 'machine'] as const;
export type IdeInvocationOrigin = (typeof IDE_INVOCATION_ORIGINS)[number];

/** QuaranGate-owned opaque identities; none of these are host paths. */
export const IDE_INSTANCE_ID_PATTERN = /^ide_[0-9a-f]{32}$/;
export const IDE_SESSION_ID_PATTERN = /^ides_[0-9a-f]{32}$/;
export const IDE_OPERATION_ID_PATTERN = /^ideo_[0-9a-f]{32}$/;
export const IDE_PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const IDE_LOGICAL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const IDE_WORKSPACE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
export const IDE_GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

export const MAX_IDE_EVENT_MESSAGE_BYTES = 8 * 1024;

export type IdeSessionContractErrorCode =
  | 'INVALID_IDE_IDENTITY'
  | 'INVALID_IDE_SESSION_TRANSITION'
  | 'INVALID_IDE_OPERATION_TRANSITION'
  | 'IDE_BINDING_MISMATCH'
  | 'IDE_GENERATION_MISMATCH'
  | 'IDE_CAPABILITY_DENIED'
  | 'IDE_SESSION_STATE_DENIED'
  | 'IDE_CONTROLLER_LEASE_REQUIRED'
  | 'IDE_WRITER_LEASE_REQUIRED'
  | 'IDE_EVENT_SEQUENCE_INVALID'
  | 'IDE_EVENT_TERMINAL';

export class IdeSessionContractError extends Error {
  public constructor(public readonly code: IdeSessionContractErrorCode, message: string) {
    super(message);
    this.name = 'IdeSessionContractError';
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function assertPattern(value: unknown, pattern: RegExp, field: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', `${field} is invalid`);
  }
}

export function assertIdeInstanceId(value: unknown): asserts value is string {
  assertPattern(value, IDE_INSTANCE_ID_PATTERN, 'ideInstanceId');
}

export function assertIdeSessionId(value: unknown): asserts value is string {
  assertPattern(value, IDE_SESSION_ID_PATTERN, 'sessionId');
}

export function assertIdeOperationId(value: unknown): asserts value is string {
  assertPattern(value, IDE_OPERATION_ID_PATTERN, 'operationId');
}

export function assertIdePrincipalId(value: unknown): asserts value is string {
  assertPattern(value, IDE_PRINCIPAL_ID_PATTERN, 'principalId');
}

export function assertIdeLogicalId(value: unknown, field = 'logicalId'): asserts value is string {
  assertPattern(value, IDE_LOGICAL_ID_PATTERN, field);
}

export function assertIdeWorkspaceFingerprint(value: unknown): asserts value is string {
  assertPattern(value, IDE_WORKSPACE_FINGERPRINT_PATTERN, 'workspaceFingerprint');
}

export function assertIdeConnectionGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'connectionGeneration must be a positive safe integer');
  }
}

export function assertIdeProduct(value: unknown): asserts value is IdeProductId {
  if (!oneOf(value, IDE_PRODUCT_IDS)) {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'ideProduct is unsupported');
  }
}

export function assertIdeCapability(value: unknown): asserts value is IdeCapability {
  if (!oneOf(value, IDE_CAPABILITIES)) {
    throw new IdeSessionContractError('IDE_CAPABILITY_DENIED', 'IDE capability is unsupported');
  }
}

export function ideCapabilityRequiresWriterLease(capability: IdeCapability): boolean {
  return capability === 'request_implementation';
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export const IDE_SESSION_STATES = [
  'DISCOVERED',
  'ENROLLED',
  'CONNECTED',
  'AVAILABLE',
  'CONTROLLER_ACQUIRED',
  'OPERATION_ACTIVE',
  'DISCONNECTED',
  'STALE',
] as const;
export type IdeSessionState = (typeof IDE_SESSION_STATES)[number];

const IDE_SESSION_TRANSITIONS: Record<IdeSessionState, readonly IdeSessionState[]> = {
  DISCOVERED: ['ENROLLED'],
  ENROLLED: ['CONNECTED', 'STALE'],
  CONNECTED: ['AVAILABLE', 'DISCONNECTED', 'STALE'],
  AVAILABLE: ['CONTROLLER_ACQUIRED', 'DISCONNECTED', 'STALE'],
  CONTROLLER_ACQUIRED: ['AVAILABLE', 'OPERATION_ACTIVE', 'DISCONNECTED', 'STALE'],
  OPERATION_ACTIVE: ['CONTROLLER_ACQUIRED', 'DISCONNECTED', 'STALE'],
  DISCONNECTED: [],
  STALE: [],
};

export function canTransitionIdeSession(from: IdeSessionState, to: IdeSessionState): boolean {
  return IDE_SESSION_TRANSITIONS[from].includes(to);
}

export function assertIdeSessionTransition(from: IdeSessionState, to: IdeSessionState): void {
  if (!canTransitionIdeSession(from, to)) {
    throw new IdeSessionContractError(
      'INVALID_IDE_SESSION_TRANSITION',
      `invalid IDE session transition ${from} -> ${to}`,
    );
  }
}

export function isTerminalIdeSessionState(state: IdeSessionState): boolean {
  return IDE_SESSION_TRANSITIONS[state].length === 0;
}

// ---------------------------------------------------------------------------
// Operation lifecycle
// ---------------------------------------------------------------------------

export const IDE_OPERATION_STATES = [
  'PENDING',
  'RUNNING',
  'CANCELLING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'DISCONNECTED',
  'INDETERMINATE',
] as const;
export type IdeOperationState = (typeof IDE_OPERATION_STATES)[number];

const IDE_OPERATION_TRANSITIONS: Record<IdeOperationState, readonly IdeOperationState[]> = {
  PENDING: ['RUNNING', 'CANCELLED', 'FAILED', 'DISCONNECTED', 'INDETERMINATE'],
  RUNNING: ['CANCELLING', 'COMPLETED', 'CANCELLED', 'FAILED', 'DISCONNECTED', 'INDETERMINATE'],
  CANCELLING: ['CANCELLED', 'FAILED', 'DISCONNECTED', 'INDETERMINATE'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
  DISCONNECTED: [],
  INDETERMINATE: [],
};

export function canTransitionIdeOperation(from: IdeOperationState, to: IdeOperationState): boolean {
  return IDE_OPERATION_TRANSITIONS[from].includes(to);
}

export function assertIdeOperationTransition(from: IdeOperationState, to: IdeOperationState): void {
  if (!canTransitionIdeOperation(from, to)) {
    throw new IdeSessionContractError(
      'INVALID_IDE_OPERATION_TRANSITION',
      `invalid IDE operation transition ${from} -> ${to}`,
    );
  }
}

export function isTerminalIdeOperationState(state: IdeOperationState): boolean {
  return IDE_OPERATION_TRANSITIONS[state].length === 0;
}

// ---------------------------------------------------------------------------
// Full-tuple logical binding
// ---------------------------------------------------------------------------

export interface IdeSessionBinding {
  principalId: string;
  projectId: string;
  worktreeId: string;
  workspaceFingerprint: string;
  baseRevision?: string;
  ideProduct: IdeProductId;
  ideInstanceId: string;
  sessionId: string;
  connectionGeneration: number;
  capabilities: readonly IdeCapability[];
  sessionState: IdeSessionState;
  controllerLease: 'none' | 'acquired';
  writerLease: 'none' | 'acquired';
}

export interface IdeSessionAuthorityRequest {
  principalId: string;
  projectId: string;
  worktreeId: string;
  workspaceFingerprint: string;
  baseRevision?: string;
  ideProduct: IdeProductId;
  ideInstanceId: string;
  sessionId: string;
  connectionGeneration: number;
  capability: IdeCapability;
}

function validateBaseRevision(value: string | undefined): void {
  if (value !== undefined && !IDE_GIT_REVISION_PATTERN.test(value)) {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'baseRevision is invalid');
  }
}

export function validateIdeSessionBinding(binding: IdeSessionBinding): void {
  assertIdePrincipalId(binding.principalId);
  assertIdeLogicalId(binding.projectId, 'projectId');
  assertIdeLogicalId(binding.worktreeId, 'worktreeId');
  assertIdeWorkspaceFingerprint(binding.workspaceFingerprint);
  validateBaseRevision(binding.baseRevision);
  assertIdeProduct(binding.ideProduct);
  assertIdeInstanceId(binding.ideInstanceId);
  assertIdeSessionId(binding.sessionId);
  assertIdeConnectionGeneration(binding.connectionGeneration);
  if (!oneOf(binding.sessionState, IDE_SESSION_STATES)) {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'sessionState is invalid');
  }
  if (binding.controllerLease !== 'none' && binding.controllerLease !== 'acquired') {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'controllerLease is invalid');
  }
  if (binding.writerLease !== 'none' && binding.writerLease !== 'acquired') {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'writerLease is invalid');
  }
  const controllerState = binding.sessionState === 'CONTROLLER_ACQUIRED' || binding.sessionState === 'OPERATION_ACTIVE';
  if ((binding.controllerLease === 'acquired') !== controllerState) {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'controller lease and session state are inconsistent');
  }
  if (binding.writerLease === 'acquired' && binding.controllerLease !== 'acquired') {
    throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'writer lease requires controller lease');
  }
  const seen = new Set<IdeCapability>();
  for (const capability of binding.capabilities) {
    assertIdeCapability(capability);
    if (seen.has(capability)) {
      throw new IdeSessionContractError('INVALID_IDE_IDENTITY', 'duplicate IDE capability');
    }
    seen.add(capability);
  }
}

export function assertIdeSessionAuthority(
  current: IdeSessionBinding,
  requested: IdeSessionAuthorityRequest,
): void {
  validateIdeSessionBinding(current);
  assertIdePrincipalId(requested.principalId);
  assertIdeLogicalId(requested.projectId, 'projectId');
  assertIdeLogicalId(requested.worktreeId, 'worktreeId');
  assertIdeWorkspaceFingerprint(requested.workspaceFingerprint);
  validateBaseRevision(requested.baseRevision);
  assertIdeProduct(requested.ideProduct);
  assertIdeInstanceId(requested.ideInstanceId);
  assertIdeSessionId(requested.sessionId);
  assertIdeConnectionGeneration(requested.connectionGeneration);
  assertIdeCapability(requested.capability);

  if (requested.connectionGeneration !== current.connectionGeneration) {
    throw new IdeSessionContractError('IDE_GENERATION_MISMATCH', 'IDE connection generation is stale or mismatched');
  }

  const exactFields: Array<[string, unknown, unknown]> = [
    ['principalId', requested.principalId, current.principalId],
    ['projectId', requested.projectId, current.projectId],
    ['worktreeId', requested.worktreeId, current.worktreeId],
    ['workspaceFingerprint', requested.workspaceFingerprint, current.workspaceFingerprint],
    ['baseRevision', requested.baseRevision, current.baseRevision],
    ['ideProduct', requested.ideProduct, current.ideProduct],
    ['ideInstanceId', requested.ideInstanceId, current.ideInstanceId],
    ['sessionId', requested.sessionId, current.sessionId],
  ];
  const mismatch = exactFields.find(([, requestedValue, currentValue]) => requestedValue !== currentValue);
  if (mismatch !== undefined) {
    throw new IdeSessionContractError('IDE_BINDING_MISMATCH', `IDE binding mismatch: ${mismatch[0]}`);
  }

  if (!current.capabilities.includes(requested.capability)) {
    throw new IdeSessionContractError('IDE_CAPABILITY_DENIED', 'IDE capability is not granted');
  }
  if (current.controllerLease !== 'acquired') {
    throw new IdeSessionContractError('IDE_CONTROLLER_LEASE_REQUIRED', 'IDE capability requires controller lease');
  }
  const startCapability = requested.capability === 'prompt'
    || requested.capability === 'request_review'
    || requested.capability === 'request_implementation';
  const expectedState: IdeSessionState = startCapability ? 'CONTROLLER_ACQUIRED' : 'OPERATION_ACTIVE';
  if (current.sessionState !== expectedState) {
    throw new IdeSessionContractError('IDE_SESSION_STATE_DENIED', `IDE capability is not valid in ${current.sessionState}`);
  }
  if (ideCapabilityRequiresWriterLease(requested.capability) && current.writerLease !== 'acquired') {
    throw new IdeSessionContractError('IDE_WRITER_LEASE_REQUIRED', 'IDE implementation capability requires writer lease');
  }
}

// ---------------------------------------------------------------------------
// Normalized event envelope and sequence enforcement
// ---------------------------------------------------------------------------

export const IDE_EVENT_TYPES = [
  'operation_started',
  'assistant_chunk',
  'tool_activity',
  'status',
  'completed',
  'cancelled',
  'failed',
  'disconnected',
  'indeterminate',
] as const;
export type IdeEventType = (typeof IDE_EVENT_TYPES)[number];

export const IDE_TERMINAL_EVENT_TYPES: readonly IdeEventType[] = [
  'completed',
  'cancelled',
  'failed',
  'disconnected',
  'indeterminate',
] as const;

export interface IdeOperationEvent {
  version: 1;
  operationId: string;
  sessionId: string;
  connectionGeneration: number;
  origin: IdeInvocationOrigin;
  sequence: number;
  type: IdeEventType;
  message?: string;
}

export function isTerminalIdeEventType(type: IdeEventType): boolean {
  return IDE_TERMINAL_EVENT_TYPES.includes(type);
}

export function validateIdeOperationEvent(event: IdeOperationEvent): void {
  if (event.version !== 1) {
    throw new IdeSessionContractError('IDE_EVENT_SEQUENCE_INVALID', 'IDE event version is unsupported');
  }
  assertIdeOperationId(event.operationId);
  assertIdeSessionId(event.sessionId);
  assertIdeConnectionGeneration(event.connectionGeneration);
  if (!oneOf(event.origin, IDE_INVOCATION_ORIGINS)) {
    throw new IdeSessionContractError('IDE_EVENT_SEQUENCE_INVALID', 'IDE event origin is invalid');
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw new IdeSessionContractError('IDE_EVENT_SEQUENCE_INVALID', 'IDE event sequence is invalid');
  }
  if (!oneOf(event.type, IDE_EVENT_TYPES)) {
    throw new IdeSessionContractError('IDE_EVENT_SEQUENCE_INVALID', 'IDE event type is invalid');
  }
  if (event.message !== undefined) {
    if (typeof event.message !== 'string' || Buffer.byteLength(event.message, 'utf8') > MAX_IDE_EVENT_MESSAGE_BYTES) {
      throw new IdeSessionContractError('IDE_EVENT_SEQUENCE_INVALID', 'IDE event message exceeds bound');
    }
  }
}

/**
 * Per-operation fail-closed event ordering. A reconnect/new generation must use
 * a new tracker; a terminal event permanently closes this operation stream.
 */
export class IdeEventSequenceTracker {
  private nextSequence = 0;
  private terminal = false;

  public constructor(
    private readonly operationId: string,
    private readonly sessionId: string,
    private readonly connectionGeneration: number,
  ) {
    assertIdeOperationId(operationId);
    assertIdeSessionId(sessionId);
    assertIdeConnectionGeneration(connectionGeneration);
  }

  public accept(event: IdeOperationEvent): void {
    validateIdeOperationEvent(event);
    if (this.terminal) {
      throw new IdeSessionContractError('IDE_EVENT_TERMINAL', 'late IDE event after terminal outcome');
    }
    if (
      event.operationId !== this.operationId
      || event.sessionId !== this.sessionId
      || event.connectionGeneration !== this.connectionGeneration
    ) {
      throw new IdeSessionContractError('IDE_BINDING_MISMATCH', 'IDE event binding does not match operation');
    }
    if (event.sequence !== this.nextSequence) {
      throw new IdeSessionContractError('IDE_EVENT_SEQUENCE_INVALID', 'IDE event sequence is duplicate, missing, or out of order');
    }
    if (this.nextSequence === 0 && event.type !== 'operation_started') {
      throw new IdeSessionContractError('IDE_EVENT_SEQUENCE_INVALID', 'first IDE event must be operation_started');
    }
    this.nextSequence += 1;
    if (isTerminalIdeEventType(event.type)) {
      this.terminal = true;
    }
  }

  public isTerminal(): boolean {
    return this.terminal;
  }

  public expectedSequence(): number {
    return this.nextSequence;
  }
}
