"use client";
import { useState } from "react";
import { grantFields, preflightFields, type AuthoritySnapshot, type PreflightRequest } from "../lib/operational/authority";
import { toolCatalog, type ToolName } from "../lib/operational/tool-catalog";
import { useOperational } from "./operational-provider";
import { MetadataTable, OperationalHeading, ReadPanel } from "./operational-read";
import { Badge, Panel, Select, Table } from "./primitives";

function GrantSnapshot({ snapshot }: { snapshot: AuthoritySnapshot }) {
  const { client } = useOperational();
  const [tool, setTool] = useState<ToolName>("targets_list");
  const [selection, setSelection] = useState<Partial<Record<typeof preflightFields[number], string>>>({});
  const request: PreflightRequest = { tool, ...selection };
  return <>
    <MetadataTable caption="authority metadata" rows={[
      { label: "principal.id", value: snapshot.principal.id ?? "UNKNOWN" },
      { label: "principal.name", value: snapshot.principal.name ?? "UNKNOWN" },
      ...(["scopes", ...grantFields] as const).map(label => ({ label: `principal.${label}`, value: snapshot.principal[label]?.join(", ") || (snapshot.principal[label] === null ? "UNKNOWN" : "None exposed") })),
    ]} />
    <Panel title="Operation-specific advisory preflight">
      <p>Preflight is advisory. Runtime state and operation-specific server checks may still deny the real action. No operation is executed here.</p>
      <Select id="authority-tool" label="Operation to explain" value={tool} onChange={event => { setTool(event.target.value as ToolName); setSelection({}); }}>
        {toolCatalog.map(item => <option key={item.name} value={item.name}>{item.name} · {item.authority}</option>)}
      </Select>
      <div className="foundation-grid">{preflightFields.map((field, index) => <Select key={field} id={`authority-${field}`} label={`Optional ${field}`} value={selection[field] ?? ""} onChange={event => setSelection(current => { const next = { ...current }; if (event.target.value) next[field] = event.target.value; else delete next[field]; return next; })}>
        <option value="">Not selected / not evaluated</option>
        {snapshot.principal[grantFields[index]]?.filter(value => value !== "*").map(value => <option key={value} value={value}>{value}</option>)}
      </Select>)}</div>
      <p className="muted">Selectors contain only exact identifiers in the server grant projection. Wildcard grants do not supply concrete inventory. An omitted dimension is not proof of authority for that dimension.</p>
      <ReadPanel key={JSON.stringify(request)} title="Server preflight result" action="Read advisory preflight" operation={signal => client.authority(request, signal)}>{result => <MetadataTable caption="Preflight result" rows={[
        { label: "Decision", value: result.preflight.evaluated === true ? result.preflight.allowed === true ? "ADVISORY_ALLOWED" : result.preflight.allowed === false ? "DENIED" : "UNKNOWN" : "NOT_AVAILABLE" },
        { label: "Required scope", value: result.preflight.requiredScope ?? "UNKNOWN" },
        { label: "Server reason", value: result.preflight.reason ?? "UNKNOWN" },
      ]} />}</ReadPanel>
    </Panel>
  </>;
}
export function SecurityExplorer() {
  const { client } = useOperational();
  return <>
    <OperationalHeading title="Security & Access">Principal → scopes → target, project, backend, profile and GitHub grants → operation-specific server preflight. Session identity is not authorization.</OperationalHeading>
    <Panel title="Authority classes">
      <p><Badge>Read</Badge> inspection · <Badge>Write</Badge> bounded content or job creation · <Badge>Execution</Badge> target commands · <Badge tone="attention">Destructive</Badge> lifecycle, deletion, promotion and remote write</p>
      <p>These labels describe impact, not eligibility. Effective grants and preflight decisions below come only from the server. No security grade or inferred permission is computed.</p>
      <details><summary>Operation impact reference · classifications do not grant permission</summary><Table caption="Action classes" headings={["Tool", "Authority", "Purpose"]} rows={toolCatalog.map(item => ({ id: item.name, cells: { Tool: item.name, Authority: item.authority, Purpose: item.purpose } }))} /></details>
    </Panel>
    <ReadPanel title="Effective principal grants" action="Read authority" operation={signal => client.authority(undefined, signal)}>{snapshot => <GrantSnapshot key={snapshot.generatedAt} snapshot={snapshot} />}</ReadPanel>
    <ReadPanel title="Capability qualification" action="Read capabilities" operation={signal => client.control("capabilities", signal)}>{snapshot => <MetadataTable caption="Capability metadata" rows={snapshot.rows} />}</ReadPanel>
    <ReadPanel title="Docker authority boundary" action="Read topology" operation={signal => client.control("topology", signal)}>{snapshot => <MetadataTable caption="Topology metadata" rows={snapshot.rows} />}</ReadPanel>
  </>;
}
