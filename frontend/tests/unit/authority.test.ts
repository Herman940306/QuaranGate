import { describe, expect, it, vi } from "vitest";
import { authority } from "../../src/lib/operational/authority";
import { createOperationalClient } from "../../src/lib/operational/client";
import type { Transport } from "../../src/lib/operational/transport";
const response = (data: unknown): Transport => async (_url, init) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: { structuredContent: { view: "authority", generatedAt: "2026-09-26T12:00:00Z", data } } }), { headers: { "content-type": "application/json" } });
describe("FE12 server authority projection", () => {
  it("keeps absent grants UNKNOWN and drops arbitrary data", () => {
    const result = authority({ view: "authority", generatedAt: "now", data: { principal: { id: "demo", scopes: [], token: "omit" }, raw: "omit" } });
    expect(result.principal.scopes).toEqual([]); expect(result.principal.targets).toBeNull(); expect(result.preflight.allowed).toBeNull(); expect(JSON.stringify(result)).not.toContain("omit");
  });
  it("returns server denial without inferring from scopes", async () => {
    const result = await createOperationalClient(response({ principal: { scopes: ["*"] }, preflight: { evaluated: true, allowed: false, requiredScope: "agents:apply", reason: "Runtime policy" } })).authority({ tool: "agent_apply", project: "demo" });
    expect(result.data.preflight.allowed).toBe(false);
  });
  it("rejects an unevaluated allow and malformed grants", () => {
    for (const data of [{ preflight: { evaluated: false, allowed: true } }, { principal: { targets: "*" } }]) expect(() => authority({ view: "authority", generatedAt: "now", data })).toThrow();
  });
  it("uses only authority query, bounded selectors and the closed tool catalog", async () => {
    const transport = vi.fn(response({ preflight: { evaluated: true, allowed: true } }));
    const client = createOperationalClient(transport);
    await client.authority({ tool: "terminal_exec", target: "demo" });
    expect(JSON.parse(String(transport.mock.calls[0][1].body)).params).toEqual({ name: "control_center_query", arguments: { view: "authority", tool: "terminal_exec", target: "demo" } });
    expect(() => client.authority({ tool: "arbitrary" as "targets_list" })).toThrow();
    expect(() => client.authority({ tool: "targets_list", target: "x".repeat(257) })).toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
