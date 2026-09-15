import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalSerialize } from '../executor/agents/canonicalJson.js';
import type { Scope } from '../gateway/config.js';

const GIB = 1024 ** 3;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export const INSTALLER_SCHEMA_VERSION = 1 as const;
export const MINIMUM_DOCKER_VERSION = '24.0.0';
export const MINIMUM_COMPOSE_VERSION = '2.20.0';
export const MINIMUM_NODE_VERSION = '22.0.0';

export type ReadinessStatus = 'READY' | 'REMEDIATION_REQUIRED' | 'UNSUPPORTED' | 'BLOCKED';
export type ReadinessCheckStatus = 'PASS' | Exclude<ReadinessStatus, 'READY'>;

export interface ToolFact {
  available: boolean;
  version?: string;
  daemonReachable?: boolean;
}

export interface HostFacts {
  platform: 'windows' | 'wsl' | 'linux' | 'macos' | 'unknown';
  platformVersion: string;
  wslDistribution?: string;
  wslVersion?: 1 | 2;
  docker: ToolFact;
  compose: ToolFact;
  git: ToolFact;
  node: ToolFact;
  cpuCores: number;
  memoryBytes: number;
  storageBytesFree: number;
  filesystem: {
    supportsAtomicRename: boolean;
    caseSensitive: boolean;
    installRootIsSymlink: boolean;
  };
  gpu: {
    present: boolean;
    name?: string;
    vramBytes?: number;
  };
}

export interface ReadinessCheck {
  code: string;
  status: ReadinessCheckStatus;
  detail: string;
  remediation?: string;
}

export interface SystemReadiness {
  status: ReadinessStatus;
  checks: ReadinessCheck[];
}

