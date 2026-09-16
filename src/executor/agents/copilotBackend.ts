/** Governed, read-only GitHub Copilot CLI ACP backend (A7). */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { BridgeError } from '../../shared/errors.js';
import type { AgentProfileId, AgentResourcePolicy } from '../../shared/agents.js';
import {
  connectNetwork,
  createContainer,
  createNetwork,
  getContainerLogs,
  inspectContainerFull,
  killContainer,
  removeContainer,
  removeNetwork,
  removeVolume,
  startContainer,
  waitContainer,
} from '../docker.js';
import { jobNetworkName } from './egressProxy.js';
import { buildTar, populateVolume } from './runnerAssets.js';
import { RunnerSandbox, type StageResult } from './sandboxRunner.js';
import {
  LABEL_JOB,
  LABEL_MANAGED,
  LABEL_RESOURCE,
  RUNNER_USER,
  SANDBOX_LABEL_NS,
  WORKSPACE_PATH,
  toRunnerLimits,
} from './sandboxSpec.js';
import {
  COPILOT_RUNNER_SECRET_PATH,
  CopilotCredentialManager,
} from './copilotCredentialManager.js';
import {
  COPILOT_RESULT_MARKER,
  type CopilotRunnerControl,
  type CopilotRunnerResult,
} from './copilotRunnerMain.js';
import { COPILOT_SUPPORTED_PROFILES } from '../copilotConfig.js';

const RUNNER_HOME = '/home/runner';
const COPILOT_HOME = `${RUNNER_HOME}/.copilot`;
const CONTROL_PATH = '/run/control';
const CONTROL_FILE = `${CONTROL_PATH}/control.json`;
const RUNNER_ENTRY = `${CONTROL_PATH}/executor/agents/copilotRunnerMain.js`;
const SECRET_ENTRY = `${CONTROL_PATH}/copilot-secret-entrypoint.sh`;
const PROXY_ALIAS = 'egress-proxy';
const PROXY_PORT = 8080;
const ALLOWED_TOOL_KINDS = new Set(['read', 'view', 'grep', 'glob']);

