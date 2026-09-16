import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const createdDirs: string[] = [];
afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const exact = {
  semgrep: '1.177.0', gitleaks: '8.30.1', 'osv-scanner': '2.6.0', trivy: '0.74.0', cosign: '3.1.3',
};

function fakeToolDir(overrides: Record<string,string> = {}) {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules/.qg-toolchain-'));
  createdDirs.push(dir);
  for (const [name, version] of Object.entries(exact)) {
    const shown = overrides[name] ?? version;
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name} version v${shown}'\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

describe('SH-05 pinned security toolchain', () => {
  it('passes only when every required scanner reports its exact pinned version', () => {
    const dir = fakeToolDir();
    const r = spawnSync(process.execPath, ['scripts/security-toolchain.mjs'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } });
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(true);
    expect(report.tools.every((t: any) => t.status === 'PASS')).toBe(true);
    expect(report.acquisitionPolicy).toBe('NO_AUTO_DOWNLOAD_OWNER_PROVIDED_VERIFIED_ARTIFACTS_ONLY');
  });

  it('fails closed on a scanner version mismatch', () => {
    const dir = fakeToolDir({ trivy: '0.73.0' });
    const r = spawnSync(process.execPath, ['scripts/security-toolchain.mjs'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } });
    expect(r.status).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.tools.find((t: any) => t.id === 'trivy').status).toBe('VERSION_MISMATCH');
  });

  it('rejects a version that merely contains the pinned version as a prefix', () => {
    const dir = fakeToolDir({ semgrep: '1.177.0-rc1' });
    const r = spawnSync(process.execPath, ['scripts/security-toolchain.mjs'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` } });
    expect(r.status).toBe(2);
    const report = JSON.parse(r.stdout);
    expect(report.tools.find((t: any) => t.id === 'semgrep').status).toBe('VERSION_MISMATCH');
  });

  it('fails closed when required binaries are absent, while report-only remains inspectable', () => {
    const dir = fakeToolDir();
    const r = spawnSync(process.execPath, ['scripts/security-toolchain.mjs', '--report-only'], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.tools.every((t: any) => t.status === 'ABSENT')).toBe(true);
  });
});