function parseVersion(input: string | undefined): number[] | null {
  if (!input) return null;
  const match = input.trim().match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function versionAtLeast(actual: string | undefined, minimum: string): boolean {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function pass(code: string, detail: string): ReadinessCheck {
  return { code, status: 'PASS', detail };
}

function issue(
  code: string,
  status: Exclude<ReadinessCheckStatus, 'PASS'>,
  detail: string,
  remediation: string,
): ReadinessCheck {
  return { code, status, detail, remediation };
}

function toolCheck(
  fact: ToolFact,
  name: string,
  missingCode: string,
  versionCode: string,
  minimum: string,
): ReadinessCheck {
  if (!fact.available) {
    return issue(missingCode, 'REMEDIATION_REQUIRED', `${name} was not detected`, `Install an owner-approved ${name} release and rerun readiness.`);
  }
  if (!versionAtLeast(fact.version, minimum)) {
    return issue(versionCode, 'REMEDIATION_REQUIRED', `${name} ${fact.version ?? 'unknown'} is below ${minimum}`, `Upgrade ${name} to ${minimum} or newer through its trusted distribution channel.`);
  }
  return pass(`${name.toUpperCase().replaceAll(' ', '_')}_READY`, `${name} ${fact.version} is available`);
}

export function evaluateSystemReadiness(facts: HostFacts): SystemReadiness {
  const checks: ReadinessCheck[] = [];

  if (facts.platform === 'windows') {
    checks.push(facts.wslVersion === 2 && Boolean(facts.wslDistribution)
      ? pass('WSL2_READY', `WSL2 distribution ${facts.wslDistribution} is available`)
      : issue('WSL2_REQUIRED', 'UNSUPPORTED', 'Native Windows without WSL2 is not a supported runtime', 'Enable an owner-approved WSL2 Linux distribution; no automatic privilege change will be attempted.'));
  } else if (facts.platform === 'wsl') {
    checks.push(facts.wslVersion === 2 && Boolean(facts.wslDistribution)
      ? pass('WSL2_READY', `Running in WSL2 distribution ${facts.wslDistribution}`)
      : issue('WSL2_REQUIRED', 'UNSUPPORTED', 'WSL was detected without a proven WSL2 distribution', 'Select a WSL2 distribution and rerun readiness.'));
  } else if (facts.platform === 'linux') {
    checks.push(pass('LINUX_READY', `Linux ${facts.platformVersion} is supported`));
  } else if (facts.platform === 'macos') {
    checks.push(issue('MACOS_QUALIFICATION_REQUIRED', 'REMEDIATION_REQUIRED', 'macOS is design-compatible but not release-qualified', 'Complete the governed macOS platform qualification before installation.'));
  } else {
    checks.push(issue('PLATFORM_UNSUPPORTED', 'UNSUPPORTED', 'The operating system/runtime is unsupported', 'Use Linux or Windows 11 with WSL2.'));
  }

  checks.push(toolCheck(facts.docker, 'Docker', 'DOCKER_MISSING', 'DOCKER_VERSION_UNSUPPORTED', MINIMUM_DOCKER_VERSION));
  if (facts.docker.available) {
    checks.push(facts.docker.daemonReachable === true
      ? pass('DOCKER_DAEMON_READY', 'Docker daemon is reachable')
      : issue('DOCKER_DAEMON_UNREACHABLE', 'BLOCKED', 'Docker is installed but the daemon is not reachable', 'Start Docker through the owner-approved mechanism and rerun readiness.'));
  }
  checks.push(toolCheck(facts.compose, 'Docker Compose', 'COMPOSE_MISSING', 'COMPOSE_VERSION_UNSUPPORTED', MINIMUM_COMPOSE_VERSION));
  checks.push(facts.git.available
    ? pass('GIT_READY', `Git ${facts.git.version ?? 'version unknown'} is available`)
    : issue('GIT_MISSING', 'REMEDIATION_REQUIRED', 'Git was not detected', 'Install Git through a trusted distribution channel.'));
  checks.push(toolCheck(facts.node, 'Node', 'NODE_MISSING', 'NODE_VERSION_UNSUPPORTED', MINIMUM_NODE_VERSION));

  checks.push(Number.isInteger(facts.cpuCores) && facts.cpuCores >= 2
    ? pass('CPU_READY', `${facts.cpuCores} logical CPU cores detected`)
    : issue('CPU_INADEQUATE', 'BLOCKED', 'At least 2 logical CPU cores are required', 'Select a host with at least 2 logical CPU cores.'));
  checks.push(Number.isFinite(facts.memoryBytes) && facts.memoryBytes >= 4 * GIB
    ? pass('MEMORY_READY', `${Math.floor(facts.memoryBytes / GIB)} GiB memory detected`)
    : issue('MEMORY_INADEQUATE', 'BLOCKED', 'At least 4 GiB memory is required for the core product', 'Free resources or select a host with at least 4 GiB memory.'));
  checks.push(Number.isFinite(facts.storageBytesFree) && facts.storageBytesFree >= 10 * GIB
    ? pass('STORAGE_READY', `${Math.floor(facts.storageBytesFree / GIB)} GiB free storage detected`)
    : issue('STORAGE_INADEQUATE', 'BLOCKED', 'At least 10 GiB free storage is required before model storage', 'Free storage or choose another explicit storage root.'));
  checks.push(facts.filesystem.supportsAtomicRename
    ? pass('ATOMIC_RENAME_READY', 'Installation filesystem supports same-filesystem atomic rename')
    : issue('ATOMIC_RENAME_UNSUPPORTED', 'UNSUPPORTED', 'The installation filesystem cannot prove atomic rename support', 'Choose a local filesystem with atomic rename semantics.'));
  checks.push(!facts.filesystem.installRootIsSymlink
    ? pass('INSTALL_ROOT_NOT_SYMLINK', 'Installation root is not a symbolic link')
    : issue('INSTALL_ROOT_SYMLINK', 'BLOCKED', 'The installation root resolves through a symbolic link', 'Choose a canonical non-symlink installation root.'));
  checks.push(pass('GPU_OPTIONAL', facts.gpu.present ? `Optional GPU detected: ${facts.gpu.name ?? 'unnamed'}` : 'No GPU detected; CPU-compatible profiles remain available'));

  let status: ReadinessStatus = 'READY';
  const states = new Set(checks.map((check) => check.status));
  if (states.has('UNSUPPORTED')) status = 'UNSUPPORTED';
  else if (states.has('BLOCKED')) status = 'BLOCKED';
  else if (states.has('REMEDIATION_REQUIRED')) status = 'REMEDIATION_REQUIRED';
  return { status, checks };
}

export type InstallProfile = 'RECOMMENDED' | 'DEVELOPER' | 'QA_TESTING' | 'ADVANCED_CUSTOM';
export type ProjectAccess = 'READ_ONLY' | 'READ_WRITE';

export interface ProfileDefaults {
  projectAccess: ProjectAccess;
  remoteAccess: false;
  scopes: Scope[];
  backupProfile: BackupProfile;
}

export function profileDefaults(): Record<InstallProfile, ProfileDefaults> {
  return {
    RECOMMENDED: {
      projectAccess: 'READ_ONLY',
      remoteAccess: false,
      scopes: ['targets:read', 'files:read', 'git:read', 'agents:read'],
      backupProfile: 'RECOMMENDED',
    },
    DEVELOPER: {
      projectAccess: 'READ_ONLY',
      remoteAccess: false,
      scopes: ['targets:read', 'files:read', 'git:read', 'agents:read', 'agents:dispatch'],
      backupProfile: 'RECOMMENDED',
    },
    QA_TESTING: {
      projectAccess: 'READ_ONLY',
      remoteAccess: false,
      scopes: ['targets:read', 'targets:logs', 'files:read', 'terminal:exec', 'git:read', 'process:read'],
      backupProfile: 'RECOMMENDED',
    },
    ADVANCED_CUSTOM: {
      projectAccess: 'READ_ONLY',
      remoteAccess: false,
      scopes: ['targets:read', 'files:read', 'git:read'],
      backupProfile: 'CUSTOM',
    },
  };
}

export type ClientPermission =
  | 'READ_FILES'
  | 'RUN_TESTS'
  | 'DISPATCH_AGENTS'
  | 'REVIEW_CHANGES'
  | 'APPLY_APPROVED_CHANGES'
  | 'INSPECT_OPERATIONS'
  | 'ADMINISTER_INFRASTRUCTURE';

const PERMISSION_SCOPES: Record<ClientPermission, Scope[]> = {
  READ_FILES: ['files:read'],
  RUN_TESTS: ['terminal:exec'],
  DISPATCH_AGENTS: ['agents:read', 'agents:dispatch'],
  REVIEW_CHANGES: ['agents:read'],
  APPLY_APPROVED_CHANGES: ['agents:apply'],
  INSPECT_OPERATIONS: ['targets:read', 'targets:logs', 'process:read'],
  ADMINISTER_INFRASTRUCTURE: ['targets:control'],
};

export function mapClientPermissions(permissions: ClientPermission[]): Scope[] {
  const ordered: Scope[] = [];
  for (const permission of permissions) {
    const scopes = PERMISSION_SCOPES[permission];
    if (!scopes) throw new InstallerPolicyError('UNKNOWN_PERMISSION', `Unknown client permission: ${String(permission)}`);
    for (const scope of scopes) if (!ordered.includes(scope)) ordered.push(scope);
  }
  return ordered;
}

export interface ProjectEnrollment {
  id: string;
  path: string;
  access: ProjectAccess;
}

export interface PlannedProject extends ProjectEnrollment {
  guards: string[];
  canonicalAttestationRequired: true;
}

export type ProviderState = 'CONFIGURED' | 'DEFERRED_ENTITLEMENT' | 'DISABLED';
export interface CredentialReference {
  storage: 'ENVIRONMENT' | 'OS_KEYCHAIN';
  reference: string;
}
export interface ProviderChoice {
  state: ProviderState;
  credential?: CredentialReference;
}
export interface ProviderChoices {
  kiro: ProviderChoice;
  copilot: ProviderChoice;
  ollama: ProviderChoice;
}

export type LocalAiProfile = 'EFFICIENT' | 'BALANCED' | 'CUSTOM';
export interface LocalAiChoice {
  profile: LocalAiProfile;
  model: {
    id: string;
    runtime: 'ollama';
    contextTokens: number;
  };
  limits: {
    cpuCores: number;
    memoryBytes: number;
    vramBytes: number;
  };
}

export interface AcceptedIdeContract {
  version: number;
  digest: string;
  adapterIds: string[];
}
export type IdeChoice =
  | { state: 'UPSTREAM_P7_PENDING' }
  | { state: 'READY'; contract: AcceptedIdeContract };

export type GithubPermission =
  | 'metadata:read'
  | 'contents:read'
  | 'contents:write'
  | 'pull_requests:read'
  | 'pull_requests:write'
  | 'issues:read'
  | 'issues:write';

export type GithubChoice =
  | { enabled: false }
  | {
      enabled: true;
      account: string;
      repositories: string[];
      permissions: GithubPermission[];
    };

export type RemoteChoice =
  | { enabled: false }
  | {
      enabled: true;
      mechanism: 'TAILSCALE_PRIVATE';
      reversible: true;
      publicExposure: false;
    };

export type StartupChoice =
  | { enabled: false }
  | {
      enabled: true;
      mechanism: 'WINDOWS_TASK_SCHEDULER_WSL' | 'SYSTEMD_USER';
      runLevel: 'LIMITED';
    };

export type BackupProfile = 'RECOMMENDED' | 'MINIMAL' | 'CUSTOM';
export type BackupCategory = 'CONFIG' | 'PROJECT_REFERENCES' | 'DURABLE_STATE' | 'EVIDENCE' | 'MODELS';
export interface BackupChoice {
  profile: BackupProfile;
  location: string;
  include: BackupCategory[];
  includeCredentials: boolean;
}

export interface InstallerAnswers {
  schemaVersion: 1;
  host: HostFacts;
  profile: InstallProfile;
  installRoot: string;
  roots: {
    state: string;
    evidence: string;
    models: string;
    backups: string;
    cache: string;
  };
  projects: ProjectEnrollment[];
  providers: ProviderChoices;
  localAi: LocalAiChoice;
  ide: IdeChoice;
  github: GithubChoice;
  remote: RemoteChoice;
  clientPermissions: ClientPermission[];
  startup: StartupChoice;
  backup: BackupChoice;
}

export type InstallStepKind =
  | 'ATTEST_PATHS'
  | 'WRITE_INSTALL_MANIFEST'
  | 'MATERIALIZE_CONFIG'
  | 'REGISTER_STARTUP'
  | 'START_RUNTIME'
  | 'VERIFY_HEALTH'
  | 'OPEN_CONTROL_CENTER_AFTER_HEALTH'
  | 'OPEN_PUBLIC_PORT';

export interface InstallStep {
  sequence: number;
  kind: InstallStepKind;
  mutation: boolean;
  authorityBoundary: string;
}

export interface InstallPlan {
  schemaVersion: 1;
  digest: string;
  readiness: SystemReadiness;
  profile: InstallProfile;
  installRoot: string;
  roots: InstallerAnswers['roots'];
  projects: PlannedProject[];
  providers: ProviderChoices;
  localAi: LocalAiChoice;
  ide: IdeChoice;
  github: GithubChoice;
  remote: RemoteChoice;
  scopes: Scope[];
  startup: StartupChoice;
  backup: BackupChoice;
  requiredConsents: string[];
  review: {
    projectAuthorities: string[];
    providers: Record<keyof ProviderChoices, ProviderState>;
    localAi: string;
    ideEnrollment: string;
    githubAuthority: string;
    remoteAccess: string;
    startup: string;
    backup: string;
    clientScopes: Scope[];
    controlCenterUrl: 'http://127.0.0.1:8787';
  };
  steps: InstallStep[];
}

export interface InstallConsent {
  accepted: boolean;
  expectedPlanDigest: string;
  approvedSensitiveChoices: string[];
}

export interface AuthorizedInstallPlan {
  authorized: true;
  plan: InstallPlan;
  consentDigest: string;
}

export class InstallerPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'InstallerPolicyError';
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InstallerPolicyError('SCHEMA_INVALID', `${label} must be an object`);
  }
}

