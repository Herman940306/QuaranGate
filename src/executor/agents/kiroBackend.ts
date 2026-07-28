/**
 * Real Kiro ACP Backend — Phase A4 (Read-Only).
 *
 * Drives Kiro CLI in ACP mode for read-only analysis, inside a hardened runner
 * container. It composes the A3 sandbox foundation with the A4 controls:
 *
 *   - A3 workspace staging (trusted committed-HEAD snapshot) mounted READ-ONLY
 *   - A4 credential delivery (secret volume file — never Docker Env)
 *   - A4 per-job bridge agent (UNGUESSABLE name — workspace cannot override it)
 *   - A4 backend-only egress (job-scoped internal network + allowlist proxy)
 *   - A4 read-only profile enforcement (audit/plan/review only; implement DENIED)
 *
 * EXECUTION MODEL (A4 production wiring):
 *   The Executor never shells out to a `docker` CLI. It launches the runner
 *   purely through the trusted Docker Engine API (create → start → wait → logs
 *   → inspect → remove). The ACP JSON-RPC turn is driven by a RUNNER-INTERNAL
 *   Node process (runnerMain.js — reusing the same AcpDriver) that speaks to the
 *   `kiro-cli acp` child over local stdio and emits a single bounded normalized
 *   result line on stdout. The Executor consumes that line from the container
 *   logs. This is why the Executor image needs NO docker CLI and NO interactive
 *   attach.
 *
 * The Kiro API key is read inside the container from the RO secret file by the
 * image entrypoint — it is never in the container Env, args, labels or logs.
 *
 * Follows the FakeAgentBackend phase contract (prepare → run → validate) so it
 * plugs into AgentJobEngine unchanged.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { BridgeError } from '../../shared/errors.js';
import type { AgentResourcePolicy, AgentProfileId } from '../../shared/agents.js';
import {
  ACP_TRUST_TOOLS_FLAG, ACP_AGENT_NAME_PREFIX, assertReadonlyProfile,
} from './acpDriver.js';
import { CredentialManager, RUNNER_SECRET_PATH, secretVolumeName } from './credentialManager.js';
import { buildTar, populateVolume } from './runnerAssets.js';
import { RunnerSandbox, type StageResult } from './sandboxRunner.js';
import {
  SANDBOX_LABEL_NS, LABEL_MANAGED, LABEL_JOB, LABEL_RESOURCE,
  RUNNER_USER, WORKSPACE_PATH, toRunnerLimits,
} from './sandboxSpec.js';
import { jobNetworkName } from './egressProxy.js';
import { RESULT_MARKER, type RunnerResult } from './runnerMain.js';
import {
  createNetwork, removeNetwork, connectNetwork, createContainer, startContainer,
  waitContainer, getContainerLogs, inspectContainerFull,
  killContainer, removeContainer, removeVolume,
} from '../docker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNNER_HOME = '/home/runner';
const RUNNER_KIRO_HOME = `${RUNNER_HOME}/.kiro`;
const EGRESS_PROXY_ALIAS = 'egress-proxy';
const EGRESS_PROXY_PORT = 8080;

/** Where the trusted control bundle (driver code + control.json) is mounted RO. */
const RUNNER_CONTROL_PATH = '/run/control';
const RUNNER_CONTROL_FILE = `${RUNNER_CONTROL_PATH}/control.json`;
/** Runner-internal ACP driver entrypoint (delivered on the control volume). */
const RUNNER_DRIVER_ENTRY = `${RUNNER_CONTROL_PATH}/executor/agents/runnerMain.js`;

/** Assistant-text bound carried into the runner result (kept small). */
const MAX_ASSISTANT_BYTES = 16 * 1024;

const ns = (): string => SANDBOX_LABEL_NS.replace(/\./g, '-');
function homeVolumeName(jobId: string): string { return `${ns()}-home-${jobId}`; }
function controlVolumeName(jobId: string): string { return `${ns()}-control-${jobId}`; }
function runnerContainerName(jobId: string): string { return `${ns()}-krunner-${jobId}`; }
function proxyContainerName(jobId: string): string { return `${ns()}-proxy-${jobId}`; }
function intNetName(jobId: string): string { return jobNetworkName(jobId); }
function extNetName(jobId: string): string { return `${jobNetworkName(jobId)}-ext`; }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KiroBackendJobInput {
  jobId: string;
  backend: 'kiro';
  project: string;
  profile: AgentProfileId;
  prompt: string;
  hostPath: string;
  policy: AgentResourcePolicy;
  model: string;
}

