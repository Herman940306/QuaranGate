"use client";
import { useState } from "react";
import { Button, IconButton, Input, Textarea, Select, Panel, Badge, PermissionExplanation } from "./primitives";
import { useOverlay } from "./overlays";
import { Tabs } from "./tabs";
export function DesignExamples() {
  const overlay = useOverlay();
  const [error, setError] = useState("");
  return <>
    <Panel title="Controls"><div className="cluster"><Button emphasis="solid" intent="primary" onClick={() => overlay.notify("Design example activated. No operation was performed.")}>Primary action</Button><Button onClick={() => overlay.notify("Secondary design example activated.")}>Secondary</Button><Button emphasis="ghost" onClick={() => overlay.notify("Quiet design example activated.")}>Quiet action</Button><Button disabled>Unavailable</Button><Button disabled busy>Processing</Button><IconButton label="Example information" onClick={() => overlay.notify("This is a design example.")}>i</IconButton></div><div className="cluster"><Badge tone="verified">DESIGN · Verified</Badge><Badge tone="attention">DESIGN · Attention</Badge><Badge tone="destructive">DESIGN · Denied</Badge><Badge>DESIGN · Unknown</Badge></div></Panel>
    <Panel title="Fields and validation"><form noValidate onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const input = form.elements.namedItem("sample-name") as HTMLInputElement; if (!input.value.trim()) { setError("Enter a name for this example."); input.focus(); } else { setError(""); overlay.notify("Design form validated. Nothing was saved."); } }}>
      <div className="form-grid"><Input id="sample-name" name="sample-name" label="Example name" help="Design data only. This form does not save." error={error} required autoComplete="off" /><Select id="sample-select" label="Example selection" defaultValue="read"><option value="read">Read</option><option value="write">Write</option><option value="execution">Execution</option></Select></div>
      <Textarea id="sample-notes" className="resize-none" label="Example notes" help="Local form state only. Long text scrolls inside this field." /><Button type="submit" emphasis="solid" intent="primary">Validate example</Button>
    </form></Panel>
    <Panel title="Overlays and feedback"><div className="cluster"><Button onClick={() => overlay.open({ title: "Example dialog", description: "Design demonstration only. No backend action is connected.", children: <><Input id="dialog-name" label="Example field" /><Button onClick={() => { overlay.close(); overlay.notify("Example dialog closed. No changes were applied."); }}>Finish example</Button></> })}>Open dialog</Button><Button onClick={() => overlay.open({ title: "Example drawer", description: "Design demonstration of a bounded detail panel.", kind: "drawer", children: <PermissionExplanation state="unknown" reason="This example has no server-derived eligibility." /> })}>Open drawer</Button><Button onClick={() => overlay.notify("Example notification. No operational result is implied.")}>Show notification</Button></div></Panel>
    <Panel title="Tabs"><Tabs label="State examples" items={[{ label: "Context", content: <p>Design example · context remains visible before an action.</p> }, { label: "Evidence", content: <p>No operational evidence is connected to this foundation.</p> }, { label: "Authority", content: <p>Completed does not mean applied. A UI state never grants authority.</p> }]} /></Panel>
  </>;
}
