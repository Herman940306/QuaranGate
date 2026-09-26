"use client";
import { useMemo, useState } from "react";
import { createIdentityClient } from "../lib/identity/client";
import type { IdentityAdapter, IdentityState, SessionView } from "../lib/identity/contracts";
import { Account } from "./identity-account";
import { Permissions } from "./identity-permissions";
import { useIdentity } from "./identity-provider";
import { SignIn } from "./identity-sign-in";
import { Workspaces } from "./identity-workspaces";
import { ReadPanel } from "./operational-read";
import { Panel, Select } from "./primitives";
import { Shell } from "./shell";
const scenarios = ["signed_out", "active", "stale", "workspace_conflict", "forbidden", "unmapped", "mapping_unavailable", "principal_forbidden", "unavailable", "expired", "revoked", "expiring", "slow_switch"] as const;
type Scenario = typeof scenarios[number];
const fixtureNow = Date.parse("2026-09-26T08:00:00Z");
const fixtureClock = () => fixtureNow;
function fixtureSession(scenario: Scenario, workspace = "synthetic-lab", version = "synthetic-v1"): SessionView {
  return { user: { id: "synthetic-user", displayName: "Synthetic Operator" }, organization: { id: "synthetic-org", name: "Synthetic Organization" }, workspace: { id: workspace, name: workspace === "synthetic-lab" ? "Synthetic Lab" : "Synthetic Review" }, workspaces: [{ id: "synthetic-lab", name: "Synthetic Lab" }, { id: "synthetic-review", name: "Synthetic Review" }], roles: ["Reviewer"], overrides: ["Review workflow only"], principal: scenario === "unmapped" ? { status: "unmapped" } : scenario === "mapping_unavailable" ? { status: "unavailable" } : scenario === "principal_forbidden" ? { status: "forbidden" } : { status: "mapped", reference: "synthetic-principal" }, capabilitySummary: ["Review workflow eligibility; display only"], version, issuedAt: "2026-09-26T07:00:00Z", expiresAt: scenario === "expiring" ? "2026-09-26T08:04:00Z" : "2026-09-26T09:00:00Z", federationLabel: "Synthetic Keycloak" };
}
function fixtureAdapter(scenario: Scenario): IdentityAdapter {
  let current = fixtureSession(scenario);
  let signedOut = scenario === "signed_out";
  const read = (): IdentityState => signedOut ? { kind: "signed_out" } : scenario === "unavailable" || scenario === "expired" || scenario === "revoked" ? { kind: scenario } : { kind: "active", session: current };
  return {
    getCurrentSession: async () => read(), beginLogin: async () => ({ kind: "redirecting" }),
    logout: async () => { signedOut = true; return { kind: "signed_out" }; },
    switchWorkspace: async (id, version) => {
      if (scenario === "stale" || scenario === "workspace_conflict" || scenario === "forbidden") return { kind: scenario };
      if (version !== current.version) return { kind: "stale" };
      // Intentionally ignores abort to prove the UI suppresses late replies. Entire route is dev-only.
      if (scenario === "slow_switch") await new Promise(resolve => setTimeout(resolve, 600));
      current = fixtureSession(scenario, id, "synthetic-v2"); return { kind: "active", session: current };
    },
  };
}
export function IdentityPreview() {
  const [scenario, setScenario] = useState<Scenario>("signed_out");
  const [surface, setSurface] = useState("sign-in");
  const client = useMemo(() => createIdentityClient(fixtureAdapter(scenario), () => fixtureNow), [scenario]);
  return <Shell engineering identityClient={client} identityClock={fixtureClock}><Panel title="Synthetic identity qualification"><p>Development-only fixtures. No live account, identity provider or backend integration. No production sign-in is simulated.</p><Select id="fixture-scenario" label="Synthetic scenario" value={scenario} onChange={e => setScenario(e.target.value as Scenario)}>{scenarios.map(s => <option key={s}>{s}</option>)}</Select><Select id="fixture-surface" label="Preview surface" value={surface} onChange={e => setSurface(e.target.value)}>{["sign-in", "account", "workspaces", "permissions"].map(s => <option key={s}>{s}</option>)}</Select></Panel>{surface === "account" ? <Account /> : surface === "workspaces" ? <Workspaces /> : surface === "permissions" ? <Permissions /> : <SignIn />}<ProjectionProbe /></Shell>;
}
function ProjectionProbe() {
  const { state } = useIdentity();
  return <ReadPanel<string> title="Synthetic operational projection" action="Read synthetic projection" ready={state.kind === "active" || state.kind === "expiring"} operation={async () => { await new Promise(resolve => setTimeout(resolve, 250)); return { data: "Synthetic operational result", receivedAt: new Date().toISOString() }; }}>{data => <p>{data}</p>}</ReadPanel>;
}