export interface KiroBackendResult {
  summary: string;
  exitCode: number;
  sessionId: string | null;
  toolCalls: { kind: string; count: number }[];
  stopReason: string;
}

export interface KiroBackendOptions {
  /** Runner image (kiro-cli + kiro-cli-chat baked in, hardened). */
  runnerImage: string;
  /** Image used for short-lived volume-populate helpers. */
  helperImage: string;
  /** Image used to run the egress proxy container. */
  proxyImage: string;
  /** Command the proxy container runs (node dist entrypoint). */
  proxyCmd: string[];
  /**
   * Read-only mounts for the proxy container (its own program — e.g. the bridge
   * dist tree). NEVER the analyzed project, /jobs, or docker.sock.
   */
  proxyMounts?: { source: string; target: string }[];
  credentialManager: CredentialManager;
  sandbox: RunnerSandbox;
  /**
   * Stop the runner ACP sequence after session/new (no prompt, no model
   * inference). Trusted flag for the production-execution gate / health probe.
   */
  dryRun?: boolean;
  /**
   * Override the directory the runner-internal driver assets are read from.
   * Defaults to this module's own compiled directory (dist/executor/agents).
   * Test seam only — never caller-controlled.
   */
  driverAssetsDir?: string;
}

// ---------------------------------------------------------------------------
// Model class mapping (provider-neutral class -> concrete Kiro model id).
//
// Only models ADVERTISED by Kiro CLI 2.5.0 `session/new` (availableModels:
// claude-sonnet-4, claude-sonnet-4.5) are used. `claude-haiku-4.5` was accepted
// by startup --model but is NOT advertised as available, so it is not used.
// ---------------------------------------------------------------------------

export function resolveModel(modelClass: string): string {
  switch (modelClass) {
    case 'fast': return 'claude-sonnet-4';
    case 'standard': return 'claude-sonnet-4.5';
    case 'deep': return 'claude-sonnet-4.5';
    default: return 'claude-sonnet-4';
  }
}

/**
 * The bridge-owned read-only agent config for one job. The `name` is the
 * unguessable per-job identity; all other fields lock the agent to read/grep/
 * glob with no MCP, no hooks, no wildcard, no fixed model. Exported so tests can
 * assert the effective capability set directly.
 */
export function bridgeAgentConfig(name: string): Record<string, unknown> {
  return {
    name,
    description: 'Bridge-controlled read-only analysis agent.',
    prompt: 'You are a read-only code analysis agent inside the MCP IDE Bridge sandbox. '
      + 'You may ONLY read files, search with grep, and list with glob. You must NEVER '
      + 'attempt to write, modify, delete, or execute anything, and NEVER use shell, '
      + 'terminal, web, MCP, or any tool not explicitly available.',
    mcpServers: {},
    tools: ['read', 'grep', 'glob'],
    toolAliases: {},
    allowedTools: [],
    resources: [],
    hooks: {},
    toolsSettings: {},
    includeMcpJson: false,
    model: null,
  };
}

// ---------------------------------------------------------------------------
// Pure: hardened Docker Engine API container-create body for the runner.
//
// Unit-testable without a daemon; constructed ONLY from trusted policy — no
// caller-controlled field can reach any of these settings. The runner command
// is the runner-internal ACP driver (node), NOT an interactive `kiro-cli acp`
// attached to the Executor.
// ---------------------------------------------------------------------------

