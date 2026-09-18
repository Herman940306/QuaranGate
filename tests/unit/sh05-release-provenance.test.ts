import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleasePackageManifest, verifyReleasePackageManifest } from '../../src/installer/releasePackage.js';
import {
  createDisposableGitChildRoot,
  createDisposableGitRoot,
  initializeDisposableGitRepository,
  runDisposableGit,
} from '../helpers/disposableGit.js';
import {
  BUILD_TYPE,
  BUILDER_ID,
  COSIGN_VERSION,
  DSSE_PAYLOAD_TYPE,
  PREDICATE_TYPE,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
  STATEMENT_TYPE,
  buildProvenanceStatement,
  canonicalStringify,
  exactCosignVersion,
  extractSignedStatement,
  pathIsWithinRoot,
  validateProvenanceStatement,
  verifyReleaseManifest,
} from '../../scripts/release-provenance.mjs';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const imageA = `sha256:${'b'.repeat(64)}`;
const imageB = `sha256:${'c'.repeat(64)}`;
const createdRoots: string[] = [];
afterEach(() => { while (createdRoots.length) rmSync(createdRoots.pop()!, { recursive: true, force: true }); });

function manifest(commit: string) {
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

function source(commit = 'a'.repeat(40), tree = 'e'.repeat(40)) {
  return { repository: 'https://github.com/Herman940306/QuaranGate.git', branch: 'release/test', commit, tree, clean: true };
}

function statementFixture() {
  const s = source(); const m = manifest(s.commit);
  const sourceBindingBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source: s })}\n`);
  const manifestBytes = Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
  const sbomBytes = Buffer.from(`${JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT' })}\n`);
  const policyBytes = readFileSync('security/release-policy.json');
  const toolchainBytes = readFileSync('security/release-toolchain.json');
  const statement = buildProvenanceStatement({ source: s, sourceBindingBytes, manifest: m, manifestBytes, sbomBytes, policyBytes, toolchainBytes });
  return { s, m, sourceBindingBytes, manifestBytes, sbomBytes, policyBytes, toolchainBytes, statement };
}

function bundleFor(statement: any) {
  return {
    mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
    verificationMaterial: { publicKey: { hint: 'test' } },
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      payloadType: DSSE_PAYLOAD_TYPE,
      signatures: [{ sig: Buffer.from('test-signature').toString('base64') }],
    },
  };
}

function git(cwd: string, args: string[], inherited = process.env) {
  return runDisposableGit(cwd, args, inherited);
}

