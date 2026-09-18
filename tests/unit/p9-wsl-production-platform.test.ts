import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveInstallPlan,
  buildInstallPlan,
  type HostFacts,
  type InstallerAnswers,
} from '../../src/installer/productInstaller.js';
import { createInstallationManifest } from '../../src/lifecycle/manifest.js';
import {
  WslProductionLifecyclePlatform,
  type PlatformCommandRequest,
  type PlatformCommandResult,
} from '../../src/installer/wslProductionPlatform.js';
import { createInitialRuntimeSecrets } from '../../src/installer/runtimeConfig.js';

const gib = 1024 ** 3;
const commit = 'a'.repeat(40);
const releaseDigest = 'b'.repeat(64);
const digests = {
  'docker-authority': `sha256:${'1'.repeat(64)}`,
  executor: `sha256:${'2'.repeat(64)}`,
  gateway: `sha256:${'3'.repeat(64)}`,
  'projects-work': `sha256:${'4'.repeat(64)}`,
};

function facts(): HostFacts {
  return {
    platform: 'wsl', platformVersion: '6.6.114.1-microsoft-standard-WSL2', wslDistribution: 'Ubuntu-24.04', wslVersion: 2,
    runtimeUser: { name: 'herman', uid: 1000, gid: 1000 },
    docker: { available: true, version: '29.7.2', daemonReachable: true },
    compose: { available: true, version: '5.5.0' }, git: { available: true, version: '2.43.0' },
    node: { available: true, version: '24.20.0' }, cpuCores: 8, memoryBytes: 32 * gib,
    storageBytesFree: 100 * gib,
    filesystem: { supportsAtomicRename: true, caseSensitive: true, installRootIsSymlink: false }, gpu: { present: false },
  };
}

function fixture(startup = true) {
  const base = mkdtempSync(path.join(tmpdir(), 'qg-p9-wsl-platform-'));
  chmodSync(base, 0o700);
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  const packageRoot = path.join(base, 'package');
  const project = path.join(base, 'project');
  const answers: InstallerAnswers = {
    schemaVersion: 1, host: facts(), profile: 'RECOMMENDED',
    release: { state: 'VERIFIED_RELEASE', productVersion: '1.0.0', sourceCommit: commit, manifestDigest: releaseDigest },
    installRoot: install,
    roots: { state, evidence: path.join(state, 'evidence'), models: path.join(state, 'models'), backups: path.join(state, 'backups'), cache: path.join(base, 'cache') },
    projects: [{ id: 'sample-project', path: project, access: 'READ_ONLY' }],
    providers: { kiro: { state: 'DEFERRED_ENTITLEMENT' }, copilot: { state: 'DEFERRED_ENTITLEMENT' }, ollama: { state: 'DISABLED' } },
    localAi: { profile: 'EFFICIENT', model: { id: 'qwen3.5:4b-q4_K_M', runtime: 'ollama', contextTokens: 32768 }, limits: { cpuCores: 2, memoryBytes: 4 * gib, vramBytes: 4 * gib } },
    ide: { state: 'UPSTREAM_P7_PENDING' }, github: { enabled: false }, remote: { enabled: false },
    clientPermissions: ['READ_FILES', 'INSPECT_OPERATIONS'],
    startup: startup ? { enabled: true, mechanism: 'WINDOWS_TASK_SCHEDULER_WSL', runLevel: 'LIMITED' } : { enabled: false },
    backup: { profile: 'RECOMMENDED', location: path.join(state, 'backups'), include: ['CONFIG'], includeCredentials: false },
  };
  const plan = buildInstallPlan(answers);
  const authorizedPlan = approveInstallPlan(plan, { accepted: true, expectedPlanDigest: plan.digest, approvedSensitiveChoices: plan.requiredConsents });
  const runtimeIdentities = [
    { component: 'docker-authority', reference: `quarangate:docker-authority-${commit}`, digest: digests['docker-authority'] },
    { component: 'executor', reference: `quarangate:executor-${commit}`, digest: digests.executor },
    { component: 'gateway', reference: `quarangate:gateway-${commit}`, digest: digests.gateway },
    { component: 'projects-work', reference: `quarangate:projects-work-${commit}`, digest: digests['projects-work'] },
  ];
  const startupRegistrations = startup ? [{
    id: 'quarangate-user-startup', mechanism: 'WINDOWS_TASK_SCHEDULER_WSL' as const,
    identityDigest: 'c'.repeat(64), enabled: true,
  }] : [];
  const manifest = createInstallationManifest({
    schemaVersion: 1, installationId: '123e4567-e89b-42d3-a456-426614174000', lifecycleState: 'REPAIR_REQUIRED',
    productVersion: '1.0.0', sourceCommit: commit, releaseDigest, configSchemaVersion: 0, stateSchemaVersion: 0,
    installedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
    components: runtimeIdentities.map((x) => x.component), integrations: {
      providers: { kiro: { state: 'DEFERRED_ENTITLEMENT' }, copilot: { state: 'DEFERRED_ENTITLEMENT' }, ollama: { state: 'DISABLED' } },
      ide: { state: 'UPSTREAM_P7_PENDING' }, github: { state: 'DISABLED' },
    },
    roots: { install, ...answers.roots }, runtimeIdentities, migrations: [], startupRegistrations,
    clientRegistrations: [], sessionResumePolicy: {
      mutating: 'REFUSE_ON_SOURCE_DRIFT_NEW_SESSION_NO_INHERITED_AUTHORITY',
      readOnly: 'RE_ATTEST_REAUTHORIZE_NEW_GENERATION_ZERO_MUTATION_AUTHORITY',
      historicalMemory: 'CONTEXT_ONLY_NEVER_AUTHORITY',
    }, health: { state: 'UNHEALTHY', verifiedAt: '2026-09-18T00:00:00.000Z' },
  });
  return { base, install, state, packageRoot, project, authorizedPlan, manifest };
}

