import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
const jobId = `job_${"a".repeat(32)}`;
async function mockMcp(page: Page, mode: "success" | "forbidden" | "unavailable" = "success") {
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON();
    if (mode !== "success") { await route.fulfill({ status: mode === "forbidden" ? 403 : 503, body: "private error stack" }); return; }
    const name = request.params.name;
    const view = request.params.arguments.view;
    let data: unknown;
    if (name === "control_center_query") data = { view, generatedAt: new Date().toISOString(), data: view === "providers" ? { activeJobs: 1, queuedJobs: 2, sessionContinuity: "DEFERRED" } : { principal: { id: "principal-demo", name: "Demo principal", scopes: ["targets:read"] }, targets: { visible: 1, running: 1 }, executor: { dockerReachable: true } } };
    else if (name === "targets_list") data = { targets: [{ id: "demo", name: "Demo target", source: "manual", running: true }] };
    else if (name === "target_inspect") data = { id: "demo", running: true, source: "manual" };
    else if (name === "agent_status") data = { jobId, status: "COMPLETED", createdAt: "2026-09-26T00:00:00Z" };
    else if (name === "agent_result") data = { jobId, status: "COMPLETED", backend: "kiro", project: "demo", profile: "audit", summary: "PRIVATE PROVIDER OUTPUT" };
    else if (name === "agent_diff") data = { jobId, diffHash: "a".repeat(64), chunk: "<script>untrusted evidence</script>", chunkBytes: 35, totalBytes: 35, truncated: false, applicable: false };
    else if (name.startsWith("git_")) data = { exitCode: 1, timedOut: true, truncated: true, stdout: "partial stdout", stderr: "bounded stderr", durationMs: 1000 };
    else if (name === "agent_projects") data = { projects: [{ id: "demo", gitRequired: true, allowedBackends: ["kiro"], allowedProfiles: ["audit"] }] };
    else if (name === "agents_list") data = { backends: [{ id: "kiro", available: false, profiles: ["audit"] }] };
    else if (name === "github_repositories") data = { repositories: [{ repository: "org/repo", owner: "org", private: true, archived: false }] };
    else throw new Error(`Unexpected tool ${name}`);
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: { structuredContent: data } }, headers: { "X-QuaranGate-Request-Id": "12345678-1234-1234-1234-123456789abc" } });
  });
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1); }
async function axe(page: Page) { expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); }
for (const width of [1280, 360]) {
  test(`overview and targets are truthful and accessible at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await mockMcp(page); await page.goto("/overview");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByText("Not connected. Choose a read operation to check the connection.").first()).toBeVisible();
    await page.getByRole("button", { name: "Read overview", exact: true }).click(); await expect(page.getByRole("table", { name: "Overview metadata" })).toContainText("principal-demo");
    await page.getByRole("button", { name: "Read provider state" }).click(); await expect(page.getByRole("table", { name: "Provider metadata" })).toContainText("DEFERRED");
    await page.getByLabel("Mode").selectOption("dark"); await expect(page.locator("html")).toHaveAttribute("data-mode", "dark"); await noOverflow(page); await axe(page);
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: `test-results/fe1-overview-${width}.png`, fullPage: true });
    await page.goto("/targets"); await page.getByRole("button", { name: "Read targets", exact: true }).click(); await expect(page.getByRole("table", { name: "Targets", exact: true })).toContainText("UNKNOWN");
    await page.getByLabel("Logical target ID", { exact: true }).fill("demo"); await page.getByRole("button", { name: "Inspect target" }).click(); await expect(page.getByRole("table", { name: "Target detail" })).toContainText("UNKNOWN");
    await noOverflow(page); await axe(page); await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: `test-results/fe1-targets-${width}.png`, fullPage: true });
  });
}
test("known-job lookup preserves completion, safe evidence and no discovery", async ({ page }) => {
  await mockMcp(page); await page.goto("/jobs");
  await expect(page.getByText("Job discovery/listing is not available in the current backend contract.")).toBeVisible();
  await page.getByLabel("Known job ID", { exact: true }).fill(jobId); await page.getByRole("button", { name: "Look up job" }).click(); await expect(page.getByRole("table", { name: "Job status" })).toContainText("COMPLETED");
  await expect(page.getByRole("table", { name: "Job status" })).not.toContainText("APPLIED");
  await page.getByRole("button", { name: "Read result metadata" }).click(); await expect(page.getByRole("table", { name: "Result metadata" })).toContainText("COMPLETED"); await expect(page.getByText("PRIVATE PROVIDER OUTPUT")).toHaveCount(0);
  await page.getByRole("button", { name: "Read bounded diff" }).click(); await expect(page.getByText("<script>untrusted evidence</script>", { exact: true })).toBeVisible(); await expect(page.locator(".machine script")).toHaveCount(0); await axe(page);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 }); expect(page.url()).not.toContain(jobId);
});
for (const mode of ["forbidden", "unavailable"] as const) {
  test(`${mode} is explicit and does not leak backend copy`, async ({ page }) => { await mockMcp(page, mode); await page.goto("/overview"); await page.getByRole("button", { name: "Read overview", exact: true }).click(); await expect(page.getByText(mode === "forbidden" ? "The server denied this read. Current authority does not permit it." : "The operational service is unavailable. Retry when it is reachable.")).toBeVisible(); await expect(page.getByText("private error stack")).toHaveCount(0); await axe(page); });
}
test("keyboard navigation, reduced motion and appearance survive product navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/overview"); await page.keyboard.press("Tab"); await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByLabel("Palette").selectOption("delft"); await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Targets", exact: true }).click(); await expect(page.locator("html")).toHaveAttribute("data-palette", "delft");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
});
test("Git failure/truncation, backend availability and GitHub authority stay distinct", async ({ page }) => {
  await mockMcp(page); await page.goto("/git"); await page.getByLabel("Logical target ID").fill("demo"); await page.getByRole("button", { name: "Read Git diff statistics" }).click(); await expect(page.getByText("Command failed or outcome unknown · output truncated")).toBeVisible(); await expect(page.getByText("bounded stderr", { exact: true })).toBeVisible();
  await page.goto("/projects"); await page.getByRole("button", { name: "Read projects" }).click(); await expect(page.getByRole("table", { name: "Agent projects" })).toContainText("demo");
  await page.goto("/agents"); await page.getByRole("button", { name: "Read backends" }).click(); await expect(page.getByRole("table", { name: "Agent backends" })).toContainText("Unavailable / deferred");
  await page.goto("/github"); await page.getByRole("button", { name: "Read repositories" }).click(); await expect(page.getByRole("table", { name: "Governed repositories" })).toContainText("org/repo"); await expect(page.getByText(/Read availability grants no write or review authority/)).toBeVisible();
});
test("Control Center and Security views remain metadata-only with generated time", async ({ page }) => {
  await mockMcp(page); await page.goto("/control-center");
  for (const view of ["summary", "authority", "topology", "providers", "capabilities", "recovery"]) {
    await page.getByRole("button", { name: `Read ${view}`, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Read completed" })).toHaveCount(["summary", "authority", "topology", "providers", "capabilities", "recovery"].indexOf(view) + 1);
  }
  await expect(page.getByText(/Generated:/).first()).toBeVisible(); await axe(page);
  await page.goto("/security"); await page.getByRole("button", { name: "Read authority", exact: true }).click(); await expect(page.getByRole("table", { name: "authority metadata" })).toContainText("principal-demo"); await axe(page);
});
test("cancelled reads reject late output", async ({ page }) => {
  let resolveRequest: (() => void) | undefined;
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON();
    await new Promise<void>(resolve => { resolveRequest = resolve; });
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: { structuredContent: { jobId, status: "COMPLETED", createdAt: "now" } } } }).catch(() => undefined);
  });
  await page.goto("/jobs"); await page.getByLabel("Known job ID").fill(jobId); await page.getByRole("button", { name: "Look up job" }).click(); await expect(page.getByText("Reading server state")).toBeVisible();
  await page.getByRole("button", { name: "Cancel read" }).click(); resolveRequest?.(); await expect(page.getByText("Read cancelled. No new result was accepted.")).toBeVisible(); await expect(page.getByRole("table", { name: "Job status" })).toHaveCount(0);
});
