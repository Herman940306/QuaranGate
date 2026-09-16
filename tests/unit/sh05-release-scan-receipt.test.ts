import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const source = { repository: 'https://github.com/Herman940306/QuaranGate.git', branch: 'release/test', commit: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true };
const versions: Record<string,string> = { semgrep: '1.177.0', gitleaks: '8.30.0', 'osv-scanner': '2.6.0', trivy: '0.74.0' };
function fixture(raw: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'qg-scan-receipt-')); mkdirSync(join(root, 'out'));
  const input = join(root, 'raw.json'); const binding = join(root, 'binding.json'); const toolchain = join(root, 'toolchain.json'); const imageIdentities = join(root, 'images.json'); const output = join(root, 'out', 'receipt.json');
  writeFileSync(input, JSON.stringify(raw));
  writeFileSync(binding, JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source }));
  writeFileSync(toolchain, JSON.stringify({ schemaVersion: 1, ok: true, tools: Object.entries(versions).map(([id, expectedVersion]) => ({ id, expectedVersion, status: 'PASS', ...(id === 'gitleaks' ? { functionalCanary: { status: 'PASS', findingCount: 1 } } : {}) })) }));
  const digest = `sha256:${'c'.repeat(64)}`;
  writeFileSync(imageIdentities, JSON.stringify({ schemaVersion: 1, images: [{ component: 'gateway', reference: 'quarangate-gateway:git-test', digest }] }));
  return { input, binding, toolchain, imageIdentities, output };
}
function run(gate: string, raw: unknown, exitCode: number, mutate?: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture(raw); mutate?.(f);
  const args = ['scripts/release-scan-receipt.mjs', '--gate', gate, '--input', f.input, '--source-binding', f.binding, '--toolchain-report', f.toolchain, '--scanner-exit-code', String(exitCode), '--output', f.output];
  if (gate === 'image-scan') args.push('--image-identities', f.imageIdentities);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const receipt = (() => { try { return JSON.parse(readFileSync(f.output, 'utf8')); } catch { return null; } })();
  return { r, receipt };
}

