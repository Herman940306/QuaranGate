"use client";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel, ReceiptTime } from "./operational-read";
import { controlViews, type ControlView } from "../lib/operational/contracts";
function ControlViewPanel({ view }: { view: ControlView }) {
  const { client } = useOperational();
  return <ReadPanel title={view[0].toUpperCase() + view.slice(1)} action={`Read ${view}`} operation={signal => client.control(view, signal)}>{snapshot => <><ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} /><MetadataTable caption={`${view} metadata`} rows={snapshot.rows} /></>}</ReadPanel>;
}
export function ControlCenter({ security = false }: { security?: boolean }) {
  return <><OperationalHeading title={security ? "Security & Access" : "Control Center"}>{security ? "Principal grants and capability evidence. No security score is fabricated. Displayed scopes and advisory state do not authorize an operation." : "Read metadata snapshots. UNKNOWN, deferred implementation and production qualification remain distinct. Recovery is informational only."}</OperationalHeading><div className="foundation-grid">{(security ? ["authority", "capabilities", "topology"] as const : controlViews).map(view => <ControlViewPanel key={view} view={view} />)}</div></>;
}
