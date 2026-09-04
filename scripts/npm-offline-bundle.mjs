#!/usr/bin/env node

import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 1;
export const ALLOWED_HOST = 'registry.npmjs.org';
export const ALLOWED_HOSTS = [`${ALLOWED_HOST}:443`];
export const DEFAULT_IMAGE = 'node:24-alpine';
export const BUNDLE_ENV = 'QUARANGATE_NPM_ARTIFACT_ROOT';
export const PREPARATION_MARKER_ENV = 'QUARANGATE_NPM_PREPARATION_CONTAINER';

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SHA512_HEX = /^[a-f0-9]{128}$/u;
const SHA512_SRI = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;
const TARBALL_NAME = /^sha512-([a-f0-9]{128})\.tgz$/u;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class BundleError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'BundleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new BundleError(code, message);
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function decodeSha512Integrity(integrity, packagePath) {
  if (typeof integrity !== 'string') {
    fail('STOP_LOCK_POLICY', `${packagePath}: missing integrity`);
  }
  const match = SHA512_SRI.exec(integrity);
  if (!match) {
    fail('STOP_LOCK_POLICY', `${packagePath}: integrity must be one canonical sha512 SRI`);
  }
  const encoded = match[1];
  const digest = Buffer.from(encoded, 'base64');
  if (digest.length !== 64 || digest.toString('base64') !== encoded) {
    fail('STOP_LOCK_POLICY', `${packagePath}: malformed sha512 SRI`);
  }
  return { digest, hex: digest.toString('hex') };
}

export function validateResolvedUrl(resolved, packagePath) {
  if (typeof resolved !== 'string') {
    fail('STOP_LOCK_POLICY', `${packagePath}: missing resolved URL`);
  }
  let url;
  try {
    url = new URL(resolved);
  } catch {
    fail('STOP_LOCK_POLICY', `${packagePath}: invalid resolved URL`);
  }
  if (url.protocol !== 'https:') {
    fail('STOP_LOCK_POLICY', `${packagePath}: resolved URL is not HTTPS`);
  }
  if (url.hostname !== ALLOWED_HOST) {
    fail('STOP_LOCK_POLICY', `${packagePath}: hostname ${url.hostname} is not allowed`);
  }
  if ((url.port || '443') !== '443') {
    fail('STOP_LOCK_POLICY', `${packagePath}: effective port is not 443`);
  }
  if (url.username || url.password) {
    fail('STOP_LOCK_POLICY', `${packagePath}: embedded URL credentials are forbidden`);
  }
  if (url.search || url.hash || !url.pathname.endsWith('.tgz') || url.href !== resolved) {
    fail('STOP_LOCK_POLICY', `${packagePath}: resolved URL is not a canonical registry tarball URL`);
  }
  return url;
}

function packageNameFromPath(packagePath, entry) {
  if (typeof entry.name === 'string' && entry.name.length > 0) return entry.name;
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  return index === -1 ? null : packagePath.slice(index + marker.length);
}

