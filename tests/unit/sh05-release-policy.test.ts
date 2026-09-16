import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const commit = 'a'.repeat(40);
const fixedAt = '2026-09-16T12:00:00.000Z';
const policy = JSON.parse(readFileSync('security/release-policy.json', 'utf8'));

function expectedTool(gate: string) {
  return policy.expectedTools[gate] ?? { name: 'test-runner', version: '1' };
}

function fixture(findings: Record<string, any[]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qg-release-policy-'));
  const evidence = join(dir, 'evidence');
  mkdirSync(evidence);
  const policyPath = join(dir, 'policy.json');
  const baselinePath = join(dir, 'baseline.json');
  const exceptionsPath = join(dir, 'exceptions.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 1, findings: [] }));
  writeFileSync(exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: [] }));
  for (const gate of policy.requiredGates) {
    writeFileSync(join(evidence, `${gate}.json`), JSON.stringify({
      schemaVersion: 1,
      gate,
      status: 'PASS',
      source: { commit, clean: true },
      tool: expectedTool(gate),
      findings: findings[gate] ?? [],
    }));
  }
  return { dir, evidence, policyPath, baselinePath, exceptionsPath };
}

function evaluate(f: ReturnType<typeof fixture>, commitArg = commit) {
  return spawnSync(process.execPath, [
    'scripts/release-security-policy.mjs',
    '--evidence-dir', f.evidence,
    '--commit', commitArg,
    '--at', fixedAt,
    '--policy', f.policyPath,
    '--baseline', f.baselinePath,
    '--exceptions', f.exceptionsPath,
  ], { encoding: 'utf8' });
}

