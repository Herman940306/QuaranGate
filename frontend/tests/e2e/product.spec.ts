import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const evidence = "test-results/visual-rechecks/fe3";
async function preview(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/product-preview");
  await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await expect(page.getByText("Development-only fixtures.", { exact: false })).toBeVisible();
}
async function read(page: Page) {
  await page.getByRole("button", { name: "Re-read configuration" }).click();
  await expect(page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider/ }).or(page.getByRole("button", { name: "Synthetic reviewer" })).or(page.getByText("No providers configured")).or(page.getByText("No profiles configured"))).toBeVisible();
}
async function axe(page: Page) { expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1); }
async function noSecretPersistence(page: Page, secret: string) {
  const browser = await page.evaluate(async () => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), databases: (await indexedDB.databases()).map(db => db.name ?? ""), cookies: document.cookie, url: location.href, text: document.body.innerText }));
  expect(JSON.stringify(browser)).not.toContain(secret);
  expect(browser.local).toBe("{}"); expect(browser.session).toBe("{}"); expect(browser.cookies).toBe("");
  expect(browser.databases.every(name => name.startsWith("__next_"))).toBe(true);
  expect(new URL(browser.url).search).toBe(""); expect(new URL(browser.url).hash).toBe("");
}

for (const width of [1280, 360]) {
  test(`provider inventory, setup, write-only lifecycle and visual evidence at ${width}`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await preview(page, width); await read(page);
    await expect(page.getByText("Configuration and validation do not grant operational authority.")).toBeVisible();
    await axe(page); await noOverflow(page);
    await page.evaluate(() => { const heading = [...document.querySelectorAll("h1")].find(h => h.textContent === "Providers"); if (heading) window.scrollTo(0, heading.getBoundingClientRect().top + scrollY - 140); (document.activeElement as HTMLElement)?.blur(); });
    await page.screenshot({ path: `${evidence}/fe3-provider-${width}.png` });
    await page.getByRole("button", { name: "Create provider" }).click();
    await expect(page.getByLabel("Provider kind")).toBeFocused();
    await page.getByRole("button", { name: "Submit configuration" }).click();
    await expect(page.getByText("Choose a returned provider kind.")).toBeVisible();
    await expect(page.getByLabel("Provider kind")).toBeFocused();
    await page.getByLabel("Provider kind").selectOption("synthetic-provider");
    await page.getByRole("button", { name: "Submit configuration" }).click();
    await expect(page.getByText("Choose a returned owner scope.")).toBeVisible();
    await expect(page.getByLabel("Owner scope")).toBeFocused();
    await page.getByLabel("Owner scope").selectOption("workspace");
    const secret = `synthetic-browser-only-${width}`;
    await page.getByLabel("Secret (write-only)").fill(secret);
    await page.getByRole("button", { name: "Submit configuration" }).click();
    await expect(page.getByLabel("Secret (write-only)")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider-\d+/ })).toBeVisible();
    await noSecretPersistence(page, secret); await axe(page); await noOverflow(page);
    await page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider-\d+/ }).click();
    await expect(page.getByRole("table", { name: "Configuration metadata" })).toContainText("Saved configuration");
    await page.getByRole("button", { name: "Edit configuration" }).click();
    await expect(page.getByLabel("Secret (write-only)")).toHaveValue("");
    await page.getByLabel("Secret (write-only)").fill(secret);
    await page.getByRole("button", { name: "Cancel editor" }).click();
    await expect(page.getByLabel("Secret (write-only)")).toHaveCount(0);
    await page.getByRole("button", { name: "Edit configuration" }).click();
    await expect(page.getByLabel("Secret (write-only)")).toHaveValue("");
    await page.getByLabel("Secret (write-only)").fill(secret);
    await page.getByLabel("Configuration surface").selectOption("profiles");
    await expect(page.getByLabel("Secret (write-only)")).toHaveCount(0);
    await noSecretPersistence(page, secret); expect(errors).toEqual([]);
  });
}

