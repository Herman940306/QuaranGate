import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultHostProbeDependencies, probeHostFacts } from './hostProbe.js';
import {
  approveInstallPlan,
  buildInstallPlan,
  type ClientPermission,
  type InstallerAnswers,
  type InstallProfile,
  type InstallReleaseChoice,
  type LocalAiChoice,
  type ProviderChoice,
} from './productInstaller.js';
import {
  verifyTrustedReleaseBundle,
  type TrustedReleaseBundle,
} from '../lifecycle/productionDriver.js';
import {
  verifyReleaseTrustPolicy,
  type ReleasePackageManifest,
  type ReleaseSignatureProof,
  type ReleaseTrustPolicy,
} from './releasePackage.js';
import { verifyProductionReleaseProfile } from './productionRelease.js';
import { assertInitialRuntimePlanActivationDeferred } from './runtimeConfig.js';
import { executeProductionInstall } from './productionInstaller.js';
import { WslProductionLifecyclePlatform } from './wslProductionPlatform.js';

const GIB = 1024 ** 3;
const MAX_ANSWERS_BYTES = 64 * 1024;
const GUIDED_KEYS = [
  'backup', 'controlCenterUrl', 'githubRepository', 'ide', 'installRoot',
  'localAiProfile', 'profile', 'project', 'providers', 'remote',
  'schemaVersion', 'startup',
].sort();

export interface GuidedAnswers {
  schemaVersion: 1;
  profile: InstallProfile;
  installRoot: string;
  project: { id: string; path: string; access: 'READ_ONLY' | 'READ_WRITE' };
  providers: {
    kiro: 'CONFIGURED' | 'DEFERRED_ENTITLEMENT' | 'DISABLED';
    copilot: 'CONFIGURED' | 'DEFERRED_ENTITLEMENT' | 'DISABLED';
    ollama: 'CONFIGURED' | 'DISABLED';
  };
  localAiProfile: 'EFFICIENT' | 'BALANCED' | 'CUSTOM';
  ide: 'UPSTREAM_P7_PENDING';
  githubRepository: string | null;
  remote: 'LOCAL_ONLY' | 'TAILSCALE_PRIVATE';
  startup: 'WINDOWS_TASK_SCHEDULER_WSL' | 'DISABLED';
  backup: 'RECOMMENDED' | 'MINIMAL' | 'CUSTOM';
  controlCenterUrl: 'http://127.0.0.1:8787';
}

function fail(message: string): never {
  throw new Error(message);
}

function assertExactKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value as object).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail(`${label} has unknown or missing fields`);
  }
}

function readGuidedAnswers(file: string): GuidedAnswers {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ANSWERS_BYTES) {
    fail('guided answers must be a bounded regular non-symlink file');
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  assertExactKeys(parsed, GUIDED_KEYS, 'guided answers');
  assertExactKeys(parsed.project, ['access', 'id', 'path'], 'project enrollment');
  assertExactKeys(parsed.providers, ['copilot', 'kiro', 'ollama'], 'providers');
  if (parsed.schemaVersion !== 1
    || !['RECOMMENDED', 'DEVELOPER', 'QA_TESTING', 'ADVANCED_CUSTOM'].includes(String(parsed.profile))
    || typeof parsed.installRoot !== 'string'
    || typeof parsed.project.id !== 'string'
    || typeof parsed.project.path !== 'string'
    || !['READ_ONLY', 'READ_WRITE'].includes(String(parsed.project.access))
    || !['CONFIGURED', 'DEFERRED_ENTITLEMENT', 'DISABLED'].includes(String(parsed.providers.kiro))
    || !['CONFIGURED', 'DEFERRED_ENTITLEMENT', 'DISABLED'].includes(String(parsed.providers.copilot))
    || !['CONFIGURED', 'DISABLED'].includes(String(parsed.providers.ollama))
    || !['EFFICIENT', 'BALANCED', 'CUSTOM'].includes(String(parsed.localAiProfile))
    || parsed.ide !== 'UPSTREAM_P7_PENDING'
    || (parsed.githubRepository !== null && typeof parsed.githubRepository !== 'string')
    || !['LOCAL_ONLY', 'TAILSCALE_PRIVATE'].includes(String(parsed.remote))
    || !['WINDOWS_TASK_SCHEDULER_WSL', 'DISABLED'].includes(String(parsed.startup))
    || !['RECOMMENDED', 'MINIMAL', 'CUSTOM'].includes(String(parsed.backup))
    || parsed.controlCenterUrl !== 'http://127.0.0.1:8787') {
    fail('guided answers validation failed');
  }
  return parsed as unknown as GuidedAnswers;
}

