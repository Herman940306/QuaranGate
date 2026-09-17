/**
 * P7 I2.2 QuaranGate-side remote companion transport state machine.
 *
 * This channel transports QuaranGate-origin commands over one already B6-
 * authenticated connection. It does not create controller/writer authority.
 * The authorization response must still be admitted through B7/B9 by the
 * trusted caller before executeOperation is sent.
 */
import { hashIdeCompanionPayload } from '../../shared/ideCompanionAuth.js';
import {
  serializeIdeCompanionImplementationPayload,
  serializeIdeCompanionReviewPayload,
} from '../../shared/ideCompanionOperations.js';
import {
  IdeRemoteTransportError,
  parseIdeRemoteClientFrame,
  type IdeRemoteClientFrame,
  type IdeRemoteImplementationOutcome,
  type IdeRemoteOperationAuthorizedFrame,
  type IdeRemoteOperationCapability,
  type IdeRemoteReviewIntentFrame,
  type IdeRemoteReviewIntentCancelFrame,
  type IdeRemoteReviewIntentRejection,
  type IdeRemoteServerFrame,
} from '../../shared/ideCompanionRemoteTransport.js';
import { parseIdeWorkspaceAttestation } from '../../shared/ideWorkspaceAttestation.js';
import type { IdeImplementationOperationAdapter } from './ideImplementationCoordinator.js';
import type { IdeOperationEvent } from '../../shared/ideSessions.js';
import type { IdeReviewOperationAdapter } from './ideOperationCoordinator.js';

export const IDE_REMOTE_AUTHORIZATION_TIMEOUT_MS = 20_000;

export type IdeCompanionRemoteChannelErrorCode =
  | 'IDE_REMOTE_CHANNEL_CLOSED'
  | 'IDE_REMOTE_CHANNEL_BUSY'
  | 'IDE_REMOTE_CHANNEL_BINDING_MISMATCH'
  | 'IDE_REMOTE_CHANNEL_SEQUENCE'
  | 'IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID'
  | 'IDE_REMOTE_CHANNEL_UNEXPECTED_FRAME'
  | 'IDE_REMOTE_CHANNEL_SEND_FAILED'
  | 'IDE_REMOTE_CHANNEL_TIMEOUT';

export class IdeCompanionRemoteChannelError extends Error {
  constructor(public readonly code: IdeCompanionRemoteChannelErrorCode, message: string) {
    super(message);
    this.name = 'IdeCompanionRemoteChannelError';
  }
}

export interface IdeCompanionRemoteChannelOptions {
  sessionId: string;
  connectionGeneration: number;
  send(frame: IdeRemoteServerFrame): boolean;
  close(): void;
  /** Trusted Plane-B reread: remote execution is forbidden until B7/B9 durably admitted this exact operation. */
  isOperationAdmitted(operationId: string, capability: IdeRemoteOperationCapability): boolean;
  /** Optional trusted QuaranGate-side sink for non-authoritative user review intents. */
  onReviewIntent?: (frame: IdeRemoteReviewIntentFrame) => void;
  /** Optional trusted QuaranGate-side sink for exact intent cancellation. */
  onReviewIntentCancel?: (frame: IdeRemoteReviewIntentCancelFrame) => void;
  authorizationTimeoutMs?: number;
}

export interface IdeRemoteAuthorizationRequest {
  operationId: string;
  controllerLeaseId: string;
  capability: IdeRemoteOperationCapability;
  prompt: string;
}

