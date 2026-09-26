import { describe, expect, it, vi } from "vitest";
import { createOperationalClient } from "../../src/lib/operational/client";
import { jobStatuses } from "../../src/lib/operational/contracts";
import { freshness, stateCopy } from "../../src/lib/operational/state";
import type { Transport } from "../../src/lib/operational/transport";
const target = { id: "demo", name: "Demo", source: "manual", running: false };
const jobId = `job_${"a".repeat(32)}`;
function transport(data: unknown, options: { mismatch?: boolean; fallback?: boolean; isError?: boolean; sse?: boolean } = {}): Transport {
  return async (url, init) => {
    expect(url).toBe("/mcp"); expect(init.credentials).toBe("same-origin"); expect(init.cache).toBe("no-store"); expect(init.redirect).toBe("error");
    expect(init.headers).not.toHaveProperty("Authorization");
    const request = JSON.parse(String(init.body));
    const payload = { jsonrpc: "2.0", id: options.mismatch ? "wrong" : request.id, result: { ...(options.fallback ? { content: [{ type: "text", text: JSON.stringify(data) }] } : { structuredContent: data }), isError: options.isError } };
    return new Response(options.sse ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload), { headers: { "Content-Type": options.sse ? "text/event-stream" : "application/json", "X-QuaranGate-Request-Id": "12345678-1234-1234-1234-123456789abc" } });
  };
}
describe("same-origin operational boundary", () => {
  it.each([{}, { fallback: true }, { sse: true }])("decodes structured, JSON text, and SSE results %j", async options => {
    const result = await createOperationalClient(transport({ targets: [target] }, options)).targets();
    expect(result.data).toEqual([{ ...target, health: "UNKNOWN" }]); expect(result.correlationId).toBe("12345678-1234-1234-1234-123456789abc");
  });
  it("prefers structured content over conflicting text", async () => {
    const client = createOperationalClient(async (_, init) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: { structuredContent: { targets: [target] }, content: [{ type: "text", text: '{"targets":[]}' }] } }), { headers: { "content-type": "application/json" } }));
    expect((await client.targets()).data).toHaveLength(1);
  });
  it("rejects response-ID mismatch", async () => { await expect(createOperationalClient(transport({ targets: [] }, { mismatch: true })).targets()).rejects.toMatchObject({ state: "unknown" }); });
  it("uses unique IDs across instances and concurrent requests", async () => {
    const ids: string[] = []; const base = transport({ targets: [] }); const injected: Transport = (url, init) => { ids.push(JSON.parse(String(init.body)).id); return base(url, init); };
    await Promise.all([createOperationalClient(injected).targets(), createOperationalClient(injected).targets()]); expect(new Set(ids).size).toBe(2);
  });
  it.each([401, 403, 404, 405, 500, 503])("maps HTTP %i before parsing unsafe bodies", async status => { await expect(createOperationalClient(async () => new Response("private stack", { status })).targets()).rejects.toMatchObject({ state: status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "unavailable" }); });
  it.each(["FORBIDDEN_SCOPE", "UNAUTHENTICATED", "NOT_IMPLEMENTED", "GITHUB_NOT_CONFIGURED", "FAILED_AGENT"]) ("maps MCP error %s with safe copy", async error => {
    const failed = createOperationalClient(transport({ error, message: "private provider stack" }, { isError: true })).targets();
    await expect(failed).rejects.not.toThrow("private provider");
  });
  it.each([{}, { jsonrpc: "1.0", id: "x", result: {} }, { jsonrpc: "2.0", id: "x", result: {}, error: {} }, []])("rejects malformed envelopes %j", async payload => { await expect(createOperationalClient(async () => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })).targets()).rejects.toMatchObject({ state: "unknown" }); });
  it("rejects malformed tool results and payloads", async () => { await expect(createOperationalClient(transport({ targets: [{ ...target, running: "yes" }] })).targets()).rejects.toMatchObject({ state: "unknown" }); });
  it("maps network failure without exposing details", async () => { await expect(createOperationalClient(async () => { throw new TypeError("private network detail"); }).targets()).rejects.toMatchObject({ state: "unavailable", message: stateCopy.unavailable }); });
  it("cancels before sending and after an injected late response", async () => {
    const c = new AbortController(); c.abort(); const fetcher = vi.fn(transport({ targets: [] })); await expect(createOperationalClient(fetcher).targets(c.signal)).rejects.toMatchObject({ state: "cancelled" }); expect(fetcher).not.toHaveBeenCalled();
    const late = new AbortController(); await expect(createOperationalClient(async (url, init) => { late.abort(); return transport({ targets: [] })(url, init); }).targets(late.signal)).rejects.toMatchObject({ state: "cancelled" });
  });
  it("drops untrusted correlation and never exposes raw error data", async () => {
    await expect(createOperationalClient(async () => new Response("secret", { status: 403, headers: { "X-QuaranGate-Request-Id": "credential-looking-value" } })).targets()).rejects.toMatchObject({ state: "forbidden", correlationId: undefined });
  });
  it("exposes only purpose-specific reads", () => { expect(Object.keys(createOperationalClient())).toEqual(["targets", "target", "projects", "backends", "job", "result", "diff", "gitStatus", "gitDiff", "gitLog", "repositories", "statistics", "resources", "activity", "authority", "control"]); });
});
describe("read contracts", () => {
  it("reads projects and unavailable backends without authority promotion", async () => {
    expect((await createOperationalClient(transport({ projects: [{ id: "demo", gitRequired: true, allowedBackends: ["kiro"], allowedProfiles: ["audit"] }] })).projects()).data[0].gitRequired).toBe(true);
    expect((await createOperationalClient(transport({ backends: [{ id: "kiro", available: false, profiles: ["audit"] }] })).backends()).data[0].available).toBe(false);
  });
  it("keeps known-job lifecycle and omits provider prose", async () => {
    for (const status of jobStatuses) expect((await createOperationalClient(transport({ jobId, status, createdAt: "now" })).job(jobId)).data.status).toBe(status);
    const result = await createOperationalClient(transport({ jobId, status: "COMPLETED", backend: "kiro", project: "demo", profile: "audit", summary: "raw provider prompt" })).result(jobId);
    expect(result.data).not.toHaveProperty("summary"); expect(result.data.status).toBe("COMPLETED");
    await expect(createOperationalClient(transport({ jobId, status: "COMPLETED", createdAt: "now" })).job(`job_${"b".repeat(32)}`)).rejects.toMatchObject({ state: "unknown" });
  });
  it("rejects invalid lookup before transport", () => { const fetcher = vi.fn(); expect(() => createOperationalClient(fetcher).job("arbitrary")).toThrow(); expect(fetcher).not.toHaveBeenCalled(); });
  it("retains Git execution distinctions", async () => {
    const result = { exitCode: 1, stdout: "partial", stderr: "error", timedOut: true, truncated: true, durationMs: 1000 };
    expect((await createOperationalClient(transport(result)).gitDiff("demo")).data).toEqual(result);
  });
  it("retains Control Center generation time and unknowns", async () => {
    const result = await createOperationalClient(transport({ view: "providers", generatedAt: "2026-01-01T00:00:00Z", data: { activeJobs: null, queuedJobs: 2, sessionContinuity: "DEFERRED", secret: "omit" } })).control("providers");
    expect(result.data.generatedAt).toBe("2026-01-01T00:00:00Z"); expect(result.data.rows).toContainEqual({ label: "activeJobs", value: "UNKNOWN" }); expect(JSON.stringify(result)).not.toContain("omit");
  });
  it("distinguishes freshness, future dates and invalid dates", () => { const now = Date.parse("2026-01-01T00:00:00Z"); expect(freshness("2026-01-01T00:00:00Z", now)).toBe("available"); expect(freshness("2025-12-31T23:58:00Z", now)).toBe("stale"); expect(freshness("2026-01-02", now)).toBe("unknown"); expect(freshness("bad", now)).toBe("unknown"); });
});

