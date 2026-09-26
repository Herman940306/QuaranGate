import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function preview(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/approvals-preview");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Review & Approvals" })).toBeVisible();
  await page.getByRole("button", { name: "Load approvals" }).click();
  await expect(page.getByRole("button", { name: /agent.apply/ })).toBeVisible();
}
async function axe(page: Page) { expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1); }

for (const width of [1280, 360]) {
  test(`FE6 approval inbox is responsive, accessible and authority-honest at ${width}`, async ({ page }) => {
    await preview(page, width);
    await expect(page.getByText("APPROVED ≠ EXECUTED")).toBeVisible();
    await page.getByRole("button", { name: /agent.apply/ }).click();
    await expect(page.getByText("Decision record only")).toBeVisible();
    await expect(page.getByText("synthetic-requester-a")).toBeVisible();
    await expect(page.getByText("b".repeat(64))).toBeVisible();
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, query: location.search, hash: location.hash }))).toEqual({ local: 0, session: 0, query: "", hash: "" });
    await axe(page); await noOverflow(page);
  });
}

test("FE6 explicit approval records a decision without implying execution", async ({ page }) => {
  await preview(page);
  await page.getByRole("button", { name: /agent.apply/ }).click();
  await expect(page.getByRole("button", { name: "Record approval" })).toBeDisabled();
  await page.getByLabel(/Type approved synthetic-approval-1 to confirm/).fill("approved synthetic-approval-1");
  await page.getByRole("button", { name: "Record approval" }).click();
  await expect(page.getByText(/Server acknowledged APPROVED at version/)).toBeVisible();
  await expect(page.getByText(/does not mean the underlying operation executed/)).toBeVisible();
  await expect(page.getByText("APPROVED", { exact: true })).toBeVisible();
  await axe(page);
});

test("FE6 stale and unavailable decisions fail closed", async ({ page }) => {
  await preview(page);
  await page.getByLabel("Approval scenario").selectOption("stale");
  await page.getByRole("button", { name: "Load approvals" }).click();
  await page.getByRole("button", { name: /agent.apply/ }).click();
  await page.getByLabel(/Type approved synthetic-approval-1 to confirm/).fill("approved synthetic-approval-1");
  await page.getByRole("button", { name: "Record approval" }).click();
  await expect(page.getByText("Approval version changed.", { exact: false })).toBeVisible();

  await page.getByLabel("Approval scenario").selectOption("unavailable");
  await page.getByRole("button", { name: "Load approvals" }).click();
  await expect(page.getByText("Approval service unavailable.", { exact: false })).toBeVisible();
  await axe(page);
});
