import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function mockMcp(page: Page) {
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON();
    const { name, arguments: args } = request.params;
    const data: Record<string, unknown> = name === "targets_list" ? { targets: [{ id: "demo", name: "Demo target", source: "manual", running: true }] }
      : name === "fs_list" ? { entries: ["src/", "README.md"] }
      : name === "fs_stat" ? { path: args.path, type: "file", size: 12, mode: "0644", mtime: "2026-09-26T00:00:00Z" }
      : name === "fs_read" ? { path: args.path, bytes: 12, content: "sample <script>" }
      : name === "fs_search" ? { matches: ["README.md:1:sample <script>"] }
      : name === "process_list" ? { exitCode: 0, stdout: "PID COMMAND\n1 init", stderr: "", truncated: false, timedOut: false, durationMs: 20 }
      : {};
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: { structuredContent: data } }, headers: { "X-QuaranGate-Request-Id": "12345678-1234-1234-1234-123456789abc" } });
  });
}
for (const width of [1280, 360]) {
  test(`FE4 files and processes respect read and identity boundaries at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await mockMcp(page); await page.goto("/files"); await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Load targets" }).click(); await page.getByLabel("Target", { exact: true }).selectOption("demo");
    await page.getByRole("button", { name: "List entries" }).click();
    await expect(page.getByRole("list", { name: "Directory entries" })).toContainText("README.md");
    await page.getByRole("button", { name: "Select path" }).last().click();
    await page.getByRole("button", { name: "Read file" }).click();
    await expect(page.getByText("sample <script>", { exact: true })).toBeVisible();
    await expect(page.locator(".machine script")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit file write" })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.goto("/processes"); await page.waitForLoadState("networkidle"); await page.getByRole("button", { name: "Load targets" }).click(); await page.getByLabel("Target", { exact: true }).selectOption("demo");
    await page.getByRole("button", { name: "Read processes" }).click(); await expect(page.getByText("PID COMMAND\n1 init")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
test("FE4 terminal and target control stay gated without product identity", async ({ page }) => {
  await mockMcp(page); await page.goto("/terminal"); await page.waitForLoadState("networkidle"); await page.getByRole("button", { name: "Load targets" }).click(); await page.getByLabel("Target", { exact: true }).selectOption("demo");
  await page.getByLabel("Command", { exact: true }).fill("echo ready"); await expect(page.getByRole("button", { name: "Run command" })).toBeDisabled();
  await page.goto("/targets"); await page.waitForLoadState("networkidle"); await page.getByRole("button", { name: "Load targets" }).click(); await page.getByLabel("Target", { exact: true }).selectOption("demo");
  await page.getByLabel("Type start demo to confirm").fill("start demo"); await expect(page.getByRole("button", { name: "Submit start" })).toBeDisabled();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});
