import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  P10V_REQUIRED_DEMO_IDS,
  P10V_REQUIRED_ROUTE_IDS,
  p10vContract,
  validateP10vRuntimeUrl,
} from '../../e2e/contracts/p10v-visual-evidence.mjs';
import { finalizeP10vEvidence } from '../../e2e/scripts/p10v-evidence-finalize.mjs';
import { verifyP10vIndependentAcceptance } from '../../e2e/scripts/p10v-acceptance.mjs';
import { generateP10vVisualSummary } from '../../e2e/scripts/p10v-visual-compare.mjs';

const SOURCE = {
  repository: 'https://github.com/Herman940306/QuaranGate.git',
  branch: 'integrate/quarangate-forward',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  clean: true,
};

const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('fixture-png')]);
const WEBM = Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]), Buffer.from('fixture-webm')]);

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function completeEvidenceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qg-p10v-'));
  for (const dir of [
    'identity', 'screenshots/routes', 'demos', 'playwright', 'visual', 'accessibility', 'observability', 'security', 'review',
  ]) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'README.md'), '# P10-V fixture\n');
  writeJson(join(root, 'contract.json'), p10vContract());
  writeJson(join(root, 'readiness.json'), { schemaVersion: 1, status: 'PASS', source: SOURCE });
  writeJson(join(root, 'identity/source.json'), { schemaVersion: 1, status: 'PASS', source: SOURCE });
  writeJson(join(root, 'identity/runtime.json'), { schemaVersion: 1, status: 'PASS', sourceCommit: SOURCE.commit, runtimeRevision: SOURCE.commit, environment: 'DISPOSABLE_QUALIFICATION', productionData: false, customerData: false });
  writeJson(join(root, 'identity/browser.json'), { schemaVersion: 1, status: 'PASS', browser: 'chromium', version: 'test-browser' });
  writeJson(join(root, 'playwright/results.json'), { suites: [], errors: [], stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 } });
  writeJson(join(root, 'visual/summary.json'), { status: 'PASS', mode: 'INITIAL_CANONICAL_BASELINE_REVIEW_REQUIRED', sourceCommit: SOURCE.commit, baselineSourceCommit: SOURCE.commit, mismatches: 0, routesCompared: 21 });
  writeJson(join(root, 'accessibility/report.json'), { status: 'PASS', serious: 0, critical: 0 });
  writeJson(join(root, 'observability/console-summary.json'), { status: 'PASS', pageErrorCount: 0, consoleErrorCount: 0, errors: [] });
  writeJson(join(root, 'observability/network-summary.json'), { status: 'PASS', requests: [], secretsIncluded: false });
  writeJson(join(root, 'security/public-media-scan.json'), {
    status: 'PASS', manualReview: true, secrets: 0, pii: 0, privatePaths: 0,
  });
  for (const id of P10V_REQUIRED_ROUTE_IDS) writeFileSync(join(root, 'screenshots/routes', `${id}.png`), Buffer.concat([PNG, Buffer.from(`:${id}`)]));
  for (const id of P10V_REQUIRED_DEMO_IDS) writeFileSync(join(root, 'demos', `${id}.webm`), Buffer.concat([WEBM, Buffer.from(`:${id}`)]));
  return root;
}

