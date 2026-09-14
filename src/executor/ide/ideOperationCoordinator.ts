/**
 * P7 B7 non-mutating IDE review-operation coordinator.
 *
 * Durable lifecycle/audit lives in Plane-B. This coordinator owns only the
 * in-process adapter handle and AbortController. It never persists prompt or
 * response bodies and never grants writer authority.
 */
import { hashIdeCompanionPayload, type IdeCompanionAuthEnvelope } from '../../shared/ideCompanionAuth.js';
import { serializeIdeCompanionReviewPayload } from '../../shared/ideCompanionOperations.js';
import type { IdeOperationEvent } from '../../shared/ideSessions.js';
import { admitIdeCompanionRuntimeRequest } from './ideCompanionRuntimeAdmission.js';
import type { IdeCompanionRuntimeRef } from './ideCompanionRuntime.js';
import { verifyAuthenticatedIdeWorkspace } from './ideWorkspaceAttestation.js';
import {
  IdeRegistryStoreError,
  IdeSessionStore,
  type IdeOperationRow,
} from './ideSessionStore.js';

export const IDE_REVIEW_OPERATION_MAX_RUNTIME_MS = 10 * 60 * 1000;

export type IdeReviewAdapterEventType = 'assistant_chunk' | 'tool_activity' | 'status';

export interface IdeReviewOperationAdapterInput {
  operationId: string;
  sessionId: string;
  connectionGeneration: number;
  prompt: string;
  signal: AbortSignal;
  emit: (type: IdeReviewAdapterEventType, message?: string) => void;
}

/**
 * B7 adapter seam is deliberately review-only. No filesystem, terminal,
 * project path, writer lease, tool executor or credential is supplied here.
 */
export interface IdeReviewOperationAdapter {
  run(input: IdeReviewOperationAdapterInput): Promise<void>;
}

export interface IdeOperationCoordinatorOptions {
  store: IdeSessionStore;
  runtime: IdeCompanionRuntimeRef;
  adapter: IdeReviewOperationAdapter;
  nowMs?: () => number;
  maxRuntimeMs?: number;
}

export class IdeOperationCoordinatorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IdeOperationCoordinatorError';
  }
}

interface ActiveOperation {
  operationId: string;
  sessionId: string;
  connectionGeneration: number;
  controllerLeaseId: string;
  nextSequence: number;
  controller: AbortController;
  timer: NodeJS.Timeout;
  sink: (event: IdeOperationEvent) => void;
}

export class IdeOperationCoordinator {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly clock: () => number;
  private readonly maxRuntimeMs: number;

  constructor(private readonly opts: IdeOperationCoordinatorOptions) {
    this.clock = opts.nowMs ?? (() => Date.now());
    this.maxRuntimeMs = opts.maxRuntimeMs ?? IDE_REVIEW_OPERATION_MAX_RUNTIME_MS;
    if (!Number.isSafeInteger(this.maxRuntimeMs) || this.maxRuntimeMs < 1 || this.maxRuntimeMs > IDE_REVIEW_OPERATION_MAX_RUNTIME_MS) {
      throw new IdeOperationCoordinatorError('IDE_OPERATION_RUNTIME_INVALID', 'review operation runtime bound is invalid');
    }
  }

