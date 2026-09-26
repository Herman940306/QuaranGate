"use client";
import Link from "next/link";
import { toolCatalog } from "../lib/operational/tool-catalog";
import { compareTools, type DiscoveredTool } from "../lib/operational/tool-discovery";
import { useOperational } from "./operational-provider";
import { OperationalHeading, ReadPanel } from "./operational-read";
import { Panel, Table } from "./primitives";
function Catalog({ tools }: { tools?: DiscoveredTool[] }) {
  const comparison = tools === undefined ? undefined : compareTools(tools);
  return <>
    <p>{comparison ? `Expected ${comparison.expected} · discovered ${comparison.live} · MISSING ${comparison.missing.length} · EXTRA ${comparison.extra.length}` : `Expected source catalog: ${toolCatalog.length} tools. Live discovery is UNKNOWN until read.`}</p>
    {comparison ? <p role="status">{comparison.missing.length || comparison.extra.length ? "CATALOG_DRIFT · review required; extra tools are not supported contracts" : "EXACT_NAME_MATCH · discovery does not grant operation authority"}</p> : null}
    <Table caption="Expected tool contracts" headings={["Tool", "Authority", "Purpose", "Discovery", "Bounded argument schema"]} rows={toolCatalog.map(tool => {
      const live = tools?.find(item => item.name === tool.name);
      return { id: tool.name, cells: { Tool: tool.name, Authority: tool.authority, Purpose: tool.purpose, Discovery: tools === undefined ? "UNKNOWN" : live ? "PRESENT" : "MISSING", "Bounded argument schema": live ? live.fields.map(field => `${field.name}: ${field.type} ${field.required ? "required" : "optional"}${field.min === null ? "" : ` min ${field.min}`}${field.max === null ? "" : ` max ${field.max}`}`).join("; ") || "No arguments exposed" : "UNKNOWN" } };
    })} />
    {comparison?.extra.length ? <Table caption="Extra discovered contracts" headings={["Tool", "Authority", "State"]} rows={comparison.extra.map(name => ({ id: name, cells: { Tool: name, Authority: "UNKNOWN", State: "EXTRA · not supported by frontend" } }))} /> : null}
  </>;
}
export function ToolLab() {
  const { client } = useOperational();
  return <>
    <OperationalHeading title="Tool Lab">Advanced inspection of the current governed MCP contract catalog. Tool discovery never bypasses server authorization or accepts catalog drift.</OperationalHeading>
    <ReadPanel title="Live contract discovery" action="Discover current tools" operation={signal => client.discoverTools(signal)}>{tools => <Catalog tools={tools} />}</ReadPanel>
    <details className="panel"><summary>Expected source catalog · available before connection</summary><Catalog /></details>
    <Panel title="Invocation boundary"><p>No arbitrary JSON-RPC method, endpoint, Docker API, host command or GitHub API input is provided. Discovery displays safe schema names/types/bounds only; defaults, descriptions, argument values and arbitrary schema bodies are dropped.</p><p>Execution and destructive actions remain in their governed workflows with existing confirmations and pessimistic server-authorized outcomes. The command palette navigates only and never executes a tool. COMPLETED != APPLIED.</p><p><Link href="/files">Files</Link> · <Link href="/terminal">Terminal</Link> · <Link href="/targets">Targets</Link> · <Link href="/arena">Agent Arena</Link> · <Link href="/github">GitHub</Link></p></Panel>
  </>;
}
