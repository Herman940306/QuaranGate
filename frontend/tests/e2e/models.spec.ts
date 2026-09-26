import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
for (const width of [1280, 360]) {
  test(`FE9 Local AI models remains readiness-only at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/models");
    await expect(page.getByRole("heading", { name: "Local AI & Models" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Qualified local models" })).toContainText("qwen3.5:4b-q4_K_M");
    await expect(page.getByRole("table", { name: "O1 deployment truth" })).toContainText("Pending / incomplete");
    await expect(page.getByText("Implement/writer/live mutation is not approved.")).toBeVisible();
    await expect(page.getByRole("button", { name: /pull|switch|enable|seed|probe/i })).toHaveCount(0);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, search: location.search, hash: location.hash }))).toEqual({ local: 0, session: 0, search: "", hash: "" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