export function buildRunnerCreateBody(opts: {
  jobId: string;
  image: string;
  workspaceVolume: string;
  secretVolume: string;
  homeVolume: string;
  controlVolume: string;
  internalNetwork: string;
  proxyUrl: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
}): Record<string, unknown> {
  const env = [
    `HTTPS_PROXY=${opts.proxyUrl}`,
    `HTTP_PROXY=${opts.proxyUrl}`,
    `ALL_PROXY=${opts.proxyUrl}`,
    'NO_PROXY=',
    `HOME=${RUNNER_HOME}`,
    `KIRO_HOME=${RUNNER_KIRO_HOME}`,
    `XDG_CONFIG_HOME=${RUNNER_HOME}/.config`,
    `XDG_DATA_HOME=${RUNNER_HOME}/.local/share`,
    `XDG_STATE_HOME=${RUNNER_HOME}/.local/state`,
    `XDG_CACHE_HOME=${RUNNER_HOME}/.cache`,
    'KIRO_DISABLE_UPDATE=1',
    'KIRO_TELEMETRY=off',
    'NO_COLOR=1',
    'GIT_TERMINAL_PROMPT=0',
  ];
  return {
    Image: opts.image,
    User: RUNNER_USER,
    WorkingDir: WORKSPACE_PATH,
    // The runner-internal ACP driver. The image ENTRYPOINT exports KIRO_API_KEY
    // from the RO secret file, then exec's this.
    Cmd: ['node', RUNNER_DRIVER_ENTRY, RUNNER_CONTROL_FILE],
    Env: env,
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_RESOURCE]: 'runner',
      [LABEL_JOB]: opts.jobId,
    },
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges'],
      GroupAdd: [],
      Devices: [],
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      UsernsMode: '',
      NetworkMode: opts.internalNetwork,
      Memory: opts.memoryBytes,
      MemorySwap: opts.memoryBytes,
      NanoCpus: opts.nanoCpus,
      PidsLimit: opts.pidsLimit,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
      Mounts: [
        { Type: 'volume', Source: opts.workspaceVolume, Target: WORKSPACE_PATH, ReadOnly: true },
        { Type: 'volume', Source: opts.secretVolume, Target: '/run/secrets', ReadOnly: true },
        { Type: 'volume', Source: opts.homeVolume, Target: RUNNER_HOME, ReadOnly: false },
        { Type: 'volume', Source: opts.controlVolume, Target: RUNNER_CONTROL_PATH, ReadOnly: true },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

class KiroAgentFailure extends Error {
  constructor(message: string) { super(message); this.name = 'KiroAgentFailure'; }
}

function log(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', msg, ...fields }));
}

/** Extract the single bounded normalized result line the runner driver emits. */
export function parseRunnerResult(stdout: string): RunnerResult | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const idx = line.indexOf(RESULT_MARKER);
    if (idx === -1) continue;
    try {
      return JSON.parse(line.slice(idx + RESULT_MARKER.length)) as RunnerResult;
    } catch {
      return null;
    }
  }
  return null;
}

export class KiroBackend {
  private staged: StageResult | null = null;
  private secretVolume: string | null = null;
  private homeVolume: string | null = null;
  private controlVolume: string | null = null;
  private intNet: string | null = null;
  private extNet: string | null = null;
  private proxyContainerId: string | null = null;
  private runnerContainerId: string | null = null;
  private turnResult: RunnerResult | null = null;
  private imageId: string | null = null;
  private readonly agentName: string;
  private readonly model: string;

  constructor(
    private readonly job: KiroBackendJobInput,
    private readonly opts: KiroBackendOptions,
  ) {
    assertReadonlyProfile(job.profile);
    // Unguessable per-job agent name: a staged/tracked project cannot ship a
    // same-named .kiro/agents/<name>.json to override the bridge agent.
    this.agentName = `${ACP_AGENT_NAME_PREFIX}${randomBytes(16).toString('hex')}`;
    this.model = job.model || resolveModel(job.policy.modelClass);
  }

  isAgentFailure(e: unknown): boolean { return e instanceof KiroAgentFailure; }

  /** Evidence accessors (tests / diagnostics). */
  getAgentName(): string { return this.agentName; }
  getModel(): string { return this.model; }
  getResult(): RunnerResult | null { return this.turnResult; }
  getImageId(): string | null { return this.imageId; }
  getSessionId(): string | null { return this.turnResult?.sessionId ?? null; }