export function analyzeLockText(lockText) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    fail('STOP_LOCK_POLICY', 'package-lock.json is not valid JSON');
  }
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    fail('STOP_LOCK_POLICY', 'package-lock.json must use lockfileVersion 3 and contain packages');
  }

  const entries = [];
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (packagePath === '') continue;
    if (!entry || typeof entry !== 'object') fail('STOP_LOCK_POLICY', `${packagePath}: invalid package entry`);
    if (entry.link === true || entry.resolved === undefined) {
      fail('STOP_LOCK_POLICY', `${packagePath}: non-registry package sources are forbidden`);
    }
    const url = validateResolvedUrl(entry.resolved, packagePath);
    const { hex } = decodeSha512Integrity(entry.integrity, packagePath);
    if (typeof entry.version !== 'string' || entry.version.length === 0) {
      fail('STOP_LOCK_POLICY', `${packagePath}: missing version`);
    }
    entries.push({
      packagePath,
      name: packageNameFromPath(packagePath, entry),
      version: entry.version,
      resolved: url.href,
      integrity: entry.integrity,
      digestHex: hex,
      tarball: `tarballs/sha512-${hex}.tgz`,
    });
  }
  entries.sort((a, b) => compareCodePoints(a.packagePath, b.packagePath));
  if (entries.length === 0) fail('STOP_LOCK_POLICY', 'lock contains no resolved package artifacts');
  const digestToUrl = new Map();
  const urlToDigest = new Map();
  for (const entry of entries) {
    const priorUrl = digestToUrl.get(entry.digestHex);
    const priorDigest = urlToDigest.get(entry.resolved);
    if ((priorUrl !== undefined && priorUrl !== entry.resolved) ||
        (priorDigest !== undefined && priorDigest !== entry.digestHex)) {
      fail('STOP_LOCK_POLICY', `${entry.packagePath}: ambiguous URL/integrity mapping`);
    }
    digestToUrl.set(entry.digestHex, entry.resolved);
    urlToDigest.set(entry.resolved, entry.digestHex);
  }
  return {
    lock,
    lockfileVersion: lock.lockfileVersion,
    packageLockSha256: sha256(lockText),
    entries,
    artifactCount: new Set(entries.map((entry) => entry.digestHex)).size,
  };
}

export async function analyzeLockFile(lockfilePath) {
  return analyzeLockText(await fs.readFile(lockfilePath, 'utf8'));
}

function expectedManifestEntry(entry, size) {
  return {
    packagePath: entry.packagePath,
    name: entry.name,
    version: entry.version,
    resolved: entry.resolved,
    integrity: entry.integrity,
    tarball: entry.tarball,
    size,
  };
}

export function createManifest(analysis, sizes) {
  const entries = analysis.entries.map((entry) => {
    const size = sizes.get(entry.digestHex);
    if (!Number.isSafeInteger(size) || size < 1) {
      fail('STOP_BUNDLE_INVALID', `${entry.tarball}: invalid verified byte size`);
    }
    return expectedManifestEntry(entry, size);
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    packageLockSha256: analysis.packageLockSha256,
    packageLockVersion: analysis.lockfileVersion,
    packageEntryCount: analysis.entries.length,
    artifactCount: analysis.artifactCount,
    allowedHosts: ALLOWED_HOSTS,
    entries,
  };
}

export function createDescriptor(manifest, manifestBytes) {
  return {
    schemaVersion: SCHEMA_VERSION,
    packageLockSha256: manifest.packageLockSha256,
    packageLockVersion: manifest.packageLockVersion,
    packageEntryCount: manifest.packageEntryCount,
    artifactCount: manifest.artifactCount,
    manifestSha256: sha256(manifestBytes),
    allowedHosts: ALLOWED_HOSTS,
  };
}

async function lstatRegularFile(filePath, label) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('STOP_BUNDLE_INVALID', `${label} is missing`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('STOP_BUNDLE_INVALID', `${label} must be a regular non-symlink file`);
  }
  if (stat.nlink !== 1) fail('STOP_BUNDLE_INVALID', `${label} must not be hard-linked`);
  return stat;
}

