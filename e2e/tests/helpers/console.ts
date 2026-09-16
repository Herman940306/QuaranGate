import { expect, type Page } from '@playwright/test';
import { AUTHORITATIVE_ROUTES } from '../../contracts/routes.mjs';
import { SYNTHETIC_BROWSER_CREDENTIALS } from '../../contracts/synthetic-credentials.mjs';

export const ROUTES = AUTHORITATIVE_ROUTES.map(({ id, label, href, hash }) => [id, label, href, hash] as const);

export async function connectConsole(page: Page, token = SYNTHETIC_BROWSER_CREDENTIALS.ok) {
  await page.goto('/console/#/connect');
  await expect(page.locator('#route-title')).toHaveText('Connect');
  await page.locator('#api-key').fill(token);
  await page.locator('#connect-submit').click();
  await expect(page.locator('#app')).toHaveAttribute('data-connected', 'true');
  await expect(page.locator('#connection-label')).toHaveText('Connected');
  await expect(page.locator('#route-title')).toHaveText('Overview');
}

export async function disconnectConsole(page: Page) {
  const disconnect = page.locator('#disconnect-button');
  const menu = page.locator('#menu-button');
  if (await menu.isVisible()) {
    await expect(menu).toBeEnabled();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#drawer-backdrop')).toBeVisible();
  }
  await disconnect.click();
  await expect(page.locator('#app')).toHaveAttribute('data-connected', 'false');
  await expect(page.locator('#route-title')).toHaveText('Connect');
}

export function trackBrowserErrors(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  return { pageErrors, consoleErrors };
}