function rejectUnknownKeys(value: unknown, allowed: readonly string[], label: string): void {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new InstallerPolicyError('CREDENTIAL_SCHEMA_INVALID', `${label} contains forbidden credential fields: ${unknown.sort().join(', ')}`);
  }
}

function validateProvider(name: keyof ProviderChoices, choice: ProviderChoice): void {
  rejectUnknownKeys(choice, ['state', 'credential'], `${name} provider`);
  if (!['CONFIGURED', 'DEFERRED_ENTITLEMENT', 'DISABLED'].includes(choice.state)) {
    throw new InstallerPolicyError('PROVIDER_STATE_INVALID', `${name} provider state is invalid`);
  }
  if (choice.credential !== undefined) {
    rejectUnknownKeys(choice.credential, ['storage', 'reference'], `${name} credential reference`);
    if (!['ENVIRONMENT', 'OS_KEYCHAIN'].includes(choice.credential.storage)) {
      throw new InstallerPolicyError('CREDENTIAL_STORAGE_INVALID', `${name} credential storage must be an approved reference store`);
    }
    if (!/^[A-Za-z][A-Za-z0-9._:/-]{2,127}$/u.test(choice.credential.reference) || CONTROL.test(choice.credential.reference)) {
      throw new InstallerPolicyError('CREDENTIAL_REFERENCE_INVALID', `${name} credential reference is invalid`);
    }
  }
  if ((name === 'kiro' || name === 'copilot') && choice.state === 'CONFIGURED' && !choice.credential) {
    throw new InstallerPolicyError('CREDENTIAL_REFERENCE_REQUIRED', `${name} requires a credential reference or explicit deferral`);
  }
  if (choice.state !== 'CONFIGURED' && choice.credential) {
    throw new InstallerPolicyError('CREDENTIAL_REFERENCE_UNEXPECTED', `${name} credential reference is only valid for a configured provider`);
  }
}

