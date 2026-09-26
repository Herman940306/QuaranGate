"use client";
import { useState } from "react";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel } from "./operational-read";
import { Input, EmptyState, Table } from "./primitives";
import { TargetLifecycle } from "./operational-workstation";
export function Targets() {
  const { client } = useOperational(); const [target, setTarget] = useState("");
  return <><OperationalHeading title="Targets" lifecycle>Read authorized targets and inspect one logical target. Lifecycle actions require separate server authorization; running state and health are separate.</OperationalHeading>
    <ReadPanel title="Authorized inventory" action="Read targets" operation={signal => client.targets(signal)}>{rows => <><p className="muted">Showing up to 100 of {rows.length} returned targets. This display cap does not bound backend enumeration.</p>{rows.length ? <Table caption="Targets" headings={["ID", "Name", "Source", "Running", "Health"]} rows={rows.slice(0, 100).map((row, i) => ({ id: String(i), cells: { ID: row.id, Name: row.name, Source: row.source, Running: row.running ? "Running" : "Stopped", Health: row.health } }))} /> : <EmptyState title="No targets returned">No target inventory is exposed to this principal.</EmptyState>}</>}</ReadPanel>
    <Input id="inspect-target" label="Logical target ID" value={target} maxLength={256} onChange={event => setTarget(event.target.value)} help="Enter an ID from the authorized inventory. No host paths or Docker identifiers are selected here." />
    <ReadPanel key={target} ready={target.length > 0} title="Target detail" action="Inspect target" operation={signal => client.target(target, signal)}>{row => <MetadataTable caption="Target detail" rows={[{ label: "ID", value: row.id }, { label: "Running", value: String(row.running) }, { label: "Status", value: row.status }, { label: "Health", value: row.health }, { label: "Source", value: row.source }]} />}</ReadPanel>
    <TargetLifecycle />
  </>;
}
