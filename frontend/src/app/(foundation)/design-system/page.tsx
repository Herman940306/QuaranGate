import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppearanceControls } from "../../../components/appearance-controls";
import { DesignExamples } from "../../../components/design-examples";
import { MotionSample } from "../../../components/motion-sample";
import { Badge, EmptyState, ErrorState, LoadingState, MachineOutput, Panel, PermissionExplanation, Table } from "../../../components/primitives";
export const metadata: Metadata = { title: "Design System" };
const roles = ["canvas", "surface", "surface-muted", "rail", "ink", "muted", "primary", "focus", "verified", "attention", "destructive", "machine", "boundary"];
export default function DesignSystemPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <><div className="page-heading"><div><p className="eyebrow">ENGINEERING / COMPONENT REVIEW</p><h1>Design System</h1><p className="page-intro">All examples are design fixtures. No status represents a real user, service, or security result.</p></div><Badge>Development only</Badge></div>
    <Panel title="Appearance"><AppearanceControls /></Panel>
    <Panel title="Semantic color"><div className="swatches">{roles.map(role => <div key={role}><span style={{ background: `var(--${role})` }} /><code>{role}</code></div>)}</div></Panel>
    <Panel title="Typography"><h3 className="type-display">Precision Engineering Test Bench</h3><p>IBM Plex Sans · Clear controls, measured hierarchy, legible detail.</p><p className="mono">IBM Plex Mono · DESIGN / evidence_id / 0123456789</p></Panel>
    <div className="review-grid"><DesignExamples /></div>
    <Panel title="Motion categories"><MotionSample /></Panel>
    <div className="review-grid"><Panel title="Loading"><LoadingState label="DESIGN · Loading example" /></Panel><Panel title="Empty"><EmptyState title="DESIGN · No items">There are no items in this example.</EmptyState></Panel><Panel title="Error"><ErrorState category="unavailable" /></Panel><Panel title="Permission explanations"><PermissionExplanation state="unknown" reason="DESIGN · Current eligibility cannot be established." /><PermissionExplanation state="denied" reason="DESIGN · Example of a server-denied operation." /></Panel></div>
    <Panel title="Technical surfaces"><MachineOutput label="DESIGN · inert machine-output example">{'<script>example only</script>\nCOMPLETED != APPLIED\nNo operational evidence connected.'}</MachineOutput><Table caption="DESIGN · Component review inventory" headings={["Primitive", "Ownership", "Purpose"]} rows={[
      { id: "overlay", cells: { Primitive: "Dialog / Drawer", Ownership: "Shared overlay provider", Purpose: "Focus trap and restoration" } },
      { id: "select", cells: { Primitive: "Select", Ownership: "Native control", Purpose: "Platform keyboard interaction" } },
      { id: "appearance", cells: { Primitive: "Appearance", Ownership: "Page-memory adapter", Purpose: "No account persistence in F1" } },
    ]} /></Panel>
  </>;
}
