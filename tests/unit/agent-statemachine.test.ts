import { describe, it, expect } from 'vitest';
import {
  AGENT_JOB_STATUSES,
  AGENT_JOB_ACTIVE_STATUSES,
  AGENT_FAILURE_CODES,
  AGENT_JOB_DISPOSITIONS,
  canTransitionAgentJob,
  assertAgentJobTransition,
  isActiveAgentJobStatus,
  isAgentFailureStatus,
  isExecutionComplete,
  isFinalDisposition,
  isTerminalAgentJobStatus,
  isWriterProfile,
  AGENT_WRITER_POLICY_V1,
  type AgentJobStatus,
} from '../../src/shared/agents.js';
import { BridgeError } from '../../src/shared/errors.js';

/** Independent expectation of the full allowed transition set. */
const EXPECTED: Record<AgentJobStatus, AgentJobStatus[]> = {
  QUEUED: ['PREPARING', 'FAILED_PRECONDITION', 'FAILED_POLICY', 'FAILED_INFRASTRUCTURE', 'CANCELLED'],
  PREPARING: ['RUNNING', 'FAILED_PRECONDITION', 'FAILED_POLICY', 'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED'],
  RUNNING: ['VALIDATING', 'FAILED_POLICY', 'FAILED_AGENT', 'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED'],
  VALIDATING: ['COMPLETED', 'FAILED_POLICY', 'FAILED_AGENT', 'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED'],
  COMPLETED: ['APPLIED', 'DISCARDED'],
  FAILED_PRECONDITION: [],
  FAILED_POLICY: [],
  FAILED_AGENT: [],
  FAILED_TIMEOUT: [],
  FAILED_INFRASTRUCTURE: [],
  CANCELLED: [],
  APPLIED: [],
  DISCARDED: [],
};

describe('agent job state machine', () => {
  it('matches the expected matrix over the full cross-product', () => {
    for (const from of AGENT_JOB_STATUSES) {
      for (const to of AGENT_JOB_STATUSES) {
        expect(canTransitionAgentJob(from, to), `${from} -> ${to}`)
          .toBe(EXPECTED[from].includes(to));
      }
    }
  });

  it('accepts the happy path', () => {
    const path: AgentJobStatus[] = ['QUEUED', 'PREPARING', 'RUNNING', 'VALIDATING', 'COMPLETED', 'APPLIED'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(() => assertAgentJobTransition(path[i]!, path[i + 1]!)).not.toThrow();
    }
  });

  it('COMPLETED may be discarded instead of applied', () => {
    expect(canTransitionAgentJob('COMPLETED', 'DISCARDED')).toBe(true);
  });

  it('COMPLETED is not equivalent to APPLIED (apply is a separate transition)', () => {
    expect(isExecutionComplete('COMPLETED')).toBe(true);
    expect(isFinalDisposition('COMPLETED')).toBe(false);
    expect(isTerminalAgentJobStatus('COMPLETED')).toBe(false);
  });

  it('final dispositions are immutable', () => {
    for (const d of AGENT_JOB_DISPOSITIONS) {
      for (const to of AGENT_JOB_STATUSES) {
        expect(canTransitionAgentJob(d, to)).toBe(false);
      }
    }
    expect(canTransitionAgentJob('APPLIED', 'RUNNING')).toBe(false);
    expect(canTransitionAgentJob('DISCARDED', 'APPLIED')).toBe(false);
  });

  it('failure statuses never resume', () => {
    for (const f of AGENT_FAILURE_CODES) {
      for (const to of AGENT_JOB_STATUSES) {
        expect(canTransitionAgentJob(f, to), `${f} -> ${to}`).toBe(false);
      }
    }
    expect(canTransitionAgentJob('CANCELLED', 'RUNNING')).toBe(false);
    expect(canTransitionAgentJob('FAILED_TIMEOUT', 'RUNNING')).toBe(false);
  });

  it('no status skips straight to COMPLETED except VALIDATING', () => {
    for (const from of AGENT_JOB_STATUSES) {
      expect(canTransitionAgentJob(from, 'COMPLETED')).toBe(from === 'VALIDATING');
    }
  });

  it('assertAgentJobTransition throws a typed 409 on invalid transitions', () => {
    try {
      assertAgentJobTransition('APPLIED', 'RUNNING');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe('INVALID_JOB_TRANSITION');
      expect((e as BridgeError).httpStatus).toBe(409);
    }
  });

  it('classifies statuses coherently', () => {
    for (const s of AGENT_JOB_ACTIVE_STATUSES) {
      expect(isActiveAgentJobStatus(s)).toBe(true);
      expect(isTerminalAgentJobStatus(s)).toBe(false);
      expect(isExecutionComplete(s)).toBe(false);
    }
    for (const f of AGENT_FAILURE_CODES) {
      expect(isAgentFailureStatus(f)).toBe(true);
      expect(isTerminalAgentJobStatus(f)).toBe(true);
      expect(isExecutionComplete(f)).toBe(false);
    }
    for (const d of AGENT_JOB_DISPOSITIONS) {
      expect(isFinalDisposition(d)).toBe(true);
      expect(isTerminalAgentJobStatus(d)).toBe(true);
      expect(isExecutionComplete(d)).toBe(true);
    }
  });

  it('v1 writer policy: only implement writes; one writer globally and per project', () => {
    expect(isWriterProfile('implement')).toBe(true);
    expect(isWriterProfile('audit')).toBe(false);
    expect(isWriterProfile('plan')).toBe(false);
    expect(isWriterProfile('review')).toBe(false);
    expect(AGENT_WRITER_POLICY_V1.maxActiveGlobalWriterJobs).toBe(1);
    expect(AGENT_WRITER_POLICY_V1.maxActiveWriterJobsPerProject).toBe(1);
  });
});
