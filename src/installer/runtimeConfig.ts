import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import { validateAgentConfig } from '../executor/agentConfig.js';
import type { Scope } from '../gateway/config.js';
import { atomicWritePrivateFile } from '../lifecycle/safeFilesystem.js';
import type { InstallationManifest } from '../lifecycle/manifest.js';
import {
  verifyAuthorizedInstallPlan,
  type AuthorizedInstallPlan,
  type InstallPlan,
  type PlannedProject,
} from './productInstaller.js';
import { PRODUCTION_RUNTIME_COMPONENTS, type ProductionRuntimeComponent } from './productionRelease.js';

export interface InitialRuntimeSecrets {
  internalToken: string;
  dockerAuthorityToken: string;
  ownerApiKey: string;
}

export interface InitialRuntimeCredential {
  principalId: 'owner-control-center';
  apiKey: string;
}

export interface MaterializeInitialRuntimeConfigRequest {
  manifest: InstallationManifest;
  authorizedPlan: AuthorizedInstallPlan;
  secrets: InitialRuntimeSecrets;
}

export interface MaterializeInitialRuntimeConfigResult {
  ownerCredential: InitialRuntimeCredential;
  writtenFiles: string[];
}

export class RuntimeConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

type RandomSource = (size: number) => Buffer;

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function secretFromSeed(seed: Buffer, domain: string): string {
  return createHash('sha256').update(domain).update(Buffer.from([0])).update(seed).digest('base64url');
}

export function createInitialRuntimeSecrets(random: RandomSource): InitialRuntimeSecrets {
  const seed = random(32);
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new RuntimeConfigError('RUNTIME_RANDOM_INVALID', 'Runtime random source must return exactly 32 bytes');
  }
  const internalToken = secretFromSeed(seed, 'quarangate.internal-token.v1');
  const dockerAuthorityToken = secretFromSeed(seed, 'quarangate.docker-authority-token.v1');
  const ownerApiKey = `qg_${secretFromSeed(seed, 'quarangate.owner-api-key.v1')}`;
  if (internalToken === dockerAuthorityToken) {
    throw new RuntimeConfigError('RUNTIME_SECRET_COLLISION', 'Runtime authority tokens must be distinct');
  }
  return { internalToken, dockerAuthorityToken, ownerApiKey };
}

function assertSecretMaterial(secrets: InitialRuntimeSecrets): void {
  const values = [secrets.internalToken, secrets.dockerAuthorityToken, secrets.ownerApiKey];
  if (values.some((value) => typeof value !== 'string' || value.length < 32 || /[\r\n\0]/u.test(value))) {
    throw new RuntimeConfigError('RUNTIME_SECRET_INVALID', 'Runtime secret material is malformed');
  }
  if (new Set(values).size !== values.length) {
    throw new RuntimeConfigError('RUNTIME_SECRET_COLLISION', 'Runtime secrets must be pairwise distinct');
  }
}

function runtimeImages(manifest: InstallationManifest): Record<ProductionRuntimeComponent, { reference: string; digest: string }> {
  const expected = [...PRODUCTION_RUNTIME_COMPONENTS];
  const actual = manifest.runtimeIdentities.map((identity) => identity.component);
  if (actual.length !== expected.length || actual.some((component, index) => component !== expected[index])) {
    throw new RuntimeConfigError('RUNTIME_IMAGE_INVENTORY_INVALID', 'Installed runtime identity does not match the production release profile');
  }
  const out = {} as Record<ProductionRuntimeComponent, { reference: string; digest: string }>;
  for (const identity of manifest.runtimeIdentities) {
    const component = identity.component as ProductionRuntimeComponent;
    if (!identity.reference.includes(manifest.sourceCommit) || !identity.reference.includes(component)) {
      throw new RuntimeConfigError('RUNTIME_IMAGE_IDENTITY_INVALID', `Runtime image identity is not source-bound for ${component}`);
    }
    out[component] = { reference: identity.reference, digest: identity.digest };
  }
  return out;
}

