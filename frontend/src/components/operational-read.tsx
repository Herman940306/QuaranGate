"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useOperationalRead } from "../lib/client/use-operational-read";
import { freshness, stateCopy, type OperationalState } from "../lib/operational/state";
import type { ReadReceipt } from "../lib/operational/transport";
import { Badge, Button, EmptyState, LoadingState, Panel, Table } from "./primitives";
export function OperationalStateView({ state, correlationId }: { state: OperationalState; correlationId?: string }) {
  return <div className="state" role="status"><Badge tone={state === "forbidden" ? "destructive" : state === "available" ? "verified" : "neutral"}>{state.replaceAll("_", " ")}</Badge><p>{stateCopy[state]}</p>{correlationId ? <small>Request correlation: {correlationId}</small> : null}</div>;
}
export function ReceiptTime({ receivedAt, generatedAt }: { receivedAt: string; generatedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  return <p className="muted">Received: <time dateTime={receivedAt}>{receivedAt}</time>{generatedAt ? <> · Generated: <time dateTime={generatedAt}>{generatedAt}</time></> : null} · {freshness(generatedAt ?? receivedAt, now)}</p>;
}
export function ReadPanel<T>({ title, action, operation, children, ready = true }: { ready?: boolean; title: string; action: string; operation: (signal: AbortSignal) => Promise<ReadReceipt<T>>; children: (data: T) => ReactNode }) {
  const read = useOperationalRead<T>();
  return <Panel title={title}><div className="form-actions"><Button disabled={!ready} busy={read.pending} onClick={() => void read.run(operation)}>{action}</Button>{read.pending ? <Button onClick={read.cancel}>Cancel read</Button> : null}</div>
    {read.pending ? <LoadingState label="Reading server state" /> : <OperationalStateView state={read.state} correlationId={read.correlationId} />}
    {read.receipt ? <><ReceiptTime receivedAt={read.receipt.receivedAt} />{children(read.receipt.data)}</> : null}
  </Panel>;
}
export function MetadataTable({ caption, rows }: { caption: string; rows: { label: string; value: string }[] }) {
  return rows.length ? <Table caption={caption} headings={["Field", "Server value"]} rows={rows.map((row, index) => ({ id: `${index}`, cells: { Field: row.label, "Server value": row.value } }))} /> : <EmptyState title="No metadata exposed">No values were returned for this read.</EmptyState>;
}
export function OperationalHeading({ title, children }: { title: string; children: ReactNode }) {
  return <><div className="page-heading"><div><p className="eyebrow">GOVERNED WORKSPACE / READ</p><h1>{title}</h1><p className="page-intro">{children}</p></div><Badge>Read only</Badge></div><div className="authority-strip"><span className="authority-label">AUTHORITY BOUNDARY</span><strong>Server-authorized reads</strong><span>Eligibility remains server-controlled</span><span>Production identity integration pending</span></div></>;
}