interface AuthorizedOperation {
  operationId: string;
  capability: IdeRemoteOperationCapability;
  prompt: string;
  authorization: IdeRemoteOperationAuthorizedFrame;
}
interface PendingAuthorization {
  sequence: number;
  request: IdeRemoteAuthorizationRequest;
  resolve(value: IdeRemoteOperationAuthorizedFrame): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
interface ActiveExecution {
  operationId: string;
  capability: IdeRemoteOperationCapability;
  nextEventSequence: number;
  emit(type: 'assistant_chunk'|'tool_activity'|'status', message?: string): void;
  resolveReview?: () => void;
  rejectReview?: (error: Error) => void;
  resolveImplementation?: (value: { outcome: IdeRemoteImplementationOutcome }) => void;
  rejectImplementation?: (error: Error) => void;
  cancelSequence?: number;
}

function err(code: IdeCompanionRemoteChannelErrorCode, message: string): IdeCompanionRemoteChannelError {
  return new IdeCompanionRemoteChannelError(code, message);
}

export class IdeCompanionRemoteChannel {
  readonly sessionId: string;
  readonly connectionGeneration: number;
  private nextCommandSequence = 1;
  private nextReviewIntentSequence = 1;
  private pendingAuthorization?: PendingAuthorization;
  private authorized?: AuthorizedOperation;
  private active?: ActiveExecution;
  private closed = false;
  private transportReady = false;
  private readonly readyWaiters: Array<{resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}> = [];
  private readonly authorizationTimeoutMs: number;

