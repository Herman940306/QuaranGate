import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const commit = 'a'.repeat(40);
const tree = 'e'.repeat(40);
const fixedAt = '2026-09-16T12:00:00.000Z';
const repository = 'https://github.com/Herman940306/QuaranGate.git';
const source = { repository, branch: 'release/test', commit, tree, clean: true };
const productionPolicy = JSON.parse(readFileSync('security/release-policy.json', 'utf8'));
const policy = structuredClone(productionPolicy);
policy.gateContracts = { ...policy.gateContracts, e2e: { state: 'TEST_FIXTURE_INTEGRATED', passAllowed: true, failureCode: 'TEST_ONLY' } };

function expectedTool(gate: string) { return policy.expectedTools[gate] ?? { name: 'test-runner', version: '1' }; }
const digest = 'f'.repeat(64);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function execution(commandId: string) {
  return { commandId, exitCode: 0, signal: null, durationMs: 1, stdout: { sha256: digest, bytes: 0 }, stderr: { sha256: digest, bytes: 0 } };
}
function validReceipt(gate: string, sourceBindingSha256: string, findings: any[]) {
  const receipt: any = { schemaVersion: 1, gate, status: 'PASS', source, tool: expectedTool(gate), findings };
  const commandIds: Record<string, string> = {
    typecheck: 'typescript-typecheck', build: 'typescript-build', unit: 'vitest-unit', integration: 'vitest-integration',
    e2e: 'playwright-e2e', 'system-e2e': 'p10-system-e2e-validate', 'authority-invariants': 'authority-invariants', 'security-fuzz': 'security-fuzz', 'security-chaos': 'vitest-security-chaos', 'security-egress': 'vitest-security-egress', 'security-docker': 'vitest-security-docker', 'security-prompt-injection': 'vitest-security-prompt-injection', sbom: 'release-sbom', provenance: 'cosign-verify-blob-attestation',
  };
  if (commandIds[gate]) receipt.execution = execution(commandIds[gate]);
  if (['unit', 'integration', 'e2e', 'security-chaos', 'security-egress', 'security-docker', 'security-prompt-injection'].includes(gate)) receipt.testCounts = { files: 2, tests: 10, failed: 0 };
  if (gate === 'system-e2e') receipt.artifact = {
    schemaVersion: 2, status: 'PASS', runId: 'p10-system-e2e-fixture-001', operatorId: 'qualification-operator-a', sourceCommit: commit, productVersion: '1.0.0',
    releaseManifestDigest: digest, signedPackageSha256: digest,
    releaseSignatureProofSha256: digest, releaseTrustPolicyId: 'installer-release-trust-v1', releaseTrustPolicySha256: digest,
    signingKeyId: 'release-key-a', signingKeyFingerprint: digest, evidenceManifestSha256: digest, reviewReceiptSha256: digest,
    reviewerId: 'independent-reviewer-b', reviewedAt: '2026-09-17T13:00:00.000Z',
    stepCount: 15, artifactCount: 15, totalArtifactBytes: 1500,
    environment: 'DISPOSABLE_QUALIFICATION', platform: 'WINDOWS11_WSL2',
  };
  if (gate === 'authority-invariants') receipt.artifact = { rulesChecked: 12, composeFilesChecked: 10, dockerfilesChecked: 7 };
  if (gate === 'security-fuzz') receipt.artifact = { targetCount: 15, totalExecutions: 30060, coverageRanges: 106, iterationsPerTarget: 2000, maxInputBytes: 1024, maxCorpus: 256, maxRuntimeMs: 20000, coverageSampleInterval: 16, seed: 0x51f08a11 };
  if (gate === 'sbom') receipt.artifact = { kind: 'spdx-json', sha256: digest, bytes: 100 };
  if (['sast', 'secrets', 'sca', 'config-scan', 'image-scan'].includes(gate)) receipt.scan = {
    scannerExitCode: findings.length ? 1 : 0, rawReportSha256: digest, rawReportBytes: 100, toolchainReportSha256: digest,
    sourceBindingSha256, normalizedFindingCount: findings.length,
  };
  if (gate === 'image-scan') {
    receipt.scan.imageIdentitiesSha256 = digest;
    receipt.images = [{ component: 'gateway', reference: 'quarangate-gateway:git-test', digest: `sha256:${'c'.repeat(64)}` }];
  }
  if (gate === 'provenance') {
    receipt.statement = { predicateType: 'https://slsa.dev/provenance/v1', sha256: digest, bytes: 100, subjectCount: 3, releaseManifestSha256: digest, releaseManifestDigest: digest, sbomSha256: digest };
    receipt.bundle = { sha256: digest, bytes: 100, mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', signedStatementSha256: digest, signedStatementBytes: 90 };
    receipt.publicKey = { sha256: digest, bytes: 32 };
  }
  return receipt;
}
function fixture(findings: Record<string, any[]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qg-release-policy-'));
  const evidence = join(dir, 'evidence'); mkdirSync(evidence);
  const policyPath = join(dir, 'policy.json');
  const baselinePath = join(dir, 'baseline.json');
  const exceptionsPath = join(dir, 'exceptions.json');
  const sourceBindingPath = join(dir, 'source-binding.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 1, findings: [] }));
  writeFileSync(exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: [] }));
  const sourceBindingBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source }));
  writeFileSync(sourceBindingPath, sourceBindingBytes);
  const sourceBindingSha256 = sha256(sourceBindingBytes);
  for (const gate of policy.requiredGates) {
    writeFileSync(join(evidence, `${gate}.json`), JSON.stringify(validReceipt(gate, sourceBindingSha256, findings[gate] ?? [])));
  }
  return { evidence, policyPath, baselinePath, exceptionsPath, sourceBindingPath };
}
function evaluate(f: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, [
    'scripts/release-security-policy.mjs', '--evidence-dir', f.evidence, '--source-binding', f.sourceBindingPath, '--at', fixedAt,
    '--policy', f.policyPath, '--baseline', f.baselinePath, '--exceptions', f.exceptionsPath,
  ], { encoding: 'utf8' });
}

