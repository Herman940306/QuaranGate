"use client";
import { useMemo, useState } from "react";
import { createIdentityClient } from "../lib/identity/client";
import type { SessionView } from "../lib/identity/contracts";
import { createProductClient } from "../lib/client/product/client";
import { createFixtureAdapter, fixtureScenarios, type FixtureScenario } from "../lib/client/product/fixtures";
import { AppearanceControls } from "./appearance-controls";
import { ProductClientProvider } from "./product-boundary";
import { AgentProfiles, Providers } from "./product-inventory";
import { Workspaces } from "./identity-workspaces";
import { Panel, Select } from "./primitives";
import { Shell } from "./shell";
const now = () => Date.parse("2026-09-26T08:00:00Z");
function identityClient(userId: string) {
  let session: SessionView = { user: { id: userId, displayName: "Synthetic operator" }, organization: { id: "synthetic-org", name: "Synthetic org" }, workspace: { id: "synthetic-lab", name: "Synthetic Lab" }, workspaces: [{ id: "synthetic-lab", name: "Synthetic Lab" }, { id: "synthetic-review", name: "Synthetic Review" }], roles: [], overrides: [], capabilitySummary: [], principal: { status: "unmapped" }, version: "synthetic-session-v1", issuedAt: "2026-09-26T07:00:00Z", expiresAt: "2026-09-26T09:00:00Z" };
  let sequence = 1;
  return createIdentityClient({ getCurrentSession: async () => ({ kind: "active", session }), beginLogin: async () => ({ kind: "redirecting" }), logout: async () => ({ kind: "signed_out" }), switchWorkspace: async (id, version) => { if (version !== session.version) return { kind: "stale" }; const workspace = session.workspaces.find(w => w.id === id); if (!workspace) return { kind: "forbidden" }; session = { ...session, workspace, version: `synthetic-session-v${++sequence}` }; return { kind: "active", session }; } }, now);
}
export function ProductPreview() {
  const [scenario, setScenario] = useState<FixtureScenario>("available"); const [surface, setSurface] = useState("providers"); const [user, setUser] = useState("synthetic-user-a");
  const identity = useMemo(() => identityClient(user), [user]); const client = useMemo(() => createProductClient(createFixtureAdapter(scenario)), [scenario]);
  return <Shell engineering identityClient={identity} identityClock={now}><Panel title="Synthetic configuration qualification"><p>Development-only fixtures. No live provider, secret custody, product integration or operational grants.</p><Select id="product-scenario" label="Configuration scenario" value={scenario} onChange={e => setScenario(e.target.value as FixtureScenario)}>{fixtureScenarios.map(s => <option key={s}>{s}</option>)}</Select><Select id="product-surface" label="Configuration surface" value={surface} onChange={e => setSurface(e.target.value)}>{["providers", "profiles"].map(s => <option key={s}>{s}</option>)}</Select><Select id="product-user" label="Synthetic identity" value={user} onChange={e => setUser(e.target.value)}>{["synthetic-user-a", "synthetic-user-b"].map(s => <option key={s}>{s}</option>)}</Select><AppearanceControls /></Panel><Workspaces /><ProductClientProvider client={client}><div key={`${scenario}-${surface}-${user}`}>{surface === "providers" ? <Providers /> : <AgentProfiles />}</div></ProductClientProvider></Shell>;
}
