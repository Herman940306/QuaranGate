import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { connectConsole, ROUTES, trackBrowserErrors } from './helpers/console.js';

test.describe('21-route shell and responsive contract', () => {
  test('renders the independent authoritative 21-route label/id/href/hash map without uncaught browser errors', async ({ page }) => {
    const errors = trackBrowserErrors(page);
    await connectConsole(page);

    const discovered = await page.locator('#nav a[data-route]').evaluateAll((links) => links.map((link) => ({
      id: link.getAttribute('data-route'),
      href: link.getAttribute('href'),
      label: link.querySelector('.nav-item__label')?.textContent?.trim() ?? '',
      origin: new URL(link.getAttribute('href') || '', document.baseURI).origin,
    })));
    expect(discovered).toHaveLength(21);
    expect(new Set(discovered.map((route) => route.id)).size).toBe(21);
    expect(new Set(discovered.map((route) => route.href)).size).toBe(21);
    expect(discovered.map(({ id, label, href }) => [id, label, href])).toEqual(ROUTES.map(([id, label, href]) => [id, label, href]));
    expect(new Set(discovered.map((route) => route.origin))).toEqual(new Set([new URL(page.url()).origin]));

    for (const [route, title, href, hash] of ROUTES) {
      const link = page.locator(`[data-route="${route}"]`);
      await expect(link).toHaveAttribute('href', href);
      await page.goto(`/console/${hash}`);
      await expect(page).toHaveURL(new RegExp(`${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      await expect(page.locator('#route-title')).toHaveText(title);
      await expect(link).toHaveAttribute('aria-current', '');
      await expect(page.locator('#main-content')).toBeFocused();
    }
    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });

  test('has no serious or critical axe violations on the connected Overview shell', async ({ page }) => {
    await connectConsole(page);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const severe = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
    expect(severe, severe.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([]);
  });

  test('matches the viewport-specific navigation contract without skipped cases', async ({ page }, testInfo) => {
    await connectConsole(page);
    const menu = page.locator('#menu-button');
    await expect(page.locator('#sidebar')).toBeVisible();
    if (testInfo.project.name === 'chromium-narrow') {
      await expect(menu).toBeVisible();
      await expect(menu).toBeEnabled();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await menu.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#drawer-backdrop')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeFocused();
    } else {
      await expect(menu).toBeHidden();
    }
  });
});
