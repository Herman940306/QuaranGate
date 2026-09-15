import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalSerialize } from '../executor/agents/canonicalJson.js';
import {
  verifyReleasePackageManifest,
  verifyReleasePayload,
  verifyReleaseSignature,
  verifyReleaseTrustPolicy,
  type ReleasePackageManifest,
  type ReleaseSignatureProof,
  type ReleaseTrustPolicy,
  type VerifiedReleasePackage,
} from '../installer/releasePackage.js';
import {
  createInstallationManifest,
  type InstallationManifest,
  type MigrationRecord,
} from './manifest.js';
import {
  LifecycleDriverError,
  type LifecycleDriver,
  type LifecyclePreflight,
} from './engine.js';
import {
  validateRootOwnership,
  type ProjectRoot,
} from './pathOwnership.js';
import { verifyRecoveryAnchor } from './planner.js';
import type {
  AuthorizedLifecyclePlan,
  DataCategory,
  LifecycleStep,
  RecoveryAnchor,
  RecoveryPayloadIdentity,
} from './planner.js';
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readPrivateFile,
} from './safeFilesystem.js';

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const MAX_RECOVERY_FILES = 10_000;
const MAX_RECOVERY_BYTES = 1024 * 1024 * 1024;

interface StateDocument {
  schemaVersion: number;
  appliedMigrations: string[];
  values: Record<string, string | number | boolean | null>;
}

interface MigrationDescriptor {
  schemaVersion: 1;
  id: string;
  kind: 'CONFIG' | 'STATE';
  fromVersion: number;
  toVersion: number;
  set: Record<string, string | number | boolean | null>;
  remove: string[];
}

export interface RuntimeInspection {
  running: boolean;
  healthy: boolean;
  sourceCommit: string | null;
  releaseDigest: string | null;
  runtimeIdentities: InstallationManifest['runtimeIdentities'];
}

export interface AuthorityInspection {
  duplicateAuthority: boolean;
  staleRegistrations: boolean;
}

export interface ProductionLifecyclePlatform {
  inspectAuthority(manifest: InstallationManifest): Promise<AuthorityInspection>;
  reconcileStartup(manifest: InstallationManifest): Promise<void>;
  removeStartup(manifest: InstallationManifest): Promise<void>;
  startRuntime(manifest: InstallationManifest): Promise<void>;
  stopRuntime(manifest: InstallationManifest): Promise<void>;
  inspectRuntime(manifest: InstallationManifest): Promise<RuntimeInspection>;
  openControlCenter(url: 'http://127.0.0.1:8787'): Promise<void>;
}

export interface TrustedReleaseBundle {
  /** Untrusted release material. Trust anchors are supplied independently. */
  payloadRoot: string;
  manifest: ReleasePackageManifest;
  signatureProof: ReleaseSignatureProof;
}

export interface ProductionLifecycleDriverOptions {
  projectRoots: ProjectRoot[];
  platform: ProductionLifecyclePlatform;
  release?: TrustedReleaseBundle;
  releaseTrustPolicy?: ReleaseTrustPolicy;
  installTemplate?: InstallationManifest;
  initialConfiguration?: Record<string, string | number | boolean | null>;
  initialState?: Record<string, string | number | boolean | null>;
  now?: () => string;
}

interface OwnerMarker {
  schemaVersion: 1;
  installationId: string;
  category: 'INSTALL' | 'STATE' | 'EVIDENCE' | 'MODELS' | 'BACKUPS' | 'CACHE';
  identityDigest: string;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function markerIdentity(marker: Omit<OwnerMarker, 'identityDigest'>): string {
  return createHash('sha256').update(canonicalSerialize(marker)).digest('hex');
}

function ownerMarker(installationId: string, category: OwnerMarker['category']): OwnerMarker {
  const identity = { schemaVersion: 1 as const, installationId, category };
  return { ...identity, identityDigest: markerIdentity(identity) };
}

function markerPath(root: string): string {
  return path.join(root, '.quarangate-owned.json');
}

function assertRealDirectory(target: string, code: string): void {
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LifecycleDriverError(code, 'Lifecycle root must be a real directory', false);
  }
}

function assertUnownedLeafEmpty(root: string): void {
  if (!existsSync(root)) return;
  assertRealDirectory(root, 'UNOWNED_ROOT_UNSAFE');
  if (readdirSync(root).length !== 0) {
    throw new LifecycleDriverError('UNOWNED_ROOT_OCCUPIED', 'Refusing to adopt a nonempty unowned lifecycle root', false);
  }
}

/**
 * Fresh install must never make pre-existing customer/foreign bytes lifecycle-owned.
 * The state root may structurally contain its configured evidence/models/backups
 * children; every leaf root must itself be empty. During coordinator execution,
 * only the lifecycle journal directory may additionally exist under state.
 */
