"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useIdentity } from "./identity-provider";
import { ProductBoundary } from "./product-boundary";
import { OperationalStateView, ReceiptTime } from "./operational-read";
import { Badge, Button, Input, MachineOutput, Panel, Select, Textarea } from "./primitives";
import { useProductRequest } from "./product-state";
import { useOperationalRead } from "../lib/client/use-operational-read";
import { createArenaClient, type Backend, type DispatchReceipt, type DispositionReceipt, type Project } from "../lib/client/arena/client";
import type { Inventory, ProductClient, ProductContext, ProfileView } from "../lib/client/product/contracts";
import { useWorkstationAction } from "../lib/client/workstation/use-action";
import type { JobStatus } from "../lib/operational/contracts";

const activeStatuses = new Set<JobStatus>(["QUEUED", "PREPARING", "RUNNING", "VALIDATING"]);
const finishedStatuses = new Set<JobStatus>(["COMPLETED", "FAILED_PRECONDITION", "FAILED_POLICY", "FAILED_AGENT", "FAILED_TIMEOUT", "FAILED_INFRASTRUCTURE", "CANCELLED", "APPLIED", "DISCARDED"]);
function jobTone(status: JobStatus) { return status === "APPLIED" ? "verified" : status.startsWith("FAILED") ? "destructive" : status === "COMPLETED" ? "attention" : "neutral" as const; }
function canAct(identity: ReturnType<typeof useIdentity>) { return identity.integrated && identity.state.kind === "active" && identity.state.session.principal.status === "mapped"; }
export function AgentArena() { return <ProductBoundary>{(product, context) => <ArenaContent product={product} context={context} />}</ProductBoundary>; }

