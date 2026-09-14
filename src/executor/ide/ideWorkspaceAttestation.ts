/** Trusted comparison of authenticated IDE workspace evidence to Plane-B enrollment (P7 B5). */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  deriveIdeWorkspaceFingerprint,
  parseIdeWorkspaceAttestation,
  type IdeWorkspaceAttestation,
} from '../../shared/ideWorkspaceAttestation.js';
import type { AdmittedIdeCompanionRequest } from './ideCompanionAdmission.js';
import {
  assertIdeCompanionRuntimeRef,
  type IdeCompanionRuntimeRef,
} from './ideCompanionRuntime.js';
import { IdeSessionStore } from './ideSessionStore.js';

export type IdeWorkspaceVerificationErrorCode =
  | 'IDE_WORKSPACE_PAYLOAD_NOT_AUTHENTICATED'
  | 'IDE_WORKSPACE_RUNTIME_MISMATCH'
  | 'IDE_WORKSPACE_ENROLLMENT_DENIED'
  | 'IDE_WORKSPACE_SESSION_MISMATCH'
  | 'IDE_WORKSPACE_FINGERPRINT_MISMATCH'
  | 'IDE_WORKSPACE_BASE_REVISION_MISMATCH';

export class IdeWorkspaceVerificationError extends Error {
  constructor(public readonly code: IdeWorkspaceVerificationErrorCode, message: string) {
    super(message);
    this.name = 'IdeWorkspaceVerificationError';
  }
}

export interface VerifyAuthenticatedIdeWorkspaceInput {
  store: IdeSessionStore;
  runtime: IdeCompanionRuntimeRef;
  /** Genuine output of accepted B4/B3 admission for these exact payload bytes. */
  admitted: AdmittedIdeCompanionRequest;
  payload: Uint8Array | string;
}

export interface VerifiedIdeWorkspaceBinding {
  enrollmentId: string;
  principalId: string;
  projectId: string;
  worktreeId: string;
  workspaceFingerprint: string;
  baseRevision?: string;
  ideProduct: IdeWorkspaceAttestation['ideProduct'];
  ideInstanceId: string;
  runtimeInstanceId: string;
  sessionId: string;
  connectionGeneration: number;
  filesystemIdentity: string;
  environmentIdentity: string;
  gitHeadRevision?: string;
}

function sha256Bytes(value: Uint8Array | string): Buffer {
  return createHash('sha256').update(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).digest();
}
function safeHexEqual(actual: Buffer, expectedHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
function safeFingerprintEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Verify only already-authenticated bytes. Adapter evidence never supplies
 * projectId/worktreeId/workspaceFingerprint authority; those are re-derived
 * from the durable trusted enrollment before the fingerprint comparison.
 */
export function verifyAuthenticatedIdeWorkspace(
  input: VerifyAuthenticatedIdeWorkspaceInput,
): VerifiedIdeWorkspaceBinding {
  assertIdeCompanionRuntimeRef(input.runtime);
  if (!safeHexEqual(sha256Bytes(input.payload), input.admitted.payloadSha256)) {
    throw new IdeWorkspaceVerificationError('IDE_WORKSPACE_PAYLOAD_NOT_AUTHENTICATED', 'workspace evidence bytes do not match the authenticated B3 payload');
  }
  const attestation = parseIdeWorkspaceAttestation(input.payload);

  if (attestation.enrollmentId !== input.admitted.enrollmentId
    || attestation.ideInstanceId !== input.admitted.ideInstanceId
    || attestation.sessionId !== input.admitted.sessionId
    || attestation.connectionGeneration !== input.admitted.connectionGeneration) {
    throw new IdeWorkspaceVerificationError('IDE_WORKSPACE_PAYLOAD_NOT_AUTHENTICATED', 'workspace attestation identity does not match authenticated B3 admission');
  }
  if (attestation.enrollmentId !== input.runtime.enrollmentId
    || attestation.ideInstanceId !== input.runtime.ideInstanceId
    || attestation.runtimeInstanceId !== input.runtime.runtimeInstanceId
    || attestation.ideProduct !== input.runtime.ideProduct
    || attestation.adapterId !== input.runtime.adapterId
    || attestation.adapterVersion !== input.runtime.adapterVersion) {
    throw new IdeWorkspaceVerificationError('IDE_WORKSPACE_RUNTIME_MISMATCH', 'workspace attestation does not match trusted B4 runtime identity');
  }

  const enrollment = input.store.getEnrollment(attestation.enrollmentId);
  if (!enrollment || enrollment.state !== 'ACTIVE') {
    throw new IdeWorkspaceVerificationError('IDE_WORKSPACE_ENROLLMENT_DENIED', 'workspace attestation enrollment is not active');
  }
  if (enrollment.ideInstanceId !== attestation.ideInstanceId || enrollment.ideProduct !== attestation.ideProduct) {
    throw new IdeWorkspaceVerificationError('IDE_WORKSPACE_ENROLLMENT_DENIED', 'workspace attestation IDE identity differs from trusted enrollment');
  }
  const session = input.store.getSession(attestation.sessionId);
  if (!session || session.enrollmentId !== enrollment.enrollmentId
    || session.connectionGeneration !== attestation.connectionGeneration
    || session.connectionGeneration !== enrollment.currentGeneration
    || session.state === 'DISCONNECTED' || session.state === 'STALE') {
    throw new IdeWorkspaceVerificationError('IDE_WORKSPACE_SESSION_MISMATCH', 'workspace attestation session is stale, terminal or mismatched');
  }

  const fingerprint = deriveIdeWorkspaceFingerprint({
    projectId: enrollment.projectId,
    worktreeId: enrollment.worktreeId,
    workspace: attestation.workspace,
  });
  if (!safeFingerprintEqual(fingerprint, enrollment.workspaceFingerprint)) {
    throw new IdeWorkspaceVerificationError('IDE_WORKSPACE_FINGERPRINT_MISMATCH', 'workspace attestation does not match trusted enrollment fingerprint');
  }

  if (enrollment.baseRevision !== undefined) {
    if (attestation.workspace.git.kind !== 'worktree'
      || attestation.workspace.git.headRevision !== enrollment.baseRevision) {
      throw new IdeWorkspaceVerificationError('IDE_WORKSPACE_BASE_REVISION_MISMATCH', 'workspace Git HEAD does not match trusted enrollment base revision');
    }
  }

  return {
    enrollmentId: enrollment.enrollmentId,
    principalId: enrollment.principalId,
    projectId: enrollment.projectId,
    worktreeId: enrollment.worktreeId,
    workspaceFingerprint: enrollment.workspaceFingerprint,
    baseRevision: enrollment.baseRevision,
    ideProduct: enrollment.ideProduct,
    ideInstanceId: enrollment.ideInstanceId,
    runtimeInstanceId: input.runtime.runtimeInstanceId,
    sessionId: session.sessionId,
    connectionGeneration: session.connectionGeneration,
    filesystemIdentity: attestation.workspace.filesystemIdentity,
    environmentIdentity: attestation.workspace.environmentIdentity,
    gitHeadRevision: attestation.workspace.git.kind === 'worktree' ? attestation.workspace.git.headRevision : undefined,
  };
}