class FakeHost {
  readonly calls: PlatformCommandRequest[] = [];
  core = '';
  projects = '';
  task: { exists: boolean; description?: string; execute?: string; arguments?: string; principalUserId?: string; principalLogonType?: string; principalRunLevel?: string; triggerType?: string; triggerUserId?: string } = { exists: false };
  networks: string[] = [];
  volumes: string[] = [];
  readonly composeNetworks = new Map<string, string[]>();
  readonly composeVolumes = new Map<string, string[]>();
  readonly states = new Map<string, string>();

  result(stdout = ''): PlatformCommandResult { return { exitCode: 0, stdout, stderr: '', timedOut: false }; }

  private resourceOutput(kind: 'network' | 'volume', request: PlatformCommandRequest): string {
    const filterIndex = request.args.indexOf('--filter');
    const filter = filterIndex >= 0 ? request.args[filterIndex + 1] ?? '' : '';
    const prefix = 'label=com.docker.compose.project=';
    if (filter.startsWith(prefix)) {
      const project = filter.slice(prefix.length);
      const source = kind === 'network' ? this.composeNetworks : this.composeVolumes;
      const values = source.get(project) ?? [];
      return values.length > 0 ? values.join('\n') + '\n' : '';
    }
    const values = kind === 'network' ? this.networks : this.volumes;
    return values.length > 0 ? values.join('\n') + '\n' : '';
  }

  run = async (request: PlatformCommandRequest): Promise<PlatformCommandResult> => {
    this.calls.push(request);
    if (request.program === 'wslpath') {
      return this.result(`C:\\pkg\\${path.basename(request.args[1] ?? request.args[0] ?? 'script.ps1')}\n`);
    }
    if (request.program === 'powershell.exe') {
      const joined = request.args.join(' ');
      if (joined.includes('Inspect-QuaranGateProductionAutostart.ps1')) return this.result(`${JSON.stringify(this.task)}\n`);
      if (joined.includes('Install-QuaranGateProductionAutostart.ps1')) {
        const digestIndex = request.args.indexOf('-IdentityDigest');
        const rootIndex = request.args.indexOf('-InstallRoot');
        const digest = request.args[digestIndex + 1]!;
        const root = request.args[rootIndex + 1]!;
        this.task = {
          exists: true,
          description: `QuaranGate production startup identity=${digest}`,
          execute: 'C:\\Windows\\System32\\wsl.exe',
          arguments: `"--distribution" "Ubuntu-24.04" "--user" "herman" "--exec" "bash" "${root}/scripts/production-runtime-start.sh"`,
          principalUserId: 'DESKTOP\\herman',
          principalLogonType: 'Interactive',
          principalRunLevel: 'Limited',
          triggerType: 'MSFT_TaskLogonTrigger',
          triggerUserId: 'DESKTOP\\herman',
        };
        return this.result('PRODUCTION_AUTOSTART_INSTALL=PASS\n');
      }
      if (joined.includes('Remove-QuaranGateProductionAutostart.ps1')) {
        this.task = { exists: false };
        return this.result('PRODUCTION_AUTOSTART_REMOVE=PASS\n');
      }
      if (joined.includes('Open-QuaranGateControlCenter.ps1')) return this.result('CONTROL_CENTER_OPEN=PASS\n');
    }
    if (request.program === 'docker' && request.args[0] === 'ps') {
      const filter = request.args[request.args.indexOf('--filter') + 1] ?? '';
      return this.result(filter.endsWith('=quarangate-projects') ? this.projects : this.core);
    }
    if (request.program === 'docker' && request.args[0] === 'network' && request.args[1] === 'ls') {
      return this.result(this.resourceOutput('network', request));
    }
    if (request.program === 'docker' && request.args[0] === 'volume' && request.args[1] === 'ls') {
      return this.result(this.resourceOutput('volume', request));
    }
    if (request.program === 'docker' && request.args[0] === 'inspect') {
      return this.result(`${this.states.get(request.args[1]!) ?? ''}\n`);
    }
    if (request.program === 'bash') return this.result('PASS\n');
    return { exitCode: 127, stdout: '', stderr: 'unexpected command', timedOut: false };
  };
}