function resourceName(kind: string, jobId: string): string {
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-copilot-${kind}-${jobId}`;
}

export function copilotRunnerContainerName(jobId: string): string {
  return resourceName('runner', jobId);
}

export function copilotProxyContainerName(jobId: string): string {
  return resourceName('proxy', jobId);
}

export interface CopilotBackendJobInput {
  jobId: string;
  principalId: string;
  backend: 'copilot';
  project: string;
  profile: AgentProfileId;
  prompt: string;
  hostPath: string;
  policy: AgentResourcePolicy;
  model: string;
}

export interface CopilotBackendOptions {
  runnerImage: string;
  helperImage: string;
  proxyImage: string;
  proxyCmd: string[];
  egressHosts: string[];
  credentialManager: CopilotCredentialManager;
  sandbox: RunnerSandbox;
  dryRun?: boolean;
  driverAssetsDir?: string;
}

export interface CopilotBackendResult {
  summary: string;
  exitCode: number;
  baseCommit: string | null;
  changedFiles: string[];
}

export class CopilotAgentFailure extends Error {
  override name = 'CopilotAgentFailure';
}

const SAFE_RESULT_TOKEN = /^[A-Za-z0-9._:/-]{1,64}$/u;
const TRUSTED_RUNNER_ERRORS = new Set([
  'failed to read trusted Copilot control',
  'Copilot ACP spawn failed',
  'Copilot ACP initialize failed',
  'Copilot ACP session failed',
  'Copilot ACP prompt failed',
]);

/** Pure hardened runner spec: volume-only mounts, RO workspace, no Docker socket. */
export function buildCopilotRunnerCreateBody(opts: {
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
  return {
    Image: opts.image,
    User: RUNNER_USER,
    WorkingDir: WORKSPACE_PATH,
    Cmd: ['/bin/sh', SECRET_ENTRY, 'node', RUNNER_ENTRY, CONTROL_FILE],
    Env: [
      `HTTPS_PROXY=${opts.proxyUrl}`,
      `HTTP_PROXY=${opts.proxyUrl}`,
      `ALL_PROXY=${opts.proxyUrl}`,
      'NO_PROXY=',
      `HOME=${RUNNER_HOME}`,
      `COPILOT_HOME=${COPILOT_HOME}`,
      'COPILOT_AUTO_UPDATE=false',
      'COPILOT_OTEL_ENABLED=false',
      'CI=1',
      'NO_COLOR=1',
      'GIT_TERMINAL_PROMPT=0',
    ],
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
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m' },
      Mounts: [
        { Type: 'volume', Source: opts.workspaceVolume, Target: WORKSPACE_PATH, ReadOnly: true },
        { Type: 'volume', Source: opts.secretVolume, Target: '/run/secrets', ReadOnly: true },
        { Type: 'volume', Source: opts.homeVolume, Target: RUNNER_HOME, ReadOnly: false },
        { Type: 'volume', Source: opts.controlVolume, Target: CONTROL_PATH, ReadOnly: true },
      ],
    },
  };
}

export function parseCopilotRunnerResult(stdout: string, expectedDryRun?: boolean): CopilotRunnerResult | null {
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length !== 1 || !lines[0]!.startsWith(COPILOT_RESULT_MARKER)) return null;
  try {
    const raw = JSON.parse(lines[0]!.slice(COPILOT_RESULT_MARKER.length)) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as CopilotRunnerResult & Record<string, unknown>;
    const allowedKeys = new Set(['ok','dryRun','protocolVersion','agentInfo','sessionId','toolCalls','assistantText','stopReason','refusedRequestCount','error']);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
    if (typeof value.ok !== 'boolean' || typeof value.dryRun !== 'boolean'
      || (expectedDryRun !== undefined && value.dryRun !== expectedDryRun)
      || !Array.isArray(value.toolCalls) || value.toolCalls.length > 512
      || typeof value.assistantText !== 'string' || Buffer.byteLength(value.assistantText, 'utf8') > 16 * 1024
      || typeof value.stopReason !== 'string' || !SAFE_RESULT_TOKEN.test(value.stopReason)
      || !Number.isSafeInteger(value.refusedRequestCount) || value.refusedRequestCount < 0 || value.refusedRequestCount > 512) return null;
    let totalToolCalls = 0;
    for (const toolCall of value.toolCalls) {
      if (!toolCall || typeof toolCall.kind !== 'string' || !SAFE_RESULT_TOKEN.test(toolCall.kind)
        || (toolCall.status !== undefined && (typeof toolCall.status !== 'string' || !SAFE_RESULT_TOKEN.test(toolCall.status)))
        || !Number.isSafeInteger(toolCall.count) || toolCall.count < 1) return null;
      totalToolCalls += toolCall.count;
      if (totalToolCalls > 512) return null;
    }
    if (value.protocolVersion !== undefined && (!Number.isSafeInteger(value.protocolVersion) || Number(value.protocolVersion) < 0 || Number(value.protocolVersion) > 1024)) return null;
    if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.length < 1 || Buffer.byteLength(value.sessionId, 'utf8') > 512 || /[\x00-\x1f\x7f]/u.test(value.sessionId))) return null;
    if (value.agentInfo !== undefined) {
      if (!value.agentInfo || typeof value.agentInfo !== 'object' || Array.isArray(value.agentInfo)) return null;
      const info = value.agentInfo as unknown as Record<string, unknown>;
      if (Object.keys(info).some((key) => !['name','version'].includes(key))) return null;
      if (typeof info.name !== 'string' || info.name.length < 1 || Buffer.byteLength(info.name, 'utf8') > 256) return null;
      if (typeof info.version !== 'string' || info.version.length < 1 || Buffer.byteLength(info.version, 'utf8') > 256) return null;
    }
    if (value.error !== undefined && (typeof value.error !== 'string' || !TRUSTED_RUNNER_ERRORS.has(value.error))) return null;
    if ((value.ok && value.error !== undefined) || (!value.ok && value.error === undefined)) return null;
    return value;
  } catch {
    return null;
  }
}

export function assertCopilotRunnerExecution(
  waited: { statusCode: number | null; timedOut: boolean },
  logs: { stdout: string; truncated: boolean },
  expectedDryRun?: boolean,
): CopilotRunnerResult {
  if (waited.timedOut) throw new CopilotAgentFailure('Copilot runner exceeded maxRuntimeMs');
  if (waited.statusCode !== 0) throw new CopilotAgentFailure('Copilot runner exited unsuccessfully');
  if (logs.truncated) throw new CopilotAgentFailure('Copilot runner output exceeded maxOutputBytes');
  const parsed = parseCopilotRunnerResult(logs.stdout, expectedDryRun);
  if (!parsed?.ok) throw new CopilotAgentFailure(parsed?.error ?? 'Copilot runner produced no valid ACP result');
  return parsed;
}

export function assertCopilotReadonlyResult(result: CopilotRunnerResult): void {
  if (result.refusedRequestCount !== 0) {
    throw new CopilotAgentFailure('Copilot attempted a privileged ACP client request');
  }
  const disallowed = result.toolCalls.filter((toolCall) => !ALLOWED_TOOL_KINDS.has(toolCall.kind));
  if (disallowed.length > 0) {
    throw new CopilotAgentFailure(`Copilot attempted tools outside read-only policy: ${disallowed.map((item) => item.kind).join(', ')}`);
  }
  if (!result.dryRun) {
    if (result.stopReason !== 'end_turn') {
      throw new CopilotAgentFailure('Copilot did not complete normally');
    }
    if (result.assistantText.trim() === '') {
      throw new CopilotAgentFailure('Copilot completed without a usable assistant response');
    }
  }
}

export class CopilotBackend {
  private staged: StageResult | null = null;
  private secretVolume: string | null = null;
  private homeVolume: string | null = null;
  private controlVolume: string | null = null;
  private internalNetwork: string | null = null;
  private externalNetwork: string | null = null;
  private proxyContainerId: string | null = null;
  private runnerContainerId: string | null = null;
  private turnResult: CopilotRunnerResult | null = null;
  private cleanupFailed = false;

  constructor(
    private readonly job: CopilotBackendJobInput,
    private readonly opts: CopilotBackendOptions,
  ) {
    if (!COPILOT_SUPPORTED_PROFILES.includes(job.profile)) {
      throw new BridgeError('FORBIDDEN_PROFILE', `Copilot does not support profile ${job.profile}`, 403);
    }
  }

  isAgentFailure(error: unknown): boolean {
    return !this.cleanupFailed && error instanceof CopilotAgentFailure;
  }
  isDryRun(): boolean { return Boolean(this.opts.dryRun); }

  async prepare(signal: AbortSignal): Promise<void> {
    this.checkAbort(signal);
    try {
      this.staged = await this.opts.sandbox.stageWorkspace({
        jobId: this.job.jobId,
        hostPath: this.job.hostPath,
        gitRequired: true,
        // The runner also receives a secret mount. Reject every tracked
        // symlink so an untrusted repository cannot traverse to that mount.
        rejectTrackedSymlinks: true,
      });
      this.checkAbort(signal);
      this.secretVolume = await this.opts.credentialManager.provisionSecret(this.job.jobId);
      this.checkAbort(signal);
      this.homeVolume = await this.provisionHome();
      this.checkAbort(signal);
      this.controlVolume = await this.provisionControl();
      this.checkAbort(signal);
      await this.startEgress();
      this.checkAbort(signal);
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  private async provisionHome(): Promise<string> {
    const volumeName = resourceName('home', this.job.jobId);
    const tar = await buildTar({
      dirs: [
        { name: '.copilot/', mode: 0o700 },
        { name: '.cache/', mode: 0o700 },
        { name: '.config/', mode: 0o700 },
      ],
      files: [{
        name: '.copilot/settings.json',
        content: Buffer.from(JSON.stringify({ model: this.job.model }), 'utf8'),
        mode: 0o600,
      }],
    });
    await populateVolume({
      volumeName,
      labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'home', [LABEL_JOB]: this.job.jobId },
      helperImage: this.opts.helperImage,
      mountPath: RUNNER_HOME,
      tar,
    });
    return volumeName;
  }

  private async provisionControl(): Promise<string> {
    const volumeName = resourceName('control', this.job.jobId);
    const dir = this.opts.driverAssetsDir ?? dirname(fileURLToPath(import.meta.url));
    const control: CopilotRunnerControl = {
      model: this.job.model,
      cwd: WORKSPACE_PATH,
      prompt: this.job.prompt,
      dryRun: Boolean(this.opts.dryRun),
      promptTimeoutMs: this.job.policy.maxRuntimeMs,
      maxAssistantBytes: Math.min(this.job.policy.maxOutputBytes, 16 * 1024),
    };
    const entrypoint = `#!/bin/sh\nset -eu\ntest -r ${COPILOT_RUNNER_SECRET_PATH}\nCOPILOT_GITHUB_TOKEN="$(cat ${COPILOT_RUNNER_SECRET_PATH})"\nexport COPILOT_GITHUB_TOKEN\nunset GH_TOKEN GITHUB_TOKEN\nexec "$@"\n`;
    const tar = await buildTar({
      dirs: [
        { name: 'executor/', mode: 0o700 },
        { name: 'executor/agents/', mode: 0o700 },
        { name: 'shared/', mode: 0o700 },
      ],
      files: [
        { name: 'executor/agents/copilotRunnerMain.js', content: readFileSync(join(dir, 'copilotRunnerMain.js')), mode: 0o500 },
        { name: 'executor/agents/acpDriver.js', content: readFileSync(join(dir, 'acpDriver.js')), mode: 0o500 },
        { name: 'shared/errors.js', content: readFileSync(join(dir, '..', '..', 'shared', 'errors.js')), mode: 0o500 },
        { name: 'control.json', content: Buffer.from(JSON.stringify(control), 'utf8'), mode: 0o400 },
        { name: 'copilot-secret-entrypoint.sh', content: Buffer.from(entrypoint, 'utf8'), mode: 0o500 },
      ],
    });
    await populateVolume({
      volumeName,
      labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'control', [LABEL_JOB]: this.job.jobId },
      helperImage: this.opts.helperImage,
      mountPath: CONTROL_PATH,
      tar,
    });
    return volumeName;
  }

  private async startEgress(): Promise<void> {
    const labels = { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'net', [LABEL_JOB]: this.job.jobId };
    this.internalNetwork = `${jobNetworkName(this.job.jobId)}-copilot-int`;
    this.externalNetwork = `${jobNetworkName(this.job.jobId)}-copilot-ext`;
    await createNetwork(this.internalNetwork, { internal: true, labels });
    await createNetwork(this.externalNetwork, { internal: false, labels });
    this.proxyContainerId = await createContainer(copilotProxyContainerName(this.job.jobId), {
      Image: this.opts.proxyImage,
      User: RUNNER_USER,
      Cmd: this.opts.proxyCmd,
      Env: [
        `EGRESS_PROXY_PORT=${PROXY_PORT}`,
        `EGRESS_PROXY_EXACT_ALLOWLIST=${this.opts.egressHosts.join(',')}`,
      ],
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'proxy', [LABEL_JOB]: this.job.jobId },
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: this.internalNetwork,
        Mounts: [],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=1m' },
        Memory: 128 * 1024 * 1024,
        PidsLimit: 32,
      },
      NetworkingConfig: { EndpointsConfig: { [this.internalNetwork]: { Aliases: [PROXY_ALIAS] } } },
    });
    await connectNetwork(this.externalNetwork, this.proxyContainerId);
    await startContainer(this.proxyContainerId);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const logs = await getContainerLogs(this.proxyContainerId, 8192).catch(() => ({ stdout: '' }));
      if (logs.stdout.includes('egress proxy listening')) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new BridgeError('SANDBOX_FAILED', 'Copilot egress proxy did not become ready', 500);
  }

  async run(signal: AbortSignal): Promise<void> {
    this.checkAbort(signal);
    if (!this.staged || !this.secretVolume || !this.homeVolume || !this.controlVolume || !this.internalNetwork) {
      throw new BridgeError('SANDBOX_FAILED', 'Copilot prepare() did not complete', 500);
    }
    const limits = toRunnerLimits(this.job.policy);
    const body = buildCopilotRunnerCreateBody({
      jobId: this.job.jobId,
      image: this.opts.runnerImage,
      workspaceVolume: this.staged.volumeName,
      secretVolume: this.secretVolume,
      homeVolume: this.homeVolume,
      controlVolume: this.controlVolume,
      internalNetwork: this.internalNetwork,
      proxyUrl: `http://${PROXY_ALIAS}:${PROXY_PORT}`,
      memoryBytes: limits.memoryBytes,
      nanoCpus: limits.nanoCpus,
      pidsLimit: limits.pidsLimit,
    });
    this.runnerContainerId = await createContainer(copilotRunnerContainerName(this.job.jobId), body);
    await startContainer(this.runnerContainerId);
    const waited = await this.waitBounded(this.runnerContainerId, limits.maxRuntimeMs, signal);
    const logs = await getContainerLogs(this.runnerContainerId, limits.maxOutputBytes);
    this.turnResult = assertCopilotRunnerExecution(waited, logs, Boolean(this.opts.dryRun));
  }

  private async waitBounded(containerId: string, timeoutMs: number, signal: AbortSignal) {
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
    try {
      return await Promise.race([waitContainer(containerId, { timeoutMs }), aborted]);
    } catch (error) {
      await killContainer(containerId).catch(() => {});
      throw error;
    }
  }

  async validate(signal: AbortSignal): Promise<CopilotBackendResult> {
    this.checkAbort(signal);
    try {
      if (!this.turnResult) throw new CopilotAgentFailure('Copilot result is unavailable');
      assertCopilotReadonlyResult(this.turnResult);
      const summary = this.turnResult.dryRun
        ? `Copilot ACP dry-run OK (protocol=${this.turnResult.protocolVersion ?? '?'}, agent=${this.turnResult.agentInfo?.version ?? '?'})`
        : (this.turnResult.assistantText || `Copilot analysis completed (profile=${this.job.profile})`).slice(0, 4096);
      return {
        summary,
        exitCode: 0,
        baseCommit: this.staged?.baseCommit ?? null,
        changedFiles: [],
      };
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    let cleanupError: unknown;
    const attempt = async (operation: () => Promise<void>): Promise<boolean> => {
      try {
        await operation();
        return true;
      } catch (error) {
        cleanupError ??= error;
        return false;
      }
    };
    if (this.runnerContainerId) {
      await killContainer(this.runnerContainerId).catch(() => {});
      if (await attempt(() => removeContainer(this.runnerContainerId!, true))) this.runnerContainerId = null;
    } else {
      // Best-effort recovery for a create call that failed after Docker
      // accepted the name but before an ID reached this process.
      await killContainer(copilotRunnerContainerName(this.job.jobId)).catch(() => {});
      await removeContainer(copilotRunnerContainerName(this.job.jobId), true).catch(() => {});
    }
    if (this.proxyContainerId) {
      await killContainer(this.proxyContainerId).catch(() => {});
      if (await attempt(() => removeContainer(this.proxyContainerId!, true))) this.proxyContainerId = null;
    } else {
      await killContainer(copilotProxyContainerName(this.job.jobId)).catch(() => {});
      await removeContainer(copilotProxyContainerName(this.job.jobId), true).catch(() => {});
    }
    if (this.externalNetwork && await attempt(() => removeNetwork(this.externalNetwork!))) this.externalNetwork = null;
    if (this.internalNetwork && await attempt(() => removeNetwork(this.internalNetwork!))) this.internalNetwork = null;
    if (this.controlVolume && await attempt(() => removeVolume(this.controlVolume!, true))) this.controlVolume = null;
    if (this.secretVolume) {
      if (await attempt(() => this.opts.credentialManager.revokeSecret(this.job.jobId))) this.secretVolume = null;
    }
    if (this.homeVolume && await attempt(() => removeVolume(this.homeVolume!, true))) this.homeVolume = null;
    if (this.staged && await attempt(() => this.opts.sandbox.disposeWorkspace(this.staged!.volumeName))) this.staged = null;
    if (cleanupError) {
      this.cleanupFailed = true;
      console.error(JSON.stringify({
        level: 'error', msg: 'Copilot cleanup left unverified resources', jobId: this.job.jobId,
      }));
      throw new BridgeError('SANDBOX_FAILED', 'Copilot cleanup left unverified resources', 500);
    }
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
  }
}
