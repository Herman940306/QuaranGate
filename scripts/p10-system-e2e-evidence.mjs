#!/usr/bin/env node
import {
  createHash,
  createPublicKey,
  verify as verifyCryptographicSignature,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pathIsWithinRoot } from './release-path-safety.mjs';
import {
  canonicalStringify,
  sha256,
  validateSourceBinding,
  verifyReleaseManifest,
} from './release-provenance.mjs';

const SOURCE_ROOT = realpathSync(resolve(fileURLToPath(new URL('../', import.meta.url))));
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_SIGNED_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;

export const P10_SYSTEM_E2E_SCHEMA_VERSION = 2;
export const P10_SYSTEM_E2E_STEPS = Object.freeze([
  'fresh-install',
  'configure',
  'enroll',
  'kiro',
  'ollama',
  'copilot',
  'github',
  'ide',
  'jobs',
  'restart-crash',
  'resume',
  'review',
  'apply',
  'evidence',
  'backup-recovery',
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function parseJsonBytes(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${label} is malformed JSON`); }
}

function realExternalFile(candidate, label, maxBytes = MAX_MANIFEST_BYTES) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${label} is required`);
  const absolute = resolve(candidate);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) throw new Error(`${label} input is unavailable or unsafe`);
  const info = statSync(absolute);
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error(`${label} size/type is invalid`);
  const real = realpathSync(absolute);
  if (pathIsWithinRoot(SOURCE_ROOT, real)) throw new Error(`${label} must remain outside the Git worktree`);
  return { path: real, info };
}

function readJsonExternal(candidate, label, maxBytes = MAX_MANIFEST_BYTES) {
  const input = realExternalFile(candidate, label, maxBytes);
  const bytes = readFileSync(input.path);
  return { ...input, bytes, value: parseJsonBytes(bytes, label) };
}

function realExternalDirectory(candidate, label) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${label} is required`);
  const absolute = resolve(candidate);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isDirectory()) {
    throw new Error(`${label} must be an existing real directory`);
  }
  const real = realpathSync(absolute);
  if (pathIsWithinRoot(SOURCE_ROOT, real)) throw new Error(`${label} must be outside the Git worktree`);
  if (process.platform !== 'win32' && (statSync(real).mode & 0o077) !== 0) throw new Error(`${label} must be owner-only (0700)`);
  return real;
}

function hashRegularFile(candidate, label, maxBytes) {
  const { path, info } = realExternalFile(candidate, label, maxBytes);
  if (info.nlink !== 1) throw new Error(`${label} must be a single-link regular file`);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const fd = openSync(path, 'r');
  let total = 0;
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} exceeds size bound`);
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  if (total !== info.size) throw new Error(`${label} changed during hashing`);
  return { path, bytes: total, sha256: hash.digest('hex') };
}

function sameSource(a, b) {
  return a?.repository === b?.repository
    && a?.branch === b?.branch
    && a?.commit === b?.commit
    && a?.tree === b?.tree
    && a?.clean === true
    && b?.clean === true;
}

function exactSource(value, label) {
  assertExactKeys(value, ['repository', 'branch', 'commit', 'tree', 'clean'], label);
  if ((value.repository !== null && (typeof value.repository !== 'string' || value.repository.length > 2048))
    || (value.branch !== null && (typeof value.branch !== 'string' || !value.branch || value.branch.length > 256))
    || !GIT_COMMIT.test(value.commit ?? '')
    || !GIT_COMMIT.test(value.tree ?? '')
    || value.clean !== true) throw new Error(`${label} identity is invalid`);
  return value;
}

