import "server-only";

export const BE9_ASSESSMENT_STATES = [
  "PLANNED",
  "ADMITTED",
  "PREPARING",
  "RUNNING",
  "CANCELLING",
  "CLEANUP",
  "COMPLETED",
  "FAILED_POLICY",
  "FAILED_PRECONDITION",
  "FAILED_TOOL",
  "FAILED_TIMEOUT",
  "FAILED_INFRASTRUCTURE",
  "CANCELLED",
  "CLEANUP_FAILED",
] as const;

export type SecurityAssessmentState = typeof BE9_ASSESSMENT_STATES[number];

export const BE9_TERMINAL_STATES = [
  "COMPLETED",
  "FAILED_POLICY",
  "FAILED_PRECONDITION",
  "FAILED_TOOL",
  "FAILED_TIMEOUT",
  "FAILED_INFRASTRUCTURE",
  "CANCELLED",
  "CLEANUP_FAILED",
] as const satisfies readonly SecurityAssessmentState[];

export type SecurityAssessmentTerminalState = typeof BE9_TERMINAL_STATES[number];

export const BE9_PENDING_OUTCOMES = [
  "SUCCESS",
  "CANCELLED",
  "FAILED_PRECONDITION",
  "FAILED_TOOL",
  "FAILED_TIMEOUT",
  "FAILED_INFRASTRUCTURE",
] as const;

export type SecurityAssessmentPendingOutcome = typeof BE9_PENDING_OUTCOMES[number];
export type SecurityAssessmentActorClass = "product-service" | "operational-bridge" | "worker" | "recovery";

export interface SecurityAssessmentOwner {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  principalRef: string;
  principalMappingVersion: number;
}

export interface SecurityAssessmentBinding {
  projectId: string;
  targetId?: string;
  sourceRevision: string;
  assessmentIntent?: "source" | "runtime" | "pipeline";
}

export interface ImmutableSnapshot<T> {
  schemaVersion: "BE9_SNAPSHOT_V1";
  algorithm: "sha256";
  digest: string;
  value: T;
  byteLength: number;
}

export interface SecurityAssessmentCreateInput<TDiscovery = unknown, TPlan = unknown> {
  assessmentId: string;
  owner: SecurityAssessmentOwner;
  binding: SecurityAssessmentBinding;
  discoveryId: string;
  planId: string;
  discoverySnapshot: TDiscovery;
  planSnapshot: TPlan;
  requestedAt: string;
  correlationId: string;
}

export interface SecurityAssessmentTransitionInput {
  assessmentId: string;
  expectedVersion: number;
  nextState: SecurityAssessmentState;
  reason: string;
  actor: SecurityAssessmentActorClass;
  correlationId: string;
  at: string;
  pendingOutcome?: SecurityAssessmentPendingOutcome;
  cleanupUncertain?: boolean;
}

export interface SecurityAssessmentTransitionRecord {
  assessmentId: string;
  priorState: SecurityAssessmentState;
  nextState: SecurityAssessmentState;
  version: number;
  reason: string;
  actor: SecurityAssessmentActorClass;
  correlationId: string;
  at: string;
  pendingOutcome?: SecurityAssessmentPendingOutcome;
}

export interface SecurityAssessmentRecord<TDiscovery = unknown, TPlan = unknown> {
  id: string;
  owner: SecurityAssessmentOwner;
  binding: SecurityAssessmentBinding;
  discoveryId: string;
  planId: string;
  discoverySnapshot: ImmutableSnapshot<TDiscovery>;
  planSnapshot: ImmutableSnapshot<TPlan>;
  state: SecurityAssessmentState;
  version: number;
  pendingOutcome?: SecurityAssessmentPendingOutcome;
  requestedAt: string;
  updatedAt: string;
  correlationId: string;
  transitionLog: SecurityAssessmentTransitionRecord[];
}

export interface SecurityAssessmentReadScope {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  principalRef: string;
}

export interface SecurityAssessmentRepository {
  create<TDiscovery, TPlan>(input: SecurityAssessmentCreateInput<TDiscovery, TPlan>): Promise<SecurityAssessmentRecord<TDiscovery, TPlan>>;
  read(scope: SecurityAssessmentReadScope, assessmentId: string): Promise<SecurityAssessmentRecord | undefined>;
  transition(input: SecurityAssessmentTransitionInput): Promise<SecurityAssessmentRecord>;
  listActive(): Promise<SecurityAssessmentRecord[]>;
}
