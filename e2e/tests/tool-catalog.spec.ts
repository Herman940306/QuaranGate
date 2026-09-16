import { test, expect } from '@playwright/test';
import { connectConsole } from './helpers/console.js';
import { SYNTHETIC_BROWSER_CREDENTIALS } from '../contracts/synthetic-credentials.mjs';

test.describe('45-tool catalog and drift handling', () => {
  test('maps the exact 45-tool server surface', async ({ page }) => {
    await connectConsole(page, SYNTHETIC_BROWSER_CREDENTIALS.ok);
    await page.goto('/console/#/tool-lab');
    await expect(page.locator('.alert__title')).toContainText('Complete surface mapped');
    await expect(page.locator('.alert__body')).toContainText('All 45 current Console tools');
    await expect(page.locator('[data-tool-name]')).toHaveCount(45);
  });

  test('reports a missing expected tool without inventing success', async ({ page }) => {
    await connectConsole(page, SYNTHETIC_BROWSER_CREDENTIALS.missingTool);
    await page.goto('/console/#/tool-lab');
    await expect(page.locator('.alert__title')).toContainText('Tool surface differs');
    await expect(page.locator('.alert__body')).toContainText('Missing: targets_list');
    await expect(page.locator('.alert__body')).toContainText('Extra: none');
  });

  test('reports an unexpected future tool without silently accepting drift', async ({ page }) => {
    await connectConsole(page, SYNTHETIC_BROWSER_CREDENTIALS.extraTool);
    await page.goto('/console/#/tool-lab');
    await expect(page.locator('.alert__title')).toContainText('Tool surface differs');
    await expect(page.locator('.alert__body')).toContainText('Missing: none');
    await expect(page.locator('.alert__body')).toContainText('Extra: future_tool');
  });

  test('suppresses duplicate in-flight tool submissions', async ({ page }) => {
    await connectConsole(page, SYNTHETIC_BROWSER_CREDENTIALS.ok);
    await page.goto('/console/#/tool-lab');
    let calls = 0;
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      let body: any = {};
      try { body = request.postDataJSON(); } catch { /* no-op */ }
      if (body?.method === 'tools/call' && body?.params?.name === 'targets_list') {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await route.continue();
    });
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('#tool-form');
      if (!form) throw new Error('tool form missing');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => calls).toBe(1);
    await expect(page.locator('#tool-run')).toBeEnabled();
  });
});
