"use client";
import Link from "next/link";
import { navigationGroups } from "../lib/navigation";
import { CommandDiscovery } from "./command-discovery";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { IdentityClient } from "../lib/identity/contracts";
import { IdentityProvider, useIdentity } from "./identity-provider";
import { useOverlay } from "./overlays";
import { OperationalProvider, useOperational } from "./operational-provider";
import { Badge, IconButton } from "./primitives";

function Navigation({ engineering, onNavigate }: { engineering: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return <nav aria-label="Main navigation">{navigationGroups.map(group => <div className="nav-group" key={group.label}>
    <p className="nav-group-label">{group.label}</p>
    {group.routes.map(([href, label]) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} onClick={onNavigate}>{label}</Link>)}
    {group.label === "Workspace" && engineering ? <Link href="/design-system" aria-current={pathname === "/design-system" ? "page" : undefined} onClick={onNavigate}>Design System <span>DEV</span></Link> : null}
  </div>)}</nav>;
}
function AuthorityClasses({ principal }: { principal: string }) {
  return <section className="shell-authority" aria-label="Authority classifications">
    <div className="authority-context"><strong>Authority classes</strong><span>Classification only · eligibility and grants are server-controlled</span><small>{principal}</small></div>
    <ol className="authority-classes"><li><strong>Read</strong><span>Server checked</span></li><li><strong>Write</strong><span>Server checked</span></li><li><strong>Execution</strong><span>Server checked</span></li><li><strong>Destructive</strong><span>Confirm + server check</span></li></ol>
  </section>;
}
function TrustRibbon() {
  return <section className="trust-ribbon" aria-label="Execution trust path"><div><span>01 · Client</span><strong>Request intent</strong><small>No direct executor control</small></div><div><span>02 · Gateway</span><strong>Authorization boundary</strong><small>Live status not verified here</small></div><div><span>03 · Executor</span><strong>Server mediated</strong><small>Availability unknown here</small></div></section>;
}
export function Shell({ children, engineering, identityClient, identityClock }: { children: ReactNode; engineering: boolean; identityClient?: IdentityClient; identityClock?: () => number }) {
  return <IdentityProvider client={identityClient} clock={identityClock}><IdentityOperationalBoundary engineering={engineering}>{children}</IdentityOperationalBoundary></IdentityProvider>;
}
function IdentityOperationalBoundary({ children, engineering }: { children: ReactNode; engineering: boolean }) {
  const { projectionEpoch } = useIdentity();
  return <OperationalProvider projectionEpoch={projectionEpoch}><ShellBody engineering={engineering}>{children}</ShellBody></OperationalProvider>;
}
function ShellBody({ children, engineering }: { children: ReactNode; engineering: boolean }) {
  const overlay = useOverlay();
  const pathname = usePathname();
  const { state } = useOperational();
  const identity = useIdentity();
  const session = identity.state.kind === "active" || identity.state.kind === "expiring" ? identity.state.session : undefined;
  const principal = session ? `Principal ${session.principal.status}; grants require server check` : "No verified principal";
  const readFailure = ["forbidden", "unavailable", "unknown", "stale", "unauthenticated"].includes(state);
  return <div className="shell"><a className="skip-link" href="#main">Skip to content</a>
    <aside className="rail"><Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">Q</span><span>QuaranGate<small>ENGINEERING WORKSPACE</small></span></Link><Navigation engineering={engineering} /><div className="rail-foot"><span className="rail-label">AUTHORITY BOUNDARY</span><p>Server authority applies to every operation.</p><span className="rail-version">Product integration pending</span></div></aside>
    <div className="workspace"><header className="command-bar"><div className="header-context"><span className="narrow-menu"><IconButton label="Open navigation" onClick={() => overlay.open({ title: "Navigation", description: "QuaranGate product routes", kind: "drawer", closeOnDesktop: true, children: <Navigation engineering={engineering} onNavigate={overlay.close} /> })}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg></IconButton></span><Link href="/workspaces" className="context-label">Workspace<small>{session?.workspace.name ?? "No verified workspace"}</small></Link></div><div className="account-context"><CommandDiscovery /><div className="read-context"><span>Last read</span><Badge>{state === "available" ? "completed" : state === "not_connected" ? "not checked" : state.replaceAll("_", " ")}</Badge></div><Link href="/account" className="context-label">Account<small>{session?.user.displayName ?? (identity.integrated ? identity.state.kind.replaceAll("_", " ") : "Identity integration pending")}</small></Link></div></header>
      <AuthorityClasses principal={principal} />
      {readFailure ? <section className="shell-status-banner" aria-label="Last read context"><strong>Last read: {state.replaceAll("_", " ")}</strong><span>Check the affected panel for details. This does not establish general service or grant status.</span></section> : null}
      <main id="main" tabIndex={-1} key={["/overview", "/arena", "/approvals", "/ide-sessions", "/models", "/monitoring", "/statistics", "/targets", "/projects", "/files", "/terminal", "/git", "/processes", "/agents", "/jobs", "/github", "/control-center", "/security", "/audit-evidence", "/recovery-backups", "/settings", "/tool-lab"].includes(pathname) ? identity.projectionEpoch : pathname}>{pathname === "/overview" ? <TrustRibbon /> : null}{children}</main><footer className="page-footer">QuaranGate · Product candidate <span>Product authority is enforced by the server. Completed does not mean applied.</span></footer>
    </div>
  </div>;
}