function normalizeAbsolutePath(input: string, label: string): string {
  if (typeof input !== 'string' || CONTROL.test(input) || input.includes('\\') || !path.posix.isAbsolute(input)) {
    throw new InstallerPolicyError('PATH_INVALID', `${label} must be an absolute canonical WSL/Linux path`);
  }
  const normalized = path.posix.normalize(input).replace(/\/+$/u, '') || '/';
  if (normalized !== input.replace(/\/+$/u, '') || normalized === '/') {
    throw new InstallerPolicyError('PATH_INVALID', `${label} must be canonical and cannot be the filesystem root`);
  }
  return normalized;
}

function validateProject(project: ProjectEnrollment): PlannedProject {
  if (!SAFE_ID.test(project.id)) throw new InstallerPolicyError('PROJECT_ID_INVALID', 'Project id is invalid');
  const canonical = normalizeAbsolutePath(project.path, `project ${project.id}`);
  if (/^\/(?:home|Users)\/[^/]+$/u.test(canonical) || canonical === '/home' || canonical === '/Users') {
    throw new InstallerPolicyError('PROJECT_PATH_TOO_BROAD', `Project ${project.id} selects a broad home directory`);
  }
  if (!['READ_ONLY', 'READ_WRITE'].includes(project.access)) {
    throw new InstallerPolicyError('PROJECT_ACCESS_INVALID', `Project ${project.id} access must be explicit`);
  }
  return {
    ...project,
    path: canonical,
    guards: ['.git', '.env', '.env.*', 'secrets', 'credentials'],
    canonicalAttestationRequired: true,
  };
}

