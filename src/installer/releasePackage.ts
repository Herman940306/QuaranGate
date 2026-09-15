import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { canonicalSerialize } from '../executor/agents/canonicalJson.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|private[-_]?keys?)(?:\/|$)/iu;

export type ReleaseSigningState =
  | 'SIGNED'
  | 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL'
  | 'NOT_YET_RELEASE_GATE';

export interface ReleasePackageFile {
  path: string;
  sizeBytes: number;
  digest: string;
  mode: 0o644 | 0o755;
}

export interface ReleasePackageImage {
  component: string;
  reference: string;
  digest: string;
}

export interface ReleasePackageManifest {
  schemaVersion: 1;
  productVersion: string;
  sourceCommit: string;
  createdAt: string;
  architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE';
  signing: ReleaseSigningState;
  files: ReleasePackageFile[];
  images: ReleasePackageImage[];
  manifestDigest: string;
}

export class ReleasePackageError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ReleasePackageError';
  }
}

function hash(value: Buffer | unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : canonicalSerialize(value);
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactKeys(value: object, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ReleasePackageError('PACKAGE_SCHEMA_INVALID', `${label} contains unknown or missing fields`);
  }
}

function validateFile(file: ReleasePackageFile): void {
  assertExactKeys(file, ['path', 'sizeBytes', 'digest', 'mode'], 'Package file');
  const normalized = path.posix.normalize(file.path);
  if (!file.path || normalized !== file.path || path.posix.isAbsolute(file.path)
    || file.path.includes('\\') || file.path.split('/').includes('..') || normalized === '.') {
    throw new ReleasePackageError('PACKAGE_PATH_INVALID', `Package file path is unsafe: ${file.path}`);
  }
  if (SECRET_PATH.test(file.path)) {
    throw new ReleasePackageError('PACKAGE_SECRET_PATH_REFUSED', `Package secret/credential path is refused: ${file.path}`);
  }
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !SHA256.test(file.digest)
    || ![0o644, 0o755].includes(file.mode)) {
    throw new ReleasePackageError('PACKAGE_FILE_INVALID', `Package file identity is invalid: ${file.path}`);
  }
}

function validateImage(image: ReleasePackageImage): void {
  assertExactKeys(image, ['component', 'reference', 'digest'], 'Package image');
  if (!SAFE_ID.test(image.component) || !image.reference || /(?:^|:)latest$/iu.test(image.reference)) {
    throw new ReleasePackageError('PACKAGE_IMAGE_MUTABLE', 'Package image reference is invalid or mutable');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(image.digest)) {
    throw new ReleasePackageError('PACKAGE_IMAGE_INVALID', 'Package image digest is invalid');
  }
}

function manifestIdentity(manifest: ReleasePackageManifest): Omit<ReleasePackageManifest, 'manifestDigest'> {
  const { manifestDigest: _manifestDigest, ...identity } = manifest;
  return identity;
}

function validateIdentity(
  identity: Omit<ReleasePackageManifest, 'manifestDigest'>,
): Omit<ReleasePackageManifest, 'manifestDigest'> {
  if (identity.schemaVersion !== 1
    || !SEMVER.test(identity.productVersion)
    || !GIT_COMMIT.test(identity.sourceCommit)
    || !Number.isFinite(Date.parse(identity.createdAt))
    || identity.architecture !== 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE'
    || !['SIGNED', 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL', 'NOT_YET_RELEASE_GATE'].includes(identity.signing)) {
    throw new ReleasePackageError('PACKAGE_IDENTITY_INVALID', 'Release package identity is invalid');
  }
  if (identity.files.length === 0) throw new ReleasePackageError('PACKAGE_FILES_EMPTY', 'Release package has no payload files');
  for (const file of identity.files) validateFile(file);
  const filePaths = identity.files.map((file) => file.path);
  if (filePaths.some((value, index) => index > 0 && (filePaths[index - 1] ?? '') >= value)) {
    throw new ReleasePackageError('PACKAGE_FILES_UNSORTED', 'Package files must be sorted and unique');
  }
  if (identity.images.length === 0) throw new ReleasePackageError('PACKAGE_IMAGES_EMPTY', 'Release package has no OCI image identities');
  for (const image of identity.images) validateImage(image);
  const components = identity.images.map((image) => image.component);
  if (components.some((value, index) => index > 0 && (components[index - 1] ?? '') >= value)) {
    throw new ReleasePackageError('PACKAGE_IMAGES_UNSORTED', 'Package image identities must be sorted and unique');
  }
  return identity;
}

export function createReleasePackageManifest(
  identityInput: Omit<ReleasePackageManifest, 'manifestDigest'>,
): ReleasePackageManifest {
  const identity = validateIdentity(identityInput);
  return { ...identity, manifestDigest: hash(identity) };
}

export function verifyReleasePackageManifest(value: ReleasePackageManifest): ReleasePackageManifest {
  assertExactKeys(value, [
    'schemaVersion', 'productVersion', 'sourceCommit', 'createdAt',
    'architecture', 'signing', 'files', 'images', 'manifestDigest',
  ], 'Release package manifest');
  const identity = validateIdentity(manifestIdentity(value));
  if (!SHA256.test(value.manifestDigest)) {
    throw new ReleasePackageError('PACKAGE_MANIFEST_DIGEST_INVALID', 'Release package manifest digest is invalid');
  }
  const expected = Buffer.from(hash(identity), 'hex');
  const actual = Buffer.from(value.manifestDigest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ReleasePackageError('PACKAGE_MANIFEST_DIGEST_MISMATCH', 'Release package manifest digest does not match its content');
  }
  return value;
}

export function verifyReleasePayload(
  manifestInput: ReleasePackageManifest,
  read: (relativePath: string) => Buffer,
): { manifestDigest: string; verifiedFiles: number; verifiedBytes: number } {
  const manifest = verifyReleasePackageManifest(manifestInput);
  let verifiedBytes = 0;
  for (const file of manifest.files) {
    const bytes = read(file.path);
    const actualDigest = hash(bytes);
    if (bytes.length !== file.sizeBytes || actualDigest !== file.digest) {
      throw new ReleasePackageError('PACKAGE_PAYLOAD_INTEGRITY_FAILED', `Package payload integrity failed for ${file.path}`);
    }
    verifiedBytes += bytes.length;
  }
  return {
    manifestDigest: manifest.manifestDigest,
    verifiedFiles: manifest.files.length,
    verifiedBytes,
  };
}
