import { createHash } from 'node:crypto';
import { BridgeError, asBridgeError } from '../shared/errors.js';
import {
  SECURITY_ASSESSMENT_ID_PATTERN,
  SECURITY_DISCOVERY_ID_PATTERN,
  SECURITY_PLAN_ID_PATTERN,
  SECURITY_SHA256_PATTERN,
  SECURITY_SOURCE_REVISION_PATTERN,
  type ProductAssessmentAdmissionRequest,
  type SecurityAssessmentAdmissionReceipt,
  type SecurityAssessmentOperationalBinding,
  type SecurityAssessmentOperationalPreflight,
} from '../shared/securityAssessment.js';
import type { Principal } from './config.js';
import { authorizeSecurityAssessmentBinding } from './securityAssessmentAuthz.js';

const BRIDGE_REQUEST_ID = /^bar_[0-9a-f]{24}$/;
const NONCE = /^[0-9a-f]{32,64}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

export interface SecurityAssessmentAdmissionDependencies {
  principalById: (id: string) => Principal | undefined;
  preflight: (request: {
    assessmentId: string;
    projectId: string;
    targetId?: string;
    expectedSourceRevision: string;
    requireRunningTarget: boolean;
    requestedCapabilityClasses: string[];
  }) => Promise<SecurityAssessmentOperationalPreflight>;
  claimReplay?: (request: {
    bridgeRequestId: string;
    nonce: string;
    assessmentId: string;
    assessmentVersion: number;
    expiresAt: string;
  }) => Promise<boolean>;
  now?: () => Date;
}

function stable(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  const object = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) out[key] = stable(object[key]);
  return out;
}

function digestReceipt(value: Omit<SecurityAssessmentAdmissionReceipt, 'admissionReceiptDigest'>): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function parseIso(value: string, code: string): number {
  if (value.length < 20 || value.length > 40) {
    throw new BridgeError('MALFORMED_REQUEST', code, 400);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BridgeError('MALFORMED_REQUEST', code, 400);
  }
  return parsed.getTime();
}

function validateBinding(binding: SecurityAssessmentOperationalBinding): void {
  if (!SECURITY_ASSESSMENT_ID_PATTERN.test(binding.assessmentId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment identity', 400);
  }
  if (!Number.isSafeInteger(binding.assessmentVersion) || binding.assessmentVersion < 0) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment version', 400);
  }
  if (!SAFE_REF.test(binding.correlationId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment correlation identity', 400);
  }
  if (!SAFE_REF.test(binding.principalRef)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment Principal binding', 400);
  }
  if (!Number.isSafeInteger(binding.principalMappingVersion) || binding.principalMappingVersion < 0) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid Principal mapping version', 400);
  }
  if (!SECURITY_DISCOVERY_ID_PATTERN.test(binding.discoveryId)
    || !SECURITY_SHA256_PATTERN.test(binding.discoveryDigest)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid discovery binding', 400);
  }
  if (!SECURITY_PLAN_ID_PATTERN.test(binding.planId)
    || !SECURITY_SHA256_PATTERN.test(binding.planDigest)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid plan binding', 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(binding.projectId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid project binding', 400);
  }
  if (binding.targetId !== undefined
    && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(binding.targetId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid target binding', 400);
  }
  if (!SECURITY_SOURCE_REVISION_PATTERN.test(binding.expectedSourceRevision)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid source revision binding', 400);
  }
  if (!['source', 'runtime', 'pipeline'].includes(binding.assessmentIntent)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment intent', 400);
  }
  if (
    !Array.isArray(binding.requestedCapabilityClasses)
    || binding.requestedCapabilityClasses.length < 1
    || binding.requestedCapabilityClasses.length > 64
    || binding.requestedCapabilityClasses.some(
      (value) => typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value),
    )
  ) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment capability classes', 400);
  }
  if (binding.networkClass !== 'NONE' || binding.credentialClass !== 'NONE') {
    throw new BridgeError('MALFORMED_REQUEST', 'BE9.2 network/credential class must be NONE', 400);
  }
}