function validateGithub(choice: GithubChoice): void {
  if (!choice.enabled) return;
  if (!SAFE_ID.test(choice.account)) throw new InstallerPolicyError('GITHUB_ACCOUNT_INVALID', 'GitHub account is invalid');
  if (choice.repositories.length === 0 || choice.repositories.some((repo) => repo === '*' || !SAFE_ID.test(repo))) {
    throw new InstallerPolicyError('GITHUB_REPOSITORY_INVALID', 'GitHub setup requires explicit selected repositories; wildcard authority is refused');
  }
  if (new Set(choice.repositories).size !== choice.repositories.length) {
    throw new InstallerPolicyError('GITHUB_REPOSITORY_DUPLICATE', 'GitHub repository selections must be unique');
  }
  if (choice.permissions.length === 0 || new Set(choice.permissions).size !== choice.permissions.length) {
    throw new InstallerPolicyError('GITHUB_PERMISSION_INVALID', 'GitHub permissions must be explicit and unique');
  }
}

function validateLocalAi(choice: LocalAiChoice, host: HostFacts): void {
  if (!SAFE_ID.test(choice.model.id.replace(':', '-'))) {
    throw new InstallerPolicyError('LOCAL_AI_MODEL_INVALID', 'local AI model identity is invalid');
  }
  const { contextTokens } = choice.model;
  const limits = choice.limits;
  const valid = Number.isInteger(contextTokens) && contextTokens >= 1024 && contextTokens <= 262144
    && Number.isFinite(limits.cpuCores) && limits.cpuCores > 0 && limits.cpuCores <= host.cpuCores
    && Number.isFinite(limits.memoryBytes) && limits.memoryBytes >= GIB && limits.memoryBytes <= host.memoryBytes
    && Number.isFinite(limits.vramBytes) && limits.vramBytes >= 0
    && (!host.gpu.present || limits.vramBytes <= (host.gpu.vramBytes ?? 0));
  if (!valid) throw new InstallerPolicyError('LOCAL_AI_LIMITS_INVALID', 'local AI context/resource limits exceed detected hardware or safe bounds');
}

