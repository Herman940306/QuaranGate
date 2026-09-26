import { describe, expect, it, vi } from "vitest";
import { createProductClient } from "../../src/lib/client/product/client";
import type { ProductAdapter, ProductContext, ProviderIntent } from "../../src/lib/client/product/contracts";
import { createFixtureAdapter, fixtureOptions, fixtureProvider } from "../../src/lib/client/product/fixtures";
import { ProductRequest } from "../../src/lib/client/product/request";
const ctx: ProductContext = { userId: "synthetic-user", organizationId: "synthetic-org", workspaceId: "synthetic-lab", sessionVersion: "synthetic-session" };
const signal = () => new AbortController().signal;
function adapter(reply: unknown): ProductAdapter { return { ...createFixtureAdapter("available"), inspectProvider: async () => reply, saveProvider: async () => reply, validateProvider: async () => reply }; }
const envelope = (data: unknown, context = ctx) => ({ kind: "available", context, data });
function intent(): ProviderIntent { return { id: fixtureProvider.id, kind: fixtureProvider.kind, ownerScope: fixtureProvider.ownerScope, expectedVersion: fixtureProvider.version, optionsVersion: fixtureOptions.version, secretValue: "synthetic-only-input" }; }
describe("product semantic boundary", () => {
  it("default cannot fake integration or save and scrubs caller secret", async () => {
    const client = createProductClient(); const input = intent(); expect(client.integrated).toBe(false);
    expect(await client.saveProvider(ctx, input, fixtureOptions, signal())).toEqual({ kind: "integration_pending" }); expect(input).not.toHaveProperty("secretValue");
    expect(await client.listProfiles(ctx, signal())).toEqual({ kind: "integration_pending" });
  });
  it("projects safe metadata only, dropping secret/grants/error extras", async () => {
    const client = createProductClient(adapter(envelope({ ...fixtureProvider, secretValue: "synthetic-extra", authority: true, rawError: "synthetic-error" })));
    expect(await client.inspectProvider(ctx, fixtureProvider.id, signal())).toEqual({ kind: "available", data: fixtureProvider });
  });
  it("rejects wrong context and record", async () => {
    expect(await createProductClient(adapter(envelope(fixtureProvider, { ...ctx, workspaceId: "other" }))).inspectProvider(ctx, fixtureProvider.id, signal())).toEqual({ kind: "conflict" });
    expect(await createProductClient(adapter(envelope({ ...fixtureProvider, id: "other" }))).inspectProvider(ctx, fixtureProvider.id, signal())).toEqual({ kind: "unavailable" });
  });
  it("unchanged version cannot acknowledge update or validation", async () => {
    const client = createProductClient(adapter(envelope(fixtureProvider)));
    expect(await client.saveProvider(ctx, intent(), fixtureOptions, signal())).toEqual({ kind: "unavailable" });
    expect(await client.validateProvider(ctx, fixtureProvider.id, fixtureProvider.version, signal())).toEqual({ kind: "unavailable" });
  });
  it("stale options and unreturned references never reach adapter", async () => {
    const save = vi.fn(async () => envelope(fixtureProvider)); const client = createProductClient({ ...adapter(null), saveProvider: save });
    const stale = { ...intent(), optionsVersion: "old" }; expect(await client.saveProvider(ctx, stale, fixtureOptions, signal())).toEqual({ kind: "stale" }); expect(stale).not.toHaveProperty("secretValue");
    const invalid = { ...intent(), kind: "unreturned" }; expect(await client.saveProvider(ctx, invalid, fixtureOptions, signal())).toEqual({ kind: "unavailable" }); expect(invalid).not.toHaveProperty("secretValue"); expect(save).not.toHaveBeenCalled();
  });
  it("scrubs caller intent while preserving synchronous adapter consumption", async () => {
    let consumed = false;
    const client = createProductClient({ ...adapter(null), saveProvider: async (_c, request) => { consumed = request.secretValue === "synthetic-only-input"; return envelope({ ...fixtureProvider, version: "next" }); } });
    const input = intent(); const pending = client.saveProvider(ctx, input, fixtureOptions, signal());
    expect(input).not.toHaveProperty("secretValue"); expect(consumed).toBe(true); expect(await pending).toEqual({ kind: "available", data: { ...fixtureProvider, version: "next" } });
  });
  it("keeps a request-scoped secret valid across an asynchronous adapter boundary", async () => {
    let observed: string | undefined; let callerScrubbed = false;
    const input = intent();
    const client = createProductClient({ ...adapter(null), saveProvider: async (_c, request) => {
      await Promise.resolve();
      callerScrubbed = !Object.hasOwn(input, "secretValue");
      observed = request.secretValue;
      return envelope({ ...fixtureProvider, version: "next", secretValue: request.secretValue });
    } });
    const pending = client.saveProvider(ctx, input, fixtureOptions, signal());
    expect(input).not.toHaveProperty("secretValue");
    const result = await pending;
    expect(callerScrubbed).toBe(true); expect(observed).toBe("synthetic-only-input");
    expect(result).toEqual({ kind: "available", data: { ...fixtureProvider, version: "next" } });
    expect(result).not.toHaveProperty("secretValue"); expect(result.kind === "available" && result.data).not.toHaveProperty("secretValue");
    expect(input).not.toHaveProperty("secretValue"); expect(client).not.toHaveProperty("secretValue");
  });
  it("does not leak the request through rejected or cancelled saves", async () => {
    const rejectedInput = intent();
    const rejected = createProductClient({ ...adapter(null), saveProvider: async (_c, request) => { await Promise.resolve(); expect(request.secretValue).toBe("synthetic-only-input"); throw new Error("synthetic-only-input"); } });
    expect(await rejected.saveProvider(ctx, rejectedInput, fixtureOptions, signal())).toEqual({ kind: "unavailable" });
    expect(rejectedInput).not.toHaveProperty("secretValue");
    const controller = new AbortController(); let resolve!: (v: unknown) => void;
    const cancelledInput = intent();
    const cancelled = createProductClient({ ...adapter(null), saveProvider: (_c, request) => { expect(request.secretValue).toBe("synthetic-only-input"); return new Promise(r => { resolve = r; }); } });
    const pending = cancelled.saveProvider(ctx, cancelledInput, fixtureOptions, controller.signal);
    controller.abort(); resolve(envelope({ ...fixtureProvider, version: "next", secretValue: "synthetic-only-input" }));
    expect(await pending).toEqual({ kind: "cancelled" }); expect(cancelledInput).not.toHaveProperty("secretValue");
  });
  it("raw exceptions and malformed / oversized views are bounded", async () => {
    const client = createProductClient({ ...adapter(null), inspectProvider: async () => { throw new Error("synthetic-private-detail"); } });
    expect(await client.inspectProvider(ctx, fixtureProvider.id, signal())).toEqual({ kind: "unavailable" });
    expect(await createProductClient(adapter(envelope({ ...fixtureProvider, maskedHint: "x".repeat(257) }))).inspectProvider(ctx, fixtureProvider.id, signal())).toEqual({ kind: "unavailable" });
  });
  it("late aborted adapter response cannot return metadata", async () => {
    const controller = new AbortController(); let resolve!: (v: unknown) => void;
    const client = createProductClient({ ...adapter(null), inspectProvider: () => new Promise(r => { resolve = r; }) });
    const pending = client.inspectProvider(ctx, fixtureProvider.id, controller.signal); controller.abort(); resolve(envelope(fixtureProvider)); expect(await pending).toEqual({ kind: "cancelled" });
  });
  it("rejects duplicate inventory identifiers and profile option injection", async () => {
    const client = createProductClient({ ...createFixtureAdapter("available"), listProviders: async () => envelope({ items: [fixtureProvider, fixtureProvider], options: fixtureOptions }) });
    expect(await client.listProviders(ctx, signal())).toEqual({ kind: "unavailable" });
    expect(await client.saveProfile(ctx, { name: "Synthetic", backend: "/host/path", acpProfile: "synthetic-acp", project: "synthetic-project", resourcePolicy: "synthetic-policy", capabilities: [], optionsVersion: fixtureOptions.version }, fixtureOptions, signal())).toEqual({ kind: "unavailable" });
  });
});
describe("product request arbitration", () => {
  it("duplicate requests are suppressed and cancel/dispose drops late output", async () => {
    const request = new ProductRequest(); let resolve!: (v: { kind: "available"; data: string }) => void; const publish = vi.fn(); const call = vi.fn(() => new Promise<{ kind: "available"; data: string }>(r => { resolve = r; }));
    const pending = request.run(call, publish); await request.run(call, publish); expect(call).toHaveBeenCalledTimes(1); request.cancel(); resolve({ kind: "available", data: "old-workspace" }); await pending; expect(publish).not.toHaveBeenCalled();
  });
  it("timeout aborts, reports uncertainty and suppresses late response", async () => {
    vi.useFakeTimers(); try { const request = new ProductRequest(10); const publish = vi.fn(); let aborted = false; let resolve!: (v: { kind: "available"; data: string }) => void;
      const pending = request.run<string>(s => { s.addEventListener("abort", () => { aborted = true; }); return new Promise(r => { resolve = r; }); }, publish);
      await vi.advanceTimersByTimeAsync(11); await pending; expect(aborted).toBe(true); expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: "conflict" }); resolve({ kind: "available", data: "late" }); await Promise.resolve(); expect(publish).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
