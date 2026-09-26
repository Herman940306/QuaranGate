import type { Metadata } from "next";
import { AppearanceControls } from "../../components/appearance-controls";
import { Badge, EmptyState, MachineOutput, Panel, PermissionExplanation } from "../../components/primitives";
export const metadata: Metadata = { title: "Foundation" };
export default function FoundationPage() {
  return <><div className="page-heading"><div><p className="eyebrow">PRODUCT SYSTEM / F1</p><h1>A foundation for<br />governed engineering.</h1><p className="page-intro">The workspace shell, appearance system, and interaction foundations. Operational services are not connected.</p></div><Badge>Foundation preview</Badge></div>
    <div className="authority-strip"><span className="authority-label">CURRENT BOUNDARY</span><strong>Interface foundation</strong><span>Identity unavailable</span><span>Operations unavailable</span></div>
    <div className="foundation-grid"><Panel title="Your workspace appearance"><p className="muted">Choose a working surface that suits you.</p><AppearanceControls /></Panel><Panel title="Account and workspace"><EmptyState title="Identity is not connected">Account and workspace context are placeholders in this foundation.</EmptyState></Panel></div>
    <div className="foundation-grid"><Panel title="Authority stays explicit"><PermissionExplanation state="not_implemented" reason="This foundation cannot invoke MCP tools, change files, or operate infrastructure." /></Panel><Panel title="Machine-output surface"><MachineOutput label="DESIGN EXAMPLE · no runtime data">{"interface: foundation\nconnection: not configured\noperational authority: unavailable"}</MachineOutput></Panel></div>
  </>;
}