function quoteEnv(value: string, force = false): string {
  if (/\r|\n|\0/u.test(value)) throw new RuntimeConfigError('RUNTIME_ENV_INVALID', 'Runtime environment value contains a control character');
  if (!force && /^[A-Za-z0-9._:/@+\-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}

function envLine(name: string, value: string, forceQuote = false): string {
  return `${name}=${quoteEnv(value, forceQuote)}`;
}

export function assertInitialRuntimePlanActivationDeferred(plan: InstallPlan): InstallPlan {
  const configured = Object.entries(plan.providers)
    .filter(([, choice]) => choice.state === 'CONFIGURED')
    .map(([name]) => name)
    .sort();
  if (configured.length > 0) {
    throw new RuntimeConfigError(
      'PROVIDER_ACTIVATION_REQUIRES_CONFIGURE',
      `Provider activation (${configured.join(', ')}) belongs to the post-install configure/provider qualification steps`,
    );
  }
  if (plan.github.enabled) {
    throw new RuntimeConfigError('GITHUB_ACTIVATION_REQUIRES_CONFIGURE', 'GitHub activation belongs to the post-install configure/GitHub qualification step');
  }
  if (plan.ide.state !== 'UPSTREAM_P7_PENDING') {
    throw new RuntimeConfigError('IDE_ENROLLMENT_REQUIRES_POST_INSTALL', 'IDE binding belongs to the post-install enrollment qualification step');
  }
  if (plan.remote.enabled) {
    throw new RuntimeConfigError('REMOTE_ACTIVATION_REQUIRES_POST_INSTALL', 'Remote access activation is not part of fresh-install package apply');
  }
  return plan;
}

export function assertInitialRuntimeActivationDeferred(planInput: AuthorizedInstallPlan): AuthorizedInstallPlan {
  const authorized = verifyAuthorizedInstallPlan(planInput);
  assertInitialRuntimePlanActivationDeferred(authorized.plan);
  return authorized;
}

function clientDocument(plan: AuthorizedInstallPlan, ownerApiKey: string): unknown {
  const scopes = plan.plan.scopes;
  const agentAuthority = scopes.some((scope) => scope.startsWith('agents:'));
  return {
    clients: [{
      id: 'owner-control-center',
      name: 'QuaranGate Owner Control Center',
      keyHash: sha256(ownerApiKey),
      enabled: true,
      scopes,
      targets: plan.plan.projects.map((project) => project.id),
      rateLimit: 120,
      projects: agentAuthority ? plan.plan.projects.map((project) => project.id) : [],
      agentBackends: agentAuthority ? ['kiro', 'copilot', 'ollama'] : [],
      agentProfiles: agentAuthority ? ['audit', 'plan', 'implement', 'review'] : [],
      githubAccounts: plan.plan.github.enabled ? [plan.plan.github.account] : [],
      githubProjects: plan.plan.github.enabled ? plan.plan.projects.map((project) => project.id) : [],
    }],
  };
}

function bridgeDocument(projects: PlannedProject[]): unknown {
  return {
    discovery: { enabled: false },
    targets: projects.map((project) => ({
      id: project.id,
      composeProject: 'quarangate-projects',
      composeService: project.id,
      workspace: '/workspace',
    })),
  };
}

const profiles = [
  { id: 'audit', workspaceAccess: 'read-only', shellPolicy: 'read-only', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'economy' },
  { id: 'plan', workspaceAccess: 'read-only', shellPolicy: 'none', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'economy' },
  { id: 'implement', workspaceAccess: 'sandbox-write', shellPolicy: 'validation', gitPolicy: 'sandbox', networkPolicy: 'backend-only', defaultResourcePolicy: 'standard' },
  { id: 'review', workspaceAccess: 'read-only', shellPolicy: 'validation', gitPolicy: 'read', networkPolicy: 'backend-only', defaultResourcePolicy: 'standard' },
] as const;

const resourcePolicies = [
  { id: 'economy', modelClass: 'fast', maxRuntimeMs: 600_000, maxCpuMillicores: 1000, maxMemoryBytes: 1_073_741_824, maxPids: 128, maxOutputBytes: 262_144, maxEvidenceBytes: 10_485_760, networkPolicy: 'backend-only', retentionClass: 'ephemeral' },
  { id: 'standard', modelClass: 'standard', maxRuntimeMs: 1_800_000, maxCpuMillicores: 2000, maxMemoryBytes: 2_147_483_648, maxPids: 256, maxOutputBytes: 262_144, maxEvidenceBytes: 52_428_800, networkPolicy: 'backend-only', retentionClass: 'short' },
  { id: 'deep', modelClass: 'deep', maxRuntimeMs: 3_600_000, maxCpuMillicores: 4000, maxMemoryBytes: 4_294_967_296, maxPids: 512, maxOutputBytes: 262_144, maxEvidenceBytes: 104_857_600, maxProviderCredits: 100, networkPolicy: 'backend-only', retentionClass: 'audit' },
] as const;

function agentDocument(projects: PlannedProject[]): unknown {
  const doc = {
    backends: [
      { id: 'kiro', enabled: false, profiles: ['audit', 'plan', 'implement', 'review'], defaultResourcePolicy: 'standard' },
      { id: 'copilot', enabled: false, profiles: ['audit', 'plan', 'review'], defaultResourcePolicy: 'economy' },
      { id: 'ollama', enabled: false, profiles: ['audit', 'plan', 'review'], defaultResourcePolicy: 'economy' },
    ],
    projects: projects.map((project) => ({
      id: project.id,
      hostPath: project.path,
      worktreeId: project.id,
      gitRequired: true,
      backends: ['kiro', 'copilot', 'ollama'],
      profiles: ['audit', 'plan', 'implement', 'review'],
      guardedPaths: project.guards,
      sensitiveReadGlobs: [...new Set([...project.guards, '**/*.key', '**/secrets/**'])].sort(),
    })),
    profiles,
    resourcePolicies,
  };
  validateAgentConfig(doc);
  return doc;
}

function projectsComposeDocument(projects: PlannedProject[]): unknown {
  const services: Record<string, unknown> = {};
  for (const project of projects) {
    services[project.id] = {
      image: '${PROJECTS_WORK_IMAGE:?set immutable projects-work image}',
      pull_policy: 'never',
      working_dir: '/workspace',
      user: '${QG_RUNTIME_UID:?set runtime uid}:${QG_RUNTIME_GID:?set runtime gid}',
      labels: {
        'mcp.bridge.enabled': 'true',
        'mcp.bridge.workspace': '/workspace',
        'mcp.bridge.name': project.id,
      },
      command: ['sh', '-c', 'while true; do sleep 3600; done'],
      volumes: [{
        type: 'bind', source: project.path, target: '/workspace', read_only: project.access === 'READ_ONLY',
        bind: { create_host_path: false },
      }],
      tmpfs: ['/tmp'],
      restart: 'unless-stopped',
      security_opt: ['no-new-privileges:true'],
      cap_drop: ['ALL'],
      read_only: true,
      pids_limit: 512,
      mem_limit: '2g',
    };
  }
  return { name: 'quarangate-projects', services };
}

function runtimeEnv(
  manifest: InstallationManifest,
  stateRoot: string,
  images: ReturnType<typeof runtimeImages>,
  secrets: InitialRuntimeSecrets,
): string {
  const lines = [
    envLine('BRIDGE_PORT', '8787'),
    envLine('BRIDGE_PUBLIC_URL', 'http://127.0.0.1:8787'),
    envLine('GIT_REVISION', manifest.sourceCommit),
    envLine('GATEWAY_IMAGE', images.gateway.reference),
    envLine('GATEWAY_IMAGE_ID', images.gateway.digest),
    envLine('DOCKER_AUTHORITY_IMAGE', images['docker-authority'].reference),
    envLine('DOCKER_AUTHORITY_IMAGE_ID', images['docker-authority'].digest),
    envLine('EXECUTOR_IMAGE', images.executor.reference),
    envLine('EXECUTOR_IMAGE_ID', images.executor.digest),
    envLine('PROJECTS_WORK_IMAGE', images['projects-work'].reference),
    envLine('PROJECTS_WORK_IMAGE_ID', images['projects-work'].digest),
    envLine('AGENT_KIRO_KEY_FILE', path.join(stateRoot, 'credentials/kiro-api-key.placeholder')),
    envLine('INTERNAL_TOKEN', secrets.internalToken, true),
    envLine('DOCKER_AUTHORITY_TOKEN', secrets.dockerAuthorityToken, true),
  ];
  return `${lines.join('\n')}\n`;
}

function yamlBytes(value: unknown): Buffer {
  return Buffer.from(YAML.stringify(value, { lineWidth: 0 }), 'utf8');
}

export function materializeInitialRuntimeConfig(
  request: MaterializeInitialRuntimeConfigRequest,
): MaterializeInitialRuntimeConfigResult {
  const authorizedPlan = assertInitialRuntimeActivationDeferred(request.authorizedPlan);
  const { manifest, secrets } = request;
  assertSecretMaterial(secrets);
  if (authorizedPlan.plan.release.state !== 'VERIFIED_RELEASE'
    || authorizedPlan.plan.release.sourceCommit !== manifest.sourceCommit
    || authorizedPlan.plan.release.manifestDigest !== manifest.releaseDigest
    || authorizedPlan.plan.installRoot !== manifest.roots.install) {
    throw new RuntimeConfigError('RUNTIME_PLAN_RELEASE_MISMATCH', 'Runtime configuration does not match the reviewed install/release identity');
  }
  const planProjects = authorizedPlan.plan.projects;
  if (planProjects.length === 0) throw new RuntimeConfigError('RUNTIME_PROJECTS_EMPTY', 'At least one reviewed project is required');
  const images = runtimeImages(manifest);

  const writtenFiles: string[] = [];
  const writeInstall = (relative: string, bytes: Buffer) => {
    writtenFiles.push(atomicWritePrivateFile(manifest.roots.install, relative, bytes));
  };
  writeInstall('.env', Buffer.from(runtimeEnv(manifest, manifest.roots.state, images, secrets), 'utf8'));
  writeInstall('config/clients.yaml', yamlBytes(clientDocument(authorizedPlan, secrets.ownerApiKey)));
  writeInstall('config/bridge.yaml', yamlBytes(bridgeDocument(planProjects)));
  writeInstall('config/agents.yaml', yamlBytes(agentDocument(planProjects)));
  writeInstall('config/projects.compose.yaml', yamlBytes(projectsComposeDocument(planProjects)));
  writtenFiles.push(atomicWritePrivateFile(manifest.roots.state, 'credentials/kiro-api-key.placeholder', Buffer.alloc(0)));

  return {
    ownerCredential: { principalId: 'owner-control-center', apiKey: secrets.ownerApiKey },
    writtenFiles,
  };
}