  constructor(private readonly opts: IdeCompanionRemoteChannelOptions) {
    this.sessionId = opts.sessionId;
    this.connectionGeneration = opts.connectionGeneration;
    this.authorizationTimeoutMs = opts.authorizationTimeoutMs ?? IDE_REMOTE_AUTHORIZATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.authorizationTimeoutMs) || this.authorizationTimeoutMs < 1
      || this.authorizationTimeoutMs > IDE_REMOTE_AUTHORIZATION_TIMEOUT_MS) {
      throw err('IDE_REMOTE_CHANNEL_TIMEOUT', 'authorization timeout bound is invalid');
    }
  }

  authorizeOperation(request: IdeRemoteAuthorizationRequest): Promise<IdeRemoteOperationAuthorizedFrame> {
    this.requireOpen();
    if (!this.transportReady) return this.waitUntilReady().then(() => this.beginAuthorization(request));
    return this.beginAuthorization(request);
  }

  waitUntilReady(): Promise<void> {
    this.requireOpen();
    if (this.transportReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.readyWaiters.indexOf(waiter);
          if (index < 0 || this.closed || this.transportReady) return;
          this.readyWaiters.splice(index, 1);
          reject(err('IDE_REMOTE_CHANNEL_TIMEOUT', 'remote transport_ready timed out'));
          this.failClosed();
        }, this.authorizationTimeoutMs),
      };
      this.readyWaiters.push(waiter);
    });
  }

  private beginAuthorization(request: IdeRemoteAuthorizationRequest): Promise<IdeRemoteOperationAuthorizedFrame> {
    this.requireOpen();
    if (this.pendingAuthorization !== undefined || this.authorized !== undefined || this.active !== undefined) {
      throw err('IDE_REMOTE_CHANNEL_BUSY', 'remote companion already has an operation in flight');
    }
    const sequence = this.nextSequence();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingAuthorization?.sequence !== sequence) return;
        this.pendingAuthorization = undefined;
        reject(err('IDE_REMOTE_CHANNEL_TIMEOUT', 'remote operation authorization timed out'));
        this.failClosed();
      }, this.authorizationTimeoutMs);
      this.pendingAuthorization = { sequence, request, resolve, reject, timer };
      if (!this.send({
        version: 1,
        type: 'authorize_operation',
        sessionId: this.sessionId,
        connectionGeneration: this.connectionGeneration,
        commandSequence: sequence,
        operationId: request.operationId,
        controllerLeaseId: request.controllerLeaseId,
        capability: request.capability,
        prompt: request.prompt,
      })) {
        clearTimeout(timer);
        this.pendingAuthorization = undefined;
        reject(err('IDE_REMOTE_CHANNEL_SEND_FAILED', 'remote authorization command could not be sent'));
        this.failClosed();
      }
    });
  }

  reviewAdapter(): IdeReviewOperationAdapter {
    return { run: async (input) => {
      const authorized = this.requireAuthorized(input.operationId, 'request_review', input.prompt);
      if (!this.opts.isOperationAdmitted(input.operationId, 'request_review')) {
        throw err('IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID', 'remote review operation is not durably admitted by Plane-B');
      }
      if (input.sessionId !== this.sessionId || input.connectionGeneration !== this.connectionGeneration) {
        throw err('IDE_REMOTE_CHANNEL_BINDING_MISMATCH', 'review adapter session/generation mismatch');
      }
      await this.executeReview(authorized, input.signal, input.emit);
    } };
  }

  implementationAdapter(): IdeImplementationOperationAdapter {
    return { run: async (input) => {
      const authorized = this.requireAuthorized(input.operationId, 'request_implementation', input.prompt);
      if (!this.opts.isOperationAdmitted(input.operationId, 'request_implementation')) {
        throw err('IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID', 'remote implementation operation is not durably admitted by Plane-B');
      }
      if (input.sessionId !== this.sessionId || input.connectionGeneration !== this.connectionGeneration) {
        throw err('IDE_REMOTE_CHANNEL_BINDING_MISMATCH', 'implementation adapter session/generation mismatch');
      }
      return await this.executeImplementation(authorized, input.signal, input.emit);
    } };
  }

  discardAuthorization(operationId: string): boolean {
    if (this.active !== undefined || this.pendingAuthorization !== undefined) return false;
    if (this.authorized?.operationId !== operationId) return false;
    this.authorized = undefined;
    return true;
  }

  sendReviewIntentEvent(intentSequence: number, event: IdeOperationEvent): boolean {
    this.requireOpen();
    if (event.sessionId !== this.sessionId || event.connectionGeneration !== this.connectionGeneration) {
      throw err('IDE_REMOTE_CHANNEL_BINDING_MISMATCH', 'review intent event does not match authenticated session/generation');
    }
    return this.sendSequenced({
      version: 1,
      type: 'review_intent_event',
      sessionId: this.sessionId,
      connectionGeneration: this.connectionGeneration,
      commandSequence: this.nextSequence(),
      intentSequence,
      event,
    });
  }

  sendReviewIntentRejected(intentSequence: number, reason: IdeRemoteReviewIntentRejection): boolean {
    this.requireOpen();
    return this.sendSequenced({
      version: 1,
      type: 'review_intent_rejected',
      sessionId: this.sessionId,
      connectionGeneration: this.connectionGeneration,
      commandSequence: this.nextSequence(),
      intentSequence,
      reason,
    });
  }

  handleClientFrame(bytes: Uint8Array | string): void {
    this.requireOpen();
    let frame: IdeRemoteClientFrame;
    try { frame = parseIdeRemoteClientFrame(bytes); }
    catch (error) {
      this.protocolFailure(error instanceof Error ? error : err('IDE_REMOTE_CHANNEL_UNEXPECTED_FRAME', 'invalid remote frame'));
      return;
    }
    if (frame.sessionId !== this.sessionId || frame.connectionGeneration !== this.connectionGeneration) {
      this.protocolFailure(err('IDE_REMOTE_CHANNEL_BINDING_MISMATCH', 'remote client frame session/generation mismatch'));
      return;
    }
    try {
      if (frame.type === 'transport_ready') { this.acceptTransportReady(); return; }
      if (!this.transportReady) throw err('IDE_REMOTE_CHANNEL_UNEXPECTED_FRAME','remote client sent operation data before transport_ready');
      if (frame.type === 'review_intent') { this.acceptReviewIntent(frame); return; }
      if (frame.type === 'review_intent_cancel') { this.acceptReviewIntentCancel(frame); return; }
      if (frame.type === 'operation_authorized') { this.acceptAuthorization(frame); return; }
      if (frame.type === 'adapter_event') { this.acceptEvent(frame); return; }
      if (frame.type === 'review_result') { this.acceptReviewResult(frame); return; }
      if (frame.type === 'implementation_result') { this.acceptImplementationResult(frame); return; }
      this.acceptCancelAck(frame);
    } catch (error) {
      this.protocolFailure(error instanceof Error ? error : err('IDE_REMOTE_CHANNEL_UNEXPECTED_FRAME', 'remote client frame rejected'));
    }
  }

  connectionClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const failure = err('IDE_REMOTE_CHANNEL_CLOSED', 'authenticated remote companion connection closed');
    for (const waiter of this.readyWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(failure); }
    if (this.pendingAuthorization !== undefined) {
      clearTimeout(this.pendingAuthorization.timer);
      this.pendingAuthorization.reject(failure);
      this.pendingAuthorization = undefined;
    }
    this.rejectActive(failure);
    this.authorized = undefined;
  }

  private acceptTransportReady(): void {
    if (this.transportReady) throw err('IDE_REMOTE_CHANNEL_SEQUENCE','duplicate transport_ready');
    this.transportReady = true;
    for (const waiter of this.readyWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  }

  private acceptReviewIntent(frame: IdeRemoteReviewIntentFrame): void {
    if (frame.intentSequence !== this.nextReviewIntentSequence) {
      throw err('IDE_REMOTE_CHANNEL_SEQUENCE', 'review intent sequence is stale, replayed or skipped');
    }
    this.nextReviewIntentSequence += 1;
    const handler = this.opts.onReviewIntent;
    if (handler === undefined) {
      this.sendReviewIntentRejected(frame.intentSequence, 'BRIDGE_UNAVAILABLE');
      return;
    }
    handler(frame);
  }

  private acceptReviewIntentCancel(frame: IdeRemoteReviewIntentCancelFrame): void {
    if (frame.intentSequence < 1 || frame.intentSequence >= this.nextReviewIntentSequence) {
      throw err('IDE_REMOTE_CHANNEL_SEQUENCE', 'review intent cancellation is stale or unknown');
    }
    const handler = this.opts.onReviewIntentCancel;
    if (handler === undefined) {
      this.sendReviewIntentRejected(frame.intentSequence, 'BRIDGE_UNAVAILABLE');
      return;
    }
    handler(frame);
  }

  private acceptAuthorization(frame: IdeRemoteOperationAuthorizedFrame): void {
    const pending = this.pendingAuthorization;
    if (pending === undefined || frame.commandSequence !== pending.sequence || frame.operationId !== pending.request.operationId) {
      throw err('IDE_REMOTE_CHANNEL_SEQUENCE', 'unexpected or replayed operation authorization');
    }
    const auth = frame.auth;
    const request = pending.request;
    if (auth.sessionId !== this.sessionId || auth.connectionGeneration !== this.connectionGeneration
      || auth.operationId !== request.operationId || auth.controllerLeaseId !== request.controllerLeaseId
      || auth.capability !== request.capability) {
      throw err('IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID', 'returned B3 authorization does not match QuaranGate command');
    }
    const attestation = parseIdeWorkspaceAttestation(frame.workspaceAttestation);
    if (attestation.sessionId !== this.sessionId || attestation.connectionGeneration !== this.connectionGeneration) {
      throw err('IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID', 'returned B5 attestation session/generation is mismatched');
    }
    const payload = request.capability === 'request_review'
      ? serializeIdeCompanionReviewPayload(request.prompt, frame.workspaceAttestation)
      : serializeIdeCompanionImplementationPayload(request.prompt, frame.workspaceAttestation);
    if (auth.payloadSha256 !== hashIdeCompanionPayload(payload)) {
      throw err('IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID', 'returned B3 authorization payload hash does not bind exact prompt/workspace');
    }
    clearTimeout(pending.timer);
    this.pendingAuthorization = undefined;
    this.authorized = { operationId: request.operationId, capability: request.capability, prompt: request.prompt, authorization: frame };
    pending.resolve(frame);
  }

  private acceptEvent(frame: Extract<IdeRemoteClientFrame,{type:'adapter_event'}>): void {
    const active = this.requireActive(frame.operationId);
    if (frame.eventSequence !== active.nextEventSequence) throw err('IDE_REMOTE_CHANNEL_SEQUENCE', 'adapter event sequence is not contiguous');
    active.nextEventSequence += 1;
    active.emit(frame.eventType, frame.message);
  }

  private acceptReviewResult(frame: Extract<IdeRemoteClientFrame,{type:'review_result'}>): void {
    const active = this.requireActive(frame.operationId);
    if (active.capability !== 'request_review' || frame.eventSequence !== active.nextEventSequence || active.resolveReview === undefined || active.rejectReview === undefined) {
      throw err('IDE_REMOTE_CHANNEL_SEQUENCE', 'review result does not match active review operation');
    }
    this.active = undefined;
    this.authorized = undefined;
    if (frame.result === 'completed') active.resolveReview();
    else active.rejectReview(err('IDE_REMOTE_CHANNEL_CLOSED', `remote review ended ${frame.result}`));
  }

  private acceptImplementationResult(frame: Extract<IdeRemoteClientFrame,{type:'implementation_result'}>): void {
    const active = this.requireActive(frame.operationId);
    if (active.capability !== 'request_implementation' || frame.eventSequence !== active.nextEventSequence
      || active.resolveImplementation === undefined || active.rejectImplementation === undefined) {
      throw err('IDE_REMOTE_CHANNEL_SEQUENCE', 'implementation result does not match active implementation operation');
    }
    this.active = undefined;
    this.authorized = undefined;
    // The remote IDE/client is not an independent mutation oracle. A claimed
    // success/no-mutation/rollback outcome cannot prove filesystem state well
    // enough to release shared writer authority. Until QuaranGate owns an
    // independent postcondition verifier, every remote terminal is uncertain.
    active.resolveImplementation({ outcome: 'indeterminate' });
  }

  private acceptCancelAck(frame: Extract<IdeRemoteClientFrame,{type:'cancel_ack'}>): void {
    const active = this.requireActive(frame.operationId);
    if (active.cancelSequence === undefined || active.cancelSequence !== frame.commandSequence) {
      throw err('IDE_REMOTE_CHANNEL_SEQUENCE', 'cancel acknowledgement is stale or unexpected');
    }
    active.cancelSequence = undefined;
  }

  private executeReview(
    authorized: AuthorizedOperation,
    signal: AbortSignal,
    emit: (type:'assistant_chunk'|'tool_activity'|'status',message?:string)=>void,
  ): Promise<void> {
    this.requireOpen();
    if (this.active !== undefined) throw err('IDE_REMOTE_CHANNEL_BUSY', 'remote operation already active');
    const sequence = this.nextSequence();
    return new Promise((resolve, reject) => {
      const active: ActiveExecution = {
        operationId: authorized.operationId,
        capability: authorized.capability,
        nextEventSequence: 0,
        emit,
        resolveReview: resolve,
        rejectReview: reject,
      };
      this.active = active;
      if (!this.send({
        version:1,type:'execute_operation',sessionId:this.sessionId,connectionGeneration:this.connectionGeneration,
        commandSequence:sequence,operationId:authorized.operationId,capability:'request_review',
      })) {
        this.active = undefined;
        reject(err('IDE_REMOTE_CHANNEL_SEND_FAILED', 'remote review execute command could not be sent'));
        this.failClosed();
        return;
      }
      this.attachAbort(signal, active);
    });
  }

  private executeImplementation(
    authorized: AuthorizedOperation,
    signal: AbortSignal,
    emit: (type:'assistant_chunk'|'tool_activity'|'status',message?:string)=>void,
  ): Promise<{outcome:IdeRemoteImplementationOutcome}> {
    this.requireOpen();
    if (this.active !== undefined) throw err('IDE_REMOTE_CHANNEL_BUSY', 'remote operation already active');
    const sequence = this.nextSequence();
    return new Promise((resolve, reject) => {
      const active: ActiveExecution = {
        operationId: authorized.operationId,
        capability: authorized.capability,
        nextEventSequence: 0,
        emit,
        resolveImplementation: resolve,
        rejectImplementation: reject,
      };
      this.active = active;
      if (!this.send({
        version:1,type:'execute_operation',sessionId:this.sessionId,connectionGeneration:this.connectionGeneration,
        commandSequence:sequence,operationId:authorized.operationId,capability:'request_implementation',
      })) {
        this.active = undefined;
        reject(err('IDE_REMOTE_CHANNEL_SEND_FAILED', 'remote implementation execute command could not be sent'));
        this.failClosed();
        return;
      }
      this.attachAbort(signal, active);
    });
  }

  private attachAbort(signal: AbortSignal, active: ActiveExecution): void {
    const abort = (): void => {
      if (this.active !== active || active.cancelSequence !== undefined || this.closed) return;
      const sequence = this.nextSequence();
      active.cancelSequence = sequence;
      if (!this.send({
        version:1,type:'cancel_operation',sessionId:this.sessionId,connectionGeneration:this.connectionGeneration,
        commandSequence:sequence,operationId:active.operationId,
      })) this.failClosed();
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  private sendSequenced(frame: IdeRemoteServerFrame): boolean {
    if (!this.send(frame)) {
      this.failClosed();
      return false;
    }
    return true;
  }

  private send(frame: IdeRemoteServerFrame): boolean {
    try { return this.opts.send(frame); }
    catch { return false; }
  }

  private requireAuthorized(operationId: string, capability: IdeRemoteOperationCapability, prompt: string): AuthorizedOperation {
    this.requireOpen();
    const authorized = this.authorized;
    if (authorized === undefined || authorized.operationId !== operationId || authorized.capability !== capability || authorized.prompt !== prompt) {
      throw err('IDE_REMOTE_CHANNEL_AUTHORIZATION_INVALID', 'remote adapter call lacks exact prior QuaranGate authorization');
    }
    return authorized;
  }
  private requireActive(operationId: string): ActiveExecution {
    const active = this.active;
    if (active === undefined || active.operationId !== operationId) throw err('IDE_REMOTE_CHANNEL_UNEXPECTED_FRAME', 'remote frame has no exact active operation');
    return active;
  }
  private requireOpen(): void {
    if (this.closed) throw err('IDE_REMOTE_CHANNEL_CLOSED', 'remote companion channel is closed');
  }
  private nextSequence(): number {
    const value = this.nextCommandSequence;
    if (!Number.isSafeInteger(value) || value < 1 || value === Number.MAX_SAFE_INTEGER) {
      this.failClosed();
      throw err('IDE_REMOTE_CHANNEL_SEQUENCE', 'remote command sequence exhausted');
    }
    this.nextCommandSequence += 1;
    return value;
  }
  private rejectActive(error: Error): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    active.rejectReview?.(error);
    active.rejectImplementation?.(error);
  }
  private protocolFailure(error: Error): void {
    if (this.pendingAuthorization !== undefined) {
      clearTimeout(this.pendingAuthorization.timer);
      this.pendingAuthorization.reject(error);
      this.pendingAuthorization = undefined;
    }
    this.rejectActive(error);
    this.authorized = undefined;
    this.failClosed();
  }
  private failClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const failure=err('IDE_REMOTE_CHANNEL_CLOSED','remote companion channel failed closed');
    for(const waiter of this.readyWaiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(failure);}
    if (this.pendingAuthorization !== undefined) {
      clearTimeout(this.pendingAuthorization.timer);
      this.pendingAuthorization.reject(failure);
      this.pendingAuthorization = undefined;
    }
    this.rejectActive(failure);
    this.authorized = undefined;
    this.opts.close();
  }
}
