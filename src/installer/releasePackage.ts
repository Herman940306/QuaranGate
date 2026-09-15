import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifyCryptographicSignature,
} from 'node:crypto';
import path from 'node:path';
import { canonicalSerialize } from '../executor/agents/canonicalJson.js';
import type { MigrationRecord } from '../lifecycle/manifest.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|private[-_]?keys?)(?:\/|$)/iu;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type ReleaseSigningState =
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

export interface ReleaseLifecycleContract {
  configSchemaVersion: number;
  stateSchemaVersion: number;
  components: string[];
  migrations: MigrationRecord[];
}

export interface ReleasePackageManifest {
  schemaVersion: 1;
  productVersion: string;
  sourceCommit: string;
  createdAt: string;
  architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE';
  signing: ReleaseSigningState;
  lifecycle: ReleaseLifecycleContract;
  files: ReleasePackageFile[];
  images: ReleasePackageImage[];
  manifestDigest: string;
}

export interface ReleaseSignatureProof {
  schemaVersion: 1;
  algorithm: 'Ed25519';
  keyId: string;
  manifestDigest: string;
  signedAt: string;
  signature: string;
}

export interface TrustedReleaseKey {
  keyId: string;
  algorithm: 'Ed25519';
  publicKeyPem: string;
}

export interface VerifiedReleasePackage {
  manifest: ReleasePackageManifest;
  signingIdentity: {
    keyId: string;
    algorithm: 'Ed25519';
    publicKeyFingerprint: string;
    signedAt: string;
  };
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

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleasePackageError('PACKAGE_SCHEMA_INVALID', `${label} must be an object`);
  }
}

