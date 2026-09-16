#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
export const BUILD_TYPE = 'urn:quarangate:buildtype:p9-release-assurance:v1';
export const BUILDER_ID = 'urn:quarangate:builder:local-release-assurance:v1';
export const SIGSTORE_BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json';
export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const COSIGN_VERSION = '3.1.3';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|private[-_]?keys?)(?:\/|$)/iu;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} is malformed JSON`); }
}

export function canonicalStringify(value) {
  if (value === null) return 'null';
  if (value === undefined) throw new Error('canonical JSON contains undefined');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON contains non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  throw new Error(`canonical JSON contains unsupported type ${typeof value}`);
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
  if (!file.path || normalized !== file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').includes('..')) {
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
  const keys = lifecycle.migrations.map((migration) => `${migration.kind}:${String(migration.fromVersion).padStart(8, '0')}:${migration.id}`);
  if (keys.some((key, index) => index > 0 && keys[index - 1] >= key)) throw new Error('release manifest migrations must be sorted and unique');
  for (const [kind, version] of [['CONFIG', lifecycle.configSchemaVersion], ['STATE', lifecycle.stateSchemaVersion]]) {
    const records = lifecycle.migrations.filter((migration) => migration.kind === kind);
    if (records.length !== version || records.some((record, index) => record.fromVersion !== index || record.toVersion !== index + 1)) {
      throw new Error(`release manifest ${kind} migration history is incomplete`);
    }
  }
}

export function verifyReleaseManifest(manifest, sourceCommit) {
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
  if (JSON.stringify(manifest.lifecycle.components) !== JSON.stringify(images.map((image) => image.component))) throw new Error('release manifest lifecycle/image component set mismatch');
  const { manifestDigest, ...identity } = manifest;
  const expectedDigest = sha256(Buffer.from(canonicalStringify(identity), 'utf8'));
  if (expectedDigest !== manifestDigest) throw new Error('release manifest canonical digest mismatch');
  return { manifestDigest, productVersion: manifest.productVersion, images };
}

export function validateSourceBinding(receipt) {
  const source = receipt?.source;
  if (receipt?.schemaVersion !== 1 || receipt?.gate !== 'source-binding' || receipt?.status !== 'PASS' || source?.clean !== true
    || !/^[0-9a-f]{40}$/u.test(source?.commit ?? '') || !/^[0-9a-f]{40}$/u.test(source?.tree ?? '')) {
    throw new Error('source-binding receipt is not a valid exact clean source receipt');
  }
  return source;
}

function run(binary, args) {
  const started = Date.now();
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return {
    status: result.status,
    signal: result.signal ?? null,
    errorCode: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function git(args) {
  const result = run('git', args);
  if (result.errorCode || result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function currentSource() {
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const indexTree = git(['write-tree']);
  if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{40}$/u.test(tree) || indexTree !== tree) throw new Error('current Git source/index identity is invalid or staged');
  if (run('git', ['diff', '--quiet', '--no-ext-diff']).status !== 0 || run('git', ['diff', '--cached', '--quiet', '--no-ext-diff']).status !== 0 || run('git', ['diff', '--check', 'HEAD']).status !== 0) {
    throw new Error('current Git working tree is not clean');
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (untracked.length) throw new Error('current Git working tree has non-ignored untracked bytes');
  const origin = run('git', ['config', '--get', 'remote.origin.url']);
  const branch = run('git', ['branch', '--show-current']);
  return { repository: origin.status === 0 ? origin.stdout.trim() || null : null, branch: branch.status === 0 ? branch.stdout.trim() || null : null, commit, tree, clean: true };
}

function sameSource(a, b) {
  return a?.clean === true && b?.clean === true && a?.repository === b?.repository && a?.branch === b?.branch && a?.commit === b?.commit && a?.tree === b?.tree;
}

export function pathIsWithinRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

function requireExternalOutput(path, label) {
  const root = git(['rev-parse', '--show-toplevel']);
  if (pathIsWithinRoot(root, path)) throw new Error(`${label} must be outside the Git worktree`);
}

export function buildProvenanceStatement({ source, sourceBindingBytes, manifest, manifestBytes, sbomBytes, policyBytes, toolchainBytes }) {
  const identity = verifyReleaseManifest(manifest, source.commit);
  const releaseManifestSha256 = sha256(manifestBytes);
  const subjects = [
    { name: `quarangate-release-manifest-${identity.productVersion}.json`, digest: { sha256: releaseManifestSha256 } },
    ...identity.images.map((image) => ({ name: image.reference, digest: { sha256: image.digest.slice('sha256:'.length) } })),
  ];
  return {
    _type: STATEMENT_TYPE,
    subject: subjects,
    predicateType: PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: BUILD_TYPE,
        externalParameters: {
          architecture: manifest.architecture,
          productVersion: manifest.productVersion,
          releaseManifestDigest: manifest.manifestDigest,
          releaseSigningState: manifest.signing,
        },
        internalParameters: {
          sourceBranch: source.branch,
          sourceCommit: source.commit,
          sourceTree: source.tree,
        },
        resolvedDependencies: [
          { uri: source.repository ?? 'urn:quarangate:source:unknown', digest: { gitCommit: source.commit } },
          { name: 'security/release-policy.json', digest: { sha256: sha256(policyBytes) } },
          { name: 'security/release-toolchain.json', digest: { sha256: sha256(toolchainBytes) } },
        ],
      },
      runDetails: {
        builder: { id: BUILDER_ID, version: { releaseAssurance: '1' } },
        byproducts: [
          { name: 'source-binding.json', digest: { sha256: sha256(sourceBindingBytes) } },
          { name: 'release.spdx.json', digest: { sha256: sha256(sbomBytes) } },
        ],
      },
    },
  };
}

export function validateProvenanceStatement(statement) {
  assertExactKeys(statement, ['_type', 'subject', 'predicateType', 'predicate'], 'in-toto statement');
  if (statement._type !== STATEMENT_TYPE || statement.predicateType !== PREDICATE_TYPE || !Array.isArray(statement.subject) || statement.subject.length < 2) throw new Error('in-toto/SLSA statement identity is invalid');
  for (const item of statement.subject) {
    assertExactKeys(item, ['name', 'digest'], 'in-toto subject');
    if (typeof item.name !== 'string' || !item.name) throw new Error('in-toto subject name is invalid');
    assertExactKeys(item.digest, ['sha256'], 'in-toto subject digest');
    if (!SHA256.test(item.digest.sha256)) throw new Error('in-toto subject digest is invalid');
  }
  assertExactKeys(statement.predicate, ['buildDefinition', 'runDetails'], 'SLSA predicate');
  const build = statement.predicate.buildDefinition;
  assertExactKeys(build, ['buildType', 'externalParameters', 'internalParameters', 'resolvedDependencies'], 'SLSA buildDefinition');
  if (build.buildType !== BUILD_TYPE || !Array.isArray(build.resolvedDependencies) || build.resolvedDependencies.length < 3) throw new Error('SLSA buildDefinition is invalid');
  assertPlainObject(build.externalParameters, 'SLSA externalParameters');
  assertPlainObject(build.internalParameters, 'SLSA internalParameters');
  const runDetails = statement.predicate.runDetails;
  assertExactKeys(runDetails, ['builder', 'byproducts'], 'SLSA runDetails');
  assertExactKeys(runDetails.builder, ['id', 'version'], 'SLSA builder');
  if (runDetails.builder.id !== BUILDER_ID || !Array.isArray(runDetails.byproducts) || runDetails.byproducts.length !== 2) throw new Error('SLSA runDetails is invalid');
  return statement;
}

function strictBase64(value, label) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error(`${label} is not canonical base64`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

export function extractSignedStatement(bundle) {
  assertExactKeys(bundle, ['mediaType', 'verificationMaterial', 'dsseEnvelope'], 'Sigstore bundle');
  if (bundle.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE) throw new Error('Sigstore bundle media type is not v0.3');
  assertPlainObject(bundle.verificationMaterial, 'Sigstore verificationMaterial');
  const envelope = bundle.dsseEnvelope;
  assertExactKeys(envelope, ['payload', 'payloadType', 'signatures'], 'Sigstore DSSE envelope');
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) throw new Error('Sigstore DSSE envelope identity/signature cardinality is invalid');
  const signature = envelope.signatures[0];
  assertPlainObject(signature, 'Sigstore DSSE signature');
  if (typeof signature.sig !== 'string' || !signature.sig) throw new Error('Sigstore DSSE signature is missing');
  strictBase64(signature.sig, 'Sigstore DSSE signature');
  const payload = strictBase64(envelope.payload, 'Sigstore DSSE payload');
  let statement;
  try { statement = JSON.parse(payload.toString('utf8')); } catch { throw new Error('Sigstore DSSE payload is not JSON'); }
  validateProvenanceStatement(statement);
  return { statement, payloadSha256: sha256(payload), payloadBytes: payload.length };
}

export function exactCosignVersion(output) {
  const escaped = COSIGN_VERSION.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^0-9A-Za-z.+-])v?${escaped}(?:$|[^0-9A-Za-z.+-])`, 'u').test(output);
}