export async function auditIndexedDbPersistence(page: Page, marker: string) {
  return page.evaluate(async ({ marker, limits }) => {
    const errors: string[] = [];
    const databases: Array<{ name: string; version: number; stores: Array<{ name: string; recordsScanned: number }> }> = [];
    let markerFound = false;
    let totalStores = 0;
    let totalRecords = 0;

    const inspect = async (value: any, depth = 0, seen = new WeakSet<object>()): Promise<boolean> => {
      if (typeof value === 'string') return value.includes(marker);
      if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).includes(marker);
      if (depth > limits.maxValueDepth) { errors.push('INDEXEDDB_VALUE_DEPTH_LIMIT'); return false; }
      if (value instanceof Blob) {
        if (value.size > limits.maxBlobBytes) { errors.push('INDEXEDDB_BLOB_LIMIT'); return false; }
        try { return (await value.text()).includes(marker); }
        catch { errors.push('INDEXEDDB_BLOB_READ_FAILED'); return false; }
      }
      if (value instanceof ArrayBuffer) {
        if (value.byteLength > limits.maxBinaryBytes) { errors.push('INDEXEDDB_BINARY_LIMIT'); return false; }
        return new TextDecoder().decode(new Uint8Array(value)).includes(marker);
      }
      if (ArrayBuffer.isView(value)) {
        if (value.byteLength > limits.maxBinaryBytes) { errors.push('INDEXEDDB_BINARY_LIMIT'); return false; }
        return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).includes(marker);
      }
      if (value instanceof Date) return value.toISOString().includes(marker);
      if (typeof value !== 'object') return String(value).includes(marker);
      if (seen.has(value)) return false;
      seen.add(value);

      let entries: Array<[unknown, unknown]> = [];
      if (value instanceof Map) entries = [...value.entries()];
      else if (value instanceof Set) entries = [...value.values()].map((item, index) => [index, item]);
      else entries = Object.entries(value);
      if (entries.length > limits.maxObjectEntries) { errors.push('INDEXEDDB_OBJECT_ENTRY_LIMIT'); entries = entries.slice(0, limits.maxObjectEntries); }
      for (const [key, item] of entries) {
        if (await inspect(key, depth + 1, seen) || await inspect(item, depth + 1, seen)) return true;
      }
      return false;
    };

    if (typeof indexedDB?.databases !== 'function') {
      return { supported: false, complete: false, markerFound: false, errors: ['INDEXEDDB_DATABASE_ENUMERATION_UNSUPPORTED'], databases, totalStores, totalRecords };
    }

    let infos: IDBDatabaseInfo[];
    try { infos = await indexedDB.databases(); }
    catch { return { supported: true, complete: false, markerFound: false, errors: ['INDEXEDDB_DATABASE_ENUMERATION_FAILED'], databases, totalStores, totalRecords }; }
    if (infos.length > limits.maxDatabases) errors.push('INDEXEDDB_DATABASE_LIMIT');

    for (const info of infos.slice(0, limits.maxDatabases)) {
      if (!info.name || !info.version) { errors.push('INDEXEDDB_DATABASE_IDENTITY_INCOMPLETE'); continue; }
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        let request: IDBOpenDBRequest;
        try { request = indexedDB.open(info.name!, info.version); }
        catch { errors.push(`INDEXEDDB_OPEN_FAILED:${info.name}`); resolve(null); return; }
        request.onupgradeneeded = () => { request.transaction?.abort(); };
        request.onerror = () => { errors.push(`INDEXEDDB_OPEN_FAILED:${info.name}`); resolve(null); };
        request.onsuccess = () => resolve(request.result);
        request.onblocked = () => { errors.push(`INDEXEDDB_OPEN_BLOCKED:${info.name}`); resolve(null); };
      });
      if (!db) continue;
      try {
        const storeNames = Array.from(db.objectStoreNames);
        if (totalStores + storeNames.length > limits.maxStores) errors.push('INDEXEDDB_STORE_LIMIT');
        const remainingStores = Math.max(0, limits.maxStores - totalStores);
        const selectedStores = storeNames.slice(0, remainingStores);
        const dbResult = { name: info.name, version: info.version, stores: [] as Array<{ name: string; recordsScanned: number }> };
        databases.push(dbResult);
        totalStores += selectedStores.length;

        for (const storeName of selectedStores) {
          const rows = await new Promise<Array<{ key: IDBValidKey; value: unknown }>>((resolve) => {
            const collected: Array<{ key: IDBValidKey; value: unknown }> = [];
            let transaction: IDBTransaction;
            try { transaction = db.transaction(storeName, 'readonly'); }
            catch { errors.push(`INDEXEDDB_STORE_OPEN_FAILED:${info.name}/${storeName}`); resolve([]); return; }
            const store = transaction.objectStore(storeName);
            const request = store.openCursor();
            request.onerror = () => { errors.push(`INDEXEDDB_STORE_READ_FAILED:${info.name}/${storeName}`); resolve(collected); };
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { resolve(collected); return; }
              if (collected.length >= limits.maxRecordsPerStore) { errors.push(`INDEXEDDB_RECORD_LIMIT:${info.name}/${storeName}`); resolve(collected); return; }
              collected.push({ key: cursor.key, value: cursor.value });
              cursor.continue();
            };
            transaction.onabort = () => { errors.push(`INDEXEDDB_TRANSACTION_ABORTED:${info.name}/${storeName}`); resolve(collected); };
          });
          dbResult.stores.push({ name: storeName, recordsScanned: rows.length });
          totalRecords += rows.length;
          for (const row of rows) {
            if (await inspect(row.key) || await inspect(row.value)) markerFound = true;
          }
        }
      } finally {
        db.close();
      }
    }

    return { supported: true, complete: errors.length === 0, markerFound, errors, databases, totalStores, totalRecords };
  }, {
    marker,
    limits: { maxDatabases: 32, maxStores: 64, maxRecordsPerStore: 100, maxValueDepth: 8, maxObjectEntries: 256, maxBlobBytes: 1_048_576, maxBinaryBytes: 1_048_576 },
  });
}

export async function browserStorageSnapshot(page: Page, marker: string) {
  const basic = await page.evaluate(() => ({
    url: location.href,
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    cookie: document.cookie,
    html: document.documentElement.outerHTML,
  }));
  const indexedDb = await auditIndexedDbPersistence(page, marker);
  return { ...basic, indexedDb };
}