function ArenaContent({ product, context }: { product: ProductClient; context?: ProductContext }) {
  const client = useMemo(() => createArenaClient(), []); const identity = useIdentity();
  const projectRead = useOperationalRead<Project[]>(); const backendRead = useOperationalRead<Backend[]>(); const profileRead = useProductRequest<Inventory<ProfileView>>();
  const statusRead = useOperationalRead<import("../lib/client/arena/client").JobState>();
  const resultRead = useOperationalRead<import("../lib/client/arena/client").AgentResult>();
  const diffRead = useOperationalRead<import("../lib/client/arena/client").DiffChunk>();
  const dispatch = useWorkstationAction<DispatchReceipt>(); const disposition = useWorkstationAction<DispositionReceipt>();
  const [project, setProject] = useState(""); const [backend, setBackend] = useState(""); const [profileId, setProfileId] = useState(""); const [prompt, setPrompt] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [jobId, setJobId] = useState(""); const [submittedPrompt, setSubmittedPrompt] = useState("");
  const pendingPrompt = useRef("");
  const [choice, setChoice] = useState<"cancel" | "discard" | "apply">("cancel"); const [confirmation, setConfirmation] = useState("");
  const runStatus = useRef(statusRead.run); runStatus.current = statusRead.run;
  const projects = projectRead.receipt?.data ?? []; const backends = backendRead.receipt?.data ?? [];
  const profiles = profileRead.result.kind === "available" ? profileRead.result.data.items : [];
  const selectedProject = projects.find(item => item.id === project);
  const selectedBackend = backends.find(item => item.id === backend);
  const eligibleProfiles = profiles.filter(item => item.project === project && item.backend === backend && selectedProject?.allowedProfiles.includes(item.acpProfile) && selectedBackend?.profiles.includes(item.acpProfile));
  const selectedProfile = eligibleProfiles.find(item => item.id === profileId);
  const selectedJob = statusRead.receipt?.data.jobId === jobId ? statusRead.receipt.data : undefined;
  const jobStatus = selectedJob?.status;
  const submitted = Boolean(jobId && /^job_[a-f0-9]{32}$/.test(jobId));
  const dispatchReady = canAct(identity) && Boolean(context) && product.integrated && Boolean(selectedProject && selectedBackend?.available && selectedProject.allowedBackends.includes(backend) && selectedProfile && prompt.trim());
  const diff = diffRead.receipt?.data.jobId === jobId ? diffRead.receipt.data : undefined;
  const result = resultRead.receipt?.data.jobId === jobId ? resultRead.receipt.data : undefined;
  const reviewed = Boolean(diff && !diff.truncated && diff.contentComplete === true && diff.applicable === true && result?.jobId === jobId && (!result.diffHash || result.diffHash === diff.diffHash));
  const dispositionReady = canAct(identity) && selectedJob?.jobId === jobId && (choice === "cancel" ? activeStatuses.has(selectedJob.status) : selectedJob.status === "COMPLETED" && (choice === "discard" || reviewed));
  function loadOptions() {
    void projectRead.run(signal => client.projects(signal)); void backendRead.run(signal => client.backends(signal));
    if (product.integrated && context) profileRead.run(signal => product.listProfiles(context, signal));
  }
  useEffect(() => {
    if (!submitted || (jobStatus && finishedStatuses.has(jobStatus)) || statusRead.state === "forbidden" || statusRead.state === "unauthenticated") return;
    const poll = () => { if (document.visibilityState === "visible") void runStatus.current(signal => client.status(jobId, signal)); };
    poll(); const timer = setInterval(poll, 4000); return () => clearInterval(timer);
  }, [submitted, jobId, jobStatus, statusRead.state, client]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!dispatchReady || !selectedProfile || !prompt.trim()) return;
    const intent = { project, backend, profile: selectedProfile.acpProfile, resourcePolicy: selectedProfile.resourcePolicy, prompt };
    pendingPrompt.current = prompt;
    await dispatch.run(() => client.dispatch(intent));
  }
  useEffect(() => {
    const ack = dispatch.receipt?.data; if (!ack || ack.jobId === jobId) return;
    setJobId(ack.jobId); setSubmittedPrompt(pendingPrompt.current); pendingPrompt.current = ""; setPrompt(""); setConfirmation("");
  }, [dispatch.receipt, jobId]);
  async function act() {
    if (!dispositionReady || confirmation !== `${choice} ${jobId}`) return;
    const id = jobId; const operation = choice; setConfirmation("");
    await disposition.run(() => operation === "cancel" ? client.cancel(id) : operation === "discard" ? client.discard(id) : client.apply(id), () => client.status(id));
    void statusRead.run(signal => client.status(id, signal));
  }
  return <><div className="page-heading"><div><p className="eyebrow">AGENT CONTROL PLANE / GOVERNED JOBS</p><h1>Agent Arena</h1><p className="page-intro">Configure one bounded work request, then follow its durable job. Completion creates reviewable evidence; only a separate apply can change the registered project.</p></div><Badge>Polling · no token stream</Badge></div>
    <div className="arena-grid"><aside className="arena-builder" aria-label="Agent builder"><Button className="arena-builder-toggle" aria-expanded={builderOpen} aria-controls="arena-builder-content" onClick={() => setBuilderOpen(open => !open)}>{builderOpen ? "Hide agent builder" : "Configure agent"} · {project || "no project"}</Button><div id="arena-builder-content" className="arena-builder-content" data-open={builderOpen}><Panel title="Agent builder" className="arena-builder-panel"><p className="muted">Selections request a server decision. Project, backend and Agent Profile configuration are separate from grants and runtime availability.</p>
      <Button onClick={loadOptions} busy={projectRead.pending || backendRead.pending || profileRead.pending}>Load current options</Button>
      <div className="cluster" role="status"><Badge>Projects: {projectRead.state.replaceAll("_", " ")}</Badge><Badge>Backends: {backendRead.state.replaceAll("_", " ")}</Badge></div>
      <Select id="arena-project" label="Project" value={projects.some(item => item.id === project) ? project : ""} onChange={event => { setProject(event.target.value); setProfileId(""); }}><option value="">Select returned project</option>{projects.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</Select>
      <Select id="arena-backend" label="Backend" value={backends.some(item => item.id === backend) ? backend : ""} onChange={event => { setBackend(event.target.value); setProfileId(""); }}><option value="">Select returned backend</option>{backends.filter(item => selectedProject?.allowedBackends.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.id} · {item.available ? "configured" : "unavailable"}</option>)}</Select>
      <Select id="arena-profile" label="Agent Profile" value={eligibleProfiles.some(item => item.id === profileId) ? profileId : ""} onChange={event => setProfileId(event.target.value)} help="Saved profiles are configuration, not authority. Only currently returned matching references appear."><option value="">{product.integrated ? "Select returned profile" : "Product profile integration pending"}</option>{eligibleProfiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.acpProfile}</option>)}</Select>
      {profileRead.result.kind === "available" ? <p className="muted">{profiles.length} configured profile{profiles.length === 1 ? "" : "s"} returned; {eligibleProfiles.length} match the selected project and backend.</p> : <p className="muted">Agent Profiles are unavailable until the accepted product adapter is connected. <Link href="/agent-profiles">Open Agent Profiles</Link>.</p>}
      <div className="permission"><Badge>Model resolution unknown</Badge><p>The current operational tool returns backend IDs and ACP profiles, not a model catalog, context size, hardware qualification or cloud entitlement. Those values cannot be inferred here. On the checked FE3 base, Kiro is the only real runner candidate; other backend IDs use a deterministic fake engine.</p></div>
      <p className="muted">Requested ACP profile: <strong>{selectedProfile?.acpProfile ?? "None"}</strong> · Resource policy: <strong>{selectedProfile?.resourcePolicy ?? "Unknown"}</strong></p>
    </Panel></div></aside>
    <section className="arena-conversation" aria-label="Governed agent conversation"><div className="arena-conversation-head"><div><p className="eyebrow">WORK REQUEST</p><h2>{submitted ? `Job ${jobId}` : "New governed request"}</h2></div><div className="cluster"><Badge tone={selectedJob ? jobTone(selectedJob.status) : "neutral"}>{selectedJob?.status ?? (dispatch.receipt ? dispatch.receipt.data.status : "LOCAL DRAFT")}</Badge>{submitted ? <Button onClick={() => { dispatch.reset(); disposition.reset(); setJobId(""); setSubmittedPrompt(""); setConfirmation(""); }}>New request</Button> : null}</div></div>
      <div className="arena-thread">{submittedPrompt ? <article className="arena-message"><p className="arena-message-meta">Your work request · local display</p><p>{submittedPrompt}</p></article> : submitted ? <p className="muted">Known job opened. The original prompt is not returned by this contract.</p> : <div className="arena-empty"><span className="arena-empty-mark" aria-hidden="true">Q</span><h3>What should this agent work on?</h3><p>Choose a returned project, backend and configured Agent Profile. Write the task below. QuaranGate dispatches only after an authenticated principal and server checks are available.</p></div>}
        {submitted ? <div className="arena-job"><section className="arena-job-track" aria-label="Job progression">{(["QUEUED", "PREPARING", "RUNNING", "VALIDATING", "COMPLETED"] as const).map((stage, index) => <div key={stage} data-current={selectedJob?.status === stage} data-passed={selectedJob ? ["QUEUED", "PREPARING", "RUNNING", "VALIDATING", "COMPLETED"].indexOf(selectedJob.status) > index : false}><span className="arena-step-number" aria-hidden="true">{index + 1}</span><strong>{stage}</strong></div>)}</section>
          <p role="status">Lifecycle: <Badge tone={selectedJob ? jobTone(selectedJob.status) : "neutral"}>{selectedJob?.status ?? "Awaiting server read"}</Badge></p>{selectedJob?.progress ? <p>{selectedJob.progress}</p> : null}{selectedJob?.failureCode ? <p>Failure code: <code>{selectedJob.failureCode}</code></p> : null}
          <div className="cluster"><Button onClick={() => void statusRead.run(signal => client.status(jobId, signal))} busy={statusRead.pending}>Check status</Button><span className="muted">Active jobs are polled every 4 seconds while this tab is visible.</span></div>
          {statusRead.receipt ? <ReceiptTime receivedAt={statusRead.receipt.receivedAt} /> : null}
          {statusRead.state !== "available" && statusRead.state !== "not_connected" ? <OperationalStateView state={statusRead.state} correlationId={statusRead.correlationId} /> : null}
          <div className="arena-evidence"><Panel title="Result"><Button onClick={() => void resultRead.run(signal => client.result(jobId, signal))} busy={resultRead.pending}>Read result</Button>{result ? <><p className="muted">Status {result.status} · {result.backend} · {result.project} · {result.profile} · exit {result.exitCode ?? "UNKNOWN"}</p><MachineOutput label="Agent summary · untrusted output">{result.summary}</MachineOutput><p className="muted">Evidence references: {result.evidence.length} · Changed files: {result.changedFiles.length} · Usage: {result.usageAvailable ? "reported" : "unavailable"}</p></> : <p className="muted">A final result is read separately. No response text is fabricated from status.</p>}</Panel>
            <Panel title="Diff review"><Button onClick={() => void diffRead.run(signal => client.diff(jobId, signal))} busy={diffRead.pending}>Read bounded diff</Button>{diff ? <><p className="muted">Hash <code>{diff.diffHash}</code> · {diff.chunkBytes}/{diff.totalBytes} bytes · {diff.truncated ? "More chunks exist" : "Single chunk"}</p><MachineOutput label="Stored diff · untrusted evidence">{diff.chunk}</MachineOutput><p className="muted">Content complete: {String(diff.contentComplete ?? "UNKNOWN")} · Applicable advisory: {String(diff.applicable ?? "UNKNOWN")}</p></> : <p className="muted">Review stored evidence before any disposition. A truncated first chunk is insufficient for apply.</p>}</Panel></div>
          <Panel title="Disposition"><p className="muted">COMPLETED means reviewable, never applied. Apply is a guarded promotion into the real registered project; the server re-verifies the canonical artifact, current grants, project HEAD, guarded paths and host state.</p>
            <fieldset className="cluster"><legend>Decision</legend>{(["cancel", "discard", "apply"] as const).map(operation => <Button key={operation} aria-pressed={choice === operation} onClick={() => { setChoice(operation); setConfirmation(""); }}>{operation[0].toUpperCase() + operation.slice(1)}</Button>)}</fieldset>
            <p className="muted">{choice === "cancel" ? "Cancel ends an active job; a retry creates a new job." : choice === "discard" ? "Discard records a final decision without changing the project or deleting evidence." : "Apply may change the real project. Review the complete verified diff and obtain the required server approval before submitting."}</p>
            <Input id="arena-confirm" label={`Type ${choice} ${jobId} to confirm`} value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" />
            <Button intent={choice === "apply" ? "destructive" : "attention"} emphasis="solid" busy={disposition.pending} disabled={!dispositionReady || confirmation !== `${choice} ${jobId}`} onClick={() => void act()}>Submit {choice}</Button>
            {!canAct(identity) ? <p className="muted">Product identity integration pending. No disposition request can be sent.</p> : null}
            {disposition.receipt ? <p role="status">Server acknowledged {disposition.receipt.data.status} for {disposition.receipt.data.jobId}. Check job status to reconcile current state.</p> : null}
            {disposition.failure ? <p role="alert">Outcome unverified. Check job status before retrying.</p> : null}
          </Panel>
        </div> : null}</div>
      <form noValidate className="arena-composer" onSubmit={event => void submit(event)}><Textarea id="arena-prompt" label="Work request" value={prompt} maxLength={32768} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Ask QuaranGate to review, plan, investigate, or implement…" help="Enter submits; Shift+Enter adds a line. The request is local until the server acknowledges dispatch." />
        <div className="arena-composer-bar"><div className="cluster"><Button disabled title="No accepted microphone or speech-to-text contract" aria-label="Voice input unavailable">Mic</Button><Button disabled title="Attachments are not in the current agent_dispatch contract">Attach</Button><Badge>{selectedProject?.id ?? "No project"}</Badge></div><Button type="submit" emphasis="solid" disabled={!dispatchReady || dispatch.pending} busy={dispatch.pending}>Dispatch request</Button></div>
        {dispatch.failure ? <p role="alert">Dispatch outcome unverified. Check for a server job receipt before trying again; no automatic retry occurs.</p> : null}
        {dispatch.receipt ? <p role="status">Server acknowledged job <code>{dispatch.receipt.data.jobId}</code> at <time dateTime={dispatch.receipt.data.createdAt}>{dispatch.receipt.data.createdAt}</time>.</p> : null}
        {!product.integrated ? <p className="muted">Product Agent Profile integration pending. Compose a draft; dispatch remains disabled.</p> : null}
      </form>
    </section></div>
    <div className="arena-reopen"><Panel title="Open a known job"><p className="muted">The current backend has no conversation or job-list API. Paste a known server-issued job ID to inspect its durable status; this field is not persisted.</p><Input id="arena-job-id" label="Known job ID" value={jobId} onChange={event => { dispatch.reset(); setJobId(event.target.value); setSubmittedPrompt(""); }} maxLength={36} placeholder="job_…" /></Panel></div>
  </>;
}
