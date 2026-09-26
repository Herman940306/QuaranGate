import { failureKinds, type ProductContext, type Result } from "../product/contracts";
import { approval, approvalList } from "./projection";
import type { ApprovalAdapter, ApprovalClient, ApprovalDecisionIntent } from "./contracts";

function context(value: ProductContext): ProductContext {
  for (const field of [value.userId, value.organizationId, value.workspaceId, value.sessionVersion]) {
    if (!field || field.length > 256 || [...field].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error("Invalid product context");
  }
  return { ...value };
}
function sameContext(a: ProductContext, b: unknown): boolean {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const v = b as Record<string, unknown>;
  return v.userId === a.userId && v.organizationId === a.organizationId && v.workspaceId === a.workspaceId && v.sessionVersion === a.sessionVersion;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid approval response");
  return value as Record<string, unknown>;
}
function id(value: string): string {
  if (!value || value.length > 256 || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error("Invalid approval id");
  return value;
}
function decisionIntent(value: ApprovalDecisionIntent): ApprovalDecisionIntent {
  if (value.decision !== "APPROVED" && value.decision !== "REJECTED") throw new Error("Invalid approval decision");
  if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) throw new Error("Invalid approval version");
  if (value.rationale !== undefined && (!value.rationale.trim() || value.rationale.length > 4096)) throw new Error("Invalid rationale");
  return { id: id(value.id), decision: value.decision, expectedVersion: value.expectedVersion, ...(value.rationale === undefined ? {} : { rationale: value.rationale }) };
}
export function createApprovalClient(adapter?: ApprovalAdapter): ApprovalClient {
  async function invoke<T>(ctx: ProductContext, signal: AbortSignal, call: (a: ApprovalAdapter, c: ProductContext) => Promise<unknown>, parse: (value: unknown) => T): Promise<Result<T>> {
    if (signal.aborted) return { kind: "cancelled" };
    if (!adapter) return { kind: "integration_pending" };
    try {
      const safeContext = context(ctx);
      const raw = record(await call(adapter, safeContext));
      if (signal.aborted) return { kind: "cancelled" };
      if (failureKinds.includes(raw.kind as typeof failureKinds[number])) return { kind: raw.kind as typeof failureKinds[number] };
      if (raw.kind !== "available" || !sameContext(safeContext, raw.context)) return { kind: "conflict" };
      return { kind: "available", data: parse(raw.data) };
    } catch {
      return { kind: signal.aborted ? "cancelled" : "unavailable" };
    }
  }
  return {
    integrated: Boolean(adapter),
    list: (c, s) => invoke(c, s, (a, ctx) => a.listApprovals(ctx, s), approvalList),
    decide: (c, input, s) => {
      const safe = decisionIntent(input);
      return invoke(c, s, (a, ctx) => a.decideApproval(ctx, safe, s), value => {
        const next = approval(value);
        if (next.id !== safe.id || next.status !== safe.decision || next.version === safe.expectedVersion) throw new Error("Stale approval acknowledgement");
        return next;
      });
    },
  };
}