  /**
   * PREPARE: stage RO workspace, provision the secret + per-job home + control
   * volumes, create the job-scoped networks, and start the egress proxy. Fails
   * closed — any partial resource is cleaned up.
   */
  async prepare(signal: AbortSignal): Promise<void> {
    this.checkAbort(signal);
    try {
      log('kiro backend: staging workspace', { jobId: this.job.jobId, project: this.job.project });
      this.staged = await this.opts.sandbox.stageWorkspace({
        jobId: this.job.jobId, hostPath: this.job.hostPath, gitRequired: true,
      });
      this.checkAbort(signal);

      log('kiro backend: provisioning credential', { jobId: this.job.jobId });
      this.secretVolume = await this.opts.credentialManager.provisionSecret(this.job.jobId);
      this.checkAbort(signal);

      log('kiro backend: provisioning runner home', { jobId: this.job.jobId });
      this.homeVolume = await this.provisionHome();
      this.checkAbort(signal);

      log('kiro backend: provisioning control bundle', { jobId: this.job.jobId, dryRun: Boolean(this.opts.dryRun) });
      this.controlVolume = await this.provisionControl();
      this.checkAbort(signal);

      log('kiro backend: creating job networks + egress proxy', { jobId: this.job.jobId });
      await this.startEgress();
      this.checkAbort(signal);

      log('kiro backend: prepare complete', {
        jobId: this.job.jobId, baseCommit: this.staged.baseCommit, agent: this.agentName,
      });
    } catch (e) {
      await this.cleanup();
      throw e;
    }
  }

