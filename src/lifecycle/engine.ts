import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalSerialize } from '../executor/agents/canonicalJson.js';
import {
  installationManifestDigest,
  validateInstallationManifest,
  type InstallationManifest,
} from './manifest.js';
import {
  createRecoveryAnchor,
  verifyRecoveryAnchor,
  type AuthorizedLifecyclePlan,
  type LifecycleAction,
  type LifecycleStep,
  type RecoveryAnchor,
  type RecoveryPayloadIdentity,
} from './planner.js';
import { atomicWritePrivateFile, ensurePrivateDirectory, readPrivateFile } from './safeFilesystem.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type LifecycleOperationState =
  | 'MUTATING'
  | 'PARTIAL_MUTATION_RECOVERABLE'
  | 'NO_MUTATION'
  | 'ROLLED_BACK'
  | 'SUCCESS'
  | 'UNCERTAIN';

export interface LifecycleJournal {
  schemaVersion: 1;
  operationId: string;
  action: LifecycleAction;
  planDigest: string;
  state: LifecycleOperationState;
  mutationStarted: boolean;
  anchorId: string | null;
  updatedAt: string;
  errorCode: string | null;
}

export interface LifecyclePreflight {
  duplicateAuthority: boolean;
  staleRegistrations: boolean;
  preservationVerified: boolean;
}

export interface LifecycleDriver {
  preflight(plan: AuthorizedLifecyclePlan, current: InstallationManifest | null): Promise<LifecyclePreflight>;
  captureRecoveryPayloads(
    plan: AuthorizedLifecyclePlan,
    current: InstallationManifest,
  ): Promise<RecoveryPayloadIdentity[]>;
  executeStep(
    step: LifecycleStep,
    plan: AuthorizedLifecyclePlan,
    current: InstallationManifest | null,
    anchor: RecoveryAnchor | null,
  ): Promise<void>;
  finalManifest(
    plan: AuthorizedLifecyclePlan,
    current: InstallationManifest | null,
  ): Promise<InstallationManifest>;
  verifyFinalState(
    plan: AuthorizedLifecyclePlan,
    manifest: InstallationManifest,
  ): Promise<boolean>;
  restoreRecoveryAnchor(anchor: RecoveryAnchor): Promise<void>;
  verifyRollback(anchor: RecoveryAnchor): Promise<boolean>;
}

export interface LifecycleExecutionResult {
  state: 'NO_MUTATION' | 'ROLLED_BACK' | 'SUCCESS' | 'UNCERTAIN';
  operationId: string;
  errorCode?: string;
  anchorId?: string;
}

export class LifecycleDriverError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly mutationStarted: boolean,
  ) {
    super(message);
    this.name = 'LifecycleDriverError';
  }
}

function parseJournal(value: unknown): LifecycleJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LifecycleDriverError('JOURNAL_INVALID', 'Lifecycle journal is malformed', false);
  }
  const journal = value as Record<string, unknown>;
  const keys = [
    'action', 'anchorId', 'errorCode', 'mutationStarted', 'operationId',
    'planDigest', 'schemaVersion', 'state', 'updatedAt',
  ];
  const actualKeys = Object.keys(journal).sort();
  if (actualKeys.length !== keys.length || actualKeys.some((key, index) => key !== keys[index])) {
    throw new LifecycleDriverError('JOURNAL_INVALID', 'Lifecycle journal has unknown or missing fields', false);
  }
  const actions: LifecycleAction[] = ['INSTALL', 'UPGRADE', 'REPAIR', 'ROLLBACK', 'UNINSTALL', 'REINSTALL'];
  const states: LifecycleOperationState[] = ['MUTATING', 'PARTIAL_MUTATION_RECOVERABLE', 'NO_MUTATION', 'ROLLED_BACK', 'SUCCESS', 'UNCERTAIN'];
  if (journal.schemaVersion !== 1
    || typeof journal.operationId !== 'string'
    || !SAFE_ID.test(journal.operationId)
    || typeof journal.action !== 'string'
    || !actions.includes(journal.action as LifecycleAction)
    || typeof journal.planDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(journal.planDigest)
    || typeof journal.state !== 'string'
    || !states.includes(journal.state as LifecycleOperationState)
    || typeof journal.mutationStarted !== 'boolean'
    || (journal.anchorId !== null && (typeof journal.anchorId !== 'string' || !SAFE_ID.test(journal.anchorId)))
    || typeof journal.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(journal.updatedAt))
    || (journal.errorCode !== null && typeof journal.errorCode !== 'string')) {
    throw new LifecycleDriverError('JOURNAL_INVALID', 'Lifecycle journal validation failed', false);
  }
  return journal as unknown as LifecycleJournal;
}

