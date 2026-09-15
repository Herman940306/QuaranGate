import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalSerialize } from '../executor/agents/canonicalJson.js';
import {
  installationManifestDigest,
  validateInstallationManifest,
  type InstallationManifest,
  type MigrationRecord,
} from './manifest.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export type LifecycleAction = 'INSTALL' | 'UPGRADE' | 'REPAIR' | 'ROLLBACK' | 'UNINSTALL' | 'REINSTALL';
export type DataCategory = 'PROJECTS' | 'EVIDENCE' | 'MODELS' | 'CREDENTIALS' | 'BACKUPS' | 'LOCAL_STATE' | 'CACHE';

export interface TargetRelease {
  productVersion: string;
  sourceCommit: string;
  releaseDigest: string;
  configSchemaVersion: number;
  stateSchemaVersion: number;
  components: string[];
  migrations: MigrationRecord[];
}

export interface PreservationPolicy {
  projects: 'PRESERVE_REFERENCES';
  evidence: 'PRESERVE' | 'REMOVE';
  models: 'PRESERVE' | 'REMOVE';
  credentials: 'PRESERVE_OR_REAUTHORIZE' | 'REMOVE';
  backups: 'PRESERVE' | 'REMOVE';
  localState: 'PRESERVE' | 'REMOVE';
  cache: 'PRESERVE' | 'REMOVE';
}

export interface RecoveryPayloadIdentity {
  relativePath: string;
  sizeBytes: number;
  digest: string;
}

export interface RecoveryAnchor {
  schemaVersion: 1;
  anchorId: string;
  createdAt: string;
  manifest: InstallationManifest;
  manifestDigest: string;
  payloads: RecoveryPayloadIdentity[];
  anchorDigest: string;
}

export interface LifecyclePlanRequest {
  action: LifecycleAction;
  operationId: string;
  target?: TargetRelease;
  preservation: PreservationPolicy;
  removeData?: DataCategory[];
  authorityState: 'VALID' | 'UNKNOWN_OR_MALFORMED';
  rollbackAnchor?: RecoveryAnchor;
}

export type LifecycleStepKind =
  | 'VERIFY_EXISTING_IDENTITY'
  | 'VERIFY_PRECONDITIONS'
  | 'CREATE_RECOVERY_ANCHOR'
  | 'MIGRATE_CONFIGURATION'
  | 'MIGRATE_STATE'
  | 'TRANSITION_COMPONENTS'
  | 'RECONCILE_COMPONENTS'
  | 'VERIFY_STARTUP_REGISTRATION'
  | 'REMOVE_APPLICATION_COMPONENTS'
  | 'REMOVE_SELECTED_DATA'
  | 'RESTORE_RECOVERY_ANCHOR'
  | 'REFUSE_DUPLICATE_AUTHORITY'
  | 'REFUSE_STALE_REGISTRATIONS'
  | 'VERIFY_FINAL_IDENTITY_AND_HEALTH';

export interface LifecycleStep {
  sequence: number;
  kind: LifecycleStepKind;
  mutation: boolean;
}

export interface LifecyclePlan {
  schemaVersion: 1;
  action: LifecycleAction;
  operationId: string;
  currentManifestDigest: string | null;
  target: TargetRelease | null;
  preservation: PreservationPolicy;
  removeData: DataCategory[];
  destructiveChoices: string[];
  recoveryAnchorRequired: boolean;
  rollbackAnchor: RecoveryAnchor | null;
  noOp: boolean;
  steps: LifecycleStep[];
  digest: string;
  authorized: boolean;
  consentDigest?: string;
}

export interface LifecycleConsent {
  accepted: boolean;
  expectedPlanDigest: string;
  approvedDestructiveChoices: string[];
}

export type AuthorizedLifecyclePlan = LifecyclePlan & { authorized: true; consentDigest: string };

export class LifecyclePlanError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LifecyclePlanError';
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalSerialize(value)).digest('hex');
}

function planIdentity(plan: LifecyclePlan): Record<string, unknown> {
  const { digest: _digest, authorized: _authorized, consentDigest: _consentDigest, ...identity } = plan;
  return identity;
}

function compareVersion(left: string, right: string): number {
  const parse = (value: string): number[] => {
    if (!SEMVER.test(value)) throw new LifecyclePlanError('VERSION_INVALID', `Invalid semantic version: ${value}`);
    return value.split('-', 1)[0]!.split('.').map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0) ? -1 : 1;
  }
  return left.localeCompare(right);
}