function providerChoice(name: 'kiro' | 'copilot', state: GuidedAnswers['providers']['kiro']): ProviderChoice {
  if (state === 'CONFIGURED') {
    return {
      state,
      credential: {
        storage: 'ENVIRONMENT',
        reference: name === 'kiro' ? 'KIRO_AUTOMATION_TOKEN' : 'COPILOT_AUTOMATION_TOKEN',
      },
    };
  }
  return { state };
}

function permissions(profile: InstallProfile): ClientPermission[] {
  switch (profile) {
    case 'RECOMMENDED':
      return ['READ_FILES', 'REVIEW_CHANGES', 'INSPECT_OPERATIONS'];
    case 'DEVELOPER':
      return ['READ_FILES', 'RUN_TESTS', 'DISPATCH_AGENTS', 'REVIEW_CHANGES', 'INSPECT_OPERATIONS'];
    case 'QA_TESTING':
      return ['READ_FILES', 'RUN_TESTS', 'INSPECT_OPERATIONS'];
    case 'ADVANCED_CUSTOM':
      return ['READ_FILES'];
  }
}

function localAi(
  profile: GuidedAnswers['localAiProfile'],
  host: ReturnType<typeof probeHostFacts>,
): LocalAiChoice {
  if (profile === 'CUSTOM') {
    fail('CUSTOM local AI requires exact advanced model/context/resource values; the basic wizard will not guess them');
  }
  const balanced = profile === 'BALANCED';
  return {
    profile,
    model: {
      id: balanced ? 'qwen3.5:9b-q4_K_M' : 'qwen3.5:4b-q4_K_M',
      runtime: 'ollama',
      contextTokens: balanced ? 65536 : 32768,
    },
    limits: {
      cpuCores: Math.min(host.cpuCores, balanced ? 4 : 2),
      memoryBytes: Math.min(host.memoryBytes, (balanced ? 8 : 4) * GIB),
      vramBytes: host.gpu.present
        ? Math.min(host.gpu.vramBytes ?? 0, (balanced ? 8 : 4) * GIB)
        : 0,
    },
  };
}

export function planFromGuidedAnswers(
  guided: GuidedAnswers,
  release: InstallReleaseChoice = { state: 'RELEASE_GATE_PENDING' },
): ReturnType<typeof buildInstallPlan> {
  const host = probeHostFacts(defaultHostProbeDependencies(guided.installRoot));
  const state = path.posix.join(os.homedir().replaceAll('\\', '/'), '.local/state/quarangate');
  const data = path.posix.join(os.homedir().replaceAll('\\', '/'), '.local/share/quarangate');
  const [githubOwner, githubRepo] = guided.githubRepository?.split('/') ?? [];
  const answers: InstallerAnswers = {
    schemaVersion: 1,
    host,
    profile: guided.profile,
    release,
    installRoot: guided.installRoot,
    roots: {
      state,
      evidence: path.posix.join(state, 'evidence'),
      models: path.posix.join(data, 'models'),
      backups: path.posix.join(data, 'backups'),
      cache: path.posix.join(os.homedir().replaceAll('\\', '/'), '.cache/quarangate'),
    },
    projects: [guided.project],
    providers: {
      kiro: providerChoice('kiro', guided.providers.kiro),
      copilot: providerChoice('copilot', guided.providers.copilot),
      ollama: { state: guided.providers.ollama },
    },
    localAi: localAi(guided.localAiProfile, host),
    ide: { state: 'UPSTREAM_P7_PENDING' },
    github: githubOwner && githubRepo
      ? {
          enabled: true,
          account: githubOwner,
          repositories: [githubRepo],
          permissions: ['metadata:read', 'contents:read'],
        }
      : { enabled: false },
    remote: guided.remote === 'TAILSCALE_PRIVATE'
      ? { enabled: true, mechanism: 'TAILSCALE_PRIVATE', reversible: true, publicExposure: false }
      : { enabled: false },
    clientPermissions: permissions(guided.profile),
    startup: guided.startup === 'WINDOWS_TASK_SCHEDULER_WSL'
      ? { enabled: true, mechanism: 'WINDOWS_TASK_SCHEDULER_WSL', runLevel: 'LIMITED' }
      : { enabled: false },
    backup: {
      profile: guided.backup,
      location: path.posix.join(data, 'backups'),
      include: guided.backup === 'MINIMAL'
        ? ['CONFIG', 'PROJECT_REFERENCES']
        : ['CONFIG', 'PROJECT_REFERENCES', 'DURABLE_STATE', 'EVIDENCE'],
      includeCredentials: false,
    },
  };
  return buildInstallPlan(answers);
}

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROOF_BYTES = 16 * 1024;
const MAX_TRUST_BYTES = 64 * 1024;
const MAX_CONSENT_BYTES = 64 * 1024;

