import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { externalOutputPath, externalPrivateEvidenceDirectory, pathIsWithinRoot } from '../../scripts/release-path-safety.mjs';

const owned: string[] = [];
afterEach(() => { while (owned.length) rmSync(owned.pop()!, { recursive: true, force: true }); });
function temp(prefix: string) { const root = mkdtempSync(join(tmpdir(), prefix)); owned.push(root); return root; }

describe('SH-05 release evidence path containment', () => {
  it('accepts real external output parents and rejects direct source paths', () => {
    const source = temp('qg-source-'); const evidence = temp('qg-evidence-');
    expect(pathIsWithinRoot(source, join(source, 'receipt.json'))).toBe(true);
    expect(externalOutputPath(source, join(evidence, 'receipt.json'), '--output')).toBe(join(evidence, 'receipt.json'));
    expect(() => externalOutputPath(source, join(source, 'receipt.json'), '--output')).toThrow(/outside the Git worktree/u);
  });

  it('rejects an external-looking parent symlink that resolves back into source', () => {
    const source = temp('qg-source-link-'); const outside = temp('qg-outside-link-'); const target = join(source, 'evidence'); mkdirSync(target);
    const link = join(outside, 'redirect'); symlinkSync(target, link, 'dir');
    expect(() => externalOutputPath(source, join(link, 'receipt.json'), '--output')).toThrow(/outside the Git worktree/u);
  });

  it('rejects an existing output symlink even when its parent is external', () => {
    const source = temp('qg-source-filelink-'); const outside = temp('qg-outside-filelink-'); const sourceFile = join(source, 'receipt.json'); writeFileSync(sourceFile, '{}');
    const link = join(outside, 'receipt.json'); symlinkSync(sourceFile, link, 'file');
    expect(() => externalOutputPath(source, link, '--output')).toThrow(/symbolic link/u);
  });

  it('requires a fresh empty owner-only external evidence directory', () => {
    const source = temp('qg-source-dir-'); const parent = temp('qg-evidence-parent-'); const evidence = join(parent, 'run');
    expect(externalPrivateEvidenceDirectory(source, evidence)).toBe(evidence);
    writeFileSync(join(evidence, 'stale'), 'x');
    expect(() => externalPrivateEvidenceDirectory(source, evidence)).toThrow(/must be empty/u);
    rmSync(join(evidence, 'stale'));
    if (process.platform !== 'win32') {
      chmodSync(evidence, 0o755);
      expect(() => externalPrivateEvidenceDirectory(source, evidence)).toThrow(/owner-only/u);
    }
  });
});
