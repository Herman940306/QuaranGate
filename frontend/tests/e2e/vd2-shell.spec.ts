import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const evidenceRoot = process.env.VD2_SCREENSHOT_DIR;
async function capture(page: Page, name: string) {
  if (!evidenceRoot) return;
  await mkdir(evidenceRoot, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(evidenceRoot, name), fullPage: true, caret: "initial" });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test("desktop rail groups every route and authority remains classification only", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/overview");
  await expect(page).toHaveTitle("Overview — QuaranGate");
  const rail = page.locator("aside.rail");
  await expect(rail).toBeVisible();
  await expect(rail).toHaveCSS("width", "248px");
  await expect(rail.getByRole("navigation", { name: "Main navigation" }).locator("a")).toHaveCount(30);
  for (const group of ["Workstation", "Integrations", "Assurance", "Workspace"]) await expect(rail.getByText(group, { exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  const authority = page.getByRole("region", { name: "Authority classifications" });
  for (const category of ["Read", "Write", "Execution", "Destructive"]) await expect(authority.getByText(category, { exact: true })).toBeVisible();
  await expect(authority).toContainText("Classification only");
  await expect(authority).toContainText("No verified principal");
  const trust = page.getByRole("region", { name: "Execution trust path" });
  await expect(trust).toContainText("Client"); await expect(trust).toContainText("Gateway"); await expect(trust).toContainText("Executor");
  await expect(trust).toContainText("Availability unknown here");
  await expect(page.locator("main h1")).toHaveCount(1);
  await capture(page, "desktop-overview.png");
  await rail.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(rail.getByRole("link", { name: "Jobs", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Completed does not mean applied.")).toBeVisible();
  await noOverflow(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("narrow drawer retains route hierarchy, focus, and account context", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/overview");
  await expect(page.locator("aside.rail")).toBeHidden();
  await expect(page.getByRole("link", { name: /Account Identity integration pending/ })).toBeVisible();
  await noOverflow(page);
  await capture(page, "narrow-overview.png");
  const trigger = page.getByRole("button", { name: "Open navigation" });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("navigation", { name: "Main navigation" }).locator("a")).toHaveCount(30);
  await expect(drawer.getByRole("button", { name: "Close" })).toBeFocused();
  await capture(page, "narrow-drawer.png");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await drawer.getByRole("link", { name: "Targets", exact: true }).click();
  await expect(page).toHaveURL(/\/targets$/);
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await noOverflow(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("degraded, palette, forced colors and 200 percent reflow keep shell truth visible", async ({ page }) => {
  await page.route("**/mcp", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/overview");
  await page.getByRole("button", { name: "Read overview", exact: true }).click();
  await expect(page.locator(".shell-status-banner")).toContainText("Last read: unavailable");
  await expect(page.locator(".shell-status-banner")).toContainText("Check the affected panel for details");
  await capture(page, "degraded-overview.png");
  await page.getByLabel("Mode").selectOption("dark");
  await page.getByLabel("Palette").selectOption("delft");
  await capture(page, "dark-delft-overview.png");
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await capture(page, "forced-colors-overview.png");
  await noOverflow(page);
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await noOverflow(page);
  await capture(page, "zoom-200-narrow.png");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
