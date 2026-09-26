"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import type { SessionView } from "../lib/identity/contracts";
import { AppearanceControls } from "./appearance-controls";
import { useIdentity } from "./identity-provider";
import { ProductAuthorization } from "./identity-permissions";
import { IdentityFeedback, PrincipalStateView } from "./identity-status";
import { MetadataTable } from "./operational-read";
import { Badge, Button, Panel } from "./primitives";

export function AccountSession({ session }: { session: SessionView }) {
  return <><MetadataTable caption="Safe account and session details" rows={[
    { label: "Display identity", value: session.user.displayName }, { label: "Product user reference", value: session.user.id },
    { label: "Organization", value: session.organization.name }, { label: "Workspace", value: session.workspace.name },
    { label: "Session version", value: session.version }, { label: "Issued (UTC)", value: session.issuedAt }, { label: "Expires (UTC)", value: session.expiresAt },
    { label: "Federation provider", value: session.federationLabel ?? "Not provided" }, { label: "QuaranGate Principal reference", value: session.principal.reference ?? "Not provided" },
  ]} /><PrincipalStateView status={session.principal.status} /></>;
}
export function Account() {
  const { state, pending, store } = useIdentity();
  const logoutRequested = useRef(false);
  const session = state.kind === "active" || state.kind === "expiring" ? state.session : undefined;
  useEffect(() => {
    if (!logoutRequested.current) return;
    if (pending === "logout") document.getElementById("identity-account-cancel")?.focus();
    else { document.getElementById("identity-account-check")?.focus(); logoutRequested.current = false; }
  }, [pending]);
  return <><div className="page-heading"><div><p className="eyebrow">PRODUCT IDENTITY / SESSION</p><h1>Account</h1><p className="page-intro">Your product context and its operational authority boundary.</p></div><Badge>Account view</Badge></div>
    <div className="authority-strip"><span className="authority-label">AUTHORITY BOUNDARY</span><strong>Operational authority is server-controlled.</strong><span>Identity and roles alone do not authorize operations.</span></div>
    <Panel title="Current session"><div className="form-actions"><Button id="identity-account-check" busy={Boolean(pending)} onClick={() => void store.refresh()}>Check session</Button>{pending ? <Button id="identity-account-cancel" onClick={store.cancel}>Cancel request</Button> : null}{session ? <Button disabled={Boolean(pending)} onClick={() => { logoutRequested.current = true; void store.logout(); }}>Sign out</Button> : <Link href="/sign-in">Sign in</Link>}</div><IdentityFeedback />{session ? <AccountSession session={session} /> : null}</Panel>
    <Panel title="Workspace membership"><p>Workspace choices come only from your current server-returned membership. Switching rechecks membership and principal mapping.</p><Link href="/workspaces">Choose workspace</Link></Panel>
    <Panel title="Product permissions">{session ? <ProductAuthorization session={session} showPrincipal={false} /> : <p>Product roles and overrides describe workflow eligibility. QuaranGate Principal grants and live preconditions remain separate.</p>}<Link href="/permissions">View product permissions</Link></Panel>
    <Panel title="Appearance preview"><AppearanceControls /><p className="muted">Cross-device preference sync pending. Sign-in does not persist these local preview choices.</p></Panel>
  </>;
}
