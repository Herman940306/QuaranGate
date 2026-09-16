import { test, expect } from '@playwright/test';
import { connectConsole } from './helpers/console.js';

const OLD = 'E2E_PREFLIGHT_OLD_RESULT';
const NEW = 'E2E_PREFLIGHT_NEW_RESULT';

test.describe('Security preflight response ordering', () => {
  test('newest legitimate preflight response remains authoritative when an older request completes later', async ({ page }) => {
    await connectConsole(page);
    await page.goto('/console/#/security');
    await expect(page.locator('#preflight-form')).toBeVisible();

    const observed: string[] = [];
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      let body: any = {};
      try { body = request.postDataJSON(); } catch { return route.continue(); }
      const args = body?.params?.arguments || {};
      if (body?.method !== 'tools/call' || body?.params?.name !== 'control_center_query' || args.view !== 'authority' || !args.tool) {
        return route.continue();
      }

      const marker = String(args.tool);
      if (marker !== OLD && marker !== NEW) return route.continue();
      observed.push(marker);
      await new Promise((resolve) => setTimeout(resolve, marker === OLD ? 650 : 75));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            structuredContent: {
              data: {
                principal: { id: 'e2e-browser', scopes: ['targets:read'] },
                preflight: { requestMarker: marker, decision: 'ALLOW' },
              },
            },
          },
        }),
      });
    });

    await page.locator('#preflight-tool').fill(OLD);
    await page.locator('#preflight-form').dispatchEvent('submit');
    await expect.poll(() => observed.includes(OLD)).toBe(true);

    await page.locator('#preflight-tool').fill(NEW);
    await page.locator('#preflight-form').dispatchEvent('submit');
    await expect.poll(() => observed.includes(NEW)).toBe(true);

    await expect(page.locator('.preflight-result')).toContainText(NEW, { timeout: 2_000 });
    await expect(page.locator('.preflight-result')).not.toContainText(OLD);

    await page.waitForTimeout(800);
    await expect(page.locator('.preflight-result')).toContainText(NEW);
    await expect(page.locator('.preflight-result')).not.toContainText(OLD);
  });
});
