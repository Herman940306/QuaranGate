"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { SessionView } from "../lib/identity/contracts";
import { useIdentity } from "./identity-provider";
import { IdentityFeedback } from "./identity-status";
import { Badge, Button, Panel, Select } from "./primitives";
function WorkspaceSelection({ session, onSwitch }: { session: SessionView; onSwitch: (id: string, version: string) => void }) {
  const [selected, setSelected] = useState(session.workspace.id);
  return <><Select id="identity-workspace" label="Workspace" value={selected} help="Only current memberships returned by the server are listed." onChange={event => setSelected(event.target.value)}>{session.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
    <div className="form-actions"><Button emphasis="solid" disabled={selected === session.workspace.id} onClick={() => onSwitch(selected, session.version)}>Switch workspace</Button></div></>;
}
export function Workspaces() {
  const { state, pending, store } = useIdentity();
  const switchRequested = useRef(false);
  const session = state.kind === "active" || state.kind === "expiring" ? state.session : undefined;
  useEffect(() => {
    if (!switchRequested.current) return;
    if (pending === "workspace") document.getElementById("identity-workspace-cancel")?.focus();
    else { document.getElementById(session ? "identity-workspace" : "identity-session-check")?.focus(); switchRequested.current = false; }
  }, [pending, session]);
  function switchWorkspace(id: string, version: string) { switchRequested.current = true; void store.switchWorkspace(id, version); }
  return <><div className="page-heading"><div><p className="eyebrow">PRODUCT IDENTITY / MEMBERSHIP</p><h1>Workspaces</h1><p className="page-intro">Choose a workspace from your current membership.</p></div><Badge>Version checked by server</Badge></div>
    <Panel title="Workspace context"><p>Switching clears prior operational results and checks the expected session version. A conflict requires a fresh session check; no last-write-wins or automatic retry is assumed.</p><IdentityFeedback />
      {session && !pending ? <WorkspaceSelection key={`${session.user.id}:${session.version}:${session.workspace.id}`} session={session} onSwitch={switchWorkspace} /> : null}
      <div className="form-actions"><Button id="identity-session-check" busy={Boolean(pending)} onClick={() => void store.refresh()}>Check session</Button>{pending ? <Button id="identity-workspace-cancel" onClick={store.cancel}>Cancel request</Button> : null}<Link href="/account">View account</Link></div>
    </Panel></>;
}
