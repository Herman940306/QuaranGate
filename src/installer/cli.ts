import { lstatSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultHostProbeDependencies, probeHostFacts } from './hostProbe.js';
import {
  buildInstallPlan,
  type ClientPermission,
  type InstallerAnswers,
  type InstallProfile,
  type LocalAiChoice,
  type ProviderChoice,
} from './productInstaller.js';

const GIB = 1024 ** 3;
const MAX_ANSWERS_BYTES = 64 * 1024;
const GUIDED_KEYS = [
  'backup', 'controlCenterUrl', 'githubRepository', 'ide', 'installRoot',
  'localAiProfile', 'profile', 'project', 'providers', 'remote',
  'schemaVersion', 'startup',
].sort();

interface GuidedAnswers {
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

export function planFromGuidedAnswers(guided: GuidedAnswers): ReturnType<typeof buildInstallPlan> {
  const host = probeHostFacts(defaultHostProbeDependencies(guided.installRoot));
  const state = path.posix.join(os.homedir().replaceAll('\\', '/'), '.local/state/quarangate');
  const data = path.posix.join(os.homedir().replaceAll('\\', '/'), '.local/share/quarangate');
  const [githubOwner, githubRepo] = guided.githubRepository?.split('/') ?? [];
  const answers: InstallerAnswers = {
    schemaVersion: 1,
    host,
    profile: guided.profile,
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

function parseArgs(argv: string[]): { command: string; answersFile: string } {
  if (argv.length !== 3 || argv[0] !== 'plan' || argv[1] !== '--answers' || !argv[2]) {
    fail('usage: cli.js plan --answers <bounded-json-file>');
  }
  return { command: argv[0], answersFile: argv[2] };
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const plan = planFromGuidedAnswers(readGuidedAnswers(args.answersFile));
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    digest: plan.digest,
    requiredConsents: plan.requiredConsents,
    readiness: plan.readiness,
    review: {
      installRoot: plan.installRoot,
      projectAuthority: plan.review.projectAuthorities.join(', '),
      providers: Object.entries(plan.review.providers).map(([name, state]) => `${name}=${state}`).join(', '),
      localAi: plan.review.localAi,
      ide: plan.review.ideEnrollment,
      github: plan.review.githubAuthority,
      remote: plan.review.remoteAccess,
      startup: plan.review.startup,
      backup: plan.review.backup,
      clientPermissions: plan.review.clientScopes.join(', '),
    },
  }));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'installer planning failed';
    process.stderr.write(`INSTALLER_PLAN_BLOCKED: ${message}\n`);
    process.exitCode = 1;
  }
}
