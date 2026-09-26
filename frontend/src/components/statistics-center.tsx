"use client";
import { useState } from "react";
import type { StatisticsSnapshot } from "../lib/operational/contracts";
import { useOperational } from "./operational-provider";
import { OperationalHeading, ReadPanel, ReceiptTime } from "./operational-read";
import { Panel, PermissionExplanation, Select, Table } from "./primitives";

const windows = [
  { label: "15 minutes", value: 15 * 60 * 1000 },
  { label: "1 hour", value: 60 * 60 * 1000 },
  { label: "6 hours", value: 6 * 60 * 60 * 1000 },
  { label: "24 hours maximum", value: 24 * 60 * 60 * 1000 },
] as const;

function duration(value: number | null): string {
  return value === null ? "UNKNOWN" : `${value} ms`;
}

function windowLabel(windowMs: number): string {
  return windows.find(item => item.value === windowMs)?.label ?? `${windowMs} ms`;
}

function Snapshot({ snapshot }: { snapshot: StatisticsSnapshot }) {
  const activityRows = [
    ["Requested window", windowLabel(snapshot.activity.windowMs)],
    ["Retained principal entries", String(snapshot.activity.retained)],
    ["Entries in window", String(snapshot.activity.total)],
    ["Allowed", String(snapshot.activity.allowed)],
    ["Denied", String(snapshot.activity.denied)],
    ["Failures", String(snapshot.activity.failures)],
    ["p50 duration", duration(snapshot.activity.p50Ms)],
    ["p95 duration", duration(snapshot.activity.p95Ms)],
  ].map(([label, value], index) => ({ id: String(index), cells: { Metric: label, "Server value": value } }));
  const runtimeRows = [
    ["Active jobs", snapshot.jobs.active === null ? "UNKNOWN" : String(snapshot.jobs.active)],
    ["Queued jobs", snapshot.jobs.queued === null ? "UNKNOWN" : String(snapshot.jobs.queued)],
    ["Visible targets", String(snapshot.targets.visible)],
    ["Running targets", String(snapshot.targets.running)],
    ["Visible backends", String(snapshot.backends.visible)],
    ["Available backends", String(snapshot.backends.available)],
  ].map(([label, value], index) => ({ id: String(index), cells: { Metric: label, "Server value": value } }));
  return <>
    <ReceiptTime receivedAt={snapshot.generatedAt} generatedAt={snapshot.generatedAt} />
    <div className="review-grid">
      <Panel title="Activity window"><Table caption="Activity statistics" headings={["Metric", "Server value"]} rows={activityRows} /></Panel>
      <Panel title="Current runtime aggregates"><Table caption="Runtime statistics" headings={["Metric", "Server value"]} rows={runtimeRows} /></Panel>
    </div>
    <Panel title="Top tools in current window">
      {snapshot.activity.topTools.length
        ? <Table caption="Top tools" headings={["Tool", "Count"]} rows={snapshot.activity.topTools.map((row, index) => ({ id: String(index), cells: { Tool: row.tool, Count: String(row.count) } }))} />
        : <p className="muted">No tool activity was retained for the selected operational window.</p>}
    </Panel>
  </>;
}

export function StatisticsCenter() {
  const { client } = useOperational();
  const [windowMs, setWindowMs] = useState<number>(60 * 60 * 1000);
  return <>
    <OperationalHeading title="Statistics">Read the current principal-scoped operational statistics snapshot. Values come from the bounded in-memory Control Center activity ring plus current runtime aggregates; they are not durable analytics or a historical trend service.</OperationalHeading>
    <Panel title="Operational window">
      <Select id="statistics-window" label="Current in-memory window" value={String(windowMs)} onChange={event => setWindowMs(Number(event.target.value))} help="The server clamps statistics to at most 24 hours. Capacity is also bounded by the shared 2,048-entry in-memory activity ring.">
        {windows.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </Select>
      <p className="muted">Changing the window requests a fresh aggregate snapshot only. It does not query a durable warehouse or reconstruct missing activity.</p>
    </Panel>
    <ReadPanel key={windowMs} title="Statistics snapshot" action="Read statistics" operation={signal => client.statistics(windowMs, signal)}>
      {snapshot => <Snapshot snapshot={snapshot} />}
    </ReadPanel>
    <Panel title="Statistics boundary">
      <PermissionExplanation state="unknown" reason="There is no accepted durable 24h/7d/30d analytics, billing, token/cost, business-metric, retention warehouse or trend-series contract on this frontend lane." />
      <p className="muted">Current statistics are operational-window metadata only. Ring capacity or process restart may make the retained set shorter than the selected time window. No zero value is invented when the server reports an unknown runtime count.</p>
    </Panel>
  </>;
}
