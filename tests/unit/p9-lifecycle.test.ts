import { describe, expect, it } from 'vitest';
import {
  createInstallationManifest,
  installationManifestDigest,
  validateInstallationManifest,
  type InstallationManifest,
} from '../../src/lifecycle/manifest.js';
import {
  approveLifecyclePlan,
  buildLifecyclePlan,
  createRecoveryAnchor,
  verifyRecoveryAnchor,
  type LifecyclePlanRequest,
} from '../../src/lifecycle/planner.js';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const shaC = 'c'.repeat(64);
const gitA = '1'.repeat(40);
const gitB = '2'.repeat(40);

function manifest(overrides: Partial<InstallationManifest> = {}): InstallationManifest {
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
      reference: 'quarangate-gateway:git-1111111111111111111111111111111111111111',
      digest: `sha256:${shaB}`,
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
    health: {
      state: 'HEALTHY',
      verifiedAt: '2026-09-15T00:00:00.000Z',
    },
    ...overrides,
  });
}

function upgradeRequest(overrides: Partial<LifecyclePlanRequest> = {}): LifecyclePlanRequest {
  return {
    action: 'UPGRADE',
    operationId: 'op-upgrade-001',
    target: {
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
    },
    preservation: {
      projects: 'PRESERVE_REFERENCES',
      evidence: 'PRESERVE',
      models: 'PRESERVE',
      credentials: 'PRESERVE_OR_REAUTHORIZE',
      backups: 'PRESERVE',
      localState: 'PRESERVE',
      cache: 'REMOVE',
    },
    authorityState: 'VALID',
    ...overrides,
  };
}

