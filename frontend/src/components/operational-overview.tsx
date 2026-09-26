"use client";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel, ReceiptTime } from "./operational-read";
import { AppearanceControls } from "./appearance-controls";
import { Panel } from "./primitives";
export function Overview() {
  const { client } = useOperational();
  return <><OperationalHeading title="Overview">Inspect the backend and current principal. Missing values remain unknown; these snapshots are not analytics or authority grants.</OperationalHeading>
    <div className="foundation-grid"><ReadPanel title="Backend and target summary" action="Read overview" operation={signal => client.control("summary", signal)}>{snapshot => <><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="Overview metadata" rows={snapshot.rows} /></>}</ReadPanel>
    <ReadPanel title="Providers and aggregate jobs" action="Read provider state" operation={signal => client.control("providers", signal)}>{snapshot => <><p className="muted">Active/queued counts are runtime aggregates, not a list of your jobs.</p><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="Provider metadata" rows={snapshot.rows} /></>}</ReadPanel></div>
    <div className="foundation-grid"><ReadPanel title="Current principal grants" action="Read authority" operation={signal => client.control("authority", signal)}>{snapshot => <><p>Scope possession does not prove runtime eligibility.</p><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption="Principal grants" rows={snapshot.rows} /></>}</ReadPanel><Panel title="Workspace appearance"><AppearanceControls /></Panel></div>
  </>;
}
