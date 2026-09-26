import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const jobId = `job_${"a".repeat(32)}`;
async function mockMcp(page: Page) {
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON();
    const data = request.params.name === "agent_projects" ? { projects: [{ id: "demo", gitRequired: true, allowedBackends: ["kiro"], allowedProfiles: ["review"] }] }
      : request.params.name === "agents_list" ? { backends: [{ id: "kiro", available: true, profiles: ["review"] }] }
      : request.params.name === "agent_status" ? { jobId, status: "COMPLETED", createdAt: "2026-09-26T00:00:00Z", completedAt: "2026-09-26T00:01:00Z" }
      : request.params.name === "agent_result" ? { jobId, status: "COMPLETED", project: "demo", backend: "kiro", profile: "review", summary: "Review complete · no changes applied", changedFiles: [] }
      : request.params.name === "agent_diff" ? { jobId, diffHash: "b".repeat(64), chunk: "<script>untrusted diff</script>", chunkBytes: 31, totalBytes: 31, truncated: false, applicable: true, contentComplete: true }
      : {};
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: { structuredContent: data } } });
  });
}
for (const width of [1280, 360]) {
  test(`Agent Arena is responsive and honest at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await mockMcp(page); await page.goto("/arena"); await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Agent Arena" })).toBeVisible();
    if (width === 360) await page.getByRole("button", { name: /Configure agent/ }).click();
    await expect(page.getByText("Product Agent Profile integration pending.")).toBeVisible();
    await page.getByRole("button", { name: "Load current options" }).click();
    await page.getByLabel("Project", { exact: true }).selectOption("demo"); await page.getByLabel("Backend", { exact: true }).selectOption("kiro");
    await page.getByLabel("Work request").fill("Review the change"); await expect(page.getByRole("button", { name: "Dispatch request" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Voice input unavailable" })).toBeDisabled();
    await page.getByLabel("Known job ID").fill(jobId);
    await expect(page.getByText("Lifecycle:")).toContainText("COMPLETED");
    await page.getByRole("button", { name: "Read result" }).click(); await expect(page.getByText("Review complete · no changes applied")).toBeVisible();
    await page.getByRole("button", { name: "Read bounded diff" }).click(); await expect(page.getByText("<script>untrusted diff</script>", { exact: true })).toBeVisible();
    await expect(page.locator(".machine script")).toHaveCount(0);
    await page.getByRole("button", { name: "Apply", exact: true }).click(); await page.getByLabel(`Type apply ${jobId} to confirm`).fill(`apply ${jobId}`);
    await expect(page.getByRole("button", { name: "Submit apply" })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: `test-results/fe5-arena-${width}.png`, fullPage: true });
  });
}

test("synthetic Arena dispatch, review and explicit apply remain separate", async ({ page }) => {
  let applied = false; const sent: string[] = []; const prompts: string[] = [];
  await page.route("**/mcp", async route => {
    const request = route.request().postDataJSON(); const name = request.params.name as string; sent.push(name);
    if (name === "agent_dispatch") prompts.push(request.params.arguments.prompt);
    const data = name === "agent_projects" ? { projects: [{ id: "demo", gitRequired: true, allowedBackends: ["kiro"], allowedProfiles: ["review"] }] }
      : name === "agents_list" ? { backends: [{ id: "kiro", available: true, profiles: ["review"] }] }
      : name === "agent_dispatch" ? { jobId, status: "QUEUED", project: "demo", backend: "kiro", profile: "review", resourcePolicy: "standard", createdAt: "2026-09-26T00:00:00Z" }
      : name === "agent_status" ? { jobId, status: applied ? "APPLIED" : "COMPLETED", createdAt: "2026-09-26T00:00:00Z", completedAt: "2026-09-26T00:01:00Z" }
      : name === "agent_result" ? { jobId, status: "COMPLETED", project: "demo", backend: "kiro", profile: "review", summary: "Reviewed the requested change", diffHash: "b".repeat(64), changedFiles: [] }
      : name === "agent_diff" ? { jobId, diffHash: "b".repeat(64), chunk: "diff --git", chunkBytes: 10, totalBytes: 10, truncated: false, applicable: true, contentComplete: true }
      : name === "agent_apply" ? { jobId, status: "APPLIED", project: "demo", appliedAt: "2026-09-26T00:02:00Z" }
      : {};
    if (name === "agent_apply") applied = true;
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result: { structuredContent: data } } });
  });
  await page.goto("/arena-preview"); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Load current options" }).click();
  await page.getByLabel("Project", { exact: true }).selectOption("demo"); await page.getByLabel("Backend", { exact: true }).selectOption("kiro");
  await page.getByLabel("Agent Profile", { exact: true }).selectOption("synthetic-reviewer");
  const prompt = page.getByLabel("Work request");
  await expect(page.locator("form.arena-composer")).toHaveAttribute("novalidate", "");
  await expect(prompt).toHaveCSS("resize", "none");
  await prompt.fill("Keyboard request");
  await prompt.press("Shift+Enter");
  await expect(prompt).toHaveValue("Keyboard request\n");
  expect(prompts).toEqual([]);
  // A native constraint must not preempt the application's submit handler.
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setCustomValidity("Synthetic browser constraint"));
  expect(await prompt.evaluate((element: HTMLTextAreaElement) => element.validity.valid)).toBe(false);
  await prompt.press("Enter");
  await expect(page.getByText(`Server acknowledged job ${jobId}`)).toBeVisible();
  expect(prompts).toEqual(["Keyboard request\n"]);
  expect(sent).not.toContain("agent_apply");
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setCustomValidity(""));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Reload the synthetic fixture to exercise the existing button submit path independently.
  await page.reload(); await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Load current options" }).click();
  await page.getByLabel("Project", { exact: true }).selectOption("demo"); await page.getByLabel("Backend", { exact: true }).selectOption("kiro");
  await page.getByLabel("Agent Profile", { exact: true }).selectOption("synthetic-reviewer");
  await page.getByLabel("Work request").fill("Review the bounded change");
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setCustomValidity("Synthetic browser constraint"));
  await expect(page.getByRole("button", { name: "Dispatch request" })).toBeEnabled();
  await page.getByRole("button", { name: "Dispatch request" }).click();
  await expect(page.getByText(`Server acknowledged job ${jobId}`)).toBeVisible();
  expect(prompts).toEqual(["Keyboard request\n", "Review the bounded change"]);
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setCustomValidity(""));
  await expect(page.getByText("Review the bounded change", { exact: true })).toBeVisible();
  await expect(page.getByText("Lifecycle:")).toContainText("COMPLETED");
  expect(sent).not.toContain("agent_apply");
  await page.getByRole("button", { name: "Read result" }).click(); await expect(page.getByText("Reviewed the requested change")).toBeVisible();
  await page.getByRole("button", { name: "Read bounded diff" }).click(); await expect(page.getByText("diff --git", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Submit apply" })).toBeDisabled();
  await page.getByLabel(`Type apply ${jobId} to confirm`).fill(`apply ${jobId}`);
  await page.getByRole("button", { name: "Submit apply" }).click();
  await expect(page.getByText(`Server acknowledged APPLIED for ${jobId}`)).toBeVisible();
  await expect(page.getByText("Lifecycle:")).toContainText("APPLIED");
  expect(sent.filter(name => name === "agent_apply")).toHaveLength(1);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