describe('SH-05 release security policy', () => {
  it('passes a complete evidence set bound to the exact mechanical source receipt', () => {
    const f = fixture(); const r = evaluate(f); expect(r.status, r.stderr || r.stdout).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.verdict).toBe('PASS'); expect(report.requiredGateCount).toBe(19); expect(report.evidence).toHaveLength(19);
    expect(report.source).toEqual(source); expect(report.sourceBinding.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when any gate contract explicitly forbids a PASS', () => {
    const f = fixture();
    const forbiddenPolicy = structuredClone(productionPolicy);
    forbiddenPolicy.gateContracts.e2e = { state: 'TEST_FORBIDDEN', passAllowed: false, failureCode: 'TEST_E2E_PASS_FORBIDDEN' };
    writeFileSync(f.policyPath, JSON.stringify(forbiddenPolicy));
    const r = evaluate(f);
    expect(r.status).toBe(3);
    const failures = JSON.parse(r.stdout).failures;
    expect(failures).toContainEqual(expect.objectContaining({
      gate: 'e2e', code: 'GATE_PASS_NOT_ALLOWED', failureCode: 'TEST_E2E_PASS_FORBIDDEN',
    }));
  });

  it('rejects structurally minimal hand-authored PASS receipts that do not prove gate execution', () => {
    const f = fixture();
    writeFileSync(join(f.evidence, 'unit.json'), JSON.stringify({ schemaVersion: 1, gate: 'unit', status: 'PASS', source, tool: expectedTool('unit'), findings: [], testCounts: { files: 1, tests: 1, failed: 0 } }));
    for (const gate of ['security-docker', 'security-prompt-injection']) {
      writeFileSync(join(f.evidence, `${gate}.json`), JSON.stringify({
        schemaVersion: 1, gate, status: 'PASS', source, tool: expectedTool(gate), findings: [],
      }));
    }
    writeFileSync(join(f.evidence, 'sast.json'), JSON.stringify({ schemaVersion: 1, gate: 'sast', status: 'PASS', source, tool: expectedTool('sast'), findings: [] }));
    writeFileSync(join(f.evidence, 'provenance.json'), JSON.stringify({ schemaVersion: 1, gate: 'provenance', status: 'PASS', source, tool: expectedTool('provenance'), findings: [] }));
    const r = evaluate(f); expect(r.status).toBe(3);
    const failures = JSON.parse(r.stdout).failures;
    expect(failures).toContainEqual(expect.objectContaining({ gate: 'unit', code: 'INVALID_EXECUTION_EVIDENCE' }));
    for (const gate of ['security-docker', 'security-prompt-injection']) {
      expect(failures).toContainEqual(expect.objectContaining({ gate, code: 'INVALID_EXECUTION_EVIDENCE' }));
      expect(failures).toContainEqual(expect.objectContaining({ gate, code: 'INVALID_TEST_COUNTS' }));
    }
    expect(failures).toContainEqual(expect.objectContaining({ gate: 'sast', code: 'INVALID_SCAN_EVIDENCE' }));
    expect(failures).toContainEqual(expect.objectContaining({ gate: 'provenance', code: 'INVALID_PROVENANCE_EVIDENCE' }));
  });

  it('fails closed on system-e2e bounded summary source/environment drift', () => {
    for (const mutate of [
      (receipt: any) => { receipt.artifact.sourceCommit = 'b'.repeat(40); },
      (receipt: any) => { receipt.artifact.environment = 'PRODUCTION'; },
      (receipt: any) => { receipt.artifact.stepCount = 14; },
    ]) {
      const f = fixture();
      const path = join(f.evidence, 'system-e2e.json');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      mutate(receipt); writeFileSync(path, JSON.stringify(receipt));
      const r = evaluate(f); expect(r.status).toBe(3);
      expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ gate: 'system-e2e', code: 'INVALID_SYSTEM_E2E_EVIDENCE' }));
    }
  });

  it('fails closed for invalid source-binding identity', () => {
    const f = fixture();
    writeFileSync(f.sourceBindingPath, JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source: { ...source, clean: false } }));
    const r = evaluate(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('source-binding receipt is not a valid exact clean source receipt');
  });

  it('fails closed for missing or malformed evidence', () => {
    const missing = fixture(); unlinkSync(join(missing.evidence, 'integration.json'));
    let r = evaluate(missing); expect(r.status).toBe(3); expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ gate: 'integration', code: 'MISSING_EVIDENCE' }));
    const malformed = fixture(); writeFileSync(join(malformed.evidence, 'unit.json'), '{not-json');
    r = evaluate(malformed); expect(r.status).toBe(3); expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ gate: 'unit', code: 'MALFORMED_EVIDENCE' }));
  });

  it('fails closed for commit/tree/repository drift, non-PASS gates, and tool drift', () => {
    const f = fixture();
    writeFileSync(join(f.evidence, 'sast.json'), JSON.stringify({ schemaVersion: 1, gate: 'sast', status: 'FAIL', source: { ...source, tree: 'b'.repeat(40) }, tool: { name: 'semgrep', version: '1.176.0' }, findings: [] }));
    const r = evaluate(f); expect(r.status).toBe(3);
    const codes = JSON.parse(r.stdout).failures.map((x: any) => x.code);
    expect(codes).toContain('STALE_OR_DIRTY_SOURCE_BINDING'); expect(codes).toContain('GATE_NOT_PASS'); expect(codes).toContain('TOOL_VERSION_MISMATCH');
  });

  it('never lets baseline or owner exception waive CRITICAL or authority/integrity/secret findings', () => {
    const findings = [
      { fingerprint: 'critical-dependency-1', severity: 'CRITICAL', category: 'dependency' },
      { fingerprint: 'authority-medium-1', severity: 'MEDIUM', category: 'authority' },
      { fingerprint: 'integrity-low-1', severity: 'LOW', category: 'integrity' },
      { fingerprint: 'secret-high-1', severity: 'HIGH', category: 'secret' },
    ];
    const f = fixture({ sast: findings });
    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: findings.map((finding) => ({ ...finding, gate: 'sast', firstObservedCommit: '1'.repeat(40), ownerApprovedBy: 'Herman', reason: 'must not bypass absolute blocker' })) }));
    writeFileSync(f.exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: findings.map((finding) => ({ gate: 'sast', fingerprint: finding.fingerprint, ownerApprovedBy: 'Herman', reason: 'must not bypass absolute blocker', expiresAt: '2026-09-17T00:00:00.000Z' })) }));
    const r = evaluate(f); expect(r.status).toBe(3); const report = JSON.parse(r.stdout);
    for (const finding of findings) expect(report.failures).toContainEqual(expect.objectContaining({ code: 'BLOCKING_FINDING', fingerprint: finding.fingerprint }));
  });

  it('allows an existing non-sensitive HIGH only through a gate-bound baseline or valid owner exception', () => {
    const finding = { fingerprint: 'cve-high-known', severity: 'HIGH', category: 'dependency' };
    const f = fixture({ sca: [finding] }); let r = evaluate(f); expect(r.status).toBe(3);
    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: [{ ...finding, gate: 'sca', firstObservedCommit: '1'.repeat(40), ownerApprovedBy: 'Herman', reason: 'known pre-existing dependency finding' }] }));
    r = evaluate(f); expect(r.status, r.stdout).toBe(0); expect(JSON.parse(r.stdout).tolerated).toContainEqual(expect.objectContaining({ disposition: 'BASELINE' }));
    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: [] }));
    writeFileSync(f.exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: [{ gate: 'sca', fingerprint: finding.fingerprint, ownerApprovedBy: 'Herman', reason: 'bounded temporary dependency exception', expiresAt: '2026-09-17T00:00:00.000Z' }] }));
    r = evaluate(f); expect(r.status, r.stdout).toBe(0); expect(JSON.parse(r.stdout).tolerated).toContainEqual(expect.objectContaining({ disposition: 'OWNER_EXCEPTION' }));
  });

  it('does not let another gate or incomplete metadata waive a HIGH finding', () => {
    const finding = { fingerprint: 'cve-high-scope', severity: 'HIGH', category: 'dependency' }; const f = fixture({ sca: [finding] });
    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: [{ ...finding, gate: 'sast', ownerApprovedBy: 'Herman', reason: 'wrong gate', firstObservedCommit: '1'.repeat(40) }] }));
    writeFileSync(f.exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: [{ gate: 'sast', fingerprint: finding.fingerprint, ownerApprovedBy: 'Herman', reason: 'wrong gate', expiresAt: '2026-09-17T00:00:00.000Z' }] }));
    const r = evaluate(f); expect(r.status).toBe(3); expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ code: 'NEW_HIGH_FINDING' }));
  });

  it('fails closed when a finding lacks a stable fingerprint', () => {
    const f = fixture({ sast: [{ severity: 'HIGH', category: 'dependency' }] }); const r = evaluate(f); expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ code: 'FINDING_WITHOUT_FINGERPRINT' }));
  });
});