function validateProductRequest(
  request: ProductAssessmentAdmissionRequest,
  nowMs: number,
): void {
  const allowed = new Set([
    'schemaVersion', 'bridgeRequestId', 'productActorRef',
    'productUserId', 'organizationId', 'workspaceId',
    'assessmentId', 'assessmentVersion', 'correlationId',
    'principalRef', 'principalMappingVersion',
    'discoveryId', 'discoveryDigest', 'planId', 'planDigest',
    'projectId', 'targetId', 'expectedSourceRevision', 'assessmentIntent',
    'requestedCapabilityClasses', 'networkClass', 'credentialClass',
    'requestedAt', 'expiresAt', 'nonce',
  ]);
  for (const key of Object.keys(request as unknown as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw new BridgeError('MALFORMED_REQUEST', 'product assessment admission contains unsupported fields', 400);
    }
  }
  if (request.schemaVersion !== 'BE9_ADMISSION_V1') {
    throw new BridgeError('MALFORMED_REQUEST', 'unsupported product assessment admission schema', 400);
  }
  if (!BRIDGE_REQUEST_ID.test(request.bridgeRequestId)
    || !SAFE_REF.test(request.productActorRef)
    || !SAFE_REF.test(request.productUserId)
    || !SAFE_REF.test(request.organizationId)
    || !SAFE_REF.test(request.workspaceId)
    || !NONCE.test(request.nonce)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid product assessment admission metadata', 400);
  }
  validateBinding(request);
  const requestedAt = parseIso(request.requestedAt, 'invalid admission requestedAt');
  const expiresAt = parseIso(request.expiresAt, 'invalid admission expiresAt');
  if (
    expiresAt <= requestedAt
    || expiresAt - requestedAt > MAX_TTL_MS
    || requestedAt > nowMs + MAX_CLOCK_SKEW_MS
    || expiresAt < nowMs
  ) {
    throw new BridgeError('MALFORMED_REQUEST', 'product assessment admission request is expired or outside TTL', 400);
  }
}

export class SecurityAssessmentAdmissionService {
  private readonly now: () => Date;