test("provider validation, stale mutation, unavailable, forbidden and empty states", async ({ page }) => {
  await preview(page); await read(page);
  await page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider/ }).click();
  await page.getByRole("button", { name: "Request provider validation" }).click();
  await expect(page.getByText("Validation succeeded.", { exact: false })).toBeVisible();
  await page.getByLabel("Configuration scenario").selectOption("validation_failed"); await read(page);
  await page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider/ }).click();
  await page.getByRole("button", { name: "Request provider validation" }).click();
  await expect(page.getByText("Validation failed.", { exact: false })).toBeVisible();
  await page.getByLabel("Configuration scenario").selectOption("stale"); await read(page);
  await page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider/ }).click();
  await page.getByRole("button", { name: "Edit configuration" }).click();
  await page.getByRole("button", { name: "Submit configuration" }).click();
  await expect(page.getByText("Configuration version changed.", { exact: false })).toBeVisible();
  for (const [scenario, copy] of [["unavailable", "Configuration service unavailable."], ["forbidden", "Configuration access forbidden."], ["empty", "No providers configured"]]) {
    await page.getByLabel("Configuration scenario").selectOption(scenario); await page.getByRole("button", { name: "Re-read configuration" }).click();
    await expect(page.getByText(copy, { exact: false })).toBeVisible(); await axe(page);
  }
});

test("profile editor invalid input, save, edit and workspace isolation", async ({ page }) => {
  await preview(page); await page.getByLabel("Configuration surface").selectOption("profiles"); await read(page);
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByLabel("Profile name")).toBeFocused();
  await page.getByRole("button", { name: "Submit profile" }).click();
  await expect(page.getByText("Enter a bounded profile name.")).toBeVisible(); await expect(page.getByLabel("Profile name")).toBeFocused();
  await page.getByLabel("Profile name").fill("Synthetic new profile");
  await page.getByLabel("Backend reference").selectOption("synthetic-backend");
  await page.getByLabel("ACP profile reference").selectOption("synthetic-acp");
  await page.getByLabel("Logical project").selectOption("synthetic-project");
  await page.getByLabel("Resource policy reference").selectOption("synthetic-policy");
  await page.getByRole("button", { name: "Submit profile" }).click();
  await expect(page.getByRole("button", { name: "Synthetic new profile" })).toBeVisible();
  await page.getByRole("button", { name: "Synthetic new profile" }).click();
  await expect(page.getByRole("table", { name: "Configuration metadata" })).toContainText("Synthetic new profile");
  await expect(page.getByText("No dispatch is performed by Agent Profile selection.")).toBeVisible();
  await page.getByRole("button", { name: "Edit configuration" }).click();
  await expect(page.getByLabel("Profile name")).toHaveValue("Synthetic new profile");
  await page.getByLabel("Profile name").fill("Synthetic revised profile");
  await page.getByRole("button", { name: "Submit profile" }).click();
  await expect(page.getByRole("button", { name: "Synthetic revised profile" })).toBeVisible();
  await page.evaluate(() => { const heading = [...document.querySelectorAll("h1")].find(h => h.textContent === "Agent Profiles"); if (heading) window.scrollTo(0, heading.getBoundingClientRect().top + scrollY - 140); (document.activeElement as HTMLElement)?.blur(); });
  await page.screenshot({ path: `${evidence}/fe3-profile-1280.png` }); await axe(page);
  await page.getByLabel("Workspace", { exact: true }).selectOption("synthetic-review");
  await page.getByRole("button", { name: "Switch workspace", exact: true }).click();
  await expect(page.getByText("Current workspace: synthetic-review")).toBeVisible();
  await expect(page.getByRole("table", { name: "Configuration metadata" })).toHaveCount(0);
  await page.getByRole("button", { name: "Re-read configuration" }).click();
  await expect(page.getByRole("button", { name: "Synthetic reviewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Synthetic revised profile" })).toHaveCount(0);
});

