import { describe, expect, it } from 'vitest';
import {
  IDE_CAPABILITIES,
  IDE_OPERATION_ID_PATTERN,
  IDE_REVIEW_BASE_CAPABILITIES,
  IdeEventSequenceTracker,
  IdeSessionContractError,
  assertIdeConnectionGeneration,
  assertIdeOperationTransition,
  assertIdeSessionAuthority,
  assertIdeSessionTransition,
  canTransitionIdeOperation,
  canTransitionIdeSession,
  ideCapabilityRequiresWriterLease,
  isTerminalIdeOperationState,
  isTerminalIdeSessionState,
  type IdeOperationEvent,
  type IdeSessionAuthorityRequest,
  type IdeSessionBinding,
  validateIdeOperationEvent,
  validateIdeSessionBinding,
} from '../../src/shared/ideSessions.js';

const binding = (overrides: Partial<IdeSessionBinding> = {}): IdeSessionBinding => ({
  principalId: 'chatgpt-browser',
  projectId: 'quarangate',
  worktreeId: 'forward',
  workspaceFingerprint: 'a'.repeat(64),
  baseRevision: 'b'.repeat(40),
  ideProduct: 'vscode',
  ideInstanceId: `ide_${'1'.repeat(32)}`,
  sessionId: `ides_${'2'.repeat(32)}`,
  connectionGeneration: 7,
  capabilities: IDE_REVIEW_BASE_CAPABILITIES,
  sessionState: 'CONTROLLER_ACQUIRED',
  controllerLease: 'acquired',
  writerLease: 'none',
  ...overrides,
});

const request = (overrides: Partial<IdeSessionAuthorityRequest> = {}): IdeSessionAuthorityRequest => ({
  principalId: 'chatgpt-browser',
  projectId: 'quarangate',
  worktreeId: 'forward',
  workspaceFingerprint: 'a'.repeat(64),
  baseRevision: 'b'.repeat(40),
  ideProduct: 'vscode',
  ideInstanceId: `ide_${'1'.repeat(32)}`,
  sessionId: `ides_${'2'.repeat(32)}`,
  connectionGeneration: 7,
  capability: 'request_review',
  ...overrides,
});

function code(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof IdeSessionContractError ? error.code : 'OTHER_ERROR';
  }
}

