#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const executablePath = chromium.executablePath();
if (!executablePath || !existsSync(executablePath)) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: 'BROWSER_EXECUTABLE_UNAVAILABLE' })}\n`);
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const version = browser.version();
  process.stdout.write(`${JSON.stringify({ ok: true, browser: 'chromium', version })}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({ ok: false, code: 'BROWSER_RUNTIME_UNAVAILABLE' })}\n`);
  process.exitCode = 2;
} finally {
  if (browser) await browser.close();
}
