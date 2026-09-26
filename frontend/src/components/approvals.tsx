"use client";
import { useMemo, useState } from "react";
import { approvalCopy, type ApprovalDecision, type ApprovalView } from "../lib/client/approvals/contracts";
import type { ApprovalClient } from "../lib/client/approvals/contracts";
import type { ProductContext } from "../lib/client/product/contracts";
import { useProductRequest } from "./product-state";
import { ApprovalBoundary } from "./approval-boundary";
import { Badge, Button, EmptyState, Input, MachineOutput, Panel, Textarea } from "./primitives";

function tone(status: ApprovalView["status"]) {
  return status === "APPROVED" ? "verified" : status === "REJECTED" || status === "EXPIRED" || status === "CANCELLED" ? "destructive" : "attention";
}
function Feedback({ kind }: { kind: "loading" | "integration_pending" | "unavailable" | "forbidden" | "stale" | "conflict" | "cancelled" }) {
  return <p role={kind === "loading" ? "status" : "alert"}>{approvalCopy[kind]}</p>;
}
export function Approvals() {
  return <ApprovalBoundary>{(client, context) => <ApprovalsContent client={client} context={context} />}</ApprovalBoundary>;
}

function ApprovalsContent({ client, context }: { client: ApprovalClient; context?: ProductContext }) {
  const list = useProductRequest<ApprovalView[]>();
  const decision = useProductRequest<ApprovalView>();
  const [selectedId, setSelectedId] = useState("");
  const [choice, setChoice] = useState<ApprovalDecision>("APPROVED");
  const [confirmation, setConfirmation] = useState("");
  const [rationale, setRationale] = useState("");

  const rows = list.result.kind === "available" ? list.result.data : [];
  const listed = useMemo(() => rows.find(row => row.id === selectedId), [rows, selectedId]);
  const acknowledged = decision.result.kind === "available" && decision.result.data.id === selectedId ? decision.result.data : undefined;
  const selected = acknowledged ?? listed;
  const pending = selected?.status === "PENDING";

  function load() {
    if (!context) return;
    list.run(signal => client.list(context, signal));
  }

  function submitDecision() {
    if (!context || !selected || selected.status !== "PENDING" || confirmation !== `${choice.toLowerCase()} ${selected.id}`) return;
    decision.run(signal => client.decide(context, {
      id: selected.id,
      decision: choice,
      expectedVersion: selected.version,
      ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
    }, signal));
  }

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">COLLABORATION / DECISION RECORDS</p><h1>Review & Approvals</h1><p className="page-intro">Review bounded approval records and record a decision. Approval is evidence of a decision only; it never executes the underlying operation or grants operational authority.</p></div>
      <Badge>APPROVED ≠ EXECUTED</Badge>
    </div>
    <div className="review-grid">
      <Panel title="Approval inbox">
        <p className="muted">Records are scoped to the current product session and workspace. Referenced resources require their own authorization when opened or executed elsewhere.</p>
        <Button onClick={load} busy={list.pending} disabled={!context}>Load approvals</Button>
        {!client.integrated ? <p className="muted">Production approval adapter integration pending. No BE5 request is sent from this surface yet.</p> : null}
        {list.result.kind === "available" && !rows.length ? <EmptyState title="No approval records">The current workspace returned no approval records.</EmptyState> : null}
        {list.result.kind !== "available" && list.result.kind !== "integration_pending" ? <Feedback kind={list.result.kind} /> : null}
        {rows.length ? <ul className="approval-list" aria-label="Approval records">{rows.map(row => <li key={row.id}><Button className="approval-row" aria-pressed={selectedId === row.id} onClick={() => { setSelectedId(row.id); setConfirmation(""); setRationale(""); }}>
          <span className="approval-row-copy"><strong>{row.actionClass}</strong><small>{row.subjectType} · {row.subjectId}</small></span><Badge tone={tone(row.status)}>{row.status}</Badge>
        </Button></li>)}</ul> : null}
      </Panel>
      <Panel title={selected ? `Approval ${selected.id}` : "Decision review"}>
        {!selected ? <EmptyState title="Select an approval">Choose a returned record to inspect its safe decision metadata.</EmptyState> : <>
          <div className="cluster"><Badge tone={tone(selected.status)}>{selected.status}</Badge><Badge>v{selected.version}</Badge></div>
          <dl className="detail-grid">
            <div><dt>Requester</dt><dd>{selected.requesterProductUserId}</dd></div>
            <div><dt>Action class</dt><dd>{selected.actionClass}</dd></div>
            <div><dt>Subject</dt><dd>{selected.subjectType} · {selected.subjectId}</dd></div>
            <div><dt>Requested</dt><dd><time dateTime={selected.createdAt}>{selected.createdAt}</time></dd></div>
            <div><dt>Expires</dt><dd>{selected.expiresAt ? <time dateTime={selected.expiresAt}>{selected.expiresAt}</time> : "Not supplied"}</dd></div>
            <div><dt>Correlation</dt><dd>{selected.requestCorrelationId}</dd></div>
          </dl>
          {selected.evidenceDigestSha256 ? <MachineOutput label="Evidence digest · reference only">{selected.evidenceDigestSha256}</MachineOutput> : <p className="muted">No evidence digest was supplied with this record.</p>}
          {selected.rationale ? <p><strong>Rationale:</strong> {selected.rationale}</p> : null}
          <div className="permission"><Badge tone="attention">Decision record only</Badge><p>Even an APPROVED record cannot call MCP, Agent Control Plane, GitHub, Docker, host, or any other operational surface. Any future execution flow must re-check current session, mapped principal, grants, resource state, and preconditions.</p></div>
          <fieldset className="cluster" disabled={!pending || decision.pending}><legend>Decision</legend>
            <Button aria-pressed={choice === "APPROVED"} onClick={() => { setChoice("APPROVED"); setConfirmation(""); }}>Approve</Button>
            <Button aria-pressed={choice === "REJECTED"} intent="destructive" onClick={() => { setChoice("REJECTED"); setConfirmation(""); }}>Reject</Button>
          </fieldset>
          <Textarea id="approval-rationale" label="Decision rationale" value={rationale} maxLength={4096} onChange={event => setRationale(event.target.value)} disabled={!pending} help="Optional bounded decision text. It does not grant authority." />
          <Input id="approval-confirm" label={`Type ${choice.toLowerCase()} ${selected.id} to confirm`} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={!pending} autoComplete="off" />
          <Button emphasis="solid" intent={choice === "REJECTED" ? "destructive" : "attention"} busy={decision.pending} disabled={!pending || confirmation !== `${choice.toLowerCase()} ${selected.id}`} onClick={submitDecision}>Record {choice === "APPROVED" ? "approval" : "rejection"}</Button>
          {!pending ? <p className="muted">This record is final or expired. No decision control is available.</p> : null}
          {decision.result.kind === "available" ? <p role="status">Server acknowledged {decision.result.data.status} at version {decision.result.data.version}. This acknowledgement does not mean the underlying operation executed.</p> : decision.result.kind !== "integration_pending" ? <Feedback kind={decision.result.kind} /> : null}
        </>}
      </Panel>
    </div>
  </>;
}
