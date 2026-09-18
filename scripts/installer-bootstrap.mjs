#!/usr/bin/env node
/**
 * QuaranGate production release bootstrap.
 *
 * This file is intentionally a minimal inner release verifier:
 *   - its own bytes must already be authenticated by the outer signed Windows
 *     package before execution; it is not self-authenticating;
 *   - Node built-ins only;
 *   - no imports from QuaranGate source or package dependencies;
 *   - verifies release identity/signature/trust/payload closure, copies only
 *     verified bytes into a private staging tree, re-verifies that tree, and
 *     loads dist/installer/cli.js only from the private verified copy.
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|private[-_]?keys?)(?:\/|$)/iu;
const PRODUCTION_COMPONENTS = ['docker-authority', 'executor', 'gateway', 'projects-work'];
const INSTALLER_RUNTIME_MODULES = [
  'dist/executor/agentConfig.js',
  'dist/executor/agents/applyPolicy.js',
  'dist/executor/agents/canonicalJson.js',
  'dist/gateway/config.js',
  'dist/installer/cli.js',
  'dist/installer/hostProbe.js',
  'dist/installer/productInstaller.js',
  'dist/installer/productionInstaller.js',
  'dist/installer/productionRelease.js',
  'dist/installer/releasePackage.js',
  'dist/installer/runtimeConfig.js',
  'dist/installer/wslProductionPlatform.js',
  'dist/lifecycle/engine.js',
  'dist/lifecycle/manifest.js',
  'dist/lifecycle/pathOwnership.js',
  'dist/lifecycle/planner.js',
  'dist/lifecycle/productionDriver.js',
  'dist/lifecycle/safeFilesystem.js',
  'dist/shared/agents.js',
  'dist/shared/errors.js',
];
const INSTALLER_RUNTIME_PACKAGES = ['yaml', 'zod'];
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => 'node:' + name)]);
const REQUIRED_PAYLOAD = [
  'compose.yaml',
  ...INSTALLER_RUNTIME_MODULES,
  'node_modules/yaml/package.json',
  'node_modules/zod/package.json',
  'package-lock.json',
  'package.json',
  'scripts/installer-bootstrap.mjs',
  'scripts/production-runtime-start.sh',
  'scripts/production-runtime-stop.sh',
  'scripts/windows/Inspect-QuaranGateProductionAutostart.ps1',
  'scripts/windows/Install-QuaranGateProductionAutostart.ps1',
  'scripts/windows/Open-QuaranGateControlCenter.ps1',
  'scripts/windows/QuaranGate-Setup.cmd',
  'scripts/windows/QuaranGate-Setup.ps1',
  'scripts/windows/Remove-QuaranGateProductionAutostart.ps1',
];
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_FILES = 50_000;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function canonicalStringify(value) {
  if (value === null) return 'null';
  if (value === undefined) fail('canonical value contains undefined');
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) fail('canonical value contains non-finite number');
      return JSON.stringify(value);
    case 'string': return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return '[' + value.map((item) => canonicalStringify(item)).join(',') + ']';
      return '{' + Object.keys(value).sort().map((key) =>
        JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}';
    default:
      fail('canonical value contains unsupported type');
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object');
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const want = [...expected].sort();
  if (actual.length !== want.length || actual.some((key, index) => key !== want[index])) {
    fail(label + ' contains unknown or missing fields');
  }
}

function canonicalExternalFile(input, label) {
  if (!path.isAbsolute(input) || path.resolve(input) !== input) fail(label + ' must be one canonical absolute path');
  const stat = lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_JSON_BYTES) {
    fail(label + ' must be a bounded single-link regular file');
  }
  if (realpathSync(input) !== input) fail(label + ' must not resolve through an alias');
  return input;
}

function canonicalPackageRoot(input) {
  if (!path.isAbsolute(input) || path.resolve(input) !== input || input === path.parse(input).root) {
    fail('package root must be one canonical absolute non-root path');
  }
  const stat = lstatSync(input);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(input) !== input) {
    fail('package root must be one real canonical directory');
  }
  return input;
}

function readJson(file, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(canonicalExternalFile(file, label), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail(label + ' is not valid JSON');
    throw error;
  }
  return parsed;
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function safePayloadPath(value) {
  if (typeof value !== 'string') return false;
  const normalized = path.posix.normalize(value);
  return Boolean(value)
    && normalized === value
    && !path.posix.isAbsolute(value)
    && !value.includes('\\')
    && !value.split('/').includes('..')
    && normalized !== '.'
    && !SECRET_PATH.test(value);
}

function validateManifest(manifest) {
  assertExactKeys(manifest, [
    'schemaVersion', 'productVersion', 'sourceCommit', 'createdAt',
    'architecture', 'signing', 'lifecycle', 'files', 'images', 'manifestDigest',
  ], 'release manifest');
  if (manifest.schemaVersion !== 1
    || !SEMVER.test(manifest.productVersion ?? '')
    || !GIT_COMMIT.test(manifest.sourceCommit ?? '')
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || manifest.architecture !== 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE'
    || !['DEFERRED_EXTERNAL_OWNER_CREDENTIAL', 'NOT_YET_RELEASE_GATE'].includes(manifest.signing)
    || !SHA256.test(manifest.manifestDigest ?? '')) {
    fail('release manifest identity is invalid');
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_PACKAGE_FILES) {
    fail('release manifest file inventory is invalid');
  }
  let totalBytes = 0;
  for (const file of manifest.files) {
    assertExactKeys(file, ['path', 'sizeBytes', 'digest', 'mode'], 'release manifest file');
    if (!safePayloadPath(file.path)
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
      || !SHA256.test(file.digest ?? '')
      || ![0o644, 0o755].includes(file.mode)) {
      fail('release manifest file identity is invalid');
    }
    totalBytes += file.sizeBytes;
    if (totalBytes > MAX_PACKAGE_BYTES) fail('release payload exceeds bootstrap byte bound');
  }
  const filePaths = manifest.files.map((file) => file.path);
  if (filePaths.some((value, index) => index > 0 && filePaths[index - 1] >= value)) {
    fail('release manifest files must be sorted and unique');
  }

  assertExactKeys(manifest.lifecycle, ['configSchemaVersion', 'stateSchemaVersion', 'components', 'migrations'], 'release lifecycle');
  const lifecycle = manifest.lifecycle;
  if (!Number.isInteger(lifecycle.configSchemaVersion) || lifecycle.configSchemaVersion < 0
    || !Number.isInteger(lifecycle.stateSchemaVersion) || lifecycle.stateSchemaVersion < 0
    || !Array.isArray(lifecycle.components) || lifecycle.components.length === 0
    || lifecycle.components.some((component) => !SAFE_ID.test(component))
    || lifecycle.components.some((component, index) => index > 0 && lifecycle.components[index - 1] >= component)
    || !Array.isArray(lifecycle.migrations)) {
    fail('release lifecycle identity is invalid');
  }
  for (const migration of lifecycle.migrations) {
    assertExactKeys(migration, ['id', 'kind', 'fromVersion', 'toVersion', 'digest'], 'release migration');
    if (!SAFE_ID.test(migration.id ?? '') || !['CONFIG', 'STATE'].includes(migration.kind)
      || !Number.isInteger(migration.fromVersion) || migration.fromVersion < 0
      || migration.toVersion !== migration.fromVersion + 1 || !SHA256.test(migration.digest ?? '')) {
      fail('release migration identity is invalid');
    }
    const artifact = 'migrations/' + migration.kind.toLowerCase() + '/' + migration.id + '.json';
    const file = manifest.files.find((candidate) => candidate.path === artifact);
    if (!file || file.digest !== migration.digest) fail('release migration is not bound to an exact payload file');
  }
  const migrationKeys = lifecycle.migrations.map((migration) =>
    migration.kind + ':' + String(migration.fromVersion).padStart(8, '0') + ':' + migration.id);
  if (migrationKeys.some((value, index) => index > 0 && migrationKeys[index - 1] >= value)) {
    fail('release migrations must be sorted and unique');
  }
  for (const [kind, version] of [['CONFIG', lifecycle.configSchemaVersion], ['STATE', lifecycle.stateSchemaVersion]]) {
    const records = lifecycle.migrations.filter((migration) => migration.kind === kind);
    if (records.length !== version || records.some((record, index) =>
      record.fromVersion !== index || record.toVersion !== index + 1)) {
      fail(kind + ' release migration history is incomplete');
    }
  }

  if (!Array.isArray(manifest.images) || manifest.images.length !== PRODUCTION_COMPONENTS.length) {
    fail('production image inventory is invalid');
  }
  for (const image of manifest.images) {
    assertExactKeys(image, ['component', 'reference', 'digest'], 'release image');
    if (!SAFE_ID.test(image.component ?? '') || typeof image.reference !== 'string' || image.reference.length === 0
      || /(?:^|:)latest$/iu.test(image.reference)
      || !/^sha256:[0-9a-f]{64}$/u.test(image.digest ?? '')) {
      fail('release image identity is invalid');
    }
  }
  const components = manifest.images.map((image) => image.component);
  if (components.some((value, index) => index > 0 && components[index - 1] >= value)
    || JSON.stringify(components) !== JSON.stringify(PRODUCTION_COMPONENTS)
    || JSON.stringify(lifecycle.components) !== JSON.stringify(PRODUCTION_COMPONENTS)) {
    fail('production component inventory is invalid');
  }
  for (const image of manifest.images) {
    if (!image.reference.includes(manifest.sourceCommit) || !image.reference.includes(image.component)) {
      fail('production image reference is not bound to service identity and exact source commit');
    }
  }
  const present = new Set(filePaths);
  const missing = REQUIRED_PAYLOAD.filter((file) => !present.has(file));
  if (missing.length) fail('production release payload is incomplete: ' + missing.join(', '));
  const allowedDependencyPrefixes = INSTALLER_RUNTIME_PACKAGES.map((name) => 'node_modules/' + name + '/');
  const unexpectedDependency = manifest.files.find((file) => file.path.startsWith('node_modules/')
    && !allowedDependencyPrefixes.some((prefix) => file.path.startsWith(prefix)));
  if (unexpectedDependency) {
    fail('production installer payload contains an unaudited runtime dependency: ' + unexpectedDependency.path);
  }
  for (const file of manifest.files) {
    if (['scripts/production-runtime-start.sh', 'scripts/production-runtime-stop.sh'].includes(file.path)
      && file.mode !== 0o755) {
      fail('production runtime script mode is invalid');
    }
  }

  const { manifestDigest, ...identity } = manifest;
  if (sha256(Buffer.from(canonicalStringify(identity), 'utf8')) !== manifestDigest) {
    fail('release manifest canonical digest mismatch');
  }
  return manifest;
}

function validateTrustPolicy(value) {
  assertExactKeys(value, ['schemaVersion', 'policyId', 'trustedKeys'], 'release trust policy');
  if (value.schemaVersion !== 1 || !SAFE_ID.test(value.policyId ?? '')
    || !Array.isArray(value.trustedKeys) || value.trustedKeys.length === 0) {
    fail('release trust policy is invalid');
  }
  const ids = new Set();
  for (const key of value.trustedKeys) {
    assertExactKeys(key, ['keyId', 'algorithm', 'publicKeyPem'], 'trusted release key');
    if (!SAFE_ID.test(key.keyId ?? '') || key.algorithm !== 'Ed25519'
      || typeof key.publicKeyPem !== 'string' || key.publicKeyPem.length > 4096
      || ids.has(key.keyId)) {
      fail('trusted release key is invalid or duplicated');
    }
    ids.add(key.keyId);
  }
  return value;
}

function validateSignatureProof(value, manifest) {
  assertExactKeys(value, ['schemaVersion', 'algorithm', 'keyId', 'manifestDigest', 'signedAt', 'signature'], 'release signature proof');
  if (value.schemaVersion !== 1 || value.algorithm !== 'Ed25519' || !SAFE_ID.test(value.keyId ?? '')
    || value.manifestDigest !== manifest.manifestDigest
    || !Number.isFinite(Date.parse(value.signedAt))
    || Date.parse(value.signedAt) < Date.parse(manifest.createdAt)
    || typeof value.signature !== 'string' || value.signature.length === 0
    || value.signature.length > 512 || !BASE64.test(value.signature)) {
    fail('release signature proof is invalid');
  }
  const signature = Buffer.from(value.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== value.signature) {
    fail('release signature encoding is invalid');
  }
  return value;
}

function verifyDetachedSignature(manifest, proof, trustPolicy) {
  const trusted = trustPolicy.trustedKeys.find((key) => key.keyId === proof.keyId);
  if (!trusted) fail('release signing key is not trusted');
  let publicKey;
  try {
    publicKey = createPublicKey(trusted.publicKeyPem);
  } catch {
    fail('trusted release public key is invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('trusted release key is not Ed25519');
  const payload = Buffer.from(canonicalStringify({
    schemaVersion: 1,
    purpose: 'QUARANGATE_RELEASE_MANIFEST',
    manifestDigest: manifest.manifestDigest,
    productVersion: manifest.productVersion,
    sourceCommit: manifest.sourceCommit,
    createdAt: manifest.createdAt,
  }), 'utf8');
  if (!verifySignature(null, payload, publicKey, Buffer.from(proof.signature, 'base64'))) {
    fail('release signature verification failed');
  }
  return {
    keyId: trusted.keyId,
    publicKeyFingerprint: sha256(publicKey.export({ type: 'spki', format: 'der' })),
  };
}

function ancestors(relative) {
  const parts = relative.split('/');
  const out = [];
  for (let index = 1; index < parts.length; index += 1) out.push(parts.slice(0, index).join('/'));
  return out;
}

function verifyClosedPayload(root, manifest, stageRoot = null) {
  const expectedFiles = new Map(manifest.files.map((file) => [file.path, file]));
  const expectedDirs = new Set(manifest.files.flatMap((file) => ancestors(file.path)));
  const seenFiles = new Set();
  const seenDirs = new Set();
  let totalBytes = 0;

  const walk = (absolute, prefix) => {
    for (const entry of readdirSync(absolute).sort()) {
      const relative = prefix ? prefix + '/' + entry : entry;
      const candidate = path.join(absolute, entry);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) fail('release payload contains a symlink: ' + relative);
      if (stat.isDirectory()) {
        if (!expectedDirs.has(relative)) fail('release payload contains an unmanifested directory: ' + relative);
        seenDirs.add(relative);
        walk(candidate, relative);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) fail('release payload contains an unsafe entry: ' + relative);
      const expected = expectedFiles.get(relative);
      if (!expected) fail('release payload contains an unmanifested file: ' + relative);
      if (stat.size !== expected.sizeBytes) fail('release payload size mismatch: ' + relative);
      const bytes = readFileSync(candidate);
      totalBytes += bytes.length;
      if (totalBytes > MAX_PACKAGE_BYTES) fail('release payload exceeds bootstrap byte bound');
      if (sha256(bytes) !== expected.digest) fail('release payload digest mismatch: ' + relative);
      if (stageRoot) {
        const destination = path.join(stageRoot, ...relative.split('/'));
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, bytes, { flag: 'wx', mode: expected.mode });
        chmodSync(destination, expected.mode);
      }
      seenFiles.add(relative);
    }
  };
  walk(root, '');

  if (seenFiles.size !== expectedFiles.size || [...expectedFiles.keys()].some((file) => !seenFiles.has(file))) {
    fail('release payload is missing one or more manifest files');
  }
  if (seenDirs.size !== expectedDirs.size || [...expectedDirs].some((dir) => !seenDirs.has(dir))) {
    fail('release payload directory tree is incomplete');
  }

  const packageJsonRoot = stageRoot ?? root;
  const packageJson = JSON.parse(readFileSync(path.join(packageJsonRoot, 'package.json'), 'utf8'));
  if (!packageJson || packageJson.type !== 'module') fail('production package must declare ESM module type');
  return { files: seenFiles.size, directories: seenDirs.size, bytes: totalBytes };
}

function packageNameFromSpecifier(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function stripJavaScriptComments(source) {
  let out = '';
  let index = 0;
  let state = 'code';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { out += '  '; index += 2; state = 'line-comment'; continue; }
      if (char === '/' && next === '*') { out += '  '; index += 2; state = 'block-comment'; continue; }
      if (char === '\'' || char === '"' || char === '`') { out += char; index += 1; state = char; continue; }
      out += char; index += 1; continue;
    }
    if (state === 'line-comment') {
      out += char === '\n' || char === '\r' ? char : ' ';
      index += 1;
      if (char === '\n' || char === '\r') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { out += '  '; index += 2; state = 'code'; continue; }
      out += char === '\n' || char === '\r' ? char : ' ';
      index += 1;
      continue;
    }
    out += char;
    index += 1;
    if (char === '\\') {
      if (index < source.length) { out += source[index]; index += 1; }
      continue;
    }
    if (char === state) state = 'code';
  }
  if (state === 'block-comment') fail('installer runtime contains an unterminated block comment: ' + source);
  return out;
}

function jsSpecifiers(source, relative) {
  const uncommented = stripJavaScriptComments(source);
  if (/\bimport\s*\((?!\s*['"])/u.test(uncommented)
    || /\brequire\s*\((?!\s*['"])/u.test(uncommented)
    || /\bmodule\s*\.\s*require\s*\(/u.test(uncommented)
    || /\bcreateRequire\s*\(/u.test(uncommented)) {
    fail('installer runtime contains an opaque module load that cannot be manifest-bound: ' + relative);
  }
  return [
    ...uncommented.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    ...uncommented.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ...uncommented.matchAll(/\bimport\s+['"]([^'"]+)['"]/gu),
    ...uncommented.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1]);
}

function normalizePackageRelative(value, label) {
  const normalized = path.posix.normalize(value.replace(/^\.\//u, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || normalized.includes('\\')) {
    fail(label + ' resolves outside its package root');
  }
  return normalized;
}

function resolveManifestedImport(fromRelative, specifier, manifestPaths) {
  const base = normalizePackageRelative(path.posix.join(path.posix.dirname(fromRelative), specifier), 'runtime import');
  const ext = path.posix.extname(base);
  const candidates = ext
    ? [base]
    : [base + '.js', base + '.mjs', base + '.cjs', path.posix.join(base, 'index.js'), path.posix.join(base, 'index.mjs'), path.posix.join(base, 'index.cjs')];
  const resolved = candidates.find((candidate) => manifestPaths.has(candidate));
  if (!resolved) fail('installer runtime import is missing from the manifest: ' + specifier + ' declared by ' + fromRelative);
  return resolved;
}

function packageJsonFromRoot(root, packageName) {
  return JSON.parse(readFileSync(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8'));
}

function packageEntryPoint(packageJson, packageName) {
  if (packageName === 'yaml') {
    const dot = packageJson.exports?.['.'];
    return normalizePackageRelative(dot?.node ?? packageJson.main ?? './dist/index.js', 'yaml entrypoint');
  }
  if (packageName === 'zod') {
    const dot = packageJson.exports?.['.'];
    return normalizePackageRelative(dot?.import ?? packageJson.module ?? packageJson.main ?? './index.js', 'zod entrypoint');
  }
  fail('installer runtime imports an unaudited package: ' + packageName);
}

function verifyInstallerRuntimeClosure(root, manifest) {
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  const localSeen = new Set();
  const packageSeen = new Set();
  const importedPackages = new Set();

  const readManifestedJs = (relative) => {
    if (!manifestPaths.has(relative)) fail('installer runtime file is missing from the manifest: ' + relative);
    const absolute = path.join(root, ...relative.split('/'));
    return readFileSync(absolute, 'utf8');
  };

  const visitLocal = (relative) => {
    if (localSeen.has(relative)) return;
    localSeen.add(relative);
    for (const specifier of jsSpecifiers(readManifestedJs(relative), relative)) {
      if (NODE_BUILTINS.has(specifier)) continue;
      if (specifier.startsWith('/')) {
        fail('installer runtime absolute module imports are refused: ' + specifier);
      }
      if (specifier.startsWith('.')) {
        visitLocal(resolveManifestedImport(relative, specifier, manifestPaths));
        continue;
      }
      const pkg = packageNameFromSpecifier(specifier);
      if (!INSTALLER_RUNTIME_PACKAGES.includes(pkg)) {
        fail('installer runtime imports an unaudited package: ' + pkg);
      }
      if (specifier !== pkg) {
        fail('installer runtime imports an unaudited package subpath: ' + specifier);
      }
      importedPackages.add(pkg);
    }
  };

  const visitPackage = (packageName, packageRelative) => {
    const relative = 'node_modules/' + packageName + '/' + packageRelative;
    if (packageSeen.has(relative)) return;
    packageSeen.add(relative);
    for (const specifier of jsSpecifiers(readManifestedJs(relative), relative)) {
      if (NODE_BUILTINS.has(specifier)) continue;
      if (specifier.startsWith('/')) {
        fail('runtime package absolute module imports are refused: ' + specifier);
      }
      if (specifier.startsWith('.')) {
        const inner = resolveManifestedImport(relative, specifier, manifestPaths);
        const prefix = 'node_modules/' + packageName + '/';
        if (!inner.startsWith(prefix)) fail('runtime package import escapes package root: ' + relative);
        visitPackage(packageName, inner.slice(prefix.length));
        continue;
      }
      if (specifier === packageName) {
        visitPackage(packageName, packageEntryPoint(packageJsonFromRoot(root, packageName), packageName));
        continue;
      }
      fail('runtime package imports an external package not admitted into the installer closure: ' + specifier);
    }
  };

  for (const relative of INSTALLER_RUNTIME_MODULES) visitLocal(relative);
  for (const packageName of importedPackages) {
    const packageJsonPath = 'node_modules/' + packageName + '/package.json';
    if (!manifestPaths.has(packageJsonPath)) fail('runtime package metadata is missing from the manifest: ' + packageName);
    const packageJson = packageJsonFromRoot(root, packageName);
    visitPackage(packageName, packageEntryPoint(packageJson, packageName));
  }

  return {
    localFiles: localSeen.size,
    packageFiles: packageSeen.size,
    packages: [...importedPackages].sort(),
  };
}

function verifyBootstrapInputs({ packageRoot, manifestFile, signatureProofFile, trustPolicyFile }) {
  const root = canonicalPackageRoot(packageRoot);
  const manifestPath = canonicalExternalFile(manifestFile, 'release manifest');
  const proofPath = canonicalExternalFile(signatureProofFile, 'release signature proof');
  const trustPath = canonicalExternalFile(trustPolicyFile, 'release trust policy');
  if (isInside(root, manifestPath) || isInside(root, proofPath) || isInside(root, trustPath)) {
    fail('release manifest, signature proof and installer trust policy must remain outside the payload root');
  }

  const manifest = validateManifest(readJson(manifestPath, 'release manifest'));
  const trustPolicy = validateTrustPolicy(readJson(trustPath, 'release trust policy'));
  const proof = validateSignatureProof(readJson(proofPath, 'release signature proof'), manifest);
  const signingIdentity = verifyDetachedSignature(manifest, proof, trustPolicy);
  const payload = verifyClosedPayload(root, manifest);
  const runtimeClosure = verifyInstallerRuntimeClosure(root, manifest);
  return {
    root,
    manifest,
    proof,
    trustPolicy,
    result: {
      schemaVersion: 1,
      status: 'PASS',
      sourceCommit: manifest.sourceCommit,
      manifestDigest: manifest.manifestDigest,
      signingKeyId: signingIdentity.keyId,
      signingKeyFingerprint: signingIdentity.publicKeyFingerprint,
      verifiedFiles: payload.files,
      verifiedBytes: payload.bytes,
      runtimeFiles: runtimeClosure.localFiles + runtimeClosure.packageFiles,
      runtimePackages: runtimeClosure.packages,
    },
  };
}

function stageVerifiedPayload(root, manifest) {
  const staged = mkdtempSync(path.join(os.tmpdir(), 'quarangate-release-bootstrap-'));
  chmodSync(staged, 0o700);
  try {
    verifyClosedPayload(root, manifest, staged);
    // Re-hash the private copy and prove the installer graph before any of its code is loaded.
    verifyClosedPayload(staged, manifest);
    verifyInstallerRuntimeClosure(staged, manifest);
    return staged;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function stageVerifiedMetadata(manifest, proof, trustPolicy) {
  const staged = mkdtempSync(path.join(os.tmpdir(), 'quarangate-release-bootstrap-meta-'));
  chmodSync(staged, 0o700);
  try {
    const files = {
      manifestFile: path.join(staged, 'release-manifest.json'),
      signatureProofFile: path.join(staged, 'release-signature.json'),
      trustPolicyFile: path.join(staged, 'release-trust-policy.json'),
    };
    writeFileSync(files.manifestFile, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    writeFileSync(files.signatureProofFile, JSON.stringify(proof), { flag: 'wx', mode: 0o600 });
    writeFileSync(files.trustPolicyFile, JSON.stringify(trustPolicy), { flag: 'wx', mode: 0o600 });
    return { root: staged, ...files };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

export function verifyBootstrapRelease(input) {
  return verifyBootstrapInputs(input).result;
}

function parseProductionArgs(argv) {
  const command = argv[0];
  const expected = command === 'apply-production' ? 13 : 11;
  if (!['plan-production', 'apply-production'].includes(command)
    || argv.length !== expected
    || argv[1] !== '--answers'
    || argv[3] !== '--package-root'
    || argv[5] !== '--manifest'
    || argv[7] !== '--signature-proof'
    || argv[9] !== '--trust-policy'
    || (command === 'apply-production' && argv[11] !== '--consent')
    || !argv[2] || !argv[4] || !argv[6] || !argv[8] || !argv[10]
    || (command === 'apply-production' && !argv[12])) {
    fail('invalid production bootstrap arguments');
  }
  return {
    command,
    packageRoot: argv[4],
    manifestFile: argv[6],
    signatureProofFile: argv[8],
    trustPolicyFile: argv[10],
  };
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseProductionArgs(argv);
  const verified = verifyBootstrapInputs(parsed);
  const staged = stageVerifiedPayload(verified.root, verified.manifest);
  let metadata;
  try {
    metadata = stageVerifiedMetadata(verified.manifest, verified.proof, verified.trustPolicy);
    const cli = path.join(staged, 'dist', 'installer', 'cli.js');
    const delegatedArgv = [...argv];
    delegatedArgv[4] = staged;
    delegatedArgv[6] = metadata.manifestFile;
    delegatedArgv[8] = metadata.signatureProofFile;
    delegatedArgv[10] = metadata.trustPolicyFile;
    const child = spawnSync(process.execPath, [cli, ...delegatedArgv], {
      cwd: staged,
      stdio: 'inherit',
      timeout: 20 * 60 * 1000,
    });
    if (child.error) throw child.error;
    if (child.signal) fail('production installer CLI terminated by signal ' + child.signal);
    process.exitCode = child.status ?? 1;
  } finally {
    if (metadata) rmSync(metadata.root, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write('INSTALLER_BOOTSTRAP_BLOCKED: ' + (error instanceof Error ? error.message : 'verification failed') + '\n');
    process.exitCode = 1;
  }
}
