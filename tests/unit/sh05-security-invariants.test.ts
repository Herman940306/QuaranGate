import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(root = '.') {
  return spawnSync(process.execPath, ['scripts/security-invariants.mjs', '--root', root], { encoding: 'utf8' });
}
function fixture(compose: string, source = '') {
  const d = mkdtempSync(join(tmpdir(), 'qg-sh05-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  mkdirSync(join(d, 'src', 'gateway'), { recursive: true });
  writeFileSync(join(d, 'compose.yaml'), compose);
  writeFileSync(join(d, 'src', 'gateway', 'x.ts'), source);
  return d;
}
const safeCompose = `services:\n  gateway:\n    image: qg\n  executor:\n    image: qg\n  docker-authority:\n    image: qg\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`;

describe('SH-05 security invariant gate', () => {
  it('passes the canonical authority topology and scans all compose/docker surfaces', () => {
    const r = run();
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(true);
    expect(body.failures).toEqual([]);
    expect(body.composeFilesChecked).toBeGreaterThan(1);
    expect(body.dockerfilesChecked).toBeGreaterThan(1);
  });
  it('is wired as a release-blocking package script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['security:invariants']).toBe('node scripts/security-invariants.mjs');
  });
  it('fails closed on privileged executor', () => {
    const r = run(fixture(safeCompose.replace('executor:\n    image: qg', 'executor:\n    image: qg\n    privileged: true')));
    expect(r.status).toBe(1); expect(r.stdout).toContain('NO_PRIVILEGED_SERVICE');
  });
  it('fails closed when executor regains raw docker socket authority', () => {
    const r = run(fixture(safeCompose.replace('executor:\n    image: qg', 'executor:\n    image: qg\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock')));
    expect(r.status).toBe(1); expect(r.stdout).toContain('NO_RAW_DOCKER_AUTHORITY');
  });
  it('fails closed on caller-controlled HostConfig in source', () => {
    const r = run(fixture(safeCompose, 'const x = { HostConfig: input };'));
    expect(r.status).toBe(1); expect(r.stdout).toContain('NO_CALLER_HOSTCONFIG');
  });
});
