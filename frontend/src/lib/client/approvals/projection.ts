import { approvalStatuses, type ApprovalView } from "./contracts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid approval view");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error("Invalid approval text");
  return value;
}
function optionalText(value: unknown, max = 256): string | undefined { return value === undefined ? undefined : text(value, max); }
function timestamp(value: unknown): string {
  const v = text(value, 64);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error("Invalid approval timestamp");
  return v;
}
function optionalTimestamp(value: unknown): string | undefined { return value === undefined ? undefined : timestamp(value); }
function digest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const v = text(value, 64);
  if (!/^[0-9a-f]{64}$/.test(v)) throw new Error("Invalid approval digest");
  return v;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid approval version");
  return value;
}
export function approval(value: unknown): ApprovalView {
  const v = record(value);
  if (!approvalStatuses.includes(v.status as ApprovalView["status"])) throw new Error("Invalid approval status");
  const evidenceDigestSha256 = digest(v.evidenceDigestSha256);
  const rationale = optionalText(v.rationale, 4096);
  const expiresAt = optionalTimestamp(v.expiresAt);
  const decidedAt = optionalTimestamp(v.decidedAt);
  return {
    id: text(v.id),
    organizationId: text(v.organizationId),
    workspaceId: text(v.workspaceId),
    requesterProductUserId: text(v.requesterProductUserId),
    ...(v.decisionProductUserId === undefined ? {} : { decisionProductUserId: text(v.decisionProductUserId) }),
    actionClass: text(v.actionClass),
    subjectType: text(v.subjectType, 64),
    subjectId: text(v.subjectId),
    ...(evidenceDigestSha256 ? { evidenceDigestSha256 } : {}),
    requestCorrelationId: text(v.requestCorrelationId),
    ...(rationale ? { rationale } : {}),
    status: v.status as ApprovalView["status"],
    ...(expiresAt ? { expiresAt } : {}),
    ...(decidedAt ? { decidedAt } : {}),
    version: version(v.version),
    createdAt: timestamp(v.createdAt),
    updatedAt: timestamp(v.updatedAt),
  };
}
export function approvalList(value: unknown): ApprovalView[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid approval list");
  const rows = value.map(approval);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Duplicate approval IDs");
  return rows;
}
