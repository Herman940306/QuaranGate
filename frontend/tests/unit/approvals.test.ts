import { describe, expect, it } from "vitest";
import { createApprovalClient } from "../../src/lib/client/approvals/client";
import type { ApprovalAdapter } from "../../src/lib/client/approvals/contracts";
import type { ProductContext } from "../../src/lib/client/product/contracts";

const context: ProductContext = { userId: "user-a", organizationId: "org-a", workspaceId: "ws-a", sessionVersion: "session-v1" };
const pending = {
  id: "approval-1", organizationId: "org-a", workspaceId: "ws-a", requesterProductUserId: "requester-a",
  actionClass: "agent.apply", subjectType: "agent_job", subjectId: "job_1", evidenceDigestSha256: "a".repeat(64),
  requestCorrelationId: "corr-1", status: "PENDING", version: 1, createdAt: "2026-09-26T09:00:00Z", updatedAt: "2026-09-26T09:00:00Z",
};

function adapter(listValue: unknown, decisionValue?: unknown): ApprovalAdapter {
  return {
    listApprovals: async c => ({ kind: "available", context: c, data: listValue }),
    decideApproval: async c => ({ kind: "available", context: c, data: decisionValue }),
  };
}

describe("FE6 approval semantic client", () => {
  it("projects only bounded approval DTO fields and preserves decision-record semantics", async () => {
    const client = createApprovalClient(adapter([{ ...pending, ignoredAuthority: { scopes: ["admin"] } }]));
    const result = await client.list(context, new AbortController().signal);
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.data[0]?.status).toBe("PENDING");
    expect(JSON.stringify(result.data)).not.toContain("ignoredAuthority");
  });

  it("requires context binding and valid states", async () => {
    const wrongContext: ApprovalAdapter = { listApprovals: async () => ({ kind: "available", context: { ...context, workspaceId: "other" }, data: [pending] }), decideApproval: async () => ({ kind: "unavailable" }) };
    expect((await createApprovalClient(wrongContext).list(context, new AbortController().signal)).kind).toBe("conflict");
    const invalid = createApprovalClient(adapter([{ ...pending, status: "EXECUTED" }]));
    expect((await invalid.list(context, new AbortController().signal)).kind).toBe("unavailable");
  });

  it("decides only APPROVED or REJECTED with optimistic expectedVersion and rejects stale acknowledgements", async () => {
    const calls: unknown[] = [];
    const good: ApprovalAdapter = {
      listApprovals: async c => ({ kind: "available", context: c, data: [pending] }),
      decideApproval: async (c, intent) => {
        calls.push(intent);
        return { kind: "available", context: c, data: { ...pending, status: intent.decision, version: 2, decisionProductUserId: c.userId, decidedAt: "2026-09-26T09:30:00Z", updatedAt: "2026-09-26T09:30:00Z" } };
      },
    };
    const client = createApprovalClient(good);
    const result = await client.decide(context, { id: "approval-1", decision: "APPROVED", expectedVersion: 1 }, new AbortController().signal);
    expect(result.kind).toBe("available");
    expect(calls).toEqual([{ id: "approval-1", decision: "APPROVED", expectedVersion: 1 }]);

    const staleAck = createApprovalClient(adapter([], { ...pending, status: "APPROVED", version: 1 }));
    expect((await staleAck.decide(context, { id: "approval-1", decision: "APPROVED", expectedVersion: 1 }, new AbortController().signal)).kind).toBe("unavailable");
  });

  it("does not turn cancellation or integration absence into success", async () => {
    expect((await createApprovalClient().list(context, new AbortController().signal)).kind).toBe("integration_pending");
    const controller = new AbortController(); controller.abort();
    expect((await createApprovalClient(adapter([])).list(context, controller.signal)).kind).toBe("cancelled");
  });
});
