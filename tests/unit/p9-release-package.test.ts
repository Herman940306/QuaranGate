import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createReleasePackageManifest,
  releaseSignaturePayload,
  verifyReleasePackageManifest,
  verifyReleasePayload,
  verifyReleaseSignature,
  verifyReleaseTrustPolicy,
} from '../../src/installer/releasePackage.js';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const gitA = '1'.repeat(40);
const lifecycle0 = {
  configSchemaVersion: 0,
  stateSchemaVersion: 0,
  components: ['gateway'],
  migrations: [],
};
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
      lifecycle: lifecycle0,
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
      lifecycle: lifecycle0,
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

  it('requires the lifecycle component set to exactly match OCI image component identities', () => {
    expect(() => createReleasePackageManifest({
      schemaVersion: 1,
      productVersion: '0.1.0',
      sourceCommit: gitA,
      createdAt: '2026-09-15T00:00:00.000Z',
      architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
      signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
      lifecycle: lifecycle0,
      files: [{ path: 'dist/index.js', sizeBytes: 1, digest: shaA, mode: 0o644 }],
      images: [{ component: 'executor', reference: `executor:git-${gitA}`, digest: `sha256:${shaA}` }],
    })).toThrow(/component.*image|image.*component/iu);
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
      lifecycle: lifecycle0,
      files: [{ path: 'dist/index.js', sizeBytes: bytes.length, digest, mode: 0o644 }],
      images: [{ component: 'gateway', reference: `gateway:git-${gitA}`, digest: `sha256:${shaA}` }],
    });
    expect(verifyReleasePayload(manifest, () => bytes).verifiedFiles).toBe(1);
    expect(() => verifyReleasePayload(manifest, () => Buffer.from('tampered'))).toThrow(/integrity/u);
  });
});

describe('P9 detached release signing trust', () => {
  function unsignedManifest(createdAt = '2026-09-15T00:00:00.000Z') {
    return createReleasePackageManifest({
      schemaVersion: 1,
      productVersion: '0.1.0',
      sourceCommit: gitA,
      createdAt,
      architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
      signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
      lifecycle: lifecycle0,
      files: [{ path: 'dist/index.js', sizeBytes: 1, digest: shaA, mode: 0o644 }],
      images: [{ component: 'gateway', reference: `gateway:git-${gitA}`, digest: `sha256:${shaA}` }],
    });
  }

  it('validates an installer-owned trust policy independently from release material', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const policy = {
      schemaVersion: 1 as const,
      policyId: 'production-release-policy',
      trustedKeys: [{
        keyId: 'release-key-a',
        algorithm: 'Ed25519' as const,
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }],
    };
    expect(verifyReleaseTrustPolicy(policy)).toEqual(policy);
    expect(() => verifyReleaseTrustPolicy({ ...policy, trustedKeys: [] })).toThrow(/trust policy/iu);
    expect(() => verifyReleaseTrustPolicy({ ...policy, unknown: true } as never)).toThrow(/unknown|fields/iu);
  });

  it('refuses caller self-assertion of SIGNED and missing or malformed proof', () => {
    expect(() => createReleasePackageManifest({
      ...unsignedManifest(),
      signing: 'SIGNED',
    } as never)).toThrow(/identity|sign/iu);

    const manifest = unsignedManifest();
    const { publicKey } = generateKeyPairSync('ed25519');
    const trust = [{
      keyId: 'release-key-a',
      algorithm: 'Ed25519' as const,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }];
    expect(() => verifyReleaseSignature(manifest, undefined as never, trust)).toThrow(/proof/iu);
    expect(() => verifyReleaseSignature(manifest, {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: 'release-key-a',
      manifestDigest: manifest.manifestDigest,
      signedAt: '2026-09-15T00:01:00.000Z',
      signature: 'not-base64!',
    }, trust)).toThrow(/signature|proof/iu);
  });

  it('verifies an Ed25519 proof and refuses wrong manifest or trust identity', () => {
    const manifest = unsignedManifest();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const proof = {
      schemaVersion: 1 as const,
      algorithm: 'Ed25519' as const,
      keyId: 'release-key-a',
      manifestDigest: manifest.manifestDigest,
      signedAt: '2026-09-15T00:01:00.000Z',
      signature: sign(null, releaseSignaturePayload(manifest), privateKey).toString('base64'),
    };
    const trustedKey = {
      keyId: 'release-key-a',
      algorithm: 'Ed25519' as const,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };

    expect(verifyReleaseSignature(manifest, proof, [trustedKey]).signingIdentity.keyId).toBe('release-key-a');
    expect(() => verifyReleaseSignature(unsignedManifest('2026-09-15T00:02:00.000Z'), proof, [trustedKey]))
      .toThrow(/manifest|digest/iu);

    const other = generateKeyPairSync('ed25519').publicKey;
    expect(() => verifyReleaseSignature(manifest, proof, [{
      keyId: 'release-key-b',
      algorithm: 'Ed25519',
      publicKeyPem: other.export({ type: 'spki', format: 'pem' }).toString(),
    }])).toThrow(/trusted|identity/iu);
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
