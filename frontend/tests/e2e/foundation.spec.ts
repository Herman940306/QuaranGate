import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const evidenceRoot = process.env.F1_SCREENSHOT_DIR;
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" || /hydration|hydrated.*match/i.test(message.text())) errors.push(message.text());
  });
  await page.emulateMedia({ colorScheme: "light" });
});
test.afterEach(async ({ page }) => { expect(browserErrors.get(page)).toEqual([]); });
async function capture(page: Page, name: string, fullPage = true) {
  if (!evidenceRoot) return;
  await mkdir(evidenceRoot, { recursive: true });
  // Next keeps an empty overlay portal even with devIndicators disabled.
  await expect(page.locator("nextjs-portal").getByRole("button")).toHaveCount(0);
  await expect(page.locator("nextjs-portal").getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(evidenceRoot, name), fullPage, caret: "initial" });
}
async function assertNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("foundation shell is honest, responsive, and free of persistent browser data", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Foundation — QuaranGate");
  await expect(page.getByRole("heading", { name: /foundation for governed engineering/i })).toBeVisible();
  await expect(page.getByText("Operational services are not connected.")).toBeVisible();
  await assertNoPageOverflow(page);
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
    databases: "databases" in indexedDB ? (await indexedDB.databases()).map(database => database.name ?? "") : [],
    cacheKeys: "caches" in window ? (await caches.keys()).length : 0,
  }));
  expect(storage.local).toBe(0);
  expect(storage.session).toBe(0);
  expect(storage.cookies).toBe("");
  expect(storage.cacheKeys).toBe(0);
  // Next development tooling owns a debug database. F1 creates no application database.
  expect(storage.databases.every(name => name.startsWith("__next_"))).toBe(true);
  await capture(page, "desktop-shell.png");

  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByLabel("Open navigation")).toBeVisible();
  await assertNoPageOverflow(page);
  await capture(page, "narrow-shell-360-full-page.png");
  await capture(page, "narrow-shell-360.png", false);
});

test("appearance exposes every approved value and resets on reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Mode").locator("option")).toHaveCount(3);
  await expect(page.getByLabel("Palette").locator("option")).toHaveCount(5);
  await expect(page.getByLabel("Density").locator("option")).toHaveCount(2);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-mode", "system");
  await expect.poll(() => page.locator("html").evaluate(element => getComputedStyle(element).colorScheme)).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.locator("html").evaluate(element => getComputedStyle(element).colorScheme)).toBe("light");
  await page.getByLabel("Mode").selectOption("dark");
  await page.getByLabel("Palette").selectOption("warm_workbench");
  await page.getByLabel("Density").selectOption("compact");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "warm_workbench");
  await capture(page, "dark-warm-compact.png");
  await page.reload();
  await expect(page.getByLabel("Mode")).toHaveValue("system");
  await expect(page.getByLabel("Palette")).toHaveValue("default");
  await expect(page.getByLabel("Density")).toHaveValue("comfortable");
});

test("design route covers validation, tabs, dialog focus, drawer, toast and accessibility", async ({ page }) => {
  await page.goto("/design-system");
  await page.getByLabel("Mode").selectOption("light");
  await expect(page).toHaveTitle("Design System — QuaranGate");
  await expect(page.getByRole("heading", { name: "Design System" })).toBeVisible();
  await capture(page, "design-system-light.png");

  await page.getByRole("button", { name: "Validate example" }).click();
  await expect(page.getByText("Enter a name for this example.")).toBeVisible();
  await expect(page.getByLabel("Example name")).toBeFocused();
  await page.getByRole("tab", { name: "Evidence" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Authority" })).toHaveAttribute("aria-selected", "true");

  const dialogTrigger = page.getByRole("button", { name: "Open dialog" });
  await dialogTrigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(page.locator("dialog > div")).toHaveCSS("opacity", "1");
  await capture(page, "dialog-full-page-regression.png");
  await expect(page.getByRole("dialog")).toHaveAttribute("open", "");
  await capture(page, "dialog.png", false);
  await expect(page.getByRole("dialog")).toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "Finish example" })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Finish example" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialogTrigger).toBeFocused();

  const drawerTrigger = page.getByRole("button", { name: "Open drawer" });
  await drawerTrigger.click();
  await expect(page.getByRole("dialog")).toHaveAttribute("data-kind", "drawer");
  await expect(page.locator("dialog > div")).toHaveCSS("opacity", "1");
  await capture(page, "drawer.png", false);
  await expect(page.getByRole("dialog")).toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawerTrigger).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Show notification" })).toBeFocused();
  await capture(page, "keyboard-focus.png", false);

  await page.getByRole("button", { name: "Show notification" }).click();
  await expect(page.locator('.toast-center [role="status"]')).toContainText("Example notification");
  await capture(page, "notification-and-focus.png");

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  await assertNoPageOverflow(page);
});

test("reduced motion keeps state and removes spatial movement", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/design-system");
  const sample = page.locator('[data-motion="panel"]');
  const before = await sample.boundingBox();
  await page.getByRole("button", { name: "Preview motion" }).click();
  const after = await sample.boundingBox();
  expect(after?.x).toBe(before?.x);
  await expect(page.getByText("User-triggered demonstration. Reduced motion removes movement.")).toBeVisible();
  await context.close();
});