describe('SH-05 release security policy', () => {
  it('passes a complete exact-source evidence set with the pinned tools', () => {
    const f = fixture();
    const r = evaluate(f);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.verdict).toBe('PASS');
    expect(report.requiredGateCount).toBe(13);
    expect(report.evidence).toHaveLength(13);
  });

  it('fails closed for missing or malformed evidence', () => {
    const missing = fixture();
    unlinkSync(join(missing.evidence, 'integration.json'));
    let r = evaluate(missing);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ gate: 'integration', code: 'MISSING_EVIDENCE' }));

    const malformed = fixture();
    writeFileSync(join(malformed.evidence, 'unit.json'), '{not-json');
    r = evaluate(malformed);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ gate: 'unit', code: 'MALFORMED_EVIDENCE' }));
  });

  it('fails closed for stale/dirty source, non-PASS gates, and tool drift', () => {
    const f = fixture();
    writeFileSync(join(f.evidence, 'sast.json'), JSON.stringify({
      schemaVersion: 1,
      gate: 'sast',
      status: 'FAIL',
      source: { commit: 'b'.repeat(40), clean: false },
      tool: { name: 'semgrep', version: '1.176.0' },
      findings: [],
    }));
    const r = evaluate(f);
    expect(r.status).toBe(3);
    const codes = JSON.parse(r.stdout).failures.map((x: any) => x.code);
    expect(codes).toContain('STALE_OR_DIRTY_SOURCE_BINDING');
    expect(codes).toContain('GATE_NOT_PASS');
    expect(codes).toContain('TOOL_VERSION_MISMATCH');
  });

  it('never lets a baseline or owner exception waive CRITICAL or authority/integrity/secret findings', () => {
    const findings = [
      { fingerprint: 'critical-dependency-1', severity: 'CRITICAL', category: 'dependency' },
      { fingerprint: 'authority-medium-1', severity: 'MEDIUM', category: 'authority' },
      { fingerprint: 'integrity-low-1', severity: 'LOW', category: 'integrity' },
      { fingerprint: 'secret-high-1', severity: 'HIGH', category: 'secret' },
    ];
    const f = fixture({ sast: findings });
    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: findings.map((finding) => ({ ...finding, gate: 'sast', firstObservedCommit: '1'.repeat(40), ownerApprovedBy: 'Herman', reason: 'must not bypass absolute blocker' })) }));
    writeFileSync(f.exceptionsPath, JSON.stringify({
      schemaVersion: 1,
      exceptions: findings.map((finding) => ({
        gate: 'sast',
        fingerprint: finding.fingerprint,
        ownerApprovedBy: 'Herman',
        reason: 'must not bypass absolute blocker',
        expiresAt: '2026-09-17T00:00:00.000Z',
      })),
    }));
    const r = evaluate(f);
    expect(r.status).toBe(3);
    const report = JSON.parse(r.stdout);
    for (const finding of findings) {
      expect(report.failures).toContainEqual(expect.objectContaining({ code: 'BLOCKING_FINDING', fingerprint: finding.fingerprint }));
      expect(report.tolerated).not.toContainEqual(expect.objectContaining({ fingerprint: finding.fingerprint }));
    }
  });

  it('allows an existing non-sensitive HIGH only through an explicit baseline or valid owner exception', () => {
    const finding = { fingerprint: 'cve-high-known', severity: 'HIGH', category: 'dependency' };
    const f = fixture({ sca: [finding] });
    let r = evaluate(f);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ code: 'NEW_HIGH_FINDING' }));

    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: [{ ...finding, gate: 'sca', firstObservedCommit: '1'.repeat(40), ownerApprovedBy: 'Herman', reason: 'known pre-existing dependency finding' }] }));
    r = evaluate(f);
    expect(r.status, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).tolerated).toContainEqual(expect.objectContaining({ fingerprint: finding.fingerprint, disposition: 'BASELINE' }));

    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: [] }));
    writeFileSync(f.exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: [{
      gate: 'sca',
      fingerprint: finding.fingerprint,
      ownerApprovedBy: 'Herman',
      reason: 'bounded temporary dependency exception',
      expiresAt: '2026-09-17T00:00:00.000Z',
    }] }));
    r = evaluate(f);
    expect(r.status, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).tolerated).toContainEqual(expect.objectContaining({ fingerprint: finding.fingerprint, disposition: 'OWNER_EXCEPTION' }));

    writeFileSync(f.exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: [{
      gate: 'sca',
      fingerprint: finding.fingerprint,
      ownerApprovedBy: 'Herman',
      reason: 'expired dependency exception',
      expiresAt: '2026-09-15T00:00:00.000Z',
    }] }));
    r = evaluate(f);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ code: 'NEW_HIGH_FINDING', fingerprint: finding.fingerprint }));
  });

  it('does not let a baseline or exception for another gate or incomplete metadata waive a HIGH finding', () => {
    const finding = { fingerprint: 'cve-high-scope', severity: 'HIGH', category: 'dependency' };
    const f = fixture({ sca: [finding] });
    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: [{ ...finding, gate: 'sast', ownerApprovedBy: 'Herman', reason: 'wrong gate', firstObservedCommit: '1'.repeat(40) }] }));
    writeFileSync(f.exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: [{ gate: 'sast', fingerprint: finding.fingerprint, ownerApprovedBy: 'Herman', reason: 'wrong gate', expiresAt: '2026-09-17T00:00:00.000Z' }] }));
    let r = evaluate(f);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ code: 'NEW_HIGH_FINDING', fingerprint: finding.fingerprint }));

    writeFileSync(f.baselinePath, JSON.stringify({ schemaVersion: 1, findings: [{ ...finding, gate: 'sca', ownerApprovedBy: 'Herman', reason: '', firstObservedCommit: '1'.repeat(40) }] }));
    writeFileSync(f.exceptionsPath, JSON.stringify({ schemaVersion: 1, exceptions: [] }));
    r = evaluate(f);
    expect(r.status).toBe(3);
  });

  it('fails closed when a finding lacks a stable fingerprint', () => {
    const f = fixture({ sast: [{ severity: 'HIGH', category: 'dependency' }] });
    const r = evaluate(f);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).failures).toContainEqual(expect.objectContaining({ code: 'FINDING_WITHOUT_FINGERPRINT' }));
  });
});
