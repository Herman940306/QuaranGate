/**
 * P7 I2 trusted QuaranGate-side admission bridge for a user-originated VS Code
 * review intent.
 *
 * The companion may submit only a bounded prompt plus a connection-local
 * correlation sequence. QuaranGate derives the current session/controller,
 * allocates the authoritative operationId, obtains fresh B3+B5 authorization
 * through the accepted I2.2 channel, and only then enters B7 durable review.
 * No participant-controlled project/worktree/controller/writer identity exists
 * on this surface.
 */
import { randomBytes } from 'node:crypto';
import type {
  IdeRemoteReviewIntentCancelFrame,
  IdeRemoteReviewIntentFrame,
  IdeRemoteReviewIntentRejection,
} from '../../shared/ideCompanionRemoteTransport.js';
import {
  isTerminalIdeEventType,
  type IdeOperationEvent,
} from '../../shared/ideSessions.js';
import { IdeCompanionRemoteChannel } from './ideCompanionRemoteChannel.js';
import { IdeOperationCoordinator } from './ideOperationCoordinator.js';
import type { IdeCompanionRuntimeRef } from './ideCompanionRuntime.js';
import {
  IdeSessionStore,
  type IdeSessionRegistryKey,
} from './ideSessionStore.js';

export const IDE_USER_REVIEW_INTENT_OPERATION_ID_ATTEMPTS = 4;

export interface IdeCompanionUserReviewIntentOptions {
  store: IdeSessionStore;
  runtime: IdeCompanionRuntimeRef;
  sessionKey: IdeSessionRegistryKey;
  remote: IdeCompanionRemoteChannel;
  operationIdBytes?: (size: number) => Buffer;
  nowMs?: () => number;
  operationMaxRuntimeMs?: number;
}

type IntentPhase = 'ADMITTING' | 'RUNNING';
interface ActiveIntent {
  intentSequence: number;
  prompt: string;
  phase: IntentPhase;
  cancelled: boolean;
  controllerLeaseId?: string;
  operationId?: string;
}

export class IdeCompanionUserReviewIntentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IdeCompanionUserReviewIntentError';
  }
}

export class IdeCompanionUserReviewIntentCoordinator {
  private readonly operationCoordinator: IdeOperationCoordinator;
  private readonly operationIdBytes: (size: number) => Buffer;
  private current?: ActiveIntent;

  constructor(private readonly opts: IdeCompanionUserReviewIntentOptions) {
    this.operationIdBytes = opts.operationIdBytes ?? randomBytes;
    this.operationCoordinator = new IdeOperationCoordinator({
      store: opts.store,
      runtime: opts.runtime,
      adapter: opts.remote.reviewAdapter(),
      nowMs: opts.nowMs,
      maxRuntimeMs: opts.operationMaxRuntimeMs,
    });
  }

  accept(frame: IdeRemoteReviewIntentFrame): void {
    this.assertFrameBinding(frame.sessionId, frame.connectionGeneration);
    if (this.current !== undefined) {
      this.safeReject(frame.intentSequence, 'BUSY');
      return;
    }
    const intent: ActiveIntent = {
      intentSequence: frame.intentSequence,
      prompt: frame.prompt,
      phase: 'ADMITTING',
      cancelled: false,
    };
    this.current = intent;
    void this.admit(intent);
  }

  cancel(frame: IdeRemoteReviewIntentCancelFrame): void {
    this.assertFrameBinding(frame.sessionId, frame.connectionGeneration);
    const intent = this.current;
    if (intent === undefined || intent.intentSequence !== frame.intentSequence) {
      throw new IdeCompanionUserReviewIntentError('IDE_REVIEW_INTENT_STALE', 'review intent cancellation is stale');
    }
    intent.cancelled = true;
    if (intent.phase === 'RUNNING' && intent.operationId !== undefined && intent.controllerLeaseId !== undefined) {
      this.operationCoordinator.cancelTrusted(intent.operationId, intent.controllerLeaseId);
    }
  }

