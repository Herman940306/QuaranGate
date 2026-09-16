#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const evidenceDir = valueAfter('--evidence-dir');
const sourceBindingPath = valueAfter('--source-binding');
const releaseManifestPath = valueAfter('--release-manifest');
const sbomPath = valueAfter('--sbom');
const policyReportPath = valueAfter('--policy-report');
const output = valueAfter('--output');
if (!evidenceDir) throw new Error('--evidence-dir is required');
if (!sourceBindingPath || !existsSync(sourceBindingPath)) throw new Error('--source-binding requires an existing source-binding receipt');
if (!releaseManifestPath || !existsSync(releaseManifestPath)) throw new Error('--release-manifest requires an existing P9 release manifest');
if (!sbomPath || !existsSync(sbomPath)) throw new Error('--sbom requires an existing SPDX JSON file');
if (!policyReportPath || !existsSync(policyReportPath)) throw new Error('--policy-report requires an existing release-policy report');
if (!output) throw new Error('--output is required');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (path, label) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${label} is malformed JSON`); } };
const sameSource = (a, b) => a?.clean === true && b?.clean === true && a?.commit === b?.commit && a?.tree === b?.tree && a?.repository === b?.repository;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|private[-_]?keys?)(?:\/|$)/iu;

function canonicalStringify(value) {
  if (value === null) return 'null';
  if (value === undefined) throw new Error('release manifest contains undefined');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release manifest contains non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  throw new Error(`release manifest contains unsupported type ${typeof value}`);
}

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

function validateFile(file) {
  assertExactKeys(file, ['path', 'sizeBytes', 'digest', 'mode'], 'release manifest file');
  const normalized = posix.normalize(file.path);
  if (!file.path || normalized !== file.path || posix.isAbsolute(file.path) || file.path.includes('\\') || file.path.split('/').includes('..') || normalized === '.') {
    throw new Error('release manifest file path is unsafe');
  }
  if (SECRET_PATH.test(file.path)) throw new Error('release manifest secret/credential path is refused');
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !SHA256.test(file.digest ?? '') || ![0o644, 0o755].includes(file.mode)) {
    throw new Error('release manifest file identity is invalid');
  }
}

function validateImage(image) {
  assertExactKeys(image, ['component', 'reference', 'digest'], 'release manifest image');
  if (!SAFE_ID.test(image.component ?? '') || typeof image.reference !== 'string' || !image.reference || /(?:^|:)latest$/iu.test(image.reference) || !/^sha256:[0-9a-f]{64}$/u.test(image.digest ?? '')) {
    throw new Error('release manifest image identity is invalid or mutable');
  }
  return { component: image.component, reference: image.reference, digest: image.digest };
}

function validateLifecycle(lifecycle, files) {
  assertExactKeys(lifecycle, ['configSchemaVersion', 'stateSchemaVersion', 'components', 'migrations'], 'release manifest lifecycle');
  if (!Number.isInteger(lifecycle.configSchemaVersion) || lifecycle.configSchemaVersion < 0
    || !Number.isInteger(lifecycle.stateSchemaVersion) || lifecycle.stateSchemaVersion < 0
    || !Array.isArray(lifecycle.components) || lifecycle.components.length === 0
    || lifecycle.components.some((component) => !SAFE_ID.test(component))
    || lifecycle.components.some((component, index) => index > 0 && lifecycle.components[index - 1] >= component)
    || !Array.isArray(lifecycle.migrations)) {
    throw new Error('release manifest lifecycle identity is invalid');
  }
  for (const migration of lifecycle.migrations) {
    assertExactKeys(migration, ['id', 'kind', 'fromVersion', 'toVersion', 'digest'], 'release manifest migration');
    if (!SAFE_ID.test(migration.id ?? '') || !['CONFIG', 'STATE'].includes(migration.kind)
      || !Number.isInteger(migration.fromVersion) || migration.fromVersion < 0
      || migration.toVersion !== migration.fromVersion + 1 || !SHA256.test(migration.digest ?? '')) {
      throw new Error('release manifest migration identity is invalid');
    }
    const artifact = `migrations/${migration.kind.toLowerCase()}/${migration.id}.json`;
    const file = files.find((candidate) => candidate.path === artifact);
    if (!file || file.digest !== migration.digest) throw new Error('release manifest migration is not bound to an exact payload artifact');
  }
  const migrationKeys = lifecycle.migrations.map((migration) => `${migration.kind}:${String(migration.fromVersion).padStart(8, '0')}:${migration.id}`);
  if (migrationKeys.some((key, index) => index > 0 && migrationKeys[index - 1] >= key)) throw new Error('release manifest migrations must be sorted and unique');
  for (const [kind, version] of [['CONFIG', lifecycle.configSchemaVersion], ['STATE', lifecycle.stateSchemaVersion]]) {
    const records = lifecycle.migrations.filter((migration) => migration.kind === kind);
    if (records.length !== version || records.some((record, index) => record.fromVersion !== index || record.toVersion !== index + 1)) {
      throw new Error(`release manifest ${kind} migration history is incomplete`);
    }
  }
}

function verifyReleaseManifest(manifest, sourceCommit) {
  assertExactKeys(manifest, ['schemaVersion', 'productVersion', 'sourceCommit', 'createdAt', 'architecture', 'signing', 'lifecycle', 'files', 'images', 'manifestDigest'], 'release manifest');
  if (manifest.schemaVersion !== 1 || manifest.sourceCommit !== sourceCommit || !SEMVER.test(manifest.productVersion ?? '')
    || !Number.isFinite(Date.parse(manifest.createdAt)) || manifest.architecture !== 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE'
    || !['DEFERRED_EXTERNAL_OWNER_CREDENTIAL', 'NOT_YET_RELEASE_GATE'].includes(manifest.signing)
    || !SHA256.test(manifest.manifestDigest ?? '')) {
    throw new Error('release manifest identity/source binding is invalid');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('release manifest has no payload files');
  manifest.files.forEach(validateFile);
  const filePaths = manifest.files.map((file) => file.path);
  if (filePaths.some((value, index) => index > 0 && filePaths[index - 1] >= value)) throw new Error('release manifest payload files must be sorted and unique');
  validateLifecycle(manifest.lifecycle, manifest.files);
  if (!Array.isArray(manifest.images) || manifest.images.length === 0) throw new Error('release manifest has no OCI image identities');
  const images = manifest.images.map(validateImage);
  if (images.some((image, index) => index > 0 && images[index - 1].component >= image.component)) throw new Error('release manifest image components must be sorted and unique');
  if (JSON.stringify(manifest.lifecycle.components) !== JSON.stringify(images.map((image) => image.component))) {
    throw new Error('release manifest lifecycle/image component set mismatch');
  }
  const { manifestDigest, ...identity } = manifest;
  const expectedDigest = sha256(Buffer.from(canonicalStringify(identity), 'utf8'));
  if (expectedDigest !== manifestDigest) throw new Error('release manifest canonical digest mismatch');
  return { manifestDigest, productVersion: manifest.productVersion, images };
}

const sourceBindingBytes = readFileSync(sourceBindingPath);
const sourceBinding = readJson(sourceBindingPath, 'source-binding receipt');
if (sourceBinding.schemaVersion !== 1 || sourceBinding.gate !== 'source-binding' || sourceBinding.status !== 'PASS' || sourceBinding.source?.clean !== true || !/^[0-9a-f]{40}$/u.test(sourceBinding.source?.commit ?? '') || !/^[0-9a-f]{40}$/u.test(sourceBinding.source?.tree ?? '')) {
  throw new Error('source-binding receipt is not a valid exact clean source receipt');
}
const source = sourceBinding.source;
const releaseManifestBytes = readFileSync(releaseManifestPath);
const releaseManifest = readJson(releaseManifestPath, 'release manifest');
const releaseIdentity = verifyReleaseManifest(releaseManifest, source.commit);
const policy = readJson('security/release-policy.json', 'release policy');
const policyBytes = readFileSync(policyReportPath);
const policyReport = readJson(policyReportPath, 'release-policy report');
if (policyReport.schemaVersion !== 1 || policyReport.verdict !== 'PASS' || policyReport.ok !== true) throw new Error('release-policy report is not a PASS receipt');
if (!sameSource(policyReport.source, source)) throw new Error('release-policy report source does not match source-binding receipt');
if (policyReport.sourceBinding?.sha256 !== sha256(sourceBindingBytes)) throw new Error('release-policy source-binding hash mismatch');

const sbomBytes = readFileSync(sbomPath);
const sbom = readJson(sbomPath, 'SBOM');
if (sbom.spdxVersion !== 'SPDX-2.3' || sbom.SPDXID !== 'SPDXRef-DOCUMENT') throw new Error('SBOM is not the expected SPDX-2.3 document');

const evidence = [];
const testCounts = {};
for (const gate of policy.requiredGates) {
  const path = join(evidenceDir, `${gate}.json`);
  if (!existsSync(path)) throw new Error(`missing required gate receipt: ${gate}`);
  const bytes = readFileSync(path);
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`malformed required gate receipt: ${gate}`); }
  if (receipt.schemaVersion !== 1 || receipt.gate !== gate || receipt.status !== 'PASS') throw new Error(`gate receipt is not an exact PASS receipt: ${gate}`);
  if (!sameSource(receipt.source, source)) throw new Error(`gate receipt source binding mismatch: ${gate}`);
  const expectedTool = policy.expectedTools?.[gate];
  if (expectedTool && (receipt.tool?.name !== expectedTool.name || receipt.tool?.version !== expectedTool.version)) throw new Error(`gate receipt tool binding mismatch: ${gate}`);
  if (['unit', 'integration', 'e2e'].includes(gate)) {
    const counts = receipt.testCounts;
    if (!counts || !Number.isInteger(counts.files) || counts.files <= 0 || !Number.isInteger(counts.tests) || counts.tests <= 0 || !Number.isInteger(counts.failed) || counts.failed !== 0) throw new Error(`gate receipt lacks valid passing test counts: ${gate}`);
    testCounts[gate] = { files: counts.files, tests: counts.tests, failed: counts.failed };
  }
  evidence.push({ gate, sha256: sha256(bytes), bytes: bytes.length });
}

const policyEvidence = new Map((policyReport.evidence ?? []).map((entry) => [entry.gate, entry.sha256]));
for (const item of evidence) if (policyEvidence.get(item.gate) !== item.sha256) throw new Error(`release-policy evidence hash mismatch: ${item.gate}`);
evidence.sort((a, b) => a.gate.localeCompare(b.gate));
const subject = {
  productVersion: releaseIdentity.productVersion,
  releaseManifestDigest: releaseIdentity.manifestDigest,
  images: releaseIdentity.images,
};
const artifacts = {
  sourceBinding: { path: sourceBindingPath, sha256: sha256(sourceBindingBytes), bytes: sourceBindingBytes.length },
  releaseManifest: { path: releaseManifestPath, sha256: sha256(releaseManifestBytes), bytes: releaseManifestBytes.length, manifestDigest: releaseIdentity.manifestDigest },
  sbom: { path: sbomPath, sha256: sha256(sbomBytes), bytes: sbomBytes.length, format: 'SPDX-2.3' },
  policyReport: { path: policyReportPath, sha256: sha256(policyBytes), bytes: policyBytes.length },
};
const bindingArtifacts = {
  sourceBinding: { sha256: artifacts.sourceBinding.sha256, bytes: artifacts.sourceBinding.bytes },
  releaseManifest: { sha256: artifacts.releaseManifest.sha256, bytes: artifacts.releaseManifest.bytes, manifestDigest: artifacts.releaseManifest.manifestDigest },
  sbom: { sha256: artifacts.sbom.sha256, bytes: artifacts.sbom.bytes, format: artifacts.sbom.format },
  policyReport: { sha256: artifacts.policyReport.sha256, bytes: artifacts.policyReport.bytes },
};
const bindingInput = Buffer.from(JSON.stringify({ source, subject, artifacts: bindingArtifacts, evidence, testCounts }), 'utf8');
const bundle = { schemaVersion: 1, source, subject, artifacts, testCounts, evidence, bundleBindingSha256: sha256(bindingInput) };
writeFileSync(resolve(output), `${JSON.stringify(bundle, null, 2)}\n`);
