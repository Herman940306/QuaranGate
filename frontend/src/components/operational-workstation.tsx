"use client";
import { useMemo, useState, type ReactNode } from "react";
import { useIdentity } from "./identity-provider";
import { useOperational } from "./operational-provider";
import { GitExecution } from "./operational-git";
import { MetadataTable, ReadPanel, ReceiptTime } from "./operational-read";
import { Badge, Button, EmptyState, Input, MachineOutput, Panel, Select, Table, Textarea } from "./primitives";
import { createWorkstationClient, workspacePath, type TargetControlReceipt } from "../lib/client/workstation/client";
import { useWorkstationAction } from "../lib/client/workstation/use-action";
import type { OperationalState } from "../lib/operational/state";
import type { Target } from "../lib/operational/contracts";

function Heading({ title, description, authority }: { title: string; description: string; authority: "Read" | "Execution" | "Write" }) {
  return <div className="page-heading"><div><p className="eyebrow">GOVERNED WORKSPACE / {authority.toUpperCase()}</p><h1>{title}</h1><p className="page-intro">{description}</p></div><Badge tone={authority === "Read" ? "neutral" : "attention"}>{authority} · server authorized</Badge></div>;
}
function useCanMutate() {
  const identity = useIdentity();
  return identity.integrated && identity.state.kind === "active" && identity.state.session.principal.status === "mapped";
}
function MutationBoundary({ children }: { children: ReactNode }) {
  const allowed = useCanMutate();
  return <><div className="permission"><Badge tone={allowed ? "attention" : "neutral"}>{allowed ? "Server decision required" : "Integration pending"}</Badge><p>{allowed ? "This request will be evaluated against the current principal, target and policy. A browser selection never grants access." : "An authenticated product session and principal mapping are required before this action can be submitted. The current frontend cannot assert them."}</p></div>{children}</>;
}
function TargetPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { client } = useOperational();
  return <ReadPanel title="Authorized targets" action="Load targets" operation={signal => client.targets(signal)}>{(rows: Target[]) => <>
    <Select id="workstation-target" label="Target" value={rows.some(row => row.id === value) ? value : ""} onChange={event => onChange(event.target.value)} help="Only returned logical target IDs can be selected. The server still checks each operation."><option value="">Select a returned target</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id} · {row.running ? "running" : "stopped"}</option>)}</Select>
    <p className="muted">{rows.length} target{rows.length === 1 ? "" : "s"} returned. Target source and status are server observations, not authority grants.</p>
  </>}</ReadPanel>;
}
const mutationFailure: Record<OperationalState, string> = {
  not_connected: "No operational connection was verified.", unauthenticated: "An authenticated principal is required.", forbidden: "The server denied the operation.", unavailable: "The operational service did not return a usable acknowledgement.", unknown: "The response could not be verified.", stale: "The current context may have changed.", not_implemented: "The server does not implement this operation.", available: "The operation state is inconsistent.", cancelled: "The request stopped locally; server outcome is unknown.",
};
function ActionResult<T>({ action, summary }: { action: ReturnType<typeof useWorkstationAction<T>>; summary: (value: T) => ReactNode }) {
  return <div className="action-result" role="status" aria-live="polite">{action.pending ? <p>Waiting for server acknowledgement. Do not repeat the request.</p> : null}
    {action.failure ? <div className="permission"><Badge tone="destructive">Outcome unverified</Badge><p>{mutationFailure[action.failure]} The request may have reached the server; inspect current state before retrying.</p></div> : null}
    {action.receipt ? <div className="permission"><Badge tone="verified">Server acknowledged</Badge>{summary(action.receipt.data)}<ReceiptTime receivedAt={action.receipt.receivedAt} />{action.receipt.correlationId ? <p className="mono">Request correlation: {action.receipt.correlationId}</p> : null}{action.check ? <p>Post-action read: {action.check === "confirmed" ? "completed" : action.check === "pending" ? "checking" : "unavailable; inspect before further changes"}.</p> : null}</div> : null}
  </div>;
}
function validPath(path: string, root = false) { try { workspacePath(path, root); return true; } catch { return false; } }