  constructor(private readonly deps: SecurityAssessmentAdmissionDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  private receipt(
    request: Pick<ProductAssessmentAdmissionRequest,
      'bridgeRequestId' | 'assessmentId' | 'assessmentVersion' | 'correlationId'
      | 'networkClass' | 'credentialClass'>,
    decision: SecurityAssessmentAdmissionReceipt['decision'],
    decisionCode: string,
    extras: Partial<SecurityAssessmentAdmissionReceipt> = {},
  ): SecurityAssessmentAdmissionReceipt {
    const decisionAt = this.now().toISOString();
    const decisionExpiresAt = new Date(
      new Date(decisionAt).getTime() + MAX_TTL_MS,
    ).toISOString();
    const unsigned: Omit<SecurityAssessmentAdmissionReceipt, 'admissionReceiptDigest'> = {
      schemaVersion: 'BE9_ADMISSION_RECEIPT_V1',
      bridgeRequestId: request.bridgeRequestId,
      assessmentId: request.assessmentId,
      assessmentVersion: request.assessmentVersion,
      correlationId: request.correlationId,
      decision,
      decisionCode,
      decisionAt,
      decisionExpiresAt,
      policyVersion: 'BE9_ADMISSION_POLICY_V1',
      resourceClass: 'STATIC_SOURCE',
      networkClass: request.networkClass,
      credentialClass: request.credentialClass,
      ...extras,
    };
    return {
      ...unsigned,
      admissionReceiptDigest: digestReceipt(unsigned),
    };
  }

  async admitProduct(
    request: ProductAssessmentAdmissionRequest,
  ): Promise<SecurityAssessmentAdmissionReceipt> {
    const nowMs = this.now().getTime();
    validateProductRequest(request, nowMs);
    if (!this.deps.claimReplay) {
      throw new BridgeError(
        'PRECONDITION_FAILED',
        'durable assessment replay protection is unavailable',
        503,
      );
    }
    const claimed = await this.deps.claimReplay({
      bridgeRequestId: request.bridgeRequestId,
      nonce: request.nonce,
      assessmentId: request.assessmentId,
      assessmentVersion: request.assessmentVersion,
      expiresAt: request.expiresAt,
    });
    if (!claimed) {
      return this.receipt(request, 'REPLAY_REJECTED', 'BRIDGE_REQUEST_REPLAY');
    }

    const principal = this.deps.principalById(request.principalRef);
    if (!principal) {
      return this.receipt(request, 'DENIED_POLICY', 'PRINCIPAL_NOT_CURRENT');
    }

    return this.admitResolvedPrincipal(principal, request);
  }

  async admitResolvedPrincipal(
    principal: Principal,
    binding: SecurityAssessmentOperationalBinding & { bridgeRequestId?: string },
  ): Promise<SecurityAssessmentAdmissionReceipt> {
    validateBinding(binding);
    const request = {
      bridgeRequestId: binding.bridgeRequestId ?? `bar_${createHash('sha256')
        .update(`${binding.assessmentId}:${binding.assessmentVersion}:${binding.correlationId}`)
        .digest('hex').slice(0, 24)}`,
      assessmentId: binding.assessmentId,
      assessmentVersion: binding.assessmentVersion,
      correlationId: binding.correlationId,
      networkClass: binding.networkClass,
      credentialClass: binding.credentialClass,
    } as const;

    try {
      authorizeSecurityAssessmentBinding(principal, binding, 'write');
    } catch (error) {
      const be = asBridgeError(error);
      return this.receipt(request, 'DENIED_POLICY', be.code);
    }

    try {
      const preflight = await this.deps.preflight({
        assessmentId: binding.assessmentId,
        projectId: binding.projectId,
        ...(binding.targetId ? { targetId: binding.targetId } : {}),
        expectedSourceRevision: binding.expectedSourceRevision,
        requireRunningTarget: binding.assessmentIntent !== 'source',
        requestedCapabilityClasses: binding.requestedCapabilityClasses,
      });

      if (
        preflight.projectId !== binding.projectId
        || preflight.targetId !== binding.targetId
        || preflight.sourceRevision !== binding.expectedSourceRevision
      ) {
        return this.receipt(request, 'FAILED_PRECONDITION', 'OPERATIONAL_BINDING_MISMATCH');
      }
      if (!preflight.resourceAvailable) {
        return this.receipt(request, 'TEMPORARILY_UNAVAILABLE', 'EXECUTION_RESOURCE_BUSY', {
          resolvedPrincipalId: principal.id,
          resolvedProjectId: preflight.projectId,
          ...(preflight.targetId ? { resolvedTargetId: preflight.targetId } : {}),
          resolvedSourceRevision: preflight.sourceRevision,
        });
      }
      if (preflight.capabilityStatus !== 'AVAILABLE') {
        return this.receipt(request, 'TEMPORARILY_UNAVAILABLE', preflight.capabilityCode, {
          resolvedPrincipalId: principal.id,
          resolvedProjectId: preflight.projectId,
          ...(preflight.targetId ? { resolvedTargetId: preflight.targetId } : {}),
          resolvedSourceRevision: preflight.sourceRevision,
        });
      }

      return this.receipt(request, 'ADMITTED', 'ADMISSION_OK', {
        resolvedPrincipalId: principal.id,
        resolvedProjectId: preflight.projectId,
        ...(preflight.targetId ? { resolvedTargetId: preflight.targetId } : {}),
        resolvedSourceRevision: preflight.sourceRevision,
      });
    } catch (error) {
      const be = asBridgeError(error);
      const temporary = ['CONCURRENCY_LIMIT', 'DOCKER_UNAVAILABLE'].includes(be.code);
      return this.receipt(
        request,
        temporary ? 'TEMPORARILY_UNAVAILABLE' : 'FAILED_PRECONDITION',
        be.code,
        { resolvedPrincipalId: principal.id },
      );
    }
  }
}
