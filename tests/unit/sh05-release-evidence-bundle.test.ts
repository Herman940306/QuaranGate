import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const commit = 'a'.repeat(40); const tree = 'e'.repeat(40); const imageDigest = `sha256:${'b'.repeat(64)}`;
const source = { repository: 'https://github.com/Herman940306/QuaranGate.git', branch: 'release/test', commit, tree, clean: true };
const policy = JSON.parse(readFileSync('security/release-policy.json', 'utf8'));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qg-release-bundle-')); const evidence = join(root, 'evidence'); mkdirSync(evidence);
  const policyReport = join(root, 'policy.json'); const sbom = join(root, 'sbom.json'); const output = join(root, 'bundle.json'); const sourceBinding = join(root, 'source-binding.json');
  const sourceBindingBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source })}\n`); writeFileSync(sourceBinding, sourceBindingBytes);
  const hashes: { gate: string; sha256: string }[] = [];
  for (const gate of policy.requiredGates) {
    const receipt: any = { schemaVersion: 1, gate, status: 'PASS', source, tool: policy.expectedTools[gate] ?? { name: 'test-runner', version: '1' }, findings: [] };
    if (['unit', 'integration', 'e2e'].includes(gate)) receipt.testCounts = { files: 2, tests: 10, failed: 0 };
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`); writeFileSync(join(evidence, `${gate}.json`), bytes); hashes.push({ gate, sha256: sha256(bytes) });
  }
  writeFileSync(policyReport, `${JSON.stringify({ schemaVersion: 1, source, sourceBinding: { sha256: sha256(sourceBindingBytes) }, ok: true, verdict: 'PASS', evidence: hashes })}\n`);
  writeFileSync(sbom, `${JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [] })}\n`);
  return { evidence, policyReport, sbom, output, sourceBinding };
}
function run(f: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, ['scripts/release-evidence-bundle.mjs', '--evidence-dir', f.evidence, '--source-binding', f.sourceBinding, '--image-digest', imageDigest, '--sbom', f.sbom, '--policy-report', f.policyReport, '--output', f.output], { encoding: 'utf8' });
}

describe('SH-05 release evidence bundle', () => {
  it('binds exact Git source/tree, image, SBOM, policy, gate hashes and test counts deterministically', () => {
    const a = fixture(); const b = fixture(); let r = run(a); expect(r.status, r.stderr).toBe(0); r = run(b); expect(r.status, r.stderr).toBe(0);
    const one = JSON.parse(readFileSync(a.output, 'utf8')); const two = JSON.parse(readFileSync(b.output, 'utf8'));
    expect(one.source).toEqual(source); expect(one.subject.imageDigest).toBe(imageDigest); expect(one.evidence).toHaveLength(policy.requiredGates.length);
    expect(one.testCounts).toEqual({ unit: { files: 2, tests: 10, failed: 0 }, integration: { files: 2, tests: 10, failed: 0 }, e2e: { files: 2, tests: 10, failed: 0 } });
    expect(one.bundleBindingSha256).toBe(two.bundleBindingSha256);
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

  it('rejects malformed image digests and non-SPDX SBOMs', () => {
    const f = fixture(); let r = spawnSync(process.execPath, ['scripts/release-evidence-bundle.mjs', '--evidence-dir', f.evidence, '--source-binding', f.sourceBinding, '--image-digest', 'sha256:not-a-digest', '--sbom', f.sbom, '--policy-report', f.policyReport, '--output', f.output], { encoding: 'utf8' });
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('--image-digest requires');
    const g = fixture(); writeFileSync(g.sbom, JSON.stringify({ spdxVersion: 'SPDX-2.2', SPDXID: 'SPDXRef-DOCUMENT' })); r = run(g); expect(r.status).not.toBe(0); expect(r.stderr).toContain('SBOM is not the expected SPDX-2.3 document');
  });
});
