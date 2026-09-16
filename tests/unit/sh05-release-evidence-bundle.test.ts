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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qg-release-bundle-')); const evidence = join(root, 'evidence'); mkdirSync(evidence);
  const policyReport = join(root, 'policy.json'); const sbom = join(root, 'sbom.json'); const output = join(root, 'bundle.json'); const sourceBinding = join(root, 'source-binding.json'); const manifestPath = join(root, 'release-manifest.json');
  const sourceBindingBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source })}\n`); writeFileSync(sourceBinding, sourceBindingBytes);
  const hashes: { gate: string; sha256: string }[] = [];
  for (const gate of policy.requiredGates) {
    const receipt: any = { schemaVersion: 1, gate, status: 'PASS', source, tool: policy.expectedTools[gate] ?? { name: 'test-runner', version: '1' }, findings: [] };
    if (['unit', 'integration', 'e2e'].includes(gate)) receipt.testCounts = { files: 2, tests: 10, failed: 0 };
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`); writeFileSync(join(evidence, `${gate}.json`), bytes); hashes.push({ gate, sha256: sha256(bytes) });
  }
  writeFileSync(policyReport, `${JSON.stringify({ schemaVersion: 1, source, sourceBinding: { sha256: sha256(sourceBindingBytes) }, ok: true, verdict: 'PASS', evidence: hashes })}\n`);
  writeFileSync(sbom, `${JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [] })}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(releaseManifest(), null, 2)}\n`);
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
    expect(one.testCounts).toEqual({ unit: { files: 2, tests: 10, failed: 0 }, integration: { files: 2, tests: 10, failed: 0 }, e2e: { files: 2, tests: 10, failed: 0 } });
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

  it('fails closed for a non-PASS policy verdict', () => {
    const f = fixture(); const report = JSON.parse(readFileSync(f.policyReport, 'utf8')); report.verdict = 'FAIL'; report.ok = false; writeFileSync(f.policyReport, JSON.stringify(report));
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('release-policy report is not a PASS receipt');
  });

  it('rejects non-SPDX SBOMs', () => {
    const g = fixture(); writeFileSync(g.sbom, JSON.stringify({ spdxVersion: 'SPDX-2.2', SPDXID: 'SPDXRef-DOCUMENT' })); const r = run(g); expect(r.status).not.toBe(0); expect(r.stderr).toContain('SBOM is not the expected SPDX-2.3 document');
  });
});
