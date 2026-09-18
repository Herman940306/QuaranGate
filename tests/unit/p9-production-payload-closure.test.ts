import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReleasePackageManifest } from '../../src/installer/releasePackage.js';
import { verifyProductionReleasePayloadClosure } from '../../src/installer/productionRelease.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'qg-p9-closure-'));
  const root = path.join(base, 'payload');
  mkdirSync(path.join(root, 'dist', 'installer'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const payloads = new Map<string, Buffer>([
    ['compose.yaml', Buffer.from('compose')],
    ['dist/installer/cli.js', Buffer.from('export {};')],
    ['scripts/start.sh', Buffer.from('#!/bin/sh\n')],
  ]);
  for (const [relative, bytes] of payloads) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const files = [...payloads.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([relative, bytes]) => ({
    path: relative,
    sizeBytes: bytes.length,
    digest: hash(bytes),
    mode: relative === 'scripts/start.sh' ? 0o755 as const : 0o644 as const,
  }));
  const sourceCommit = 'a'.repeat(40);
  const manifest = createReleasePackageManifest({
    schemaVersion: 1,
    productVersion: '1.0.0',
    sourceCommit,
    createdAt: '2026-09-18T00:00:00.000Z',
    architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
    signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
    lifecycle: {
      configSchemaVersion: 0,
      stateSchemaVersion: 0,
      components: ['gateway'],
      migrations: [],
    },
    files,
    images: [{
      component: 'gateway',
      reference: 'quarangate:gateway-' + sourceCommit,
      digest: 'sha256:' + '1'.repeat(64),
    }],
  });
  return { base, root, manifest };
}

describe('P9 production release payload closure', () => {
  it('accepts an exact manifest-declared tree', () => {
    const value = fixture();
    expect(verifyProductionReleasePayloadClosure(value.root, value.manifest)).toEqual({
      files: 3,
      directories: 3,
    });
  });

  it('refuses an unmanifested regular file', () => {
    const value = fixture();
    writeFileSync(path.join(value.root, 'extra.txt'), 'extra');
    expect(() => verifyProductionReleasePayloadClosure(value.root, value.manifest)).toThrow(/unmanifested file/iu);
  });

  it('refuses an unmanifested empty directory', () => {
    const value = fixture();
    mkdirSync(path.join(value.root, 'extra-dir'));
    expect(() => verifyProductionReleasePayloadClosure(value.root, value.manifest)).toThrow(/unmanifested directory/iu);
  });

  it('refuses a symlinked file', () => {
    const value = fixture();
    symlinkSync(path.join(value.root, 'compose.yaml'), path.join(value.root, 'extra-link'));
    expect(() => verifyProductionReleasePayloadClosure(value.root, value.manifest)).toThrow(/symlink/iu);
  });

  it('refuses a symlinked directory', () => {
    const value = fixture();
    symlinkSync(path.join(value.root, 'dist'), path.join(value.root, 'dist-link'), 'dir');
    expect(() => verifyProductionReleasePayloadClosure(value.root, value.manifest)).toThrow(/symlink/iu);
  });

  it('refuses hard-linked manifest files', () => {
    const value = fixture();
    linkSync(path.join(value.root, 'compose.yaml'), path.join(value.root, 'compose-copy.yaml'));
    expect(() => verifyProductionReleasePayloadClosure(value.root, value.manifest)).toThrow(/unsafe filesystem entry/iu);
  });

  it('refuses a missing manifest-declared file', () => {
    const value = fixture();
    rmSync(path.join(value.root, 'compose.yaml'));
    expect(() => verifyProductionReleasePayloadClosure(value.root, value.manifest)).toThrow(/missing one or more manifest-declared files/iu);
  });

  it('refuses a noncanonical package root', () => {
    const value = fixture();
    expect(() => verifyProductionReleasePayloadClosure(value.root + path.sep + '.', value.manifest))
      .toThrow(/canonical absolute/iu);
  });

  it('refuses a symlinked package root', () => {
    const value = fixture();
    const alias = path.join(value.base, 'payload-link');
    symlinkSync(value.root, alias, 'dir');
    expect(() => verifyProductionReleasePayloadClosure(alias, value.manifest)).toThrow(/real non-symlink directory/iu);
  });
});