export function selectLocalAiProfile(
  host: HostFacts,
  requested: Exclude<LocalAiProfile, 'CUSTOM'>,
): { profile: Exclude<LocalAiProfile, 'CUSTOM'>; reason: string } {
  if (requested === 'BALANCED') {
    const gpuEnough = host.gpu.present && (host.gpu.vramBytes ?? 0) >= 8 * GIB;
    if (host.memoryBytes >= 16 * GIB && (gpuEnough || host.cpuCores >= 8)) {
      return { profile: 'BALANCED', reason: 'Detected resources satisfy the balanced profile envelope' };
    }
    return { profile: 'EFFICIENT', reason: 'Balanced resources are unavailable; selected the bounded efficient profile' };
  }
  return { profile: 'EFFICIENT', reason: 'Efficient profile explicitly selected' };
}

function validateIde(choice: IdeChoice): string {
  if (choice.state === 'UPSTREAM_P7_PENDING') return 'UPSTREAM_P7_PENDING';
  if (!Number.isInteger(choice.contract.version) || choice.contract.version < 1 || !SHA256.test(choice.contract.digest)) {
    throw new InstallerPolicyError('IDE_CONTRACT_INVALID', 'IDE contract digest/version is invalid');
  }
  if (choice.contract.adapterIds.length === 0 || choice.contract.adapterIds.some((id) => !SAFE_ID.test(id))) {
    throw new InstallerPolicyError('IDE_CONTRACT_INVALID', 'IDE contract adapter inventory is invalid');
  }
  const sorted = [...choice.contract.adapterIds].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((id, index) => id !== choice.contract.adapterIds[index])) {
    throw new InstallerPolicyError('IDE_CONTRACT_INVALID', 'IDE adapter inventory must be unique and sorted');
  }
  return `READY:${sorted.join(',')}`;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalSerialize(value)).digest('hex');
}

function planWithoutDigest(plan: InstallPlan): Omit<InstallPlan, 'digest'> {
  const { digest: _digest, ...rest } = plan;
  return rest;
}

