import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReleasePackageManifest, releaseSignaturePayload } from '../../src/installer/releasePackage.js';
import { validateP10SystemE2eEvidence } from '../../scripts/p10-system-e2e-evidence.mjs';

const source = {
  repository: 'https://github.com/Herman940306/QuaranGate.git',
  branch: 'integrate/quarangate-forward',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  clean: true,
};
const steps = [
  'fresh-install','configure','enroll','kiro','ollama','copilot','github','ide','jobs',
  'restart-crash','resume','review','apply','evidence','backup-recovery',
] as const;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const signingKeyId = 'release-key-a';
const signingKeys = generateKeyPairSync('ed25519');
const publicKeyPem = signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function releaseManifest() {
  return createReleasePackageManifest({
    schemaVersion: 1,
    productVersion: '1.0.0',
    sourceCommit: source.commit,
    createdAt: '2026-09-17T10:00:00.000Z',
    architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
    signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
    lifecycle: { configSchemaVersion: 0, stateSchemaVersion: 0, components: ['gateway'], migrations: [] },
    files: [{ path: 'dist/index.js', sizeBytes: 1, digest: 'd'.repeat(64), mode: 0o644 }],
    images: [{ component: 'gateway', reference: `quarangate-gateway:git-${source.commit}`, digest: `sha256:${'c'.repeat(64)}` }],
  });
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'qg-p10-system-e2e-'));
  const root = join(base, 'run');
  const inputs = join(base, 'inputs');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(inputs, { mode: 0o700 });
  mkdirSync(join(root, 'artifacts'), { mode: 0o700 });
  mkdirSync(join(root, 'review'), { mode: 0o700 });

  const release = releaseManifest();
  const releaseManifestPath = join(inputs, 'release-manifest.json');
  writeFileSync(releaseManifestPath, `${JSON.stringify(release, null, 2)}\n`);
  const sourceBindingPath = join(inputs, 'source-binding.json');
  writeFileSync(sourceBindingPath, `${JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source }, null, 2)}\n`);
  const releaseSignatureProofPath = join(inputs, 'release-signature-proof.json');
  const proof = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: signingKeyId,
    manifestDigest: release.manifestDigest,
    signedAt: '2026-09-17T10:01:00.000Z',
    signature: sign(null, releaseSignaturePayload(release), signingKeys.privateKey).toString('base64'),
  };
  writeFileSync(releaseSignatureProofPath, `${JSON.stringify(proof, null, 2)}\n`);
  const releaseTrustPolicyPath = join(inputs, 'release-trust-policy.json');
  const trustPolicy = { schemaVersion: 1, policyId: 'installer-release-trust-v1', trustedKeys: [{ keyId: signingKeyId, algorithm: 'Ed25519', publicKeyPem }] };
  writeFileSync(releaseTrustPolicyPath, `${JSON.stringify(trustPolicy, null, 2)}\n`);
  const signedPackagePath = join(inputs, 'QuaranGate-Setup.exe');
  const signedPackageBytes = Buffer.from('synthetic signed Windows package bytes for validator fixture\n');
  writeFileSync(signedPackagePath, signedPackageBytes);

  const evidenceSteps = steps.map((id, index) => {
    const artifacts: Array<{ path: string; sha256: string; bytes: number; kind: string }> = [];
    const addArtifact = (kind: string, suffix: string) => {
      const relativePath = `artifacts/${String(index + 1).padStart(2, '0')}-${id}-${suffix}.bin`;
      const bytes = Buffer.from(`${JSON.stringify({ id, kind, marker: `reviewable-synthetic-${index}` })}\n`);
      writeFileSync(join(root, relativePath), bytes);
      artifacts.push({ path: relativePath, sha256: sha256(bytes), bytes: bytes.length, kind });
    };
    addArtifact('RECEIPT', 'receipt');
    if (id === 'fresh-install' || id === 'restart-crash') addArtifact('LOG', 'log');
    if (id === 'backup-recovery') addArtifact('ARCHIVE', 'archive');
    return {
      id,
      status: 'PASS',
      startedAt: new Date(Date.UTC(2026, 8, 17, 10, 10 + index * 2, 0)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 8, 17, 10, 11 + index * 2, 0)).toISOString(),
      artifacts,
    };
  });
  const evidence: any = {
    schemaVersion: 2,
    status: 'EVIDENCE_COMPLETE_REVIEW_PENDING',
    runId: 'p10-system-e2e-fixture-001',
    operatorId: 'qualification-operator-a',
    source,
    environment: {
      classification: 'DISPOSABLE_QUALIFICATION',
      platform: 'WINDOWS11_WSL2',
      productionData: false,
      customerData: false,
    },
    release: {
      productVersion: release.productVersion,
      manifestDigest: release.manifestDigest,
      signedPackageSha256: sha256(signedPackageBytes),
    },
    steps: evidenceSteps,
  };
  const evidencePath = join(root, 'manifest.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const reviewPath = join(root, 'review/independent-review.json');
  const review: any = {
    schemaVersion: 1,
    status: 'PASS',
    verdict: 'ACCEPT',
    reviewerIndependent: true,
    reviewerId: 'independent-reviewer-b',
    reviewedAt: '2026-09-17T11:00:00.000Z',
    operatorId: evidence.operatorId,
    sourceCommit: source.commit,
    releaseManifestDigest: release.manifestDigest,
    evidenceManifestSha256: sha256(readFileSync(evidencePath)),
    signedPackageSha256: evidence.release.signedPackageSha256,
    evidenceSafety: { secretScan: 'PASS', credentialMarkers: 0, customerIdentifiers: 0 },
    findings: [],
  };
  writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  return {
    base, root, inputs, evidencePath, reviewPath, sourceBindingPath, releaseManifestPath,
    releaseSignatureProofPath, releaseTrustPolicyPath, signedPackagePath,
    evidence, review, release, proof, trustPolicy,
  };
}