export function assertFreshInstallRootsAvailable(
  manifestInput: InstallationManifest,
  allowLifecycleMetadata = false,
): void {
  const manifest = createInstallationManifest(manifestInput);
  const roots = manifest.roots;
  validateRootOwnership({ install: roots.install, lifecycle: roots, projects: [] });
  for (const leaf of [roots.install, roots.evidence, roots.models, roots.backups, roots.cache]) {
    assertUnownedLeafEmpty(leaf);
  }
  if (!existsSync(roots.state)) return;
  assertRealDirectory(roots.state, 'UNOWNED_ROOT_UNSAFE');

  const childRoots = [roots.evidence, roots.models, roots.backups]
    .map((child) => path.relative(roots.state, child))
    .filter((relative) => relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    .map((relative) => relative.split(path.sep));

  const walk = (directory: string, prefixes: string[][], atStateRoot: boolean): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (atStateRoot && allowLifecycleMetadata && entry === 'lifecycle') continue;
      const matching = prefixes.filter((parts) => parts[0] === entry);
      if (matching.length === 0) {
        throw new LifecycleDriverError('UNOWNED_ROOT_OCCUPIED', 'Refusing to adopt foreign content in the unowned state root', false);
      }
      const target = path.join(directory, entry);
      assertRealDirectory(target, 'UNOWNED_ROOT_UNSAFE');
      if (matching.some((parts) => parts.length === 1)) continue;
      walk(target, matching.map((parts) => parts.slice(1)), false);
    }
  };
  walk(roots.state, childRoots, true);
}

function assertSafeTreeEntry(target: string): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new LifecycleDriverError('OWNED_TREE_SYMLINK_REFUSED', 'Lifecycle-owned tree contains a symbolic link', false);
  }
  if (stat.isFile() && stat.nlink !== 1) {
    throw new LifecycleDriverError('OWNED_TREE_HARDLINK_REFUSED', 'Lifecycle-owned tree contains a hard-linked file', false);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new LifecycleDriverError('OWNED_TREE_TYPE_REFUSED', 'Lifecycle-owned tree contains an unsupported entry', false);
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target).sort()) assertSafeTreeEntry(path.join(target, entry));
  }
}

function createOwnedRoot(root: string, installationId: string, category: OwnerMarker['category']): void {
  ensurePrivateDirectory(root);
  const marker = ownerMarker(installationId, category);
  atomicWritePrivateFile(root, '.quarangate-owned.json', Buffer.from(canonicalSerialize(marker)));
}

function verifyOwnedRoot(root: string, installationId: string, category: OwnerMarker['category']): void {
  const raw = readPrivateFile(root, '.quarangate-owned.json', 16 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new LifecycleDriverError('OWNERSHIP_MARKER_INVALID', `${category} ownership marker is malformed`, false);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LifecycleDriverError('OWNERSHIP_MARKER_INVALID', `${category} ownership marker is malformed`, false);
  }
  const marker = parsed as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  const expected = ['category', 'identityDigest', 'installationId', 'schemaVersion'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new LifecycleDriverError('OWNERSHIP_MARKER_INVALID', `${category} ownership marker has unknown fields`, false);
  }
  const identity = {
    schemaVersion: marker.schemaVersion,
    installationId: marker.installationId,
    category: marker.category,
  };
  if (marker.schemaVersion !== 1 || marker.installationId !== installationId || marker.category !== category
    || marker.identityDigest !== markerIdentity(identity as Omit<OwnerMarker, 'identityDigest'>)) {
    throw new LifecycleDriverError('OWNERSHIP_MARKER_MISMATCH', `${category} root is not owned by this installation`, false);
  }
}

function clearOwnedRoot(root: string, installationId: string, category: OwnerMarker['category']): void {
  verifyOwnedRoot(root, installationId, category);
  for (const entry of readdirSync(root).sort()) {
    if (entry === '.quarangate-owned.json') continue;
    const target = path.join(root, entry);
    assertSafeTreeEntry(target);
  }
  for (const entry of readdirSync(root).sort()) {
    if (entry === '.quarangate-owned.json') continue;
    rmSync(path.join(root, entry), { recursive: true, force: false });
  }
}

function relativePayloadPath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (!value || normalized !== value || path.posix.isAbsolute(value)
    || value.includes('\\') || value.split('/').includes('..') || normalized === '.') {
    throw new LifecycleDriverError('PACKAGE_PATH_INVALID', 'Release payload path is unsafe', false);
  }
  return normalized;
}

function readPackageFile(bundle: TrustedReleaseBundle, relativeInput: string): Buffer {
  const relative = relativePayloadPath(relativeInput);
  const root = path.resolve(bundle.payloadRoot);
  if (!existsSync(root)) {
    throw new LifecycleDriverError('PACKAGE_ROOT_UNSAFE', 'Release payload root is missing', false);
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new LifecycleDriverError('PACKAGE_ROOT_UNSAFE', 'Release payload root must be a real directory', false);
  }
  const parts = relative.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    if (!current.startsWith(`${root}${path.sep}`)) {
      throw new LifecycleDriverError('PACKAGE_PATH_ESCAPE', 'Release payload escaped its trusted root', false);
    }
    if (!existsSync(current)) {
      throw new LifecycleDriverError('PACKAGE_FILE_UNSAFE', 'Release payload path is missing', false);
    }
    const stat = lstatSync(current);
    const final = index === parts.length - 1;
    if (!final) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new LifecycleDriverError('PACKAGE_PARENT_UNSAFE', 'Release payload contains a symlinked or non-directory parent', false);
      }
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new LifecycleDriverError('PACKAGE_FILE_UNSAFE', 'Release payload entry is not a single-link regular file', false);
    }
  }
  return readFileSync(current);
}

