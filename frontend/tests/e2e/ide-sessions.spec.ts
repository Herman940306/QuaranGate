import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function mockMcp(page: Page) {
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON();
    if (request.params.name !== "control_center_query") throw new Error("Unexpected tool");
    const view = request.params.arguments.view;
    const data = view === "summary"
      ? { capabilityState: { ideSessionControl: "AVAILABLE_NOT_LIVE_QUALIFIED" } }
      : { matrix: [
          { component: "VS Code", configured: true, implementation: "SOURCE_CLOSED", productionQualification: "LIVE_REVERIFICATION_IN_PROGRESS", toolUse: "QUARANGATE_GOVERNED_REVIEW", sessionResume: "SOURCE_IMPLEMENTED_LIVE_OPEN" },
          { component: "Cursor", configured: true, implementation: "SOURCE_CLOSED", productionQualification: "LIVE_BLOCKED", toolUse: "QUARANGATE_GOVERNED_REVIEW", sessionResume: "SOURCE_IMPLEMENTED_LIVE_BLOCKED" },
        ] };
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: { structuredContent: { view, generatedAt: "2026-09-26T09:30:00Z", data } } } });
  });
}
async function axe(page: Page) { expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); }

for (const width of [1280, 360]) {
  test(`FE7 IDE Session Center stays metadata-only at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockMcp(page);
    await page.goto("/ide-sessions");
    await page.getByRole("button", { name: "Read IDE readiness" }).click();
    await expect(page.getByRole("table", { name: "IDE control readiness" })).toContainText("AVAILABLE_NOT_LIVE_QUALIFIED");
    await page.getByRole("button", { name: "Read IDE adapter qualification" }).click();
    const table = page.getByRole("table", { name: "IDE adapter qualification" });
    await expect(table).toContainText("VS Code");
    await expect(table).toContainText("Cursor");
    await expect(page.getByText(/no public MCP\/HTTP session discovery or control route/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /acquire|start review|cancel session|request implementation/i })).toHaveCount(0);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, search: location.search, hash: location.hash }))).toEqual({ local: 0, session: 0, search: "", hash: "" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await axe(page);
  });
}
