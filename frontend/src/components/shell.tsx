"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useOverlay } from "./overlays";
import { OperationalProvider, useOperational } from "./operational-provider";
import { Badge, IconButton } from "./primitives";

function Navigation({ engineering, onNavigate }: { engineering: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return <nav aria-label="Main navigation"><Link href="/" aria-current={pathname === "/" ? "page" : undefined} onClick={onNavigate}>Foundation</Link>{[["/overview", "Overview"], ["/targets", "Targets"], ["/projects", "Projects"], ["/agents", "Agents"], ["/jobs", "Jobs"], ["/git", "Git"], ["/github", "GitHub"], ["/control-center", "Control Center"], ["/security", "Security & Access"]].map(([href, label]) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} onClick={onNavigate}>{label}</Link>)}{engineering ? <Link href="/design-system" aria-current={pathname === "/design-system" ? "page" : undefined} onClick={onNavigate}>Design System <span>DEV</span></Link> : null}</nav>;
}
export function Shell({ children, engineering }: { children: ReactNode; engineering: boolean }) {
  return <OperationalProvider><ShellBody engineering={engineering}>{children}</ShellBody></OperationalProvider>;
}
function ShellBody({ children, engineering }: { children: ReactNode; engineering: boolean }) {
  const overlay = useOverlay();
  const { state } = useOperational();
  return <div className="shell"><a className="skip-link" href="#main">Skip to content</a>
    <aside className="rail"><Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">Q</span><span>QuaranGate<small>ENGINEERING WORKSPACE</small></span></Link><p className="rail-label">PRODUCT FOUNDATION</p><Navigation engineering={engineering} /><div className="rail-foot"><span className="rail-label">AUTHORITY BOUNDARY</span><p>Read surfaces only.<br />Server authority applies.</p><span className="rail-version">FE1 · Source candidate</span></div></aside>
    <div className="workspace"><header className="command-bar"><div className="header-context"><span className="narrow-menu"><IconButton label="Open navigation" onClick={() => overlay.open({ title: "Navigation", description: "QuaranGate foundation routes", kind: "drawer", closeOnDesktop: true, children: <Navigation engineering={engineering} onNavigate={overlay.close} /> })}>☰</IconButton></span><span className="context-label">Workspace<small>Foundation placeholder</small></span></div><div className="account-context"><Badge>{state === "available" ? "Last read connected" : state.replaceAll("_", " ")}</Badge><span className="context-label">Account<small>Not configured</small></span></div></header>
      <main id="main" tabIndex={-1}>{children}</main><footer className="page-footer">QuaranGate · Product candidate <span>Product authority is enforced by the server.</span></footer>
    </div>
  </div>;
}
