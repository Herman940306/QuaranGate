"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useOverlay } from "./overlays";
import { Badge, IconButton } from "./primitives";

function Navigation({ engineering, onNavigate }: { engineering: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return <nav aria-label="Main navigation"><Link href="/" aria-current={pathname === "/" ? "page" : undefined} onClick={onNavigate}>Foundation</Link>{engineering ? <Link href="/design-system" aria-current={pathname === "/design-system" ? "page" : undefined} onClick={onNavigate}>Design System <span>DEV</span></Link> : null}</nav>;
}
export function Shell({ children, engineering }: { children: ReactNode; engineering: boolean }) {
  const overlay = useOverlay();
  return <div className="shell"><a className="skip-link" href="#main">Skip to content</a>
    <aside className="rail"><Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">Q</span><span>QuaranGate<small>ENGINEERING WORKSPACE</small></span></Link><p className="rail-label">PRODUCT FOUNDATION</p><Navigation engineering={engineering} /><div className="rail-foot"><span className="rail-label">AUTHORITY BOUNDARY</span><p>Interface only.<br />No operational connection.</p><span className="rail-version">F1 · Local foundation</span></div></aside>
    <div className="workspace"><header className="command-bar"><div className="header-context"><span className="narrow-menu"><IconButton label="Open navigation" onClick={() => overlay.open({ title: "Navigation", description: "QuaranGate foundation routes", kind: "drawer", closeOnDesktop: true, children: <Navigation engineering={engineering} onNavigate={overlay.close} /> })}>☰</IconButton></span><span className="context-label">Workspace<small>Foundation placeholder</small></span></div><div className="account-context"><Badge>Not connected</Badge><span className="context-label">Account<small>Not configured</small></span></div></header>
      <main id="main" tabIndex={-1}>{children}</main><footer className="page-footer">QuaranGate · Foundation preview <span>Product authority is enforced by the server.</span></footer>
    </div>
  </div>;
}
