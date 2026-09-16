import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const createdDirs: string[] = [];
afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const exact = {
  semgrep: '1.177.0', gitleaks: '8.30.0', 'osv-scanner': '2.6.0', trivy: '0.74.0', cosign: '3.1.3',
};

function fakeToolDir(overrides: Record<string,string> = {}, options: { gitleaksCanaryPass?: boolean } = {}) {
  const dir = mkdtempSync(join(process.cwd(), 'node_modules/.qg-toolchain-'));
  createdDirs.push(dir);
  for (const [name, version] of Object.entries(exact)) {
    const shown = overrides[name] ?? version;
    const file = join(dir, name);
    if (name === 'gitleaks') {
      const canaryPass = options.gitleaksCanaryPass !== false;
      writeFileSync(file, `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst a=process.argv.slice(2);\nif(a[0]==='version'){console.log('gitleaks version v${shown}');process.exit(0);}\nif(a[0]==='dir'){const i=a.indexOf('--report-path');if(i>=0&&a[i+1])fs.writeFileSync(a[i+1],${canaryPass ? "JSON.stringify([{RuleID:'github-pat',Fingerprint:'canary'}])" : "'[]'"});process.exit(${canaryPass ? 1 : 0});}\nprocess.exit(9);\n`);
    } else {
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name} version v${shown}'\n`);
    }
    chmodSync(file, 0o755);
  }
  return dir;
}

function run(dir: string, extra: string[] = []) {
  return spawnSync(process.execPath, ['scripts/security-toolchain.mjs', ...extra], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
  });
}

describe('SH-05 pinned security toolchain', () => {
  it('passes only when every required scanner reports its exact pinned version and Gitleaks detects the canary', () => {
    const r = run(fakeToolDir());
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(true);
    expect(report.tools.every((t: any) => t.status === 'PASS')).toBe(true);
    expect(report.tools.find((t: any) => t.id === 'gitleaks').functionalCanary).toMatchObject({ status: 'PASS', findingCount: 1 });
    expect(report.acquisitionPolicy).toBe('NO_AUTO_DOWNLOAD_OWNER_PROVIDED_VERIFIED_ARTIFACTS_ONLY');
  });

  it('fails closed on a scanner version mismatch', () => {
    const r = run(fakeToolDir({ trivy: '0.73.0' }));
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).tools.find((t: any) => t.id === 'trivy').status).toBe('VERSION_MISMATCH');
  });

  it('rejects a version that merely contains the pinned version as a prefix', () => {
    const r = run(fakeToolDir({ semgrep: '1.177.0-rc1' }));
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).tools.find((t: any) => t.id === 'semgrep').status).toBe('VERSION_MISMATCH');
  });

  it('fails closed when the pinned Gitleaks binary has the known silent-detection failure class', () => {
    const r = run(fakeToolDir({}, { gitleaksCanaryPass: false }));
    expect(r.status).toBe(2);
    const tool = JSON.parse(r.stdout).tools.find((t: any) => t.id === 'gitleaks');
    expect(tool.status).toBe('FUNCTIONAL_CANARY_FAILED');
    expect(tool.functionalCanary).toMatchObject({ status: 'FAIL', scannerExitCode: 0, findingCount: 0 });
  });

  it('fails closed when required binaries are absent, while report-only remains inspectable', () => {
    const r = spawnSync(process.execPath, ['scripts/security-toolchain.mjs', '--report-only'], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.tools.every((t: any) => t.status === 'ABSENT')).toBe(true);
  });
});