function assertExactKeys(value: unknown, keys: string[], label: string): void {
  assertPlainObject(value, label);
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

function validateLifecycleContract(
  lifecycle: ReleaseLifecycleContract,
  files: ReleasePackageFile[],
): void {
  assertExactKeys(lifecycle, ['configSchemaVersion', 'stateSchemaVersion', 'components', 'migrations'], 'Release lifecycle contract');
  if (!Number.isInteger(lifecycle.configSchemaVersion) || lifecycle.configSchemaVersion < 0
    || !Number.isInteger(lifecycle.stateSchemaVersion) || lifecycle.stateSchemaVersion < 0
    || !Array.isArray(lifecycle.components) || lifecycle.components.length === 0
    || lifecycle.components.some((component) => !SAFE_ID.test(component))
    || lifecycle.components.some((component, index) => index > 0 && lifecycle.components[index - 1]! >= component)
    || !Array.isArray(lifecycle.migrations)) {
    throw new ReleasePackageError('PACKAGE_LIFECYCLE_INVALID', 'Release lifecycle identity is invalid');
  }
  for (const migration of lifecycle.migrations) {
    assertExactKeys(migration, ['id', 'kind', 'fromVersion', 'toVersion', 'digest'], 'Release migration');
    if (!SAFE_ID.test(migration.id) || !['CONFIG', 'STATE'].includes(migration.kind)
      || !Number.isInteger(migration.fromVersion) || migration.fromVersion < 0
      || migration.toVersion !== migration.fromVersion + 1 || !SHA256.test(migration.digest)) {
      throw new ReleasePackageError('PACKAGE_MIGRATION_INVALID', 'Release migration identity is invalid');
    }
    const artifact = `migrations/${migration.kind.toLowerCase()}/${migration.id}.json`;
    const file = files.find((candidate) => candidate.path === artifact);
    if (!file || file.digest !== migration.digest) {
      throw new ReleasePackageError('PACKAGE_MIGRATION_UNBOUND', 'Release migration is not bound to an exact package artifact');
    }
  }
  const keys = lifecycle.migrations.map((migration) =>
    `${migration.kind}:${String(migration.fromVersion).padStart(8, '0')}:${migration.id}`);
  if (keys.some((key, index) => index > 0 && keys[index - 1]! >= key)) {
    throw new ReleasePackageError('PACKAGE_MIGRATION_INVALID', 'Release migrations must be sorted and unique');
  }
  for (const [kind, version] of [
    ['CONFIG', lifecycle.configSchemaVersion],
    ['STATE', lifecycle.stateSchemaVersion],
  ] as const) {
    const records = lifecycle.migrations.filter((migration) => migration.kind === kind);
    if (records.length !== version || records.some((record, index) =>
      record.fromVersion !== index || record.toVersion !== index + 1)) {
      throw new ReleasePackageError('PACKAGE_MIGRATION_HISTORY_INVALID', `${kind} release migration history is incomplete`);
    }
  }
}

function manifestIdentity(manifest: ReleasePackageManifest): Omit<ReleasePackageManifest, 'manifestDigest'> {
  const { manifestDigest: _manifestDigest, ...identity } = manifest;
  return identity;
}

function validateIdentity(
  identity: Omit<ReleasePackageManifest, 'manifestDigest'>,
): Omit<ReleasePackageManifest, 'manifestDigest'> {
  assertExactKeys(identity, [
    'schemaVersion', 'productVersion', 'sourceCommit', 'createdAt',
    'architecture', 'signing', 'lifecycle', 'files', 'images',
  ], 'Release package identity');
  if (identity.schemaVersion !== 1
    || !SEMVER.test(identity.productVersion)
    || !GIT_COMMIT.test(identity.sourceCommit)
    || !Number.isFinite(Date.parse(identity.createdAt))
    || identity.architecture !== 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE'
    || !['DEFERRED_EXTERNAL_OWNER_CREDENTIAL', 'NOT_YET_RELEASE_GATE'].includes(identity.signing)) {
    throw new ReleasePackageError(
      'PACKAGE_IDENTITY_INVALID',
      'Release package identity or signing state is invalid; SIGNED cannot be self-asserted',
    );
  }
  if (!Array.isArray(identity.files) || identity.files.length === 0) {
    throw new ReleasePackageError('PACKAGE_FILES_EMPTY', 'Release package has no payload files');
  }
  for (const file of identity.files) validateFile(file);
  const filePaths = identity.files.map((file) => file.path);
  if (filePaths.some((value, index) => index > 0 && (filePaths[index - 1] ?? '') >= value)) {
    throw new ReleasePackageError('PACKAGE_FILES_UNSORTED', 'Package files must be sorted and unique');
  }
  validateLifecycleContract(identity.lifecycle, identity.files);
  if (!Array.isArray(identity.images) || identity.images.length === 0) {
    throw new ReleasePackageError('PACKAGE_IMAGES_EMPTY', 'Release package has no OCI image identities');
  }
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
    'architecture', 'signing', 'lifecycle', 'files', 'images', 'manifestDigest',
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

export function releaseSignaturePayload(manifestInput: ReleasePackageManifest): Buffer {
  const manifest = verifyReleasePackageManifest(manifestInput);
  return Buffer.from(canonicalSerialize({
    schemaVersion: 1,
    purpose: 'QUARANGATE_RELEASE_MANIFEST',
    manifestDigest: manifest.manifestDigest,
    productVersion: manifest.productVersion,
    sourceCommit: manifest.sourceCommit,
    createdAt: manifest.createdAt,
  }));
}

function parseProof(value: unknown): ReleaseSignatureProof {
  assertExactKeys(value, [
    'schemaVersion', 'algorithm', 'keyId', 'manifestDigest', 'signedAt', 'signature',
  ], 'Release signature proof');
  const proof = value as unknown as ReleaseSignatureProof;
  if (proof.schemaVersion !== 1 || proof.algorithm !== 'Ed25519' || !SAFE_ID.test(proof.keyId)
    || !SHA256.test(proof.manifestDigest) || !Number.isFinite(Date.parse(proof.signedAt))
    || typeof proof.signature !== 'string' || proof.signature.length === 0
    || proof.signature.length > 512 || !BASE64.test(proof.signature)) {
    throw new ReleasePackageError('PACKAGE_SIGNATURE_PROOF_INVALID', 'Release signature proof is malformed');
  }
  const signature = Buffer.from(proof.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== proof.signature) {
    throw new ReleasePackageError('PACKAGE_SIGNATURE_PROOF_INVALID', 'Release signature encoding is invalid');
  }
  return proof;
}

function parseTrustedKey(value: unknown): TrustedReleaseKey {
  assertExactKeys(value, ['keyId', 'algorithm', 'publicKeyPem'], 'Trusted release key');
  const key = value as unknown as TrustedReleaseKey;
  if (!SAFE_ID.test(key.keyId) || key.algorithm !== 'Ed25519'
    || typeof key.publicKeyPem !== 'string' || key.publicKeyPem.length > 4096) {
    throw new ReleasePackageError('TRUSTED_RELEASE_KEY_INVALID', 'Trusted release key is malformed');
  }
  return key;
}

export function verifyReleaseSignature(
  manifestInput: ReleasePackageManifest,
  proofInput: ReleaseSignatureProof,
  trustedKeyInputs: TrustedReleaseKey[],
): VerifiedReleasePackage {
  const manifest = verifyReleasePackageManifest(manifestInput);
  const proof = parseProof(proofInput);
  if (proof.manifestDigest !== manifest.manifestDigest) {
    throw new ReleasePackageError('PACKAGE_SIGNATURE_MANIFEST_MISMATCH', 'Signature proof names a different manifest digest');
  }
  if (Date.parse(proof.signedAt) < Date.parse(manifest.createdAt)) {
    throw new ReleasePackageError('PACKAGE_SIGNATURE_TIME_INVALID', 'Signature predates the release package');
  }
  if (!Array.isArray(trustedKeyInputs) || trustedKeyInputs.length === 0) {
    throw new ReleasePackageError('TRUSTED_RELEASE_KEY_MISSING', 'No trusted release signing identity is configured');
  }
  const trustedKeys = trustedKeyInputs.map(parseTrustedKey);
  if (new Set(trustedKeys.map((key) => key.keyId)).size !== trustedKeys.length) {
    throw new ReleasePackageError('TRUSTED_RELEASE_KEY_DUPLICATE', 'Trusted release key identities must be unique');
  }
  const trusted = trustedKeys.find((key) => key.keyId === proof.keyId);
  if (!trusted) {
    throw new ReleasePackageError('SIGNING_IDENTITY_UNTRUSTED', 'Release signing identity is not trusted');
  }

  let publicKey;
  try {
    publicKey = createPublicKey(trusted.publicKeyPem);
  } catch {
    throw new ReleasePackageError('TRUSTED_RELEASE_KEY_INVALID', 'Trusted release public key cannot be parsed');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new ReleasePackageError('TRUSTED_RELEASE_KEY_INVALID', 'Trusted release key is not Ed25519');
  }
  const signature = Buffer.from(proof.signature, 'base64');
  if (!verifyCryptographicSignature(null, releaseSignaturePayload(manifest), publicKey, signature)) {
    throw new ReleasePackageError('PACKAGE_SIGNATURE_INVALID', 'Release signature verification failed');
  }
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    manifest,
    signingIdentity: {
      keyId: trusted.keyId,
      algorithm: 'Ed25519',
      publicKeyFingerprint: createHash('sha256').update(der).digest('hex'),
      signedAt: proof.signedAt,
    },
  };
}
