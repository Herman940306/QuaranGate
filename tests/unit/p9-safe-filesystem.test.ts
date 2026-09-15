import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readPrivateFile,
  safeRemoveOwnedTree,
} from '../../src/lifecycle/safeFilesystem.js';

describe('P9 lifecycle filesystem safety', () => {
  it('atomically writes private files under a canonical trusted root', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qg-p9-fs-'));
    const root = join(outer, 'state');
    ensurePrivateDirectory(root);
    atomicWritePrivateFile(root, 'manifests/install.json', Buffer.from('{"ok":true}', 'utf8'));
    const target = join(root, 'manifests/install.json');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}');
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(root, 'manifests')).mode & 0o777).toBe(0o700);
  });

  it('rejects traversal, symlink destinations, and hard-linked existing files', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qg-p9-fs-'));
    const root = join(outer, 'state');
    ensurePrivateDirectory(root);
    expect(() => atomicWritePrivateFile(root, '../escape', Buffer.from('x'))).toThrow(/path/u);

    const outside = join(outer, 'outside');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root, 'symlink'));
    expect(() => atomicWritePrivateFile(root, 'symlink', Buffer.from('x'))).toThrow(/symbolic link/u);

    writeFileSync(join(root, 'first'), 'first', { mode: 0o600 });
    linkSync(join(root, 'first'), join(root, 'second'));
    expect(() => atomicWritePrivateFile(root, 'second', Buffer.from('x'))).toThrow(/hard link/u);
  });

  it('applies the same link, mode, and size checks to lifecycle reads', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qg-p9-fs-'));
    const root = join(outer, 'state');
    ensurePrivateDirectory(root);
    atomicWritePrivateFile(root, 'safe.json', Buffer.from('{"safe":true}'));
    expect(readPrivateFile(root, 'safe.json').toString('utf8')).toBe('{"safe":true}');
    expect(() => readPrivateFile(root, 'safe.json', 2)).toThrow(/limit/u);

    const outside = join(outer, 'outside-read');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root, 'read-link'));
    expect(() => readPrivateFile(root, 'read-link')).toThrow(/symbolic link/u);
  });

  it('refuses a trusted root whose existing path crosses a symlink', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qg-p9-fs-'));
    const real = join(outer, 'real');
    mkdirSync(real);
    symlinkSync(real, join(outer, 'alias'));
    expect(() => ensurePrivateDirectory(join(outer, 'alias', 'state'))).toThrow(/symbolic link/u);
  });

  it('removes only an explicitly allowlisted owned tree and refuses unsafe entries', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qg-p9-fs-'));
    const root = join(outer, 'state');
    ensurePrivateDirectory(join(root, 'cache'));
    writeFileSync(join(root, 'cache', 'item'), 'cache');
    safeRemoveOwnedTree(root, 'cache', ['cache', 'evidence']);
    expect(existsSync(join(root, 'cache'))).toBe(false);

    ensurePrivateDirectory(join(root, 'models'));
    expect(() => safeRemoveOwnedTree(root, 'models', ['cache', 'evidence'])).toThrow(/allowlisted/u);

    ensurePrivateDirectory(join(root, 'evidence'));
    const outside = join(outer, 'outside-dir');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'evidence', 'escape'));
    expect(() => safeRemoveOwnedTree(root, 'evidence', ['cache', 'evidence'])).toThrow(/symbolic link/u);
    expect(existsSync(outside)).toBe(true);
  });

  it('refuses unsafe directory permissions instead of silently widening them', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qg-p9-fs-'));
    const root = join(outer, 'state');
    mkdirSync(root, { mode: 0o777 });
    chmodSync(root, 0o777);
    expect(() => ensurePrivateDirectory(root)).toThrow(/permissions/u);
  });
});
