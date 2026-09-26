/** Synthetic fixture adapter. Imported only by development preview or tests; never production runtime. */
import type { ProductAdapter, ProductContext, ProductOptions, ProfileView, ProviderView } from "./contracts";
export const fixtureOptions: ProductOptions = {
  version: "synthetic-options-1", providerKinds: [{ id: "synthetic-provider", label: "Synthetic provider" }], ownerScopes: [{ id: "workspace", label: "Current synthetic workspace" }],
  backends: [{ id: "synthetic-backend", label: "Synthetic review backend" }], acpProfiles: [{ id: "synthetic-acp", label: "Synthetic bounded profile" }], projects: [{ id: "synthetic-project", label: "Synthetic logical project" }], resourcePolicies: [{ id: "synthetic-policy", label: "Synthetic resource policy" }], capabilities: [{ id: "synthetic-read", label: "Synthetic read preference" }],
};
export const fixtureProvider: ProviderView = { id: "synthetic-provider-1", kind: "synthetic-provider", ownerScope: "workspace", configured: true, maskedHint: "•••• demo", validation: "unknown", updatedAt: "2026-09-26T08:00:00Z", version: "synthetic-provider-v1" };
export const fixtureProfile: ProfileView = { id: "synthetic-profile-1", name: "Synthetic reviewer", backend: "synthetic-backend", acpProfile: "synthetic-acp", project: "synthetic-project", resourcePolicy: "synthetic-policy", capabilities: ["synthetic-read"], version: "synthetic-profile-v1" };
export const fixtureScenarios = ["available", "empty", "unavailable", "forbidden", "stale", "validation_failed", "slow"] as const;
export type FixtureScenario = typeof fixtureScenarios[number];
export function createFixtureAdapter(scenario: FixtureScenario): ProductAdapter {
  // Workspace-keyed metadata only. Never retain secret values or mutation histories.
  const providers = new Map<string, ProviderView[]>(); const profiles = new Map<string, ProfileView[]>(); let sequence = 1;
  const p = (c: ProductContext) => { if (!providers.has(c.workspaceId)) providers.set(c.workspaceId, scenario === "empty" ? [] : [{ ...fixtureProvider, id: `${c.workspaceId}-provider` }]); return providers.get(c.workspaceId) ?? []; };
  const a = (c: ProductContext) => { if (!profiles.has(c.workspaceId)) profiles.set(c.workspaceId, scenario === "empty" ? [] : [{ ...fixtureProfile, id: `${c.workspaceId}-profile` }]); return profiles.get(c.workspaceId) ?? []; };
  async function response(c: ProductContext, data: unknown, mutation = false) {
    if (scenario === "slow") await new Promise(resolve => setTimeout(resolve, 650)); // ignored abort tests late-response suppression
    if (scenario === "unavailable" || scenario === "forbidden") return { kind: scenario };
    if (mutation && scenario === "stale") return { kind: "stale" };
    return { kind: "available", context: c, data };
  }
  return {
    listProviders: c => response(c, { items: p(c), options: fixtureOptions }), listProfiles: c => response(c, { items: a(c), options: fixtureOptions }),
    inspectProvider: (c, id) => response(c, p(c).find(i => i.id === id)), inspectProfile: (c, id) => response(c, a(c).find(i => i.id === id)),
    saveProvider: (c, input) => {
      const current = input.id ? p(c).find(i => i.id === input.id) : undefined;
      if (input.id && (!current || input.expectedVersion !== current.version)) return Promise.resolve({ kind: "stale" });
      const next: ProviderView = { ...fixtureProvider, id: input.id ?? `${c.workspaceId}-provider-${++sequence}`, kind: input.kind, ownerScope: input.ownerScope, configured: Boolean(current?.configured || input.secretValue), version: `synthetic-provider-v${++sequence}` };
      if (scenario !== "stale" && scenario !== "forbidden" && scenario !== "unavailable") providers.set(c.workspaceId, [...p(c).filter(i => i.id !== next.id), next]);
      return response(c, next, true);
    },
    validateProvider: (c, id, version) => {
      const current = p(c).find(i => i.id === id); if (!current || version !== current.version) return Promise.resolve({ kind: "stale" });
      const next: ProviderView = { ...current, validation: scenario === "validation_failed" ? "failed" : "succeeded", version: `synthetic-validation-v${++sequence}` };
      if (scenario !== "stale" && scenario !== "forbidden" && scenario !== "unavailable") providers.set(c.workspaceId, p(c).map(i => i.id === id ? next : i));
      return response(c, next, true);
    },
    saveProfile: (c, input) => {
      const current = input.id ? a(c).find(i => i.id === input.id) : undefined; if (input.id && (!current || input.expectedVersion !== current.version)) return Promise.resolve({ kind: "stale" });
      const next: ProfileView = { id: input.id ?? `${c.workspaceId}-profile-${++sequence}`, name: input.name, backend: input.backend, acpProfile: input.acpProfile, project: input.project, resourcePolicy: input.resourcePolicy, capabilities: [...input.capabilities], version: `synthetic-profile-v${++sequence}` };
      if (scenario !== "stale" && scenario !== "forbidden" && scenario !== "unavailable") profiles.set(c.workspaceId, [...a(c).filter(i => i.id !== next.id), next]);
      return response(c, next, true);
    },
  };
}
