"use client";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel, ReceiptTime } from "./operational-read";
import { Panel, PermissionExplanation } from "./primitives";

export function MonitoringCenter() {
  const { client } = useOperational();
  return <>
    <OperationalHeading title="Monitoring">Read bounded monitoring metadata from the Control Center contract. These snapshots are not live telemetry streams, hardware probes, uptime guarantees or production-health certifications.</OperationalHeading>
    <div className="foundation-grid">
      <ReadPanel title="Runtime summary" action="Read runtime summary" operation={signal => client.control("summary", signal)}>{snapshot => <><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="Runtime summary metadata" rows={snapshot.rows} /></>}</ReadPanel>
      <ReadPanel title="Provider aggregates" action="Read provider aggregates" operation={signal => client.control("providers", signal)}>{snapshot => <><p className="muted">Aggregate counts are not a job list and do not prove principal-specific eligibility.</p><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="Provider aggregate metadata" rows={snapshot.rows} /></>}</ReadPanel>
      <ReadPanel title="Topology snapshot" action="Read topology" operation={signal => client.control("topology", signal)}>{snapshot => <><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="Topology metadata" rows={snapshot.rows} /></>}</ReadPanel>
      <ReadPanel title="Capability snapshot" action="Read capabilities" operation={signal => client.control("capabilities", signal)}>{snapshot => <><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="Capability metadata" rows={snapshot.rows} /></>}</ReadPanel>
    </div>
    <Panel title="Monitoring boundary">
      <PermissionExplanation state="unknown" reason="This frontend has no accepted hardware telemetry, temperature, GPU/VRAM, network-flow, log-stream or alerting contract. Unknown values remain unknown." />
      <p className="muted">A future monitoring product surface can add richer telemetry only after an accepted backend contract defines source, freshness, retention, authorization and failure semantics.</p>
    </Panel>
  </>;
}
