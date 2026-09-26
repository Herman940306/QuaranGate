import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function mockMcp(page: Page) {
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON();
    expect(request.params.name).toBe("control_center_query");
    expect(request.params.arguments.view).toBe("statistics");
    const sinceMs = request.params.arguments.sinceMs;
    await route.fulfill({ json: {
      jsonrpc: "2.0", id: request.id,
      result: { structuredContent: {
        view: "statistics", generatedAt: "2026-09-26T10:00:00Z",
        data: {
          activity: { retained: 23, windowMs: sinceMs, total: 15, allowed: 12, denied: 3, failures: 2, p50Ms: 18, p95Ms: 77, topTools: [{ tool: "control_center_query", count: 9 }, { tool: "targets_list", count: 6 }] },
          jobs: { active: 1, queued: null },
          targets: { visible: 4, running: 3 },
          backends: { visible: 3, available: 2 },
        },
      } },
    } });
  });
}

for (const width of [1280, 360]) {
  test(`FE11 Statistics stays bounded and snapshot-only at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockMcp(page);
    await page.goto("/statistics");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Statistics", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Read statistics" }).click();
    await expect(page.getByRole("table", { name: "Activity statistics" })).toContainText("15");
    await expect(page.getByRole("table", { name: "Runtime statistics" })).toContainText("UNKNOWN");
    await expect(page.getByRole("table", { name: "Top tools" })).toContainText("control_center_query");
    await expect(page.getByText(/not durable analytics or a historical trend service/i)).toBeVisible();
    await expect(page.getByText(/no accepted durable 24h\/7d\/30d analytics/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /export|trend|billing|cost|refresh history/i })).toHaveCount(0);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, search: location.search, hash: location.hash }))).toEqual({ local: 0, session: 0, search: "", hash: "" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test("FE11 changes only the bounded current window", async ({ page }) => {
  await mockMcp(page);
  await page.goto("/statistics");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("table", { name: "Activity statistics" })).toContainText("1 hour");
  const nextSnapshot = page.waitForRequest(request => request.url().endsWith("/mcp") && request.postDataJSON().params.arguments.sinceMs === 6 * 60 * 60 * 1000);
  await page.getByLabel("Current in-memory window").selectOption(String(6 * 60 * 60 * 1000));
  await nextSnapshot;
  await expect(page.getByRole("table", { name: "Activity statistics" })).toContainText("6 hours");
});

test("FE11 hides the old window when the new snapshot is unavailable", async ({ page }) => {
  await mockMcp(page);
  await page.goto("/statistics");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("table", { name: "Activity statistics" })).toBeVisible();
  await page.route("**/mcp", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.getByLabel("Current in-memory window").selectOption(String(6 * 60 * 60 * 1000));
  await expect(page.getByRole("table", { name: "Activity statistics" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "unavailable" })).toBeVisible();
});