function assertSortedUnique(values: string[], label: string): void {
  if (values.length === 0 || values.some((value, index) => !SAFE_ID.test(value) || (index > 0 && (values[index - 1] ?? '') >= value))) {
    throw new LifecyclePlanError('RELEASE_INVALID', `${label} must be non-empty, sorted, unique safe identifiers`);
  }
}

function validateTarget(target: TargetRelease): TargetRelease {
  if (!SEMVER.test(target.productVersion) || !GIT_COMMIT.test(target.sourceCommit) || !SHA256.test(target.releaseDigest)) {
    throw new LifecyclePlanError('RELEASE_INVALID', 'Target release identity is invalid');
  }
  if (!Number.isInteger(target.configSchemaVersion) || target.configSchemaVersion < 0
    || !Number.isInteger(target.stateSchemaVersion) || target.stateSchemaVersion < 0) {
    throw new LifecyclePlanError('RELEASE_INVALID', 'Target schema versions are invalid');
  }
  assertSortedUnique(target.components, 'Target components');
  for (const migration of target.migrations) {
    if (!SAFE_ID.test(migration.id)
      || !['CONFIG', 'STATE'].includes(migration.kind)
      || !Number.isInteger(migration.fromVersion)
      || !Number.isInteger(migration.toVersion)
      || migration.toVersion !== migration.fromVersion + 1
      || !SHA256.test(migration.digest)) {
      throw new LifecyclePlanError('MIGRATION_INVALID', 'Target migration chain record is invalid');
    }
  }
  const keys = target.migrations.map((migration) => `${migration.kind}:${String(migration.fromVersion).padStart(8, '0')}:${migration.id}`);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && (keys[index - 1] ?? '') >= key)) {
    throw new LifecyclePlanError('MIGRATION_INVALID', 'Target migrations must be sorted and unique');
  }
  return target;
}

function validateMigrationChain(kind: 'CONFIG' | 'STATE', from: number, to: number, migrations: MigrationRecord[]): void {
  if (to < from) throw new LifecyclePlanError('MIGRATION_DOWNGRADE_REFUSED', `${kind} schema downgrade requires an exact compatible recovery anchor`);
  const relevant = migrations.filter((migration) => migration.kind === kind);
  if (to === from) {
    if (relevant.length !== 0) throw new LifecyclePlanError('MIGRATION_CHAIN_INVALID', `${kind} migration chain is unexpected for unchanged schema`);
    return;
  }
  if (relevant.length !== to - from) {
    throw new LifecyclePlanError('MIGRATION_CHAIN_INVALID', `${kind} migration chain is incomplete`);
  }
  for (let version = from; version < to; version += 1) {
    const expected = relevant[version - from];
    if (!expected || expected.fromVersion !== version || expected.toVersion !== version + 1) {
      throw new LifecyclePlanError('MIGRATION_CHAIN_INVALID', `${kind} migration chain does not match the historical expected shape`);
    }
  }
}

function validatePreservation(policy: PreservationPolicy): void {
  if (policy.projects !== 'PRESERVE_REFERENCES') {
    throw new LifecyclePlanError('PROJECT_POLICY_INVALID', 'Project contents are never lifecycle-owned deletion targets');
  }
  const values = Object.values(policy);
  if (values.some((value) => typeof value !== 'string')) {
    throw new LifecyclePlanError('PRESERVATION_POLICY_INVALID', 'Preservation choices must be explicit');
  }
}

function validateRelativePayloadPath(value: string): void {
  const normalized = path.posix.normalize(value);
  if (!value || value !== normalized || value.startsWith('/') || value.includes('\\')
    || value.split('/').includes('..') || normalized === '.') {
    throw new LifecyclePlanError('ANCHOR_PAYLOAD_INVALID', 'Recovery payload path is not canonical and relative');
  }
}

function anchorIdentity(anchor: RecoveryAnchor): Record<string, unknown> {
  const { anchorDigest: _anchorDigest, ...identity } = anchor;
  return identity;
}

