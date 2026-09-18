import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateAgentConfig } from '../../src/executor/agentConfig.js';
import {
  approveInstallPlan,
  buildInstallPlan,
  type HostFacts,
  type InstallerAnswers,
} from '../../src/installer/productInstaller.js';
import {
  createInitialRuntimeSecrets,
  materializeInitialRuntimeConfig,
} from '../../src/installer/runtimeConfig.js';
import { createInstallationManifest } from '../../src/lifecycle/manifest.js';

const gib = 1024 ** 3;
const commit = 'a'.repeat(40);
const releaseDigest = 'b'.repeat(64);
const imageDigest = (n: string) => `sha256:${n.repeat(64)}`;

function facts(): HostFacts {
  return {
    platform: 'wsl', platformVersion: '2', wslDistribution: 'Ubuntu-24.04', wslVersion: 2,
    runtimeUser: { name: 'herman', uid: 1000, gid: 1000 },
    docker: { available: true, version: '29.7.2', daemonReachable: true },
    compose: { available: true, version: '5.5.0' }, git: { available: true, version: '2.43.0' },
    node: { available: true, version: '24.20.0' }, cpuCores: 8, memoryBytes: 32 * gib,
    storageBytesFree: 100 * gib,
    filesystem: { supportsAtomicRename: true, caseSensitive: true, installRootIsSymlink: false },
    gpu: { present: true, vramBytes: 12 * gib },
  };
}

function fixture(providerOverride?: InstallerAnswers['providers']) {
  const base = mkdtempSync(path.join(tmpdir(), 'qg-p9-runtime-config-'));
  chmodSync(base, 0o700);
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  const roots = {
    state,
    evidence: path.join(state, 'evidence'),
    models: path.join(state, 'models'),
    backups: path.join(state, 'backups'),
    cache: path.join(base, 'cache'),
  };
  const project = path.join(base, 'project');
  const answers: InstallerAnswers = {
    schemaVersion: 1,
    host: facts(),
    profile: 'RECOMMENDED',
    release: { state: 'VERIFIED_RELEASE', productVersion: '1.0.0', sourceCommit: commit, manifestDigest: releaseDigest },
    installRoot: install,
    roots,
    projects: [{ id: 'sample-project', path: project, access: 'READ_ONLY' }],
    providers: providerOverride ?? {
      kiro: { state: 'DEFERRED_ENTITLEMENT' },
      copilot: { state: 'DEFERRED_ENTITLEMENT' },
      ollama: { state: 'DISABLED' },
    },
    localAi: {
      profile: 'EFFICIENT', model: { id: 'qwen3.5:4b-q4_K_M', runtime: 'ollama', contextTokens: 32768 },
      limits: { cpuCores: 2, memoryBytes: 4 * gib, vramBytes: 4 * gib },
    },
    ide: { state: 'UPSTREAM_P7_PENDING' }, github: { enabled: false }, remote: { enabled: false },
    clientPermissions: ['READ_FILES', 'REVIEW_CHANGES', 'INSPECT_OPERATIONS'],
    startup: { enabled: false },
    backup: { profile: 'RECOMMENDED', location: roots.backups, include: ['CONFIG', 'PROJECT_REFERENCES'], includeCredentials: false },
  };
  const plan = buildInstallPlan(answers);
  const authorizedPlan = approveInstallPlan(plan, {
    accepted: true, expectedPlanDigest: plan.digest, approvedSensitiveChoices: plan.requiredConsents,
  });
  const runtimeIdentities = [
    { component: 'docker-authority', reference: `quarangate:docker-authority-${commit}`, digest: imageDigest('1') },
    { component: 'executor', reference: `quarangate:executor-${commit}`, digest: imageDigest('2') },
    { component: 'gateway', reference: `quarangate:gateway-${commit}`, digest: imageDigest('3') },
    { component: 'projects-work', reference: `quarangate:projects-work-${commit}`, digest: imageDigest('4') },
  ];
  const manifest = createInstallationManifest({
    schemaVersion: 1, installationId: '123e4567-e89b-42d3-a456-426614174000', lifecycleState: 'REPAIR_REQUIRED',
    productVersion: '1.0.0', sourceCommit: commit, releaseDigest, configSchemaVersion: 0, stateSchemaVersion: 0,
    installedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
    components: runtimeIdentities.map((x) => x.component),
    integrations: {
      providers: { kiro: { state: 'DEFERRED_ENTITLEMENT' }, copilot: { state: 'DEFERRED_ENTITLEMENT' }, ollama: { state: 'DISABLED' } },
      ide: { state: 'UPSTREAM_P7_PENDING' }, github: { state: 'DISABLED' },
    },
    roots: { install, ...roots }, runtimeIdentities, migrations: [], startupRegistrations: [],
    clientRegistrations: [],
    sessionResumePolicy: {
      mutating: 'REFUSE_ON_SOURCE_DRIFT_NEW_SESSION_NO_INHERITED_AUTHORITY',
      readOnly: 'RE_ATTEST_REAUTHORIZE_NEW_GENERATION_ZERO_MUTATION_AUTHORITY',
      historicalMemory: 'CONTEXT_ONLY_NEVER_AUTHORITY',
    },
    health: { state: 'UNHEALTHY', verifiedAt: '2026-09-18T00:00:00.000Z' },
  });
  return { base, install, state, project, authorizedPlan, manifest };
}