describe('SH-05 scanner report normalization', () => {
  it('normalizes Semgrep findings and fails closed on scanner errors/exit mismatch', () => {
    const raw = { results: [{ check_id: 'ts.security.example', path: 'src/a.ts', start: { line: 4, col: 2 }, end: { line: 4, col: 8 }, extra: { severity: 'ERROR', message: 'unsafe pattern', fingerprint: 'fp' } }], errors: [] };
    let { r, receipt } = run('sast', raw, 1); expect(r.status, r.stderr).toBe(0); expect(receipt.status).toBe('PASS'); expect(receipt.scan.toolchainReportSha256).toMatch(/^[0-9a-f]{64}$/); expect(receipt.scan.sourceBindingSha256).toMatch(/^[0-9a-f]{64}$/); expect(receipt.findings[0]).toMatchObject({ severity: 'HIGH', category: 'code', ruleId: 'ts.security.example', path: 'src/a.ts', line: 4 });
    ({ r, receipt } = run('sast', { ...raw, errors: [{ message: 'parse failed' }] }, 1)); expect(r.status).toBe(4); expect(receipt.status).toBe('FAIL');
    ({ r, receipt } = run('sast', raw, 0)); expect(r.status).toBe(4); expect(receipt.scanError).toContain('required --error contract');
  });

  it('normalizes only redacted Gitleaks findings and treats exit 1 without findings as ambiguous error', () => {
    const leak = { RuleID: 'generic-api-key', File: 'config.txt', StartLine: 7, Fingerprint: 'abc', Secret: 'REDACTED', Match: 'REDACTED' };
    let { r, receipt } = run('secrets', [leak], 1); expect(r.status, r.stderr).toBe(0); expect(receipt.findings[0]).toMatchObject({ severity: 'HIGH', category: 'secret', ruleId: 'generic-api-key', path: 'config.txt', line: 7 }); expect(JSON.stringify(receipt)).not.toContain('api-key-value');
    ({ r, receipt } = run('secrets', [{ ...leak, Secret: 'api-key-value' }], 1)); expect(r.status).toBe(4); expect(receipt.scanError).toContain('unredacted'); expect(JSON.stringify(receipt)).not.toContain('api-key-value');
    ({ r, receipt } = run('secrets', [], 1)); expect(r.status).toBe(4); expect(receipt.scanError).toContain('ambiguous/error');
  });

  it('requires the proven Gitleaks functional canary', () => {
    const { r } = run('secrets', [], 0, (f) => {
      const report = JSON.parse(readFileSync(f.toolchain, 'utf8')); report.tools.find((x: any) => x.id === 'gitleaks').functionalCanary.status = 'FAIL'; writeFileSync(f.toolchain, JSON.stringify(report));
    });
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('functional canary');
  });

  it('normalizes OSV vulnerabilities conservatively and rejects non-result error exits', () => {
    const raw = { results: [{ source: { path: 'package-lock.json', type: 'lockfile' }, packages: [{ package: { name: 'dep', version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'GHSA-test', summary: 'example issue' }] }] }] };
    let { r, receipt } = run('sca', raw, 1); expect(r.status, r.stderr).toBe(0); expect(receipt.findings[0]).toMatchObject({ severity: 'CRITICAL', category: 'dependency', ruleId: 'GHSA-test', package: 'dep', version: '1.0.0' });
    ({ r, receipt } = run('sca', raw, 127)); expect(r.status).toBe(4); expect(receipt.scanError).toContain('non-result/error exit 127');
    ({ r, receipt } = run('sca', { results: [] }, 128)); expect(r.status).toBe(4); expect(receipt.scanError).toContain('non-result/error exit 128');
  });

  it('normalizes Trivy config findings and requires the findings exit contract', () => {
    const raw = { SchemaVersion: 2, Results: [{ Target: 'compose.yaml', Misconfigurations: [{ ID: 'AVD-DS-0001', Severity: 'CRITICAL', Title: 'privileged container', CauseMetadata: { StartLine: 9 } }] }] };
    let { r, receipt } = run('config-scan', raw, 1); expect(r.status, r.stderr).toBe(0); expect(receipt.findings[0]).toMatchObject({ severity: 'CRITICAL', category: 'configuration', path: 'compose.yaml', line: 9 });
    ({ r, receipt } = run('config-scan', raw, 0)); expect(r.status).toBe(4); expect(receipt.scanError).toContain('required --exit-code 1 contract');
  });

  it('does not discard unexpected Trivy finding classes and fail-safes unknown severity to CRITICAL', () => {
    const raw = { SchemaVersion: 2, Results: [{ Target: 'compose.yaml', Misconfigurations: [{ ID: 'AVD-X', Severity: 'UNKNOWN', Title: 'unknown config risk' }], Vulnerabilities: [{ VulnerabilityID: 'CVE-X', PkgName: 'dep', InstalledVersion: '1', Severity: 'UNKNOWN' }], Secrets: [{ RuleID: 'token', StartLine: 5 }] }] };
    const { r, receipt } = run('config-scan', raw, 1);
    expect(r.status, r.stderr).toBe(0);
    expect(receipt.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'AVD-X', category: 'configuration', severity: 'CRITICAL' }),
      expect.objectContaining({ ruleId: 'CVE-X', category: 'dependency', severity: 'CRITICAL' }),
      expect.objectContaining({ ruleId: 'token', category: 'secret', severity: 'HIGH' }),
    ]));
  });

  it('binds Trivy image findings to exact immutable release image identities without copying secret material', () => {
    const digest = `sha256:${'c'.repeat(64)}`; const reference = 'quarangate-gateway:git-test'; const scanTarget = `${reference}@${digest}`; const repoDigest = `quarangate-gateway@${digest}`;
    const raw = [{ SchemaVersion: 2, ArtifactName: scanTarget, ArtifactType: 'container_image', Metadata: { RepoDigests: [repoDigest] }, Results: [{ Target: 'quarangate-gateway', Vulnerabilities: [{ VulnerabilityID: 'CVE-2026-0001', PkgName: 'libx', InstalledVersion: '1.2.3', Severity: 'CRITICAL', Title: 'critical vuln' }], Secrets: [{ RuleID: 'private-key', StartLine: 3, Title: 'private key', Match: 'SENSITIVE' }] }] }];
    let { r, receipt } = run('image-scan', raw, 1); expect(r.status, r.stderr).toBe(0); expect(receipt.images).toEqual([{ component: 'gateway', reference, digest }]); expect(receipt.scan.imageIdentitiesSha256).toMatch(/^[0-9a-f]{64}$/u); expect(receipt.findings).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'dependency', severity: 'CRITICAL' }), expect.objectContaining({ category: 'secret', severity: 'HIGH' })])); expect(JSON.stringify(receipt)).not.toContain('SENSITIVE');
    ({ r, receipt } = run('image-scan', [{ ...raw[0], ArtifactName: `other@${digest}` }], 1)); expect(r.status).toBe(4); expect(receipt.scanError).toContain('exact release image identity');
    ({ r, receipt } = run('image-scan', [{ ...raw[0], Metadata: { RepoDigests: [] } }], 1)); expect(r.status).toBe(4); expect(receipt.scanError).toContain('exact release image identity');
  });

  it('fails closed if the toolchain report cannot prove the pinned scanner version', () => {
    const { r } = run('sast', { results: [], errors: [] }, 0, (f) => {
      const report = JSON.parse(readFileSync(f.toolchain, 'utf8')); report.tools.find((x: any) => x.id === 'semgrep').expectedVersion = '0.0.0'; writeFileSync(f.toolchain, JSON.stringify(report));
    });
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('does not prove pinned semgrep@1.177.0');
  });
});
