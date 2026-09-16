import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const commit = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const policy = JSON.parse(readFileSync('security/release-policy.json', 'utf8'));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qg-release-bundle-'));
  const evidence = join(root, 'evidence'); mkdirSync(evidence);
  const policyReport = join(root, 'policy.json');
  const sbom = join(root, 'sbom.json');
  const output = join(root, 'bundle.json');
  const hashes: { gate: string; sha256: string }[] = [];
  for (const gate of policy.requiredGates) {
    const receipt: any = {
      schemaVersion: 1,
      gate,
      status: 'PASS',
      source: { commit, clean: true },
      tool: policy.expectedTools[gate] ?? { name: 'test-runner', version: '1' },
      findings: [],
    };
    if (['unit', 'integration', 'e2e'].includes(gate)) receipt.testCounts = { files: 2, tests: 10, failed: 0 };
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    writeFileSync(join(evidence, `${gate}.json`), bytes);
    hashes.push({ gate, sha256: sha256(bytes) });
  }
  writeFileSync(policyReport, `${JSON.stringify({ schemaVersion: 1, commit, ok: true, verdict: 'PASS', evidence: hashes })}\n`);
  writeFileSync(sbom, `${JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', packages: [] })}\n`);
  return { root, evidence, policyReport, sbom, output };
}

function run(f: ReturnType<typeof fixture>, extra: string[] = []) {
  return spawnSync(process.execPath, [
    'scripts/release-evidence-bundle.mjs',
    '--evidence-dir', f.evidence,
    '--commit', commit,
    '--image-digest', imageDigest,
    '--sbom', f.sbom,
    '--policy-report', f.policyReport,
    '--output', f.output,
    ...extra,
  ], { encoding: 'utf8' });
}

describe('SH-05 release evidence bundle', () => {
  it('binds exact source, image, SBOM, policy report, gate hashes and test counts deterministically', () => {
    const a = fixture(); const b = fixture();
    let r = run(a); expect(r.status, r.stderr).toBe(0);
    r = run(b); expect(r.status, r.stderr).toBe(0);
    const one = JSON.parse(readFileSync(a.output, 'utf8'));
    const two = JSON.parse(readFileSync(b.output, 'utf8'));
    expect(one.source).toEqual({ repository: 'https://github.com/Herman940306/QuaranGate.git', commit, clean: true });
    expect(one.subject.imageDigest).toBe(imageDigest);
    expect(one.evidence).toHaveLength(policy.requiredGates.length);
    expect(one.testCounts).toEqual({
      unit: { files: 2, tests: 10, failed: 0 },
      integration: { files: 2, tests: 10, failed: 0 },
      e2e: { files: 2, tests: 10, failed: 0 },
    });
    expect(one.bundleBindingSha256).toBe(two.bundleBindingSha256);
  });

  it('fails closed when a required receipt is stale or dirty', () => {
    const f = fixture();
    const p = join(f.evidence, 'sast.json');
    const receipt = JSON.parse(readFileSync(p, 'utf8'));
    receipt.source = { commit: 'c'.repeat(40), clean: false };
    writeFileSync(p, JSON.stringify(receipt));
    const r = run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('gate receipt source binding mismatch: sast');
  });

  it('fails closed when evidence bytes no longer match the accepted policy report', () => {
    const f = fixture();
    const p = join(f.evidence, 'authority-invariants.json');
    const receipt = JSON.parse(readFileSync(p, 'utf8'));
    receipt.note = 'tampered-after-policy';
    writeFileSync(p, JSON.stringify(receipt));
    const r = run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-policy evidence hash mismatch: authority-invariants');
  });

  it('fails closed when test receipts omit trustworthy counts', () => {
    const f = fixture();
    const p = join(f.evidence, 'integration.json');
    const receipt = JSON.parse(readFileSync(p, 'utf8'));
    delete receipt.testCounts;
    writeFileSync(p, JSON.stringify(receipt));
    const r = run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('gate receipt lacks valid passing test counts: integration');
  });

  it('fails closed for a non-PASS policy verdict or mismatched policy commit', () => {
    const f = fixture();
    let report = JSON.parse(readFileSync(f.policyReport, 'utf8'));
    report.verdict = 'FAIL'; report.ok = false;
    writeFileSync(f.policyReport, JSON.stringify(report));
    let r = run(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-policy report is not a PASS receipt');

    const g = fixture();
    report = JSON.parse(readFileSync(g.policyReport, 'utf8'));
    report.commit = 'd'.repeat(40);
    writeFileSync(g.policyReport, JSON.stringify(report));
    r = run(g);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-policy report commit does not match --commit');
  });

  it('rejects malformed image digests and non-SPDX SBOMs', () => {
    const f = fixture();
    let r = spawnSync(process.execPath, [
      'scripts/release-evidence-bundle.mjs', '--evidence-dir', f.evidence, '--commit', commit,
      '--image-digest', 'sha256:not-a-digest', '--sbom', f.sbom, '--policy-report', f.policyReport, '--output', f.output,
    ], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--image-digest requires');

    const g = fixture();
    writeFileSync(g.sbom, JSON.stringify({ spdxVersion: 'SPDX-2.2', SPDXID: 'SPDXRef-DOCUMENT' }));
    r = run(g);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SBOM is not the expected SPDX-2.3 document');
  });
});
