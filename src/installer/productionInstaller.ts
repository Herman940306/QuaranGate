import { createHash } from 'node:crypto';
import { canonicalSerialize } from '../executor/agents/canonicalJson.js';
import {
  createInstallationManifest,
  type InstallationManifest,
} from '../lifecycle/manifest.js';
import {
  FilesystemLifecycleStore,
  LifecycleCoordinator,
  LifecycleDriverError,
  type LifecycleExecutionResult,
} from '../lifecycle/engine.js';
import {
  approveLifecyclePlan,
  buildLifecyclePlan,
  type TargetRelease,
} from '../lifecycle/planner.js';
import {
  assertFreshInstallRootsAvailable,
  ProductionLifecycleDriver,
  type ProductionLifecyclePlatform,
  type TrustedReleaseBundle,
} from '../lifecycle/productionDriver.js';
import {
  verifyAuthorizedInstallPlan,
  type AuthorizedInstallPlan,
} from './productInstaller.js';
import { verifyTrustedReleaseBundle } from '../lifecycle/productionDriver.js';
import type { ReleaseTrustPolicy, VerifiedReleasePackage } from './releasePackage.js';

export interface ProductionInstallRelease {
  bundle: TrustedReleaseBundle;
}

export interface ProductionInstallRequest {
  operationId: string;
  installationId: string;
  authorizedPlan: AuthorizedInstallPlan;
  release: ProductionInstallRelease;
}

export interface ProductionInstallResult extends LifecycleExecutionResult {
  controlCenterOpened: boolean;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalSerialize(value)).digest('hex');
}

function providerState(
  choice: AuthorizedInstallPlan['plan']['providers']['kiro'],
): { state: 'CONFIGURED' | 'DEFERRED_ENTITLEMENT' | 'DISABLED'; credentialReference?: string } {
  return choice.state === 'CONFIGURED' && choice.credential
    ? { state: choice.state, credentialReference: choice.credential.reference }
    : { state: choice.state };
}

function installManifest(
  request: ProductionInstallRequest,
  verified: VerifiedReleasePackage,
  now: string,
): InstallationManifest {
  const authorized = verifyAuthorizedInstallPlan(request.authorizedPlan);
  const plan = authorized.plan;
  if (verified.manifest.manifestDigest !== request.release.bundle.manifest.manifestDigest) {
    throw new LifecycleDriverError('RELEASE_IDENTITY_INVALID', 'Verified release identity changed unexpectedly', false);
  }
  const components = [...verified.manifest.lifecycle.components];
  const runtimeIdentities = [...verified.manifest.images]
    .sort((left, right) => left.component.localeCompare(right.component))
    .map((image) => ({
      component: image.component,
      reference: image.reference,
      digest: image.digest,
    }));
  const startupRegistrations = plan.startup.enabled
    ? [{
        id: 'quarangate-user-startup',
        mechanism: plan.startup.mechanism,
        identityDigest: digest({
          installRoot: plan.installRoot,
          mechanism: plan.startup.mechanism,
          runLevel: plan.startup.runLevel,
        }),
        enabled: true,
      }]
    : [];
  const github = plan.github.enabled
    ? {
        state: 'CONFIGURED' as const,
        selectedRepositories: plan.github.repositories
          .map((repository) => `${plan.github.enabled ? plan.github.account : ''}/${repository}`)
          .sort(),
      }
    : { state: 'DISABLED' as const };
  const ide = plan.ide.state === 'UPSTREAM_P7_PENDING'
    ? { state: 'UPSTREAM_P7_PENDING' as const }
    : {
        state: 'BOUND' as const,
        contractVersion: plan.ide.contract.version,
        contractDigest: plan.ide.contract.digest,
        adapterIds: [...plan.ide.contract.adapterIds],
      };

  return createInstallationManifest({
    schemaVersion: 1,
    installationId: request.installationId,
    lifecycleState: 'REPAIR_REQUIRED',
    productVersion: verified.manifest.productVersion,
    sourceCommit: verified.manifest.sourceCommit,
    releaseDigest: verified.manifest.manifestDigest,
    configSchemaVersion: verified.manifest.lifecycle.configSchemaVersion,
    stateSchemaVersion: verified.manifest.lifecycle.stateSchemaVersion,
    installedAt: now,
    updatedAt: now,
    components,
    integrations: {
      providers: {
        kiro: providerState(plan.providers.kiro),
        copilot: providerState(plan.providers.copilot),
        ollama: providerState(plan.providers.ollama),
      },
      ide,
      github,
    },
    roots: {
      install: plan.installRoot,
      ...plan.roots,
    },
    runtimeIdentities,
    migrations: [...verified.manifest.lifecycle.migrations],
    startupRegistrations,
    clientRegistrations: [{
      id: 'owner-control-center',
      generation: 1,
      authorityDigest: digest({ scopes: plan.scopes }),
      state: 'ACTIVE',
    }],
    sessionResumePolicy: {
      mutating: 'REFUSE_ON_SOURCE_DRIFT_NEW_SESSION_NO_INHERITED_AUTHORITY',
      readOnly: 'RE_ATTEST_REAUTHORIZE_NEW_GENERATION_ZERO_MUTATION_AUTHORITY',
      historicalMemory: 'CONTEXT_ONLY_NEVER_AUTHORITY',
    },
    health: { state: 'UNHEALTHY', verifiedAt: now },
  });
}