export interface ProductionReleasePaths {
  packageRoot: string;
  manifestFile: string;
  signatureProofFile: string;
  trustPolicyFile: string;
}

export interface ProductionConsentDocument {
  schemaVersion: 1;
  accepted: true;
  expectedPlanDigest: string;
  approvedSensitiveChoices: string[];
  operationId: string;
  installationId: string;
}

export interface VerifiedProductionReleaseInput {
  packageRoot: string;
  bundle: TrustedReleaseBundle;
  trustPolicy: ReleaseTrustPolicy;
  release: Extract<InstallReleaseChoice, { state: 'VERIFIED_RELEASE' }>;
}

function canonicalInputFile(file: string, maxBytes: number, label: string): string {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) {
    fail(label + ' must be one canonical absolute path');
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maxBytes) {
    fail(label + ' must be a bounded single-link regular non-symlink file');
  }
  if (realpathSync(file) !== file) {
    fail(label + ' must not resolve through a filesystem alias');
  }
  return file;
}

function canonicalPackageRoot(rootInput: string): string {
  if (!path.isAbsolute(rootInput) || path.resolve(rootInput) !== rootInput || rootInput === path.parse(rootInput).root) {
    fail('package root must be one canonical absolute non-root path');
  }
  const stat = lstatSync(rootInput);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(rootInput) !== rootInput) {
    fail('package root must be a real canonical directory');
  }
  return rootInput;
}

function readBoundedJson<T>(file: string, maxBytes: number, label: string): T {
  const safe = canonicalInputFile(file, maxBytes, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(safe, 'utf8')) as unknown;
  } catch {
    fail(label + ' is not valid JSON');
  }
  return parsed as T;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function loadVerifiedProductionRelease(paths: ProductionReleasePaths): VerifiedProductionReleaseInput {
  const packageRoot = canonicalPackageRoot(paths.packageRoot);
  const manifestFile = canonicalInputFile(paths.manifestFile, MAX_MANIFEST_BYTES, 'release manifest');
  const signatureProofFile = canonicalInputFile(paths.signatureProofFile, MAX_PROOF_BYTES, 'release signature proof');
  const trustPolicyFile = canonicalInputFile(paths.trustPolicyFile, MAX_TRUST_BYTES, 'release trust policy');

  if (isInside(packageRoot, trustPolicyFile)) {
    fail('release trust policy must be supplied independently from release payload material');
  }

  const manifest = readBoundedJson<ReleasePackageManifest>(manifestFile, MAX_MANIFEST_BYTES, 'release manifest');
  const signatureProof = readBoundedJson<ReleaseSignatureProof>(signatureProofFile, MAX_PROOF_BYTES, 'release signature proof');
  const trustPolicy = verifyReleaseTrustPolicy(
    readBoundedJson<ReleaseTrustPolicy>(trustPolicyFile, MAX_TRUST_BYTES, 'release trust policy'),
  );
  const bundle: TrustedReleaseBundle = { payloadRoot: packageRoot, manifest, signatureProof };
  const verified = verifyTrustedReleaseBundle(bundle, trustPolicy);
  verifyProductionReleaseProfile(verified.manifest);

  return {
    packageRoot,
    bundle,
    trustPolicy,
    release: {
      state: 'VERIFIED_RELEASE',
      productVersion: verified.manifest.productVersion,
      sourceCommit: verified.manifest.sourceCommit,
      manifestDigest: verified.manifest.manifestDigest,
    },
  };
}

export function readProductionConsent(file: string): ProductionConsentDocument {
  const value = readBoundedJson<unknown>(file, MAX_CONSENT_BYTES, 'production consent');
  assertExactKeys(
    value,
    ['accepted', 'approvedSensitiveChoices', 'expectedPlanDigest', 'installationId', 'operationId', 'schemaVersion'],
    'production consent',
  );
  const consent = value as Record<string, unknown>;
  if (consent.schemaVersion !== 1 || consent.accepted !== true
    || typeof consent.expectedPlanDigest !== 'string' || !SHA256.test(consent.expectedPlanDigest)
    || typeof consent.operationId !== 'string' || !SAFE_OPERATION_ID.test(consent.operationId)
    || typeof consent.installationId !== 'string' || !UUID.test(consent.installationId)
    || !Array.isArray(consent.approvedSensitiveChoices)
    || consent.approvedSensitiveChoices.some((choice) => typeof choice !== 'string' || choice.length === 0 || choice.length > 512)) {
    fail('production consent validation failed');
  }
  return consent as unknown as ProductionConsentDocument;
}

