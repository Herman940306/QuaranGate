/**
 * P7 B9.1 backend-neutral implementation-operation admission.
 *
 * This source slice deliberately stops before durable B7 operation creation or
 * any mutation-capable adapter call. It authenticates one request, consumes its
 * replay token, re-verifies B5 workspace evidence, acquires the exact B8 live
 * writer lease, then proves the complete B1 tuple with writerLease=acquired.
 */
import { hashIdeCompanionPayload, type IdeCompanionAuthEnvelope } from '../../shared/ideCompanionAuth.js';
import { serializeIdeCompanionImplementationPayload } from '../../shared/ideCompanionOperations.js';
import { AgentJobStore, type LiveWriterLeaseRow } from '../agents/jobStore.js';
import { authenticateAndClaimIdeCompanionRuntimeRequest } from './ideCompanionRuntimeAdmission.js';
import type { IdeCompanionRuntimeRef } from './ideCompanionRuntime.js';
import { IdeSessionStore } from './ideSessionStore.js';
import { verifyAuthenticatedIdeWorkspace } from './ideWorkspaceAttestation.js';

export type IdeImplementationAdmissionErrorCode =
  | 'IDE_IMPLEMENTATION_CAPABILITY_DENIED'
  | 'IDE_IMPLEMENTATION_WRITER_SETTLEMENT_FAILED';

export class IdeImplementationAdmissionError extends Error {
  constructor(public readonly code: IdeImplementationAdmissionErrorCode, message: string) {
    super(message);
    this.name = 'IdeImplementationAdmissionError';
  }
}

export interface AdmitIdeImplementationInput {
  ideStore: IdeSessionStore;
  writerStore: AgentJobStore;
  runtime: IdeCompanionRuntimeRef;
  envelope: IdeCompanionAuthEnvelope;
  prompt: string;
  workspaceAttestation: string;
  /** Trusted server-side wall clock. */
  nowMs: number;
}

export interface AdmittedIdeImplementation {
  enrollmentId: string;
  ideInstanceId: string;
  sessionId: string;
  connectionGeneration: number;
  controllerLeaseId: string;
  operationId: string;
  capability: 'request_implementation';
  payloadSha256: string;
  principalId: string;
  projectId: string;
  worktreeId: string;
  workspaceFingerprint: string;
  baseRevision?: string;
  writerLeaseId: string;
}

function releasePreOperationLease(
  writerStore: AgentJobStore,
  lease: LiveWriterLeaseRow,
  reason: string,
): void {
  const binding = {
    projectId: lease.projectId,
    worktreeId: lease.worktreeId,
    ownerKind: 'ide' as const,
    ownerId: lease.ownerId,
    principalId: lease.principalId,
    writerLeaseId: lease.writerLeaseId,
  };
  try {
    writerStore.releaseLiveWriterLease({ ...binding, reason });
  } catch (releaseError) {
    try {
      writerStore.markLiveWriterUncertain({ ...binding, reason: 'B9 pre-operation writer settlement could not be proven' });
    } catch {
      // Never claim release after both durable settlement attempts fail.
    }
    throw new IdeImplementationAdmissionError(
      'IDE_IMPLEMENTATION_WRITER_SETTLEMENT_FAILED',
      'implementation admission failed and writer lease settlement could not be proven',
    );
  }
}

/**
 * Return an ACTIVE B8 IDE lease only after the complete authenticated B5/B1
 * authority chain is proven. The caller owns that lease on success and must
 * either bind it to the later durable B7 operation or settle it fail-closed.
 */
export function admitIdeImplementation(input: AdmitIdeImplementationInput): AdmittedIdeImplementation {
  if (input.envelope.capability !== 'request_implementation') {
    throw new IdeImplementationAdmissionError('IDE_IMPLEMENTATION_CAPABILITY_DENIED', 'implementation admission requires request_implementation');
  }
  const payload = serializeIdeCompanionImplementationPayload(input.prompt, input.workspaceAttestation);
  const admitted = authenticateAndClaimIdeCompanionRuntimeRequest({
    store: input.ideStore,
    runtime: input.runtime,
    envelope: input.envelope,
    payload,
    nowMs: input.nowMs,
  });
  const workspace = verifyAuthenticatedIdeWorkspace({
    store: input.ideStore,
    runtime: input.runtime,
    admitted: {
      enrollmentId: admitted.enrollmentId,
      ideInstanceId: admitted.ideInstanceId,
      sessionId: admitted.sessionId,
      connectionGeneration: admitted.connectionGeneration,
      payloadSha256: hashIdeCompanionPayload(input.workspaceAttestation),
    },
    payload: input.workspaceAttestation,
  });

  let lease: LiveWriterLeaseRow | undefined;
  try {
    lease = input.writerStore.acquireLiveWriterLease({
      projectId: workspace.projectId,
      worktreeId: workspace.worktreeId,
      ownerKind: 'ide',
      ownerId: admitted.operationId,
      principalId: workspace.principalId,
    });
    input.ideStore.assertCompanionAuthorityWithWriter(admitted, input.writerStore, lease.writerLeaseId);
  } catch (error) {
    if (lease !== undefined && lease.state === 'ACTIVE') {
      releasePreOperationLease(input.writerStore, lease, 'B9 implementation admission failed before durable operation start');
    }
    throw error;
  }

  return {
    ...admitted,
    capability: 'request_implementation',
    principalId: workspace.principalId,
    projectId: workspace.projectId,
    worktreeId: workspace.worktreeId,
    workspaceFingerprint: workspace.workspaceFingerprint,
    baseRevision: workspace.baseRevision,
    writerLeaseId: lease.writerLeaseId,
  };
}
