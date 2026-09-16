import { defineConfig } from '@playwright/test';
import path from 'node:path';

const port = Number(process.env.QG_E2E_PORT || 4187);
const baseURL = `http://127.0.0.1:${port}/console/`;
const evidenceRoot = process.env.QG_E2E_EVIDENCE_DIR ? path.resolve(process.env.QG_E2E_EVIDENCE_DIR) : null;

export default defineConfig({
  testDir: './tests',
  outputDir: evidenceRoot ? path.join(evidenceRoot, 'test-results') : path.join('/tmp', 'qg-e2e-results'),
  timeout: 20_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: evidenceRoot
    ? [['json', { outputFile: path.join(evidenceRoot, 'results.json') }]]
    : [['list']],
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'node mock-server.mjs',
    cwd: path.resolve('e2e'),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 15_000,
    env: { QG_E2E_PORT: String(port) },
  },
  projects: [
    { name: 'chromium-workstation', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'chromium-narrow', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
});