export function createRecoveryAnchor(input: {
  anchorId: string;
  createdAt: string;
  manifest: InstallationManifest;
  payloads: RecoveryPayloadIdentity[];
}): RecoveryAnchor {
  if (!SAFE_ID.test(input.anchorId) || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new LifecyclePlanError('ANCHOR_INVALID', 'Recovery anchor identity is invalid');
  }
  const manifest = validateInstallationManifest(input.manifest);
  const payloads = input.payloads.map((payload) => {
    validateRelativePayloadPath(payload.relativePath);
    if (!Number.isSafeInteger(payload.sizeBytes) || payload.sizeBytes < 0 || !SHA256.test(payload.digest)) {
      throw new LifecyclePlanError('ANCHOR_PAYLOAD_INVALID', 'Recovery payload identity is invalid');
    }
    return { ...payload };
  });
  const paths = payloads.map((payload) => payload.relativePath);
  if (paths.some((value, index) => index > 0 && (paths[index - 1] ?? '') >= value)) {
    throw new LifecyclePlanError('ANCHOR_PAYLOAD_INVALID', 'Recovery payloads must be sorted and unique');
  }
  const identity = {
    schemaVersion: 1 as const,
    anchorId: input.anchorId,
    createdAt: input.createdAt,
    manifest,
    manifestDigest: installationManifestDigest(manifest),
    payloads,
  };
  return { ...identity, anchorDigest: hash(identity) };
}

export function verifyRecoveryAnchor(value: RecoveryAnchor): RecoveryAnchor {
  const expectedManifestDigest = installationManifestDigest(validateInstallationManifest(value.manifest));
  if (value.schemaVersion !== 1 || !SAFE_ID.test(value.anchorId) || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new LifecyclePlanError('ANCHOR_INVALID', 'Recovery anchor schema/identity is invalid');
  }
  for (const payload of value.payloads) {
    validateRelativePayloadPath(payload.relativePath);
    if (!Number.isSafeInteger(payload.sizeBytes) || payload.sizeBytes < 0 || !SHA256.test(payload.digest)) {
      throw new LifecyclePlanError('ANCHOR_PAYLOAD_INVALID', 'Recovery payload identity is invalid');
    }
  }
  const paths = value.payloads.map((payload) => payload.relativePath);
  if (paths.some((pathValue, index) => index > 0 && (paths[index - 1] ?? '') >= pathValue)) {
    throw new LifecyclePlanError('ANCHOR_PAYLOAD_INVALID', 'Recovery payloads must be sorted and unique');
  }
  if (value.manifestDigest !== expectedManifestDigest || value.anchorDigest !== hash(anchorIdentity(value))) {
    throw new LifecyclePlanError('ANCHOR_DIGEST_MISMATCH', 'Recovery anchor digest does not match its content');
  }
  return value;
}

function targetMatchesManifest(target: TargetRelease, current: InstallationManifest): boolean {
  return target.productVersion === current.productVersion
    && target.sourceCommit === current.sourceCommit
    && target.releaseDigest === current.releaseDigest
    && target.configSchemaVersion === current.configSchemaVersion
    && target.stateSchemaVersion === current.stateSchemaVersion
    && JSON.stringify(target.components) === JSON.stringify(current.components);
}

