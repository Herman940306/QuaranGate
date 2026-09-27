import "server-only";
import type { SecurityAssessmentPlan, SecurityDiscoveryResult } from "../types";

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

export const BE9_ASSESSMENT_EVENTS = [
  "ADMISSION_REVALIDATION_PASS",
  "ADMISSION_POLICY_DENIED",
  "ADMISSION_PRECONDITION_FAILED",
  "ADMISSION_TEMPORARILY_UNAVAILABLE",
  "CANCEL_REQUEST",
  "PREPARE_BEGIN",
  "PREPARATION_INFRASTRUCTURE_FAILURE_NO_RESOURCES",
  "PREPARATION_INFRASTRUCTURE_FAILURE_WITH_RESOURCES",
  "PREPARATION_COMPLETE",
  "PRECONDITION_DRIFT_NO_RESOURCES",
  "PRECONDITION_DRIFT_WITH_RESOURCES",
  "TOOL_SUCCESS",
  "TOOL_FAILURE",
  "EXECUTION_TIMEOUT",
  "EXECUTION_INFRASTRUCTURE_FAILURE",
  "EXECUTION_STOPPED_OR_ABSENT",
  "STOP_STATE_AMBIGUOUS",
  "CLEANUP_PROVEN",
  "EVIDENCE_FINALIZATION_FAILED",
  "CLEANUP_NOT_PROVABLE",
] as const;

export type SecurityAssessmentEvent = typeof BE9_ASSESSMENT_EVENTS[number];
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

export interface SecurityAssessmentCreateInput {
  assessmentId: string;
  owner: SecurityAssessmentOwner;
  binding: SecurityAssessmentBinding;
  discoveryId: string;
  planId: string;
  discoverySnapshot: SecurityDiscoveryResult;
  planSnapshot: SecurityAssessmentPlan;
  requestedAt: string;
  correlationId: string;
}

export interface SecurityAssessmentTransitionInput {
  assessmentId: string;
  expectedVersion: number;
  event: SecurityAssessmentEvent;
  reason: string;
  actor: SecurityAssessmentActorClass;
  correlationId: string;
  at: string;
}

export interface SecurityAssessmentTransitionRecord {
  assessmentId: string;
  priorState: SecurityAssessmentState;
  event: SecurityAssessmentEvent;
  nextState: SecurityAssessmentState;
  version: number;
  reason: string;
  actor: SecurityAssessmentActorClass;
  correlationId: string;
  at: string;
  pendingOutcome?: SecurityAssessmentPendingOutcome;
}

export interface SecurityAssessmentRecord {
  id: string;
  owner: SecurityAssessmentOwner;
  binding: SecurityAssessmentBinding;
  discoveryId: string;
  planId: string;
  discoverySnapshot: ImmutableSnapshot<SecurityDiscoveryResult>;
  planSnapshot: ImmutableSnapshot<SecurityAssessmentPlan>;
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
  create(input: SecurityAssessmentCreateInput): Promise<SecurityAssessmentRecord>;
  read(scope: SecurityAssessmentReadScope, assessmentId: string): Promise<SecurityAssessmentRecord | undefined>;
  transition(input: SecurityAssessmentTransitionInput): Promise<SecurityAssessmentRecord>;
  /** Trusted recovery worker only. Never expose as a product/MCP listing primitive. */
  listActiveForRecovery(): Promise<SecurityAssessmentRecord[]>;
}