test("slow request cancellation and identity switch suppress late product results", async ({ page }) => {
  await preview(page); await page.getByLabel("Configuration scenario").selectOption("slow");
  await page.getByRole("button", { name: "Re-read configuration" }).click();
  await expect(page.getByRole("button", { name: "Cancel request" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Request cancelled. A server change may have completed; re-read to reconcile.")).toBeVisible();
  await page.waitForTimeout(800); await expect(page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Re-read configuration" }).click();
  await page.getByLabel("Synthetic identity").selectOption("synthetic-user-b");
  await page.waitForTimeout(800); await expect(page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider/ })).toHaveCount(0);
  await expect(page.getByText("Configuration and validation do not grant operational authority.")).toBeVisible();
});

test("asynchronous provider submit clears the field before settlement and cancellation hides late results", async ({ page }) => {
  await preview(page); await page.getByLabel("Configuration scenario").selectOption("slow");
  await page.getByRole("button", { name: "Re-read configuration" }).click();
  await expect(page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider/ })).toBeVisible();
  await page.getByRole("button", { name: "Create provider" }).click();
  await page.getByLabel("Provider kind").selectOption("synthetic-provider");
  await page.getByLabel("Owner scope").selectOption("workspace");
  const secret = "synthetic-async-only-input";
  await page.getByLabel("Secret (write-only)").fill(secret);
  await page.getByRole("button", { name: "Submit configuration" }).click();
  await expect(page.getByLabel("Secret (write-only)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel request" })).toBeVisible();
  await noSecretPersistence(page, secret);
  await page.getByRole("button", { name: "Cancel request" }).click();
  await page.waitForTimeout(800);
  await expect(page.getByRole("button", { name: /synthetic-provider · synthetic-lab-provider-\d+/ })).toHaveCount(0);
  await noSecretPersistence(page, secret);
});

test("production-shaped provider and profile routes stay integration pending", async ({ page }) => {
  await page.goto("/providers"); await expect(page.getByText("Product integration pending.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-read configuration" })).toBeDisabled(); await axe(page);
  await page.goto("/agent-profiles"); await expect(page.getByText("Product integration pending.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-read configuration" })).toBeDisabled(); await axe(page);
});

test("reduced motion, forced colors and 200 percent layout zoom preserve product controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" }); await preview(page, 360);
  await expect(page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).resolves.toBe(true);
  await read(page); await axe(page); await noOverflow(page);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await noOverflow(page);
  await expect(page.getByRole("button", { name: "Re-read configuration" })).toBeVisible();
  const authorityColors = await page.locator(".authority-strip").evaluate(strip => ({ background: getComputedStyle(strip).backgroundColor, foreground: getComputedStyle(strip.querySelector("strong") as HTMLElement).color }));
  expect(authorityColors.background).not.toBe(authorityColors.foreground);
  await page.evaluate(() => { const heading = [...document.querySelectorAll("h1")].find(h => h.textContent === "Providers"); if (heading) window.scrollTo(0, heading.getBoundingClientRect().top + scrollY - 100); (document.activeElement as HTMLElement)?.blur(); });
  await page.screenshot({ path: `${evidence}/fe3-forced-zoom-360.png` });
  await axe(page);
});

test("desktop 200 percent layout zoom and keyboard-only provider editor remain reachable", async ({ page }) => {
  await preview(page, 1280); await read(page);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await noOverflow(page);
  const create = page.getByRole("button", { name: "Create provider" });
  await create.focus(); await page.keyboard.press("Enter");
  await expect(page.getByLabel("Provider kind")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByLabel("Owner scope")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByLabel("Secret (write-only)")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Submit configuration" })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Cancel editor" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Re-read configuration" })).toBeFocused();
  await noOverflow(page); await axe(page);
});
