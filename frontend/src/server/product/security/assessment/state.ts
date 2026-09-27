import "server-only";
import { ProductDataError } from "../../data/errors";
import { BE9_TERMINAL_STATES, type SecurityAssessmentPendingOutcome, type SecurityAssessmentState } from "./types";

const TERMINAL = new Set<SecurityAssessmentState>(BE9_TERMINAL_STATES);

const LEGAL: Readonly<Record<SecurityAssessmentState, readonly SecurityAssessmentState[]>> = {
  PLANNED: ["ADMITTED", "FAILED_POLICY", "FAILED_PRECONDITION", "CANCELLED"],
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

const CLEANUP_FINAL_BY_OUTCOME: Readonly<Record<SecurityAssessmentPendingOutcome, SecurityAssessmentState>> = {
  SUCCESS: "COMPLETED",
  CANCELLED: "CANCELLED",
  FAILED_PRECONDITION: "FAILED_PRECONDITION",
  FAILED_TOOL: "FAILED_TOOL",
  FAILED_TIMEOUT: "FAILED_TIMEOUT",
  FAILED_INFRASTRUCTURE: "FAILED_INFRASTRUCTURE",
};

export function isTerminalAssessmentState(state: SecurityAssessmentState): boolean { return TERMINAL.has(state); }

export function assertLegalAssessmentTransition(current: SecurityAssessmentState, next: SecurityAssessmentState): void {
  if (TERMINAL.has(current)) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "assessment_terminal_state_immutable");
  if (!LEGAL[current].includes(next)) throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_illegal");
}

export function finalStateForCleanup(input: { pendingOutcome?: SecurityAssessmentPendingOutcome; cleanupUncertain?: boolean }): SecurityAssessmentState {
  if (input.cleanupUncertain) return "CLEANUP_FAILED";
  if (!input.pendingOutcome) throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_cleanup_outcome_required");
  return CLEANUP_FINAL_BY_OUTCOME[input.pendingOutcome];
}

export const LEGAL_BE9_ASSESSMENT_TRANSITIONS = LEGAL;