export class FilesystemLifecycleStore {
  readonly stateRoot: string;
  readonly lifecycleRoot: string;

  constructor(stateRoot: string) {
    if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot || stateRoot === path.parse(stateRoot).root) {
      throw new LifecycleDriverError('STATE_ROOT_INVALID', 'Lifecycle state root must be canonical, absolute, and non-root', false);
    }
    this.stateRoot = stateRoot;
    this.lifecycleRoot = path.join(stateRoot, 'lifecycle');
  }

  private ensureRoot(): string {
    return ensurePrivateDirectory(this.lifecycleRoot);
  }

  writeManifest(manifest: InstallationManifest): void {
    const checked = validateInstallationManifest(manifest);
    atomicWritePrivateFile(this.ensureRoot(), 'manifest.json', canonicalSerialize(checked));
  }

  loadManifest(): InstallationManifest | null {
    const target = path.join(this.lifecycleRoot, 'manifest.json');
    if (!existsSync(target)) return null;
    return validateInstallationManifest(JSON.parse(readPrivateFile(this.lifecycleRoot, 'manifest.json').toString('utf8')));
  }

  writeJournal(journal: LifecycleJournal): void {
    const checked = parseJournal(journal);
    atomicWritePrivateFile(this.ensureRoot(), `operations/${checked.operationId}.json`, canonicalSerialize(checked));
  }

  readJournal(operationId: string): LifecycleJournal | null {
    if (!SAFE_ID.test(operationId)) throw new LifecycleDriverError('OPERATION_ID_INVALID', 'Operation id is invalid', false);
    const target = path.join(this.lifecycleRoot, 'operations', `${operationId}.json`);
    if (!existsSync(target)) return null;
    return parseJournal(JSON.parse(readPrivateFile(this.lifecycleRoot, `operations/${operationId}.json`).toString('utf8')));
  }

  writeRecoveryAnchor(anchorInput: RecoveryAnchor): void {
    const anchor = verifyRecoveryAnchor(anchorInput);
    atomicWritePrivateFile(this.ensureRoot(), `anchors/${anchor.anchorId}.json`, canonicalSerialize(anchor));
  }

  loadRecoveryAnchor(anchorId: string): RecoveryAnchor {
    if (!SAFE_ID.test(anchorId)) throw new LifecycleDriverError('ANCHOR_ID_INVALID', 'Recovery anchor id is invalid', false);
    const target = path.join(this.lifecycleRoot, 'anchors', `${anchorId}.json`);
    if (!existsSync(target)) throw new LifecycleDriverError('ANCHOR_NOT_FOUND', 'Recovery anchor was not found', false);
    return verifyRecoveryAnchor(JSON.parse(readPrivateFile(this.lifecycleRoot, `anchors/${anchorId}.json`).toString('utf8')) as RecoveryAnchor);
  }

  acquireLock(operationId: string): void {
    if (!SAFE_ID.test(operationId)) throw new LifecycleDriverError('OPERATION_ID_INVALID', 'Operation id is invalid', false);
    const directory = ensurePrivateDirectory(path.join(this.ensureRoot(), 'locks'));
    const target = path.join(directory, 'active.lock');
    let fd: number | undefined;
    try {
      fd = openSync(target, 'wx', 0o600);
      writeSync(fd, Buffer.from(operationId, 'utf8'));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      throw new LifecycleDriverError('LIFECYCLE_BUSY', 'Another lifecycle operation is active or uncertain', false);
    }
  }

  releaseLock(operationId: string): void {
    const target = path.join(this.lifecycleRoot, 'locks', 'active.lock');
    if (!existsSync(target)) return;
    const owner = readPrivateFile(this.lifecycleRoot, 'locks/active.lock', 1024).toString('utf8');
    if (owner !== operationId) {
      throw new LifecycleDriverError('LOCK_OWNER_MISMATCH', 'Lifecycle lock belongs to another operation', false);
    }
    unlinkSync(target);
  }

  hasActiveLock(): boolean {
    return existsSync(path.join(this.lifecycleRoot, 'locks', 'active.lock'));
  }
}

