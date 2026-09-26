import { describe, expect, it, vi } from "vitest";
import { createWorkstationClient, workspacePath } from "../../src/lib/client/workstation/client";
import type { Transport } from "../../src/lib/operational/transport";

function response(data: unknown, capture?: (name: string, args: Record<string, unknown>) => void): Transport {
  return async (target, init) => {
    expect(target).toBe("/mcp"); expect(init.credentials).toBe("same-origin"); expect(init.cache).toBe("no-store");
    expect(init.headers).not.toHaveProperty("Authorization");
    const request = JSON.parse(String(init.body)); capture?.(request.params.name, request.params.arguments);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: data } }), { headers: { "content-type": "application/json", "X-QuaranGate-Request-Id": "12345678-1234-1234-1234-123456789abc" } });
  };
}
describe("FE4 workstation boundary", () => {
  it("accepts only workspace-relative paths before transport", async () => {
    const transport = vi.fn(response({ entries: [] })); const client = createWorkstationClient(transport);
    for (const path of ["/etc/passwd", "../secret", "a/../b", "a//b", "a\\b", ".", "a/", "a\u0000b"]) {
      expect(() => workspacePath(path)).toThrow();
      expect(() => client.readFile("demo", path)).toThrow();
    }
    expect(workspacePath("", true)).toBe(""); expect(workspacePath("src/app.tsx")).toBe("src/app.tsx"); expect(transport).not.toHaveBeenCalled();
  });
  it("keeps read tools purpose-specific and bounds file output", async () => {
    const calls: string[] = [];
    const client = createWorkstationClient(response({ entries: ["src/", "src/app.tsx"] }, name => calls.push(name)));
    expect((await client.listFiles("demo")).data).toEqual(["src/", "src/app.tsx"]); expect(calls).toEqual(["fs_list"]);
    await expect(createWorkstationClient(response({ path: "wrong", bytes: 4, content: "safe" })).readFile("demo", "readme.txt")).rejects.toMatchObject({ state: "unknown" });
    await expect(createWorkstationClient(response({ path: "readme.txt", bytes: 2_000_000, content: "x".repeat(1_048_577) })).readFile("demo", "readme.txt")).rejects.toMatchObject({ state: "unknown" });
  });
  it("confirms exact mutation acknowledgement and retains correlation", async () => {
    const observed: [string, Record<string, unknown>][] = [];
    const client = createWorkstationClient(response({ ok: true, path: "src/app.tsx" }, (name, args) => observed.push([name, args])));
    const ack = await client.patchFile("demo", "src/app.tsx", "old", "new");
    expect(ack.data).toEqual({ ok: true, path: "src/app.tsx" }); expect(ack.correlationId).toBe("12345678-1234-1234-1234-123456789abc");
    expect(observed).toEqual([["fs_patch", { target: "demo", path: "src/app.tsx", oldText: "old", newText: "new" }]]);
    await expect(createWorkstationClient(response({ ok: true, path: "different" })).deleteFile("demo", "src/app.tsx")).rejects.toMatchObject({ state: "unknown" });
    await expect(createWorkstationClient(response({ ok: true, target: "other", action: "stop", running: false, status: "stopped" })).controlTarget("demo", "stop")).rejects.toMatchObject({ state: "unknown" });
  });
  it("limits terminal intent, never fabricates streaming or cancellation", async () => {
    const observed: [string, Record<string, unknown>][] = [];
    const client = createWorkstationClient(response({ exitCode: 1, stdout: "partial", stderr: "failed", truncated: true, timedOut: false, durationMs: 300 }, (name, args) => observed.push([name, args])));
    const result = await client.execute("demo", "echo ready", "src");
    expect(result.data).toEqual({ exitCode: 1, stdout: "partial", stderr: "failed", truncated: true, timedOut: false, durationMs: 300 });
    expect(observed).toEqual([["terminal_exec", { target: "demo", command: "echo ready", cwd: "src", timeoutMs: 20_000 }]]);
    expect(() => client.execute("demo", "", "")).toThrow();
  });
});