function executionEvidence(result, commandId) {
  return {
    commandId,
    exitCode: result.status,
    signal: result.signal,
    durationMs: result.durationMs,
    stdout: { sha256: sha256(Buffer.from(result.stdout, 'utf8')), bytes: Buffer.byteLength(result.stdout, 'utf8') },
    stderr: { sha256: sha256(Buffer.from(result.stderr, 'utf8')), bytes: Buffer.byteLength(result.stderr, 'utf8') },
  };
}

function writeReceipt(path, receipt) {
  writeFileSync(resolve(path), `${JSON.stringify(receipt, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const valueAfter = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const sourceBindingPath = valueAfter('--source-binding');
  const manifestPath = valueAfter('--release-manifest');
  const sbomPath = valueAfter('--sbom');
  const statementOutput = valueAfter('--statement-output');
  const bundlePath = valueAfter('--bundle');
  const publicKeyPath = valueAfter('--public-key');
  const output = valueAfter('--output');
  if (!sourceBindingPath || !existsSync(sourceBindingPath)) throw new Error('--source-binding requires an existing receipt');
  if (!manifestPath || !existsSync(manifestPath)) throw new Error('--release-manifest requires an existing P9 release manifest');
  if (!sbomPath || !existsSync(sbomPath)) throw new Error('--sbom requires an existing SPDX JSON file');
  if (!statementOutput || !output) throw new Error('--statement-output and --output are required');
  requireExternalOutput(statementOutput, '--statement-output');
  requireExternalOutput(output, '--output');

  const before = currentSource();
  const sourceBindingBytes = readFileSync(sourceBindingPath);
  const source = validateSourceBinding(JSON.parse(sourceBindingBytes.toString('utf8')));
  if (!sameSource(source, before)) throw new Error('source-binding receipt does not match current exact Git source');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = readJson(manifestPath, 'release manifest');
  const sbomBytes = readFileSync(sbomPath);
  const sbom = readJson(sbomPath, 'SBOM');
  if (sbom.spdxVersion !== 'SPDX-2.3' || sbom.SPDXID !== 'SPDXRef-DOCUMENT') throw new Error('SBOM is not the expected SPDX-2.3 document');
  const policyBytes = readFileSync('security/release-policy.json');
  const toolchainBytes = readFileSync('security/release-toolchain.json');
  const statement = buildProvenanceStatement({ source, sourceBindingBytes, manifest, manifestBytes, sbomBytes, policyBytes, toolchainBytes });
  validateProvenanceStatement(statement);
  const statementBytes = Buffer.from(`${JSON.stringify(statement, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(statementOutput), statementBytes);

  const base = {
    schemaVersion: 1,
    gate: 'provenance',
    source,
    tool: { name: 'cosign', version: COSIGN_VERSION },
    statement: {
      predicateType: PREDICATE_TYPE,
      sha256: sha256(statementBytes),
      bytes: statementBytes.length,
      subjectCount: statement.subject.length,
      releaseManifestSha256: sha256(manifestBytes),
      releaseManifestDigest: manifest.manifestDigest,
      sbomSha256: sha256(sbomBytes),
    },
    findings: [],
  };

  const missing = [];
  if (!bundlePath || !existsSync(bundlePath)) missing.push('SIGSTORE_BUNDLE_NOT_PROVIDED');
  if (!publicKeyPath || !existsSync(publicKeyPath)) missing.push('PUBLIC_KEY_NOT_PROVIDED');
  const version = run('cosign', ['version']);
  if (version.errorCode === 'ENOENT') missing.push('COSIGN_UNAVAILABLE');
  if (missing.length) {
    const after = currentSource();
    if (!sameSource(source, after)) throw new Error('provenance generation mutated or drifted exact Git source');
    writeReceipt(output, { ...base, status: 'UNAVAILABLE', failureCode: 'PROVENANCE_PREREQUISITES_UNAVAILABLE', missingPrerequisites: [...new Set(missing)].sort() });
    return 4;
  }
  const versionText = `${version.stdout}\n${version.stderr}`;
  if (version.status !== 0 || version.errorCode || !exactCosignVersion(versionText)) {
    writeReceipt(output, { ...base, status: 'FAIL', failureCode: 'COSIGN_VERSION_MISMATCH', execution: executionEvidence(version, 'cosign-version') });
    return 5;
  }

  const bundleBytes = readFileSync(bundlePath);
  const bundle = readJson(bundlePath, 'Sigstore bundle');
  const signed = extractSignedStatement(bundle);
  if (canonicalStringify(signed.statement) !== canonicalStringify(statement)) {
    writeReceipt(output, { ...base, status: 'FAIL', failureCode: 'SIGNED_STATEMENT_MISMATCH', bundle: { sha256: sha256(bundleBytes), bytes: bundleBytes.length, signedStatementSha256: signed.payloadSha256, signedStatementBytes: signed.payloadBytes } });
    return 5;
  }
  const publicKeyBytes = readFileSync(publicKeyPath);
  const releaseManifestSha256 = sha256(manifestBytes);
  const verify = run('cosign', [
    'verify-blob-attestation', '--bundle', resolve(bundlePath), '--key', resolve(publicKeyPath), '--type', PREDICATE_TYPE,
    '--digest', releaseManifestSha256, '--digestAlg', 'sha256',
  ]);
  const after = currentSource();
  if (!sameSource(source, after)) throw new Error('provenance verification mutated or drifted exact Git source');
  const status = verify.status === 0 && !verify.errorCode ? 'PASS' : 'FAIL';
  writeReceipt(output, {
    ...base,
    status,
    bundle: { sha256: sha256(bundleBytes), bytes: bundleBytes.length, mediaType: bundle.mediaType, signedStatementSha256: signed.payloadSha256, signedStatementBytes: signed.payloadBytes },
    publicKey: { sha256: sha256(publicKeyBytes), bytes: publicKeyBytes.length },
    execution: executionEvidence(verify, 'cosign-verify-blob-attestation'),
    ...(status === 'FAIL' ? { failureCode: verify.errorCode ? 'COSIGN_EXECUTION_ERROR' : 'COSIGN_VERIFICATION_FAILED' } : {}),
  });
  return status === 'PASS' ? 0 : 5;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) process.exitCode = main();