describe('P9 D2 installation identity', () => {
  it('validates a deterministic versioned manifest with no credential material', () => {
    const first = manifest();
    const second = validateInstallationManifest(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
    expect(installationManifestDigest(first)).toBe(installationManifestDigest(second));
    expect(JSON.stringify(first)).not.toMatch(/token|password|secret-value/u);
  });

  it('fails closed on unknown fields, malformed hashes, and unsorted identity sets', () => {
    expect(() => validateInstallationManifest({ ...manifest(), unexpected: true })).toThrow(/unrecognized|unknown/i);
    expect(() => validateInstallationManifest({ ...manifest(), releaseDigest: 'bad' })).toThrow(/validation/i);
    expect(() => validateInstallationManifest({ ...manifest(), components: ['gateway', 'executor'] })).toThrow(/sorted/i);
    expect(() => validateInstallationManifest({
      ...manifest(),
      migrations: manifest().migrations.filter((migration) => migration.kind !== 'STATE'),
    })).toThrow(/migration history/u);
  });

  it('records ODR-2 hybrid resume semantics as context policy, never authority', () => {
    const value = manifest();
    expect(value.sessionResumePolicy.mutating).toMatch(/REFUSE_ON_SOURCE_DRIFT/u);
    expect(value.sessionResumePolicy.readOnly).toMatch(/RE_ATTEST_REAUTHORIZE/u);
    expect(value.sessionResumePolicy.historicalMemory).toBe('CONTEXT_ONLY_NEVER_AUTHORITY');
  });

  it('rejects raw credential fields in provider state', () => {
    const unsafe = JSON.parse(JSON.stringify(manifest()));
    unsafe.integrations.providers.kiro = {
      state: 'CONFIGURED',
      credentialReference: 'KIRO_TOKEN',
      secret: 'secret-value',
    };
    expect(() => validateInstallationManifest(unsafe)).toThrow(/unrecognized|unknown/i);
  });
});

describe('P9 D2 plan before mutation', () => {
  it('creates a deterministic supported upgrade plan with a mandatory recovery anchor', () => {
    const current = manifest();
    const first = buildLifecyclePlan(current, upgradeRequest());
    const second = buildLifecyclePlan(current, upgradeRequest());
    expect(first.digest).toBe(second.digest);
    expect(first.recoveryAnchorRequired).toBe(true);
    expect(first.steps[0]?.kind).toBe('VERIFY_PRECONDITIONS');
    expect(first.steps.some((step) => step.kind === 'CREATE_RECOVERY_ANCHOR')).toBe(true);
    expect(first.steps.at(-1)?.kind).toBe('VERIFY_FINAL_IDENTITY_AND_HEALTH');
    expect(first.authorized).toBe(false);
  });

  it('sequences fresh-install runtime configuration before the first runtime start', () => {
    const target = upgradeRequest().target!;
    const plan = buildLifecyclePlan(null, {
      action: 'INSTALL',
      operationId: 'op-fresh-install',
      target: { ...target, configSchemaVersion: 1, stateSchemaVersion: 1 },
      preservation: upgradeRequest().preservation,
      authorityState: 'VALID',
    });
    expect(plan.noOp).toBe(false);
    expect(plan.recoveryAnchorRequired).toBe(false);
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'VERIFY_PRECONDITIONS',
      'TRANSITION_COMPONENTS',
      'MATERIALIZE_RUNTIME_CONFIG',
      'START_RUNTIME',
      'VERIFY_STARTUP_REGISTRATION',
      'VERIFY_FINAL_IDENTITY_AND_HEALTH',
    ]);
  });

  it('requires exact migration chains and refuses malformed or partial migrations', () => {
    const current = manifest();
    expect(() => buildLifecyclePlan(current, upgradeRequest({
      target: {
        ...upgradeRequest().target!,
        migrations: [{ id: 'config-skip', kind: 'CONFIG', fromVersion: 0, toVersion: 2, digest: shaB }],
      },
    }))).toThrow(/migration chain/u);
  });

  it('binds consent to the immutable plan and all destructive choices', () => {
    const plan = buildLifecyclePlan(manifest(), upgradeRequest());
    expect(() => approveLifecyclePlan(plan, {
      accepted: true,
      expectedPlanDigest: shaA,
      approvedDestructiveChoices: plan.destructiveChoices,
    })).toThrow(/plan digest/u);
    expect(approveLifecyclePlan(plan, {
      accepted: true,
      expectedPlanDigest: plan.digest,
      approvedDestructiveChoices: plan.destructiveChoices,
    }).authorized).toBe(true);
  });

  it('makes uninstall preserve data by default and selected removal explicit', () => {
    const preserve = buildLifecyclePlan(manifest(), {
      action: 'UNINSTALL',
      operationId: 'op-uninstall-preserve',
      preservation: upgradeRequest().preservation,
      removeData: [],
      authorityState: 'VALID',
    });
    expect(preserve.destructiveChoices).toEqual([]);
    expect(preserve.steps.some((step) => step.kind === 'REMOVE_APPLICATION_COMPONENTS')).toBe(true);
    expect(preserve.steps.some((step) => step.kind === 'REMOVE_SELECTED_DATA')).toBe(false);

    const remove = buildLifecyclePlan(manifest(), {
      action: 'UNINSTALL',
      operationId: 'op-uninstall-remove',
      preservation: upgradeRequest().preservation,
      removeData: ['CACHE', 'EVIDENCE'],
      authorityState: 'VALID',
    });
    expect(remove.destructiveChoices).toEqual(['REMOVE_DATA:CACHE', 'REMOVE_DATA:EVIDENCE']);
    expect(remove.steps.some((step) => step.kind === 'REMOVE_SELECTED_DATA')).toBe(true);
  });

  it('refuses repair when authority metadata is unknown or malformed', () => {
    expect(() => buildLifecyclePlan(manifest(), {
      action: 'REPAIR',
      operationId: 'op-repair-unsafe',
      preservation: upgradeRequest().preservation,
      authorityState: 'UNKNOWN_OR_MALFORMED',
    })).toThrow(/authority state/u);
  });

  it('refuses incompatible downgrade without an exact compatible anchor', () => {
    const current = manifest({
      productVersion: '0.2.0',
      sourceCommit: gitB,
      releaseDigest: shaB,
      configSchemaVersion: 2,
      stateSchemaVersion: 2,
      migrations: [
        manifest().migrations[0]!,
        upgradeRequest().target!.migrations[0]!,
        manifest().migrations[1]!,
        upgradeRequest().target!.migrations[1]!,
      ],
    });
    expect(() => buildLifecyclePlan(current, {
      action: 'ROLLBACK',
      operationId: 'op-rollback-unsafe',
      target: {
        productVersion: '0.1.0',
        sourceCommit: gitA,
        releaseDigest: shaA,
        configSchemaVersion: 1,
        stateSchemaVersion: 1,
        components: ['control-center', 'executor', 'gateway'],
        migrations: [],
      },
      preservation: upgradeRequest().preservation,
      authorityState: 'VALID',
    })).toThrow(/compatible recovery anchor/u);
  });

  it('allows reinstall only from an uninstalled identity and always re-attests registrations', () => {
    expect(() => buildLifecyclePlan(manifest(), {
      action: 'REINSTALL',
      operationId: 'op-reinstall-wrong-state',
      target: upgradeRequest().target,
      preservation: upgradeRequest().preservation,
      authorityState: 'VALID',
    })).toThrow(/UNINSTALLED/u);

    const plan = buildLifecyclePlan(manifest({ lifecycleState: 'UNINSTALLED' }), {
      action: 'REINSTALL',
      operationId: 'op-reinstall',
      target: upgradeRequest().target,
      preservation: upgradeRequest().preservation,
      authorityState: 'VALID',
    });
    expect(plan.steps.some((step) => step.kind === 'REFUSE_DUPLICATE_AUTHORITY')).toBe(true);
    expect(plan.steps.some((step) => step.kind === 'REFUSE_STALE_REGISTRATIONS')).toBe(true);
  });

  it('permits only an exact anchor-backed supported rollback', () => {
    const old = manifest();
    const current = manifest({
      productVersion: '0.2.0',
      sourceCommit: gitB,
      releaseDigest: shaB,
      configSchemaVersion: 2,
      stateSchemaVersion: 2,
      migrations: [
        manifest().migrations[0]!,
        upgradeRequest().target!.migrations[0]!,
        manifest().migrations[1]!,
        upgradeRequest().target!.migrations[1]!,
      ],
    });
    const anchor = createRecoveryAnchor({
      anchorId: 'anchor-supported-rollback',
      createdAt: '2026-09-15T00:02:00.000Z',
      manifest: old,
      payloads: [{ relativePath: 'state/data/database.sqlite', sizeBytes: 200, digest: shaC, mode: 0o600 }],
    });
    const plan = buildLifecyclePlan(current, {
      action: 'ROLLBACK',
      operationId: 'op-supported-rollback',
      target: {
        productVersion: old.productVersion,
        sourceCommit: old.sourceCommit,
        releaseDigest: old.releaseDigest,
        configSchemaVersion: old.configSchemaVersion,
        stateSchemaVersion: old.stateSchemaVersion,
        components: old.components,
        migrations: [],
      },
      preservation: upgradeRequest().preservation,
      authorityState: 'VALID',
      rollbackAnchor: anchor,
    });
    expect(plan.steps.some((step) => step.kind === 'RESTORE_RECOVERY_ANCHOR')).toBe(true);
    expect(plan.rollbackAnchor?.anchorDigest).toBe(anchor.anchorDigest);
  });

  it('treats cancelled lifecycle consent as NO AUTHORITY to mutate', () => {
    const plan = buildLifecyclePlan(manifest(), upgradeRequest());
    expect(() => approveLifecyclePlan(plan, {
      accepted: false,
      expectedPlanDigest: plan.digest,
      approvedDestructiveChoices: [],
    })).toThrow(/consent/u);
  });

  it('represents an identical install as an idempotent no-op', () => {
    const current = manifest();
    const plan = buildLifecyclePlan(current, {
      action: 'INSTALL',
      operationId: 'op-install-idempotent',
      target: {
        productVersion: current.productVersion,
        sourceCommit: current.sourceCommit,
        releaseDigest: current.releaseDigest,
        configSchemaVersion: current.configSchemaVersion,
        stateSchemaVersion: current.stateSchemaVersion,
        components: current.components,
        migrations: [],
      },
      preservation: upgradeRequest().preservation,
      authorityState: 'VALID',
    });
    expect(plan.noOp).toBe(true);
    expect(plan.steps).toEqual([{ sequence: 1, kind: 'VERIFY_EXISTING_IDENTITY', mutation: false }]);
  });
});