function e2eFixture(inherited = process.env) {
  const root = createDisposableGitRoot('qg-prov-'); createdRoots.push(root);
  const repo = createDisposableGitChildRoot(root, 'repo'); const ev = join(root, 'evidence'); const bin = join(repo, 'test-bin');
  mkdirSync(ev); mkdirSync(bin);
  mkdirSync(join(repo, 'security'));
  const policyBytes = readFileSync('security/release-policy.json');
  const toolchainBytes = readFileSync('security/release-toolchain.json');
  writeFileSync(join(repo, 'security/release-policy.json'), policyBytes);
  writeFileSync(join(repo, 'security/release-toolchain.json'), toolchainBytes);
  writeFileSync(join(repo, 'SOURCE.txt'), 'fixture\n');
  const fake = join(bin, 'cosign');
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "version" ]; then echo "GitVersion: v${'$'}{FAKE_COSIGN_VERSION:-${COSIGN_VERSION}}"; exit 0; fi\nprintf '%s\\n' "$@" > "$FAKE_COSIGN_ARGS_FILE"\nexit "${'$'}{FAKE_COSIGN_VERIFY_EXIT:-0}"\n`);
  chmodSync(fake, 0o755);
  initializeDisposableGitRepository(repo, inherited);
  git(repo, ['config', 'user.email', 'test@example.invalid'], inherited); git(repo, ['config', 'user.name', 'SH05 Test'], inherited);
  git(repo, ['add', '.'], inherited); git(repo, ['commit', '-q', '-m', 'fixture'], inherited);
  const commit = git(repo, ['rev-parse', 'HEAD']); const tree = git(repo, ['rev-parse', 'HEAD^{tree}']); const branch = git(repo, ['branch', '--show-current']);
  const s = { repository: null, branch, commit, tree, clean: true };
  const sourceBinding = join(ev, 'source.json'); const manifestPath = join(ev, 'manifest.json'); const sbom = join(ev, 'release.spdx.json');
  const statementPath = join(ev, 'provenance.intoto.json'); const receipt = join(ev, 'provenance.json'); const bundle = join(ev, 'provenance.sigstore.json'); const publicKey = join(ev, 'cosign.pub');
  const sourceBindingBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source: s }, null, 2)}\n`);
  const m = manifest(commit); const manifestBytes = Buffer.from(`${JSON.stringify(m, null, 2)}\n`); const sbomBytes = Buffer.from(`${JSON.stringify({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT' }, null, 2)}\n`);
  writeFileSync(sourceBinding, sourceBindingBytes); writeFileSync(manifestPath, manifestBytes); writeFileSync(sbom, sbomBytes); writeFileSync(publicKey, 'TEST PUBLIC KEY\n');
  const statement = buildProvenanceStatement({ source: s, sourceBindingBytes, manifest: m, manifestBytes, sbomBytes, policyBytes, toolchainBytes });
  writeFileSync(bundle, `${JSON.stringify(bundleFor(statement), null, 2)}\n`);
  const argsFile = join(ev, 'cosign-args.txt');
  const script = resolve('scripts/release-provenance.mjs');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_COSIGN_ARGS_FILE: argsFile };
  const args = [script, '--source-binding', sourceBinding, '--release-manifest', manifestPath, '--sbom', sbom, '--statement-output', statementPath, '--bundle', bundle, '--public-key', publicKey, '--output', receipt];
  return { root, repo, ev, bin, s, m, sourceBinding, manifestPath, sbom, statementPath, receipt, bundle, publicKey, argsFile, script, env, args, statement };
}

function runFixture(f: ReturnType<typeof e2eFixture>, env = f.env, args = f.args) {
  return spawnSync(process.execPath, args, { cwd: f.repo, encoding: 'utf8', env });
}

