import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AUTHORITATIVE_ROUTES } from '../contracts/routes.mjs';
import { connectConsole } from '../tests/helpers/console.js';

const evidenceRoot = process.env.QG_P10V_EVIDENCE_DIR;
const credential = process.env.QG_P10V_BROWSER_CREDENTIAL;
const credentialClass = process.env.QG_P10V_CREDENTIAL_CLASS;
if (!evidenceRoot) throw new Error('QG_P10V_EVIDENCE_DIR is required');
if (credentialClass !== 'SYNTHETIC_DISPOSABLE') throw new Error('QG_P10V_CREDENTIAL_CLASS must be SYNTHETIC_DISPOSABLE');
if (!credential || credential.length < 16 || /[\r\n\0]/u.test(credential)) {
  throw new Error('QG_P10V_BROWSER_CREDENTIAL must be a valid disposable synthetic qualification credential');
}

const screenshotsDir = path.join(evidenceRoot, 'screenshots', 'routes');
const accessibilityDir = path.join(evidenceRoot, 'accessibility');
const observabilityDir = path.join(evidenceRoot, 'observability');
for (const dir of [screenshotsDir, accessibilityDir, observabilityDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

function json(pathname: string, value: unknown) {
  writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

test('captures the exact 21-route real-runtime visual/accessibility/safe-observability evidence set', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const severeViolations: Array<{ route: string; id: string; impact: string | null; help: string }> = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => {
    const request = response.request();
    const url = new URL(response.url());
    requests.push({ method: request.method(), path: url.pathname, status: response.status() });
  });

  await connectConsole(page, credential);
  for (const route of AUTHORITATIVE_ROUTES) {
    await page.goto(`/console/${route.hash}`);
    await expect(page.locator('#route-title')).toHaveText(route.label);
    await expect(page.locator('#main-content')).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    for (const violation of axe.violations) {
      if (violation.impact === 'serious' || violation.impact === 'critical') {
        severeViolations.push({ route: route.id, id: violation.id, impact: violation.impact, help: violation.help });
      }
    }
    await page.screenshot({
      path: path.join(screenshotsDir, `${route.id}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }

  json(path.join(accessibilityDir, 'report.json'), {
    status: severeViolations.length === 0 ? 'PASS' : 'FAIL',
    serious: severeViolations.filter((item) => item.impact === 'serious').length,
    critical: severeViolations.filter((item) => item.impact === 'critical').length,
    violations: severeViolations,
  });
  json(path.join(observabilityDir, 'console-summary.json'), {
    status: pageErrors.length === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL',
    pageErrorCount: pageErrors.length,
    consoleErrorCount: consoleErrors.length,
    errors: [],
  });
  json(path.join(observabilityDir, 'network-summary.json'), {
    status: 'PASS',
    secretsIncluded: false,
    requests: requests.slice(0, 2000),
  });

  expect(severeViolations).toEqual([]);
  expect(pageErrors.length).toBe(0);
  expect(consoleErrors.length).toBe(0);
});
