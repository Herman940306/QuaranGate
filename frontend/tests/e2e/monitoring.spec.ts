import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
async function mockMcp(page: Page) {
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON();
    if (request.params.name !== "control_center_query") throw new Error("Unexpected tool");
    const view = request.params.arguments.view;
    const data = view === "summary" ? { gateway: { ready: true }, targets: { running: 1 }, executor: { dockerReachable: true } }
      : view === "providers" ? { activeJobs: 1, queuedJobs: 2, sessionContinuity: "DEFERRED" }
      : view === "topology" ? { gateway: { network: "edge+internal" }, executor: { network: "internal" } }
      : { matrix: [{ component: "Monitoring telemetry", configured: false, implementation: "NO_PUBLIC_CONTRACT", productionQualification: "NOT_QUALIFIED", toolUse: "METADATA_ONLY", sessionResume: "NOT_APPLICABLE" }] };
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: { structuredContent: { view, generatedAt: "2026-09-26T10:00:00Z", data } } } });
  });
}
for (const width of [1280, 360]) {
  test(`FE10 Monitoring stays metadata-only at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await mockMcp(page); await page.goto("/monitoring");
    for (const name of ["Read runtime summary", "Read provider aggregates", "Read topology", "Read capabilities"]) await page.getByRole("button", { name }).click();
    await expect(page.getByRole("table", { name: "Runtime summary metadata" })).toContainText("dockerReachable");
    await expect(page.getByRole("table", { name: "Provider aggregate metadata" })).toContainText("DEFERRED");
    await expect(page.getByRole("table", { name: "Capability metadata" })).toContainText("NO_PUBLIC_CONTRACT");
    await expect(page.getByText(/no accepted hardware telemetry/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /start telemetry|enable probe|stream logs/i })).toHaveCount(0);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, search: location.search, hash: location.hash }))).toEqual({ local: 0, session: 0, search: "", hash: "" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