function verifyBundle(bundle: TrustedReleaseBundle, trustPolicyInput: ReleaseTrustPolicy): VerifiedReleasePackage {
  const trustPolicy = verifyReleaseTrustPolicy(trustPolicyInput);
  const verified = verifyReleaseSignature(bundle.manifest, bundle.signatureProof, trustPolicy.trustedKeys);
  verifyReleasePayload(verified.manifest, (relative) => readPackageFile(bundle, relative));
  return verified;
}

function writeStateDocument(root: string, relative: string, document: StateDocument): void {
  atomicWritePrivateFile(root, relative, Buffer.from(canonicalSerialize(document)));
}

function readStateDocument(root: string, relative: string, expectedVersion: number): StateDocument {
  let value: unknown;
  try {
    value = JSON.parse(readPrivateFile(root, relative).toString('utf8'));
  } catch {
    throw new LifecycleDriverError('MIGRATION_STATE_INVALID', 'Migration source document is missing or malformed', false);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LifecycleDriverError('MIGRATION_STATE_INVALID', 'Migration source document is malformed', false);
  }
  const document = value as Record<string, unknown>;
  const keys = Object.keys(document).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['appliedMigrations', 'schemaVersion', 'values'])
    || document.schemaVersion !== expectedVersion
    || !Array.isArray(document.appliedMigrations)
    || document.appliedMigrations.some((id) => typeof id !== 'string' || !SAFE_KEY.test(id))
    || !document.values || typeof document.values !== 'object' || Array.isArray(document.values)) {
    throw new LifecycleDriverError('MIGRATION_STATE_INVALID', 'Migration source document shape/version is invalid', false);
  }
  return document as unknown as StateDocument;
}

function parseMigrationDescriptor(bytes: Buffer, expected: MigrationRecord): MigrationDescriptor {
  if (sha256(bytes) !== expected.digest) {
    throw new LifecycleDriverError('MIGRATION_ARTIFACT_MISMATCH', 'Migration artifact digest does not match the reviewed release', false);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new LifecycleDriverError('MIGRATION_ARTIFACT_INVALID', 'Migration artifact is not valid JSON', false);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LifecycleDriverError('MIGRATION_ARTIFACT_INVALID', 'Migration artifact is malformed', false);
  }
  const descriptor = value as Record<string, unknown>;
  const keys = Object.keys(descriptor).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['fromVersion', 'id', 'kind', 'remove', 'schemaVersion', 'set', 'toVersion'])
    || descriptor.schemaVersion !== 1 || descriptor.id !== expected.id || descriptor.kind !== expected.kind
    || descriptor.fromVersion !== expected.fromVersion || descriptor.toVersion !== expected.toVersion
    || !descriptor.set || typeof descriptor.set !== 'object' || Array.isArray(descriptor.set)
    || !Array.isArray(descriptor.remove)) {
    throw new LifecycleDriverError('MIGRATION_ARTIFACT_INVALID', 'Migration artifact identity/shape is invalid', false);
  }
  const set = descriptor.set as Record<string, unknown>;
  if (Object.keys(set).some((key) => !SAFE_KEY.test(key)
      || !['string', 'number', 'boolean'].includes(typeof set[key]) && set[key] !== null)
    || descriptor.remove.some((key) => typeof key !== 'string' || !SAFE_KEY.test(key))
    || new Set(descriptor.remove as string[]).size !== descriptor.remove.length) {
    throw new LifecycleDriverError('MIGRATION_ARTIFACT_INVALID', 'Migration operations are not bounded scalar key operations', false);
  }
  return descriptor as unknown as MigrationDescriptor;
}

function migrationPath(record: MigrationRecord): string {
  return `migrations/${record.kind.toLowerCase()}/${record.id}.json`;
}

function mergedMigrations(current: InstallationManifest | null, target: AuthorizedLifecyclePlan['target']): MigrationRecord[] {
  const values = [...(current?.migrations ?? []), ...(target?.migrations ?? [])];
  const unique = new Map(values.map((migration) => [`${migration.kind}:${migration.fromVersion}:${migration.id}`, migration]));
  return [...unique.values()].sort((left, right) =>
    `${left.kind}:${String(left.fromVersion).padStart(8, '0')}:${left.id}`.localeCompare(
      `${right.kind}:${String(right.fromVersion).padStart(8, '0')}:${right.id}`,
    ));
}

