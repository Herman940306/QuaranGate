import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
async function mock(page: Page, failure = false) {
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON();
    expect(request.params.name).toBe("control_center_query");
    if (failure) { await route.fulfill({ status: 503, body: "private data" }); return; }
    const args = request.params.arguments;
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: { structuredContent: { view: args.view, generatedAt: new Date().toISOString(), data: { principal: { id: "principal-safe", name: "Safe principal", scopes: ["targets:read"], targets: ["demo"], projects: [], agentBackends: [], agentProfiles: [], githubAccounts: [], githubProjects: [] }, preflight: args.tool ? { evaluated: true, allowed: false, requiredScope: "terminal:exec", reason: "Missing execution scope" } : { evaluated: false } } } } } });
  });
}
for (const width of [1280, 360]) test(`FE12 server authority and advisory denial at ${width}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 }); await mock(page); await page.goto("/security"); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Read authority", exact: true }).click();
  await expect(page.getByRole("table", { name: "authority metadata" })).toContainText("principal-safe");
  await page.getByLabel("Operation to explain").selectOption("terminal_exec");
  await page.getByLabel("Optional target", { exact: true }).selectOption("demo");
  await page.getByRole("button", { name: "Read advisory preflight" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("table", { name: "Preflight result" })).toContainText("DENIED");
  await expect(page.getByText(/Runtime state and operation-specific server checks may still deny/)).toBeVisible();
  await expect(page.getByText(/Session identity is not authorization/)).toBeVisible();
  await expect(page.getByRole("button", { name: /execute|apply|grant|escalate/i })).toHaveCount(0);
  await page.getByLabel("Operation to explain").selectOption("agent_apply");
  await expect(page.getByRole("table", { name: "Preflight result" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }))).toEqual({ local: 0, session: 0, cookies: "" });
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath(`fe12-${width}.png`), fullPage: true });
});
test("FE12 unavailable authority remains closed", async ({ page }) => {
  await mock(page, true); await page.goto("/security"); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Read authority", exact: true }).click();
  await expect(page.getByText("The operational service is unavailable. Retry when it is reachable.")).toBeVisible();
  await expect(page.getByLabel("Operation to explain")).toHaveCount(0); await expect(page.getByText("private data")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
