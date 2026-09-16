import { describe, expect, it } from 'vitest';
import {
  hashIdeCompanionPayload,
  signIdeCompanionEnvelope,
  verifyIdeCompanionEnvelope,
  type IdeCompanionUnsignedEnvelope,
} from '../../src/shared/ideCompanionAuth.js';
import {
  IDE_REVIEW_BASE_CAPABILITIES,
  IdeEventSequenceTracker,
  IdeSessionContractError,
  assertIdeSessionAuthority,
  type IdeOperationEvent,
  type IdeSessionAuthorityRequest,
  type IdeSessionBinding,
} from '../../src/shared/ideSessions.js';

const secret = Buffer.alloc(32, 0x53);
const payload = Buffer.from('{"intent":"review"}', 'utf8');
const nowMs = 1_800_000_000_000;
const sessionId = `ides_${'2'.repeat(32)}`;
const operationId = `ideo_${'3'.repeat(32)}`;

function unsigned(generation: number): IdeCompanionUnsignedEnvelope {
  return {
    version: 1,
    enrollmentId: `iden_${'1'.repeat(32)}`,
    ideInstanceId: `ide_${'4'.repeat(32)}`,
    sessionId,
    connectionGeneration: generation,
    controllerLeaseId: `idectl_${'5'.repeat(32)}`,
    operationId,
    capability: 'request_review',
    nonce: 'A'.repeat(43),
    issuedAtMs: nowMs - 100,
    expiresAtMs: nowMs + 5_000,
    payloadSha256: hashIdeCompanionPayload(payload),
  };
}

function binding(): IdeSessionBinding {
  return {
    principalId: 'chatgpt-browser',
    projectId: 'quarangate',
    worktreeId: 'forward',
    workspaceFingerprint: 'a'.repeat(64),
    baseRevision: 'b'.repeat(40),
    ideProduct: 'vscode',
    ideInstanceId: `ide_${'4'.repeat(32)}`,
    sessionId,
    connectionGeneration: 8,
    capabilities: IDE_REVIEW_BASE_CAPABILITIES,
    sessionState: 'CONTROLLER_ACQUIRED',
    controllerLease: 'acquired',
    writerLease: 'none',
  };
}

function authority(generation: number): IdeSessionAuthorityRequest {
  return {
    principalId: 'chatgpt-browser',
    projectId: 'quarangate',
    worktreeId: 'forward',
    workspaceFingerprint: 'a'.repeat(64),
    baseRevision: 'b'.repeat(40),
    ideProduct: 'vscode',
    ideInstanceId: `ide_${'4'.repeat(32)}`,
    sessionId,
    connectionGeneration: generation,
    capability: 'request_review',
  };
}

function event(generation: number, sequence: number, type: IdeOperationEvent['type']): IdeOperationEvent {
  return {
    version: 1,
    operationId,
    sessionId,
    connectionGeneration: generation,
    origin: 'machine',
    sequence,
    type,
  };
}

function sessionCode(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; }
  catch (error) { return error instanceof IdeSessionContractError ? error.code : 'OTHER_ERROR'; }
}

describe('SH-07 IDE replay and generation binding across auth/session/event planes', () => {
  it('rejects a correctly MAC-authenticated request from the previous connection generation', () => {
    // A stale frame can be fully authentic: replay defense must therefore come
    // from the current durable session binding, not merely from the HMAC.
    const staleEnvelope = signIdeCompanionEnvelope(secret, unsigned(7));
    expect(() => verifyIdeCompanionEnvelope({ envelope: staleEnvelope, secret, payload, nowMs })).not.toThrow();
    expect(sessionCode(() => assertIdeSessionAuthority(binding(), authority(staleEnvelope.connectionGeneration))))
      .toBe('IDE_GENERATION_MISMATCH');

    const freshEnvelope = signIdeCompanionEnvelope(secret, unsigned(8));
    expect(() => verifyIdeCompanionEnvelope({ envelope: freshEnvelope, secret, payload, nowMs })).not.toThrow();
    expect(() => assertIdeSessionAuthority(binding(), authority(freshEnvelope.connectionGeneration))).not.toThrow();
  });

  it('rejects stale-generation routing and same-generation sequence replay after authority succeeds', () => {
    const tracker = new IdeEventSequenceTracker(operationId, sessionId, 8);
    expect(sessionCode(() => tracker.accept(event(7, 0, 'operation_started')))).toBe('IDE_BINDING_MISMATCH');
    tracker.accept(event(8, 0, 'operation_started'));
    expect(sessionCode(() => tracker.accept(event(8, 0, 'status')))).toBe('IDE_EVENT_SEQUENCE_INVALID');
    tracker.accept(event(8, 1, 'completed'));
    expect(sessionCode(() => tracker.accept(event(8, 2, 'status')))).toBe('IDE_EVENT_TERMINAL');
  });
});
