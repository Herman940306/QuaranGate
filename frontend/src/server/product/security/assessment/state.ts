import "server-only";
import { ProductDataError } from "../../data/errors";
import {
  BE9_ASSESSMENT_EVENTS,
  BE9_TERMINAL_STATES,
  type SecurityAssessmentEvent,
  type SecurityAssessmentPendingOutcome,
  type SecurityAssessmentState,
} from "./types";

export { BE9_ASSESSMENT_EVENTS };

const TERMINAL = new Set<SecurityAssessmentState>(BE9_TERMINAL_STATES);

const CLEANUP_FINAL_BY_OUTCOME: Readonly<Record<SecurityAssessmentPendingOutcome, SecurityAssessmentState>> = {
  SUCCESS: "COMPLETED",
  CANCELLED: "CANCELLED",
  FAILED_PRECONDITION: "FAILED_PRECONDITION",
  FAILED_TOOL: "FAILED_TOOL",
  FAILED_TIMEOUT: "FAILED_TIMEOUT",
  FAILED_INFRASTRUCTURE: "FAILED_INFRASTRUCTURE",
};

export interface SecurityAssessmentEventResolution {
  nextState: SecurityAssessmentState;
  pendingOutcome?: SecurityAssessmentPendingOutcome;
}

function invalidEvent(state: SecurityAssessmentState, event: SecurityAssessmentEvent): never {
  throw new ProductDataError("PRODUCT_DATA_INVALID", `assessment_event_illegal:${state}:${event}`);
}

export function isTerminalAssessmentState(state: SecurityAssessmentState): boolean {
  return TERMINAL.has(state);
}

export function finalStateForCleanup(
  pendingOutcome: SecurityAssessmentPendingOutcome | undefined,
): SecurityAssessmentState {
  if (!pendingOutcome) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_cleanup_outcome_required");
  }
  return CLEANUP_FINAL_BY_OUTCOME[pendingOutcome];
}

