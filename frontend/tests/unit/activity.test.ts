import { describe, expect, it } from "vitest";
import { activity } from "../../src/lib/operational/activity";
const row = { ts: "2026-09-26T12:00:00Z", reqId: "12345678-1234-1234-1234-123456789abc", principal: "safe", tool: "agent_dispatch", target: null, decision: "allow", durationMs: null };
const envelope = (rows: unknown[]) => ({ view: "activity", generatedAt: "now", data: { retention: { storage: "memory", maxEntries: 2048, maxAgeMs: 86400000 }, rows } });
describe("FE13 safe chronology", () => {
  it("drops raw payloads and unproven lineage fields", () => {
    const result = activity(envelope([{ ...row, prompt: "omit", detail: "omit", jobId: "unproven", response: "omit" }]));
    expect(JSON.stringify(result)).not.toContain("omit"); expect(result.rows[0]).not.toHaveProperty("jobId"); expect(result.rows[0].durationMs).toBeNull();
  });
  it("sorts by timestamp without creating relationships", () => {
    const result = activity(envelope([{ ...row, ts: "2026-09-25T12:00:00Z" }, row])); expect(result.rows[0].ts).toBe(row.ts);
  });
  it("fails closed on malformed decisions, timestamps and row overflow", () => {
    for (const rows of [[{ ...row, decision: "success" }], [{ ...row, ts: "bad" }], Array.from({length:201},()=>row)]) expect(() => activity(envelope(rows))).toThrow();
  });
});