function consentChoices(
  projects: PlannedProject[],
  scopes: Scope[],
  answers: InstallerAnswers,
): string[] {
  const choices: string[] = [];
  for (const project of projects) {
    if (project.access === 'READ_WRITE') choices.push(`PROJECT_WRITE:${project.id}`);
  }
  const powerfulScopes: Scope[] = [
    'files:write', 'files:delete', 'terminal:exec', 'agents:dispatch',
    'agents:cancel', 'agents:apply', 'targets:control', 'github:write',
  ];
  for (const scope of scopes) if (powerfulScopes.includes(scope)) choices.push(`SCOPE:${scope}`);
  if (answers.github.enabled) {
    choices.push(`GITHUB_REPOSITORIES:${answers.github.account}/${[...answers.github.repositories].sort().join(',')}`);
    for (const permission of answers.github.permissions) {
      if (permission.endsWith(':write')) choices.push(`GITHUB_PERMISSION:${permission}`);
    }
  }
  if (answers.remote.enabled) choices.push(`REMOTE_ACCESS:${answers.remote.mechanism}`);
  if (answers.startup.enabled) choices.push(`STARTUP:${answers.startup.mechanism}`);
  if (answers.backup.includeCredentials) choices.push('BACKUP_CREDENTIALS');
  for (const provider of ['kiro', 'copilot'] as const) {
    if (answers.providers[provider].state === 'CONFIGURED') choices.push(`PROVIDER:${provider}`);
  }
  return [...new Set(choices)].sort();
}

export function buildInstallPlan(answers: InstallerAnswers): InstallPlan {
  if (answers.schemaVersion !== INSTALLER_SCHEMA_VERSION) {
    throw new InstallerPolicyError('INSTALLER_SCHEMA_UNSUPPORTED', 'Installer answer schema is unsupported');
  }
  const readiness = evaluateSystemReadiness(answers.host);
  if (readiness.status !== 'READY') {
    throw new InstallerPolicyError('SYSTEM_NOT_READY', `System readiness is ${readiness.status}; remediate before mutation planning`);
  }
  if (!profileDefaults()[answers.profile]) throw new InstallerPolicyError('PROFILE_INVALID', 'Installer profile is invalid');

  const installRoot = normalizeAbsolutePath(answers.installRoot, 'install root');
  const roots = {
    state: normalizeAbsolutePath(answers.roots.state, 'state root'),
    evidence: normalizeAbsolutePath(answers.roots.evidence, 'evidence root'),
    models: normalizeAbsolutePath(answers.roots.models, 'models root'),
    backups: normalizeAbsolutePath(answers.roots.backups, 'backup root'),
    cache: normalizeAbsolutePath(answers.roots.cache, 'cache root'),
  };
  const projects = answers.projects.map(validateProject);
  if (projects.length === 0 || new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new InstallerPolicyError('PROJECTS_INVALID', 'At least one unique project enrollment is required');
  }

  for (const provider of ['kiro', 'copilot', 'ollama'] as const) validateProvider(provider, answers.providers[provider]);
  validateLocalAi(answers.localAi, answers.host);
  const ideEnrollment = validateIde(answers.ide);
  validateGithub(answers.github);
  if (answers.remote.enabled && (!answers.remote.reversible || answers.remote.publicExposure)) {
    throw new InstallerPolicyError('REMOTE_POLICY_INVALID', 'Remote access must remain private and reversible');
  }
  if (answers.startup.enabled && answers.startup.runLevel !== 'LIMITED') {
    throw new InstallerPolicyError('STARTUP_PRIVILEGE_INVALID', 'Startup must use a limited user identity');
  }
  if (answers.backup.location !== roots.backups) {
    throw new InstallerPolicyError('BACKUP_ROOT_MISMATCH', 'Backup policy location must match the reviewed backup root');
  }
  if (answers.backup.includeCredentials && answers.backup.profile !== 'CUSTOM') {
    throw new InstallerPolicyError('BACKUP_CREDENTIAL_POLICY_INVALID', 'Credential backup requires an explicit custom policy');
  }

  const scopes = mapClientPermissions(answers.clientPermissions);
  const requiredConsents = consentChoices(projects, scopes, answers);
  const steps: InstallStep[] = [
    { sequence: 1, kind: 'ATTEST_PATHS', mutation: false, authorityBoundary: 'canonical filesystem identity' },
    { sequence: 2, kind: 'WRITE_INSTALL_MANIFEST', mutation: true, authorityBoundary: 'owner state root' },
    { sequence: 3, kind: 'MATERIALIZE_CONFIG', mutation: true, authorityBoundary: 'existing QuaranGate configuration' },
    ...(answers.startup.enabled
      ? [{ sequence: 4, kind: 'REGISTER_STARTUP' as const, mutation: true, authorityBoundary: 'bounded user startup registration' }]
      : []),
    { sequence: answers.startup.enabled ? 5 : 4, kind: 'START_RUNTIME', mutation: true, authorityBoundary: 'existing governed runtime mechanism' },
    { sequence: answers.startup.enabled ? 6 : 5, kind: 'VERIFY_HEALTH', mutation: false, authorityBoundary: 'loopback health endpoint' },
    { sequence: answers.startup.enabled ? 7 : 6, kind: 'OPEN_CONTROL_CENTER_AFTER_HEALTH', mutation: false, authorityBoundary: 'loopback browser navigation' },
  ];

  const base: Omit<InstallPlan, 'digest'> = {
    schemaVersion: 1,
    readiness,
    profile: answers.profile,
    installRoot,
    roots,
    projects,
    providers: answers.providers,
    localAi: answers.localAi,
    ide: answers.ide,
    github: answers.github,
    remote: answers.remote,
    scopes,
    startup: answers.startup,
    backup: answers.backup,
    requiredConsents,
    review: {
      projectAuthorities: projects.map((project) => `${project.id}:${project.access}`),
      providers: {
        kiro: answers.providers.kiro.state,
        copilot: answers.providers.copilot.state,
        ollama: answers.providers.ollama.state,
      },
      localAi: `${answers.localAi.profile}:${answers.localAi.model.runtime}/${answers.localAi.model.id}:ctx=${answers.localAi.model.contextTokens}`,
      ideEnrollment,
      githubAuthority: answers.github.enabled
        ? `${answers.github.account}/${[...answers.github.repositories].sort().join(',')}:${[...answers.github.permissions].sort().join(',')}`
        : 'DISABLED',
      remoteAccess: answers.remote.enabled ? answers.remote.mechanism : 'LOCAL_ONLY',
      startup: answers.startup.enabled ? `${answers.startup.mechanism}:LIMITED` : 'DISABLED',
      backup: `${answers.backup.profile}:${answers.backup.location}:${[...answers.backup.include].sort().join(',')}:credentials=${answers.backup.includeCredentials}`,
      clientScopes: scopes,
      controlCenterUrl: 'http://127.0.0.1:8787',
    },
    steps,
  };

  return { ...base, digest: hashCanonical(base) };
}

