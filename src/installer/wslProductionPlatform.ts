import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { InstallationManifest } from '../lifecycle/manifest.js';
import { LifecycleDriverError } from '../lifecycle/engine.js';
import {
  type AuthorityInspection,
  type ProductionLifecyclePlatform,
  type RuntimeInspection,
} from '../lifecycle/productionDriver.js';
import {
  assertInitialRuntimeActivationDeferred,
  createInitialRuntimeSecrets,
  materializeInitialRuntimeConfig,
  type InitialRuntimeCredential,
  type InitialRuntimeSecrets,
} from './runtimeConfig.js';
import type { AuthorizedInstallPlan } from './productInstaller.js';

const MAX_COMMAND_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const CORE_SERVICES = ['docker-authority', 'executor', 'gateway'] as const;

export interface PlatformCommandRequest {
  program: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface PlatformCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type PlatformCommandRunner = (request: PlatformCommandRequest) => Promise<PlatformCommandResult>;

export interface WslProductionPlatformOptions {
  authorizedPlan: AuthorizedInstallPlan;
  /** Verified release payload root; preflight control scripts run from here. */
  packageRoot: string;
  secrets?: InitialRuntimeSecrets;
  run?: PlatformCommandRunner;
}

interface ComposeContainer {
  id: string;
  service: string;
}

interface StartupTaskInspection {
  exists: boolean;
  description?: string;
  execute?: string;
  arguments?: string;
}

interface ContainerRuntimeState {
  imageId: string;
  running: boolean;
  health: string;
}

export function defaultPlatformCommandRunner(request: PlatformCommandRequest): Promise<PlatformCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(request.program, request.args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      if (outputExceeded) return current;
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_COMMAND_OUTPUT) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return current;
      }
      return next;
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr, timedOut: false });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: outputExceeded ? 125 : (typeof code === 'number' ? code : 127),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function parseComposeLines(stdout: string): ComposeContainer[] {
  if (!stdout.trim()) return [];
  return stdout.trim().split(/\r?\n/u).map((line) => {
    const parts = line.split('|');
    if (parts.length !== 2 || !/^[0-9a-f]{12,64}$/u.test(parts[0] ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(parts[1] ?? '')) {
      throw new LifecycleDriverError('PLATFORM_DOCKER_OUTPUT_INVALID', 'Docker authority inspection returned malformed container identity', false);
    }
    return { id: parts[0]!, service: parts[1]! };
  });
}

function exactOneByService(containers: ComposeContainer[], expected: readonly string[]): {
  duplicate: boolean;
  unknown: boolean;
  missing: boolean;
} {
  const counts = new Map<string, number>();
  let unknown = false;
  for (const container of containers) {
    if (!expected.includes(container.service)) unknown = true;
    counts.set(container.service, (counts.get(container.service) ?? 0) + 1);
  }
  return {
    duplicate: [...counts.values()].some((count) => count > 1),
    unknown,
    missing: expected.some((service) => (counts.get(service) ?? 0) !== 1),
  };
}

export class WslProductionLifecyclePlatform implements ProductionLifecyclePlatform {
  private readonly plan: AuthorizedInstallPlan;
  private readonly packageRoot: string;
  private readonly secrets: InitialRuntimeSecrets;
  private readonly run: PlatformCommandRunner;
  private runtimeProvisioned = false;
  private ownerCredential: InitialRuntimeCredential | null = null;

  constructor(options: WslProductionPlatformOptions) {
    this.plan = assertInitialRuntimeActivationDeferred(options.authorizedPlan);
    if (this.plan.plan.hostBinding.platform !== 'wsl' || this.plan.plan.hostBinding.wslVersion !== 2
      || !this.plan.plan.hostBinding.wslDistribution) {
      throw new LifecycleDriverError('WSL2_HOST_BINDING_REQUIRED', 'Windows production package apply requires an exact WSL2 host binding', false);
    }
    if (this.plan.plan.startup.enabled && this.plan.plan.startup.mechanism !== 'WINDOWS_TASK_SCHEDULER_WSL') {
      throw new LifecycleDriverError('STARTUP_MECHANISM_UNSUPPORTED', 'The Windows production platform requires the bounded WSL Task Scheduler startup mechanism', false);
    }
    const packageRoot = path.resolve(options.packageRoot);
    if (packageRoot !== options.packageRoot || packageRoot === path.parse(packageRoot).root) {
      throw new LifecycleDriverError('PACKAGE_ROOT_INVALID', 'Production package root must be a canonical absolute path', false);
    }
    this.packageRoot = packageRoot;
    this.secrets = options.secrets ?? createInitialRuntimeSecrets((size) => randomBytes(size));
    this.run = options.run ?? defaultPlatformCommandRunner;
  }

  takeOwnerCredential(): InitialRuntimeCredential | null {
    const credential = this.ownerCredential;
    this.ownerCredential = null;
    return credential;
  }

  private async checked(request: PlatformCommandRequest, code = 'PLATFORM_COMMAND_FAILED'): Promise<PlatformCommandResult> {
    const result = await this.run(request);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new LifecycleDriverError(code, `Production platform command failed: ${request.program}`, false);
    }
    return result;
  }

  private packageScript(relative: string): string {
    return path.join(this.packageRoot, ...relative.split('/'));
  }

  private async windowsPath(linuxPath: string): Promise<string> {
    const result = await this.checked({ program: 'wslpath', args: ['-w', linuxPath], timeoutMs: 5_000 }, 'WINDOWS_PATH_RESOLUTION_FAILED');
    const converted = result.stdout.trim();
    if (!converted || /[\r\n\0]/u.test(converted)) {
      throw new LifecycleDriverError('WINDOWS_PATH_RESOLUTION_FAILED', 'WSL path conversion returned an invalid Windows path', false);
    }
    return converted;
  }

  private async powershellScript(relative: string, args: string[] = []): Promise<PlatformCommandResult> {
    const windowsScript = await this.windowsPath(this.packageScript(relative));
    return this.checked({
      program: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', windowsScript, ...args],
      timeoutMs: 30_000,
    }, 'WINDOWS_CONTROL_COMMAND_FAILED');
  }

  private async inspectStartup(): Promise<StartupTaskInspection> {
    const result = await this.powershellScript('scripts/windows/Inspect-QuaranGateProductionAutostart.ps1');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      throw new LifecycleDriverError('STARTUP_INSPECTION_INVALID', 'Startup inspection did not return valid JSON', false);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { exists?: unknown }).exists !== 'boolean') {
      throw new LifecycleDriverError('STARTUP_INSPECTION_INVALID', 'Startup inspection returned an invalid schema', false);
    }
    const value = parsed as Record<string, unknown>;
    if (value.exists === false) return { exists: false };
    if (typeof value.description !== 'string' || typeof value.execute !== 'string' || typeof value.arguments !== 'string') {
      throw new LifecycleDriverError('STARTUP_INSPECTION_INVALID', 'Startup inspection is missing task identity fields', false);
    }
    return { exists: true, description: value.description, execute: value.execute, arguments: value.arguments };
  }

  private expectedStartup(manifest: InstallationManifest): { digest: string; script: string } | null {
    if (manifest.startupRegistrations.length === 0) return null;
    if (manifest.startupRegistrations.length !== 1) {
      throw new LifecycleDriverError('STARTUP_REGISTRATION_INVALID', 'Production runtime permits at most one startup registration', false);
    }
    const registration = manifest.startupRegistrations[0]!;
    if (!registration.enabled) return null;
    if (registration.mechanism !== 'WINDOWS_TASK_SCHEDULER_WSL') {
      throw new LifecycleDriverError('STARTUP_MECHANISM_UNSUPPORTED', 'Unsupported production startup mechanism', false);
    }
    return {
      digest: registration.identityDigest,
      script: `${manifest.roots.install}/scripts/production-runtime-start.sh`,
    };
  }

  private startupMatches(task: StartupTaskInspection, expected: { digest: string; script: string }): boolean {
    if (!task.exists || !task.description || !task.execute || !task.arguments) return false;
    return task.description === `QuaranGate production startup identity=${expected.digest}`
      && path.win32.basename(task.execute).toLowerCase() === 'wsl.exe'
      && task.arguments.includes('--exec')
      && task.arguments.includes('bash')
      && task.arguments.includes(expected.script);
  }

  private async listCompose(project: string): Promise<ComposeContainer[]> {
    const result = await this.checked({
      program: 'docker',
      args: ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}|{{.Label "com.docker.compose.service"}}'],
      timeoutMs: 15_000,
    }, 'DOCKER_AUTHORITY_INSPECTION_FAILED');
    return parseComposeLines(result.stdout);
  }

  private async containerState(id: string): Promise<ContainerRuntimeState> {
    const result = await this.checked({
      program: 'docker',
      args: ['inspect', id, '--format', '{{.Image}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'],
      timeoutMs: 10_000,
    }, 'DOCKER_RUNTIME_INSPECTION_FAILED');
    const parts = result.stdout.trim().split('|');
    if (parts.length !== 3 || !/^sha256:[0-9a-f]{64}$/u.test(parts[0] ?? '') || !['true', 'false'].includes(parts[1] ?? '')) {
      throw new LifecycleDriverError('DOCKER_RUNTIME_INSPECTION_INVALID', 'Docker runtime inspection returned malformed state', false);
    }
    return { imageId: parts[0]!, running: parts[1] === 'true', health: parts[2]! };
  }

  async materializeRuntimeConfig(manifest: InstallationManifest): Promise<void> {
    const result = materializeInitialRuntimeConfig({
      manifest,
      authorizedPlan: this.plan,
      secrets: this.secrets,
    });
    this.ownerCredential = result.ownerCredential;
    this.runtimeProvisioned = true;
  }

  async inspectAuthority(manifest: InstallationManifest): Promise<AuthorityInspection> {
    const core = await this.listCompose('quarangate');
    const projects = await this.listCompose('quarangate-projects');
    const startup = await this.inspectStartup();

    // Before this package has materialized its own runtime config, ANY existing
    // authority is a collision. Never adopt a same-named pre-existing runtime.
    if (!this.runtimeProvisioned) {
      return {
        duplicateAuthority: core.length > 0 || projects.length > 0,
        staleRegistrations: startup.exists,
      };
    }

    const coreShape = exactOneByService(core, CORE_SERVICES);
    const expectedProjects = this.plan.plan.projects.map((project) => project.id).sort();
    const projectShape = exactOneByService(projects, expectedProjects);
    const expectedStartup = this.expectedStartup(manifest);
    let staleStartup = false;
    if (expectedStartup) {
      staleStartup = !this.startupMatches(startup, expectedStartup);
    } else {
      staleStartup = startup.exists;
    }
    return {
      duplicateAuthority: coreShape.duplicate || projectShape.duplicate,
      staleRegistrations: coreShape.unknown || projectShape.unknown || staleStartup,
    };
  }

  async reconcileStartup(manifest: InstallationManifest): Promise<void> {
    const expected = this.expectedStartup(manifest);
    if (!expected) {
      await this.removeStartup(manifest);
      return;
    }
    const host = this.plan.plan.hostBinding;
    await this.powershellScript('scripts/windows/Install-QuaranGateProductionAutostart.ps1', [
      '-Distribution', host.wslDistribution!,
      '-LinuxUser', host.runtimeUser.name,
      '-InstallRoot', manifest.roots.install,
      '-IdentityDigest', expected.digest,
    ]);
    const observed = await this.inspectStartup();
    if (!this.startupMatches(observed, expected)) {
      throw new LifecycleDriverError('STARTUP_RECONCILIATION_FAILED', 'Startup registration did not match the reviewed identity after reconciliation', true);
    }
  }

  async removeStartup(_manifest: InstallationManifest): Promise<void> {
    await this.powershellScript('scripts/windows/Remove-QuaranGateProductionAutostart.ps1');
  }

  async startRuntime(manifest: InstallationManifest): Promise<void> {
    const script = path.join(manifest.roots.install, 'scripts/production-runtime-start.sh');
    await this.checked({ program: 'bash', args: [script], cwd: manifest.roots.install, timeoutMs: 180_000 }, 'PRODUCTION_RUNTIME_START_FAILED');
  }

  async stopRuntime(manifest: InstallationManifest): Promise<void> {
    const script = path.join(manifest.roots.install, 'scripts/production-runtime-stop.sh');
    await this.checked({ program: 'bash', args: [script], cwd: manifest.roots.install, timeoutMs: 120_000 }, 'PRODUCTION_RUNTIME_STOP_FAILED');
  }

  async inspectRuntime(manifest: InstallationManifest): Promise<RuntimeInspection> {
    const core = await this.listCompose('quarangate');
    const projects = await this.listCompose('quarangate-projects');
    const coreShape = exactOneByService(core, CORE_SERVICES);
    const expectedProjects = this.plan.plan.projects.map((project) => project.id).sort();
    const projectShape = exactOneByService(projects, expectedProjects);
    if (coreShape.duplicate || coreShape.unknown || coreShape.missing
      || projectShape.duplicate || projectShape.unknown || projectShape.missing) {
      return { running: false, healthy: false, sourceCommit: null, releaseDigest: null, runtimeIdentities: [] };
    }

    const expectedImages = new Map(manifest.runtimeIdentities.map((identity) => [identity.component, identity.digest]));
    let running = true;
    let healthy = true;
    let identitiesMatch = true;
    for (const service of CORE_SERVICES) {
      const container = core.find((entry) => entry.service === service)!;
      const state = await this.containerState(container.id);
      running &&= state.running;
      healthy &&= state.running && state.health === 'healthy';
      identitiesMatch &&= state.imageId === expectedImages.get(service);
    }
    const projectsWorkDigest = expectedImages.get('projects-work');
    if (!projectsWorkDigest) identitiesMatch = false;
    for (const project of projects) {
      const state = await this.containerState(project.id);
      running &&= state.running;
      healthy &&= state.running;
      identitiesMatch &&= state.imageId === projectsWorkDigest;
    }
    healthy &&= identitiesMatch;
    return {
      running,
      healthy,
      sourceCommit: identitiesMatch ? manifest.sourceCommit : null,
      releaseDigest: identitiesMatch ? manifest.releaseDigest : null,
      runtimeIdentities: identitiesMatch ? manifest.runtimeIdentities : [],
    };
  }

  async openControlCenter(url: 'http://127.0.0.1:8787'): Promise<void> {
    if (url !== 'http://127.0.0.1:8787') {
      throw new LifecycleDriverError('CONTROL_CENTER_URL_REFUSED', 'Only the fixed loopback Control Center URL is allowed', false);
    }
    await this.powershellScript('scripts/windows/Open-QuaranGateControlCenter.ps1', ['-Url', url]);
  }
}
