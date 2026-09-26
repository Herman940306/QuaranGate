import { failureKinds, type ProductAdapter, type ProductClient, type ProductContext, type Result, type ProviderIntent } from "./contracts";
import { allowed, context, list, options, profile, provider, record, sameContext, text, unique } from "./projection";
/** Adapter must return {kind:'available',context,data}, or a bounded failure. Extra fields are discarded. */
export function createProductClient(adapter?: ProductAdapter): ProductClient {
  async function invoke<T>(ctx: ProductContext, signal: AbortSignal, call: (a: ProductAdapter, c: ProductContext) => Promise<unknown>, parse: (v: unknown) => T): Promise<Result<T>> {
    if (signal.aborted) return { kind: "cancelled" }; if (!adapter) return { kind: "integration_pending" };
    try { const c = context(ctx); const v = record(await call(adapter, c)); if (signal.aborted) return { kind: "cancelled" }; if (failureKinds.includes(v.kind as typeof failureKinds[number])) return { kind: v.kind as typeof failureKinds[number] }; if (v.kind !== "available" || !sameContext(c, context(v.context))) return { kind: "conflict" }; return { kind: "available", data: parse(v.data) }; }
    catch { return { kind: signal.aborted ? "cancelled" : "unavailable" }; }
  }
  return {
    integrated: Boolean(adapter),
    listProviders: (c, s) => invoke(c, s, (a, ctx) => a.listProviders(ctx, s), v => { const data = record(v); return { items: unique(list(data.items, provider)), options: options(data.options) }; }),
    listProfiles: (c, s) => invoke(c, s, (a, ctx) => a.listProfiles(ctx, s), v => { const data = record(v); return { items: unique(list(data.items, profile)), options: options(data.options) }; }),
    inspectProvider: (c, id, s) => invoke(c, s, (a, ctx) => a.inspectProvider(ctx, text(id), s), v => { const result = provider(v); if (result.id !== id) throw new Error("Wrong ID"); return result; }),
    inspectProfile: (c, id, s) => invoke(c, s, (a, ctx) => a.inspectProfile(ctx, text(id), s), v => { const result = profile(v); if (result.id !== id) throw new Error("Wrong ID"); return result; }),
    saveProvider: (c, input, opts, s) => {
      const pending = invoke(c, s, async (a, ctx) => {
      const o = options(opts); if (input.optionsVersion !== o.version) return { kind: "stale" };
      const request: ProviderIntent = { kind: allowed(input.kind, o.providerKinds), ownerScope: allowed(input.ownerScope, o.ownerScopes), optionsVersion: o.version, ...(input.id === undefined ? {} : { id: text(input.id), expectedVersion: text(input.expectedVersion) }) };
      if (input.secretValue !== undefined) { if (typeof input.secretValue !== "string" || !input.secretValue.length || input.secretValue.length > 4096) return { kind: "unavailable" }; request.secretValue = input.secretValue; }
      // The caller loses its reference; the adapter's request stays valid until settlement.
      // Immutable JavaScript strings cannot be cryptographically zeroized.
      delete input.secretValue;
      return await a.saveProvider(ctx, request, s);
    }, v => { const result = provider(v); if (input.id && (result.id !== input.id || result.version === input.expectedVersion)) throw new Error("Stale acknowledgement"); return result; });
      delete input.secretValue; return pending;
    },
    validateProvider: (c, id, version, s) => invoke(c, s, (a, ctx) => a.validateProvider(ctx, text(id), text(version), s), v => { const result = provider(v); if (result.id !== id || result.version === version) throw new Error("Stale validation"); return result; }),
    saveProfile: (c, input, opts, s) => invoke(c, s, (a, ctx) => {
      const o = options(opts); if (input.optionsVersion !== o.version) return Promise.resolve({ kind: "stale" });
      return a.saveProfile(ctx, { name: text(input.name), backend: allowed(input.backend, o.backends), acpProfile: allowed(input.acpProfile, o.acpProfiles), project: allowed(input.project, o.projects), resourcePolicy: allowed(input.resourcePolicy, o.resourcePolicies), capabilities: list(input.capabilities, v => allowed(text(v), o.capabilities)), optionsVersion: o.version, ...(input.id === undefined ? {} : { id: text(input.id), expectedVersion: text(input.expectedVersion) }) }, s);
    }, v => { const result = profile(v); if (input.id && (result.id !== input.id || result.version === input.expectedVersion)) throw new Error("Stale acknowledgement"); return result; }),
  };
}
