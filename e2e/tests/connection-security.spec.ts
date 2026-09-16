import { test, expect } from '@playwright/test';
import { auditIndexedDbPersistence, browserStorageSnapshot, connectConsole, disconnectConsole, trackBrowserErrors } from './helpers/console.js';
import { SYNTHETIC_BROWSER_CREDENTIALS } from '../contracts/synthetic-credentials.mjs';

const secret = SYNTHETIC_BROWSER_CREDENTIALS.persistence;

test.describe('connection and browser security contract', () => {
  test('serves the console with the frozen security headers', async ({ request }) => {
    const response = await request.get('/console/');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers()['content-security-policy']).toContain("connect-src 'self'");
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['permissions-policy']).toContain('camera=()');
  });

  test('uses same-origin /mcp and keeps the credential out of browser persistence', async ({ page }) => {
    const mcpUrls: string[] = [];
    page.on('request', (request) => { if (request.url().endsWith('/mcp')) mcpUrls.push(request.url()); });
    await connectConsole(page, secret);
    const snapshot = await browserStorageSnapshot(page, secret);
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.indexedDb.supported).toBe(true);
    expect(snapshot.indexedDb.complete, snapshot.indexedDb.errors.join('\n')).toBe(true);
    expect(snapshot.indexedDb.markerFound).toBe(false);
    expect(serialized).not.toContain(secret);
    expect(mcpUrls.length).toBeGreaterThan(0);
    const consoleOrigin = new URL(page.url()).origin;
    for (const url of mcpUrls) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(consoleOrigin);
      expect(parsed.pathname).toBe('/mcp');
    }
    await disconnectConsole(page);
    await expect(page.locator('#api-key')).toHaveValue('');
  });

  test('IndexedDB audit detects the synthetic credential marker in an innocuously named database', async ({ page }) => {
    await page.goto('/console/#/connect');
    const databaseName = 'qg-e2e-cache-control';
    try {
      await page.evaluate(({ databaseName, secret }) => new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
        request.onupgradeneeded = () => request.result.createObjectStore('cache');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('cache', 'readwrite');
          tx.objectStore('cache').put({ value: secret, purpose: 'negative-control' }, 'innocent-key');
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB write failed')); };
        };
      }), { databaseName, secret });
      const audit = await auditIndexedDbPersistence(page, secret);
      expect(audit.supported).toBe(true);
      expect(audit.complete, audit.errors.join('\n')).toBe(true);
      expect(audit.markerFound).toBe(true);
    } finally {
      await page.evaluate(async (databaseName) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error || new Error('IndexedDB fixture deletion failed'));
          request.onblocked = () => reject(new Error('IndexedDB fixture deletion blocked'));
        });

        if (typeof indexedDB.databases !== 'function') {
          throw new Error('IndexedDB database enumeration unsupported after fixture deletion');
        }
        const databases = await indexedDB.databases();
        if (!Array.isArray(databases)) {
          throw new Error('IndexedDB database enumeration returned an untrusted result');
        }
        const maxFixtureDatabases = 256;
        if (databases.length > maxFixtureDatabases) {
          throw new Error(`IndexedDB database enumeration exceeds cleanup proof bound: ${databases.length}`);
        }
        if (databases.some((entry) => entry.name === databaseName)) {
          throw new Error(`IndexedDB fixture database still present after deletion: ${databaseName}`);
        }
      }, databaseName);
    }
  });

  for (const [token, expected] of [
    [SYNTHETIC_BROWSER_CREDENTIALS.authFailure, 'Synthetic authentication failure'],
    [SYNTHETIC_BROWSER_CREDENTIALS.scopeDenied, 'Synthetic scope denial'],
    [SYNTHETIC_BROWSER_CREDENTIALS.rateLimited, 'Synthetic rate limit'],
    [SYNTHETIC_BROWSER_CREDENTIALS.malformed, 'unreadable response'],
    [SYNTHETIC_BROWSER_CREDENTIALS.mismatchedId, 'unexpected request'],
  ] as const) {
    test(`fails closed for ${token}`, async ({ page }) => {
      await page.goto('/console/#/connect');
      await page.locator('#api-key').fill(token);
      await page.locator('#connect-submit').click();
      await expect(page.locator('#app')).toHaveAttribute('data-connected', 'false');
      await expect(page.locator('#api-key')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#api-key-error')).toContainText(expected, { ignoreCase: true });
      await expect(page.locator('#api-key')).toBeFocused();
    });
  }

  test('reports offline transport without creating a connected state', async ({ page }) => {
    await page.route('**/mcp', (route) => route.abort('connectionfailed'));
    await page.goto('/console/#/connect');
    await page.locator('#api-key').fill(SYNTHETIC_BROWSER_CREDENTIALS.offline);
    await page.locator('#connect-submit').click();
    await expect(page.locator('#app')).toHaveAttribute('data-connected', 'false');
    await expect(page.locator('#api-key-error')).toContainText('could not be reached', { ignoreCase: true });
  });

  test('shows bounded progress during a slow gateway response and then connects', async ({ page }) => {
    await page.goto('/console/#/connect');
    await page.locator('#api-key').fill(SYNTHETIC_BROWSER_CREDENTIALS.slow);
    await page.locator('#connect-submit').click();
    await expect(page.locator('#connect-submit')).toContainText('Connecting');
    await expect(page.locator('#connect-status')).toContainText('Verifying');
    await expect(page.locator('#app')).toHaveAttribute('data-connected', 'true', { timeout: 8_000 });
  });

  test('disconnects on a 401 during an already-connected tool call', async ({ page }) => {
    await connectConsole(page);
    await page.goto('/console/#/tool-lab');
    await page.route('**/mcp', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.method === 'tools/call' && body?.params?.name === 'targets_list') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Synthetic expired credential', data: 'INVALID_CREDENTIAL' } }),
        });
        return;
      }
      await route.continue();
    });
    await page.locator('#tool-run').click();
    await expect(page.locator('#app')).toHaveAttribute('data-connected', 'false');
    await expect(page.locator('#route-title')).toHaveText('Connect');
    await expect(page.locator('#connection-label')).toHaveText('Not connected');
  });

  test('keeps the session connected on a 403 authorization denial', async ({ page }) => {
    await connectConsole(page);
    await page.goto('/console/#/tool-lab');
    const deny = async (route: import('@playwright/test').Route) => {
      const body = route.request().postDataJSON();
      if (body?.method === 'tools/call' && body?.params?.name === 'targets_list') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Synthetic scope denial', data: 'FORBIDDEN_SCOPE' } }),
        });
        return;
      }
      await route.continue();
    };
    await page.route('**/mcp', deny);
    await page.locator('#tool-run').click();
    await expect(page.locator('#app')).toHaveAttribute('data-connected', 'true');
    await expect(page.locator('#connection-label')).toHaveText('Connected');
    await expect(page.locator('#toast-root')).toContainText('Synthetic scope denial');

    await page.unroute('**/mcp', deny);
    await page.locator('#tool-run').click();
    await expect(page.locator('#route-view')).toContainText('targets_list result');
    await expect(page.locator('#app')).toHaveAttribute('data-connected', 'true');
  });

  test('produces no uncaught browser errors on a normal connection', async ({ page }) => {
    const errors = trackBrowserErrors(page);
    await connectConsole(page);
    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });
});
