import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const evidence = "test-results/visual-rechecks/fe2";
async function preview(page: Page, scenario: string, surface: string) {
  await page.goto("/identity-preview");
  await page.getByLabel("Synthetic scenario").selectOption(scenario);
  await page.getByLabel("Preview surface").selectOption(surface);
  await expect(page.getByText("Development-only fixtures.", { exact: false })).toBeVisible();
}
async function axe(page: Page) { expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); }
async function safe(page: Page) {
  const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, databases: (await indexedDB.databases()).map(db => db.name ?? ""), cookies: document.cookie }));
  expect({ ...storage, databases: [] }).toEqual({ local: 0, session: 0, databases: [], cookies: "" });
  // Existing F1 harness exception: Next development debug DB; production smoke requires zero databases.
  expect(storage.databases.every(name => name.startsWith("__next_"))).toBe(true);
  expect(new URL(page.url()).search).toBe(""); expect(new URL(page.url()).hash).toBe("");
  expect(await page.locator("main").innerText()).not.toMatch(/accessToken|refreshToken|idToken|pkceVerifier|raw provider|eyJ[A-Za-z0-9_-]+\./);
  expect(await page.locator("input").count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
test("production-shaped default sign-in and account remain integration pending", async ({ page }) => {
  const requests: string[] = []; page.on("request", req => requests.push(req.url()));
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Continue to identity provider" })).toBeDisabled();
  await expect(page.getByText("Identity service not integrated yet. Sign-in is unavailable.")).toBeVisible();
  await page.getByRole("link", { name: "View account" }).click();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByText("Identity service unavailable.", { exact: false })).toBeVisible();
  expect(requests.some(url => /\/api\/product|\/v0\/session|keycloak/i.test(url))).toBe(false);
  await axe(page); await safe(page);
});
for (const width of [1280, 360]) {
  test(`signed-out and active synthetic account, appearance and axe at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await preview(page, "signed_out", "sign-in");
    await expect(page.getByText("Signed out. Sign in through", { exact: false })).toBeVisible();
    await axe(page); await safe(page);
    await page.getByRole("button", { name: "Continue to identity provider" }).click();
    await expect(page.getByText("Sign-in redirect requested.", { exact: false })).toBeVisible();
    await page.getByLabel("Synthetic scenario").selectOption("active"); await page.getByLabel("Preview surface").selectOption("account");
    await expect(page.getByRole("cell", { name: "Synthetic Operator", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Synthetic Organization", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Reviewer", exact: true })).toBeVisible();
    for (const mode of ["light", "dark", "system"]) { await page.getByLabel("Mode", { exact: true }).selectOption(mode); await page.getByLabel("Palette").selectOption("mineral"); await expect(page.locator("html")).toHaveAttribute("data-mode", mode); await axe(page); }
    await mkdir(evidence, { recursive: true }); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${evidence}/fe2-account-${width}.png`, fullPage: true });
    await safe(page);
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await expect(page.getByRole("cell", { name: "Synthetic Operator", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Palette")).toHaveValue("mineral"); await safe(page);
  });
  test(`keyboard workspace switch and stale conflict at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await preview(page, "active", "workspaces");
    const selector = page.getByLabel("Workspace", { exact: true }); await expect(selector).toHaveValue("synthetic-lab");
    await selector.focus(); await page.keyboard.press("Alt+ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await expect(selector).toHaveValue("synthetic-review");
    await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Switch workspace", exact: true })).toBeFocused(); await page.keyboard.press("Enter");
    await expect(selector).toHaveValue("synthetic-review"); await expect(page.getByRole("button", { name: "Switch workspace", exact: true })).toBeDisabled();
    await axe(page); await safe(page);
    await page.getByLabel("Synthetic scenario").selectOption("stale"); await expect(selector).toHaveValue("synthetic-lab"); await selector.selectOption("synthetic-review"); await page.getByRole("button", { name: "Switch workspace", exact: true }).click();
    await expect(page.getByText("Session version changed.", { exact: false })).toBeVisible(); await expect(page.getByRole("button", { name: "Check session", exact: true })).toBeFocused(); await expect(selector).toHaveCount(0); await axe(page); await safe(page);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${evidence}/fe2-stale-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Check session", exact: true }).click(); await expect(selector).toHaveValue("synthetic-lab");
  });
}
test("principal and session lifecycle states render safely with axe", async ({ page }) => {
  for (const [scenario, copy] of [["unmapped", "Principal unmapped."], ["mapping_unavailable", "Principal mapping unavailable."], ["principal_forbidden", "Principal forbidden."], ["unavailable", "Identity service unavailable."], ["expired", "Session expired."], ["revoked", "Session revoked."], ["expiring", "Session expires soon."]]) {
    await preview(page, scenario, "account"); await expect(page.getByText(copy, { exact: false }).first()).toBeVisible(); await axe(page); await safe(page);
  }
});
test("workspace membership denial and conflict never retain account or workspace choices", async ({ page }) => {
  for (const [scenario, copy] of [["forbidden", "Product membership does not allow"], ["workspace_conflict", "Workspace switch conflict."]]) {
    await preview(page, scenario, "workspaces"); await page.getByLabel("Workspace", { exact: true }).selectOption("synthetic-review"); await page.getByRole("button", { name: "Switch workspace", exact: true }).click(); await expect(page.getByText(copy, { exact: false })).toBeVisible(); await expect(page.getByLabel("Workspace", { exact: true })).toHaveCount(0); await axe(page); await safe(page);
  }
});
test("workspace/account changes drop receipts and suppress late operational output", async ({ page }) => {
  await preview(page, "active", "account"); await page.getByRole("button", { name: "Read synthetic projection", exact: true }).click(); await expect(page.getByText("Synthetic operational result", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check session", exact: true }).click(); await expect(page.getByText("Synthetic operational result", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Read synthetic projection", exact: true }).click(); await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForTimeout(350); await expect(page.getByText("Synthetic operational result", { exact: true })).toHaveCount(0); await safe(page);
});
test("pending switch cancel clears account, late reply ignored; explicit check reconciles", async ({ page }) => {
  await preview(page, "slow_switch", "workspaces"); await page.getByLabel("Workspace", { exact: true }).selectOption("synthetic-review"); await page.getByRole("button", { name: "Switch workspace", exact: true }).click();
  await expect(page.getByText("Switching workspace", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Cancel request", exact: true }).click(); await expect(page.getByText("Request cancelled.", { exact: false })).toBeVisible(); await page.waitForTimeout(700); await expect(page.getByLabel("Workspace", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Check session", exact: true }).click(); await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("synthetic-review"); await axe(page); await safe(page);
});
test("reduced motion and keyboard shell navigation retain appearance", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/account"); await expect(page.getByText("Identity service unavailable.", { exact: false })).toBeVisible(); await page.getByLabel("Mode", { exact: true }).selectOption("dark"); await expect(page.locator("html")).toHaveAttribute("data-mode", "dark"); await page.getByLabel("Palette").selectOption("delft"); await expect(page.locator("html")).toHaveAttribute("data-palette", "delft");
  await page.locator(".rail").getByRole("link", { name: "Workspaces", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible(); await expect(page.locator("html")).toHaveAttribute("data-mode", "dark"); await expect(page.locator("html")).toHaveAttribute("data-palette", "delft");
  await axe(page); await safe(page);
});