export function approveInstallPlan(plan: InstallPlan, consent: InstallConsent): AuthorizedInstallPlan {
  const actualDigest = hashCanonical(planWithoutDigest(plan));
  if (actualDigest !== plan.digest || consent.expectedPlanDigest !== plan.digest) {
    throw new InstallerPolicyError('PLAN_IDENTITY_MISMATCH', 'Install plan digest does not match the reviewed plan');
  }
  if (!consent.accepted) throw new InstallerPolicyError('OWNER_CONSENT_REQUIRED', 'Explicit owner consent is required before mutation');
  const approved = new Set(consent.approvedSensitiveChoices);
  const missing = plan.requiredConsents.filter((choice) => !approved.has(choice));
  const unexpected = [...approved].filter((choice) => !plan.requiredConsents.includes(choice));
  if (missing.length > 0) {
    throw new InstallerPolicyError('SENSITIVE_CONSENT_MISSING', `Install plan is missing explicit consent for: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    throw new InstallerPolicyError('SENSITIVE_CONSENT_UNKNOWN', `Consent names unknown sensitive choices: ${unexpected.join(', ')}`);
  }
  return {
    authorized: true,
    plan,
    consentDigest: hashCanonical({
      accepted: true,
      approvedSensitiveChoices: [...approved].sort(),
      planDigest: plan.digest,
    }),
  };
}
