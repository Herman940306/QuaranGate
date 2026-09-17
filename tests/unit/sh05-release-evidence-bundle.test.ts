import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createReleasePackageManifest, verifyReleasePackageManifest } from '../../src/installer/releasePackage.js';

const commit = 'a'.repeat(40); const tree = 'e'.repeat(40);
const source = { repository: 'https://github.com/Herman940306/QuaranGate.git', branch: 'release/test', commit, tree, clean: true };
const policy = JSON.parse(readFileSync('security/release-policy.json', 'utf8'));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const imageA = `sha256:${'b'.repeat(64)}`; const imageB = `sha256:${'c'.repeat(64)}`;

function releaseManifest() {
  return createReleasePackageManifest({
    schemaVersion: 1,
    productVersion: '1.0.0',
    sourceCommit: commit,
    createdAt: '2026-09-16T12:00:00.000Z',
    architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
    signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
    lifecycle: { configSchemaVersion: 0, stateSchemaVersion: 0, components: ['executor', 'gateway'], migrations: [] },
    files: [{ path: 'dist/index.js', sizeBytes: 1, digest: 'd'.repeat(64), mode: 0o644 }],
    images: [
      { component: 'executor', reference: `quarangate-executor:git-${commit}`, digest: imageA },
      { component: 'gateway', reference: `quarangate-gateway:git-${commit}`, digest: imageB },
    ],
  });
}

const digest = 'f'.repeat(64);
function execution(commandId: string) {
  return { commandId, exitCode: 0, signal: null, durationMs: 1, stdout: { sha256: digest, bytes: 0 }, stderr: { sha256: digest, bytes: 0 } };
}
function validReceipt(gate: string, sourceBindingSha256: string, manifestBytes: Buffer, manifest: any, sbomBytes: Buffer) {
  const receipt: any = { schemaVersion: 1, gate, status: 'PASS', source, tool: policy.expectedTools[gate] ?? { name: 'test-runner', version: '1' }, findings: [] };
  const ids: Record<string, string> = {
    typecheck: 'typescript-typecheck', build: 'typescript-build', unit: 'vitest-unit', integration: 'vitest-integration', e2e: 'playwright-e2e', 'system-e2e': 'p10-system-e2e-validate',
    'authority-invariants': 'authority-invariants', 'security-fuzz': 'security-fuzz', 'security-chaos': 'vitest-security-chaos', 'security-egress': 'vitest-security-egress', 'security-docker': 'vitest-security-docker', 'security-prompt-injection': 'vitest-security-prompt-injection', sbom: 'release-sbom', provenance: 'cosign-verify-blob-attestation',
  };
  if (ids[gate]) receipt.execution = execution(ids[gate]);
  if (['unit', 'integration', 'e2e', 'security-chaos', 'security-egress', 'security-docker', 'security-prompt-injection'].includes(gate)) receipt.testCounts = { files: 2, tests: 10, failed: 0 };
  if (gate === 'system-e2e') receipt.artifact = {
    schemaVersion: 2, status: 'PASS', runId: 'p10-system-e2e-fixture-001', operatorId: 'qualification-operator-a', sourceCommit: commit, productVersion: manifest.productVersion,
    releaseManifestDigest: manifest.manifestDigest, signedPackageSha256: digest,
    releaseSignatureProofSha256: digest, releaseTrustPolicyId: 'installer-release-trust-v1', releaseTrustPolicySha256: digest,
    signingKeyId: 'release-key-a', signingKeyFingerprint: digest, evidenceManifestSha256: digest, reviewReceiptSha256: digest,
    reviewerId: 'independent-reviewer-b', reviewedAt: '2026-09-17T13:00:00.000Z',
    stepCount: 15, artifactCount: 15, totalArtifactBytes: 1500,
    environment: 'DISPOSABLE_QUALIFICATION', platform: 'WINDOWS11_WSL2',
  };
  if (gate === 'authority-invariants') receipt.artifact = { rulesChecked: 12, composeFilesChecked: 10, dockerfilesChecked: 7 };
  if (gate === 'security-fuzz') receipt.artifact = { targetCount: 15, totalExecutions: 30060, coverageRanges: 106, iterationsPerTarget: 2000, maxInputBytes: 1024, maxCorpus: 256, maxRuntimeMs: 20000, coverageSampleInterval: 16, seed: 0x51f08a11 };
  if (gate === 'sbom') receipt.artifact = { kind: 'spdx-json', sha256: sha256(sbomBytes), bytes: sbomBytes.length };
  if (['sast', 'secrets', 'sca', 'config-scan', 'image-scan'].includes(gate)) receipt.scan = {
    scannerExitCode: 0, rawReportSha256: digest, rawReportBytes: 100, toolchainReportSha256: digest, sourceBindingSha256, normalizedFindingCount: 0,
  };
  if (gate === 'image-scan') {
    receipt.scan.imageIdentitiesSha256 = digest;
    receipt.images = manifest.images;
  }
  if (gate === 'provenance') {
    receipt.statement = { predicateType: 'https://slsa.dev/provenance/v1', sha256: digest, bytes: 100, subjectCount: 3, releaseManifestSha256: sha256(manifestBytes), releaseManifestDigest: manifest.manifestDigest, sbomSha256: sha256(sbomBytes) };
    receipt.bundle = { sha256: digest, bytes: 100, mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', signedStatementSha256: digest, signedStatementBytes: 90 };
    receipt.publicKey = { sha256: digest, bytes: 32 };
  }
  return receipt;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qg-release-bundle-')); const evidence = join(root, 'evidence'); mkdirSync(evidence);
  const policyReport = join(root, 'policy.json'); const sbom = join(root, 'sbom.json'); const output = join(root, 'bundle.json'); const sourceBinding = join(root, 'source-binding.json'); const manifestPath = join(root, 'release-manifest.json');
  const sourceBindingBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source })}\n`); writeFileSync(sourceBinding, sourceBindingBytes);
  const sbomBytes = Buffer.from(`${JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [] })}\n`); writeFileSync(sbom, sbomBytes);
  const manifest = releaseManifest(); const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); writeFileSync(manifestPath, manifestBytes);
  const hashes: { gate: string; sha256: string }[] = [];
  for (const gate of policy.requiredGates) {
    const receipt = validReceipt(gate, sha256(sourceBindingBytes), manifestBytes, manifest, sbomBytes);
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`); writeFileSync(join(evidence, `${gate}.json`), bytes); hashes.push({ gate, sha256: sha256(bytes) });
  }
  writeFileSync(policyReport, `${JSON.stringify({ schemaVersion: 1, source, sourceBinding: { sha256: sha256(sourceBindingBytes) }, ok: true, verdict: 'PASS', evidence: hashes })}\n`);
  return { evidence, policyReport, sbom, output, sourceBinding, manifestPath };
}
function run(f: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, ['scripts/release-evidence-bundle.mjs', '--evidence-dir', f.evidence, '--source-binding', f.sourceBinding, '--release-manifest', f.manifestPath, '--sbom', f.sbom, '--policy-report', f.policyReport, '--output', f.output], { encoding: 'utf8' });
}