  connectionClosed(): void {
    this.operationCoordinator.connectionClosed(this.opts.sessionKey.sessionId, this.opts.sessionKey.connectionGeneration);
    this.current = undefined;
  }

  private async admit(intent: ActiveIntent): Promise<void> {
    try {
      if (intent.cancelled) {
        this.safeReject(intent.intentSequence, 'CANCELLED');
        this.clear(intent);
        return;
      }
      const controllerLeaseId = this.opts.store.acquireController(this.opts.sessionKey);
      intent.controllerLeaseId = controllerLeaseId;
      const operationId = this.allocateOperationId();
      intent.operationId = operationId;

      const authorization = await this.opts.remote.authorizeOperation({
        operationId,
        controllerLeaseId,
        capability: 'request_review',
        prompt: intent.prompt,
      });
      if (this.current !== intent) return;
      if (intent.cancelled) {
        this.opts.remote.discardAuthorization(operationId);
        this.releaseController(intent);
        this.safeReject(intent.intentSequence, 'CANCELLED');
        this.clear(intent);
        return;
      }

      intent.phase = 'RUNNING';
      try {
        this.operationCoordinator.startReview(
          authorization.auth,
          intent.prompt,
          authorization.workspaceAttestation,
          (event) => this.forwardDurableEvent(intent, event),
        );
      } catch {
        this.opts.remote.discardAuthorization(operationId);
        this.releaseController(intent);
        this.safeReject(intent.intentSequence, 'ADMISSION_DENIED');
        this.clear(intent);
      }
    } catch {
      this.releaseController(intent);
      if (this.current === intent) {
        this.safeReject(intent.intentSequence, intent.cancelled ? 'CANCELLED' : 'ADMISSION_DENIED');
        this.clear(intent);
      }
    }
  }

  private forwardDurableEvent(intent: ActiveIntent, event: IdeOperationEvent): void {
    if (this.current !== intent || intent.operationId !== event.operationId) {
      throw new IdeCompanionUserReviewIntentError('IDE_REVIEW_INTENT_BINDING', 'durable review event does not match active intent');
    }
    try {
      this.opts.remote.sendReviewIntentEvent(intent.intentSequence, event);
    } finally {
      if (isTerminalIdeEventType(event.type)) {
        this.releaseController(intent);
        this.clear(intent);
      }
    }
  }

  private allocateOperationId(): string {
    for (let attempt = 0; attempt < IDE_USER_REVIEW_INTENT_OPERATION_ID_ATTEMPTS; attempt += 1) {
      const bytes = this.operationIdBytes(16);
      if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 16) {
        throw new IdeCompanionUserReviewIntentError('IDE_REVIEW_INTENT_RANDOM', 'operation identity source returned an invalid length');
      }
      const operationId = `ideo_${bytes.toString('hex')}`;
      if (this.opts.store.getOperation(operationId) === undefined) return operationId;
    }
    throw new IdeCompanionUserReviewIntentError('IDE_REVIEW_INTENT_COLLISION', 'operation identity allocation exhausted');
  }

  private releaseController(intent: ActiveIntent): void {
    const controllerLeaseId = intent.controllerLeaseId;
    if (controllerLeaseId === undefined) return;
    intent.controllerLeaseId = undefined;
    try { this.opts.store.releaseController(this.opts.sessionKey, controllerLeaseId); }
    catch { /* disconnect/stale replacement is already fail-closed in Plane-B */ }
  }

  private safeReject(intentSequence: number, reason: IdeRemoteReviewIntentRejection): void {
    try { this.opts.remote.sendReviewIntentRejected(intentSequence, reason); }
    catch { /* connection failure is already fail-closed by the remote channel */ }
  }

  private clear(intent: ActiveIntent): void {
    if (this.current === intent) this.current = undefined;
  }

  private assertFrameBinding(sessionId: string, connectionGeneration: number): void {
    if (sessionId !== this.opts.sessionKey.sessionId || connectionGeneration !== this.opts.sessionKey.connectionGeneration) {
      throw new IdeCompanionUserReviewIntentError('IDE_REVIEW_INTENT_BINDING', 'review intent does not match authenticated session/generation');
    }
  }
}
