import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveInstallPlan,
  buildInstallPlan,
  type AuthorizedInstallPlan,
  type HostFacts,
  type InstallerAnswers,
} from '../../src/installer/productInstaller.js';
import { executeProductionInstall } from '../../src/installer/productionInstaller.js';
import {
  createReleasePackageManifest,
  releaseSignaturePayload,
  type ReleasePackageFile,
} from '../../src/installer/releasePackage.js';
import {
  FilesystemLifecycleStore,
  LifecycleCoordinator,
  LifecycleDriverError,
} from '../../src/lifecycle/engine.js';
import {
  createInstallationManifest,
  installationManifestDigest,
  type InstallationManifest,
  type MigrationRecord,
} from '../../src/lifecycle/manifest.js';
import {
  approveLifecyclePlan,
  buildLifecyclePlan,
  createRecoveryAnchor,
  type AuthorizedLifecyclePlan,
  type LifecyclePlan,
  type TargetRelease,
} from '../../src/lifecycle/planner.js';
import {
  initializeProductionOwnedRoots,
  ProductionLifecycleDriver,
  type AuthorityInspection,
  type ProductionLifecyclePlatform,
  type RuntimeInspection,
  type TrustedReleaseBundle,
} from '../../src/lifecycle/productionDriver.js';
import { atomicWritePrivateFile } from '../../src/lifecycle/safeFilesystem.js';

const oldDigest = '0'.repeat(64);
const oldGit = '1'.repeat(40);
const newGit = '2'.repeat(40);
const now = () => '2026-09-15T02:00:00.000Z';
const gib = 1024 ** 3;

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Fixture {
  base: string;
  roots: InstallationManifest['roots'];
  project: string;
  packageRoot: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), 'qg-p9-production-'));
  const state = path.join(base, 'owned');
  const roots = {
    install: path.join(base, 'app'),
    state,
    evidence: path.join(state, 'evidence'),
    models: path.join(state, 'models'),
    backups: path.join(state, 'backups'),
    cache: path.join(base, 'cache'),
  };
  const project = path.join(base, 'projects', 'customer');
  const packageRoot = path.join(base, 'release');
  for (const directory of [...Object.values(roots), project, packageRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  return { base, roots, project, packageRoot };
}

function migrationBytes(
  id: string,
  kind: 'CONFIG' | 'STATE',
  set: Record<string, string>,
): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    id,
    kind,
    fromVersion: 0,
    toVersion: 1,
    set,
    remove: [],
  }));
}

