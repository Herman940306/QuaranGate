/**
 * BE9.2 shared security-assessment operational contracts.
 *
 * These are bounded authority-plane wire contracts only. Product tenant state,
 * discovery/plan JSON, raw source, host paths, scanner argv/images, credentials
 * and Docker options are deliberately not expressible here.
 */
export const SECURITY_ASSESSMENT_ID_PATTERN = /^assessment_[0-9a-f]{24}$/;
export const SECURITY_DISCOVERY_ID_PATTERN = /^disc_[0-9a-f]{24}$/;
export const SECURITY_PLAN_ID_PATTERN = /^plan_[0-9a-f]{24}$/;
export const SECURITY_SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const SECURITY_SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;

export const SECURITY_ASSESSMENT_NETWORK_CLASSES = ['NONE'] as const;
export type SecurityAssessmentNetworkClass = typeof SECURITY_ASSESSMENT_NETWORK_CLASSES[number];

export const SECURITY_ASSESSMENT_CREDENTIAL_CLASSES = ['NONE'] as const;
export type SecurityAssessmentCredentialClass = typeof SECURITY_ASSESSMENT_CREDENTIAL_CLASSES[number];

export const SECURITY_ASSESSMENT_INTENTS = ['source', 'runtime', 'pipeline'] as const;
export type SecurityAssessmentIntent = typeof SECURITY_ASSESSMENT_INTENTS[number];

export interface SecurityAssessmentOperationalBinding {
  assessmentId: string;
  assessmentVersion: number;
  correlationId: string;
  principalRef: string;
  principalMappingVersion: number;
  discoveryId: string;
  discoveryDigest: string;
  planId: string;
  planDigest: string;
  projectId: string;
  targetId?: string;
  expectedSourceRevision: string;
  assessmentIntent: SecurityAssessmentIntent;
  requestedCapabilityClasses: string[];
  networkClass: SecurityAssessmentNetworkClass;
  credentialClass: SecurityAssessmentCredentialClass;
}

export interface ProductAssessmentAdmissionRequest extends SecurityAssessmentOperationalBinding {
  schemaVersion: 'BE9_ADMISSION_V1';
  bridgeRequestId: string;
  productActorRef: string;
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  requestedAt: string;
  expiresAt: string;
  nonce: string;
}

export type SecurityAssessmentAdmissionDecision =
  | 'ADMITTED'
  | 'DENIED_POLICY'
  | 'FAILED_PRECONDITION'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'REPLAY_REJECTED';

export interface SecurityAssessmentAdmissionReceipt {
  schemaVersion: 'BE9_ADMISSION_RECEIPT_V1';
  bridgeRequestId: string;
  assessmentId: string;
  assessmentVersion: number;
  correlationId: string;
  decision: SecurityAssessmentAdmissionDecision;
  decisionCode: string;
  decisionAt: string;
  decisionExpiresAt: string;
  admissionReceiptDigest: string;
  resolvedPrincipalId?: string;
  resolvedProjectId?: string;
  resolvedTargetId?: string;
  resolvedSourceRevision?: string;
  policyVersion: 'BE9_ADMISSION_POLICY_V1';
  resourceClass: 'STATIC_SOURCE';
  networkClass: SecurityAssessmentNetworkClass;
  credentialClass: SecurityAssessmentCredentialClass;
}

export interface SecurityAssessmentOperationalPreflightRequest {
  assessmentId: string;
  projectId: string;
  targetId?: string;
  expectedSourceRevision: string;
  requireRunningTarget: boolean;
  requestedCapabilityClasses: string[];
}

export interface SecurityAssessmentOperationalPreflight {
  projectId: string;
  targetId?: string;
  sourceRevision: string;
  sourceTree: string;
  clean: true;
  gitRequired: true;
  resourceAvailable: boolean;
  capabilityStatus: 'AVAILABLE' | 'UNAVAILABLE';
  capabilityCode: string;
}