describe('SH-05 SLSA v1 provenance and Cosign attestation gate', () => {
  it('constructs deterministic SLSA v1/in-toto v1 provenance over the P9 manifest and every immutable image', () => {
    const f = statementFixture(); const again = statementFixture();
    expect(f.statement).toEqual(again.statement);
    expect(f.statement._type).toBe(STATEMENT_TYPE); expect(f.statement.predicateType).toBe(PREDICATE_TYPE);
    expect(f.statement.subject).toEqual([
      { name: 'quarangate-release-manifest-1.0.0.json', digest: { sha256: sha256(f.manifestBytes) } },
      { name: `quarangate-executor:git-${f.s.commit}`, digest: { sha256: 'b'.repeat(64) } },
      { name: `quarangate-gateway:git-${f.s.commit}`, digest: { sha256: 'c'.repeat(64) } },
    ]);
    expect(f.statement.predicate.buildDefinition).toEqual(expect.objectContaining({ buildType: BUILD_TYPE }));
    expect(f.statement.predicate.buildDefinition.internalParameters).toEqual({ sourceBranch: f.s.branch, sourceCommit: f.s.commit, sourceTree: f.s.tree });
    expect(f.statement.predicate.runDetails.builder).toEqual({ id: BUILDER_ID, version: { releaseAssurance: '1' } });
    expect(f.statement.predicate.runDetails.byproducts).toEqual([
      { name: 'source-binding.json', digest: { sha256: sha256(f.sourceBindingBytes) } },
      { name: 'release.spdx.json', digest: { sha256: sha256(f.sbomBytes) } },
    ]);
    expect(() => validateProvenanceStatement(f.statement)).not.toThrow();
  });

  it('mirrors P9 fail-closed manifest decisions instead of signing a self-consistent invalid release identity', () => {
    const base: any = manifest('a'.repeat(40));
    const rehash = (value: any) => { const { manifestDigest: _drop, ...identity } = value; return { ...value, manifestDigest: createHash('sha256').update(canonicalStringify(identity)).digest('hex') }; };
    const mutations: Array<[string, (value: any) => void]> = [
      ['mutable image', (v) => { v.images[0].reference = 'executor:latest'; }],
      ['bad version', (v) => { v.productVersion = 'v1'; }],
      ['self asserted signing', (v) => { v.signing = 'SIGNED'; }],
      ['secret path', (v) => { v.files[0].path = 'config/.env'; }],
      ['unsafe repeated slash', (v) => { v.files[0].path = 'dist//index.js'; }],
      ['unsorted images', (v) => { v.images = [...v.images].reverse(); v.lifecycle.components = v.images.map((x: any) => x.component); }],
      ['component mismatch', (v) => { v.lifecycle.components = ['executor']; }],
      ['unbound migration', (v) => { v.lifecycle.configSchemaVersion = 1; v.lifecycle.migrations = [{ id: 'cfg-0-1', kind: 'CONFIG', fromVersion: 0, toVersion: 1, digest: 'f'.repeat(64) }]; }],
    ];
    for (const [label, mutate] of mutations) {
      const value = structuredClone(base); mutate(value); const invalid = rehash(value);
      expect(() => verifyReleasePackageManifest(invalid), `P9 ${label}`).toThrow();
      expect(() => verifyReleaseManifest(invalid, 'a'.repeat(40)), `SH05 ${label}`).toThrow();
    }
  });

  it('extracts only a canonical v0.3 DSSE bundle carrying one exact SLSA statement', () => {
    const f = statementFixture(); const bundle = bundleFor(f.statement);
    const signed = extractSignedStatement(bundle);
    expect(signed.statement).toEqual(f.statement); expect(signed.payloadSha256).toMatch(/^[0-9a-f]{64}$/u);
    for (const bad of [
      { ...bundle, mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.2' },
      { ...bundle, dsseEnvelope: { ...bundle.dsseEnvelope, payloadType: 'application/json' } },
      { ...bundle, dsseEnvelope: { ...bundle.dsseEnvelope, signatures: [] } },
      { ...bundle, dsseEnvelope: { ...bundle.dsseEnvelope, signatures: [{ sig: '%%%=' }] } },
      { ...bundle, dsseEnvelope: { ...bundle.dsseEnvelope, payload: 'not-base64' } },
    ]) expect(() => extractSignedStatement(bad)).toThrow();
  });

  it('pins Cosign exactly and rejects lookalike versions', () => {
    expect(exactCosignVersion('GitVersion: v3.1.3')).toBe(true);
    expect(exactCosignVersion('cosign version 3.1.3\n')).toBe(true);
    for (const value of ['3.1.2', '3.1.30', 'v3.1.3-rc1', '13.1.3']) expect(exactCosignVersion(value)).toBe(false);
  });

  it('keeps generated statement and gate receipt outputs outside the attested Git worktree', () => {
    expect(pathIsWithinRoot('/repo/root', '/repo/root/provenance.json')).toBe(true);
    expect(pathIsWithinRoot('/repo/root', '/tmp/provenance.json')).toBe(false);
  });

  it('produces PASS only after exact signed-statement equality and fixed Cosign verification arguments', () => {
    const f = e2eFixture(); const r = runFixture(f); expect(r.status, r.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
    expect(receipt.status).toBe('PASS'); expect(receipt.gate).toBe('provenance'); expect(receipt.tool).toEqual({ name: 'cosign', version: COSIGN_VERSION });
    expect(receipt.statement.subjectCount).toBe(3); expect(receipt.bundle.mediaType).toBe(SIGSTORE_BUNDLE_MEDIA_TYPE);
    expect(receipt.publicKey.sha256).toMatch(/^[0-9a-f]{64}$/u); expect(receipt.execution.commandId).toBe('cosign-verify-blob-attestation');
    const args = readFileSync(f.argsFile, 'utf8');
    expect(args).toContain('verify-blob-attestation'); expect(args).toContain('--bundle'); expect(args).toContain('--key');
    expect(args).toContain('--type'); expect(args).toContain(PREDICATE_TYPE); expect(args).toContain('--digestAlg'); expect(args).toContain('sha256');
    expect(git(f.repo, ['status', '--short'])).toBe('');
  });

  it('cannot redirect fixture Git mutations through hostile inherited repository controls', () => {
    const victim = createDisposableGitRoot('qg-source-binding-victim-'); createdRoots.push(victim);
    initializeDisposableGitRepository(victim);
    git(victim, ['config', 'user.email', 'owner@example.invalid']); git(victim, ['config', 'user.name', 'Disposable Owner']);
    writeFileSync(join(victim, 'sentinel.txt'), 'preserve\n'); git(victim, ['add', '.']); git(victim, ['commit', '-q', '-m', 'baseline']);
    const before = git(victim, ['rev-parse', 'HEAD']);
    const f = e2eFixture({ ...process.env, GIT_DIR: join(victim, '.git'), GIT_WORK_TREE: victim });
    expect(git(victim, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(victim, ['config', 'user.name'])).toBe('Disposable Owner');
    expect(git(f.repo, ['show', '-s', '--format=%an <%ae>'])).toBe('SH05 Test <test@example.invalid>');
  });

  it('fails closed before Cosign when the signed DSSE statement differs from the generated release truth', () => {
    const f = e2eFixture(); const altered = structuredClone(f.statement); altered.predicate.buildDefinition.externalParameters.productVersion = '1.0.1';
    writeFileSync(f.bundle, `${JSON.stringify(bundleFor(altered), null, 2)}\n`);
    const r = runFixture(f); expect(r.status).toBe(5);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8')); expect(receipt.status).toBe('FAIL'); expect(receipt.failureCode).toBe('SIGNED_STATEMENT_MISMATCH');
    expect(existsSyncSafe(f.argsFile)).toBe(false);
  });

  it('classifies absent owner signing material as UNAVAILABLE and a wrong Cosign version as FAIL', () => {
    const f = e2eFixture(); const withoutSigning = f.args.filter((value, index, all) => !['--bundle', '--public-key'].includes(value) && !['--bundle', '--public-key'].includes(all[index - 1] ?? ''));
    let r = runFixture(f, f.env, withoutSigning); expect(r.status).toBe(4);
    let receipt = JSON.parse(readFileSync(f.receipt, 'utf8')); expect(receipt.status).toBe('UNAVAILABLE'); expect(receipt.missingPrerequisites).toEqual(['PUBLIC_KEY_NOT_PROVIDED', 'SIGSTORE_BUNDLE_NOT_PROVIDED']);
    r = runFixture(f, { ...f.env, FAKE_COSIGN_VERSION: '3.1.2' }); expect(r.status).toBe(5); receipt = JSON.parse(readFileSync(f.receipt, 'utf8')); expect(receipt.status).toBe('FAIL'); expect(receipt.failureCode).toBe('COSIGN_VERSION_MISMATCH');
  });

  it('records cryptographic verifier failure as FAIL without raw verifier output', () => {
    const f = e2eFixture(); const env = { ...f.env, FAKE_COSIGN_VERIFY_EXIT: '7' };
    const r = runFixture(f, env); expect(r.status).toBe(5);
    const receipt = JSON.parse(readFileSync(f.receipt, 'utf8')); expect(receipt.status).toBe('FAIL'); expect(receipt.failureCode).toBe('COSIGN_VERIFICATION_FAILED');
    expect(receipt.execution.exitCode).toBe(7); expect(receipt.execution.stdout).toEqual(expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), bytes: expect.any(Number) }));
    expect(JSON.stringify(receipt)).not.toContain('TEST PUBLIC KEY');
  });
});

function existsSyncSafe(path: string) {
  try { readFileSync(path); return true; } catch { return false; }
}
