import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createMemoryAppearanceAdapter, defaultAppearance, parseAppearance } from "../../src/lib/appearance";
import { errorCopy } from "../../src/lib/errors";
import { motionSpring, transitionFor } from "../../src/lib/motion";
import { Badge, Input, MachineOutput, PermissionExplanation, Table } from "../../src/components/primitives";

describe("appearance contract", () => {
  it("fails closed to approved defaults", () => {
    expect(parseAppearance({ mode: "laser", palette: "unknown", density: "tiny" })).toEqual(defaultAppearance);
  });

  it("keeps temporary preferences in page memory only", () => {
    const first = createMemoryAppearanceAdapter();
    first.write({ mode: "dark", palette: "delft", density: "compact" });
    expect(first.read()).toEqual({ mode: "dark", palette: "delft", density: "compact" });
    expect(createMemoryAppearanceAdapter().read()).toEqual(defaultAppearance);
  });
});

describe("motion and error contracts", () => {
  it("centralizes the four approved motion categories", () => {
    expect(Object.keys(motionSpring)).toEqual(["press", "control", "panel", "layout"]);
    expect(transitionFor("panel", true)).toEqual({ duration: 0 });
  });

  it("includes fail-closed status language", () => {
    expect(errorCopy.timeout).toContain("outcome is unknown");
    expect(errorCopy.authorization).toContain("not permitted");
  });
});

describe("server-safe primitives", () => {
  it("renders associated field errors", () => {
    const html = renderToStaticMarkup(<Input id="name" label="Name" help="Required" error="Enter a name" />);
    expect(html).toContain('for="name"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="name-help name-error"');
  });

  it("renders status with text and a truthful authority explanation", () => {
    const html = renderToStaticMarkup(<><Badge tone="destructive">Denied</Badge><PermissionExplanation state="unknown" reason="Eligibility has not been checked." /></>);
    expect(html).toContain("Denied");
    expect(html).toContain("Eligibility unknown");
    expect(html).toContain("never grants permission");
  });

  it("escapes machine output and keeps semantic table structure", () => {
    const output = renderToStaticMarkup(<MachineOutput label="Output">{"<script>alert(1)</script>"}</MachineOutput>);
    expect(output).toContain("&lt;script&gt;");
    expect(output).not.toContain("<script>");
    const table = renderToStaticMarkup(<Table caption="Inventory" headings={["Name"]} rows={[{ id: "example", cells: { Name: "Example" } }]} />);
    expect(table).toContain("<caption>Inventory</caption>");
    expect(table).toContain('scope="col"');
  });
});
