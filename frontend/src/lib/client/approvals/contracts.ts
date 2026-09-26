import type { FailureKind, ProductContext, Result } from "../product/contracts";

export const approvalStatuses = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"] as const;
export type ApprovalStatus = typeof approvalStatuses[number];
export type ApprovalDecision = "APPROVED" | "REJECTED";

export interface ApprovalView {
  id: string;
  organizationId: string;
  workspaceId: string;
  requesterProductUserId: string;
  decisionProductUserId?: string;
  actionClass: string;
  subjectType: string;
  subjectId: string;
  evidenceDigestSha256?: string;
  requestCorrelationId: string;
  rationale?: string;
  status: ApprovalStatus;
  expiresAt?: string;
  decidedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalDecisionIntent {
  id: string;
  decision: ApprovalDecision;
  expectedVersion: number;
  rationale?: string;
}

export interface ApprovalAdapter {
  listApprovals(context: ProductContext, signal: AbortSignal): Promise<unknown>;
  decideApproval(context: ProductContext, intent: ApprovalDecisionIntent, signal: AbortSignal): Promise<unknown>;
}

export interface ApprovalClient {
  readonly integrated: boolean;
  list(context: ProductContext, signal: AbortSignal): Promise<Result<ApprovalView[]>>;
  decide(context: ProductContext, intent: ApprovalDecisionIntent, signal: AbortSignal): Promise<Result<ApprovalView>>;
}

export const approvalCopy: Record<FailureKind | "loading", string> = {
  integration_pending: "Approval integration pending. Decision records are unavailable until the accepted BE5 adapter is connected.",
  loading: "Waiting for the approval service.",
  unavailable: "Approval service unavailable. Re-read before taking another action; no decision is assumed.",
  forbidden: "Approval access forbidden for the current product session and workspace.",
  stale: "Approval version changed. Re-read the current record before deciding; no automatic retry occurs.",
  conflict: "Approval response did not match the current session/workspace context. Nothing is assumed.",
  cancelled: "Approval request cancelled or outcome unverified. Re-read the record before retrying.",
};