export async function executeProductionInstall(
  request: ProductionInstallRequest,
  platform: ProductionLifecyclePlatform,
  trustPolicy: ReleaseTrustPolicy,
  now: () => string = () => new Date().toISOString(),
): Promise<ProductionInstallResult> {
  const authorized = verifyAuthorizedInstallPlan(request.authorizedPlan);
  if (authorized.plan.release.state !== 'VERIFIED_RELEASE') {
    throw new LifecycleDriverError(
      'PACKAGE_APPLY_DEFERRED_RELEASE_GATE',
      'Install mutation requires a cryptographically verified release identity in the reviewed plan',
      false,
    );
  }
  const verified = verifyTrustedReleaseBundle(request.release.bundle, trustPolicy);
  if (authorized.plan.release.manifestDigest !== verified.manifest.manifestDigest
    || authorized.plan.release.productVersion !== verified.manifest.productVersion
    || authorized.plan.release.sourceCommit !== verified.manifest.sourceCommit) {
    throw new LifecycleDriverError('RELEASE_PLAN_MISMATCH', 'Release package does not match the digest-bound install plan', false);
  }
  if (verified.manifest.productVersion !== request.release.bundle.manifest.productVersion
    || verified.manifest.sourceCommit !== request.release.bundle.manifest.sourceCommit) {
    throw new LifecycleDriverError('RELEASE_IDENTITY_INVALID', 'Release verification did not preserve package identity', false);
  }
  const template = installManifest(request, verified, now());
  // Refuse occupied unowned roots before the lifecycle store can create locks/journals.
  assertFreshInstallRootsAvailable(template, false);
  const target: TargetRelease = {
    productVersion: template.productVersion,
    sourceCommit: template.sourceCommit,
    releaseDigest: template.releaseDigest,
    configSchemaVersion: template.configSchemaVersion,
    stateSchemaVersion: template.stateSchemaVersion,
    components: template.components,
    migrations: template.migrations,
  };
  const lifecyclePlan = buildLifecyclePlan(null, {
    action: 'INSTALL',
    operationId: request.operationId,
    target,
    preservation: {
      projects: 'PRESERVE_REFERENCES',
      evidence: 'PRESERVE',
      models: 'PRESERVE',
      credentials: 'PRESERVE_OR_REAUTHORIZE',
      backups: 'PRESERVE',
      localState: 'PRESERVE',
      cache: 'PRESERVE',
    },
    authorityState: 'VALID',
  });
  const approvedLifecycle = approveLifecyclePlan(lifecyclePlan, {
    accepted: true,
    expectedPlanDigest: lifecyclePlan.digest,
    approvedDestructiveChoices: [],
  });
  const store = new FilesystemLifecycleStore(template.roots.state);
  const driver = new ProductionLifecycleDriver({
    projectRoots: authorized.plan.projects.map((project) => ({ id: project.id, path: project.path })),
    platform,
    release: request.release.bundle,
    releaseTrustPolicy: trustPolicy,
    installTemplate: template,
    initialConfiguration: {
      installPlanDigest: authorized.plan.digest,
      profile: authorized.plan.profile,
      projectReferencesDigest: digest(authorized.plan.projects.map((project) => ({
        id: project.id,
        path: project.path,
        access: project.access,
      }))),
      scopesDigest: digest(authorized.plan.scopes),
    },
    initialState: {
      installationId: request.installationId,
      releaseDigest: template.releaseDigest,
    },
    now,
  });
  const result = await new LifecycleCoordinator(store, driver, now).execute(approvedLifecycle);
  if (result.state !== 'SUCCESS') return { ...result, controlCenterOpened: false };
  await platform.openControlCenter('http://127.0.0.1:8787');
  return { ...result, controlCenterOpened: true };
}
