import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVerifiedProductionRelease } from '../../src/installer/cli.js';
import {
  createReleasePackageManifest,
  releaseSignaturePayload,
  type ReleaseTrustPolicy,
} from '../../src/installer/releasePackage.js';
import {
  PRODUCTION_REQUIRED_PAYLOAD_FILES,
  PRODUCTION_RUNTIME_COMPONENTS,
} from '../../src/installer/productionRelease.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'qg-p9-production-cli-'));
  const payloadRoot = path.join(temp, 'payload');
  mkdirSync(payloadRoot, { recursive: true });

  const files = [...PRODUCTION_REQUIRED_PAYLOAD_FILES].sort().map((relative, index) => {
    const bytes = Buffer.from('payload-' + String(index) + '-' + relative, 'utf8');
    const target = path.join(payloadRoot, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    const mode = relative === 'scripts/production-runtime-start.sh'
      || relative === 'scripts/production-runtime-stop.sh'
      ? 0o755 as const
      : 0o644 as const;
    writeFileSync(target, bytes, { mode });
    return { path: relative, sizeBytes: bytes.length, digest: sha256(bytes), mode };
  });

  const commit = 'a'.repeat(40);
  const images = [...PRODUCTION_RUNTIME_COMPONENTS].map((component, index) => ({
    component,
    reference: 'quarangate:' + component + '-' + commit,
    digest: 'sha256:' + String(index + 1).repeat(64),
  }));

  const manifest = createReleasePackageManifest({
    schemaVersion: 1,
    productVersion: '1.0.0',
    sourceCommit: commit,
    createdAt: '2026-09-18T00:00:00.000Z',
    architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
    signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
    lifecycle: {
      configSchemaVersion: 0,
      stateSchemaVersion: 0,
      components: [...PRODUCTION_RUNTIME_COMPONENTS],
      migrations: [],
    },
    files,
    images,
  });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const proof = {
    schemaVersion: 1 as const,
    algorithm: 'Ed25519' as const,
    keyId: 'release-key-a',
    manifestDigest: manifest.manifestDigest,
    signedAt: '2026-09-18T00:01:00.000Z',
    signature: sign(null, releaseSignaturePayload(manifest), privateKey).toString('base64'),
  };
  const trustPolicy: ReleaseTrustPolicy = {
    schemaVersion: 1,
    policyId: 'quarangate-production-release',
    trustedKeys: [{
      keyId: 'release-key-a',
      algorithm: 'Ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }],
  };

  const manifestFile = path.join(temp, 'release-manifest.json');
  const signatureProofFile = path.join(temp, 'release-signature.json');
  const trustPolicyFile = path.join(temp, 'release-trust-policy.json');
  writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(signatureProofFile, JSON.stringify(proof), { mode: 0o600 });
  writeFileSync(trustPolicyFile, JSON.stringify(trustPolicy), { mode: 0o600 });

  return { temp, payloadRoot, manifest, manifestFile, signatureProofFile, trustPolicyFile, trustPolicy };
}

describe('P9 signed production CLI release admission', () => {
  it('verifies signature, installer-owned trust, full payload bytes, and production profile before review', () => {
    const value = fixture();
    const verified = loadVerifiedProductionRelease({
      packageRoot: value.payloadRoot,
      manifestFile: value.manifestFile,
      signatureProofFile: value.signatureProofFile,
      trustPolicyFile: value.trustPolicyFile,
    });

    expect(verified.release).toEqual({
      state: 'VERIFIED_RELEASE',
      productVersion: value.manifest.productVersion,
      sourceCommit: value.manifest.sourceCommit,
      manifestDigest: value.manifest.manifestDigest,
    });
    expect(verified.bundle.payloadRoot).toBe(value.payloadRoot);
    expect(verified.trustPolicy.policyId).toBe('quarangate-production-release');
  });

  it('refuses trust policy supplied from inside the release payload root', () => {
    const value = fixture();
    const colocatedTrust = path.join(value.payloadRoot, 'release-trust-policy.json');
    writeFileSync(colocatedTrust, JSON.stringify(value.trustPolicy), { mode: 0o600 });

    expect(() => loadVerifiedProductionRelease({
      packageRoot: value.payloadRoot,
      manifestFile: value.manifestFile,
      signatureProofFile: value.signatureProofFile,
      trustPolicyFile: colocatedTrust,
    })).toThrow(/independently/iu);
  });

  it('refuses unmanifested package-root bytes even when every signed payload file is intact', () => {
    const value = fixture();
    writeFileSync(path.join(value.payloadRoot, 'unmanifested.mjs'), 'throw new Error("executed");', { mode: 0o644 });

    expect(() => loadVerifiedProductionRelease({
      packageRoot: value.payloadRoot,
      manifestFile: value.manifestFile,
      signatureProofFile: value.signatureProofFile,
      trustPolicyFile: value.trustPolicyFile,
    })).toThrow(/unmanifested/iu);
  });

  it('refuses payload bytes that changed after the manifest was signed', () => {
    const value = fixture();
    writeFileSync(path.join(value.payloadRoot, 'compose.yaml'), 'tampered', { mode: 0o644 });

    expect(() => loadVerifiedProductionRelease({
      packageRoot: value.payloadRoot,
      manifestFile: value.manifestFile,
      signatureProofFile: value.signatureProofFile,
      trustPolicyFile: value.trustPolicyFile,
    })).toThrow(/payload integrity/iu);
  });
});