describe('P9 WSL production lifecycle platform', () => {
  it('refuses to adopt any pre-existing fresh-install runtime authority', async () => {
    const fx = fixture(false);
    const host = new FakeHost();
    host.core = 'aaaaaaaaaaaa|gateway\n';
    const platform = new WslProductionLifecyclePlatform({
      authorizedPlan: fx.authorizedPlan, packageRoot: fx.packageRoot,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 5)), run: host.run,
    });
    await expect(platform.inspectAuthority(fx.manifest)).resolves.toEqual({ duplicateAuthority: true, staleRegistrations: false });
    expect(host.calls.every((call) => call.program !== 'bash')).toBe(true);
  });

  it.each([
    ['unlabelled reserved network', 'network', 'quarangate-edge'],
    ['unlabelled retained durable volume', 'volume', 'mcp-bridge-jobs'],
  ] as const)('refuses fresh install when a %s already exists', async (_label, kind, name) => {
    const fx = fixture(false);
    const host = new FakeHost();
    if (kind === 'network') host.networks = [name];
    else host.volumes = [name];
    const platform = new WslProductionLifecyclePlatform({
      authorizedPlan: fx.authorizedPlan, packageRoot: fx.packageRoot,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 7)), run: host.run,
    });

    await expect(platform.inspectAuthority(fx.manifest)).resolves.toEqual({
      duplicateAuthority: true, staleRegistrations: false,
    });
    expect(host.calls.every((call) => call.program !== 'bash')).toBe(true);
  });

  it('refuses fresh install when any Compose-labelled network remains without containers', async () => {
    const fx = fixture(false);
    const host = new FakeHost();
    host.composeNetworks.set('quarangate-projects', ['old-project-network']);
    const platform = new WslProductionLifecyclePlatform({
      authorizedPlan: fx.authorizedPlan, packageRoot: fx.packageRoot,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 8)), run: host.run,
    });

    await expect(platform.inspectAuthority(fx.manifest)).resolves.toEqual({
      duplicateAuthority: true, staleRegistrations: false,
    });
  });

  it('fails closed on malformed Docker resource inventory output', async () => {
    const fx = fixture(false);
    const host = new FakeHost();
    host.networks = ['bad resource name'];
    const platform = new WslProductionLifecyclePlatform({
      authorizedPlan: fx.authorizedPlan, packageRoot: fx.packageRoot,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 10)), run: host.run,
    });

    await expect(platform.inspectAuthority(fx.manifest)).rejects.toThrow(/malformed or duplicate resource identity/iu);
  });

  it('materializes config, reconciles the exact startup identity, and reports only exact live image identities healthy', async () => {
    const fx = fixture(true);
    const host = new FakeHost();
    const platform = new WslProductionLifecyclePlatform({
      authorizedPlan: fx.authorizedPlan, packageRoot: fx.packageRoot,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 6)), run: host.run,
    });

    await platform.materializeRuntimeConfig(fx.manifest);
    const credential = platform.takeOwnerCredential();
    expect(credential?.principalId).toBe('owner-control-center');
    expect(platform.takeOwnerCredential()).toBeNull();

    await platform.reconcileStartup(fx.manifest);
    host.core = [
      'aaaaaaaaaaaa|docker-authority', 'bbbbbbbbbbbb|executor', 'cccccccccccc|gateway',
    ].join('\n') + '\n';
    host.projects = 'dddddddddddd|sample-project\n';
    host.states.set('aaaaaaaaaaaa', `${digests['docker-authority']}|true|healthy`);
    host.states.set('bbbbbbbbbbbb', `${digests.executor}|true|healthy`);
    host.states.set('cccccccccccc', `${digests.gateway}|true|healthy`);
    host.states.set('dddddddddddd', `${digests['projects-work']}|true|none`);

    await expect(platform.inspectAuthority({ ...fx.manifest, lifecycleState: 'INSTALLED' })).resolves.toEqual({
      duplicateAuthority: false, staleRegistrations: false,
    });
    await expect(platform.inspectRuntime(fx.manifest)).resolves.toMatchObject({
      running: true, healthy: true, sourceCommit: commit, releaseDigest,
      runtimeIdentities: fx.manifest.runtimeIdentities,
    });

    host.states.set('cccccccccccc', `sha256:${'9'.repeat(64)}|true|healthy`);
    await expect(platform.inspectRuntime(fx.manifest)).resolves.toMatchObject({
      running: true, healthy: false, sourceCommit: null, releaseDigest: null, runtimeIdentities: [],
    });
  });

  it('treats a startup task with drifted WSL distribution or Linux user as stale authority', async () => {
    const fx = fixture(true);
    const host = new FakeHost();
    const platform = new WslProductionLifecyclePlatform({
      authorizedPlan: fx.authorizedPlan, packageRoot: fx.packageRoot,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 11)), run: host.run,
    });

    await platform.materializeRuntimeConfig(fx.manifest);
    await platform.reconcileStartup(fx.manifest);
    host.task.arguments = host.task.arguments!.replace('"Ubuntu-24.04"', '"Other-Distro"');

    await expect(platform.inspectAuthority({ ...fx.manifest, lifecycleState: 'INSTALLED' })).resolves.toEqual({
      duplicateAuthority: false, staleRegistrations: true,
    });
  });

  it('treats startup principal, run-level, or trigger drift as stale authority', async () => {
    const fx = fixture(true);
    const host = new FakeHost();
    const platform = new WslProductionLifecyclePlatform({
      authorizedPlan: fx.authorizedPlan, packageRoot: fx.packageRoot,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 12)), run: host.run,
    });

    await platform.materializeRuntimeConfig(fx.manifest);
    await platform.reconcileStartup(fx.manifest);
    host.task.principalRunLevel = 'Highest';

    await expect(platform.inspectAuthority({ ...fx.manifest, lifecycleState: 'INSTALLED' })).resolves.toEqual({
      duplicateAuthority: false, staleRegistrations: true,
    });

    host.task.principalRunLevel = 'Limited';
    host.task.triggerUserId = 'DESKTOP\\other';
    await expect(platform.inspectAuthority({ ...fx.manifest, lifecycleState: 'INSTALLED' })).resolves.toEqual({
      duplicateAuthority: false, staleRegistrations: true,
    });
  });

  it('uses only fixed argv process execution for runtime start/stop and loopback Control Center open', async () => {
    const fx = fixture(false);
    const host = new FakeHost();
    const platform = new WslProductionLifecyclePlatform({
      authorizedPlan: fx.authorizedPlan, packageRoot: fx.packageRoot,
      secrets: createInitialRuntimeSecrets((n) => Buffer.alloc(n, 9)), run: host.run,
    });
    await platform.startRuntime(fx.manifest);
    await platform.stopRuntime(fx.manifest);
    await platform.openControlCenter('http://127.0.0.1:8787');
    const bash = host.calls.filter((call) => call.program === 'bash');
    expect(bash.map((call) => call.args[0])).toEqual([
      path.join(fx.install, 'scripts/production-runtime-start.sh'),
      path.join(fx.install, 'scripts/production-runtime-stop.sh'),
    ]);
    expect(host.calls.some((call) => call.program === 'powershell.exe'
      && call.args.includes('RemoteSigned') && call.args.includes('-File'))).toBe(true);
    expect(host.calls.every((call) => !['sh', 'cmd.exe'].includes(call.program))).toBe(true);
  });
});