function snapshotWalk(
  sourceRoot: string,
  current: string,
  prefix: string,
  destinationRoot: string,
  records: RecoveryPayloadIdentity[],
  totals: { bytes: number },
): void {
  if (!existsSync(current)) return;
  const stat = lstatSync(current);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
    throw new LifecycleDriverError('RECOVERY_SOURCE_UNSAFE', 'Recovery source contains an unsafe filesystem entry', false);
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(current).sort()) {
      if (entry === '.quarangate-owned.json') continue;
      snapshotWalk(sourceRoot, path.join(current, entry), prefix, destinationRoot, records, totals);
    }
    return;
  }
  const relative = path.relative(sourceRoot, current).split(path.sep).join('/');
  const anchorRelative = `${prefix}/${relative}`;
  const bytes = readFileSync(current);
  totals.bytes += bytes.length;
  if (records.length >= MAX_RECOVERY_FILES || totals.bytes > MAX_RECOVERY_BYTES) {
    throw new LifecycleDriverError('RECOVERY_PAYLOAD_LIMIT_EXCEEDED', 'Recovery payload exceeds bounded file/byte limits', false);
  }
  atomicWritePrivateFile(destinationRoot, anchorRelative, bytes);
  records.push({ relativePath: anchorRelative, sizeBytes: bytes.length, digest: sha256(bytes), mode: stat.mode & 0o777 });
}

function readVerifiedRecoveryPayloads(
  payloadRoot: string,
  payloads: RecoveryPayloadIdentity[],
): Map<string, Buffer> {
  const root = path.resolve(payloadRoot);
  if (!existsSync(root)) {
    throw new LifecycleDriverError('RECOVERY_PAYLOAD_UNSAFE', 'Recovery payload root is missing', false);
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new LifecycleDriverError('RECOVERY_PAYLOAD_UNSAFE', 'Recovery payload root is unsafe', false);
  }
  const verified = new Map<string, Buffer>();
  for (const payload of payloads) {
    const relative = relativePayloadPath(payload.relativePath);
    const parts = relative.split('/');
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      if (!current.startsWith(`${root}${path.sep}`)) {
        throw new LifecycleDriverError('RECOVERY_PAYLOAD_UNSAFE', 'Recovery payload escaped its anchor root', false);
      }
      if (!existsSync(current)) {
        throw new LifecycleDriverError('RECOVERY_PAYLOAD_UNSAFE', 'Recovery payload path is missing', false);
      }
      const stat = lstatSync(current);
      const final = index === parts.length - 1;
      if (!final) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new LifecycleDriverError('RECOVERY_PAYLOAD_UNSAFE', 'Recovery payload parent is unsafe', false);
        }
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new LifecycleDriverError('RECOVERY_PAYLOAD_UNSAFE', 'Recovery payload entry is unsafe', false);
      }
    }
    const bytes = readFileSync(current);
    if (bytes.length !== payload.sizeBytes || sha256(bytes) !== payload.digest) {
      throw new LifecycleDriverError('RECOVERY_PAYLOAD_INTEGRITY_FAILED', 'Recovery payload integrity verification failed', false);
    }
    verified.set(payload.relativePath, bytes);
  }
  return verified;
}

function assertRuntimeIdentity(expected: InstallationManifest, actual: RuntimeInspection): boolean {
  return actual.running && actual.healthy
    && actual.sourceCommit === expected.sourceCommit
    && actual.releaseDigest === expected.releaseDigest
    && JSON.stringify(actual.runtimeIdentities) === JSON.stringify(expected.runtimeIdentities);
}

export class ProductionLifecycleDriver implements LifecycleDriver {
  private readonly now: () => string;
  private verifiedRelease?: VerifiedReleasePackage;
  private result?: InstallationManifest;