describe("adversarial transport and evidence", () => {
  it("rejects invalid JSON, ambiguous MCP content and oversized bodies", async () => {
    for (const body of ["{", "x".repeat(2 * 1024 * 1024 + 1)]) await expect(createOperationalClient(async () => new Response(body, { headers: { "content-type": "application/json" } })).targets()).rejects.toMatchObject({ state: "unknown" });
    await expect(createOperationalClient(async (_, init) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: { content: [{ type: "text", text: '{}' }, { type: "text", text: '{}' }] } }), { headers: { "content-type": "application/json" } })).targets()).rejects.toMatchObject({ state: "unknown" });
  });
  it("retains matched JSON-RPC denial and validates error shape", async () => {
    const invoke = (error: unknown) => createOperationalClient(async (_, init) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, error }), { headers: { "content-type": "application/json" } })).targets();
    await expect(invoke({ code: -32001, message: "private", data: "FORBIDDEN_TARGET" })).rejects.toMatchObject({ state: "forbidden" });
    await expect(invoke({ code: "bad", message: "private" })).rejects.toMatchObject({ state: "unknown" });
  });
  it("retains bounded diff evidence without promoting applicability", async () => {
    const data = { jobId, diffHash: "a".repeat(64), chunk: "safe text", chunkBytes: 9, totalBytes: 100, truncated: true, applicable: false, contentComplete: false };
    expect((await createOperationalClient(transport(data)).diff(jobId)).data).toEqual(data);
  });
  it("reads repository metadata and no authority or credential fields", async () => {
    const data = { repository: "org/repo", owner: "org", private: true, archived: false, token: "OMIT" };
    const result = await createOperationalClient(transport({ repositories: [data] })).repositories(); expect(result.data[0]).not.toHaveProperty("token"); expect(result.data[0].localProject).toBe("UNKNOWN");
  });
});