async function lstatDirectory(directoryPath, label) {
  let stat;
  try {
    stat = await fs.lstat(directoryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('STOP_BUNDLE_INVALID', `${label} is missing`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('STOP_BUNDLE_INVALID', `${label} must be a non-symlink directory`);
  }
  return stat;
}

async function readRegularFileNoFollow(filePath, label) {
  await lstatRegularFile(filePath, label);
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) fail('STOP_BUNDLE_INVALID', `${label} changed type while opening`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail('STOP_BUNDLE_INVALID', `${label} changed while being read`);
    }
    return bytes;
  } catch (error) {
    if (error?.code === 'ELOOP') fail('STOP_BUNDLE_INVALID', `${label} is a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function assertExactKeys(object, expected, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    fail('STOP_BUNDLE_INVALID', `${label} must be an object`);
  }
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail('STOP_BUNDLE_INVALID', `${label} has unexpected or missing fields`);
  }
}

function assertSameJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('STOP_BUNDLE_INVALID', `${label} does not match the canonical lock-derived value`);
  }
}

function parseCanonicalJson(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('STOP_BUNDLE_INVALID', `${label} is not valid JSON`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(parsed)))) {
    fail('STOP_BUNDLE_INVALID', `${label} is not canonical JSON`);
  }
  return parsed;
}

async function listExact(directoryPath, expectedNames, label) {
  const dirents = await fs.readdir(directoryPath, { withFileTypes: true });
  const actualNames = dirents.map((entry) => entry.name).sort();
  const wanted = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(wanted)) {
    fail('STOP_BUNDLE_INVALID', `${label} contains unexpected or missing entries`);
  }
  return dirents;
}

export async function verifyBundle({ bundlePath, lockfilePath, descriptorPath = null }) {
  const analysis = await analyzeLockFile(lockfilePath);
  await lstatDirectory(bundlePath, 'bundle directory');
  await listExact(bundlePath, ['manifest.json', 'tarballs'], 'bundle directory');
  const tarballsPath = path.join(bundlePath, 'tarballs');
  await lstatDirectory(tarballsPath, 'tarballs directory');

  const manifestPath = path.join(bundlePath, 'manifest.json');
  const manifestBytes = await readRegularFileNoFollow(manifestPath, 'manifest.json');
  const manifest = parseCanonicalJson(manifestBytes, 'manifest.json');
  assertExactKeys(manifest, [
    'schemaVersion', 'packageLockSha256', 'packageLockVersion', 'packageEntryCount',
    'artifactCount', 'allowedHosts', 'entries',
  ], 'manifest.json');
  if (!Array.isArray(manifest.entries)) fail('STOP_BUNDLE_INVALID', 'manifest entries must be an array');

  const manifestTarballs = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    assertExactKeys(entry, ['packagePath', 'name', 'version', 'resolved', 'integrity', 'tarball', 'size'], `manifest entry ${index}`);
    if (typeof entry.tarball !== 'string' || !TARBALL_NAME.test(path.posix.basename(entry.tarball)) ||
        entry.tarball !== `tarballs/${path.posix.basename(entry.tarball)}`) {
      fail('STOP_BUNDLE_INVALID', `manifest entry ${index} has an unsafe tarball path`);
    }
    manifestTarballs.add(path.posix.basename(entry.tarball));
  }

  const actualTarballDirents = await fs.readdir(tarballsPath, { withFileTypes: true });
  const actualTarballs = actualTarballDirents.map((entry) => entry.name).sort();
  const expectedTarballs = [...new Set(analysis.entries.map((entry) => path.posix.basename(entry.tarball)))].sort();
  if (JSON.stringify(actualTarballs) !== JSON.stringify(expectedTarballs)) {
    fail('STOP_BUNDLE_INVALID', 'tarballs directory contains unexpected or missing artifacts');
  }
  if (manifestTarballs.size !== expectedTarballs.length) {
    fail('STOP_BUNDLE_INVALID', 'manifest artifact set is inconsistent');
  }

  const sizes = new Map();
  let totalBytes = 0;
  for (const filename of expectedTarballs) {
    const match = TARBALL_NAME.exec(filename);
    if (!match || !SHA512_HEX.test(match[1])) fail('STOP_BUNDLE_INVALID', `${filename}: invalid artifact filename`);
    const bytes = await readRegularFileNoFollow(path.join(tarballsPath, filename), filename);
    if (bytes.length < 1 || bytes.length > MAX_ARTIFACT_BYTES) {
      fail('STOP_BUNDLE_INVALID', `${filename}: artifact byte size is out of bounds`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_BUNDLE_BYTES) fail('STOP_BUNDLE_INVALID', 'bundle byte size exceeds limit');
    const actualHex = createHash('sha512').update(bytes).digest('hex');
    if (!timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(match[1], 'hex'))) {
      fail('STOP_BUNDLE_INVALID', `${filename}: SHA-512 mismatch`);
    }
    sizes.set(actualHex, bytes.length);
  }

  const expectedManifest = createManifest(analysis, sizes);
  assertSameJson(manifest, expectedManifest, 'manifest.json');
  const expectedDescriptor = createDescriptor(expectedManifest, manifestBytes);

  if (descriptorPath !== null) {
    const descriptorBytes = await readRegularFileNoFollow(descriptorPath, 'bundle descriptor');
    const descriptor = parseCanonicalJson(descriptorBytes, 'bundle descriptor');
    assertExactKeys(descriptor, [
      'schemaVersion', 'packageLockSha256', 'packageLockVersion', 'packageEntryCount',
      'artifactCount', 'manifestSha256', 'allowedHosts',
    ], 'bundle descriptor');
    if (!SHA256_HEX.test(descriptor.packageLockSha256) || !SHA256_HEX.test(descriptor.manifestSha256)) {
      fail('STOP_BUNDLE_INVALID', 'bundle descriptor contains an invalid SHA-256 value');
    }
    assertSameJson(descriptor, expectedDescriptor, 'bundle descriptor');
  }

  return {
    packageLockSha256: analysis.packageLockSha256,
    packageEntryCount: analysis.entries.length,
    artifactCount: expectedTarballs.length,
    manifestSha256: expectedDescriptor.manifestSha256,
    totalFiles: 2 + expectedTarballs.length,
    totalBytes: manifestBytes.length + totalBytes,
    bundlePath,
  };
}

export function assertAcceptedResponseStatus(statusCode) {
  if (statusCode >= 300 && statusCode < 400) {
    fail('STOP_PREPARATION_REDIRECT', `registry returned HTTP ${statusCode}; redirects are forbidden`);
  }
  if (statusCode !== 200) {
    fail('STOP_PREPARATION_HTTP', `registry returned HTTP ${statusCode}`);
  }
}

export async function downloadArtifact(urlString, temporaryPath, expectedDigest) {
  const url = validateResolvedUrl(urlString, 'download');
  await fs.mkdir(path.dirname(temporaryPath), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
      timeout: REQUEST_TIMEOUT_MS,
    }, async (response) => {
      let handle;
      try {
        assertAcceptedResponseStatus(response.statusCode ?? 0);
        if (response.headers['content-encoding'] !== undefined) {
          fail('STOP_PREPARATION_ENCODING', 'encoded registry responses are forbidden');
        }
        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
          fail('STOP_PREPARATION_SIZE', 'artifact exceeds the per-file byte limit');
        }
        handle = await fs.open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        const hash = createHash('sha512');
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > MAX_ARTIFACT_BYTES) fail('STOP_PREPARATION_SIZE', 'artifact exceeds the per-file byte limit');
          hash.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
        await handle.close();
        handle = null;
        if (size < 1) fail('STOP_PREPARATION_SIZE', 'artifact is empty');
        const actualDigest = hash.digest();
        if (!timingSafeEqual(actualDigest, expectedDigest)) {
          fail('STOP_PREPARATION_HASH_MISMATCH', 'downloaded artifact SHA-512 does not match package-lock.json');
        }
        resolve(size);
      } catch (error) {
        response.destroy();
        await handle?.close().catch(() => {});
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        reject(error);
      }
    });
    request.on('timeout', () => request.destroy(new BundleError('STOP_PREPARATION_TIMEOUT', 'registry request timed out')));
    request.on('error', async (error) => {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      reject(error);
    });
    request.end();
  });
}

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function prepareBundle({ lockfilePath, packageJsonPath, artifactRoot, download = downloadArtifact }) {
  // Complete policy validation happens before the first possible downloader call.
  const analysis = await analyzeLockFile(lockfilePath);
  const packageJsonBytes = await readRegularFileNoFollow(packageJsonPath, 'package.json');
  try {
    JSON.parse(packageJsonBytes.toString('utf8'));
  } catch {
    fail('STOP_LOCK_POLICY', 'package.json is not valid JSON');
  }

  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await lstatDirectory(artifactRoot, 'artifact root');
  const bundlePath = path.join(artifactRoot, analysis.packageLockSha256);
  if (await pathExists(bundlePath)) {
    const verified = await verifyBundle({ bundlePath, lockfilePath });
    return { ...verified, reusedExisting: true };
  }

  const stagingPath = await fs.mkdtemp(path.join(artifactRoot, `.${analysis.packageLockSha256}.preparing-`));
  const tarballsPath = path.join(stagingPath, 'tarballs');
  const sizes = new Map();
  let totalBytes = 0;
  try {
    await fs.mkdir(tarballsPath, { mode: 0o700 });
    const unique = new Map();
    for (const entry of analysis.entries) {
      if (!unique.has(entry.digestHex)) unique.set(entry.digestHex, entry);
    }
    for (const entry of [...unique.values()].sort((a, b) => compareCodePoints(a.digestHex, b.digestHex))) {
      const filename = path.basename(entry.tarball);
      if (!TARBALL_NAME.test(filename)) fail('STOP_BUNDLE_INVALID', 'derived artifact filename is invalid');
      const temporaryPath = path.join(tarballsPath, `.${filename}.partial`);
      const acceptedPath = path.join(tarballsPath, filename);
      const { digest } = decodeSha512Integrity(entry.integrity, entry.packagePath);
      const size = await download(entry.resolved, temporaryPath, digest);
      if (!Number.isSafeInteger(size) || size < 1) fail('STOP_PREPARATION_SIZE', `${filename}: invalid downloaded size`);
      totalBytes += size;
      if (totalBytes > MAX_BUNDLE_BYTES) fail('STOP_PREPARATION_SIZE', 'bundle byte size exceeds limit');
      await fs.rename(temporaryPath, acceptedPath);
      sizes.set(entry.digestHex, size);
    }
    const manifest = createManifest(analysis, sizes);
    await fs.writeFile(path.join(stagingPath, 'manifest.json'), canonicalJson(manifest), { flag: 'wx', mode: 0o600 });
    await verifyBundle({ bundlePath: stagingPath, lockfilePath });
    if (await pathExists(bundlePath)) fail('STOP_BUNDLE_EXISTS', 'bundle appeared during preparation; refusing overwrite');
    await fs.rename(stagingPath, bundlePath);
    const verified = await verifyBundle({ bundlePath, lockfilePath });
    return { ...verified, reusedExisting: false };
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function materializeVerifiedArtifacts({ bundlePath, lockfilePath, descriptorPath, destination }) {
  const verified = await verifyBundle({ bundlePath, lockfilePath, descriptorPath });
  if (await pathExists(destination)) fail('STOP_MATERIALIZE_EXISTS', 'materialization destination already exists');
  await fs.mkdir(destination, { mode: 0o700 });
  try {
    const analysis = await analyzeLockFile(lockfilePath);
    const filenames = [...new Set(analysis.entries.map((entry) => path.basename(entry.tarball)))].sort(compareCodePoints);
    for (const filename of filenames) {
      const source = path.join(bundlePath, 'tarballs', filename);
      const bytes = await readRegularFileNoFollow(source, filename);
      const expectedHex = TARBALL_NAME.exec(filename)?.[1];
      const actualHex = createHash('sha512').update(bytes).digest('hex');
      if (!expectedHex || actualHex !== expectedHex) fail('STOP_BUNDLE_INVALID', `${filename}: changed before materialization`);
      await fs.writeFile(path.join(destination, filename), bytes, { flag: 'wx', mode: 0o400 });
    }
    await listExact(destination, filenames, 'materialized artifact directory');
    return { ...verified, materializedArtifactCount: filenames.length, destination };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  const booleanFlags = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith('--')) fail('USAGE', `unexpected argument: ${token ?? ''}`);
    if (token === '--json') {
      if (booleanFlags.has(token)) fail('USAGE', `duplicate argument: ${token}`);
      booleanFlags.add(token);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) fail('USAGE', `${token} requires a value`);
    if (values.has(token)) fail('USAGE', `duplicate argument: ${token}`);
    values.set(token, value);
    index += 1;
  }
  return { command, values, json: booleanFlags.has('--json') };
}

function option(values, name, fallback = undefined) {
  return values.has(name) ? values.get(name) : fallback;
}

function assertAllowedOptions(values, allowed) {
  for (const key of values.keys()) {
    if (!allowed.has(key)) fail('USAGE', `unsupported option: ${key}`);
  }
}

function requiredArtifactRoot(values) {
  const supplied = option(values, '--artifact-root', process.env[BUNDLE_ENV]);
  if (!supplied) fail('USAGE', `supply --artifact-root or ${BUNDLE_ENV}`);
  return path.resolve(supplied);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new BundleError('STOP_COMMAND_FAILED', `${command} exited with ${code ?? signal}`));
    });
  });
}

async function inspectImageId(image) {
  let output = '';
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { shell: false });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.pipe(process.stderr);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new BundleError('STOP_LOCAL_BASE_IMAGE_MISSING', `${image} is not available locally`)));
  });
  return output.trim();
}

async function hostPrepare(values, jsonOutput) {
  assertAllowedOptions(values, new Set(['--artifact-root', '--lockfile', '--package-json']));
  const artifactRoot = requiredArtifactRoot(values);
  const lockfilePath = path.resolve(option(values, '--lockfile', 'package-lock.json'));
  const packageJsonPath = path.resolve(option(values, '--package-json', 'package.json'));
  const scriptPath = path.resolve(process.argv[1]);
  const analysis = await analyzeLockFile(lockfilePath);
  await readRegularFileNoFollow(packageJsonPath, 'package.json');
  await readRegularFileNoFollow(scriptPath, 'npm-offline-bundle.mjs');
  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const bundlePath = path.join(artifactRoot, analysis.packageLockSha256);
  if (await pathExists(bundlePath)) {
    const verified = await verifyBundle({ bundlePath, lockfilePath });
    const result = { ...verified, reusedExisting: true, networkEgressUsed: false };
    process.stdout.write(jsonOutput ? canonicalJson(result) : `BUNDLE_REUSED ${bundlePath}\n`);
    return;
  }

  const imageId = await inspectImageId(DEFAULT_IMAGE);
  const containerName = `quarangate-npm-offline-preparation-${process.pid}-${Date.now()}`;
  const mounts = [
    { source: packageJsonPath, target: '/inputs/package.json', readOnly: true },
    { source: lockfilePath, target: '/inputs/package-lock.json', readOnly: true },
    { source: scriptPath, target: '/tool/npm-offline-bundle.mjs', readOnly: true },
    { source: artifactRoot, target: '/output', readOnly: false },
  ];
  const record = {
    event: 'PREPARATION_CONTAINER_POLICY',
    image: DEFAULT_IMAGE,
    imageId,
    networkMode: 'bridge',
    pull: 'never',
    readOnlyRoot: true,
    user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    capDrop: ['ALL'],
    noNewPrivileges: true,
    explicitEnvironmentVariableNames: [PREPARATION_MARKER_ENV],
    allowedHosts: ALLOWED_HOSTS,
    mounts,
    dockerSocket: false,
  };
  process.stdout.write(canonicalJson(record));
  const dockerArgs = [
    'run', '--rm', '--name', containerName, '--pull=never', '--network=bridge',
    '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true',
    '--entrypoint', '/usr/local/bin/node',
    '--user', record.user,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m',
    '--pids-limit', '128', '--memory', '768m', '--cpus', '2',
    '--env', `${PREPARATION_MARKER_ENV}=1`,
  ];
  for (const mount of mounts) {
    dockerArgs.push('--mount', `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ',readonly' : ''}`);
  }
  dockerArgs.push(imageId, '/tool/npm-offline-bundle.mjs', '_prepare-worker',
    '--artifact-root', '/output', '--lockfile', '/inputs/package-lock.json', '--package-json', '/inputs/package.json', '--json');
  await run('docker', dockerArgs);
}

async function main(argv = process.argv.slice(2)) {
  const { command, values, json } = parseArguments(argv);
  const defaultLock = path.resolve('package-lock.json');
  if (command === 'prepare') {
    await hostPrepare(values, json);
    return;
  }
  if (command === '_prepare-worker') {
    if (process.env[PREPARATION_MARKER_ENV] !== '1') {
      fail('STOP_PREPARATION_CONTEXT', 'internal worker may run only in the controlled preparation container');
    }
    assertAllowedOptions(values, new Set(['--artifact-root', '--lockfile', '--package-json']));
    const result = await prepareBundle({
      artifactRoot: requiredArtifactRoot(values),
      lockfilePath: path.resolve(option(values, '--lockfile', defaultLock)),
      packageJsonPath: path.resolve(option(values, '--package-json', 'package.json')),
    });
    process.stdout.write(canonicalJson({ ...result, networkEgressUsed: !result.reusedExisting }));
    return;
  }
  if (command === 'print-path') {
    assertAllowedOptions(values, new Set(['--artifact-root', '--lockfile']));
    const analysis = await analyzeLockFile(path.resolve(option(values, '--lockfile', defaultLock)));
    process.stdout.write(`${path.join(requiredArtifactRoot(values), analysis.packageLockSha256)}\n`);
    return;
  }
  if (command === 'verify' || command === 'descriptor' || command === 'materialize') {
    assertAllowedOptions(values, new Set(['--artifact-root', '--bundle', '--lockfile', '--descriptor', '--destination']));
    const lockfilePath = path.resolve(option(values, '--lockfile', defaultLock));
    const analysis = await analyzeLockFile(lockfilePath);
    const bundlePath = option(values, '--bundle')
      ? path.resolve(option(values, '--bundle'))
      : path.join(requiredArtifactRoot(values), analysis.packageLockSha256);
    if (command === 'descriptor') {
      const verified = await verifyBundle({ bundlePath, lockfilePath });
      const manifestBytes = await readRegularFileNoFollow(path.join(bundlePath, 'manifest.json'), 'manifest.json');
      const manifest = parseCanonicalJson(manifestBytes, 'manifest.json');
      process.stdout.write(canonicalJson(createDescriptor(manifest, manifestBytes)));
      return;
    }
    const descriptorPath = path.resolve(option(values, '--descriptor', 'build/npm-dependencies.json'));
    if (command === 'materialize') {
      const destination = option(values, '--destination');
      if (!destination) fail('USAGE', 'materialize requires --destination');
      const result = await materializeVerifiedArtifacts({
        bundlePath, lockfilePath, descriptorPath, destination: path.resolve(destination),
      });
      process.stdout.write(json ? canonicalJson(result) : `BUNDLE_MATERIALIZE_PASS ${result.destination}\n`);
      return;
    }
    const result = await verifyBundle({ bundlePath, lockfilePath, descriptorPath });
    process.stdout.write(json ? canonicalJson(result) : `BUNDLE_VERIFY_PASS ${bundlePath}\n`);
    return;
  }
  fail('USAGE', 'usage: npm-offline-bundle.mjs <prepare|verify|print-path|descriptor|materialize> [options]');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