describe('P9 initial production runtime configuration', () => {
  it('materializes private, deterministic runtime config and returns the owner key only once', () => {
    const fx = fixture();
    const secrets = createInitialRuntimeSecrets((n) => Buffer.alloc(n, 7));
    const result = materializeInitialRuntimeConfig({ manifest: fx.manifest, authorizedPlan: fx.authorizedPlan, secrets });

    expect(result.ownerCredential.principalId).toBe('owner-control-center');
    expect(result.ownerCredential.apiKey).toBe(secrets.ownerApiKey);
    const env = readFileSync(path.join(fx.install, '.env'), 'utf8');
    expect(env).toContain(`GIT_REVISION=${commit}`);
    expect(env).toContain(`GATEWAY_IMAGE=quarangate:gateway-${commit}`);
    expect(env).toContain(`PROJECTS_WORK_IMAGE_ID=${imageDigest('4')}`);
    expect(env).toContain(`INTERNAL_TOKEN=${JSON.stringify(secrets.internalToken)}`);
    expect(env).not.toContain(secrets.ownerApiKey);

    const clients = YAML.parse(readFileSync(path.join(fx.install, 'config/clients.yaml'), 'utf8'));
    expect(clients.clients).toHaveLength(1);
    expect(clients.clients[0].keyHash).toBe(createHash('sha256').update(secrets.ownerApiKey).digest('hex'));
    expect(clients.clients[0].targets).toEqual(['sample-project']);
    expect(JSON.stringify(clients)).not.toContain(secrets.ownerApiKey);

    const bridge = YAML.parse(readFileSync(path.join(fx.install, 'config/bridge.yaml'), 'utf8'));
    expect(bridge.targets).toEqual([{
      id: 'sample-project', composeProject: 'quarangate-projects', composeService: 'sample-project', workspace: '/workspace',
    }]);

    const agents = YAML.parse(readFileSync(path.join(fx.install, 'config/agents.yaml'), 'utf8'));
    expect(() => validateAgentConfig(agents)).not.toThrow();
    expect(agents.backends.every((backend: { enabled: boolean }) => backend.enabled === false)).toBe(true);

    const projects = YAML.parse(readFileSync(path.join(fx.install, 'config/projects.compose.yaml'), 'utf8'));
    expect(projects.services['sample-project'].volumes[0]).toMatchObject({ source: fx.project, target: '/workspace', read_only: true });
    expect(projects.services['sample-project'].pull_policy).toBe('never');

    expect(readFileSync(path.join(fx.state, 'credentials/kiro-api-key.placeholder'))).toHaveLength(0);
  });

  it('refuses to silently activate configured providers during fresh-install materialization', () => {
    const fx = fixture({
      kiro: { state: 'DEFERRED_ENTITLEMENT' },
      copilot: { state: 'DEFERRED_ENTITLEMENT' },
      ollama: { state: 'CONFIGURED' },
    });
    expect(() => materializeInitialRuntimeConfig({
      manifest: fx.manifest,
      authorizedPlan: fx.authorizedPlan,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 8)),
    })).toThrow(/provider activation.*configure/iu);
  });
});