  startReview(
    envelope: IdeCompanionAuthEnvelope,
    prompt: string,
    workspaceAttestation: string,
    sink: (event: IdeOperationEvent) => void,
  ): IdeOperationRow {
    if (envelope.capability !== 'request_review') {
      throw new IdeOperationCoordinatorError('IDE_OPERATION_CAPABILITY_DENIED', 'B7 starts only request_review');
    }
    const authenticatedPayload=serializeIdeCompanionReviewPayload(prompt,workspaceAttestation);
    const admitted = admitIdeCompanionRuntimeRequest({
      store: this.opts.store,
      runtime: this.opts.runtime,
      envelope,
      payload: authenticatedPayload,
      nowMs: this.clock(),
    });
    // The outer B3 MAC authenticates the exact canonical [domain,prompt,attestation]
    // payload. Re-bind the nested attestation bytes to the admitted identity and
    // run the accepted B5 verifier again immediately before operation start.
    verifyAuthenticatedIdeWorkspace({
      store:this.opts.store,
      runtime:this.opts.runtime,
      admitted:{
        enrollmentId:admitted.enrollmentId,ideInstanceId:admitted.ideInstanceId,
        sessionId:admitted.sessionId,connectionGeneration:admitted.connectionGeneration,
        payloadSha256:hashIdeCompanionPayload(workspaceAttestation),
      },
      payload:workspaceAttestation,
    });
    const operation = this.opts.store.startOperation({
      ...admitted,
      runtimeInstanceId: this.opts.runtime.runtimeInstanceId,
      adapterId: this.opts.runtime.adapterId,
      adapterVersion: this.opts.runtime.adapterVersion,
      payloadSha256: admitted.payloadSha256,
      payloadBytes: Buffer.byteLength(authenticatedPayload, 'utf8'),
    });

    const started: IdeOperationEvent = {
      version: 1,
      operationId: operation.operationId,
      sessionId: operation.sessionId,
      connectionGeneration: operation.connectionGeneration,
      origin: 'machine',
      sequence: 0,
      type: 'operation_started',
    };

    const controller = new AbortController();
    const active: ActiveOperation = {
      operationId: operation.operationId,
      sessionId: operation.sessionId,
      connectionGeneration: operation.connectionGeneration,
      controllerLeaseId: envelope.controllerLeaseId,
      nextSequence: 1,
      controller,
      timer: setTimeout(() => this.timeout(operation.operationId), this.maxRuntimeMs),
      sink,
    };
    this.active.set(operation.operationId, active);
    try {
      sink(started);
    } catch (error) {
      clearTimeout(active.timer);
      this.terminal(active, 'indeterminate');
      controller.abort(new Error('initial operation event delivery failed'));
      this.active.delete(operation.operationId);
      throw error;
    }
    void this.runAdapter(active, prompt);
    return operation;
  }

  cancel(envelope: IdeCompanionAuthEnvelope): 'accepted' | 'indeterminate' {
    if (envelope.capability !== 'cancel') {
      throw new IdeOperationCoordinatorError('IDE_OPERATION_CAPABILITY_DENIED', 'operation cancel requires cancel capability');
    }
    const admitted = admitIdeCompanionRuntimeRequest({
      store: this.opts.store,
      runtime: this.opts.runtime,
      envelope,
      payload: '',
      nowMs: this.clock(),
    });
    const operation = this.opts.store.requestOperationCancellation(admitted);
    const active = this.active.get(operation.operationId);
    if (active === undefined) {
      const event: IdeOperationEvent = {
        version: 1,
        operationId: operation.operationId,
        sessionId: operation.sessionId,
        connectionGeneration: operation.connectionGeneration,
        origin: 'machine',
        sequence: operation.nextSequence,
        type: 'indeterminate',
      };
      this.opts.store.appendOperationEvent(event, admitted.controllerLeaseId);
      return 'indeterminate';
    }
    active.controller.abort(new Error('review operation cancelled'));
    return 'accepted';
  }

  /**
   * Trusted QuaranGate-origin cancellation for a user review intent that has
   * already become an exact B7 operation. The caller supplies only the
   * server-held operation/controller identities; enrollment/session fields are
   * re-derived from the durable operation row and the existing store binding
   * checks remain authoritative. No companion-provided operation identity is
   * accepted by this method.
   */
  cancelTrusted(operationId: string, controllerLeaseId: string): 'accepted' | 'indeterminate' {
    const active = this.active.get(operationId);
    const operation = this.opts.store.getOperation(operationId);
    if (operation === undefined || operation.capability !== 'request_review') {
      throw new IdeOperationCoordinatorError('IDE_OPERATION_NOT_FOUND', 'trusted review cancellation target is unavailable');
    }
    if (active === undefined || active.controllerLeaseId !== controllerLeaseId
      || active.sessionId !== operation.sessionId || active.connectionGeneration !== operation.connectionGeneration) {
      return 'indeterminate';
    }
    this.opts.store.requestOperationCancellation({
      enrollmentId: operation.enrollmentId,
      ideInstanceId: operation.ideInstanceId,
      sessionId: operation.sessionId,
      connectionGeneration: operation.connectionGeneration,
      controllerLeaseId,
      operationId,
      capability: 'cancel',
    });
    active.controller.abort(new Error('trusted QuaranGate review intent cancelled'));
    return 'accepted';
  }

