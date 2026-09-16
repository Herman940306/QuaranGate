import { describe, expect, it } from 'vitest';
import { validateRelativePath, joinWorkspace, isInside } from '../../src/shared/pathcheck.js';
import {
  validateApplyPath, validateGuardPattern, matchesGuardPattern, escapeGuardLiteralPath,
} from '../../src/executor/agents/applyPolicy.js';
import { canonicalizeWorkspaceEntryPath, validateTarEntryPath } from '../../src/executor/agents/beforeCapture.js';
import { assertAllowedEvidencePath, blobPath, readBounded } from '../../src/executor/agents/artifactReader.js';
import { HOSTILE_CODEPOINTS, SAFE_PATH_CODEPOINTS, runProperty, Sh08Prng } from '../helpers/sh08Property.js';

function accepted<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try { return { ok: true, value: fn() }; } catch { return { ok: false }; }
}

function safeSegment(rng: Sh08Prng): string {
  let s = rng.string(SAFE_PATH_CODEPOINTS, 16, 1).replaceAll('/', '').replaceAll('\\', '');
  if (s === '.' || s === '..' || s.toLowerCase() === '.git') s = `x${s}x`;
  return s || 'x';
}

describe('SH-08 path / guard / archive properties', () => {
  it('arbitrary accepted workspace paths are normalized, traversal-free and confined', () => {
    runProperty('workspace-path-confinement', { seed: 0x08a001, iterations: 2500 }, (rng) => {
      const raw = rng.string(HOSTILE_CODEPOINTS, 64);
      const r = accepted(() => validateRelativePath(raw));
      if (!r.ok) return;
      const rel = r.value;
      expect(rel).not.toContain('\\');
      expect(rel).not.toMatch(/[\x00-\x1f\x7f]/u);
      expect(rel.startsWith('/')).toBe(false);
      expect(rel.split('/')).not.toContain('..');
      expect(validateRelativePath(rel)).toBe(rel);
      const joined = joinWorkspace('/workspace', rel);
      expect(isInside('/workspace', joined)).toBe(true);
    });
  });

  it('every generated accepted apply path is exactly guardable without wildcard widening', () => {
    runProperty('apply-path-exact-guard', { seed: 0x08a002, iterations: 2500 }, (rng) => {
      const path = Array.from({ length: 1 + rng.int(4) }, () => safeSegment(rng)).join('/');
      const canonical = validateApplyPath(path);
      const guard = escapeGuardLiteralPath(canonical);
      expect(validateGuardPattern(guard)).toBe(guard);
      expect(matchesGuardPattern(canonical, guard)).toBe(true);
      const other = `${canonical}.__sh08_other__`;
      expect(matchesGuardPattern(other, guard)).toBe(false);
    });
  });

  it('arbitrary accepted archive names cannot canonicalize to absolute/traversal/backslash paths', () => {
    runProperty('archive-path-confinement', { seed: 0x08a003, iterations: 3000 }, (rng) => {
      const raw = rng.string(HOSTILE_CODEPOINTS, 72);
      const r = accepted(() => canonicalizeWorkspaceEntryPath(raw));
      if (!r.ok || r.value === '') return;
      const rel = r.value;
      expect(rel.startsWith('/')).toBe(false);
      expect(rel.includes('\\')).toBe(false);
      expect(rel.includes('\0')).toBe(false);
      expect(rel.split('/')).not.toContain('..');
      expect(validateTarEntryPath(rel)).toBe(rel);
    });
  });

  it('evidence storage accepts only fixed manifest names or hash-derived blob paths', () => {
    const fixed = new Set(['artifact-manifest.json', 'before-snapshot-manifest.json', 'post-snapshot-manifest.json']);
    runProperty('evidence-path-allowlist', { seed: 0x08a004, iterations: 2500 }, (rng) => {
      const raw = rng.string(HOSTILE_CODEPOINTS, 96);
      const r = accepted(() => assertAllowedEvidencePath(raw));
      if (!r.ok) return;
      const blob = /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/u.test(raw);
      expect(fixed.has(raw) || blob).toBe(true);
    });
    runProperty('blob-path-roundtrip', { seed: 0x08a005, iterations: 1000 }, (rng) => {
      let hash = '';
      for (let i = 0; i < 64; i++) hash += rng.pick('0123456789abcdef'.split(''));
      const p = blobPath(hash);
      expect(p).toBe(`blobs/${hash.slice(0, 2)}/${hash}`);
      expect(() => assertAllowedEvidencePath(p)).not.toThrow();
    });
  });

  it('bounded evidence reads never return more bytes than their configured maximum', async () => {
    const rng = new Sh08Prng(0x08a006);
    for (let i = 0; i < 250; i++) {
      const max = 1 + rng.int(512);
      const sizes = Array.from({ length: 1 + rng.int(10) }, () => rng.int(128));
      async function* chunks() { for (const n of sizes) yield Buffer.alloc(n, 0x61); }
      const total = sizes.reduce((a, b) => a + b, 0);
      if (total <= max) expect((await readBounded(chunks(), max)).length).toBe(total);
      else await expect(readBounded(chunks(), max)).rejects.toThrow(/maximum allowed size/u);
    }
  });
});
