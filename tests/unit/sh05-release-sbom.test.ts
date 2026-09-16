import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('SH-05 deterministic npm SBOM', () => {
  it('emits deterministic SPDX bound to the exact lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-sbom-'));
    const a = join(dir, 'a.json'); const b = join(dir, 'b.json');
    for (const out of [a,b]) {
      const r = spawnSync(process.execPath, ['scripts/release-sbom.mjs', '--output', out], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
    const aa = readFileSync(a); const bb = readFileSync(b);
    expect(aa.equals(bb)).toBe(true);
    const doc = JSON.parse(aa.toString('utf8'));
    expect(doc.spdxVersion).toBe('SPDX-2.3');
    expect(doc.packages.length).toBeGreaterThan(1);
    const lockSha = createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
    expect(doc.documentNamespace).toContain(lockSha);
    expect(doc.annotations[0].comment).toContain(lockSha);
  });
});