  /** Build the per-job home volume: the bridge agent (random name) + settings. */
  private async provisionHome(): Promise<string> {
    const volName = homeVolumeName(this.job.jobId);
    const agentJson = JSON.stringify(bridgeAgentConfig(this.agentName), null, 2);
    const settingsJson = JSON.stringify({ telemetry: { enabled: false }, updates: { autoCheck: false, autoInstall: false } });

    const tar = await buildTar({
      dirs: [
        { name: '.kiro/', mode: 0o700 },
        { name: '.kiro/agents/', mode: 0o700 },
        { name: '.kiro/settings/', mode: 0o700 },
        { name: '.config/', mode: 0o700 },
        { name: '.local/', mode: 0o700 },
        { name: '.local/share/', mode: 0o700 },
        { name: '.local/state/', mode: 0o700 },
        { name: '.cache/', mode: 0o700 },
      ],
      files: [
        { name: `.kiro/agents/${this.agentName}.json`, content: Buffer.from(agentJson, 'utf8'), mode: 0o600 },
        { name: '.kiro/settings/cli.json', content: Buffer.from(settingsJson, 'utf8'), mode: 0o600 },
      ],
    });
    await populateVolume({
      volumeName: volName,
      labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'home', [LABEL_JOB]: this.job.jobId },
      helperImage: this.opts.helperImage,
      mountPath: RUNNER_HOME,
      tar,
    });
    return volName;
  }

  /**
   * Build the per-job control volume: the runner-internal ACP driver code
   * (runnerMain + the SAME AcpDriver + its one dependency) plus the trusted,
   * NON-SECRET control.json. The API key is NEVER placed here — it is delivered
   * only via the RO secret volume + entrypoint.
   */
  private async provisionControl(): Promise<string> {
    const volName = controlVolumeName(this.job.jobId);
    const dir = this.opts.driverAssetsDir ?? dirname(fileURLToPath(import.meta.url));
    const runnerMainJs = readFileSync(join(dir, 'runnerMain.js'));
    const acpDriverJs = readFileSync(join(dir, 'acpDriver.js'));
    const errorsJs = readFileSync(join(dir, '..', '..', 'shared', 'errors.js'));

    const control = {
      agent: this.agentName,
      model: this.model,
      trustTools: ACP_TRUST_TOOLS_FLAG,
      cwd: WORKSPACE_PATH,
      prompt: this.job.prompt,
      dryRun: Boolean(this.opts.dryRun),
      promptTimeoutMs: this.job.policy.maxRuntimeMs,
      maxAssistantBytes: MAX_ASSISTANT_BYTES,
    };

    const tar = await buildTar({
      dirs: [
        { name: 'executor/', mode: 0o700 },
        { name: 'executor/agents/', mode: 0o700 },
        { name: 'shared/', mode: 0o700 },
      ],
      files: [
        { name: 'executor/agents/runnerMain.js', content: runnerMainJs, mode: 0o500 },
        { name: 'executor/agents/acpDriver.js', content: acpDriverJs, mode: 0o500 },
        { name: 'shared/errors.js', content: errorsJs, mode: 0o500 },
        { name: 'control.json', content: Buffer.from(JSON.stringify(control), 'utf8'), mode: 0o400 },
      ],
    });
    await populateVolume({
      volumeName: volName,
      labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'control', [LABEL_JOB]: this.job.jobId },
      helperImage: this.opts.helperImage,
      mountPath: RUNNER_CONTROL_PATH,
      tar,
    });
    return volName;
  }

  /** Create internal + external networks and start the allowlist egress proxy. */
  private async startEgress(): Promise<void> {
    const labels = { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'net', [LABEL_JOB]: this.job.jobId };
    this.intNet = intNetName(this.job.jobId);
    this.extNet = extNetName(this.job.jobId);
    await createNetwork(this.intNet, { internal: true, labels });
    await createNetwork(this.extNet, { internal: false, labels });

    // Proxy: on the internal net (alias for runner DNS) AND the external net
    // (Internet + DNS). It holds no key, no project, no docker.sock.
    const mounts = (this.opts.proxyMounts ?? []).map((m) => ({
      Type: 'bind', Source: m.source, Target: m.target, ReadOnly: true,
    }));
    this.proxyContainerId = await createContainer(proxyContainerName(this.job.jobId), {
      Image: this.opts.proxyImage,
      User: RUNNER_USER,
      Cmd: this.opts.proxyCmd,
      Env: [`EGRESS_PROXY_PORT=${EGRESS_PROXY_PORT}`],
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'proxy', [LABEL_JOB]: this.job.jobId },
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: this.intNet,
        Mounts: mounts,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
        Memory: 128 * 1024 * 1024,
        PidsLimit: 32,
      },
      NetworkingConfig: { EndpointsConfig: { [this.intNet]: { Aliases: [EGRESS_PROXY_ALIAS] } } },
    });
    await connectNetwork(this.extNet, this.proxyContainerId);
    await startContainer(this.proxyContainerId);
    await this.waitForProxyReady(this.proxyContainerId);
  }

  /**
   * Wait until the egress proxy is actually listening before launching the
   * runner. Without this, kiro-cli's startup credential exchange can race the
   * proxy's boot and fail with "not logged in". Bounded; fails closed.
   */
  private async waitForProxyReady(containerId: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const logs = await getContainerLogs(containerId, 8192).catch(() => ({ stdout: '' }));
      if (logs.stdout.includes('egress proxy listening')) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new BridgeError('SANDBOX_FAILED', 'egress proxy did not become ready', 500);
  }

  /**
   * RUN: launch the hardened runner via the Docker Engine API and let the
   * runner-internal ACP driver perform the turn. No `docker` CLI, no attach.
   */
  async run(signal: AbortSignal): Promise<void> {
    this.checkAbort(signal);
    if (!this.staged || !this.secretVolume || !this.homeVolume || !this.controlVolume || !this.intNet) {
      throw new BridgeError('SANDBOX_FAILED', 'prepare() did not complete', 500);
    }
    const limits = toRunnerLimits(this.job.policy);

    const body = buildRunnerCreateBody({
      jobId: this.job.jobId,
      image: this.opts.runnerImage,
      workspaceVolume: this.staged.volumeName,
      secretVolume: this.secretVolume,
      homeVolume: this.homeVolume,
      controlVolume: this.controlVolume,
      internalNetwork: this.intNet,
      proxyUrl: `http://${EGRESS_PROXY_ALIAS}:${EGRESS_PROXY_PORT}`,
      memoryBytes: limits.memoryBytes,
      nanoCpus: limits.nanoCpus,
      pidsLimit: limits.pidsLimit,
    });

    log('kiro backend: launching runner', {
      jobId: this.job.jobId, model: this.model, agent: this.agentName, dryRun: Boolean(this.opts.dryRun),
    });
    this.runnerContainerId = await createContainer(runnerContainerName(this.job.jobId), body);
    await startContainer(this.runnerContainerId);

    const waited = await this.waitBounded(this.runnerContainerId, limits.maxRuntimeMs, signal);
    const logs = await getContainerLogs(this.runnerContainerId, limits.maxOutputBytes);
    const info = await inspectContainerFull(this.runnerContainerId).catch(() => null);
    this.imageId = info?.Image ?? null;

    if (waited.timedOut) {
      throw new KiroAgentFailure('kiro runner exceeded maxRuntimeMs');
    }
    const parsed = parseRunnerResult(logs.stdout);
    if (!parsed) {
      throw new KiroAgentFailure(`kiro runner produced no ACP result (stderr: ${logs.stderr.slice(0, 400)})`);
    }
    if (!parsed.ok) {
      throw new KiroAgentFailure(`kiro ACP failed: ${parsed.error ?? 'unknown'}`);
    }
    this.turnResult = parsed;
    log('kiro backend: turn complete', {
      jobId: this.job.jobId, stopReason: parsed.stopReason,
      sessionId: parsed.sessionId, toolCallKinds: parsed.toolCalls.map((t) => t.kind),
      protocolVersion: parsed.protocolVersion, agentVersion: parsed.agentInfo?.version,
    });
  }

  /** Wait for the runner to exit, bounded by maxRuntimeMs AND the abort signal. */
  private async waitBounded(
    containerId: string, timeoutMs: number, signal: AbortSignal,
  ): Promise<{ statusCode: number | null; timedOut: boolean }> {
    const abortP = new Promise<never>((_, reject) => {
      if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
    try {
      return await Promise.race([waitContainer(containerId, { timeoutMs }), abortP]);
    } catch (e) {
      // Abort (cancel/timeout at the engine level): kill the runner so it never
      // lingers; cleanup() removes it.
      await killContainer(containerId).catch(() => {});
      throw e;
    }
  }

  /** VALIDATE: enforce read-only tool usage, build the result, and clean up. */
  async validate(signal: AbortSignal): Promise<KiroBackendResult> {
    this.checkAbort(signal);
    try {
      if (!this.turnResult) {
        throw new KiroAgentFailure('no turn result available — run() may have failed');
      }
      const READONLY_KINDS = new Set(['read', 'grep', 'glob', 'search', 'fetch_read', 'list']);
      const disallowed = this.turnResult.toolCalls.filter((tc) => !READONLY_KINDS.has(tc.kind));
      if (disallowed.length > 0) {
        throw new KiroAgentFailure(
          `agent attempted non-read-only tools: ${disallowed.map((t) => t.kind).join(', ')}`);
      }

      const r = this.turnResult;
      const summary = r.dryRun
        ? `Kiro ACP dry-run OK (protocol=${r.protocolVersion}, agent=${r.agentInfo?.version ?? '?'}, `
          + `session=${r.sessionId ?? '?'}, model=${this.model})`
        : (r.assistantText.length > 0
          ? r.assistantText.slice(0, 4096)
          : `Kiro analysis completed (profile=${this.job.profile}, tools=${r.toolCalls.length}, stop=${r.stopReason})`);

      return {
        summary,
        exitCode: 0,
        sessionId: r.sessionId ?? null,
        toolCalls: r.toolCalls,
        stopReason: r.stopReason,
      };
    } finally {
      await this.cleanup();
    }
  }

  /** Remove ALL job-scoped resources (success / failure / timeout / cancel). */
  async cleanup(): Promise<void> {
    // Force-remove the runner container (by tracked id and by name in case the
    // id was never captured).
    if (this.runnerContainerId) {
      await killContainer(this.runnerContainerId).catch(() => {});
      await removeContainer(this.runnerContainerId, true).catch(() => {});
      this.runnerContainerId = null;
    }
    await killContainer(runnerContainerName(this.job.jobId)).catch(() => {});
    await removeContainer(runnerContainerName(this.job.jobId), true).catch(() => {});

    if (this.proxyContainerId) {
      await killContainer(this.proxyContainerId).catch(() => {});
      await removeContainer(this.proxyContainerId, true).catch(() => {});
      this.proxyContainerId = null;
    }
    if (this.extNet) { await removeNetwork(this.extNet).catch(() => {}); this.extNet = null; }
    if (this.intNet) { await removeNetwork(this.intNet).catch(() => {}); this.intNet = null; }
    if (this.controlVolume) { await removeVolume(this.controlVolume, true).catch(() => {}); this.controlVolume = null; }
    if (this.secretVolume) {
      await this.opts.credentialManager.revokeSecret(this.job.jobId).catch(() => {});
      this.secretVolume = null;
    }
    if (this.homeVolume) { await removeVolume(this.homeVolume, true).catch(() => {}); this.homeVolume = null; }
    if (this.staged) {
      await this.opts.sandbox.disposeWorkspace(this.staged.volumeName).catch(() => {});
      this.staged = null;
    }
    log('kiro backend: cleanup complete', { jobId: this.job.jobId });
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
  }
}

export { RUNNER_SECRET_PATH, secretVolumeName, homeVolumeName, controlVolumeName };
