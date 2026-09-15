import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInstallationManifest,
  installationManifestDigest,
  type InstallationManifest,
} from '../../src/lifecycle/manifest.js';
import {
  approveLifecyclePlan,
  buildLifecyclePlan,
  createRecoveryAnchor,
  type AuthorizedLifecyclePlan,
  type LifecyclePlan,
  type LifecycleStep,
  type RecoveryAnchor,
  type RecoveryPayloadIdentity,
  type TargetRelease,
} from '../../src/lifecycle/planner.js';
import {
  FilesystemLifecycleStore,
  LifecycleCoordinator,
  LifecycleDriverError,
  type LifecycleDriver,
  type LifecyclePreflight,
} from '../../src/lifecycle/engine.js';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const shaC = 'c'.repeat(64);
const gitA = '1'.repeat(40);
const gitB = '2'.repeat(40);

function currentManifest(overrides: Partial<InstallationManifest> = {}): InstallationManifest {
  return createInstallationManifest({
    schemaVersion: 1,
    installationId: '123e4567-e89b-42d3-a456-426614174000',
    lifecycleState: 'INSTALLED',
    productVersion: '0.1.0',
    sourceCommit: gitA,
    releaseDigest: shaA,
    configSchemaVersion: 1,
    stateSchemaVersion: 1,
    installedAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    components: ['control-center', 'executor', 'gateway'],
    integrations: {
      providers: {
        kiro: { state: 'DEFERRED_ENTITLEMENT' },
        copilot: { state: 'DEFERRED_ENTITLEMENT' },
        ollama: { state: 'CONFIGURED' },
      },
      ide: { state: 'UPSTREAM_P7_PENDING' },
      github: { state: 'CONFIGURED', selectedRepositories: ['Herman/QuaranGate'] },
    },
    roots: {
      install: '/opt/quarangate',
      state: '/var/lib/quarangate',
      evidence: '/var/lib/quarangate/evidence',
      models: '/var/lib/quarangate/models',
      backups: '/var/lib/quarangate/backups',
      cache: '/var/cache/quarangate',
    },
    runtimeIdentities: [{
      component: 'gateway',
      reference: `quarangate-gateway:git-${gitA}`,
      digest: `sha256:${shaA}`,
    }],
    migrations: [
      {
        id: 'config-0-to-1',
        kind: 'CONFIG',
        fromVersion: 0,
        toVersion: 1,
        digest: shaC,
      },
      {
        id: 'state-0-to-1',
        kind: 'STATE',
        fromVersion: 0,
        toVersion: 1,
        digest: shaB,
      },
    ],
    startupRegistrations: [{
      id: 'quarangate-user-startup',
      mechanism: 'WINDOWS_TASK_SCHEDULER_WSL',
      identityDigest: shaB,
      enabled: true,
    }],
    clientRegistrations: [{
      id: 'chatgpt',
      generation: 1,
      authorityDigest: shaC,
      state: 'ACTIVE',
    }],
    sessionResumePolicy: {
      mutating: 'REFUSE_ON_SOURCE_DRIFT_NEW_SESSION_NO_INHERITED_AUTHORITY',
      readOnly: 'RE_ATTEST_REAUTHORIZE_NEW_GENERATION_ZERO_MUTATION_AUTHORITY',
      historicalMemory: 'CONTEXT_ONLY_NEVER_AUTHORITY',
    },
    health: { state: 'HEALTHY', verifiedAt: '2026-09-15T00:00:00.000Z' },
    ...overrides,
  });
}

function target(): TargetRelease {
  return {
    productVersion: '0.2.0',
    sourceCommit: gitB,
    releaseDigest: shaB,
    configSchemaVersion: 2,
    stateSchemaVersion: 2,
    components: ['control-center', 'executor', 'gateway'],
    migrations: [
      { id: 'config-1-to-2', kind: 'CONFIG', fromVersion: 1, toVersion: 2, digest: shaB },
      { id: 'state-1-to-2', kind: 'STATE', fromVersion: 1, toVersion: 2, digest: shaC },
    ],
  };
}

const preservation = {
  projects: 'PRESERVE_REFERENCES' as const,
  evidence: 'PRESERVE' as const,
  models: 'PRESERVE' as const,
  credentials: 'PRESERVE_OR_REAUTHORIZE' as const,
  backups: 'PRESERVE' as const,
  localState: 'PRESERVE' as const,
  cache: 'REMOVE' as const,
};