describe('SH-05 release evidence bundle', () => {
  it('binds exact Git source/tree, P9 manifest, every image, SBOM, policy, gate hashes and test counts deterministically', () => {
    const a = fixture(); const b = fixture(); let r = run(a); expect(r.status, r.stderr).toBe(0); r = run(b); expect(r.status, r.stderr).toBe(0);
    const one = JSON.parse(readFileSync(a.output, 'utf8')); const two = JSON.parse(readFileSync(b.output, 'utf8'));
    expect(one.source).toEqual(source); expect(one.subject.productVersion).toBe('1.0.0'); expect(one.subject.releaseManifestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(one.subject.images).toEqual([
      { component: 'executor', reference: `quarangate-executor:git-${commit}`, digest: imageA },
      { component: 'gateway', reference: `quarangate-gateway:git-${commit}`, digest: imageB },
    ]);
    expect(one.evidence).toHaveLength(policy.requiredGates.length);
    expect(one.testCounts).toEqual({ unit: { files: 2, tests: 10, failed: 0 }, integration: { files: 2, tests: 10, failed: 0 }, e2e: { files: 2, tests: 10, failed: 0 }, 'security-chaos': { files: 2, tests: 10, failed: 0 }, 'security-egress': { files: 2, tests: 10, failed: 0 }, 'security-docker': { files: 2, tests: 10, failed: 0 }, 'security-prompt-injection': { files: 2, tests: 10, failed: 0 } });
    expect(one.bundleBindingSha256).toBe(two.bundleBindingSha256);
  });

  it('fails closed when the P9 manifest source or canonical digest is wrong', () => {
    const f = fixture(); let manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8')); manifest.sourceCommit = 'f'.repeat(40); writeFileSync(f.manifestPath, JSON.stringify(manifest));
    let r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('release manifest identity/source binding is invalid');
    const g = fixture(); manifest = JSON.parse(readFileSync(g.manifestPath, 'utf8')); manifest.images[0].digest = `sha256:${'9'.repeat(64)}`; writeFileSync(g.manifestPath, JSON.stringify(manifest));
    r = run(g); expect(r.status).not.toBe(0); expect(r.stderr).toContain('release manifest canonical digest mismatch');
  });

  it('matches P9 fail-closed schema decisions for self-consistent but invalid release manifests', () => {
    const canonical = (value: any): string => value === null ? 'null' : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : typeof value === 'object' ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
    const rehash = (value: any) => {
      const { manifestDigest: _drop, ...identity } = value;
      return { ...value, manifestDigest: createHash('sha256').update(canonical(identity)).digest('hex') };
    };
    const base: any = releaseManifest();
    const mutations: Array<[string, (value: any) => void, RegExp]> = [
      ['mutable image', (value) => { value.images[0].reference = 'executor:latest'; }, /image identity is invalid or mutable/u],
      ['invalid product version', (value) => { value.productVersion = 'v1'; }, /identity\/source binding is invalid/u],
      ['self-asserted signed state', (value) => { value.signing = 'SIGNED'; }, /identity\/source binding is invalid/u],
      ['secret payload path', (value) => { value.files[0].path = 'config/.env'; }, /secret\/credential path is refused/u],
      ['unsorted payload paths', (value) => { value.files = [{ path: 'z.js', sizeBytes: 1, digest: 'd'.repeat(64), mode: 0o644 }, { path: 'a.js', sizeBytes: 1, digest: 'e'.repeat(64), mode: 0o644 }]; }, /payload files must be sorted and unique/u],
      ['lifecycle component mismatch', (value) => { value.lifecycle.components = ['executor']; }, /lifecycle\/image component set mismatch/u],
      ['unsorted image components', (value) => { value.images = [...value.images].reverse(); value.lifecycle.components = value.images.map((image: any) => image.component); }, /image components must be sorted and unique|lifecycle identity is invalid/u],
      ['unbound migration', (value) => { value.lifecycle.configSchemaVersion = 1; value.lifecycle.migrations = [{ id: 'cfg-0-1', kind: 'CONFIG', fromVersion: 0, toVersion: 1, digest: 'f'.repeat(64) }]; }, /migration is not bound/u],
    ];
    for (const [label, mutate, expected] of mutations) {
      const value = structuredClone(base); mutate(value); const invalid = rehash(value);
      expect(() => verifyReleasePackageManifest(invalid), label).toThrow();
      const f = fixture(); writeFileSync(f.manifestPath, JSON.stringify(invalid)); const r = run(f);
      expect(r.status, label).not.toBe(0); expect(r.stderr, label).toMatch(expected);
    }
  });

  it('fails closed when source-binding or policy source identity diverges', () => {
    const f = fixture(); const binding = JSON.parse(readFileSync(f.sourceBinding, 'utf8')); binding.source.tree = 'c'.repeat(40); writeFileSync(f.sourceBinding, JSON.stringify(binding));
    let r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toMatch(/release-policy report source does not match|source-binding hash mismatch/);
    const g = fixture(); const report = JSON.parse(readFileSync(g.policyReport, 'utf8')); report.source.tree = 'd'.repeat(40); writeFileSync(g.policyReport, JSON.stringify(report));
    r = run(g); expect(r.status).not.toBe(0); expect(r.stderr).toContain('release-policy report source does not match source-binding receipt');
  });

  it('fails closed when a required receipt is stale or dirty', () => {
    const f = fixture(); const p = join(f.evidence, 'sast.json'); const receipt = JSON.parse(readFileSync(p, 'utf8')); receipt.source = { ...source, tree: 'c'.repeat(40), clean: false }; writeFileSync(p, JSON.stringify(receipt));
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('gate receipt source binding mismatch: sast');
  });

  it('fails closed when evidence bytes no longer match the accepted policy report', () => {
    const f = fixture(); const p = join(f.evidence, 'authority-invariants.json'); const receipt = JSON.parse(readFileSync(p, 'utf8')); receipt.note = 'tampered-after-policy'; writeFileSync(p, JSON.stringify(receipt));
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('release-policy evidence hash mismatch: authority-invariants');
  });

  it('fails closed when test receipts omit trustworthy counts', () => {
    const f = fixture(); const p = join(f.evidence, 'integration.json'); const receipt = JSON.parse(readFileSync(p, 'utf8')); delete receipt.testCounts; writeFileSync(p, JSON.stringify(receipt));
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('gate receipt lacks valid passing test counts: integration');
  });

  it('rejects an E2E PASS receipt whose execution identity is not the frozen E2E command contract', () => {
    const f = fixture(); const p = join(f.evidence, 'e2e.json'); const receipt = JSON.parse(readFileSync(p, 'utf8'));
    receipt.execution.commandId = 'arbitrary-green-command';
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`); writeFileSync(p, bytes);
    const report = JSON.parse(readFileSync(f.policyReport, 'utf8')); report.evidence.find((x: any) => x.gate === 'e2e').sha256 = sha256(bytes); writeFileSync(f.policyReport, `${JSON.stringify(report)}\n`);
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('gate receipt lacks valid execution evidence: e2e');
  });

  it('fails closed when system-e2e binds a different release manifest even if the accepted policy hash is recomputed', () => {
    const f = fixture(); const p = join(f.evidence, 'system-e2e.json'); const receipt = JSON.parse(readFileSync(p, 'utf8'));
    receipt.artifact.releaseManifestDigest = '9'.repeat(64);
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`); writeFileSync(p, bytes);
    const report = JSON.parse(readFileSync(f.policyReport, 'utf8')); report.evidence.find((x: any) => x.gate === 'system-e2e').sha256 = sha256(bytes); writeFileSync(f.policyReport, `${JSON.stringify(report)}\n`);
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('system-e2e receipt does not bind exact release/live qualification evidence');
  });

  it('fails closed when provenance claims a different release manifest/SBOM even if policy evidence hashes are recomputed', () => {
    const f = fixture(); const p = join(f.evidence, 'provenance.json'); const receipt = JSON.parse(readFileSync(p, 'utf8'));
    receipt.statement.releaseManifestSha256 = '9'.repeat(64); receipt.statement.sbomSha256 = '8'.repeat(64);
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`); writeFileSync(p, bytes);
    const report = JSON.parse(readFileSync(f.policyReport, 'utf8')); report.evidence.find((x: any) => x.gate === 'provenance').sha256 = sha256(bytes); writeFileSync(f.policyReport, `${JSON.stringify(report)}\n`);
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('provenance receipt does not bind the exact release manifest/SBOM/verified bundle');
  });

  it('fails closed when image-scan evidence is for a different immutable release image set', () => {
    const f = fixture(); const p = join(f.evidence, 'image-scan.json'); const receipt = JSON.parse(readFileSync(p, 'utf8'));
    receipt.images[0].digest = `sha256:${'9'.repeat(64)}`;
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`); writeFileSync(p, bytes);
    const report = JSON.parse(readFileSync(f.policyReport, 'utf8')); report.evidence.find((x: any) => x.gate === 'image-scan').sha256 = sha256(bytes); writeFileSync(f.policyReport, `${JSON.stringify(report)}\n`);
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('image-scan receipt does not bind the exact release manifest images');
  });

  it('fails closed for a non-PASS policy verdict', () => {
    const f = fixture(); const report = JSON.parse(readFileSync(f.policyReport, 'utf8')); report.verdict = 'FAIL'; report.ok = false; writeFileSync(f.policyReport, JSON.stringify(report));
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('release-policy report is not a PASS receipt');
  });

  it('rejects non-SPDX SBOMs', () => {
    const g = fixture(); writeFileSync(g.sbom, JSON.stringify({ spdxVersion: 'SPDX-2.2', SPDXID: 'SPDXRef-DOCUMENT' })); const r = run(g); expect(r.status).not.toBe(0); expect(r.stderr).toContain('SBOM is not the expected SPDX-2.3 document');
  });
});