export function resolveAssessmentEvent(
  current: SecurityAssessmentState,
  event: SecurityAssessmentEvent,
  existingPendingOutcome?: SecurityAssessmentPendingOutcome,
): SecurityAssessmentEventResolution {
  if (TERMINAL.has(current)) {
    throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "assessment_terminal_state_immutable");
  }

  switch (current) {
    case "PLANNED":
      switch (event) {
        case "ADMISSION_REVALIDATION_PASS": return { nextState: "ADMITTED" };
        case "ADMISSION_POLICY_DENIED": return { nextState: "FAILED_POLICY" };
        case "ADMISSION_PRECONDITION_FAILED": return { nextState: "FAILED_PRECONDITION" };
        case "ADMISSION_TEMPORARILY_UNAVAILABLE": return { nextState: "PLANNED" };
        case "CANCEL_REQUEST": return { nextState: "CANCELLED" };
        default: return invalidEvent(current, event);
      }

    case "ADMITTED":
      switch (event) {
        case "PREPARE_BEGIN": return { nextState: "PREPARING" };
        case "CANCEL_REQUEST": return { nextState: "CANCELLING" };
        case "PREPARATION_INFRASTRUCTURE_FAILURE_NO_RESOURCES":
          return { nextState: "FAILED_INFRASTRUCTURE" };
        case "PREPARATION_INFRASTRUCTURE_FAILURE_WITH_RESOURCES":
          return { nextState: "CLEANUP", pendingOutcome: "FAILED_INFRASTRUCTURE" };
        default: return invalidEvent(current, event);
      }

    case "PREPARING":
      switch (event) {
        case "PREPARATION_COMPLETE": return { nextState: "RUNNING" };
        case "CANCEL_REQUEST": return { nextState: "CANCELLING" };
        case "PRECONDITION_DRIFT_NO_RESOURCES":
          return { nextState: "FAILED_PRECONDITION" };
        case "PRECONDITION_DRIFT_WITH_RESOURCES":
          return { nextState: "CLEANUP", pendingOutcome: "FAILED_PRECONDITION" };
        case "PREPARATION_INFRASTRUCTURE_FAILURE_NO_RESOURCES":
          return { nextState: "FAILED_INFRASTRUCTURE" };
        case "PREPARATION_INFRASTRUCTURE_FAILURE_WITH_RESOURCES":
          return { nextState: "CLEANUP", pendingOutcome: "FAILED_INFRASTRUCTURE" };
        case "PREPARATION_ABORT_REQUIRING_CLEANUP":
          // Catch-all resource-owning preparation aborts fail closed as
          // infrastructure failures; precondition drift has its own event.
          return { nextState: "CLEANUP", pendingOutcome: "FAILED_INFRASTRUCTURE" };
        default: return invalidEvent(current, event);
      }

    case "RUNNING":
      switch (event) {
        case "TOOL_SUCCESS": return { nextState: "CLEANUP", pendingOutcome: "SUCCESS" };
        case "TOOL_FAILURE": return { nextState: "CLEANUP", pendingOutcome: "FAILED_TOOL" };
        case "EXECUTION_TIMEOUT": return { nextState: "CLEANUP", pendingOutcome: "FAILED_TIMEOUT" };
        case "EXECUTION_INFRASTRUCTURE_FAILURE":
          return { nextState: "CLEANUP", pendingOutcome: "FAILED_INFRASTRUCTURE" };
        case "CANCEL_REQUEST": return { nextState: "CANCELLING" };
        default: return invalidEvent(current, event);
      }

    case "CANCELLING":
      switch (event) {
        case "EXECUTION_STOPPED_OR_ABSENT": {
          if (existingPendingOutcome === "SUCCESS") {
            throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_cancel_conflicts_with_success");
          }
          return {
            nextState: "CLEANUP",
            pendingOutcome: existingPendingOutcome ?? "CANCELLED",
          };
        }
        case "STOP_STATE_AMBIGUOUS":
          return { nextState: "CLEANUP", pendingOutcome: "FAILED_INFRASTRUCTURE" };
        default: return invalidEvent(current, event);
      }

    case "CLEANUP":
      switch (event) {
        case "CLEANUP_PROVEN":
          return {
            nextState: finalStateForCleanup(existingPendingOutcome),
            pendingOutcome: existingPendingOutcome,
          };
        case "EVIDENCE_FINALIZATION_FAILED":
          return {
            nextState: "FAILED_INFRASTRUCTURE",
            pendingOutcome: existingPendingOutcome,
          };
        case "CLEANUP_NOT_PROVABLE":
          return {
            nextState: "CLEANUP_FAILED",
            pendingOutcome: existingPendingOutcome,
          };
        default: return invalidEvent(current, event);
      }
  }

  throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_state_invalid");
}

export const LEGAL_BE9_ASSESSMENT_TRANSITIONS: Readonly<
  Record<SecurityAssessmentState, readonly SecurityAssessmentState[]>
> = {
  PLANNED: ["PLANNED", "ADMITTED", "FAILED_POLICY", "FAILED_PRECONDITION", "CANCELLED"],
  ADMITTED: ["PREPARING", "CANCELLING", "FAILED_INFRASTRUCTURE", "CLEANUP"],
  PREPARING: ["RUNNING", "CANCELLING", "FAILED_PRECONDITION", "FAILED_INFRASTRUCTURE", "CLEANUP"],
  RUNNING: ["CLEANUP", "CANCELLING"],
  CANCELLING: ["CLEANUP"],
  CLEANUP: ["COMPLETED", "CANCELLED", "FAILED_TOOL", "FAILED_TIMEOUT", "FAILED_INFRASTRUCTURE", "FAILED_PRECONDITION", "CLEANUP_FAILED"],
  COMPLETED: [],
  FAILED_POLICY: [],
  FAILED_PRECONDITION: [],
  FAILED_TOOL: [],
  FAILED_TIMEOUT: [],
  FAILED_INFRASTRUCTURE: [],
  CANCELLED: [],
  CLEANUP_FAILED: [],
};