function authorize(plan: LifecyclePlan): AuthorizedLifecyclePlan {
  return approveLifecyclePlan(plan, {
    accepted: true,
    expectedPlanDigest: plan.digest,
    approvedDestructiveChoices: plan.destructiveChoices,
  });
}

function upgradedManifest(current: InstallationManifest, plan: LifecyclePlan): InstallationManifest {
  const release = plan.target!;
  const migrations = [...current.migrations, ...release.migrations].sort((a, b) =>
    `${a.kind}:${String(a.fromVersion).padStart(8, '0')}:${a.id}`.localeCompare(
      `${b.kind}:${String(b.fromVersion).padStart(8, '0')}:${b.id}`,
    ),
  );
  return createInstallationManifest({
    ...current,
    lifecycleState: plan.action === 'UNINSTALL' ? 'UNINSTALLED' : 'INSTALLED',
    productVersion: release.productVersion,
    sourceCommit: release.sourceCommit,
    releaseDigest: release.releaseDigest,
    configSchemaVersion: release.configSchemaVersion,
    stateSchemaVersion: release.stateSchemaVersion,
    updatedAt: '2026-09-15T00:05:00.000Z',
    components: release.components,
    migrations,
    health: {
      state: plan.action === 'UNINSTALL' ? 'NOT_RUNNING' : 'HEALTHY',
      verifiedAt: '2026-09-15T00:05:00.000Z',
    },
  });
}

class FakeDriver implements LifecycleDriver {
  readonly steps: string[] = [];
  failPreflight = false;
  failAt?: LifecycleStep['kind'];
  rollbackFails = false;
  rollbackVerifies = true;
  duplicateAuthority = false;
  staleRegistrations = false;
  preservationVerified = true;
  finalHealthy = true;
  restored = false;
  installTemplate = currentManifest();
  finalOverride?: (plan: AuthorizedLifecyclePlan, current: InstallationManifest | null) => InstallationManifest;

  async preflight(): Promise<LifecyclePreflight> {
    if (this.failPreflight) throw new LifecycleDriverError('PRECONDITION_FAILED', 'preflight failed', false);
    return {
      duplicateAuthority: this.duplicateAuthority,
      staleRegistrations: this.staleRegistrations,
      preservationVerified: this.preservationVerified,
    };
  }

  async captureRecoveryPayloads(): Promise<RecoveryPayloadIdentity[]> {
    return [
      { relativePath: 'install/config/clients.yaml', sizeBytes: 10, digest: shaB, mode: 0o600 },
      { relativePath: 'state/data/database.sqlite', sizeBytes: 20, digest: shaC, mode: 0o600 },
    ];
  }

  async executeStep(step: LifecycleStep): Promise<void> {
    this.steps.push(step.kind);
    if (this.failAt === step.kind) {
      throw new LifecycleDriverError('STEP_FAILED', `failed at ${step.kind}`, true);
    }
  }

  async finalManifest(plan: AuthorizedLifecyclePlan, current: InstallationManifest | null): Promise<InstallationManifest> {
    if (this.finalOverride) return this.finalOverride(plan, current);
    if (plan.action === 'UNINSTALL') {
      return createInstallationManifest({
        ...current!,
        lifecycleState: 'UNINSTALLED',
        updatedAt: '2026-09-15T00:05:00.000Z',
        health: { state: 'NOT_RUNNING', verifiedAt: '2026-09-15T00:05:00.000Z' },
      });
    }
    if (plan.action === 'REPAIR') {
      return createInstallationManifest({
        ...current!,
        lifecycleState: 'INSTALLED',
        updatedAt: '2026-09-15T00:05:00.000Z',
        health: { state: 'HEALTHY', verifiedAt: '2026-09-15T00:05:00.000Z' },
      });
    }
    return upgradedManifest(current ?? this.installTemplate, plan);
  }

  async verifyFinalState(): Promise<boolean> {
    return this.finalHealthy;
  }

  async restoreRecoveryAnchor(_anchor: RecoveryAnchor): Promise<void> {
    this.restored = true;
    if (this.rollbackFails) throw new LifecycleDriverError('ROLLBACK_FAILED', 'rollback failed', true);
  }