describe('P9 D2 recovery anchor integrity', () => {
  it('binds the prior manifest and bounded payload identities', () => {
    const current = manifest();
    const anchor = createRecoveryAnchor({
      anchorId: 'anchor-001',
      createdAt: '2026-09-15T00:01:00.000Z',
      manifest: current,
      payloads: [
        { relativePath: 'install/config/clients.yaml', sizeBytes: 100, digest: shaB, mode: 0o600 },
        { relativePath: 'state/data/database.sqlite', sizeBytes: 200, digest: shaC, mode: 0o600 },
      ],
    });
    expect(verifyRecoveryAnchor(anchor)).toEqual(anchor);
    expect(anchor.manifestDigest).toBe(installationManifestDigest(current));
  });

  it('refuses a copied anchor whose integrity metadata no longer matches', () => {
    const anchor = createRecoveryAnchor({
      anchorId: 'anchor-002',
      createdAt: '2026-09-15T00:01:00.000Z',
      manifest: manifest(),
      payloads: [{ relativePath: 'install/config/bridge.yaml', sizeBytes: 50, digest: shaB, mode: 0o600 }],
    });
    expect(() => verifyRecoveryAnchor({
      ...anchor,
      payloads: [{ ...anchor.payloads[0]!, digest: shaC }],
    })).toThrow(/anchor digest/u);
  });
});