function rewriteEvidence(f: ReturnType<typeof fixture>) {
  writeFileSync(f.evidencePath, `${JSON.stringify(f.evidence, null, 2)}\n`);
}
function rewriteReview(f: ReturnType<typeof fixture>) {
  writeFileSync(f.reviewPath, `${JSON.stringify(f.review, null, 2)}\n`);
}
function rebindReview(f: ReturnType<typeof fixture>) {
  f.review.evidenceManifestSha256 = sha256(readFileSync(f.evidencePath));
  f.review.signedPackageSha256 = f.evidence.release.signedPackageSha256;
  rewriteReview(f);
}
function validate(f = fixture()) {
  return validateP10SystemE2eEvidence({
    evidenceDir: f.root,
    sourceBindingPath: f.sourceBindingPath,
    releaseManifestPath: f.releaseManifestPath,
    releaseSignatureProofPath: f.releaseSignatureProofPath,
    releaseTrustPolicyPath: f.releaseTrustPolicyPath,
    signedPackagePath: f.signedPackagePath,
  });
}

describe('P10 full-system E2E evidence validator v2', () => {
  it('accepts the exact 15-step run only with cryptographic release trust, exact package bytes and independent manifest-bound review', () => {
    const result = validate();
    expect(result).toEqual(expect.objectContaining({
      schemaVersion: 2, status: 'PASS', runId: 'p10-system-e2e-fixture-001', operatorId: 'qualification-operator-a', stepCount: 15, artifactCount: 18,
      productVersion: '1.0.0', sourceCommit: source.commit, signingKeyId,
      releaseManifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      signedPackageSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      releaseSignatureProofSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      releaseTrustPolicyId: 'installer-release-trust-v1',
      releaseTrustPolicySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      signingKeyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidenceManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      reviewReceiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      reviewerId: 'independent-reviewer-b',
    }));
  });

  it('requires step-specific minimum evidence kinds instead of arbitrary hash-correct files', () => {
    const missingFreshLog = fixture();
    missingFreshLog.evidence.steps[0].artifacts = missingFreshLog.evidence.steps[0].artifacts.filter((artifact: any) => artifact.kind !== 'LOG');
    rewriteEvidence(missingFreshLog); rebindReview(missingFreshLog);
    expect(() => validate(missingFreshLog)).toThrow(/required LOG evidence/i);

    const missingBackupArchive = fixture();
    missingBackupArchive.evidence.steps[14].artifacts = missingBackupArchive.evidence.steps[14].artifacts.filter((artifact: any) => artifact.kind !== 'ARCHIVE');
    rewriteEvidence(missingBackupArchive); rebindReview(missingBackupArchive);
    expect(() => validate(missingBackupArchive)).toThrow(/required ARCHIVE evidence/i);

    const arbitraryJsonOnly = fixture();
    for (const step of arbitraryJsonOnly.evidence.steps) {
      step.artifacts = step.artifacts.map((artifact: any) => ({ ...artifact, kind: 'JSON' }));
    }
    rewriteEvidence(arbitraryJsonOnly); rebindReview(arbitraryJsonOnly);
    expect(() => validate(arbitraryJsonOnly)).toThrow(/required RECEIPT evidence/i);
  });

  it('fails on source or release-manifest drift', () => {
    const a = fixture(); a.evidence.source.commit = 'f'.repeat(40); rewriteEvidence(a); rebindReview(a);
    expect(() => validate(a)).toThrow(/source/i);
    const b = fixture(); b.evidence.release.manifestDigest = 'f'.repeat(64); rewriteEvidence(b); rebindReview(b);
    expect(() => validate(b)).toThrow(/release manifest/i);
  });

  it('requires the exact ordered step set with every step PASS', () => {
    for (const mutate of [
      (v: any) => { v.steps.pop(); },
      (v: any) => { [v.steps[0], v.steps[1]] = [v.steps[1], v.steps[0]]; },
      (v: any) => { v.steps[1].id = v.steps[0].id; },
      (v: any) => { v.steps[4].status = 'FAIL'; },
    ]) {
      const f = fixture(); mutate(f.evidence); rewriteEvidence(f); rebindReview(f);
      expect(() => validate(f)).toThrow(/step|PASS/i);
    }
  });

  it('requires disposable non-customer/non-production environment and exact supplied package bytes', () => {
    for (const mutate of [
      (v: any) => { v.environment.classification = 'PRODUCTION'; },
      (v: any) => { v.environment.productionData = true; },
      (v: any) => { v.environment.customerData = true; },
      (v: any) => { v.release.signedPackageSha256 = 'f'.repeat(64); },
    ]) {
      const f = fixture(); mutate(f.evidence); rewriteEvidence(f); rebindReview(f);
      expect(() => validate(f)).toThrow(/environment|production|customer|package/i);
    }
    const changed = fixture(); writeFileSync(changed.signedPackagePath, 'different package bytes\n');
    expect(() => validate(changed)).toThrow(/package/i);
  });

  it('cryptographically verifies the detached P9 release signature against independent installer trust policy', () => {
    const badSignature = fixture();
    badSignature.proof.signature = Buffer.alloc(64, 0).toString('base64');
    writeFileSync(badSignature.releaseSignatureProofPath, JSON.stringify(badSignature.proof));
    expect(() => validate(badSignature)).toThrow(/cryptographic|signature/i);

    const untrusted = fixture();
    untrusted.trustPolicy.trustedKeys[0].keyId = 'different-key';
    writeFileSync(untrusted.releaseTrustPolicyPath, JSON.stringify(untrusted.trustPolicy));
    expect(() => validate(untrusted)).toThrow(/trust|identity/i);
  });

  it('requires installer trust policy to remain independently supplied and not group/world writable', () => {
    const writable = fixture(); chmodSync(writable.releaseTrustPolicyPath, 0o666);
    expect(() => validate(writable)).toThrow(/trust policy|writable|replaceable/i);

    const embedded = fixture();
    const embeddedPath = join(embedded.root, 'artifacts/embedded-trust.json');
    copyFileSync(embedded.releaseTrustPolicyPath, embeddedPath);
    expect(() => validateP10SystemE2eEvidence({
      evidenceDir: embedded.root,
      sourceBindingPath: embedded.sourceBindingPath,
      releaseManifestPath: embedded.releaseManifestPath,
      releaseSignatureProofPath: embedded.releaseSignatureProofPath,
      releaseTrustPolicyPath: embeddedPath,
      signedPackagePath: embedded.signedPackagePath,
    })).toThrow(/trust policy.*outside|outside system-e2e evidence/i);
  });

  it('requires a distinct independent reviewer bound to exact finalized manifest/package/source with zero findings', () => {
    const absent = fixture(); unlinkSync(absent.reviewPath);
    expect(() => validate(absent)).toThrow(/review/i);

    const sameActor = fixture(); sameActor.review.reviewerId = sameActor.evidence.operatorId; rewriteReview(sameActor);
    expect(() => validate(sameActor)).toThrow(/review/i);

    const stale = fixture(); stale.review.evidenceManifestSha256 = 'f'.repeat(64); rewriteReview(stale);
    expect(() => validate(stale)).toThrow(/review|manifest/i);

    const finding = fixture(); finding.review.findings = [{ id: 'P10-F1' }]; rewriteReview(finding);
    expect(() => validate(finding)).toThrow(/review/i);

    const unsafe = fixture(); unsafe.review.evidenceSafety.credentialMarkers = 1; rewriteReview(unsafe);
    expect(() => validate(unsafe)).toThrow(/evidence-safety/i);
  });

  it('rejects artifact traversal, symlinks, digest/size tamper, and duplicate references', () => {
    const traversal = fixture(); traversal.evidence.steps[0].artifacts[0].path = '../escape.json'; rewriteEvidence(traversal); rebindReview(traversal);
    expect(() => validate(traversal)).toThrow(/path|artifact/i);

    const linked = fixture(); const target = join(linked.root, linked.evidence.steps[0].artifacts[0].path); const alias = join(linked.root, 'artifacts/linked.json'); symlinkSync(target, alias); linked.evidence.steps[0].artifacts[0].path = 'artifacts/linked.json'; rewriteEvidence(linked); rebindReview(linked);
    expect(() => validate(linked)).toThrow(/symlink|artifact/i);

    const digest = fixture(); digest.evidence.steps[0].artifacts[0].sha256 = 'f'.repeat(64); rewriteEvidence(digest); rebindReview(digest);
    expect(() => validate(digest)).toThrow(/digest|artifact/i);

    const size = fixture(); size.evidence.steps[0].artifacts[0].bytes += 1; rewriteEvidence(size); rebindReview(size);
    expect(() => validate(size)).toThrow(/size|artifact/i);

    const duplicate = fixture(); duplicate.evidence.steps[1].artifacts[0] = structuredClone(duplicate.evidence.steps[0].artifacts[0]); rewriteEvidence(duplicate); rebindReview(duplicate);
    expect(() => validate(duplicate)).toThrow(/duplicate|artifact/i);
  });

  it('rejects unmanifested evidence bytes and unexpected evidence-root entries', () => {
    const extraArtifact = fixture(); writeFileSync(join(extraArtifact.root, 'artifacts/unreviewed.log'), 'unreviewed\n');
    expect(() => validate(extraArtifact)).toThrow(/unmanifested|unexpected/i);
    const extraTop = fixture(); writeFileSync(join(extraTop.root, 'notes.txt'), 'outside manifest\n');
    expect(() => validate(extraTop)).toThrow(/unmanifested|top-level/i);
  });

  it('rejects timestamp disorder and unknown/self-attested authority fields', () => {
    const time = fixture(); time.evidence.steps[1].startedAt = time.evidence.steps[0].completedAt; rewriteEvidence(time); rebindReview(time);
    expect(() => validate(time)).toThrow(/time|order/i);

    const unknown = fixture(); unknown.evidence.release.signedPackageVerified = true; rewriteEvidence(unknown); rebindReview(unknown);
    expect(() => validate(unknown)).toThrow(/unknown|field/i);

    const oldSelfReview = fixture(); oldSelfReview.evidence.evidenceSafety = { secretScan: 'PASS', credentialMarkers: 0, customerIdentifiers: 0, manualReview: true }; rewriteEvidence(oldSelfReview); rebindReview(oldSelfReview);
    expect(() => validate(oldSelfReview)).toThrow(/unknown|field/i);
  });
});
