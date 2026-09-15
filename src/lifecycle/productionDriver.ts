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
  type ReleasePackageManifest,
  type ReleaseSignatureProof,
  type TrustedReleaseKey,
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
  payloadRoot: string;
  manifest: ReleasePackageManifest;
  signatureProof: ReleaseSignatureProof;
  trustedKeys: TrustedReleaseKey[];
}

export interface ProductionLifecycleDriverOptions {
  projectRoots: ProjectRoot[];
  platform: ProductionLifecyclePlatform;
  release?: TrustedReleaseBundle;
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
  const target = path.resolve(root, ...relative.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new LifecycleDriverError('PACKAGE_PATH_ESCAPE', 'Release payload escaped its trusted root', false);
  }
  const physicalRoot = path.resolve(bundle.payloadRoot);
  const physicalTarget = path.resolve(target);
  if (!physicalTarget.startsWith(`${physicalRoot}${path.sep}`)) {
    throw new LifecycleDriverError('PACKAGE_PATH_ESCAPE', 'Release payload physical path escaped its trusted root', false);
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new LifecycleDriverError('PACKAGE_FILE_UNSAFE', 'Release payload entry is not a single-link regular file', false);
  }
  return readFileSync(target);
}

function verifyBundle(bundle: TrustedReleaseBundle): VerifiedReleasePackage {
  const verified = verifyReleaseSignature(bundle.manifest, bundle.signatureProof, bundle.trustedKeys);
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
  records.push({ relativePath: anchorRelative, sizeBytes: bytes.length, digest: sha256(bytes) });
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
    if (!this.options.release) {
      throw new LifecycleDriverError('TRUSTED_RELEASE_PACKAGE_REQUIRED', 'Lifecycle action requires a cryptographically verified release package', false);
    }
    const verified = this.verifiedRelease ?? verifyBundle(this.options.release);
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
      snapshotWalk(
        current.roots.state,
        path.join(current.roots.state, relative),
        `state/${relative}`,
        destination,
        records,
        totals,
      );
    }
    return records.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private materializeRelease(plan: AuthorizedLifecyclePlan, current: InstallationManifest | null, repair: boolean): void {
    const verified = this.requireRelease(plan);
    const manifest = this.installation(current);
    const root = manifest.roots.install;
    if (!existsSync(markerPath(root))) createOwnedRoot(root, manifest.installationId, 'INSTALL');
    else verifyOwnedRoot(root, manifest.installationId, 'INSTALL');
    if (!repair) clearOwnedRoot(root, manifest.installationId, 'INSTALL');
    for (const file of verified.manifest.files) {
      if (file.path === '.quarangate-owned.json' || file.path.startsWith('.quarangate-')) {
        throw new LifecycleDriverError('PACKAGE_RESERVED_PATH', 'Release package may not replace lifecycle ownership metadata', false);
      }
      const bytes = readPackageFile(this.options.release!, file.path);
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
      const inspection = await this.options.platform.inspectRuntime(manifest);
      return !inspection.running && manifest.lifecycleState === 'UNINSTALLED';
    }
    const authority = await this.options.platform.inspectAuthority(manifest);
    if (authority.duplicateAuthority || authority.staleRegistrations) return false;
    const runtime = await this.options.platform.inspectRuntime(manifest);
    return assertRuntimeIdentity(manifest, runtime);
  }

  async restoreRecoveryAnchor(anchor: RecoveryAnchor): Promise<void> {
    const manifest = createInstallationManifest(anchor.manifest);
    this.attest(manifest);
    const payloadRoot = path.join(manifest.roots.backups, 'anchors', anchor.anchorId, 'payloads');
    verifyOwnedRoot(manifest.roots.install, manifest.installationId, 'INSTALL');
    clearOwnedRoot(manifest.roots.install, manifest.installationId, 'INSTALL');
    for (const relative of ['config', 'data']) {
      const target = path.join(manifest.roots.state, relative);
      if (existsSync(target)) {
        assertSafeTreeEntry(target);
        rmSync(target, { recursive: true, force: false });
      }
    }
    for (const payload of anchor.payloads) {
      const source = path.join(payloadRoot, ...relativePayloadPath(payload.relativePath).split('/'));
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new LifecycleDriverError('RECOVERY_PAYLOAD_UNSAFE', 'Recovery payload entry is unsafe', true);
      }
      const bytes = readFileSync(source);
      if (bytes.length !== payload.sizeBytes || sha256(bytes) !== payload.digest) {
        throw new LifecycleDriverError('RECOVERY_PAYLOAD_INTEGRITY_FAILED', 'Recovery payload integrity verification failed', true);
      }
      const [category, ...parts] = payload.relativePath.split('/');
      const root = category === 'install' ? manifest.roots.install : manifest.roots.state;
      const destination = atomicWritePrivateFile(root, parts.join('/'), bytes);
      if (category === 'install') chmodSync(destination, 0o644);
    }
    await this.options.platform.startRuntime(manifest);
    await this.options.platform.reconcileStartup(manifest);
    this.result = manifest;
  }

  async verifyRollback(anchor: RecoveryAnchor): Promise<boolean> {
    const manifest = createInstallationManifest(anchor.manifest);
    const payloadRoot = path.join(manifest.roots.backups, 'anchors', anchor.anchorId, 'payloads');
    for (const payload of anchor.payloads) {
      const source = path.join(payloadRoot, ...relativePayloadPath(payload.relativePath).split('/'));
      if (!existsSync(source)) return false;
      const bytes = readFileSync(source);
      if (bytes.length !== payload.sizeBytes || sha256(bytes) !== payload.digest) return false;
      const [category, ...parts] = payload.relativePath.split('/');
      const root = category === 'install' ? manifest.roots.install : manifest.roots.state;
      const restored = path.join(root, ...parts);
      if (!existsSync(restored)) return false;
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
  for (const [name, category] of categories) {
    mkdirSync(manifest.roots[name], { recursive: true, mode: 0o700 });
    chmodSync(manifest.roots[name], 0o700);
    createOwnedRoot(manifest.roots[name], manifest.installationId, category);
  }
}

export function verifyTrustedReleaseBundle(bundle: TrustedReleaseBundle): VerifiedReleasePackage {
  verifyReleasePackageManifest(bundle.manifest);
  return verifyBundle(bundle);
}