describe('P7 I0 IDE Session Control common contract', () => {
  it('freezes a closed product/capability vocabulary with review read-only by default', () => {
    expect(IDE_CAPABILITIES).toEqual([
      'prompt', 'cancel', 'observe_response', 'read_bounded_editor_context', 'request_review', 'request_implementation',
    ]);
    expect(IDE_REVIEW_BASE_CAPABILITIES).toEqual(['prompt', 'cancel', 'observe_response', 'request_review']);
    expect(IDE_REVIEW_BASE_CAPABILITIES).not.toContain('read_bounded_editor_context');
    expect(IDE_REVIEW_BASE_CAPABILITIES).not.toContain('request_implementation');
    expect(ideCapabilityRequiresWriterLease('request_implementation')).toBe(true);
    for (const capability of IDE_CAPABILITIES.filter((c) => c !== 'request_implementation')) {
      expect(ideCapabilityRequiresWriterLease(capability)).toBe(false);
    }
  });

  it('uses opaque logical identities rather than host paths', () => {
    validateIdeSessionBinding(binding());
    expect(() => validateIdeSessionBinding(binding({ principalId: 'Owner.User_01' }))).not.toThrow();
    for (const bad of ['/home/herman/project', '../escape', 'UPPER', 'has space', '']) {
      expect(code(() => validateIdeSessionBinding(binding({ worktreeId: bad })))).toBe('INVALID_IDE_IDENTITY');
    }
    expect(IDE_OPERATION_ID_PATTERN.test(`ideo_${'a'.repeat(32)}`)).toBe(true);
    expect(IDE_OPERATION_ID_PATTERN.test('/tmp/operation')).toBe(false);
    for (const principalId of ['../owner', 'owner/user', 'owner user', '']) {
      expect(code(() => validateIdeSessionBinding(binding({ principalId })))).toBe('INVALID_IDE_IDENTITY');
    }
  });

  it('rejects malformed generations, fingerprints, revisions, duplicate capabilities and unsupported products', () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(code(() => assertIdeConnectionGeneration(value))).toBe('INVALID_IDE_IDENTITY');
    }
    expect(code(() => validateIdeSessionBinding(binding({ workspaceFingerprint: 'x'.repeat(64) })))).toBe('INVALID_IDE_IDENTITY');
    expect(code(() => validateIdeSessionBinding(binding({ baseRevision: 'a'.repeat(39) })))).toBe('INVALID_IDE_IDENTITY');
    expect(code(() => validateIdeSessionBinding(binding({ capabilities: ['prompt', 'prompt'] })))).toBe('INVALID_IDE_IDENTITY');
    expect(code(() => validateIdeSessionBinding(binding({ ideProduct: 'other' as any })))).toBe('INVALID_IDE_IDENTITY');
  });

  it('freezes fail-closed session transitions and makes disconnect/stale terminal for that generation', () => {
    expect(canTransitionIdeSession('DISCOVERED', 'ENROLLED')).toBe(true);
    expect(canTransitionIdeSession('ENROLLED', 'CONNECTED')).toBe(true);
    expect(canTransitionIdeSession('CONNECTED', 'AVAILABLE')).toBe(true);
    expect(canTransitionIdeSession('AVAILABLE', 'CONTROLLER_ACQUIRED')).toBe(true);
    expect(canTransitionIdeSession('CONTROLLER_ACQUIRED', 'OPERATION_ACTIVE')).toBe(true);
    expect(canTransitionIdeSession('OPERATION_ACTIVE', 'CONTROLLER_ACQUIRED')).toBe(true);
    expect(isTerminalIdeSessionState('DISCONNECTED')).toBe(true);
    expect(isTerminalIdeSessionState('STALE')).toBe(true);
    expect(canTransitionIdeSession('DISCONNECTED', 'CONNECTED')).toBe(false);
    expect(code(() => assertIdeSessionTransition('STALE', 'AVAILABLE'))).toBe('INVALID_IDE_SESSION_TRANSITION');
  });

  it('freezes operation cancellation/recovery states and never allows terminal resurrection', () => {
    expect(canTransitionIdeOperation('PENDING', 'RUNNING')).toBe(true);
    expect(canTransitionIdeOperation('RUNNING', 'CANCELLING')).toBe(true);
    expect(canTransitionIdeOperation('CANCELLING', 'CANCELLED')).toBe(true);
    expect(canTransitionIdeOperation('RUNNING', 'INDETERMINATE')).toBe(true);
    for (const terminal of ['COMPLETED', 'CANCELLED', 'FAILED', 'DISCONNECTED', 'INDETERMINATE'] as const) {
      expect(isTerminalIdeOperationState(terminal)).toBe(true);
      expect(canTransitionIdeOperation(terminal, 'RUNNING')).toBe(false);
    }
    expect(code(() => assertIdeOperationTransition('COMPLETED', 'RUNNING'))).toBe('INVALID_IDE_OPERATION_TRANSITION');
  });

  it('accepts only an exact full authority tuple', () => {
    expect(() => assertIdeSessionAuthority(binding(), request())).not.toThrow();
    for (const changed of [
      { principalId: 'other' }, { projectId: 'other' }, { worktreeId: 'other' },
      { workspaceFingerprint: 'c'.repeat(64) }, { baseRevision: 'c'.repeat(40) },
      { ideProduct: 'cursor' as const }, { ideInstanceId: `ide_${'3'.repeat(32)}` },
      { sessionId: `ides_${'4'.repeat(32)}` },
    ]) {
      expect(code(() => assertIdeSessionAuthority(binding(), request(changed)))).toBe('IDE_BINDING_MISMATCH');
    }
  });

  it('rejects stale/future connection generations before any capability decision', () => {
    expect(code(() => assertIdeSessionAuthority(binding(), request({ connectionGeneration: 6 })))).toBe('IDE_GENERATION_MISMATCH');
    expect(code(() => assertIdeSessionAuthority(binding(), request({ connectionGeneration: 8 })))).toBe('IDE_GENERATION_MISMATCH');
  });

  it('requires an exact controller lease and lifecycle state for machine authority', () => {
    expect(code(() => assertIdeSessionAuthority(
      binding({ sessionState: 'AVAILABLE', controllerLease: 'none' }),
      request(),
    ))).toBe('IDE_CONTROLLER_LEASE_REQUIRED');
    expect(code(() => assertIdeSessionAuthority(
      binding({ sessionState: 'OPERATION_ACTIVE' }),
      request(),
    ))).toBe('IDE_SESSION_STATE_DENIED');
    expect(() => assertIdeSessionAuthority(
      binding({ sessionState: 'OPERATION_ACTIVE' }),
      request({ capability: 'cancel' }),
    )).not.toThrow();
    expect(code(() => assertIdeSessionAuthority(
      binding(),
      request({ capability: 'cancel' }),
    ))).toBe('IDE_SESSION_STATE_DENIED');
  });

  it('rejects inconsistent lease/state combinations before authority use', () => {
    expect(code(() => validateIdeSessionBinding(binding({ sessionState: 'AVAILABLE' })))).toBe('INVALID_IDE_IDENTITY');
    expect(code(() => validateIdeSessionBinding(binding({ sessionState: 'CONTROLLER_ACQUIRED', controllerLease: 'none' })))).toBe('INVALID_IDE_IDENTITY');
    expect(code(() => validateIdeSessionBinding(binding({ sessionState: 'AVAILABLE', controllerLease: 'none', writerLease: 'acquired' })))).toBe('INVALID_IDE_IDENTITY');
  });

  it('denies ungranted capability and separately requires a writer lease for implementation', () => {
    expect(code(() => assertIdeSessionAuthority(binding(), request({ capability: 'read_bounded_editor_context' })))).toBe('IDE_CAPABILITY_DENIED');
    const implementation = binding({ capabilities: [...IDE_REVIEW_BASE_CAPABILITIES, 'request_implementation'] });
    expect(code(() => assertIdeSessionAuthority(implementation, request({ capability: 'request_implementation' })))).toBe('IDE_WRITER_LEASE_REQUIRED');
    expect(() => assertIdeSessionAuthority(
      binding({ capabilities: [...IDE_REVIEW_BASE_CAPABILITIES, 'request_implementation'], writerLease: 'acquired' }),
      request({ capability: 'request_implementation' }),
    )).not.toThrow();
  });

  it('rejects an omitted-vs-present base revision mismatch instead of silently weakening identity', () => {
    expect(code(() => assertIdeSessionAuthority(binding({ baseRevision: undefined }), request()))).toBe('IDE_BINDING_MISMATCH');
    expect(code(() => assertIdeSessionAuthority(binding(), request({ baseRevision: undefined })))).toBe('IDE_BINDING_MISMATCH');
  });
});

