"use client";
import { useMemo } from "react";
import { createIdentityClient } from "../lib/identity/client";
import type { SessionView } from "../lib/identity/contracts";
import { createProductClient } from "../lib/client/product/client";
import { createFixtureAdapter, fixtureOptions, fixtureProfile } from "../lib/client/product/fixtures";
import { AgentArena } from "./agent-arena";
import { ProductClientProvider } from "./product-boundary";
import { Panel } from "./primitives";
import { Shell } from "./shell";

const now = () => Date.parse("2026-09-26T08:00:00Z");
const session: SessionView = { user: { id: "synthetic-operator", displayName: "Synthetic operator" }, organization: { id: "synthetic-org", name: "Synthetic org" }, workspace: { id: "synthetic-lab", name: "Synthetic lab" }, workspaces: [{ id: "synthetic-lab", name: "Synthetic lab" }], roles: ["Reviewer"], overrides: [], capabilitySummary: [], principal: { status: "mapped", reference: "synthetic-principal" }, version: "synthetic-v1", issuedAt: "2026-09-26T07:00:00Z", expiresAt: "2026-09-26T09:00:00Z" };
export function ArenaPreview() {
  const identity = useMemo(() => createIdentityClient({ getCurrentSession: async () => ({ kind: "active", session }), beginLogin: async () => ({ kind: "redirecting" }), switchWorkspace: async () => ({ kind: "forbidden" }), logout: async () => ({ kind: "signed_out" }) }, now), []);
  const product = useMemo(() => { const base = createFixtureAdapter("available"); return createProductClient({ ...base, listProfiles: async context => ({ kind: "available", context, data: { items: [{ ...fixtureProfile, id: "synthetic-reviewer", name: "Synthetic reviewer", backend: "kiro", acpProfile: "review", project: "demo", resourcePolicy: "standard" }], options: { ...fixtureOptions, backends: [{ id: "kiro", label: "Kiro" }], acpProfiles: [{ id: "review", label: "Review" }], projects: [{ id: "demo", label: "Demo" }], resourcePolicies: [{ id: "standard", label: "Standard" }] } } }) }); }, []);
  return <Shell engineering identityClient={identity} identityClock={now}><Panel title="Synthetic Agent Arena qualification"><p>Development-only interface fixture. The MCP route must be mocked by the browser test. No live principal, provider, dispatch, project write or backend integration is claimed.</p></Panel><ProductClientProvider client={product}><AgentArena /></ProductClientProvider></Shell>;
}
