import { describe, expect, it } from 'vitest';
import {
  executionEvidence,
  gateDefinition,
  parseVitestReport,
  pathIsWithinRoot,
  unavailableReceipt,
  validateSourceBindingReceipt,
} from '../../scripts/release-gate-receipt.mjs';

const source = {
  repository: 'https://github.com/Herman940306/QuaranGate.git',
  branch: 'security/sh05-release-assurance-gpt',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  clean: true,
};

describe('SH-05 fixed release gate receipt executor', () => {
  it('admits only fixed release gates and never arbitrary caller commands', () => {
    expect(gateDefinition('typecheck').commandId).toBe('typescript-typecheck');
    expect(gateDefinition('integration').commandId).toBe('vitest-integration');
    expect(() => gateDefinition('rm -rf /')).toThrow(/unsupported fixed release gate/u);
  });

  it('marks E2E unavailable until a canonical entry point is integrated', () => {
    const definition = gateDefinition('e2e');
    expect(definition).toEqual({ unavailable: true, reason: 'CANONICAL_E2E_ENTRYPOINT_NOT_INTEGRATED' });
    expect(unavailableReceipt('e2e', source, definition)).toEqual(expect.objectContaining({
      gate: 'e2e', status: 'UNAVAILABLE', source, failureCode: 'CANONICAL_E2E_ENTRYPOINT_NOT_INTEGRATED',
    }));
  });

  it('accepts only exact all-passing Vitest reports with real file/test counts', () => {
    expect(parseVitestReport({
      success: true, numTotalTests: 12, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      testResults: [{ status: 'passed' }, { status: 'passed' }],
    })).toEqual({ files: 2, tests: 12, failed: 0 });
    for (const report of [
      { success: false, numTotalTests: 1, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, testResults: [{ status: 'failed' }] },
      { success: true, numTotalTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0, testResults: [{ status: 'passed' }] },
      { success: true, numTotalTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 1, testResults: [{ status: 'passed' }] },
      { success: true, numTotalTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [] },
    ]) expect(() => parseVitestReport(report)).toThrow(/all-passing/u);
  });

  it('requires an exact clean source-binding receipt', () => {
    expect(validateSourceBindingReceipt({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source })).toEqual(source);
    expect(() => validateSourceBindingReceipt({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source: { ...source, clean: false } })).toThrow(/source-binding/u);
    expect(() => validateSourceBindingReceipt({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source: { ...source, commit: 'nope' } })).toThrow(/source-binding/u);
  });

  it('classifies evidence paths inside the source tree so receipts cannot dirty the source after attestation', () => {
    expect(pathIsWithinRoot('/repo/root', '/repo/root/evidence/unit.json')).toBe(true);
    expect(pathIsWithinRoot('/repo/root', '/repo/root')).toBe(true);
    expect(pathIsWithinRoot('/repo/root', '/repo/root-other/unit.json')).toBe(false);
    expect(pathIsWithinRoot('/repo/root', '/tmp/qg-evidence/unit.json')).toBe(false);
  });

  it('records command output only as hashes and byte counts, never raw potentially sensitive text', () => {
    const result = { status: 0, signal: null, durationMs: 7, stdout: 'SECRET_OUTPUT', stderr: 'PRIVATE_ERROR' };
    const evidence = executionEvidence(result, 'fixed-command');
    expect(evidence).toEqual(expect.objectContaining({ commandId: 'fixed-command', exitCode: 0, durationMs: 7 }));
    expect(JSON.stringify(evidence)).not.toContain('SECRET_OUTPUT');
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_ERROR');
    expect(evidence.stdout).toEqual(expect.objectContaining({ bytes: 13, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }));
  });
});
