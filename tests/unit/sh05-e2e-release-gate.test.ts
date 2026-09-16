import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('SH-05 canonical rendered-browser release gate', () => {
  it('pins the accepted Playwright/Axe/fflate package set exactly', () => {
    const pkg = readJson('e2e/package.json');
    const lock = readJson('e2e/package-lock.json');
    expect(pkg.name).toBe('quarangate-release-e2e');
    expect(pkg.devDependencies).toEqual({
      '@axe-core/playwright': '4.13.0',
      '@playwright/test': '1.63.0',
      fflate: '0.8.3',
    });
    expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
    expect(lock.packages['node_modules/@playwright/test'].version).toBe('1.63.0');
    expect(lock.packages['node_modules/@axe-core/playwright'].version).toBe('4.13.0');
    expect(lock.packages['node_modules/fflate'].version).toBe('0.8.3');
  });

  it('freezes a deterministic two-viewport zero-retry browser profile', () => {
    const config = readFileSync('e2e/playwright.config.ts', 'utf8');
    for (const contract of [
      'fullyParallel: false', 'workers: 1', 'retries: 0', 'forbidOnly: true',
      "locale: 'en-US'", "timezoneId: 'UTC'", 'deviceScaleFactor: 1',
      "name: 'chromium-workstation'", 'width: 1440', 'height: 900',
      "name: 'chromium-narrow'", 'width: 390', 'height: 844',
      "serviceWorkers: 'block'",
    ]) expect(config).toContain(contract);
  });

  it('binds the mock server to the current clean Git source rather than historical U1 hashes', () => {
    const current = readFileSync('e2e/contracts/current-source.mjs', 'utf8');
    const server = readFileSync('e2e/mock-server.mjs', 'utf8');
    expect(current).toContain("rev-parse', 'HEAD'");
    expect(current).toContain("rev-parse', 'HEAD^{tree}'");
    expect(current).toContain("status', '--porcelain=v1', '--untracked-files=all'");
    expect(server).toContain('CURRENT_SOURCE_IDENTITY');
    const combined = `${current}\n${server}`;
    for (const forbidden of ['FROZEN_U1', 'EXPECTED_U1', 'cdc78600f6e2f1ee7dbe022d86cbec6727d309a9', 'b01015c4c2854881aeac7cab6e2caf45d978a75d']) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it('keeps rendered tests synthetic and source-local', () => {
    const server = readFileSync('e2e/mock-server.mjs', 'utf8');
    expect(server).toContain("server.listen(port, '127.0.0.1'");
    expect(server).toContain('SYNTHETIC_BROWSER_CREDENTIALS');
    expect(server).not.toMatch(/0\.0\.0\.0|owner credential|production customer/iu);
  });
});