function release(fx: Fixture): {
  bundle: TrustedReleaseBundle;
  target: TargetRelease;
  migrations: MigrationRecord[];
} {
  const payloads = new Map<string, Buffer>([
    ['app/runtime.txt', Buffer.from('new-runtime')],
    ['migrations/config/config-0-to-1.json', migrationBytes('config-0-to-1', 'CONFIG', { migrated: 'yes' })],
    ['migrations/state/state-0-to-1.json', migrationBytes('state-0-to-1', 'STATE', { migrated: 'yes' })],
  ]);
  const files: ReleasePackageFile[] = [...payloads.entries()].map(([relative, bytes]) => {
    const target = path.join(fx.packageRoot, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
    return { path: relative, sizeBytes: bytes.length, digest: hash(bytes), mode: 0o644 };
  });
  const migrations: MigrationRecord[] = [
    {
      id: 'config-0-to-1',
      kind: 'CONFIG',
      fromVersion: 0,
      toVersion: 1,
      digest: files.find((file) => file.path.includes('/config/'))!.digest,
    },
    {
      id: 'state-0-to-1',
      kind: 'STATE',
      fromVersion: 0,
      toVersion: 1,
      digest: files.find((file) => file.path.includes('/state/'))!.digest,
    },
  ];
  const manifest = createReleasePackageManifest({
    schemaVersion: 1,
    productVersion: '1.0.0',
    sourceCommit: newGit,
    createdAt: '2026-09-15T01:00:00.000Z',
    architecture: 'WINDOWS_NATIVE_WIZARD_WSL_NODE_LIFECYCLE',
    signing: 'DEFERRED_EXTERNAL_OWNER_CREDENTIAL',
    lifecycle: {
      configSchemaVersion: 1,
      stateSchemaVersion: 1,
      components: ['gateway'],
      migrations,
    },
    files,
    images: [{
      component: 'gateway',
      reference: `quarangate-gateway:git-${newGit}`,
      digest: `sha256:${'a'.repeat(64)}`,
    }],
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signatureProof = {
    schemaVersion: 1 as const,
    algorithm: 'Ed25519' as const,
    keyId: 'test-release-key',
    manifestDigest: manifest.manifestDigest,
    signedAt: '2026-09-15T01:01:00.000Z',
    signature: sign(null, releaseSignaturePayload(manifest), privateKey).toString('base64'),
  };
  const bundle = {
    payloadRoot: fx.packageRoot,
    manifest,
    signatureProof,
    trustedKeys: [{
      keyId: 'test-release-key',
      algorithm: 'Ed25519' as const,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }],
  };
  return {
    bundle,
    migrations,
    target: {
      productVersion: manifest.productVersion,
      sourceCommit: manifest.sourceCommit,
      releaseDigest: manifest.manifestDigest,
      configSchemaVersion: 1,
      stateSchemaVersion: 1,
      components: ['gateway'],
      migrations,
    },
  };
}

function currentManifest(fx: Fixture, overrides: Partial<InstallationManifest> = {}): InstallationManifest {
  return createInstallationManifest({
    schemaVersion: 1,
    installationId: '123e4567-e89b-42d3-a456-426614174000',
    lifecycleState: 'INSTALLED',
    productVersion: '0.9.0',
    sourceCommit: oldGit,
    releaseDigest: oldDigest,
    configSchemaVersion: 0,
    stateSchemaVersion: 0,
    installedAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    components: ['gateway'],
    integrations: {
      providers: {
        kiro: { state: 'DEFERRED_ENTITLEMENT' },
        copilot: { state: 'DEFERRED_ENTITLEMENT' },
        ollama: { state: 'CONFIGURED' },
      },
      ide: { state: 'UPSTREAM_P7_PENDING' },
      github: { state: 'DISABLED' },
    },
    roots: fx.roots,
    runtimeIdentities: [{
      component: 'gateway',
      reference: `quarangate-gateway:git-${oldGit}`,
      digest: `sha256:${'b'.repeat(64)}`,
    }],
    migrations: [],
    startupRegistrations: [],
    clientRegistrations: [{
      id: 'owner-control-center',
      generation: 1,
      authorityDigest: 'c'.repeat(64),
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

function seedInstalledState(manifest: InstallationManifest): void {
  initializeProductionOwnedRoots(manifest);
  atomicWritePrivateFile(manifest.roots.install, 'app/runtime.txt', Buffer.from('old-runtime'));
  atomicWritePrivateFile(manifest.roots.state, 'config/schema.json', Buffer.from(JSON.stringify({
    schemaVersion: 0,
    appliedMigrations: [],
    values: { retained: 'config' },
  })));
  atomicWritePrivateFile(manifest.roots.state, 'data/schema.json', Buffer.from(JSON.stringify({
    schemaVersion: 0,
    appliedMigrations: [],
    values: { retained: 'state' },
  })));
}

class RecordingPlatform implements ProductionLifecyclePlatform {
  duplicateAuthority = false;
  staleRegistrations = false;
  running = false;
  opened = false;
  runtime?: InstallationManifest;
  failStart?: () => void;
  readonly calls: string[] = [];

  constructor(current?: InstallationManifest) {
    if (current) {
      this.runtime = current;
      this.running = current.lifecycleState === 'INSTALLED';
    }
  }

  async inspectAuthority(): Promise<AuthorityInspection> {
    this.calls.push('inspectAuthority');
    return {
      duplicateAuthority: this.duplicateAuthority,
      staleRegistrations: this.staleRegistrations,
    };
  }

  async reconcileStartup(): Promise<void> {
    this.calls.push('reconcileStartup');
  }

  async removeStartup(): Promise<void> {
    this.calls.push('removeStartup');
  }

  async startRuntime(manifest: InstallationManifest): Promise<void> {
    this.calls.push('startRuntime');
    this.runtime = manifest;
    this.running = true;
    this.failStart?.();
  }

  async stopRuntime(): Promise<void> {
    this.calls.push('stopRuntime');
    this.running = false;
  }

  async inspectRuntime(): Promise<RuntimeInspection> {
    this.calls.push('inspectRuntime');
    return this.running && this.runtime
      ? {
          running: true,
          healthy: true,
          sourceCommit: this.runtime.sourceCommit,
          releaseDigest: this.runtime.releaseDigest,
          runtimeIdentities: this.runtime.runtimeIdentities,
        }
      : {
          running: false,
          healthy: false,
          sourceCommit: null,
          releaseDigest: null,
          runtimeIdentities: [],
        };
  }

  async openControlCenter(url: 'http://127.0.0.1:8787'): Promise<void> {
    this.calls.push(`openControlCenter:${url}`);
    this.opened = true;
  }
}

const preservation = {
  projects: 'PRESERVE_REFERENCES' as const,
  evidence: 'PRESERVE' as const,
  models: 'PRESERVE' as const,
  credentials: 'PRESERVE_OR_REAUTHORIZE' as const,
  backups: 'PRESERVE' as const,
  localState: 'PRESERVE' as const,
  cache: 'PRESERVE' as const,
};

function authorize(plan: LifecyclePlan): AuthorizedLifecyclePlan {
  return approveLifecyclePlan(plan, {
    accepted: true,
    expectedPlanDigest: plan.digest,
    approvedDestructiveChoices: plan.destructiveChoices,
  });
}

function readyFacts(): HostFacts {
  return {
    platform: 'wsl',
    platformVersion: '2',
    wslDistribution: 'Ubuntu-24.04',
    wslVersion: 2,
    docker: { available: true, version: '29.7.2', daemonReachable: true },
    compose: { available: true, version: '5.5.0' },
    git: { available: true, version: '2.43.0' },
    node: { available: true, version: '24.20.0' },
    cpuCores: 8,
    memoryBytes: 32 * gib,
    storageBytesFree: 200 * gib,
    filesystem: { supportsAtomicRename: true, caseSensitive: true, installRootIsSymlink: false },
    gpu: { present: false },
  };
}

function installAnswers(fx: Fixture, releaseIdentity: InstallerAnswers['release']): InstallerAnswers {
  return {
    schemaVersion: 1,
    host: readyFacts(),
    profile: 'RECOMMENDED',
    release: releaseIdentity,
    installRoot: fx.roots.install,
    roots: {
      state: fx.roots.state,
      evidence: fx.roots.evidence,
      models: fx.roots.models,
      backups: fx.roots.backups,
      cache: fx.roots.cache,
    },
    projects: [{ id: 'customer', path: fx.project, access: 'READ_ONLY' }],
    providers: {
      kiro: { state: 'DEFERRED_ENTITLEMENT' },
      copilot: { state: 'DEFERRED_ENTITLEMENT' },
      ollama: { state: 'CONFIGURED' },
    },
    localAi: {
      profile: 'EFFICIENT',
      model: { id: 'qwen3.5:4b-q4_K_M', runtime: 'ollama', contextTokens: 32768 },
      limits: { cpuCores: 2, memoryBytes: 4 * gib, vramBytes: 0 },
    },
    ide: { state: 'UPSTREAM_P7_PENDING' },
    github: { enabled: false },
    remote: { enabled: false },
    clientPermissions: ['READ_FILES', 'INSPECT_OPERATIONS'],
    startup: { enabled: false },
    backup: {
      profile: 'RECOMMENDED',
      location: fx.roots.backups,
      include: ['CONFIG', 'PROJECT_REFERENCES', 'DURABLE_STATE'],
      includeCredentials: false,
    },
  };
}

function authorizeInstall(answers: InstallerAnswers): AuthorizedInstallPlan {
  const plan = buildInstallPlan(answers);
  return approveInstallPlan(plan, {
    accepted: true,
    expectedPlanDigest: plan.digest,
    approvedSensitiveChoices: plan.requiredConsents,
  });
}

describe('P9 production lifecycle driver', () => {
  it('executes typed upgrade, config/state migration, component transition, anchor capture, and final identity', async () => {
    const fx = fixture();
    const current = currentManifest(fx);
    seedInstalledState(current);
    const storage = new FilesystemLifecycleStore(current.roots.state);
    storage.writeManifest(current);
    const next = release(fx);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'production-upgrade',
      target: next.target,
      preservation,
      authorityState: 'VALID',
    }));
    const platform = new RecordingPlatform(current);
    const driver = new ProductionLifecycleDriver({
      projectRoots: [{ id: 'customer', path: fx.project }],
      platform,
      release: next.bundle,
      installTemplate: current,
      now,
    });

    const result = await new LifecycleCoordinator(storage, driver, now).execute(plan);
    expect(result.state).toBe('SUCCESS');
    expect(readFileSync(path.join(fx.roots.install, 'app/runtime.txt'), 'utf8')).toBe('new-runtime');
    expect(JSON.parse(readFileSync(path.join(fx.roots.state, 'config/schema.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 1, values: { retained: 'config', migrated: 'yes' } });
    expect(JSON.parse(readFileSync(path.join(fx.roots.state, 'data/schema.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 1, values: { retained: 'state', migrated: 'yes' } });
    expect(storage.loadManifest()).toMatchObject({
      productVersion: '1.0.0',
      sourceCommit: newGit,
      releaseDigest: next.bundle.manifest.manifestDigest,
    });
    expect(storage.loadRecoveryAnchor('anchor-production-upgrade').payloads.length).toBeGreaterThan(0);
    expect(platform.calls).toEqual(expect.arrayContaining(['startRuntime', 'reconcileStartup', 'inspectRuntime']));
  });

  it('returns UNCERTAIN when a captured recovery payload is corrupted before rollback', async () => {
    const fx = fixture();
    const current = currentManifest(fx);
    seedInstalledState(current);
    const storage = new FilesystemLifecycleStore(current.roots.state);
    storage.writeManifest(current);
    const next = release(fx);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'production-corrupt-anchor',
      target: next.target,
      preservation,
      authorityState: 'VALID',
    }));
    const platform = new RecordingPlatform(current);
    platform.failStart = () => {
      writeFileSync(
        path.join(fx.roots.backups, 'anchors', 'anchor-production-corrupt-anchor', 'payloads', 'install', 'app', 'runtime.txt'),
        'tampered',
      );
      throw new Error('runtime transition failed');
    };
    const driver = new ProductionLifecycleDriver({
      projectRoots: [{ id: 'customer', path: fx.project }],
      platform,
      release: next.bundle,
      installTemplate: current,
      now,
    });

    const result = await new LifecycleCoordinator(storage, driver, now).execute(plan);
    expect(result).toMatchObject({
      state: 'UNCERTAIN',
      errorCode: 'RECOVERY_PAYLOAD_INTEGRITY_FAILED',
    });
    expect(storage.hasActiveLock()).toBe(true);
  });

  it('uninstalls application files, removes only selected owned data, and preserves customer projects', async () => {
    const fx = fixture();
    const current = currentManifest(fx);
    seedInstalledState(current);
    atomicWritePrivateFile(fx.roots.evidence, 'audit.json', Buffer.from('{}'));
    writeFileSync(path.join(fx.project, 'customer.txt'), 'preserve me');
    const storage = new FilesystemLifecycleStore(current.roots.state);
    storage.writeManifest(current);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UNINSTALL',
      operationId: 'production-uninstall',
      preservation,
      removeData: ['EVIDENCE'],
      authorityState: 'VALID',
    }));
    const platform = new RecordingPlatform(current);
    const driver = new ProductionLifecycleDriver({
      projectRoots: [{ id: 'customer', path: fx.project }],
      platform,
      installTemplate: current,
      now,
    });

    expect((await new LifecycleCoordinator(storage, driver, now).execute(plan)).state).toBe('SUCCESS');
    expect(existsSync(path.join(fx.roots.install, 'app/runtime.txt'))).toBe(false);
    expect(existsSync(path.join(fx.roots.evidence, 'audit.json'))).toBe(false);
    expect(readFileSync(path.join(fx.project, 'customer.txt'), 'utf8')).toBe('preserve me');
    expect(platform.calls).toEqual(expect.arrayContaining(['stopRuntime', 'removeStartup']));
  });

  it('refuses reinstall through the real driver when authority inspection finds duplicates', async () => {
    const fx = fixture();
    const uninstalled = currentManifest(fx, {
      lifecycleState: 'UNINSTALLED',
      health: { state: 'NOT_RUNNING', verifiedAt: '2026-09-15T00:00:00.000Z' },
    });
    seedInstalledState(uninstalled);
    const storage = new FilesystemLifecycleStore(uninstalled.roots.state);
    storage.writeManifest(uninstalled);
    const next = release(fx);
    const plan = authorize(buildLifecyclePlan(uninstalled, {
      action: 'REINSTALL',
      operationId: 'production-reinstall-duplicate',
      target: next.target,
      preservation,
      authorityState: 'VALID',
    }));
    const platform = new RecordingPlatform();
    platform.duplicateAuthority = true;
    const driver = new ProductionLifecycleDriver({
      projectRoots: [{ id: 'customer', path: fx.project }],
      platform,
      release: next.bundle,
      installTemplate: uninstalled,
      now,
    });

    const result = await new LifecycleCoordinator(storage, driver, now).execute(plan);
    expect(result).toMatchObject({ state: 'NO_MUTATION', errorCode: 'DUPLICATE_OR_STALE_AUTHORITY' });
    expect(readFileSync(path.join(fx.roots.install, 'app/runtime.txt'), 'utf8')).toBe('old-runtime');
  });

  it('restores an interrupted real-driver operation only from verified payload bytes', async () => {
    const fx = fixture();
    const current = currentManifest(fx);
    seedInstalledState(current);
    const storage = new FilesystemLifecycleStore(current.roots.state);
    storage.writeManifest(current);
    const next = release(fx);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'production-interrupted',
      target: next.target,
      preservation,
      authorityState: 'VALID',
    }));
    const platform = new RecordingPlatform(current);
    const driver = new ProductionLifecycleDriver({
      projectRoots: [{ id: 'customer', path: fx.project }],
      platform,
      release: next.bundle,
      installTemplate: current,
      now,
    });
    const payloads = await driver.captureRecoveryPayloads(plan, current);
    const anchor = createRecoveryAnchor({
      anchorId: 'anchor-production-interrupted',
      createdAt: now(),
      manifest: current,
      payloads,
    });
    storage.writeRecoveryAnchor(anchor);
    storage.acquireLock(plan.operationId);
    storage.writeJournal({
      schemaVersion: 1,
      operationId: plan.operationId,
      action: 'UPGRADE',
      planDigest: plan.digest,
      state: 'PARTIAL_MUTATION_RECOVERABLE',
      mutationStarted: true,
      anchorId: anchor.anchorId,
      updatedAt: now(),
      errorCode: 'PROCESS_INTERRUPTED',
    });
    writeFileSync(path.join(fx.roots.install, 'app/runtime.txt'), 'partial-new-state');

    const result = await new LifecycleCoordinator(storage, driver, now)
      .recoverInterruptedOperation(plan.operationId);
    expect(result.state).toBe('ROLLED_BACK');
    expect(readFileSync(path.join(fx.roots.install, 'app/runtime.txt'), 'utf8')).toBe('old-runtime');
    expect(storage.loadManifest()).toEqual(current);
  });

  it('refuses a stale installation identity before the production driver can execute', async () => {
    const fx = fixture();
    const current = currentManifest(fx);
    seedInstalledState(current);
    const storage = new FilesystemLifecycleStore(current.roots.state);
    storage.writeManifest(current);
    const next = release(fx);
    const plan = authorize(buildLifecyclePlan(current, {
      action: 'UPGRADE',
      operationId: 'production-stale',
      target: next.target,
      preservation,
      authorityState: 'VALID',
    }));
    storage.writeManifest(createInstallationManifest({
      ...current,
      updatedAt: '2026-09-15T00:30:00.000Z',
      health: { ...current.health, verifiedAt: '2026-09-15T00:30:00.000Z' },
    }));
    const platform = new RecordingPlatform(current);
    const driver = new ProductionLifecycleDriver({
      projectRoots: [{ id: 'customer', path: fx.project }],
      platform,
      release: next.bundle,
      installTemplate: current,
      now,
    });

    await expect(new LifecycleCoordinator(storage, driver, now).execute(plan))
      .rejects.toMatchObject<Partial<LifecycleDriverError>>({ code: 'STALE_INSTALLATION_IDENTITY' });
    expect(platform.calls).toEqual([]);
  });

  it('contains no generic shell or caller-selected command execution surface', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../../src/lifecycle/productionDriver.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/child_process|execSync|execFile|spawn|shell\s*:/u);
    expect(source).not.toMatch(/docker\.sock|--privileged|Invoke-Expression|sh\s+-c/u);
  });
});

describe('P9 production install-plan consumer', () => {
  it('executes a cryptographically bound install and opens Control Center only after verified health', async () => {
    const fx = fixture();
    const next = release(fx);
    const authorized = authorizeInstall(installAnswers(fx, {
      state: 'VERIFIED_RELEASE',
      productVersion: next.bundle.manifest.productVersion,
      sourceCommit: next.bundle.manifest.sourceCommit,
      manifestDigest: next.bundle.manifest.manifestDigest,
    }));
    const platform = new RecordingPlatform();
    const result = await executeProductionInstall({
      operationId: 'production-install',
      installationId: '123e4567-e89b-42d3-a456-426614174001',
      authorizedPlan: authorized,
      release: { bundle: next.bundle },
    }, platform, now);

    expect(result).toMatchObject({ state: 'SUCCESS', controlCenterOpened: true });
    expect(platform.opened).toBe(true);
    expect(platform.calls.indexOf('inspectRuntime')).toBeLessThan(
      platform.calls.indexOf('openControlCenter:http://127.0.0.1:8787'),
    );
    const stored = new FilesystemLifecycleStore(fx.roots.state).loadManifest();
    expect(stored?.releaseDigest).toBe(next.bundle.manifest.manifestDigest);
  });

  it('refuses tampered plan bytes and a source-wizard release-gate plan before mutation', async () => {
    const fx = fixture();
    const next = release(fx);
    const verified = authorizeInstall(installAnswers(fx, {
      state: 'VERIFIED_RELEASE',
      productVersion: next.bundle.manifest.productVersion,
      sourceCommit: next.bundle.manifest.sourceCommit,
      manifestDigest: next.bundle.manifest.manifestDigest,
    }));
    const tampered = {
      ...verified,
      plan: { ...verified.plan, installRoot: path.join(fx.base, 'different-root') },
    };
    await expect(executeProductionInstall({
      operationId: 'tampered-install',
      installationId: '123e4567-e89b-42d3-a456-426614174002',
      authorizedPlan: tampered,
      release: { bundle: next.bundle },
    }, new RecordingPlatform(), now)).rejects.toThrow(/reviewed plan|digest/iu);

    const unsigned = authorizeInstall(installAnswers(fx, { state: 'RELEASE_GATE_PENDING' }));
    await expect(executeProductionInstall({
      operationId: 'unsigned-install',
      installationId: '123e4567-e89b-42d3-a456-426614174003',
      authorizedPlan: unsigned,
      release: { bundle: next.bundle },
    }, new RecordingPlatform(), now)).rejects.toMatchObject<Partial<LifecycleDriverError>>({
      code: 'PACKAGE_APPLY_DEFERRED_RELEASE_GATE',
    });
    expect(existsSync(path.join(fx.roots.state, 'lifecycle', 'manifest.json'))).toBe(false);
  });
});