function parseUtc(value, label) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) throw new Error(`${label} timestamp is invalid`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} timestamp is invalid`);
  return time;
}

function releaseSignaturePayload(manifest) {
  return Buffer.from(canonicalStringify({
    schemaVersion: 1,
    purpose: 'QUARANGATE_RELEASE_MANIFEST',
    manifestDigest: manifest.manifestDigest,
    productVersion: manifest.productVersion,
    sourceCommit: manifest.sourceCommit,
    createdAt: manifest.createdAt,
  }), 'utf8');
}

function verifyDetachedReleaseSignature({ releaseManifest, signatureProofPath, trustPolicyPath, evidenceRoot }) {
  const proofInput = readJsonExternal(signatureProofPath, 'release signature proof');
  const policyInput = readJsonExternal(trustPolicyPath, 'release trust policy');
  if (pathIsWithinRoot(evidenceRoot, proofInput.path) || pathIsWithinRoot(evidenceRoot, policyInput.path)) {
    throw new Error('release signature proof and installer trust policy must remain outside system-e2e evidence');
  }
  if (policyInput.info.nlink !== 1 || (process.platform !== 'win32' && (policyInput.info.mode & 0o022) !== 0)) {
    throw new Error('installer-owned release trust policy is replaceable/writable or multiply linked');
  }
  const proof = proofInput.value;
  assertExactKeys(proof, ['schemaVersion', 'algorithm', 'keyId', 'manifestDigest', 'signedAt', 'signature'], 'release signature proof');
  if (proof.schemaVersion !== 1 || proof.algorithm !== 'Ed25519' || !SAFE_ID.test(proof.keyId ?? '')
    || proof.manifestDigest !== releaseManifest.manifestDigest || !ISO_UTC.test(proof.signedAt ?? '')
    || Date.parse(proof.signedAt) < Date.parse(releaseManifest.createdAt)
    || typeof proof.signature !== 'string' || proof.signature.length === 0 || proof.signature.length > 512
    || !BASE64.test(proof.signature)) {
    throw new Error('release signature proof is invalid or does not bind the exact release manifest');
  }
  const signature = Buffer.from(proof.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== proof.signature) throw new Error('release signature encoding is invalid');

  const policy = policyInput.value;
  assertExactKeys(policy, ['schemaVersion', 'policyId', 'trustedKeys'], 'release trust policy');
  if (policy.schemaVersion !== 1 || !SAFE_ID.test(policy.policyId ?? '') || !Array.isArray(policy.trustedKeys) || policy.trustedKeys.length < 1) {
    throw new Error('release trust policy is invalid');
  }
  const ids = new Set();
  let selected = null;
  for (const key of policy.trustedKeys) {
    assertExactKeys(key, ['keyId', 'algorithm', 'publicKeyPem'], 'trusted release key');
    if (!SAFE_ID.test(key.keyId ?? '') || key.algorithm !== 'Ed25519' || typeof key.publicKeyPem !== 'string' || key.publicKeyPem.length > 4096 || ids.has(key.keyId)) {
      throw new Error('trusted release key is invalid or duplicated');
    }
    ids.add(key.keyId);
    if (key.keyId === proof.keyId) selected = key;
  }
  if (!selected) throw new Error('release signature identity is not present in installer-owned trust policy');

  let publicKey;
  try { publicKey = createPublicKey(selected.publicKeyPem); }
  catch { throw new Error('trusted release public key is invalid'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('trusted release key is not Ed25519');
  if (!verifyCryptographicSignature(null, releaseSignaturePayload(releaseManifest), publicKey, signature)) {
    throw new Error('release signature cryptographic verification failed');
  }
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    policyId: policy.policyId,
    proofSha256: sha256(proofInput.bytes),
    trustPolicySha256: sha256(policyInput.bytes),
    keyId: selected.keyId,
    algorithm: 'Ed25519',
    publicKeyFingerprint: createHash('sha256').update(der).digest('hex'),
    signedAt: proof.signedAt,
  };
}

function safeArtifactRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('/') || value.includes('\\')) return false;
  const normalized = posix.normalize(value);
  if (normalized !== value || value.split('/').includes('..') || value === '.' || value.startsWith('../')) return false;
  return value.startsWith('artifacts/');
}

function assertNoSymlinkComponents(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = resolve(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`system-e2e artifact path contains a symlink: ${relativePath}`);
  }
}

function validateArtifact(root, artifact, seenPaths) {
  assertExactKeys(artifact, ['path', 'sha256', 'bytes', 'kind'], 'system-e2e artifact');
  if (!safeArtifactRelativePath(artifact.path)) throw new Error('system-e2e artifact path is unsafe');
  if (seenPaths.has(artifact.path)) throw new Error(`duplicate system-e2e artifact reference: ${artifact.path}`);
  seenPaths.add(artifact.path);
  if (!SHA256.test(artifact.sha256 ?? '') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > MAX_ARTIFACT_BYTES
    || !['JSON', 'LOG', 'SCREENSHOT', 'VIDEO', 'ARCHIVE', 'RECEIPT'].includes(artifact.kind)) {
    throw new Error(`system-e2e artifact identity is invalid: ${artifact.path}`);
  }
  const absolute = resolve(root, artifact.path);
  if (!pathIsWithinRoot(root, absolute) || !existsSync(absolute)) throw new Error(`system-e2e artifact is missing: ${artifact.path}`);
  assertNoSymlinkComponents(root, artifact.path);
  const info = statSync(absolute);
  if (!info.isFile() || info.size !== artifact.bytes) throw new Error(`system-e2e artifact size mismatch: ${artifact.path}`);
  const bytes = readFileSync(absolute);
  if (sha256(bytes) !== artifact.sha256) throw new Error(`system-e2e artifact digest mismatch: ${artifact.path}`);
  return bytes.length;
}

function walkArtifactFiles(root) {
  const artifactRoot = resolve(root, 'artifacts');
  if (!existsSync(artifactRoot) || lstatSync(artifactRoot).isSymbolicLink() || !statSync(artifactRoot).isDirectory()) {
    throw new Error('system-e2e artifacts directory is missing or unsafe');
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      const info = lstatSync(absolute);
      const rel = relative(root, absolute).split(sep).join('/');
      if (info.isSymbolicLink()) throw new Error(`system-e2e evidence contains a symlink: ${rel}`);
      if (info.isDirectory()) walk(absolute);
      else if (info.isFile()) files.push(rel);
      else throw new Error(`system-e2e evidence contains a non-regular entry: ${rel}`);
      if (files.length > MAX_ARTIFACTS) throw new Error('system-e2e artifact-count bound exceeded');
    }
  };
  walk(artifactRoot);
  return files.sort();
}

function assertClosedEvidenceLayout(root, referencedPaths) {
  const top = readdirSync(root).sort();
  const expectedTop = ['artifacts', 'manifest.json', 'review'];
  if (JSON.stringify(top) !== JSON.stringify(expectedTop)) throw new Error('system-e2e evidence root contains unmanifested top-level entries');
  const reviewDir = resolve(root, 'review');
  if (lstatSync(reviewDir).isSymbolicLink() || !statSync(reviewDir).isDirectory()) throw new Error('system-e2e review directory is unsafe');
  const reviewEntries = readdirSync(reviewDir).sort();
  if (JSON.stringify(reviewEntries) !== JSON.stringify(['independent-review.json'])) throw new Error('system-e2e review directory contains unexpected entries');
  const actualArtifacts = walkArtifactFiles(root);
  const expectedArtifacts = [...referencedPaths].sort();
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) throw new Error('system-e2e evidence contains unmanifested or missing artifacts');
}

function validateIndependentReview({ root, manifestSha256, manifest, source, releaseIdentity, signedPackageSha256, lastCompleted }) {
  const reviewPath = resolve(root, 'review/independent-review.json');
  if (!existsSync(reviewPath) || lstatSync(reviewPath).isSymbolicLink() || !statSync(reviewPath).isFile()) {
    throw new Error('system-e2e independent review receipt is missing or unsafe');
  }
  const reviewBytes = readFileSync(reviewPath);
  const review = parseJsonBytes(reviewBytes, 'system-e2e independent review');
  assertExactKeys(review, [
    'schemaVersion', 'status', 'verdict', 'reviewerIndependent', 'reviewerId', 'reviewedAt',
    'operatorId', 'sourceCommit', 'releaseManifestDigest', 'evidenceManifestSha256',
    'signedPackageSha256', 'evidenceSafety', 'findings',
  ], 'system-e2e independent review');
  if (review.schemaVersion !== 1 || review.status !== 'PASS' || review.verdict !== 'ACCEPT' || review.reviewerIndependent !== true
    || !SAFE_ID.test(review.reviewerId ?? '') || review.reviewerId === manifest.operatorId
    || review.operatorId !== manifest.operatorId || review.sourceCommit !== source.commit
    || review.releaseManifestDigest !== releaseIdentity.manifestDigest || review.evidenceManifestSha256 !== manifestSha256
    || review.signedPackageSha256 !== signedPackageSha256 || !SHA256.test(review.evidenceManifestSha256 ?? '')
    || !ISO_UTC.test(review.reviewedAt ?? '') || parseUtc(review.reviewedAt, 'system-e2e reviewedAt') <= lastCompleted
    || !Array.isArray(review.findings) || review.findings.length !== 0) {
    throw new Error('system-e2e independent review is not accepted or not bound to the exact finalized evidence');
  }
  assertExactKeys(review.evidenceSafety, ['secretScan', 'credentialMarkers', 'customerIdentifiers'], 'system-e2e review evidence safety');
  if (review.evidenceSafety.secretScan !== 'PASS' || review.evidenceSafety.credentialMarkers !== 0 || review.evidenceSafety.customerIdentifiers !== 0) {
    throw new Error('system-e2e independent evidence-safety review is not PASS');
  }
  return { review, reviewReceiptSha256: sha256(reviewBytes) };
}

export function validateP10SystemE2eEvidence({
  evidenceDir,
  sourceBindingPath,
  releaseManifestPath,
  releaseSignatureProofPath,
  releaseTrustPolicyPath,
  signedPackagePath,
}) {
  const root = realExternalDirectory(evidenceDir, '--system-e2e-evidence-dir');
  const sourceBindingInput = readJsonExternal(sourceBindingPath, 'source binding');
  const releaseManifestInput = readJsonExternal(releaseManifestPath, 'release manifest');
  if (pathIsWithinRoot(root, sourceBindingInput.path) || pathIsWithinRoot(root, releaseManifestInput.path)) {
    throw new Error('source binding and release manifest must remain outside system-e2e evidence');
  }
  const source = exactSource(validateSourceBinding(sourceBindingInput.value), 'source-binding source');
  const releaseManifest = releaseManifestInput.value;
  const releaseIdentity = verifyReleaseManifest(releaseManifest, source.commit);
  const signingIdentity = verifyDetachedReleaseSignature({ releaseManifest, signatureProofPath: releaseSignatureProofPath, trustPolicyPath: releaseTrustPolicyPath, evidenceRoot: root });
  const signedPackage = hashRegularFile(signedPackagePath, 'signed Windows package', MAX_SIGNED_PACKAGE_BYTES);
  if (pathIsWithinRoot(root, signedPackage.path)) throw new Error('signed Windows package must remain outside system-e2e evidence');

  const manifestPath = resolve(root, 'manifest.json');
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink() || !statSync(manifestPath).isFile()) throw new Error('system-e2e manifest.json is missing or unsafe');
  const manifestBytes = readFileSync(manifestPath);
  if (manifestBytes.length <= 0 || manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('system-e2e manifest size is invalid');
  const manifestSha256 = sha256(manifestBytes);
  const manifest = parseJsonBytes(manifestBytes, 'system-e2e manifest');
  assertExactKeys(manifest, ['schemaVersion', 'status', 'runId', 'operatorId', 'source', 'environment', 'release', 'steps'], 'system-e2e manifest');
  if (manifest.schemaVersion !== P10_SYSTEM_E2E_SCHEMA_VERSION || manifest.status !== 'EVIDENCE_COMPLETE_REVIEW_PENDING'
    || !SAFE_ID.test(manifest.runId ?? '') || !SAFE_ID.test(manifest.operatorId ?? '')) throw new Error('system-e2e manifest identity/status is invalid');
  const evidenceSource = exactSource(manifest.source, 'system-e2e source');
  if (!sameSource(evidenceSource, source)) throw new Error('system-e2e source does not match exact release source binding');

  assertExactKeys(manifest.environment, ['classification', 'platform', 'productionData', 'customerData'], 'system-e2e environment');
  if (manifest.environment.classification !== 'DISPOSABLE_QUALIFICATION'
    || manifest.environment.platform !== 'WINDOWS11_WSL2'
    || manifest.environment.productionData !== false
    || manifest.environment.customerData !== false) {
    throw new Error('system-e2e environment must be disposable Windows 11/WSL2 qualification with no production/customer data');
  }

  assertExactKeys(manifest.release, ['productVersion', 'manifestDigest', 'signedPackageSha256'], 'system-e2e release');
  if (!SEMVER.test(manifest.release.productVersion ?? '') || manifest.release.productVersion !== releaseIdentity.productVersion
    || !SHA256.test(manifest.release.manifestDigest ?? '') || manifest.release.manifestDigest !== releaseIdentity.manifestDigest) {
    throw new Error('system-e2e release manifest identity does not match the exact P9 release manifest');
  }
  if (!SHA256.test(manifest.release.signedPackageSha256 ?? '') || manifest.release.signedPackageSha256 !== signedPackage.sha256) {
    throw new Error('system-e2e signed package SHA-256 does not match the supplied package bytes');
  }

  if (!Array.isArray(manifest.steps) || manifest.steps.length !== P10_SYSTEM_E2E_STEPS.length) throw new Error('system-e2e step count is invalid');
  const seenPaths = new Set();
  let artifactCount = 0;
  let totalArtifactBytes = 0;
  let previousCompleted = null;
  let firstStarted = null;
  for (let index = 0; index < P10_SYSTEM_E2E_STEPS.length; index += 1) {
    const step = manifest.steps[index];
    assertExactKeys(step, ['id', 'status', 'startedAt', 'completedAt', 'artifacts'], `system-e2e step ${index + 1}`);
    if (step.id !== P10_SYSTEM_E2E_STEPS[index]) throw new Error(`system-e2e step order/identity mismatch at ${index + 1}`);
    if (step.status !== 'PASS') throw new Error(`system-e2e step is not PASS: ${step.id}`);
    const started = parseUtc(step.startedAt, `${step.id} startedAt`);
    const completed = parseUtc(step.completedAt, `${step.id} completedAt`);
    if (firstStarted === null) firstStarted = started;
    if (completed <= started || (previousCompleted !== null && started <= previousCompleted)) throw new Error(`system-e2e step time order is invalid: ${step.id}`);
    previousCompleted = completed;
    if (!Array.isArray(step.artifacts) || step.artifacts.length < 1 || step.artifacts.length > 32) throw new Error(`system-e2e step artifacts are invalid: ${step.id}`);
    for (const artifact of step.artifacts) {
      totalArtifactBytes += validateArtifact(root, artifact, seenPaths);
      artifactCount += 1;
      if (artifactCount > MAX_ARTIFACTS || totalArtifactBytes > MAX_TOTAL_ARTIFACT_BYTES) throw new Error('system-e2e artifact bounds exceeded');
    }
  }
  if (parseUtc(signingIdentity.signedAt, 'release signedAt') > firstStarted) throw new Error('release signature was created after the full-system qualification started');

  assertClosedEvidenceLayout(root, seenPaths);
  const { review, reviewReceiptSha256 } = validateIndependentReview({
    root,
    manifestSha256,
    manifest,
    source,
    releaseIdentity,
    signedPackageSha256: signedPackage.sha256,
    lastCompleted: previousCompleted,
  });
  if (sha256(readFileSync(manifestPath)) !== manifestSha256) throw new Error('system-e2e manifest changed during validation');
  if (sha256(readFileSync(resolve(root, 'review/independent-review.json'))) !== reviewReceiptSha256) throw new Error('system-e2e independent review changed during validation');
  const packageAfter = hashRegularFile(signedPackagePath, 'signed Windows package', MAX_SIGNED_PACKAGE_BYTES);
  if (packageAfter.sha256 !== signedPackage.sha256 || packageAfter.bytes !== signedPackage.bytes) throw new Error('signed Windows package changed during validation');

  return {
    schemaVersion: P10_SYSTEM_E2E_SCHEMA_VERSION,
    status: 'PASS',
    runId: manifest.runId,
    operatorId: manifest.operatorId,
    sourceCommit: source.commit,
    productVersion: releaseIdentity.productVersion,
    releaseManifestDigest: releaseIdentity.manifestDigest,
    signedPackageSha256: signedPackage.sha256,
    releaseSignatureProofSha256: signingIdentity.proofSha256,
    releaseTrustPolicyId: signingIdentity.policyId,
    releaseTrustPolicySha256: signingIdentity.trustPolicySha256,
    signingKeyId: signingIdentity.keyId,
    signingKeyFingerprint: signingIdentity.publicKeyFingerprint,
    evidenceManifestSha256: manifestSha256,
    reviewReceiptSha256,
    reviewerId: review.reviewerId,
    reviewedAt: review.reviewedAt,
    stepCount: manifest.steps.length,
    artifactCount,
    totalArtifactBytes,
    environment: manifest.environment.classification,
    platform: manifest.environment.platform,
  };
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const evidenceDir = valueAfter('--evidence-dir');
  const sourceBindingPath = valueAfter('--source-binding');
  const releaseManifestPath = valueAfter('--release-manifest');
  const releaseSignatureProofPath = valueAfter('--release-signature-proof');
  const releaseTrustPolicyPath = valueAfter('--release-trust-policy');
  const signedPackagePath = valueAfter('--signed-package');
  if (!evidenceDir || !sourceBindingPath || !releaseManifestPath || !releaseSignatureProofPath || !releaseTrustPolicyPath || !signedPackagePath) {
    throw new Error('--evidence-dir, --source-binding, --release-manifest, --release-signature-proof, --release-trust-policy and --signed-package are required');
  }
  process.stdout.write(`${JSON.stringify(validateP10SystemE2eEvidence({
    evidenceDir,
    sourceBindingPath,
    releaseManifestPath,
    releaseSignatureProofPath,
    releaseTrustPolicyPath,
    signedPackagePath,
  }), null, 2)}\n`);
}
