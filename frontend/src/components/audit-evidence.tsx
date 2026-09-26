"use client";
import { useState } from "react";
import type { ActivitySnapshot } from "../lib/operational/activity";
import { toolCatalog } from "../lib/operational/tool-catalog";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel } from "./operational-read";
import { Panel, Select, Table } from "./primitives";
function EvidenceSnapshot({ snapshot }: { snapshot: ActivitySnapshot }) {
  const [selected, setSelected] = useState("");
  const request = snapshot.rows.find(row => row.reqId === selected);
  return <>
    <p className="muted">Gateway-memory retention: at most {snapshot.retention.maxEntries} entries / {snapshot.retention.maxAgeMs / 3_600_000} hours; this read returns at most 100 current-principal rows. This is not an immutable ledger or a complete durable history.</p>
    <Table caption="Chronological activity · newest first" headings={["Timestamp", "Request", "Principal", "Tool", "Authority", "Target", "Decision", "Code", "Duration"]} rows={snapshot.rows.map((row,index) => ({ id: String(index), cells: { Timestamp: row.ts, Request: row.reqId, Principal: row.principal ?? "UNKNOWN", Tool: row.tool, Authority: toolCatalog.find(item => item.name === row.tool)?.authority ?? "UNKNOWN", Target: row.target ?? "UNKNOWN", Decision: row.decision, Code: row.code ?? "UNKNOWN", Duration: row.durationMs === null ? "UNKNOWN" : `${row.durationMs} ms` } }))} />
    {snapshot.rows.length === 0 ? <p>No activity retained for this principal and window.</p> : <Select id="evidence-request" label="Known request reference" value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">Select retained request</option>{Array.from(new Set(snapshot.rows.map(row => row.reqId))).map(id => <option key={id} value={id}>{id}</option>)}
    </Select>}
    <Panel title="Evidence lineage">
      <MetadataTable caption="Proven lineage" rows={[{ label: "Request", value: request?.reqId ?? "UNKNOWN" }, { label: "Request → job", value: "UNKNOWN · no relationship exposed" }]} />
      <p>The chain stops here. No sandbox, evidence, diff, review, apply/discard, commit, image or runtime link is inferred from a tool name or target identifier.</p>
    </Panel>
  </>;
}
export function AuditEvidence() {
  const { client } = useOperational();
  return <>
    <OperationalHeading title="Audit & Evidence">Chronological metadata from the principal-scoped activity ring. Operation classes describe impact, not permission or execution success.</OperationalHeading>
    <ReadPanel title="Retained activity" action="Read audit metadata" operation={signal => client.activity(signal)}>{snapshot => <EvidenceSnapshot key={snapshot.generatedAt} snapshot={snapshot} />}</ReadPanel>
    <Panel title="Evidence boundary"><p>Only timestamps, request/principal/tool/target identifiers, decisions, safe codes and durations are projected. Raw prompts, arguments, terminal output, file contents, response bodies and credentials are never displayed or persisted.</p><p>Richer lineage is NOT_AVAILABLE until an accepted server contract supplies authorized identifiers and explicit relationships. No chain-of-custody certification is claimed.</p></Panel>
  </>;
}
