import { defineConfig } from '@playwright/test';
import { existsSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateP10vRuntimeUrl } from './contracts/p10v-visual-evidence.mjs';
import { externalOutputPath } from '../scripts/release-path-safety.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const baseURL = validateP10vRuntimeUrl(process.env.QG_P10V_BASE_URL ?? '');
const evidenceRaw = process.env.QG_P10V_EVIDENCE_DIR;
if (!evidenceRaw) throw new Error('QG_P10V_EVIDENCE_DIR is required');
const evidenceRoot = externalOutputPath(sourceRoot, evidenceRaw, 'QG_P10V_EVIDENCE_DIR');
if (!existsSync(evidenceRoot) || lstatSync(evidenceRoot).isSymbolicLink() || !statSync(evidenceRoot).isDirectory()) {
  throw new Error('QG_P10V_EVIDENCE_DIR must be an existing real directory prepared by p10v-readiness.mjs');
}

export default defineConfig({
  testDir: './p10v-tests',
  outputDir: path.join(evidenceRoot, 'playwright', 'test-results'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['json', { outputFile: path.join(evidenceRoot, 'playwright', 'results.json') }],
    ['list'],
  ],
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'p10v-real-runtime-chromium', use: { browserName: 'chromium' } }],
});
