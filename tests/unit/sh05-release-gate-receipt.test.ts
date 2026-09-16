import { describe, expect, it } from 'vitest';
import {
  e2ePrerequisites,
  executionEvidence,
  gateDefinition,
  integrationPrerequisites,
  parsePlaywrightReport,
  parseVitestReport,
  pathIsWithinRoot,
  unavailableReceipt,
  validateSourceBindingReceipt,
  vitestGateInvocation,
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

  it('binds security-fuzz to the fixed bounded no-download runner contract', () => {
    expect(gateDefinition('security-fuzz')).toEqual({
      binary: process.execPath,
      args: ['scripts/security-fuzz.mjs', '--build', '--iterations', '2000', '--max-input-bytes', '1024', '--max-corpus', '256', '--max-runtime-ms', '20000'],
      tool: { name: 'quarangate-security-fuzz', version: '1' },
      commandId: 'security-fuzz',
    });
  });

  it('routes fixed unit/integration execution through the self-cleaning Vitest wrapper', () => {
    const unit = vitestGateInvocation(gateDefinition('unit'), '/external/unit.json');
    expect(unit.binary).toBe(process.execPath);
    expect(unit.args).toEqual([
      'scripts/run-vitest-clean.mjs', 'tests/unit', '--no-file-parallelism', '--reporter=json', '--outputFile=/external/unit.json',
    ]);
    const integration = vitestGateInvocation(gateDefinition('integration'), '/external/integration.json');
    expect(integration.args[1]).toBe('tests/integration');
    expect(() => vitestGateInvocation(gateDefinition('typecheck') as any, '/external/nope.json')).toThrow(/Vitest gate definition/u);
  });

  it('binds E2E to the canonical pinned Playwright entry point', () => {
    const definition = gateDefinition('e2e');
    expect(definition).toEqual({
      e2e: true,
      tool: { name: '@playwright/test', version: '1.63.0' },
      commandId: 'playwright-e2e',
    });
  });

  it('classifies E2E dependencies/browser readiness without inventing a PASS', () => {
    expect(e2ePrerequisites({
      installedVersion: () => null,
      probeBrowser: () => { throw new Error('must not probe without dependencies'); },
    })).toEqual(['E2E_DEPENDENCIES_UNAVAILABLE']);
    expect(e2ePrerequisites({
      installedVersion: () => '1.62.0',
      probeBrowser: () => { throw new Error('must not probe mismatched dependency'); },
    })).toEqual(['E2E_DEPENDENCY_VERSION_MISMATCH']);
    expect(e2ePrerequisites({
      installedVersion: () => '1.63.0',
      probeBrowser: () => ({ status: 2, errorCode: null, stdout: '{"ok":false,"code":"BROWSER_EXECUTABLE_UNAVAILABLE"}' }),
    })).toEqual(['BROWSER_EXECUTABLE_UNAVAILABLE']);
    expect(e2ePrerequisites({
      installedVersion: () => '1.63.0',
      probeBrowser: () => ({ status: 0, errorCode: null, stdout: '{"ok":true}' }),
    })).toEqual([]);
  });

  it('accepts only rendered all-passing Playwright reports with zero skips/flakes/retries', () => {
    const passing = {
      config: {
        workers: 1, forbidOnly: true, fullyParallel: false,
        projects: [
          { name: 'chromium-workstation', retries: 0 },
          { name: 'chromium-narrow', retries: 0 },
        ],
      },
      errors: [],
      stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
      suites: [{ title: 'browser', specs: [
        { file: 'a.spec.ts', tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] },
        { file: 'b.spec.ts', tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] },
      ] }],
    };
    expect(parsePlaywrightReport(passing)).toEqual({ files: 2, tests: 2, failed: 0 });
    expect(() => parsePlaywrightReport({ ...passing, stats: { ...passing.stats, skipped: 1, expected: 1 } })).toThrow(/zero-skip/u);
    expect(() => parsePlaywrightReport({ ...passing, stats: { ...passing.stats, flaky: 1 } })).toThrow(/zero-skip/u);
    const retried = structuredClone(passing);
    retried.suites[0].specs[0].tests[0].results.push({ status: 'passed' });
    expect(() => parsePlaywrightReport(retried)).toThrow(/retried/u);
  });

  it('classifies missing full-integration prerequisites without exposing secret values', () => {
    const absent = integrationPrerequisites({
      env: {},
      exists: () => false,
      probeDocker: () => ({ status: null, errorCode: 'ENOENT' }),
    });
    expect(absent).toEqual(['KEYS_ENV_NOT_CONFIGURED', 'DOCKER_CLI_UNAVAILABLE']);

    const runtimeDown = integrationPrerequisites({
      env: { KEYS_ENV: '/secret/path/keys.env' },
      exists: () => true,
      probeDocker: () => ({ status: 1, errorCode: null }),
    });
    expect(runtimeDown).toEqual(['DOCKER_RUNTIME_UNAVAILABLE']);
    expect(JSON.stringify(runtimeDown)).not.toContain('/secret/path/keys.env');

    const ready = integrationPrerequisites({
      env: { KEYS_ENV: '/keys.env' },
      exists: () => true,
      probeDocker: () => ({ status: 0, errorCode: null }),
    });
    expect(ready).toEqual([]);

    const receipt = unavailableReceipt('integration', source, {
      reason: 'INTEGRATION_PREREQUISITES_UNAVAILABLE',
      missingPrerequisites: absent,
    });
    expect(receipt).toEqual(expect.objectContaining({
      status: 'UNAVAILABLE', failureCode: 'INTEGRATION_PREREQUISITES_UNAVAILABLE',
      missingPrerequisites: ['DOCKER_CLI_UNAVAILABLE', 'KEYS_ENV_NOT_CONFIGURED'],
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
