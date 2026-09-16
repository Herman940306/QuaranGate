import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

describe('SH-05 security invariant gate', () => {
  it('passes the canonical authority topology', () => {
    const r = spawnSync(process.execPath, ['scripts/security-invariants.mjs'], { encoding: 'utf8' });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(true);
    expect(body.failures).toEqual([]);
  });

  it('is wired as a release-blocking package script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['security:invariants']).toBe('node scripts/security-invariants.mjs');
  });
});
