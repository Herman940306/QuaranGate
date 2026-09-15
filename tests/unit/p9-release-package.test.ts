import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createReleasePackageManifest,
  verifyReleasePackageManifest,
  verifyReleasePayload,
} from '../../src/installer/releasePackage.js';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const gitA = '1'.repeat(40);
const root = resolve(import.meta.dirname, '../..');

describe('P9 deterministic release package', () => {
  it('binds every payload file and OCI image to immutable identity', () => {
    const manifest = createReleasePackageManifest({
      schemaVersion: 1,
      productVersion: '0.1.0',
      sourceCommit: gitA,
      createdAt: '2026-09-15T00:00:00.000Z',
      architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
      signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
      files: [
        { path: 'dist/installer/cli.js', sizeBytes: 10, digest: shaA, mode: 0o644 },
        { path: 'scripts/windows/QuaranGate-Setup.ps1', sizeBytes: 20, digest: shaB, mode: 0o644 },
      ],
      images: [{
        component: 'gateway',
        reference: `quarangate-gateway:git-${gitA}`,
        digest: `sha256:${shaA}`,
      }],
    });
    expect(verifyReleasePackageManifest(manifest)).toEqual(manifest);
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(manifest)).not.toMatch(/token|password|secret-value/u);
  });

  it('refuses mutable image references, traversal, secret-like payload paths, and unsorted files', () => {
    const base = {
      schemaVersion: 1 as const,
      productVersion: '0.1.0',
      sourceCommit: gitA,
      createdAt: '2026-09-15T00:00:00.000Z',
      architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE' as const,
      signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL' as const,
      images: [{ component: 'gateway', reference: 'gateway:latest', digest: `sha256:${shaA}` }],
    };
    expect(() => createReleasePackageManifest({
      ...base,
      files: [{ path: '../escape', sizeBytes: 1, digest: shaA, mode: 0o644 }],
    })).toThrow(/path/u);
    expect(() => createReleasePackageManifest({
      ...base,
      files: [{ path: 'config/.env', sizeBytes: 1, digest: shaA, mode: 0o644 }],
    })).toThrow(/secret|credential/u);
    expect(() => createReleasePackageManifest({
      ...base,
      files: [
        { path: 'z/file', sizeBytes: 1, digest: shaA, mode: 0o644 },
        { path: 'a/file', sizeBytes: 1, digest: shaB, mode: 0o644 },
      ],
    })).toThrow(/sorted/u);
    expect(() => createReleasePackageManifest({
      ...base,
      images: [{ component: 'gateway', reference: 'gateway:latest', digest: `sha256:${shaA}` }],
      files: [{ path: 'dist/index.js', sizeBytes: 1, digest: shaA, mode: 0o644 }],
    })).toThrow(/mutable/u);
  });

  it('re-hashes payload bytes and fails closed on size or digest mismatch', () => {
    const bytes = Buffer.from('payload', 'utf8');
    const digest = '239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5';
    const manifest = createReleasePackageManifest({
      schemaVersion: 1,
      productVersion: '0.1.0',
      sourceCommit: gitA,
      createdAt: '2026-09-15T00:00:00.000Z',
      architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
      signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
      files: [{ path: 'dist/index.js', sizeBytes: bytes.length, digest, mode: 0o644 }],
      images: [{ component: 'gateway', reference: `gateway:git-${gitA}`, digest: `sha256:${shaA}` }],
    });
    expect(verifyReleasePayload(manifest, () => bytes).verifiedFiles).toBe(1);
    expect(() => verifyReleasePayload(manifest, () => Buffer.from('tampered'))).toThrow(/integrity/u);
  });
});

describe('P9 Windows click-install source boundary', () => {
  it('uses a native guided UI and the accepted WSL boundary without hidden elevation', () => {
    const setup = readFileSync(resolve(root, 'scripts/windows/QuaranGate-Setup.ps1'), 'utf8');
    const launcher = readFileSync(resolve(root, 'scripts/windows/QuaranGate-Setup.cmd'), 'utf8');
    expect(setup).toContain('System.Windows.Forms');
    expect(setup).toContain('ShowDialog()');
    expect(setup).toContain('UPSTREAM_P7_PENDING');
    expect(setup).toContain('http://127.0.0.1:8787');
    expect(setup).toContain("'--exec', 'node'");
    expect(setup).toContain('PLAN_REVIEW_REQUIRED');
    expect(setup).not.toMatch(/netsh|portproxy|\/var\/run\/docker\.sock|RunAs|ExecutionPolicy Bypass/u);
    expect(setup).not.toMatch(/mcpb_|API_KEY=|TOKEN=/u);
    expect(launcher).toContain('-ExecutionPolicy RemoteSigned');
    expect(launcher).not.toContain('Bypass');
  });
});
