"use client";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel, ReceiptTime } from "./operational-read";
import { Panel, PermissionExplanation } from "./primitives";

export function IdeSessionCenter() {
  const { client } = useOperational();
  return <>
    <OperationalHeading title="IDE Sessions">Read the server's bounded IDE-control readiness metadata. The current public surface does not expose IDE-session discovery, controller acquisition, prompts, cancellation or writer controls.</OperationalHeading>
    <div className="foundation-grid">
      <ReadPanel title="IDE control readiness" action="Read IDE readiness" operation={signal => client.control("summary", signal)}>
        {snapshot => {
          const rows = snapshot.rows.filter(row => row.label === "capabilityState.ideSessionControl");
          return <><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="IDE control readiness" rows={rows} /></>;
        }}
      </ReadPanel>
      <ReadPanel title="Adapter qualification" action="Read IDE adapter qualification" operation={signal => client.control("capabilities", signal)}>
        {snapshot => {
          const rows = snapshot.rows.filter(row => row.label.startsWith("VS Code /") || row.label.startsWith("Cursor /"));
          return <><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="IDE adapter qualification" rows={rows} /></>;
        }}
      </ReadPanel>
    </div>
    <Panel title="Current public boundary">
      <PermissionExplanation state="not_implemented" reason="Accepted IDE Session Control source remains a separately authorized Plane B. Its current review-operation foundation exposes no public MCP/HTTP session discovery or control route to this frontend." />
      <p className="muted">No session list, active agent, workspace/worktree binding, controller lease, review prompt, implementation request or cancellation control is synthesized here. When a public contract is accepted, those values must come from the server and preserve exact session/generation/workspace binding.</p>
    </Panel>
  </>;
}
