/**
 * P7 B4 trusted runtime admission wrapper.
 *
 * This is still transport-independent source only. It deliberately re-reads
 * the owner-only runtime credential for every admission so rotation/revocation
 * cannot be bypassed by a stale in-memory secret cache in a future listener.
 */
import type { IdeCompanionAuthEnvelope } from '../../shared/ideCompanionAuth.js';
import {
  authenticateAndClaimIdeCompanionRequest,
  type AdmittedIdeCompanionRequest,
  type AuthenticatedClaimedIdeCompanionRequest,
} from './ideCompanionAdmission.js';
import { IdeSessionStore } from './ideSessionStore.js';
import {
  IdeCompanionRuntimeError,
  readIdeCompanionSecret,
  type IdeCompanionRuntimeRef,
} from './ideCompanionRuntime.js';

export interface AdmitIdeCompanionRuntimeRequestInput {
  store: IdeSessionStore;
  runtime: IdeCompanionRuntimeRef;
  envelope: IdeCompanionAuthEnvelope;
  payload: Uint8Array | string;
  /** Trusted server-side wall clock; never sourced from the companion frame. */
  nowMs: number;
}

/**
 * Enforce runtime credential freshness + runtime/enrollment binding before the
 * accepted B3 cryptographic/replay/authority funnel. Secret bytes are zeroed
 * from this wrapper's temporary Buffer once admission returns or throws.
 */
export function authenticateAndClaimIdeCompanionRuntimeRequest(
  input: AdmitIdeCompanionRuntimeRequestInput,
): AuthenticatedClaimedIdeCompanionRequest {
  const material = readIdeCompanionSecret(input.runtime);
  try {
    if (input.envelope.enrollmentId !== input.runtime.enrollmentId
      || input.envelope.ideInstanceId !== input.runtime.ideInstanceId) {
      throw new IdeCompanionRuntimeError(
        'IDE_RUNTIME_BINDING_MISMATCH',
        'companion envelope does not match its trusted runtime credential binding',
      );
    }
    return authenticateAndClaimIdeCompanionRequest({
      store: input.store,
      envelope: input.envelope,
      secret: material.secret,
      payload: input.payload,
      nowMs: input.nowMs,
    });
  } finally {
    material.secret.fill(0);
  }
}

export function admitIdeCompanionRuntimeRequest(
  input: AdmitIdeCompanionRuntimeRequestInput,
): AdmittedIdeCompanionRequest {
  const admitted = authenticateAndClaimIdeCompanionRuntimeRequest(input);
  input.store.assertCompanionAuthority(admitted);
  return admitted;
}
