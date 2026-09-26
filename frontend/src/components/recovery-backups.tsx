"use client";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel } from "./operational-read";
import { Panel, Table } from "./primitives";
export function RecoveryBackups() {
  const { client } = useOperational();
  return <>
    <OperationalHeading title="Recovery & Backups">Read current recovery configuration and ownership metadata. No restoration, cleanup or recovery operation is performed by this page.</OperationalHeading>
    <ReadPanel title="Recovery metadata" action="Read recovery metadata" operation={signal => client.control("recovery", signal)}>{snapshot => <><MetadataTable caption="Recovery metadata" rows={snapshot.rows} /><p>The server field startupRecovery currently reflects Agent Control Plane configuration only. CONFIGURED does not prove startup recovery succeeded or that quarantine is clear.</p></>}</ReadPanel>
    <ReadPanel title="Resource lifecycle boundary" action="Read resource boundary" operation={signal => client.resources(signal)}>{snapshot => <MetadataTable caption="Resource boundary" rows={[{ label: "Enumeration state", value: snapshot.state }, { label: "Ownership model", value: snapshot.ownership }, { label: "Cleanup authority", value: snapshot.cleanup }, { label: "Server note", value: snapshot.note }]} />}</ReadPanel>
    <Panel title="Unavailable recovery detail"><Table caption="Recovery contract gaps" headings={["Capability", "State", "Boundary"]} rows={[
      { id: "quarantine", cells: { Capability: "Quarantine and session refusal details", State: "NOT_AVAILABLE", Boundary: "No public metadata fields expose these details" } },
      { id: "backups", cells: { Capability: "Backup inventory and recovery evidence IDs", State: "NOT_AVAILABLE", Boundary: "Managed externally; no public inventory or evidence linkage" } },
      { id: "mutations", cells: { Capability: "Restore / backup / cleanup / release / rollback controls", State: "NOT_IMPLEMENTED", Boundary: "No accepted browser mutation contract; use the separately governed external process" } },
    ]} /></Panel>
    <Panel title="State vocabulary"><p>AVAILABLE means a supported server-reported capability. NOT_AVAILABLE means no exposed read value or capability. NOT_IMPLEMENTED means no implementation contract. NOT_QUALIFIED means qualification is incomplete. UNKNOWN means no verified value. DEFERRED means explicitly postponed. A configuration declaration is not runtime recovery evidence.</p></Panel>
  </>;
}
