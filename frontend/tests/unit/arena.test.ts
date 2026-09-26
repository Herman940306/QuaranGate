import { describe, expect, it, vi } from "vitest";
import { createArenaClient, type DispatchIntent } from "../../src/lib/client/arena/client";
import type { Transport } from "../../src/lib/operational/transport";

const jobId = `job_${"a".repeat(32)}`;
const intent: DispatchIntent = { project: "demo", backend: "kiro", profile: "review", resourcePolicy: "standard", prompt: "Review the bounded change" };
function transport(result: unknown, onRequest?: (name: string, args: Record<string, unknown>) => void): Transport {
  return async (url, init) => {
    expect(url).toBe("/mcp"); expect(init.credentials).toBe("same-origin"); expect(init.headers).not.toHaveProperty("Authorization");
    const request = JSON.parse(String(init.body)); onRequest?.(request.params.name, request.params.arguments);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } }), { headers: { "content-type": "application/json" } });
  };
}
describe("FE5 governed agent client", () => {
  it("dispatches only bounded logical references and accepts the matching job receipt", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const client = createArenaClient(transport({ jobId, status: "QUEUED", project: "demo", backend: "kiro", profile: "review", resourcePolicy: "standard", createdAt: "2026-09-26T00:00:00Z" }, (name, args) => calls.push([name, args])));
    const receipt = await client.dispatch(intent);
    expect(receipt.data.status).toBe("QUEUED"); expect(calls).toEqual([["agent_dispatch", { ...intent, sessionPolicy: "new" }]]);
    const noCall = vi.fn(); expect(() => createArenaClient(noCall).dispatch({ ...intent, prompt: "  " })).toThrow(); expect(() => createArenaClient(noCall).dispatch({ ...intent, project: "../host" })).toThrow(); expect(noCall).not.toHaveBeenCalled();
  });
  it("rejects mismatched dispatch acknowledgement and disposition", async () => {
    await expect(createArenaClient(transport({ jobId, status: "QUEUED", project: "other", backend: "kiro", profile: "review", resourcePolicy: "standard", createdAt: "now" })).dispatch(intent)).rejects.toMatchObject({ state: "unknown" });
    await expect(createArenaClient(transport({ jobId, status: "COMPLETED" })).apply(jobId)).rejects.toMatchObject({ state: "unknown" });
    expect((await createArenaClient(transport({ jobId, status: "APPLIED", project: "demo", appliedAt: "now" })).apply(jobId)).data.status).toBe("APPLIED");
  });
  it("keeps COMPLETED distinct from APPLIED and projects only bounded result evidence", async () => {
    const result = await createArenaClient(transport({ jobId, status: "COMPLETED", project: "demo", backend: "kiro", profile: "review", summary: "Final bounded result", changedFiles: [], evidence: [{ kind: "diff", sha256: "b".repeat(64), bytes: 12 }], usage: { usageAvailable: false }, transcript: "SECRET TRANSCRIPT" })).result(jobId);
    expect(result.data.status).toBe("COMPLETED"); expect(result.data.summary).toBe("Final bounded result"); expect(JSON.stringify(result.data)).not.toContain("SECRET TRANSCRIPT"); expect(result.data.evidence).toEqual([{ kind: "diff", sha256: "b".repeat(64), bytes: 12 }]);
    const diff = await createArenaClient(transport({ jobId, diffHash: "b".repeat(64), chunk: "diff --git", chunkBytes: 10, totalBytes: 10, truncated: false, contentComplete: true, applicable: true })).diff(jobId);
    expect(diff.data.contentComplete).toBe(true); expect(diff.data.applicable).toBe(true);
  });
  it("rejects invalid job IDs and unverified result structure before display", async () => {
    const injected = vi.fn(transport({})); expect(() => createArenaClient(injected).status("job_fake")).toThrow(); expect(injected).not.toHaveBeenCalled();
    await expect(createArenaClient(transport({ jobId, status: "COMPLETED", project: "demo", backend: "kiro", profile: "review", summary: "x".repeat(16_385) })).result(jobId)).rejects.toMatchObject({ state: "unknown" });
  });
});