function planView(plan: ReturnType<typeof buildInstallPlan>): unknown {
  return {
    schemaVersion: 1,
    digest: plan.digest,
    requiredConsents: plan.requiredConsents,
    readiness: plan.readiness,
    review: {
      release: plan.review.release,
      installRoot: plan.installRoot,
      host: plan.hostBinding,
      projectAuthority: plan.review.projectAuthorities.join(', '),
      providers: Object.entries(plan.review.providers).map(([name, state]) => name + '=' + state).join(', '),
      localAi: plan.review.localAi,
      ide: plan.review.ideEnrollment,
      github: plan.review.githubAuthority,
      remote: plan.review.remoteAccess,
      startup: plan.review.startup,
      backup: plan.review.backup,
      clientPermissions: plan.review.clientScopes.join(', '),
    },
  };
}

type ParsedArgs =
  | { command: 'plan'; answersFile: string }
  | ({ command: 'plan-production'; answersFile: string } & ProductionReleasePaths)
  | ({ command: 'apply-production'; answersFile: string; consentFile: string } & ProductionReleasePaths);

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 3 && argv[0] === 'plan' && argv[1] === '--answers' && argv[2]) {
    return { command: 'plan', answersFile: argv[2] };
  }
  const production = argv[0] === 'plan-production' || argv[0] === 'apply-production';
  const expected = argv[0] === 'apply-production' ? 13 : 11;
  if (!production || argv.length !== expected
    || argv[1] !== '--answers'
    || argv[3] !== '--package-root'
    || argv[5] !== '--manifest'
    || argv[7] !== '--signature-proof'
    || argv[9] !== '--trust-policy'
    || (argv[0] === 'apply-production' && argv[11] !== '--consent')
    || !argv[2] || !argv[4] || !argv[6] || !argv[8] || !argv[10]
    || (argv[0] === 'apply-production' && !argv[12])) {
    fail(
      'usage: cli.js plan --answers <file> OR '
      + 'cli.js plan-production --answers <file> --package-root <dir> --manifest <file> '
      + '--signature-proof <file> --trust-policy <file> OR '
      + 'cli.js apply-production <same release args> --consent <file>',
    );
  }
  const common = {
    answersFile: argv[2],
    packageRoot: argv[4],
    manifestFile: argv[6],
    signatureProofFile: argv[8],
    trustPolicyFile: argv[10],
  };
  return argv[0] === 'apply-production'
    ? { command: 'apply-production', ...common, consentFile: argv[12]! }
    : { command: 'plan-production', ...common };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const guided = readGuidedAnswers(args.answersFile);
  if (args.command === 'plan') {
    process.stdout.write(JSON.stringify(planView(planFromGuidedAnswers(guided))));
    return;
  }

  const releaseInput = loadVerifiedProductionRelease(args);
  const plan = planFromGuidedAnswers(guided, releaseInput.release);
  assertInitialRuntimePlanActivationDeferred(plan);

  if (args.command === 'plan-production') {
    process.stdout.write(JSON.stringify(planView(plan)));
    return;
  }

  const consent = readProductionConsent(args.consentFile);
  const authorizedPlan = approveInstallPlan(plan, {
    accepted: consent.accepted,
    expectedPlanDigest: consent.expectedPlanDigest,
    approvedSensitiveChoices: consent.approvedSensitiveChoices,
  });
  const platform = new WslProductionLifecyclePlatform({
    authorizedPlan,
    packageRoot: releaseInput.packageRoot,
  });
  const result = await executeProductionInstall({
    operationId: consent.operationId,
    installationId: consent.installationId,
    authorizedPlan,
    release: { bundle: releaseInput.bundle },
  }, platform, releaseInput.trustPolicy);

  if (result.state !== 'SUCCESS') {
    fail('production install did not reach SUCCESS; lifecycle state=' + result.state);
  }
  const ownerCredential = platform.takeOwnerCredential();
  if (!ownerCredential) {
    fail('production install completed without the one-time owner credential');
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    status: 'PASS',
    lifecycleState: result.state,
    controlCenterOpened: result.controlCenterOpened,
    ownerCredential,
  }));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'installer operation failed';
    process.stderr.write('INSTALLER_BLOCKED: ' + message + '\n');
    process.exitCode = 1;
  });
}