export function Files() {
  const client = useMemo(() => createWorkstationClient(), []);
  const allowed = useCanMutate();
  const [target, setTarget] = useState(""); const [path, setPath] = useState(""); const [query, setQuery] = useState("");
  const [content, setContent] = useState(""); const [oldText, setOldText] = useState(""); const [newText, setNewText] = useState("");
  const [mode, setMode] = useState<"write" | "patch" | "delete">("write"); const [confirmation, setConfirmation] = useState("");
  const action = useWorkstationAction<{ ok: true; path: string }>();
  const selected = Boolean(target); const fileSelected = selected && validPath(path); const safeRoot = validPath(path, true);
  function chooseTarget(value: string) { setTarget(value); setPath(""); setConfirmation(""); setContent(""); setOldText(""); setNewText(""); }
  async function submit() {
    if (!allowed || !fileSelected || action.pending) return;
    if (mode === "delete") {
      if (confirmation !== `${target}:${path}`) return;
      await action.run(() => client.deleteFile(target, path), () => client.listFiles(target, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""));
      setConfirmation(""); return;
    }
    if (mode === "write") { if (!content) return; if (await action.run(() => client.writeFile(target, path, content), () => client.statFile(target, path))) setContent(""); return; }
    if (!oldText) return;
    if (await action.run(() => client.patchFile(target, path, oldText, newText), () => client.statFile(target, path))) { setOldText(""); setNewText(""); }
  }
  return <><Heading title="Files" authority="Write" description="Inspect and edit workspace-relative files in an authorized target. Paths never select a host filesystem." />
    <TargetPicker value={target} onChange={chooseTarget} />
    <div className="workstation-grid"><Panel title="Workspace path"><Input id="file-path" label="Relative path" value={path} maxLength={1024} onChange={event => { setPath(event.target.value); setConfirmation(""); }} error={!safeRoot ? "Use a workspace-relative path without traversal." : undefined} help="Leave blank for the workspace root when listing or searching. Exact file operations require a path." />
      <p className="muted">Returned paths are shown exactly as supplied by the server. A path in this form does not bypass server confinement.</p></Panel>
      <ReadPanel key={`list:${target}:${path}`} ready={selected && safeRoot} title="Browse directory" action="List entries" operation={signal => client.listFiles(target, path, signal)}>{entries => entries.length ? <ul className="file-entry-list" aria-label="Directory entries">{entries.map(entry => { const relative = entry.replace(/^\.\//, "").replace(/\/$/, ""); return <li key={entry}><span className="mono">{entry}</span>{validPath(relative) ? <Button onClick={() => setPath(relative)}>Select path</Button> : <Badge>Display only</Badge>}</li>; })}</ul> : <EmptyState title="No entries returned">This directory has no visible entries.</EmptyState>}</ReadPanel>
      <ReadPanel key={`stat:${target}:${path}`} ready={fileSelected} title="Path details" action="Stat path" operation={signal => client.statFile(target, path, signal)}>{stat => <MetadataTable caption="File metadata" rows={[{ label: "Path", value: stat.path }, { label: "Type", value: stat.type }, { label: "Size (bytes)", value: String(stat.size) }, { label: "Mode", value: stat.mode }, { label: "Modified", value: stat.mtime }, ...(stat.linkTarget ? [{ label: "Symlink target · metadata only", value: stat.linkTarget }] : [])]} />}</ReadPanel>
      <ReadPanel key={`read:${target}:${path}`} ready={fileSelected} title="File content" action="Read file" operation={signal => client.readFile(target, path, signal)}>{file => <><p className="muted">{file.bytes} server-reported bytes · UTF-8 presentation · bounded preview. Content is kept in page memory only.</p><MachineOutput label={`Untrusted file content · ${file.path}`}>{file.content}</MachineOutput></>}</ReadPanel>
      <Panel title="Search workspace"><Input id="file-search" label="Fixed-string query" value={query} maxLength={256} onChange={event => setQuery(event.target.value)} help="Search is recursive under the relative path above; up to 100 matches are requested." /><ReadPanel key={`search:${target}:${path}:${query}`} ready={selected && safeRoot && query.length > 0} title="Search results" action="Search files" operation={signal => client.searchFiles(target, path, query, signal)}>{matches => matches.length ? <Table caption="Returned matches" headings={["Match"]} rows={matches.map((match, index) => ({ id: String(index), cells: { Match: match } }))} /> : <EmptyState title="No matches returned">The server found no visible matches for this query.</EmptyState>}</ReadPanel></Panel>
    </div>
    <Panel title="Change a file"><MutationBoundary><fieldset className="cluster"><legend>File action</legend>{(["write", "patch", "delete"] as const).map(next => <Button key={next} aria-pressed={mode === next} onClick={() => { setMode(next); setConfirmation(""); }}>{next === "write" ? "Create / overwrite" : next === "patch" ? "Exact patch" : "Delete file"}</Button>)}</fieldset>
      <p className="muted">Target: <strong className="mono">{target || "None selected"}</strong> · Path: <strong className="mono">{path || "None selected"}</strong> · {mode === "delete" ? "Destructive · files:delete" : "Write · files:write"}</p>
      {mode === "write" ? <Textarea id="file-content" label="Replacement UTF-8 content" value={content} maxLength={262144} onChange={event => setContent(event.target.value)} help="Create or overwrite the exact path. This draft remains in page memory only and clears after acknowledgement." /> : null}
      {mode === "patch" ? <><Textarea id="file-old" label="Existing exact text" value={oldText} maxLength={65536} onChange={event => setOldText(event.target.value)} help="The server requires a unique exact match." /><Textarea id="file-new" label="Replacement text" value={newText} maxLength={65536} onChange={event => setNewText(event.target.value)} /></> : null}
      {mode === "delete" ? <Input id="file-delete-confirm" label={`Type ${target || "TARGET"}:${path || "PATH"} to confirm`} value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" help="Only a single path is requested; recursive deletion is not exposed in this UI." /> : null}
      <Button emphasis="solid" intent={mode === "delete" ? "destructive" : "primary"} disabled={!allowed || !fileSelected || (mode === "delete" ? confirmation !== `${target}:${path}` : mode === "write" ? !content : !oldText)} busy={action.pending} onClick={() => void submit()}>{mode === "delete" ? "Delete exact file" : mode === "patch" ? "Submit exact patch" : "Submit file write"}</Button>
      <ActionResult action={action} summary={value => <p>Path acknowledged: <code>{value.path}</code>.</p>} />
    </MutationBoundary></Panel>
  </>;
}

export function Terminal() {
  const client = useMemo(() => createWorkstationClient(), []); const allowed = useCanMutate(); const action = useWorkstationAction<import("../lib/operational/contracts").GitOutput>();
  const [target, setTarget] = useState(""); const [cwd, setCwd] = useState(""); const [command, setCommand] = useState("");
  return <><Heading title="Terminal" authority="Execution" description="Run one bounded command inside an authorized target workspace. Output appears after the server responds; this is not a streaming shell." />
    <TargetPicker value={target} onChange={value => { setTarget(value); setCwd(""); setCommand(""); }} />
    <Panel title="Command request"><MutationBoundary><p className="muted">Authority: terminal:exec · target: <strong className="mono">{target || "None selected"}</strong> · requested timeout: 20 seconds. No command history is stored.</p>
      <Input id="terminal-cwd" label="Relative working directory (optional)" value={cwd} onChange={event => setCwd(event.target.value)} maxLength={1024} error={cwd && !validPath(cwd) ? "Use a workspace-relative path without traversal." : undefined} />
      <Textarea id="terminal-command" label="Command" value={command} onChange={event => setCommand(event.target.value)} maxLength={4096} autoComplete="off" help="Treat commands as execution requests. Do not enter credentials. No cancellation is presented because the current tool exposes no cancellation operation." />
      <Button emphasis="solid" intent="attention" disabled={!allowed || !target || !command.trim() || Boolean(cwd && !validPath(cwd))} busy={action.pending} onClick={() => { const submitted = command; setCommand(""); void action.run(() => client.execute(target, submitted, cwd)); }}>Run command</Button>
      <ActionResult action={action} summary={value => <GitExecution output={value} />} />
    </MutationBoundary></Panel>
  </>;
}

export function Processes() {
  const client = useMemo(() => createWorkstationClient(), []); const [target, setTarget] = useState("");
  return <><Heading title="Processes" authority="Read" description="Inspect bounded process output from one authorized target. Process termination is not in the current contract." />
    <TargetPicker value={target} onChange={setTarget} />
    <ReadPanel key={target} ready={Boolean(target)} title="Target processes" action="Read processes" operation={signal => client.processes(target, signal)}>{output => <><MetadataTable caption="Process read receipt" rows={[{ label: "Exit code", value: output.exitCode === null ? "UNKNOWN" : String(output.exitCode) }, { label: "Timed out", value: String(output.timedOut) }, { label: "Truncated", value: String(output.truncated) }, { label: "Duration ms", value: String(output.durationMs) }]} /><MachineOutput label="Untrusted process output">{output.stdout}</MachineOutput>{output.stderr ? <MachineOutput label="Process read stderr">{output.stderr}</MachineOutput> : null}</>}</ReadPanel>
  </>;
}

export function TargetLifecycle() {
  const client = useMemo(() => createWorkstationClient(), []); const allowed = useCanMutate();
  const [target, setTarget] = useState(""); const [choice, setChoice] = useState<"start" | "stop" | "restart">("start"); const [confirmation, setConfirmation] = useState("");
  const action = useWorkstationAction<TargetControlReceipt>();
  return <Panel title="Target lifecycle"><MutationBoundary><p className="muted">Start, stop, or restart only an existing authorized manual target. The server verifies target source, current state, principal scope, and policy.</p>
    <TargetPicker value={target} onChange={value => { setTarget(value); setConfirmation(""); }} />
    <fieldset className="cluster"><legend>Lifecycle operation</legend>{(["start", "stop", "restart"] as const).map(value => <Button key={value} aria-pressed={choice === value} onClick={() => { setChoice(value); setConfirmation(""); }}>{value[0].toUpperCase() + value.slice(1)}</Button>)}</fieldset>
    <Input id="target-control-confirm" label={`Type ${choice} ${target || "TARGET"} to confirm`} value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" help="This confirmation expresses intent. It never proves authority or completion." />
    <Button emphasis="solid" intent="destructive" disabled={!allowed || !target || confirmation !== `${choice} ${target}`} busy={action.pending} onClick={() => { const selected = target; const operation = choice; setConfirmation(""); void action.run(() => client.controlTarget(selected, operation), () => client.inspectTarget(selected)); }}>Submit {choice}</Button>
    <ActionResult action={action} summary={value => <p><strong>{value.action}</strong> acknowledged for <code>{value.target}</code>. Server reported <strong>{value.status}</strong>; running: {String(value.running)}.</p>} />
  </MutationBoundary></Panel>;
}
