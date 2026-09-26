import type { ProductContext } from "../product/contracts";
import type { ApprovalAdapter, ApprovalDecisionIntent, ApprovalView } from "./contracts";

export const approvalFixtureScenarios = ["available", "empty", "stale", "forbidden", "unavailable", "slow"] as const;
export type ApprovalFixtureScenario = typeof approvalFixtureScenarios[number];

const base: ApprovalView[] = [
  {
    id: "synthetic-approval-1", organizationId: "synthetic-org", workspaceId: "synthetic-lab", requesterProductUserId: "synthetic-requester-a",
    actionClass: "agent.apply", subjectType: "agent_job", subjectId: "job_synthetic_review", evidenceDigestSha256: "b".repeat(64),
    requestCorrelationId: "synthetic-correlation-1", rationale: "Review evidence before recording the decision.", status: "PENDING", expiresAt: "2026-09-26T12:00:00Z",
    version: 1, createdAt: "2026-09-26T09:00:00Z", updatedAt: "2026-09-26T09:00:00Z",
  },
  {
    id: "synthetic-approval-2", organizationId: "synthetic-org", workspaceId: "synthetic-lab", requesterProductUserId: "synthetic-requester-b",
    actionClass: "github.pull_request.review", subjectType: "pull_request", subjectId: "synthetic/repo#17",
    requestCorrelationId: "synthetic-correlation-2", status: "EXPIRED", expiresAt: "2026-09-26T08:30:00Z",
    version: 2, createdAt: "2026-09-26T07:30:00Z", updatedAt: "2026-09-26T08:30:00Z",
  },
];

export function createApprovalFixtureAdapter(scenario: ApprovalFixtureScenario): ApprovalAdapter {
  const rows = new Map<string, ApprovalView[]>();
  let sequence = 2;
  function current(c: ProductContext): ApprovalView[] {
    if (!rows.has(c.workspaceId)) rows.set(c.workspaceId, scenario === "empty" ? [] : base.map(row => ({ ...row, workspaceId: c.workspaceId, organizationId: c.organizationId })));
    return rows.get(c.workspaceId) ?? [];
  }
  async function wait() { if (scenario === "slow") await new Promise(resolve => setTimeout(resolve, 650)); }
  return {
    async listApprovals(c) {
      await wait();
      if (scenario === "forbidden" || scenario === "unavailable") return { kind: scenario };
      return { kind: "available", context: c, data: current(c) };
    },
    async decideApproval(c, input: ApprovalDecisionIntent) {
      await wait();
      if (scenario === "forbidden" || scenario === "unavailable") return { kind: scenario };
      if (scenario === "stale") return { kind: "stale" };
      const row = current(c).find(item => item.id === input.id);
      if (row?.status !== "PENDING" || row.version !== input.expectedVersion) return { kind: "stale" };
      const next: ApprovalView = { ...row, status: input.decision, decisionProductUserId: c.userId, rationale: input.rationale ?? row.rationale, decidedAt: "2026-09-26T09:30:00Z", updatedAt: "2026-09-26T09:30:00Z", version: ++sequence };
      rows.set(c.workspaceId, current(c).map(item => item.id === next.id ? next : item));
      return { kind: "available", context: c, data: next };
    },
  };
}