function stepsFor(request: LifecyclePlanRequest, noOp: boolean): LifecycleStep[] {
  if (noOp) return [{ sequence: 1, kind: 'VERIFY_EXISTING_IDENTITY', mutation: false }];
  let kinds: Array<[LifecycleStepKind, boolean]>;
  switch (request.action) {
    case 'INSTALL':
      kinds = [
        ['VERIFY_PRECONDITIONS', false],
        ['TRANSITION_COMPONENTS', true],
        ['VERIFY_STARTUP_REGISTRATION', true],
        ['VERIFY_FINAL_IDENTITY_AND_HEALTH', false],
      ];
      break;
    case 'UPGRADE':
      kinds = [
        ['VERIFY_PRECONDITIONS', false],
        ['CREATE_RECOVERY_ANCHOR', true],
        ['MIGRATE_CONFIGURATION', true],
        ['MIGRATE_STATE', true],
        ['TRANSITION_COMPONENTS', true],
        ['VERIFY_STARTUP_REGISTRATION', true],
        ['VERIFY_FINAL_IDENTITY_AND_HEALTH', false],
      ];
      break;
    case 'REPAIR':
      kinds = [
        ['VERIFY_PRECONDITIONS', false],
        ['RECONCILE_COMPONENTS', true],
        ['VERIFY_STARTUP_REGISTRATION', true],
        ['VERIFY_FINAL_IDENTITY_AND_HEALTH', false],
      ];
      break;
    case 'ROLLBACK':
      kinds = [
        ['VERIFY_PRECONDITIONS', false],
        ['RESTORE_RECOVERY_ANCHOR', true],
        ['TRANSITION_COMPONENTS', true],
        ['VERIFY_STARTUP_REGISTRATION', true],
        ['VERIFY_FINAL_IDENTITY_AND_HEALTH', false],
      ];
      break;
    case 'UNINSTALL':
      kinds = [
        ['VERIFY_PRECONDITIONS', false],
        ['REMOVE_APPLICATION_COMPONENTS', true],
        ...(request.removeData && request.removeData.length > 0 ? [['REMOVE_SELECTED_DATA' as const, true] as [LifecycleStepKind, boolean]] : []),
        ['VERIFY_FINAL_IDENTITY_AND_HEALTH', false],
      ];
      break;
    case 'REINSTALL':
      kinds = [
        ['VERIFY_PRECONDITIONS', false],
        ['REFUSE_DUPLICATE_AUTHORITY', false],
        ['REFUSE_STALE_REGISTRATIONS', false],
        ['TRANSITION_COMPONENTS', true],
        ['VERIFY_STARTUP_REGISTRATION', true],
        ['VERIFY_FINAL_IDENTITY_AND_HEALTH', false],
      ];
      break;
  }
  return kinds.map(([kind, mutation], index) => ({ sequence: index + 1, kind, mutation }));
}