test("local fonts and representative theme combinations remain accessible", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const requests: string[] = [];
  const measurements: object[] = [];
  page.on("request", request => requests.push(request.url()));
  await page.goto("/design-system");
  const combinations = [
    ["light", "default", "comfortable"],
    ["dark", "delft", "comfortable"],
    ["light", "mineral", "compact"],
    ["dark", "slate", "compact"],
    ["light", "warm_workbench", "comfortable"],
    ["light", "delft", "comfortable"],
    ["light", "slate", "comfortable"],
    ["dark", "default", "comfortable"],
    ["dark", "mineral", "comfortable"],
    ["dark", "warm_workbench", "comfortable"],
    ["system", "warm_workbench", "comfortable"],
  ] as const;
  for (const width of [1280, 360]) for (const [mode, palette, density] of combinations) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByLabel("Mode").selectOption(mode);
    await page.getByLabel("Palette").selectOption(palette);
    await page.getByLabel("Density").selectOption(density);
    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
    await expect(page.locator("html")).toHaveAttribute("data-palette", palette);
    await expect(page.locator("html")).toHaveAttribute("data-density", density);
    await expect(page.getByLabel("Palette")).toHaveValue(palette);
    await expect(page.getByLabel("Density")).toHaveValue(density);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `${mode}/${palette}/${density}`).toEqual([]);
    const badges = await page.locator('.badge[data-tone="attention"]').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d"); if (!context) throw new Error("Color measurement unavailable");
      function color(value: string) {
        if (!context) throw new Error("Color measurement unavailable");
        context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        const channels = rgb.map(channel => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });
        return { hex: `#${rgb.map(channel => channel.toString(16).padStart(2, "0")).join("")}`, luminance: channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 };
      }
      const foreground = color(style.color); const background = color(style.backgroundColor);
      return { text: element.textContent, foreground: foreground.hex, background: background.hex, computedForeground: style.color, ratio: (Math.max(foreground.luminance, background.luminance) + 0.05) / (Math.min(foreground.luminance, background.luminance) + 0.05) };
    }));
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) expect(badge.ratio).toBeGreaterThanOrEqual(4.5);
    measurements.push({ width, mode, palette, density, badges });
    await assertNoPageOverflow(page);
    if (mode === "light" && palette === "warm_workbench") await capture(page, `warm-workbench-${width}.png`);
    if (mode === "dark" && palette === "delft" && width === 1280) await capture(page, "design-system-dark.png");
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByLabel("Mode").selectOption("system");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await testInfo.attach("attention-theme-matrix", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  await capture(page, "alternate-palette.png");
  expect(requests.filter(url => /fonts\.(googleapis|gstatic)\.com/.test(url))).toEqual([]);
  expect(requests.some(url => url.includes("/_next/static/media/"))).toBe(true);
});


test("forced colors preserves navigation, controls and modal keyboard operation", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/design-system");
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
  await page.getByLabel("Mode").selectOption("dark");
  await page.getByLabel("Palette").selectOption("warm_workbench");
  const trigger = page.getByRole("button", { name: "Open dialog" });
  await trigger.click();
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Finish example" })).toBeFocused();
  const outline = await page.getByRole("button", { name: "Finish example" }).evaluate(element => ({ width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle }));
  expect(outline.width).toBe("3px");
  expect(outline.style).toBe("solid");
  await expect(page.locator("dialog > div")).toHaveCSS("opacity", "1");
  await capture(page, "forced-colors-dialog.png", false);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByLabel("Open navigation").click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Foundation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Open navigation")).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await assertNoPageOverflow(page);
});

test("200 percent layout zoom keeps desktop and narrow actions and overlays reachable", async ({ page }) => {
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/design-system");
    await page.getByLabel("Mode").selectOption("light");
    await page.getByLabel("Palette").selectOption("warm_workbench");
    // CSS zoom exercises 200% layout magnification, not CDP pinch zoom.
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.locator("html").evaluate(element => getComputedStyle(element).zoom)).toBe("2");
    await assertNoPageOverflow(page);
    const trigger = page.getByRole("button", { name: "Open dialog" });
    await trigger.click();
    const bounds = await page.getByRole("dialog").boundingBox();
    if (!bounds) throw new Error("Open dialog has no visible bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
    await page.getByRole("button", { name: "Close" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Close" })).toBeInViewport();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Finish example" })).toBeFocused();
    await page.getByRole("button", { name: "Finish example" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Finish example" })).toBeInViewport();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
    await page.getByRole("button", { name: "Close" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Close" })).toBeInViewport();
    await expect(page.locator("dialog > div")).toHaveCSS("opacity", "1");
    await capture(page, `zoom-200-${width}-dialog.png`, false);
    await expect(page.getByRole("dialog")).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "Open drawer" }).click();
    const drawerBounds = await page.getByRole("dialog").boundingBox();
    if (!drawerBounds) throw new Error("Open drawer has no visible bounds");
    expect(drawerBounds.y).toBeGreaterThanOrEqual(0);
    expect(drawerBounds.y + drawerBounds.height).toBeLessThanOrEqual(800);
    await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open drawer" })).toBeFocused();
    if (width === 360) {
      await page.getByLabel("Open navigation").click();
      await page.getByRole("dialog").getByRole("link", { name: "Foundation" }).click();
      await expect(page).toHaveURL("/");
    } else {
      await page.locator(".rail").getByRole("link", { name: "Foundation" }).click();
      await expect(page).toHaveURL("/");
    }
    await assertNoPageOverflow(page);
  }
});
