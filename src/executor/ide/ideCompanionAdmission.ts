/**
 * Canonical P7 B3 companion admission funnel.
 *
 * Transport-independent and side-effect-limited: authenticate one bounded
 * envelope, durably consume its replay identity, then re-derive Plane-B
 * authority from trusted enrollment/session state. No listener, provider,
 * model, host path, writer lease, or operation execution exists here.
 */
import {
  hashIdeCompanionNonce,
  verifyIdeCompanionEnvelope,
  type IdeCompanionAuthEnvelope,
} from '../../shared/ideCompanionAuth.js';
import type { IdeCapability } from '../../shared/ideSessions.js';
import { IdeSessionStore } from './ideSessionStore.js';

export interface AdmitIdeCompanionRequestInput {
  store: IdeSessionStore;
  envelope: IdeCompanionAuthEnvelope;
  secret: Uint8Array;
  payload: Uint8Array | string;
  /** Trusted server-side wall clock; never sourced from the machine frame. */
  nowMs: number;
}

export interface AuthenticatedClaimedIdeCompanionRequest {
  enrollmentId: string;
  ideInstanceId: string;
  sessionId: string;
  connectionGeneration: number;
  controllerLeaseId: string;
  operationId: string;
  capability: IdeCapability;
  payloadSha256: string;
}

/** Identity after cryptographic verification + durable replay claim only. */
export interface AdmittedIdeCompanionRequest extends AuthenticatedClaimedIdeCompanionRequest {}

/**
 * One accepted frame is one-shot even if subsequent lifecycle authorization
 * fails: replay is claimed after cryptographic verification but before B1/B2
 * authority. That prevents a frame denied in one session state from becoming
 * usable later after state changes.
 */
export function authenticateAndClaimIdeCompanionRequest(
  input: AdmitIdeCompanionRequestInput,
): AuthenticatedClaimedIdeCompanionRequest {
  const verified = verifyIdeCompanionEnvelope({
    envelope: input.envelope,
    secret: input.secret,
    payload: input.payload,
    nowMs: input.nowMs,
  });

  input.store.claimAuthReplay({
    enrollmentId: verified.enrollmentId,
    ideInstanceId: verified.ideInstanceId,
    sessionId: verified.sessionId,
    connectionGeneration: verified.connectionGeneration,
    controllerLeaseId: verified.controllerLeaseId,
    operationId: verified.operationId,
    capability: verified.capability,
    nonceHash: hashIdeCompanionNonce(verified.nonce),
    nowMs: input.nowMs,
    expiresAtMs: verified.expiresAtMs,
  });

  return {
    enrollmentId: verified.enrollmentId,
    ideInstanceId: verified.ideInstanceId,
    sessionId: verified.sessionId,
    connectionGeneration: verified.connectionGeneration,
    controllerLeaseId: verified.controllerLeaseId,
    operationId: verified.operationId,
    capability: verified.capability,
    payloadSha256: verified.payloadSha256,
  };
}

export function admitIdeCompanionRequest(input: AdmitIdeCompanionRequestInput): AdmittedIdeCompanionRequest {
  const admitted = authenticateAndClaimIdeCompanionRequest(input);
  input.store.assertCompanionAuthority(admitted);
  return admitted;
}