  async verifyRollback(): Promise<boolean> {
    return this.rollbackVerifies;
  }
}

function store(): FilesystemLifecycleStore {
  const root = join(mkdtempSync(join(tmpdir(), 'qg-p9-engine-')), 'state');
  return new FilesystemLifecycleStore(root);
}

describe('P9 D2 lifecycle execution integration', () => {
  it('installs into fresh state and writes a validated healthy identity', async () => {
    const storage = store();
    const plan = authorize(buildLifecyclePlan(null, {
      action: 'INSTALL',
      operationId: 'op-fresh-install',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('SUCCESS');
    expect(storage.loadManifest()?.sourceCommit).toBe(gitB);
    expect(storage.readJournal('op-fresh-install')?.state).toBe('SUCCESS');
    expect(storage.hasActiveLock()).toBe(false);
  });

  it('treats an identical install as a verified idempotent no-op', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'INSTALL',
      operationId: 'op-idempotent',
      target: {
        productVersion: current.productVersion,
        sourceCommit: current.sourceCommit,
        releaseDigest: current.releaseDigest,
        configSchemaVersion: current.configSchemaVersion,
        stateSchemaVersion: current.stateSchemaVersion,
        components: current.components,
        migrations: [],
      },
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('NO_MUTATION');
    expect(driver.steps).toEqual([]);
  });

  it('upgrades through migrations, a recovery anchor, and final health verification', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'op-upgrade-success',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('SUCCESS');
    expect(storage.loadRecoveryAnchor('anchor-op-upgrade-success').manifestDigest).toBe(installationManifestDigest(current));
    expect(storage.loadManifest()?.productVersion).toBe('0.2.0');
    expect(driver.steps).toEqual(expect.arrayContaining(['MIGRATE_CONFIGURATION', 'MIGRATE_STATE', 'TRANSITION_COMPONENTS']));
  });

  it('classifies preflight failure as NO_MUTATION', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'REPAIR',
      operationId: 'op-preflight-fail',
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    driver.failPreflight = true;
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('NO_MUTATION');
    expect(storage.loadManifest()).toEqual(current);
  });

  it('rolls back a failed partially-mutating upgrade and verifies the prior manifest', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'op-upgrade-rollback',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    driver.failAt = 'MIGRATE_STATE';
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('ROLLED_BACK');
    expect(driver.restored).toBe(true);
    expect(storage.loadManifest()).toEqual(current);
    expect(storage.hasActiveLock()).toBe(false);
  });

  it('retains the operation lock and returns UNCERTAIN when rollback cannot be proven', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'op-upgrade-uncertain',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    driver.failAt = 'TRANSITION_COMPONENTS';
    driver.rollbackVerifies = false;
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('UNCERTAIN');
    expect(storage.hasActiveLock()).toBe(true);
    expect(storage.readJournal('op-upgrade-uncertain')?.state).toBe('UNCERTAIN');
  });

  it('repairs recoverable component drift through the typed reconcile step', async () => {
    const storage = store();
    const current = currentManifest({ lifecycleState: 'REPAIR_REQUIRED' });
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'REPAIR',
      operationId: 'op-repair',
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('SUCCESS');
    expect(driver.steps).toContain('RECONCILE_COMPONENTS');
  });

  it('uninstalls components while preserving data unless selected removal was approved', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UNINSTALL',
      operationId: 'op-uninstall',
      preservation,
      removeData: [],
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('SUCCESS');
    expect(storage.loadManifest()?.lifecycleState).toBe('UNINSTALLED');
    expect(driver.steps).toContain('REMOVE_APPLICATION_COMPONENTS');
    expect(driver.steps).not.toContain('REMOVE_SELECTED_DATA');
  });

  it('refuses duplicate or stale authority before reinstall mutation', async () => {
    const storage = store();
    const current = currentManifest({ lifecycleState: 'UNINSTALLED' });
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'REINSTALL',
      operationId: 'op-reinstall-duplicate',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    driver.duplicateAuthority = true;
    driver.staleRegistrations = true;
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('NO_MUTATION');
    expect(result.errorCode).toBe('DUPLICATE_OR_STALE_AUTHORITY');
    expect(driver.steps).toEqual([]);
  });

  it('blocks before mutation when requested model/evidence preservation cannot be proven', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'op-preservation-blocked',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    driver.preservationVerified = false;
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result).toMatchObject({ state: 'NO_MUTATION', errorCode: 'PRESERVATION_UNPROVEN' });
    expect(driver.steps).toEqual([]);
  });

  it('allows explicit credential reauthorization but rolls back unsafe credential loss', async () => {
    const credentialed = currentManifest({
      integrations: {
        ...currentManifest().integrations,
        providers: {
          ...currentManifest().integrations.providers,
          kiro: { state: 'CONFIGURED', credentialReference: 'KIRO_TOKEN' },
        },
      },
    });

    const reauthStore = store();
    reauthStore.writeManifest(credentialed);
    const reauthPlan = authorize(buildLifecyclePlan(credentialed, {
      action: 'UPGRADE',
      operationId: 'op-credential-reauth',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const reauthDriver = new FakeDriver();
    reauthDriver.finalOverride = (plan, current) => createInstallationManifest({
      ...upgradedManifest(current!, plan),
      integrations: {
        ...current!.integrations,
        providers: {
          ...current!.integrations.providers,
          kiro: { state: 'REAUTHORIZATION_REQUIRED' },
        },
      },
    });
    expect((await new LifecycleCoordinator(reauthStore, reauthDriver).execute(reauthPlan)).state).toBe('SUCCESS');

    const unsafeStore = store();
    unsafeStore.writeManifest(credentialed);
    const unsafePlan = authorize(buildLifecyclePlan(credentialed, {
      action: 'UPGRADE',
      operationId: 'op-credential-loss',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const unsafeDriver = new FakeDriver();
    unsafeDriver.finalOverride = (plan, current) => createInstallationManifest({
      ...upgradedManifest(current!, plan),
      integrations: {
        ...current!.integrations,
        providers: {
          ...current!.integrations.providers,
          kiro: { state: 'DISABLED' },
        },
      },
    });
    const unsafe = await new LifecycleCoordinator(unsafeStore, unsafeDriver).execute(unsafePlan);
    expect(unsafe.state).toBe('ROLLED_BACK');
    expect(unsafe.errorCode).toBe('CREDENTIAL_LIFECYCLE_INVALID');
  });

  it('rolls back when final runtime identity/health verification fails', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'op-final-health-fail',
      target: target(),
      preservation,
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    driver.finalHealthy = false;
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('ROLLED_BACK');
    expect(result.errorCode).toBe('FINAL_VERIFICATION_FAILED');
  });

  it('executes selected data removal only after exact destructive consent', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UNINSTALL',
      operationId: 'op-uninstall-selected-data',
      preservation,
      removeData: ['CACHE', 'EVIDENCE'],
      authorityState: 'VALID',
    }));
    const driver = new FakeDriver();
    const result = await new LifecycleCoordinator(storage, driver).execute(plan);
    expect(result.state).toBe('SUCCESS');
    expect(driver.steps).toContain('REMOVE_SELECTED_DATA');
  });

  it('recovers an interrupted upgrade only through its verified anchor', async () => {
    const storage = store();
    const current = currentManifest();
    storage.writeManifest(current);
    const anchor = createRecoveryAnchor({
      anchorId: 'anchor-op-interrupted',
      createdAt: '2026-09-15T00:10:00.000Z',
      manifest: current,
      payloads: [{ relativePath: 'state/data/database.sqlite', sizeBytes: 20, digest: shaC, mode: 0o600 }],
    });
    storage.writeRecoveryAnchor(anchor);
    storage.acquireLock('op-interrupted');
    storage.writeJournal({
      schemaVersion: 1,
      operationId: 'op-interrupted',
      action: 'UPGRADE',
      planDigest: shaA,
      state: 'PARTIAL_MUTATION_RECOVERABLE',
      mutationStarted: true,
      anchorId: anchor.anchorId,
      updatedAt: '2026-09-15T00:11:00.000Z',
      errorCode: 'PROCESS_INTERRUPTED',
    });
    const driver = new FakeDriver();
    const result = await new LifecycleCoordinator(storage, driver).recoverInterruptedOperation('op-interrupted');
    expect(result.state).toBe('ROLLED_BACK');
    expect(driver.restored).toBe(true);
    expect(storage.hasActiveLock()).toBe(false);
  });
});