describe('P10-V visual evidence readiness contract', () => {
  it('binds the visual route set to the authoritative 21-route Console contract', () => {
    expect(P10V_REQUIRED_ROUTE_IDS).toHaveLength(21);
    expect(new Set(P10V_REQUIRED_ROUTE_IDS).size).toBe(21);
    expect(P10V_REQUIRED_ROUTE_IDS).toEqual([
      'overview','chat','projects','targets','files','terminal','git','processes','agents','jobs','review',
      'ide-sessions','github','models','monitoring','statistics','security','audit','recovery','settings','tool-lab',
    ]);
  });

  it('freezes the approved short deterministic demo set', () => {
    expect(P10V_REQUIRED_DEMO_IDS).toEqual([
      'install-first-run', 'console-tour', 'governed-task', 'ide-session',
      'github-workflow', 'failure-recovery', 'backup-recovery',
    ]);
  });

  it('admits only local real-runtime Console URLs by default', () => {
    expect(validateP10vRuntimeUrl('http://127.0.0.1:8787/console/')).toBe('http://127.0.0.1:8787/console/');
    expect(validateP10vRuntimeUrl('https://localhost:8443/console/')).toBe('https://localhost:8443/console/');
    for (const bad of [
      'http://0.0.0.0:8787/console/',
      'https://example.com/console/',
      'file:///console/',
      'http://127.0.0.1:8787/not-console/',
      'http://user:pass@127.0.0.1:8787/console/',
    ]) expect(() => validateP10vRuntimeUrl(bad)).toThrow();
  });

  it('readiness is sequenced behind exact source-matching P10 PASS before evidence creation', () => {
    const readiness = readFileSync('e2e/scripts/p10v-readiness.mjs', 'utf8');
    expect(readiness).toContain("p10?.status !== 'PASS'");
    expect(readiness).toContain('P10_NOT_ACCEPTED');
    expect(readiness).toContain('P10_SOURCE_BINDING_MISMATCH');
    expect(readiness.indexOf("p10?.status !== 'PASS'")).toBeLessThan(readiness.indexOf('const evidenceDir = externalPrivateEvidenceDirectory'));
  });

  it('requires explicit synthetic-disposable credential and disposable-runtime attestations', () => {
    const routeEvidence = readFileSync('e2e/p10v-tests/route-evidence.spec.ts', 'utf8');
    expect(routeEvidence).toContain('QG_P10V_CREDENTIAL_CLASS');
    expect(routeEvidence).toContain('SYNTHETIC_DISPOSABLE');

    const root = completeEvidenceRoot();
    writeJson(join(root, 'identity/runtime.json'), {
      schemaVersion: 1, status: 'PASS', sourceCommit: SOURCE.commit, runtimeRevision: SOURCE.commit,
      environment: 'PRODUCTION', productionData: true, customerData: true,
    });
    expect(() => finalizeP10vEvidence({ evidenceDir: root, expectedSource: SOURCE })).toThrow(/disposable qualification/);
  });

  it('P10-V Playwright config has no mock webServer and requires explicit real-runtime/evidence inputs', () => {
    const config = readFileSync('e2e/p10v.playwright.config.ts', 'utf8');
    expect(config).toContain('QG_P10V_BASE_URL');
    expect(config).toContain('QG_P10V_EVIDENCE_DIR');
    expect(config).not.toContain('mock-server.mjs');
    expect(config).not.toMatch(/\bwebServer\s*:/u);
    expect(config).toContain('retries: 0');
    expect(config).toContain('forbidOnly: true');
  });

  it('generates deterministic exact-hash visual receipts and fails closed on baseline drift', () => {
    const initial = completeEvidenceRoot();
    // Replace the hand-authored visual fixture to exercise the real producer.
    const visualPath = join(initial, 'visual/summary.json');
    unlinkSync(visualPath);
    const first = generateP10vVisualSummary({ evidenceDir: initial, sourceCommit: SOURCE.commit, mode: 'initial' });
    expect(first.status).toBe('PASS');
    expect(first.mode).toBe('INITIAL_CANONICAL_BASELINE_REVIEW_REQUIRED');
    expect(first.routesCompared).toBe(21);

    const current = completeEvidenceRoot();
    unlinkSync(join(current, 'visual/summary.json'));
    const same = generateP10vVisualSummary({
      evidenceDir: current,
      sourceCommit: 'c'.repeat(40),
      mode: 'compare',
      baselineDir: initial,
      baselineSourceCommit: SOURCE.commit,
    });
    expect(same.status).toBe('PASS');
    expect(same.mismatches).toBe(0);

    const drift = completeEvidenceRoot();
    unlinkSync(join(drift, 'visual/summary.json'));
    writeFileSync(join(drift, 'screenshots/routes/overview.png'), Buffer.concat([PNG, Buffer.from(':changed')]))
    const changed = generateP10vVisualSummary({
      evidenceDir: drift,
      sourceCommit: 'd'.repeat(40),
      mode: 'compare',
      baselineDir: initial,
      baselineSourceCommit: SOURCE.commit,
    });
    expect(changed.status).toBe('FAIL');
    expect(changed.mismatches).toBe(1);
    expect(changed.mismatchDetails.map((item: any) => item.routeId)).toEqual(['overview']);
  });

  it('finalizes complete evidence into deterministic review-pending SHA-256 manifests', () => {
    const root = completeEvidenceRoot();
    const result = finalizeP10vEvidence({ evidenceDir: root, expectedSource: SOURCE });
    expect(result.status).toBe('EVIDENCE_COMPLETE_REVIEW_PENDING');
    expect(result.files).toBeGreaterThanOrEqual(21 + 7 + 12);
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(root, 'SHA256SUMS'), 'utf8')).toContain('screenshots/routes/overview.png');
    expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).source).toEqual(SOURCE);
  });

  it('requires a separate independent-review receipt bound to the exact finalized manifest before acceptance', () => {
    const root = completeEvidenceRoot();
    const finalized = finalizeP10vEvidence({ evidenceDir: root, expectedSource: SOURCE });
    expect(() => verifyP10vIndependentAcceptance({ evidenceDir: root, expectedSourceCommit: SOURCE.commit })).toThrow(/independent review receipt/);

    writeJson(join(root, 'review/independent-review.json'), {
      schemaVersion: 1,
      status: 'PASS',
      verdict: 'ACCEPT',
      reviewerIndependent: true,
      reviewerId: 'independent-reviewer-fixture',
      reviewedAt: '2026-09-17T12:00:00Z',
      sourceCommit: SOURCE.commit,
      manifestSha256: finalized.manifestSha256,
      findings: [],
    });
    const accepted = verifyP10vIndependentAcceptance({ evidenceDir: root, expectedSourceCommit: SOURCE.commit });
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.manifestSha256).toBe(finalized.manifestSha256);

    const reviewPath = join(root, 'review/independent-review.json');
    const originalReview = JSON.parse(readFileSync(reviewPath, 'utf8'));
    const tampered = { ...originalReview, manifestSha256: createHash('sha256').update('different').digest('hex') };
    writeJson(reviewPath, tampered);
    expect(() => verifyP10vIndependentAcceptance({ evidenceDir: root, expectedSourceCommit: SOURCE.commit })).toThrow(/exact finalized manifest/);

    writeJson(reviewPath, originalReview);
    writeFileSync(join(root, 'screenshots/routes/overview.png'), Buffer.from('tampered-after-review'));
    expect(() => verifyP10vIndependentAcceptance({ evidenceDir: root, expectedSourceCommit: SOURCE.commit })).toThrow(/artifact bytes changed/);
  });

  it('refuses real Playwright reports with skipped, flaky, unexpected, or top-level error outcomes', () => {
    for (const mutate of [
      (j: any) => { j.stats.skipped = 1; },
      (j: any) => { j.stats.flaky = 1; },
      (j: any) => { j.stats.unexpected = 1; },
      (j: any) => { j.errors.push({ message: 'bounded-fixture-error' }); },
    ]) {
      const root = completeEvidenceRoot();
      const reportPath = join(root, 'playwright/results.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      mutate(report);
      writeJson(reportPath, report);
      expect(() => finalizeP10vEvidence({ evidenceDir: root, expectedSource: SOURCE })).toThrow(/Playwright result/);
    }
  });

  it('refuses missing route media, failed/manual-unreviewed security evidence, and symlink artifacts', () => {
    const missing = completeEvidenceRoot();
    writeFileSync(join(missing, 'screenshots/routes/overview.png'), Buffer.alloc(0));
    expect(() => finalizeP10vEvidence({ evidenceDir: missing, expectedSource: SOURCE })).toThrow();

    const unsafe = completeEvidenceRoot();
    writeJson(join(unsafe, 'security/public-media-scan.json'), { status: 'PASS', manualReview: false, secrets: 0, pii: 0, privatePaths: 0 });
    expect(() => finalizeP10vEvidence({ evidenceDir: unsafe, expectedSource: SOURCE })).toThrow();

    const linked = completeEvidenceRoot();
    symlinkSync(join(linked, 'screenshots/routes/chat.png'), join(linked, 'screenshots/routes/linked.png'));
    expect(() => finalizeP10vEvidence({ evidenceDir: linked, expectedSource: SOURCE })).toThrow();
  });
});