function errorCode(error: unknown): string {
  if (error instanceof LifecycleDriverError) return error.code;
  return 'UNCLASSIFIED_LIFECYCLE_FAILURE';
}

function providerCredentialInvariant(current: InstallationManifest | null, result: InstallationManifest): void {
  if (!current) return;
  for (const name of ['kiro', 'copilot', 'ollama'] as const) {
    const before = current.integrations.providers[name];
    const after = result.integrations.providers[name];
    if (before.state === 'CONFIGURED' && before.credentialReference) {
      const preserved = after.state === 'CONFIGURED' && after.credentialReference === before.credentialReference;
      const reauthorize = after.state === 'REAUTHORIZATION_REQUIRED' && after.credentialReference === undefined;
      if (!preserved && !reauthorize) {
        throw new LifecycleDriverError('CREDENTIAL_LIFECYCLE_INVALID', `${name} credential must be preserved by reference or require explicit reauthorization`, true);
      }
    }
  }
}

function verifyResultIdentity(
  plan: AuthorizedLifecyclePlan,
  current: InstallationManifest | null,
  resultInput: InstallationManifest,
): InstallationManifest {
  const result = validateInstallationManifest(resultInput);
  if (result.installationId !== (current?.installationId ?? result.installationId)) {
    throw new LifecycleDriverError('INSTALLATION_IDENTITY_CHANGED', 'Lifecycle operation changed installation identity', true);
  }
  if (plan.action === 'UNINSTALL') {
    if (!current || result.lifecycleState !== 'UNINSTALLED' || result.sourceCommit !== current.sourceCommit) {
      throw new LifecycleDriverError('UNINSTALL_IDENTITY_INVALID', 'Uninstall result identity is invalid', true);
    }
    if (result.health.state !== 'NOT_RUNNING') {
      throw new LifecycleDriverError('UNINSTALL_HEALTH_INVALID', 'Uninstalled product must be explicitly not running', true);
    }
  } else if (plan.action === 'REPAIR') {
    if (!current
      || result.productVersion !== current.productVersion
      || result.sourceCommit !== current.sourceCommit
      || result.releaseDigest !== current.releaseDigest
      || result.lifecycleState !== 'INSTALLED') {
      throw new LifecycleDriverError('REPAIR_IDENTITY_INVALID', 'Repair may not guess or replace release identity', true);
    }
  } else if (plan.target) {
    if (result.productVersion !== plan.target.productVersion
      || result.sourceCommit !== plan.target.sourceCommit
      || result.releaseDigest !== plan.target.releaseDigest
      || result.configSchemaVersion !== plan.target.configSchemaVersion
      || result.stateSchemaVersion !== plan.target.stateSchemaVersion
      || JSON.stringify(result.components) !== JSON.stringify(plan.target.components)
      || result.lifecycleState !== 'INSTALLED') {
      throw new LifecycleDriverError('FINAL_IDENTITY_MISMATCH', 'Final runtime identity does not match the reviewed target release', true);
    }
  }
  if (plan.action !== 'UNINSTALL' && result.health.state !== 'HEALTHY') {
    throw new LifecycleDriverError('FINAL_HEALTH_FAILED', 'Lifecycle result is not healthy', true);
  }
  providerCredentialInvariant(current, result);
  return result;
}

