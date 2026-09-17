import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyAssurance, dockerRuntimePrerequisites, resolveAssuranceInputs } from '../../scripts/release-assurance.mjs';

describe('SH-05 release assurance orchestration', () => {
  it('prefers explicit CLI artifact paths and otherwise consumes only named runner-local path variables', () => {
    const env: any = {
      QG_RELEASE_EVIDENCE_DIR: '/runner/evidence',
      QG_RELEASE_IMAGE_INPUTS: '/runner/images.json',
      QG_RELEASE_MANIFEST: '/runner/manifest.json',
      QG_RELEASE_SIGSTORE_BUNDLE: '/runner/provenance.sigstore.json',
      QG_RELEASE_PUBLIC_KEY: '/runner/cosign.pub',
      QG_SYSTEM_E2E_EVIDENCE_DIR: '/runner/system-e2e',
      QG_RELEASE_SIGNATURE_PROOF: '/runner/release-signature.json',
      QG_RELEASE_TRUST_POLICY: '/runner/release-trust.json',
      QG_SIGNED_WINDOWS_PACKAGE: '/runner/QuaranGate-Setup.exe',
    };
    expect(resolveAssuranceInputs([], env)).toEqual({
      evidenceDirRaw: '/runner/evidence', imageInputs: '/runner/images.json', releaseManifest: '/runner/manifest.json',
      sigstoreBundle: '/runner/provenance.sigstore.json', publicKey: '/runner/cosign.pub', systemE2eEvidenceDir: '/runner/system-e2e',
      releaseSignatureProof: '/runner/release-signature.json', releaseTrustPolicy: '/runner/release-trust.json', signedPackage: '/runner/QuaranGate-Setup.exe',
    });
    expect(resolveAssuranceInputs(['--evidence-dir', '/cli/evidence', '--release-manifest', '/cli/manifest.json'], env)).toEqual(expect.objectContaining({
      evidenceDirRaw: '/cli/evidence', releaseManifest: '/cli/manifest.json', imageInputs: '/runner/images.json',
    }));
  });

  it('classifies Docker absence/runtime failure as environment prerequisites without hiding a healthy runtime', () => {
    expect(dockerRuntimePrerequisites((): any => ({ status: null, error: { code: 'ENOENT' } }))).toEqual(['DOCKER_CLI_UNAVAILABLE']);
    expect(dockerRuntimePrerequisites((): any => ({ status: 1, error: null }))).toEqual(['DOCKER_RUNTIME_UNAVAILABLE']);
    expect(dockerRuntimePrerequisites((): any => ({ status: 0, error: null }))).toEqual([]);
  });

  it('returns BLOCKED_ENVIRONMENT only when every policy failure is an unavailable gate, never for a real failed gate', () => {
    const unavailable: any = { e2e: { status: 'UNAVAILABLE' }, provenance: { status: 'UNAVAILABLE' } };
    expect(classifyAssurance({ verdict: 'FAIL', ok: false, failures: [
      { gate: 'e2e', code: 'GATE_NOT_PASS' }, { gate: 'provenance', code: 'GATE_NOT_PASS' },
    ] }, unavailable)).toBe('BLOCKED_ENVIRONMENT');
    expect(classifyAssurance({ verdict: 'FAIL', ok: false, failures: [{ gate: 'e2e', code: 'INVALID_TEST_COUNTS' }] }, unavailable)).toBe('FAIL');
    expect(classifyAssurance({ verdict: 'FAIL', ok: false, failures: [{ gate: 'sast', code: 'GATE_NOT_PASS' }] }, { sast: { status: 'FAIL' } } as any)).toBe('FAIL');
    expect(classifyAssurance({ verdict: 'PASS', ok: true, failures: [] }, {})).toBe('PASS');
  });

  it('keeps the self-hosted workflow no-download and wires all external release paths explicitly', () => {
    const workflow = readFileSync('.github/workflows/release-assurance.yml', 'utf8');
    expect(workflow).toContain("if: github.ref == 'refs/heads/integrate/quarangate-forward' || (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v'))");
    expect(workflow).toContain('runs-on: [self-hosted, linux, x64, quarangate-release]');
    expect(workflow).not.toMatch(/actions\/checkout|npm\s+(?:ci|install)|curl\s|wget\s|docker\s+pull/iu);
    for (const name of ['KEYS_ENV', 'QG_RELEASE_IMAGE_INPUTS', 'QG_RELEASE_MANIFEST', 'QG_RELEASE_SIGSTORE_BUNDLE', 'QG_RELEASE_PUBLIC_KEY', 'QG_SYSTEM_E2E_EVIDENCE_DIR', 'QG_RELEASE_SIGNATURE_PROOF', 'QG_RELEASE_TRUST_POLICY', 'QG_SIGNED_WINDOWS_PACKAGE', 'QG_RELEASE_EVIDENCE_ROOT']) {
      expect(workflow).toContain(`${name}:`);
    }
    expect(workflow).toContain('test ! -e "$evidence"');
    expect(workflow).toContain('QUARANGATE_RELEASE_EVIDENCE=');
    const assurance = readFileSync('scripts/release-assurance.mjs', 'utf8');
    expect(assurance).toContain("scripts/release-evidence-bundle.mjs");
    expect(assurance).toContain("release-evidence-bundle.json");
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['release:assurance']).toBe('node scripts/release-assurance.mjs');
  });
});