  connectionClosed(sessionId: string, connectionGeneration: number): void {
    for (const active of this.active.values()) {
      if (active.sessionId === sessionId && active.connectionGeneration === connectionGeneration) {
        clearTimeout(active.timer);
        active.controller.abort(new Error('IDE companion disconnected'));
        this.active.delete(active.operationId);
      }
    }
  }

  private async runAdapter(active: ActiveOperation, prompt: string): Promise<void> {
    try {
      await this.opts.adapter.run({
        operationId: active.operationId,
        sessionId: active.sessionId,
        connectionGeneration: active.connectionGeneration,
        prompt,
        signal: active.controller.signal,
        emit: (type, message) => this.adapterEvent(active, type, message),
      });
      if (active.controller.signal.aborted) {
        this.finishAfterAbort(active);
      } else {
        this.terminal(active, 'completed');
      }
    } catch {
      if (active.controller.signal.aborted) this.finishAfterAbort(active);
      else this.terminal(active, 'failed', 'operation failed');
    } finally {
      clearTimeout(active.timer);
      if (this.active.get(active.operationId) === active) this.active.delete(active.operationId);
    }
  }

  private adapterEvent(active: ActiveOperation, type: IdeReviewAdapterEventType, message?: string): void {
    if (active.controller.signal.aborted) return;
    const event: IdeOperationEvent = {
      version: 1,
      operationId: active.operationId,
      sessionId: active.sessionId,
      connectionGeneration: active.connectionGeneration,
      origin: 'machine',
      sequence: active.nextSequence,
      type,
      ...(message === undefined ? {} : { message }),
    };
    try {
      this.opts.store.appendOperationEvent(event, active.controllerLeaseId);
      active.nextSequence += 1;
      active.sink(event);
    } catch {
      active.controller.abort(new Error('durable IDE operation event rejected'));
    }
  }

  private finishAfterAbort(active: ActiveOperation): void {
    const current = this.opts.store.getOperation(active.operationId);
    if (!current || current.state === 'DISCONNECTED' || current.state === 'INDETERMINATE'
      || current.state === 'COMPLETED' || current.state === 'CANCELLED' || current.state === 'FAILED') return;
    if (current.state === 'CANCELLING') this.terminal(active, 'cancelled');
    else this.terminal(active, 'indeterminate');
  }

  private timeout(operationId: string): void {
    const active = this.active.get(operationId);
    if (!active) return;
    const current = this.opts.store.getOperation(operationId);
    if (current && (current.state === 'RUNNING' || current.state === 'CANCELLING')) {
      this.terminal(active, 'indeterminate');
    }
    active.controller.abort(new Error('review operation runtime exceeded'));
  }

  private terminal(active: ActiveOperation, type: 'completed'|'cancelled'|'failed'|'indeterminate', message?: string): void {
    const current = this.opts.store.getOperation(active.operationId);
    if (!current || current.state === 'DISCONNECTED' || current.state === 'INDETERMINATE'
      || current.state === 'COMPLETED' || current.state === 'CANCELLED' || current.state === 'FAILED') return;
    const event: IdeOperationEvent = {
      version: 1,
      operationId: active.operationId,
      sessionId: active.sessionId,
      connectionGeneration: active.connectionGeneration,
      origin: 'machine',
      sequence: current.nextSequence,
      type,
      ...(message === undefined ? {} : { message }),
    };
    try {
      this.opts.store.appendOperationEvent(event, active.controllerLeaseId);
      active.nextSequence = event.sequence + 1;
      active.sink(event);
    } catch (error) {
      if (!(error instanceof IdeRegistryStoreError)) throw error;
    }
  }
}