export class LifecycleCoordinator {
  constructor(
    private readonly store: FilesystemLifecycleStore,
    private readonly driver: LifecycleDriver,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private journal(
    plan: AuthorizedLifecyclePlan,
    state: LifecycleOperationState,
    mutationStarted: boolean,
    anchorId: string | null,
    failure: string | null,
  ): LifecycleJournal {
    return {
      schemaVersion: 1,
      operationId: plan.operationId,
      action: plan.action,
      planDigest: plan.digest,
      state,
      mutationStarted,
      anchorId,
      updatedAt: this.now(),
      errorCode: failure,
    };
  }

  async execute(plan: AuthorizedLifecyclePlan): Promise<LifecycleExecutionResult> {
    if (!plan.authorized || !plan.consentDigest) {
      throw new LifecycleDriverError('OWNER_CONSENT_REQUIRED', 'Lifecycle plan is not authorized', false);
    }
    const current = this.store.loadManifest();
    const currentDigest = current ? installationManifestDigest(current) : null;
    if (currentDigest !== plan.currentManifestDigest) {
      throw new LifecycleDriverError('STALE_INSTALLATION_IDENTITY', 'Installed identity changed after plan review', false);
    }

    this.store.acquireLock(plan.operationId);
    let mutationStarted = false;
    let anchor: RecoveryAnchor | null = null;
    try {
      if (plan.noOp) {
        if (!current || !(await this.driver.verifyFinalState(plan, current))) {
          throw new LifecycleDriverError('FINAL_VERIFICATION_FAILED', 'Existing installation identity/health could not be verified', false);
        }
        this.store.writeJournal(this.journal(plan, 'NO_MUTATION', false, null, null));
        this.store.releaseLock(plan.operationId);
        return { state: 'NO_MUTATION', operationId: plan.operationId };
      }

      this.store.writeJournal(this.journal(plan, 'MUTATING', false, null, null));
      const preflight = await this.driver.preflight(plan, current);
      if (!preflight.preservationVerified) {
        throw new LifecycleDriverError('PRESERVATION_UNPROVEN', 'Requested preservation policy could not be verified', false);
      }
      if (preflight.duplicateAuthority || preflight.staleRegistrations) {
        throw new LifecycleDriverError('DUPLICATE_OR_STALE_AUTHORITY', 'Duplicate authority or stale registrations were detected; refusing mutation', false);
      }

      if (plan.recoveryAnchorRequired) {
        if (!current) throw new LifecycleDriverError('RECOVERY_ANCHOR_SOURCE_MISSING', 'Upgrade recovery anchor requires current state', false);
        const payloads = await this.driver.captureRecoveryPayloads(plan, current);
        anchor = createRecoveryAnchor({
          anchorId: `anchor-${plan.operationId}`,
          createdAt: this.now(),
          manifest: current,
          payloads,
        });
        this.store.writeRecoveryAnchor(anchor);
      } else if (plan.rollbackAnchor) {
        anchor = plan.rollbackAnchor;
      }

      for (const step of plan.steps) {
        if (!step.mutation || step.kind === 'CREATE_RECOVERY_ANCHOR') continue;
        mutationStarted = true;
        this.store.writeJournal(this.journal(plan, 'PARTIAL_MUTATION_RECOVERABLE', true, anchor?.anchorId ?? null, null));
        await this.driver.executeStep(step, plan, current, anchor);
      }

      const result = verifyResultIdentity(plan, current, await this.driver.finalManifest(plan, current));
      if (!(await this.driver.verifyFinalState(plan, result))) {
        throw new LifecycleDriverError('FINAL_VERIFICATION_FAILED', 'Post-operation runtime identity or health verification failed', true);
      }
      this.store.writeManifest(result);
      this.store.writeJournal(this.journal(plan, 'SUCCESS', mutationStarted, anchor?.anchorId ?? null, null));
      this.store.releaseLock(plan.operationId);
      return {
        state: 'SUCCESS',
        operationId: plan.operationId,
        ...(anchor ? { anchorId: anchor.anchorId } : {}),
      };
    } catch (error) {
      const code = errorCode(error);
      const driverMutated = error instanceof LifecycleDriverError ? error.mutationStarted : mutationStarted;
      const mayHaveMutated = mutationStarted || driverMutated;
      if (!mayHaveMutated) {
        this.store.writeJournal(this.journal(plan, 'NO_MUTATION', false, anchor?.anchorId ?? null, code));
        this.store.releaseLock(plan.operationId);
        return { state: 'NO_MUTATION', operationId: plan.operationId, errorCode: code };
      }

      if (anchor && plan.action === 'UPGRADE') {
        try {
          await this.driver.restoreRecoveryAnchor(anchor);
          if (!(await this.driver.verifyRollback(anchor))) {
            throw new LifecycleDriverError('ROLLBACK_UNVERIFIED', 'Rollback state could not be verified', true);
          }
          this.store.writeManifest(anchor.manifest);
          this.store.writeJournal(this.journal(plan, 'ROLLED_BACK', true, anchor.anchorId, code));
          this.store.releaseLock(plan.operationId);
          return { state: 'ROLLED_BACK', operationId: plan.operationId, errorCode: code, anchorId: anchor.anchorId };
        } catch (rollbackError) {
          const rollbackCode = errorCode(rollbackError);
          this.store.writeJournal(this.journal(plan, 'UNCERTAIN', true, anchor.anchorId, rollbackCode));
          return { state: 'UNCERTAIN', operationId: plan.operationId, errorCode: rollbackCode, anchorId: anchor.anchorId };
        }
      }

      this.store.writeJournal(this.journal(plan, 'UNCERTAIN', true, anchor?.anchorId ?? null, code));
      return {
        state: 'UNCERTAIN',
        operationId: plan.operationId,
        errorCode: code,
        ...(anchor ? { anchorId: anchor.anchorId } : {}),
      };
    }
  }

  async recoverInterruptedOperation(operationId: string): Promise<LifecycleExecutionResult> {
    const journal = this.store.readJournal(operationId);
    if (!journal || !['MUTATING', 'PARTIAL_MUTATION_RECOVERABLE', 'UNCERTAIN'].includes(journal.state)) {
      throw new LifecycleDriverError('NO_INTERRUPTED_OPERATION', 'No interrupted lifecycle operation requires recovery', false);
    }
    if (!journal.anchorId) {
      this.store.writeJournal({ ...journal, state: 'UNCERTAIN', updatedAt: this.now(), errorCode: 'RECOVERY_ANCHOR_MISSING' });
      return { state: 'UNCERTAIN', operationId, errorCode: 'RECOVERY_ANCHOR_MISSING' };
    }
    try {
      const anchor = this.store.loadRecoveryAnchor(journal.anchorId);
      await this.driver.restoreRecoveryAnchor(anchor);
      if (!(await this.driver.verifyRollback(anchor))) {
        throw new LifecycleDriverError('ROLLBACK_UNVERIFIED', 'Interrupted operation rollback could not be verified', true);
      }
      this.store.writeManifest(anchor.manifest);
      this.store.writeJournal({ ...journal, state: 'ROLLED_BACK', updatedAt: this.now(), errorCode: 'PROCESS_INTERRUPTED' });
      this.store.releaseLock(operationId);
      return { state: 'ROLLED_BACK', operationId, errorCode: 'PROCESS_INTERRUPTED', anchorId: anchor.anchorId };
    } catch (error) {
      const code = errorCode(error);
      this.store.writeJournal({ ...journal, state: 'UNCERTAIN', updatedAt: this.now(), errorCode: code });
      return { state: 'UNCERTAIN', operationId, errorCode: code, anchorId: journal.anchorId };
    }
  }
}
