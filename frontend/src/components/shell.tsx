"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { IdentityClient } from "../lib/identity/contracts";
import { IdentityProvider, useIdentity } from "./identity-provider";
import { useOverlay } from "./overlays";
import { OperationalProvider, useOperational } from "./operational-provider";
import { Badge, IconButton } from "./primitives";

function Navigation({ engineering, onNavigate }: { engineering: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return <nav aria-label="Main navigation"><Link href="/" aria-current={pathname === "/" ? "page" : undefined} onClick={onNavigate}>Foundation</Link>{[["/overview", "Overview"], ["/targets", "Targets"], ["/projects", "Projects"], ["/files", "Files"], ["/terminal", "Terminal"], ["/git", "Git"], ["/processes", "Processes"], ["/agents", "Agents"], ["/providers", "Providers"], ["/agent-profiles", "Agent Profiles"], ["/jobs", "Jobs"], ["/github", "GitHub"], ["/control-center", "Control Center"], ["/security", "Security & Access"], ["/account", "Account"], ["/workspaces", "Workspaces"], ["/permissions", "Product permissions"], ["/sign-in", "Sign in"]].map(([href, label]) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} onClick={onNavigate}>{label}</Link>)}{engineering ? <Link href="/design-system" aria-current={pathname === "/design-system" ? "page" : undefined} onClick={onNavigate}>Design System <span>DEV</span></Link> : null}</nav>;
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
  return <div className="shell"><a className="skip-link" href="#main">Skip to content</a>
    <aside className="rail"><Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">Q</span><span>QuaranGate<small>ENGINEERING WORKSPACE</small></span></Link><p className="rail-label">PRODUCT FOUNDATION</p><Navigation engineering={engineering} /><div className="rail-foot"><span className="rail-label">AUTHORITY BOUNDARY</span><p>Server authority applies to every operation.</p><span className="rail-version">Product integration pending</span></div></aside>
    <div className="workspace"><header className="command-bar"><div className="header-context"><span className="narrow-menu"><IconButton label="Open navigation" onClick={() => overlay.open({ title: "Navigation", description: "QuaranGate foundation routes", kind: "drawer", closeOnDesktop: true, children: <Navigation engineering={engineering} onNavigate={overlay.close} /> })}>☰</IconButton></span><Link href="/workspaces" className="context-label">Workspace<small>{session?.workspace.name ?? "No verified workspace"}</small></Link></div><div className="account-context"><Badge>{state === "available" ? "Last read connected" : state.replaceAll("_", " ")}</Badge><Link href="/account" className="context-label">Account<small>{session?.user.displayName ?? (identity.integrated ? identity.state.kind.replaceAll("_", " ") : "Identity integration pending")}</small></Link></div></header>
      <main id="main" tabIndex={-1} key={["/overview", "/targets", "/projects", "/files", "/terminal", "/git", "/processes", "/agents", "/jobs", "/github", "/control-center", "/security"].includes(pathname) ? identity.projectionEpoch : pathname}>{children}</main><footer className="page-footer">QuaranGate · Product candidate <span>Product authority is enforced by the server.</span></footer>
    </div>
  </div>;
}