  constructor(private readonly options: ProductionLifecycleDriverOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private roots(current: InstallationManifest | null): InstallationManifest['roots'] {
    const manifest = current ?? this.options.installTemplate;
    if (!manifest) {
      throw new LifecycleDriverError('INSTALL_TEMPLATE_REQUIRED', 'Fresh install requires a validated installation template', false);
    }
    return manifest.roots;
  }

  private installation(current: InstallationManifest | null): InstallationManifest {
    const manifest = current ?? this.options.installTemplate;
    if (!manifest) {
      throw new LifecycleDriverError('INSTALL_TEMPLATE_REQUIRED', 'Fresh install requires a validated installation template', false);
    }
    return createInstallationManifest(manifest);
  }

  private requireRelease(plan: AuthorizedLifecyclePlan): VerifiedReleasePackage {
    if (!this.options.release || !this.options.releaseTrustPolicy) {
      throw new LifecycleDriverError('TRUSTED_RELEASE_PACKAGE_REQUIRED', 'Lifecycle action requires release material plus an independent trust policy', false);
    }
    const verified = this.verifiedRelease ?? verifyBundle(this.options.release, this.options.releaseTrustPolicy);
    this.verifiedRelease = verified;
    const expectedDigest = plan.action === 'REPAIR'
      ? this.options.installTemplate?.releaseDigest
      : plan.target?.releaseDigest;
    if (!expectedDigest || verified.manifest.manifestDigest !== expectedDigest) {
      throw new LifecycleDriverError('RELEASE_PLAN_MISMATCH', 'Release package digest does not match the reviewed lifecycle plan', false);
    }
    if (plan.target && (verified.manifest.productVersion !== plan.target.productVersion
      || verified.manifest.sourceCommit !== plan.target.sourceCommit)) {
      throw new LifecycleDriverError('RELEASE_PLAN_MISMATCH', 'Release package identity does not match the reviewed lifecycle target', false);
    }
    return verified;
  }

  private attest(current: InstallationManifest | null): void {
    const roots = this.roots(current);
    validateRootOwnership({
      install: roots.install,
      lifecycle: roots,
      projects: this.options.projectRoots,
    });
  }

  async preflight(
    plan: AuthorizedLifecyclePlan,
    current: InstallationManifest | null,
  ): Promise<LifecyclePreflight> {
    this.attest(current);
    const manifest = this.installation(current);
    if (current) {
      const categories: Array<[keyof InstallationManifest['roots'], OwnerMarker['category']]> = [
        ['install', 'INSTALL'],
        ['state', 'STATE'],
        ['evidence', 'EVIDENCE'],
        ['models', 'MODELS'],
        ['backups', 'BACKUPS'],
        ['cache', 'CACHE'],
      ];
      for (const [name, category] of categories) verifyOwnedRoot(current.roots[name], current.installationId, category);
    }
    if (['INSTALL', 'UPGRADE', 'REPAIR', 'REINSTALL'].includes(plan.action)) this.requireRelease(plan);
    const authority = await this.options.platform.inspectAuthority(manifest);
    return {
      duplicateAuthority: authority.duplicateAuthority,
      staleRegistrations: authority.staleRegistrations,
      preservationVerified: true,
    };
  }

  async captureRecoveryPayloads(
    plan: AuthorizedLifecyclePlan,
    current: InstallationManifest,
  ): Promise<RecoveryPayloadIdentity[]> {
    this.attest(current);
    verifyOwnedRoot(current.roots.backups, current.installationId, 'BACKUPS');
    const anchorId = `anchor-${plan.operationId}`;
    const destination = ensurePrivateDirectory(path.join(current.roots.backups, 'anchors', anchorId, 'payloads'));
    const records: RecoveryPayloadIdentity[] = [];
    const totals = { bytes: 0 };
    snapshotWalk(current.roots.install, current.roots.install, 'install', destination, records, totals);
    for (const relative of ['config', 'data']) {
      const source = path.join(current.roots.state, relative);
      snapshotWalk(
        source,
        source,
        `state/${relative}`,
        destination,
        records,
        totals,
      );
    }
    return records.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private materializeRelease(plan: AuthorizedLifecyclePlan, current: InstallationManifest | null, _repair: boolean): void {
    const verified = this.requireRelease(plan);
    const manifest = this.installation(current);
    const root = manifest.roots.install;
    // Re-read and re-hash the complete signed payload immediately before
    // mutation so a package change after preflight cannot be installed.
    const payloads = verified.manifest.files.map((file) => {
      if (file.path === '.quarangate-owned.json' || file.path.startsWith('.quarangate-')) {
        throw new LifecycleDriverError('PACKAGE_RESERVED_PATH', 'Release package may not replace lifecycle ownership metadata', false);
      }
      const bytes = readPackageFile(this.options.release!, file.path);
      if (bytes.length !== file.sizeBytes || sha256(bytes) !== file.digest) {
        throw new LifecycleDriverError('PACKAGE_PAYLOAD_INTEGRITY_FAILED', `Package payload integrity failed for ${file.path}`, false);
      }
      return { file, bytes };
    });
    if (!existsSync(markerPath(root))) createOwnedRoot(root, manifest.installationId, 'INSTALL');
    else verifyOwnedRoot(root, manifest.installationId, 'INSTALL');
    // INSTALL/UPGRADE/REPAIR all reconcile the lifecycle-owned install tree to
    // the exact signed payload. Repair must not preserve obsolete executables.
    clearOwnedRoot(root, manifest.installationId, 'INSTALL');
    for (const { file, bytes } of payloads) {
      const target = atomicWritePrivateFile(root, file.path, bytes);
      chmodSync(target, file.mode);
    }
  }

  private migrate(kind: 'CONFIG' | 'STATE', plan: AuthorizedLifecyclePlan, current: InstallationManifest): void {
    const release = this.requireRelease(plan);
    const relative = kind === 'CONFIG' ? 'config/schema.json' : 'data/schema.json';
    let document = readStateDocument(current.roots.state, relative, kind === 'CONFIG'
      ? current.configSchemaVersion
      : current.stateSchemaVersion);
    for (const record of plan.target?.migrations.filter((item) => item.kind === kind) ?? []) {
      const descriptorBytes = readPackageFile(this.options.release!, migrationPath(record));
      const packageFile = release.manifest.files.find((file) => file.path === migrationPath(record));
      if (!packageFile || packageFile.digest !== record.digest) {
        throw new LifecycleDriverError('MIGRATION_NOT_IN_RELEASE', 'Migration is not bound into the trusted release manifest', false);
      }
      const descriptor = parseMigrationDescriptor(descriptorBytes, record);
      if (document.schemaVersion !== descriptor.fromVersion) {
        throw new LifecycleDriverError('MIGRATION_SOURCE_VERSION_MISMATCH', 'Migration source version changed after review', false);
      }
      const values = { ...document.values, ...descriptor.set };
      for (const key of descriptor.remove) delete values[key];
      document = {
        schemaVersion: descriptor.toVersion,
        appliedMigrations: [...document.appliedMigrations, descriptor.id],
        values,
      };
      writeStateDocument(current.roots.state, relative, document);
    }
  }

  private ensureFreshRoots(manifest: InstallationManifest): void {
    // The coordinator creates only state/lifecycle journal metadata before this
    // mutation step. Any other unowned bytes make fresh installation unsafe.
    assertFreshInstallRootsAvailable(manifest, true);
    const categories: Array<[keyof InstallationManifest['roots'], OwnerMarker['category']]> = [
      ['install', 'INSTALL'],
      ['state', 'STATE'],
      ['evidence', 'EVIDENCE'],
      ['models', 'MODELS'],
      ['backups', 'BACKUPS'],
      ['cache', 'CACHE'],
    ];
    for (const [name, category] of categories) {
      const root = manifest.roots[name];
      if (existsSync(markerPath(root))) {
        verifyOwnedRoot(root, manifest.installationId, category);
      } else {
        createOwnedRoot(root, manifest.installationId, category);
      }
    }
    if (this.options.initialConfiguration) {
      writeStateDocument(manifest.roots.state, 'config/schema.json', {
        schemaVersion: manifest.configSchemaVersion,
        appliedMigrations: manifest.migrations.filter((item) => item.kind === 'CONFIG').map((item) => item.id),
        values: this.options.initialConfiguration,
      });
    }
    if (this.options.initialState) {
      writeStateDocument(manifest.roots.state, 'data/schema.json', {
        schemaVersion: manifest.stateSchemaVersion,
        appliedMigrations: manifest.migrations.filter((item) => item.kind === 'STATE').map((item) => item.id),
        values: this.options.initialState,
      });
    }
  }

  private removeSelectedData(plan: AuthorizedLifecyclePlan, current: InstallationManifest): void {
    const categoryRoots: Partial<Record<DataCategory, [string, OwnerMarker['category'] | null]>> = {
      EVIDENCE: [current.roots.evidence, 'EVIDENCE'],
      MODELS: [current.roots.models, 'MODELS'],
      BACKUPS: [current.roots.backups, 'BACKUPS'],
      CACHE: [current.roots.cache, 'CACHE'],
    };
    for (const category of plan.removeData) {
      if (category === 'PROJECTS') {
        throw new LifecycleDriverError('PROJECT_DELETE_REFUSED', 'Project content is never lifecycle-owned data', false);
      }
      if (category === 'LOCAL_STATE') {
        verifyOwnedRoot(current.roots.state, current.installationId, 'STATE');
        for (const relative of ['config', 'data']) {
          const target = path.join(current.roots.state, relative);
          if (existsSync(target)) {
            assertSafeTreeEntry(target);
            rmSync(target, { recursive: true, force: false });
          }
        }
        continue;
      }
      if (category === 'CREDENTIALS') continue;
      const mapping = categoryRoots[category];
      if (!mapping || !mapping[1]) {
        throw new LifecycleDriverError('REMOVE_DATA_INVALID', 'Selected data category has no owned removal mapping', false);
      }
      clearOwnedRoot(mapping[0], current.installationId, mapping[1]);
    }
  }

  async executeStep(
    step: LifecycleStep,
    plan: AuthorizedLifecyclePlan,
    current: InstallationManifest | null,
    anchor: RecoveryAnchor | null,
  ): Promise<void> {
    const manifest = this.installation(current);
    try {
      switch (step.kind) {
        case 'QUIESCE_RUNTIME':
          if (!current) throw new LifecycleDriverError('INSTALLATION_REQUIRED', 'Runtime quiesce requires current state', false);
          await this.options.platform.stopRuntime(current);
          return;
        case 'MIGRATE_CONFIGURATION':
          if (!current) throw new LifecycleDriverError('INSTALLATION_REQUIRED', 'Config migration requires current state', false);
          this.migrate('CONFIG', plan, current);
          return;
        case 'MIGRATE_STATE':
          if (!current) throw new LifecycleDriverError('INSTALLATION_REQUIRED', 'State migration requires current state', false);
          this.migrate('STATE', plan, current);
          return;
        case 'TRANSITION_COMPONENTS':
          if (!current) this.ensureFreshRoots(manifest);
          this.materializeRelease(plan, current, false);
          await this.options.platform.startRuntime(this.projectedManifest(plan, current, 'HEALTHY'));
          return;
        case 'RECONCILE_COMPONENTS':
          this.materializeRelease(plan, current, true);
          await this.options.platform.startRuntime(this.projectedManifest(plan, current, 'HEALTHY'));
          return;
        case 'VERIFY_STARTUP_REGISTRATION':
          await this.options.platform.reconcileStartup(this.projectedManifest(plan, current, 'HEALTHY'));
          return;
        case 'REMOVE_APPLICATION_COMPONENTS':
          if (!current) throw new LifecycleDriverError('INSTALLATION_REQUIRED', 'Uninstall requires current state', false);
          await this.options.platform.stopRuntime(current);
          await this.options.platform.removeStartup(current);
          clearOwnedRoot(current.roots.install, current.installationId, 'INSTALL');
          return;
        case 'REMOVE_SELECTED_DATA':
          if (!current) throw new LifecycleDriverError('INSTALLATION_REQUIRED', 'Data removal requires current state', false);
          this.removeSelectedData(plan, current);
          return;
        case 'RESTORE_RECOVERY_ANCHOR':
          if (!anchor) throw new LifecycleDriverError('RECOVERY_ANCHOR_MISSING', 'Rollback step requires an exact anchor', false);
          await this.restoreRecoveryAnchor(anchor);
          return;
        case 'REFUSE_DUPLICATE_AUTHORITY':
        case 'REFUSE_STALE_REGISTRATIONS':
          return;
        case 'CREATE_RECOVERY_ANCHOR':
        case 'VERIFY_EXISTING_IDENTITY':
        case 'VERIFY_PRECONDITIONS':
        case 'VERIFY_FINAL_IDENTITY_AND_HEALTH':
          return;
      }
    } catch (error) {
      if (error instanceof LifecycleDriverError) {
        throw new LifecycleDriverError(error.code, error.message, step.mutation || error.mutationStarted);
      }
      throw new LifecycleDriverError('PRODUCTION_STEP_FAILED', `Production lifecycle step ${step.kind} failed`, step.mutation);
    }
  }

  private projectedManifest(
    plan: AuthorizedLifecyclePlan,
    current: InstallationManifest | null,
    health: 'HEALTHY' | 'NOT_RUNNING',
  ): InstallationManifest {
    const base = this.installation(current);
    const target = plan.action === 'ROLLBACK' && plan.rollbackAnchor
      ? {
          productVersion: plan.rollbackAnchor.manifest.productVersion,
          sourceCommit: plan.rollbackAnchor.manifest.sourceCommit,
          releaseDigest: plan.rollbackAnchor.manifest.releaseDigest,
          configSchemaVersion: plan.rollbackAnchor.manifest.configSchemaVersion,
          stateSchemaVersion: plan.rollbackAnchor.manifest.stateSchemaVersion,
          components: plan.rollbackAnchor.manifest.components,
          migrations: plan.rollbackAnchor.manifest.migrations,
        }
      : plan.target;
    const providers = plan.removeData.includes('CREDENTIALS')
      ? Object.fromEntries(Object.entries(base.integrations.providers).map(([name, value]) => [
          name,
          value.state === 'CONFIGURED' && name !== 'ollama' ? { state: 'REAUTHORIZATION_REQUIRED' } : value,
        ]))
      : base.integrations.providers;
    return createInstallationManifest({
      ...base,
      lifecycleState: plan.action === 'UNINSTALL' ? 'UNINSTALLED' : 'INSTALLED',
      productVersion: target?.productVersion ?? base.productVersion,
      sourceCommit: target?.sourceCommit ?? base.sourceCommit,
      releaseDigest: target?.releaseDigest ?? base.releaseDigest,
      configSchemaVersion: target?.configSchemaVersion ?? base.configSchemaVersion,
      stateSchemaVersion: target?.stateSchemaVersion ?? base.stateSchemaVersion,
      components: target?.components ?? base.components,
      migrations: plan.action === 'ROLLBACK' && plan.rollbackAnchor
        ? plan.rollbackAnchor.manifest.migrations
        : mergedMigrations(current, target),
      integrations: {
        ...base.integrations,
        providers,
      },
      startupRegistrations: plan.action === 'UNINSTALL'
        ? base.startupRegistrations.map((registration) => ({ ...registration, enabled: false }))
        : base.startupRegistrations,
      updatedAt: this.now(),
      health: { state: health, verifiedAt: this.now() },
    });
  }

  async finalManifest(
    plan: AuthorizedLifecyclePlan,
    current: InstallationManifest | null,
  ): Promise<InstallationManifest> {
    const result = this.projectedManifest(
      plan,
      current,
      plan.action === 'UNINSTALL' ? 'NOT_RUNNING' : 'HEALTHY',
    );
    this.result = result;
    return result;
  }

  async verifyFinalState(
    plan: AuthorizedLifecyclePlan,
    manifest: InstallationManifest,
  ): Promise<boolean> {
    if (plan.action === 'UNINSTALL') {
      const authority = await this.options.platform.inspectAuthority(manifest);
      if (authority.duplicateAuthority || authority.staleRegistrations) return false;
      if (manifest.startupRegistrations.some((registration) => registration.enabled)) return false;
      const inspection = await this.options.platform.inspectRuntime(manifest);
      return !inspection.running && manifest.lifecycleState === 'UNINSTALLED';
    }
    const authority = await this.options.platform.inspectAuthority(manifest);
    if (authority.duplicateAuthority || authority.staleRegistrations) return false;
    const runtime = await this.options.platform.inspectRuntime(manifest);
    return assertRuntimeIdentity(manifest, runtime);
  }

  async restoreRecoveryAnchor(anchorInput: RecoveryAnchor): Promise<void> {
    const anchor = verifyRecoveryAnchor(anchorInput);
    const manifest = createInstallationManifest(anchor.manifest);
    this.attest(manifest);
    verifyOwnedRoot(manifest.roots.install, manifest.installationId, 'INSTALL');
    verifyOwnedRoot(manifest.roots.backups, manifest.installationId, 'BACKUPS');
    const payloadRoot = path.join(manifest.roots.backups, 'anchors', anchor.anchorId, 'payloads');
    // Verify the complete rollback payload before stopping the live runtime or
    // rewriting a single byte. A corrupt anchor must fail with zero mutation.
    const verifiedPayloads = readVerifiedRecoveryPayloads(payloadRoot, anchor.payloads);
    // A replacement runtime may have started before the failed transition.
    // Quiesce it only after the recovery preimage is fully proven.
    await this.options.platform.stopRuntime(manifest);
    clearOwnedRoot(manifest.roots.install, manifest.installationId, 'INSTALL');
    for (const relative of ['config', 'data']) {
      const target = path.join(manifest.roots.state, relative);
      if (existsSync(target)) {
        assertSafeTreeEntry(target);
        rmSync(target, { recursive: true, force: false });
      }
    }
    for (const payload of anchor.payloads) {
      const bytes = verifiedPayloads.get(payload.relativePath);
      if (!bytes) {
        throw new LifecycleDriverError('RECOVERY_PAYLOAD_INTEGRITY_FAILED', 'Verified recovery payload disappeared from the preflight set', true);
      }
      const [category, ...parts] = payload.relativePath.split('/');
      const root = category === 'install' ? manifest.roots.install : manifest.roots.state;
      const destination = atomicWritePrivateFile(root, parts.join('/'), bytes);
      chmodSync(destination, payload.mode);
    }
    await this.options.platform.startRuntime(manifest);
    await this.options.platform.reconcileStartup(manifest);
    this.result = manifest;
  }

  async verifyRollback(anchorInput: RecoveryAnchor): Promise<boolean> {
    const anchor = verifyRecoveryAnchor(anchorInput);
    const manifest = createInstallationManifest(anchor.manifest);
    const payloadRoot = path.join(manifest.roots.backups, 'anchors', anchor.anchorId, 'payloads');
    let verifiedPayloads: Map<string, Buffer>;
    try {
      verifiedPayloads = readVerifiedRecoveryPayloads(payloadRoot, anchor.payloads);
    } catch {
      return false;
    }
    for (const payload of anchor.payloads) {
      const bytes = verifiedPayloads.get(payload.relativePath);
      if (!bytes) return false;
      const [category, ...parts] = payload.relativePath.split('/');
      const root = category === 'install' ? manifest.roots.install : manifest.roots.state;
      const restored = path.join(root, ...parts);
      if (!existsSync(restored)) return false;
      const restoredStat = lstatSync(restored);
      if (!restoredStat.isFile() || restoredStat.isSymbolicLink() || restoredStat.nlink !== 1
        || (restoredStat.mode & 0o777) !== payload.mode) return false;
      const restoredBytes = readFileSync(restored);
      if (restoredBytes.length !== payload.sizeBytes || sha256(restoredBytes) !== payload.digest) return false;
    }
    return assertRuntimeIdentity(manifest, await this.options.platform.inspectRuntime(manifest));
  }
}

export function initializeProductionOwnedRoots(manifestInput: InstallationManifest): void {
  const manifest = createInstallationManifest(manifestInput);
  const categories: Array<[keyof InstallationManifest['roots'], OwnerMarker['category']]> = [
    ['install', 'INSTALL'],
    ['state', 'STATE'],
    ['evidence', 'EVIDENCE'],
    ['models', 'MODELS'],
    ['backups', 'BACKUPS'],
    ['cache', 'CACHE'],
  ];
  validateRootOwnership({ install: manifest.roots.install, lifecycle: manifest.roots, projects: [] });
  assertFreshInstallRootsAvailable(manifest, false);
  for (const [name, category] of categories) {
    mkdirSync(manifest.roots[name], { recursive: true, mode: 0o700 });
    chmodSync(manifest.roots[name], 0o700);
    createOwnedRoot(manifest.roots[name], manifest.installationId, category);
  }
}

export function verifyTrustedReleaseBundle(
  bundle: TrustedReleaseBundle,
  trustPolicy: ReleaseTrustPolicy,
): VerifiedReleasePackage {
  verifyReleasePackageManifest(bundle.manifest);
  return verifyBundle(bundle, trustPolicy);
}