export function buildLifecyclePlan(
  currentInput: InstallationManifest | null,
  request: LifecyclePlanRequest,
): LifecyclePlan {
  if (!SAFE_ID.test(request.operationId)) {
    throw new LifecyclePlanError('OPERATION_ID_INVALID', 'Lifecycle operation id is invalid');
  }
  if (request.authorityState !== 'VALID') {
    throw new LifecyclePlanError('AUTHORITY_STATE_UNSAFE', 'Unknown or malformed authority state cannot be repaired or migrated by guessing');
  }
  validatePreservation(request.preservation);
  const current = currentInput ? validateInstallationManifest(currentInput) : null;
  const target = request.target ? validateTarget(request.target) : null;
  const removeData = [...new Set(request.removeData ?? [])].sort() as DataCategory[];
  const allowedData: DataCategory[] = ['PROJECTS', 'EVIDENCE', 'MODELS', 'CREDENTIALS', 'BACKUPS', 'LOCAL_STATE', 'CACHE'];
  if (removeData.some((category) => !allowedData.includes(category))) {
    throw new LifecyclePlanError('REMOVE_DATA_INVALID', 'Unknown data removal category');
  }
  if (removeData.includes('PROJECTS')) {
    throw new LifecyclePlanError('PROJECT_DELETE_REFUSED', 'Lifecycle uninstall never deletes enrolled project contents');
  }
  if (request.action !== 'UNINSTALL' && removeData.length > 0) {
    throw new LifecyclePlanError('REMOVE_DATA_INVALID', 'Data removal choices are valid only for uninstall');
  }

  let noOp = false;
  let recoveryAnchorRequired = false;
  let rollbackAnchor: RecoveryAnchor | null = null;

  if (request.action === 'INSTALL') {
    if (!target) throw new LifecyclePlanError('TARGET_REQUIRED', 'Install requires a target release');
    if (current?.lifecycleState === 'INSTALLED') {
      if (!targetMatchesManifest(target, current)) {
        throw new LifecyclePlanError('INSTALLATION_EXISTS', 'A different installation already exists; use upgrade or repair');
      }
      noOp = true;
    } else if (current) {
      throw new LifecyclePlanError('INSTALL_STATE_INVALID', 'Install cannot adopt an existing non-installed identity; use reinstall');
    }
  } else {
    if (!current) throw new LifecyclePlanError('INSTALLATION_REQUIRED', `${request.action} requires an existing installation manifest`);
  }

  if (request.action === 'UPGRADE') {
    if (!target || !current) throw new LifecyclePlanError('TARGET_REQUIRED', 'Upgrade requires current and target identities');
    if (current.lifecycleState !== 'INSTALLED') throw new LifecyclePlanError('INSTALL_STATE_INVALID', 'Upgrade requires an INSTALLED identity');
    if (compareVersion(target.productVersion, current.productVersion) <= 0) {
      throw new LifecyclePlanError('UPGRADE_VERSION_INVALID', 'Upgrade target must be newer than the installed version');
    }
    validateMigrationChain('CONFIG', current.configSchemaVersion, target.configSchemaVersion, target.migrations);
    validateMigrationChain('STATE', current.stateSchemaVersion, target.stateSchemaVersion, target.migrations);
    recoveryAnchorRequired = true;
  }

  if (request.action === 'REPAIR' && current && !['INSTALLED', 'REPAIR_REQUIRED'].includes(current.lifecycleState)) {
    throw new LifecyclePlanError('REPAIR_STATE_INVALID', 'Repair requires an installed or repair-required identity');
  }

  if (request.action === 'ROLLBACK') {
    if (!target || !current) throw new LifecyclePlanError('TARGET_REQUIRED', 'Rollback requires current and target identities');
    if (compareVersion(target.productVersion, current.productVersion) >= 0) {
      throw new LifecyclePlanError('ROLLBACK_VERSION_INVALID', 'Rollback target must be older than the installed version');
    }
    if (!request.rollbackAnchor) {
      throw new LifecyclePlanError('ROLLBACK_ANCHOR_REQUIRED', 'Rollback requires an exact compatible recovery anchor');
    }
    rollbackAnchor = verifyRecoveryAnchor(request.rollbackAnchor);
    const anchorManifest = rollbackAnchor.manifest;
    if (!targetMatchesManifest(target, anchorManifest)
      || anchorManifest.configSchemaVersion !== target.configSchemaVersion
      || anchorManifest.stateSchemaVersion !== target.stateSchemaVersion) {
      throw new LifecyclePlanError('ROLLBACK_ANCHOR_INCOMPATIBLE', 'Rollback lacks an exact compatible recovery anchor for the target release/schema');
    }
  }

  if (request.action === 'UNINSTALL' && current?.lifecycleState !== 'INSTALLED') {
    throw new LifecyclePlanError('UNINSTALL_STATE_INVALID', 'Uninstall requires an INSTALLED identity');
  }

  if (request.action === 'REINSTALL') {
    if (!current || current.lifecycleState !== 'UNINSTALLED') {
      throw new LifecyclePlanError('REINSTALL_STATE_INVALID', 'Reinstall requires an existing UNINSTALLED identity');
    }
    if (!target) throw new LifecyclePlanError('TARGET_REQUIRED', 'Reinstall requires a target release');
  }

  const destructiveChoices = removeData.map((category) => `REMOVE_DATA:${category}`);
  const identity = {
    schemaVersion: 1 as const,
    action: request.action,
    operationId: request.operationId,
    currentManifestDigest: current ? installationManifestDigest(current) : null,
    target,
    preservation: request.preservation,
    removeData,
    destructiveChoices,
    recoveryAnchorRequired,
    rollbackAnchor,
    noOp,
    steps: stepsFor(request, noOp),
  };
  return {
    ...identity,
    digest: hash(identity),
    authorized: false,
  };
}

export function approveLifecyclePlan(plan: LifecyclePlan, consent: LifecycleConsent): AuthorizedLifecyclePlan {
  const actualDigest = hash(planIdentity(plan));
  if (actualDigest !== plan.digest || consent.expectedPlanDigest !== plan.digest) {
    throw new LifecyclePlanError('PLAN_IDENTITY_MISMATCH', 'Lifecycle plan digest does not match the reviewed plan');
  }
  if (!consent.accepted) {
    throw new LifecyclePlanError('OWNER_CONSENT_REQUIRED', 'Owner consent is required before lifecycle mutation');
  }
  const approved = [...new Set(consent.approvedDestructiveChoices)].sort();
  const missing = plan.destructiveChoices.filter((choice) => !approved.includes(choice));
  const unexpected = approved.filter((choice) => !plan.destructiveChoices.includes(choice));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new LifecyclePlanError('DESTRUCTIVE_CONSENT_INVALID', `Destructive choices were not approved exactly; missing=${missing.join(',')} unexpected=${unexpected.join(',')}`);
  }
  return {
    ...plan,
    authorized: true,
    consentDigest: hash({ approvedDestructiveChoices: approved, planDigest: plan.digest }),
  };
}
