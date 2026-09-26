"use client";
import { useMemo, useState } from "react";
import { createApprovalClient } from "../lib/client/approvals/client";
import { approvalFixtureScenarios, createApprovalFixtureAdapter, type ApprovalFixtureScenario } from "../lib/client/approvals/fixtures";
import { createIdentityClient } from "../lib/identity/client";
import type { SessionView } from "../lib/identity/contracts";
import { ApprovalClientProvider } from "./approval-boundary";
import { Approvals } from "./approvals";
import { Panel, Select } from "./primitives";
import { Shell } from "./shell";

const now = () => Date.parse("2026-09-26T09:15:00Z");
function identityClient(workspaceId: string) {
  let session: SessionView = {
    user: { id: "synthetic-approver", displayName: "Synthetic approver" },
    organization: { id: "synthetic-org", name: "Synthetic org" },
    workspace: { id: workspaceId, name: workspaceId === "synthetic-lab" ? "Synthetic Lab" : "Synthetic Review" },
    workspaces: [{ id: "synthetic-lab", name: "Synthetic Lab" }, { id: "synthetic-review", name: "Synthetic Review" }],
    roles: [], overrides: [], capabilitySummary: [], principal: { status: "unmapped" }, version: "synthetic-session-v1",
    issuedAt: "2026-09-26T08:00:00Z", expiresAt: "2026-09-26T10:30:00Z",
  };
  let sequence = 1;
  return createIdentityClient({
    getCurrentSession: async () => ({ kind: "active", session }),
    beginLogin: async () => ({ kind: "redirecting" }),
    logout: async () => ({ kind: "signed_out" }),
    switchWorkspace: async (id, version) => {
      if (version !== session.version) return { kind: "stale" };
      const workspace = session.workspaces.find(item => item.id === id);
      if (!workspace) return { kind: "forbidden" };
      session = { ...session, workspace, version: `synthetic-session-v${++sequence}` };
      return { kind: "active", session };
    },
  }, now);
}
export function ApprovalsPreview() {
  const [scenario, setScenario] = useState<ApprovalFixtureScenario>("available");
  const [workspace, setWorkspace] = useState("synthetic-lab");
  const identity = useMemo(() => identityClient(workspace), [workspace]);
  const client = useMemo(() => createApprovalClient(createApprovalFixtureAdapter(scenario)), [scenario]);
  return <Shell engineering identityClient={identity} identityClock={now}>
    <Panel title="Synthetic approvals qualification">
      <p>Development-only approval records. No live BE5 adapter, operational authority, or execution capability is present.</p>
      <Select id="approval-scenario" label="Approval scenario" value={scenario} onChange={event => setScenario(event.target.value as ApprovalFixtureScenario)}>{approvalFixtureScenarios.map(item => <option key={item}>{item}</option>)}</Select>
      <Select id="approval-workspace" label="Synthetic workspace" value={workspace} onChange={event => setWorkspace(event.target.value)}>{["synthetic-lab", "synthetic-review"].map(item => <option key={item}>{item}</option>)}</Select>
    </Panel>
    <ApprovalClientProvider client={client}><div key={`${scenario}-${workspace}`}><Approvals /></div></ApprovalClientProvider>
  </Shell>;
}