describe('P7 I0 normalized event envelope', () => {
  const event = (overrides: Partial<IdeOperationEvent> = {}): IdeOperationEvent => ({
    version: 1,
    operationId: `ideo_${'a'.repeat(32)}`,
    sessionId: `ides_${'b'.repeat(32)}`,
    connectionGeneration: 3,
    origin: 'machine',
    sequence: 0,
    type: 'operation_started',
    ...overrides,
  });

  it('accepts a correctly attributed bounded event', () => {
    expect(() => validateIdeOperationEvent(event({ message: 'bounded status' }))).not.toThrow();
  });

  it('rejects malformed IDs, generations, sequences, event types and oversized messages', () => {
    expect(code(() => validateIdeOperationEvent(event({ operationId: 'bad' })))).toBe('INVALID_IDE_IDENTITY');
    expect(code(() => validateIdeOperationEvent(event({ connectionGeneration: 0 })))).toBe('INVALID_IDE_IDENTITY');
    expect(code(() => validateIdeOperationEvent(event({ sequence: -1 })))).toBe('IDE_EVENT_SEQUENCE_INVALID');
    expect(code(() => validateIdeOperationEvent(event({ type: 'success' as any })))).toBe('IDE_EVENT_SEQUENCE_INVALID');
    expect(code(() => validateIdeOperationEvent(event({ message: 'é'.repeat(5000) })))).toBe('IDE_EVENT_SEQUENCE_INVALID');
  });

  it('requires operation_started at sequence zero and exact monotonic ordering', () => {
    const tracker = new IdeEventSequenceTracker(event().operationId, event().sessionId, 3);
    expect(code(() => tracker.accept(event({ sequence: 0, type: 'assistant_chunk' })))).toBe('IDE_EVENT_SEQUENCE_INVALID');
    tracker.accept(event());
    expect(tracker.expectedSequence()).toBe(1);
    expect(code(() => tracker.accept(event({ sequence: 0, type: 'status' })))).toBe('IDE_EVENT_SEQUENCE_INVALID');
    expect(code(() => tracker.accept(event({ sequence: 2, type: 'status' })))).toBe('IDE_EVENT_SEQUENCE_INVALID');
    tracker.accept(event({ sequence: 1, type: 'assistant_chunk', message: 'chunk' }));
    tracker.accept(event({ sequence: 2, type: 'status' }));
    expect(tracker.expectedSequence()).toBe(3);
  });

  it('rejects cross-operation/session/generation event routing', () => {
    const tracker = new IdeEventSequenceTracker(event().operationId, event().sessionId, 3);
    expect(code(() => tracker.accept(event({ operationId: `ideo_${'c'.repeat(32)}` })))).toBe('IDE_BINDING_MISMATCH');
    expect(code(() => tracker.accept(event({ sessionId: `ides_${'c'.repeat(32)}` })))).toBe('IDE_BINDING_MISMATCH');
    expect(code(() => tracker.accept(event({ connectionGeneration: 4 })))).toBe('IDE_BINDING_MISMATCH');
  });

  it('accepts exactly one terminal event and rejects all late events', () => {
    const tracker = new IdeEventSequenceTracker(event().operationId, event().sessionId, 3);
    tracker.accept(event());
    tracker.accept(event({ sequence: 1, type: 'completed' }));
    expect(tracker.isTerminal()).toBe(true);
    expect(code(() => tracker.accept(event({ sequence: 2, type: 'status' })))).toBe('IDE_EVENT_TERMINAL');
    expect(code(() => tracker.accept(event({ sequence: 2, type: 'failed' })))).toBe('IDE_EVENT_TERMINAL');
  });

  it('treats disconnected and indeterminate as explicit terminal outcomes, never completion', () => {
    for (const terminal of ['disconnected', 'indeterminate'] as const) {
      const tracker = new IdeEventSequenceTracker(event().operationId, event().sessionId, 3);
      tracker.accept(event());
      tracker.accept(event({ sequence: 1, type: terminal }));
      expect(tracker.isTerminal()).toBe(true);
      expect(code(() => tracker.accept(event({ sequence: 2, type: 'completed' })))).toBe('IDE_EVENT_TERMINAL');
    }
  });
});
