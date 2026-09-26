import { count, list, text } from "./contracts";
import { OperationalError } from "./state";
import { record } from "./transport";
export interface ActivityRow { ts: string; reqId: string; principal: string | null; tool: string; target: string | null; decision: "allow" | "deny"; code: string | null; durationMs: number | null }
export interface ActivitySnapshot { generatedAt: string; rows: ActivityRow[]; retention: { storage: "memory"; maxEntries: number; maxAgeMs: number } }
const nullable = (value: unknown) => value == null ? null : text(value, 256);
export function activity(value: Record<string, unknown>): ActivitySnapshot {
  if (value.view !== "activity") throw new OperationalError("unknown");
  const data = record(value.data); const retention = record(data.retention);
  if (retention.storage !== "memory" || count(retention.maxEntries) > 2048 || count(retention.maxAgeMs) > 86_400_000) throw new OperationalError("unknown");
  const rows = list(data.rows, row => {
    const ts = text(row.ts, 64); const reqId = text(row.reqId, 36);
    if (!Number.isFinite(Date.parse(ts)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reqId) || !["allow", "deny"].includes(String(row.decision))) throw new OperationalError("unknown");
    return { ts, reqId, principal: nullable(row.principal), tool: text(row.tool, 128), target: nullable(row.target), decision: row.decision as "allow" | "deny", code: nullable(row.code), durationMs: row.durationMs == null ? null : count(row.durationMs) };
  }, 200).sort((a,b) => Date.parse(b.ts) - Date.parse(a.ts));
  return { generatedAt: text(value.generatedAt, 64), rows, retention: { storage: "memory", maxEntries: count(retention.maxEntries), maxAgeMs: count(retention.maxAgeMs) } };
}
