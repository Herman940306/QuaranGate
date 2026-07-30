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
import { Readable } from 'node:stream';
import { extract as tarExtract } from 'tar-stream';
import { BridgeError } from '../../shared/errors.js';
import type { AgentResourcePolicy, AgentProfileId } from '../../shared/agents.js';
import {
  assertKiroProfile, isWriteProfile,
  resolveProfileCapability, type ProfileCapability, failedMutationToolCalls,
} from './acpDriver.js';
import { CredentialManager, RUNNER_SECRET_PATH, secretVolumeName } from './credentialManager.js';
import { buildTar, populateVolume } from './runnerAssets.js';
import { RunnerSandbox, type StageResult } from './sandboxRunner.js';
import {
  SANDBOX_LABEL_NS, LABEL_MANAGED, LABEL_JOB, LABEL_RESOURCE,
  RUNNER_USER, WORKSPACE_PATH, toRunnerLimits, buildManifestCreateBody,
} from './sandboxSpec.js';
import { jobNetworkName } from './egressProxy.js';
import { RESULT_MARKER, type RunnerResult } from './runnerMain.js';
import {
  parseManifest, diffManifests, type WorkspaceManifest, type ChangeSet,
} from './changeDetection.js';
import { captureBeforeEvidence, type BeforeCaptureResult } from './beforeCapture.js';
import { assertWriteQuiescence, parsePostTarStream, type PostCaptureResult } from './postCapture.js';
import { constructArtifact, type ArtifactResult, type EvidenceVolumeIO } from './artifactConstructor.js';
import type { GitObjectReader } from './baseCertifier.js';
import { createDockerGitObjectReader } from './gitHelper.js';
import {
  createNetwork, removeNetwork, connectNetwork, createContainer, startContainer,
  waitContainer, getContainerLogs, inspectContainerFull,
  killContainer, removeContainer, removeVolume,
  getArchive, putArchive,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first regular file's content from a tar stream (used by volume I/O). */
async function extractSingleFile(tarStream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ex = tarExtract();
    let found = false;
    ex.on('entry', (header, stream, next) => {
      if (found || header.type !== 'file') { stream.resume(); next(); return; }
      found = true;
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => { resolve(Buffer.concat(chunks)); next(); });
      stream.on('error', reject);
    });
    ex.on('finish', () => { if (!found) reject(new Error('no file in tar')); });
    ex.on('error', reject);
    tarStream.pipe(ex);
  });
}

const ns = (): string => SANDBOX_LABEL_NS.replace(/\./g, '-');
function homeVolumeName(jobId: string): string { return `${ns()}-home-${jobId}`; }
function controlVolumeName(jobId: string): string { return `${ns()}-control-${jobId}`; }
function runnerContainerName(jobId: string): string { return `${ns()}-krunner-${jobId}`; }
function proxyContainerName(jobId: string): string { return `${ns()}-proxy-${jobId}`; }
function manifestContainerName(jobId: string, phase: string): string { return `${ns()}-manifest-${phase}-${jobId}`; }
function intNetName(jobId: string): string { return jobNetworkName(jobId); }
function extNetName(jobId: string): string { return `${jobNetworkName(jobId)}-ext`; }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KiroBackendJobInput {
  jobId: string;
  principalId: string;
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
  toolCalls: { kind: string; status?: string; count: number }[];
  stopReason: string;
  /** Trusted source base commit of the staged workspace (persisted by engine). */
  baseCommit: string | null;
  /** Deterministic sandbox change evidence (implement jobs only). */
  changeSet?: ChangeSet;
  /** Convenience: changeSet.changedFiles (implement jobs only). */
  changedFiles?: string[];
  /** True for A5 implement jobs (write capability was granted). */
  writeMode: boolean;
  /** B3 canonical artifact result (real Kiro writer non-dry-run jobs only). */
  artifactResult?: ArtifactResult;
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
export function bridgeAgentConfig(name: string, opts: { write?: boolean } = {}): Record<string, unknown> {
  if (opts.write) {
    // A5 implement lane (documented write-policy remediation): read/grep/glob
    // PLUS the single canonical `write` mutation tool (official Built-in Tools
    // name; aliases fs_write/fsWrite). Permission model per the official Kiro
    // docs:
    //   - `tools` makes `write` AVAILABLE.
    //   - `allowedTools` pre-approves ONLY read/grep/glob. `write` is
    //     deliberately EXCLUDED from allowedTools: the Agent Configuration
    //     Reference states allowedTools OVERRIDES toolsSettings allowable
    //     patterns, so including `write` there would nullify the path scoping.
    //   - `toolsSettings.write.allowedPaths` grants non-interactive writes ONLY
    //     under /workspace (a tool not in allowedTools is auto-allowed by its
    //     toolSettings), and `deniedPaths` explicitly denies non-workspace
    //     locations as defense-in-depth. This matches Kiro's own Development
    //     Workflow Agent example (write in tools, NOT in allowedTools, scoped
    //     by toolsSettings).
    // Still NO mcp, NO hooks, NO wildcard, NO fixed model, NO shell/web/aws/
    // delegation. `includeMcpJson:false` and empty `mcpServers` prevent any
    // workspace `.kiro/mcp.json` from being pulled in.
    return {
      name,
      description: 'Bridge-controlled sandbox implementation agent (writes ONLY inside the disposable job workspace).',
      prompt: 'You are an implementation agent operating inside the MCP IDE Bridge disposable '
        + 'job sandbox. You may read files, search with grep, list with glob, and CREATE or '
        + 'MODIFY files ONLY within your workspace. You must NEVER use shell, terminal, web, '
        + 'MCP, AWS, subagents, delegation, or any tool not explicitly available. Do not '
        + 'attempt to reach the network or escape the workspace.',
      mcpServers: {},
      tools: ['read', 'grep', 'glob', 'write'],
      toolAliases: {},
      allowedTools: ['read', 'grep', 'glob'],
      resources: [],
      hooks: {},
      toolsSettings: {
        write: {
          allowedPaths: [WORKSPACE_PATH],
          deniedPaths: [RUNNER_HOME, '/tmp', '/run/secrets', RUNNER_CONTROL_PATH],
        },
      },
      includeMcpJson: false,
      model: null,
    };
  }
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
  /**
   * Workspace mount mode. A4 read-only profiles (audit/plan/review) mount the
   * staged snapshot READ-ONLY (true). The A5 `implement` profile mounts the
   * job-owned workspace volume WRITABLE (false) so Kiro can mutate it in-place.
   * It remains a Docker-managed job volume staged from the trusted snapshot —
   * NEVER a host project bind. The host project path is never visible here.
   */
  workspaceReadOnly: boolean;
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
        { Type: 'volume', Source: opts.workspaceVolume, Target: WORKSPACE_PATH, ReadOnly: opts.workspaceReadOnly },
        { Type: 'volume', Source: opts.secretVolume, Target: '/run/secrets', ReadOnly: true },
        { Type: 'volume', Source: opts.homeVolume, Target: RUNNER_HOME, ReadOnly: false },
        { Type: 'volume', Source: opts.controlVolume, Target: RUNNER_CONTROL_PATH, ReadOnly: true },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Pure: unique BEFORE budget computation
// ---------------------------------------------------------------------------

/**
 * Compute the BEFORE budget consumption from UNIQUE regular-file SHA-256
 * identities. Each unique hash contributes its size exactly once. Duplicate
 * entries with the same hash contribute zero additional bytes. Inconsistent
 * sizes for the same hash fail closed (evidence integrity violation).
 *
 * Exported for unit testing.
 */
export function computeUniqueBeforeBudget(
  entries: ReadonlyArray<{ kind: string; sha256?: string; sizeBytes?: number }>,
): { uniqueBeforeBytes: number; knownBeforeHashes: Set<string> } {
  const hashSizes = new Map<string, number>(); // hash → sizeBytes (first seen)
  const knownBeforeHashes = new Set<string>();

  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.sha256) continue;
    const hash = entry.sha256;
    const size = entry.sizeBytes ?? 0;
    knownBeforeHashes.add(hash);

    const existing = hashSizes.get(hash);
    if (existing === undefined) {
      hashSizes.set(hash, size);
    } else if (existing !== size) {
      // Inconsistent sizes for the same hash — B2 evidence integrity failure
      throw new BridgeError(
        'ARTIFACT_B2_INTEGRITY_FAILED',
        `BEFORE entries with hash ${hash} have inconsistent sizes: ${existing} vs ${size}`,
        500,
      );
    }
    // else: duplicate with consistent size — no additional contribution
  }

  let uniqueBeforeBytes = 0;
  for (const size of hashSizes.values()) {
    uniqueBeforeBytes += size;
  }

  return { uniqueBeforeBytes, knownBeforeHashes };
}

// ---------------------------------------------------------------------------
// Pure: cleanup helper Docker spec (test seam)
// ---------------------------------------------------------------------------

export interface CleanupHelperSpec {
  Image: string;
  User: string;
  Cmd: string[];
  Labels: Record<string, string>;
  NetworkDisabled: boolean;
  HostConfig: {
    AutoRemove: boolean;
    Privileged: boolean;
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    SecurityOpt: string[];
    NetworkMode: string;
    Mounts: Array<{ Type: string; Source: string; Target: string; ReadOnly: boolean }>;
    Memory: number;
    PidsLimit: number;
  };
}

/**
 * Construct and validate the trusted .b3-temp cleanup helper Docker spec.
 * Production remove() MUST use this exact function. Exported for unit testing.
 *
 * @param path - The path to delete (must be '.b3-temp' or start with '.b3-temp/')
 * @param evidenceVolume - The evidence Docker volume name
 * @param helperImage - The helper image to use
 * @param jobId - The job ID (for labels)
 * @returns The validated Docker container-create spec
 * @throws BridgeError if the path is invalid
 */
export function buildCleanupHelperSpec(
  path: string,
  evidenceVolume: string,
  helperImage: string,
  jobId: string,
): CleanupHelperSpec {
  // Validate path: restricted to the exact .b3-temp directory and descendants.
  // Reject: absolute paths, traversal (..), dot-only, sibling names (.b3-temp-old)
  if (path.startsWith('/') || path.includes('..') || path === '.' ||
      (path !== '.b3-temp' && !path.startsWith('.b3-temp/'))) {
    throw new BridgeError(
      'ARTIFACT_STORAGE_INTEGRITY_FAILED',
      `remove restricted to .b3-temp; rejected path: ${path}`,
      500,
    );
  }

  return {
    Image: helperImage,
    User: '0:0',
    Cmd: ['rm', '-rf', `/evidence/${path}`],
    Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'evidence-rm', [LABEL_JOB]: jobId },
    NetworkDisabled: true,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      Mounts: [{ Type: 'volume', Source: evidenceVolume, Target: '/evidence', ReadOnly: false }],
      Memory: 32 * 1024 * 1024,
      PidsLimit: 4,
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
  private readonly capability: ProfileCapability;
  private readonly writeMode: boolean;
  /** Pristine post-staging manifest, captured before the runner writes (write mode only). */
  private baselineManifest: WorkspaceManifest | null = null;
  private changeSet: ChangeSet | null = null;
  /**
   * A6-B2 STAGED_BEFORE evidence captured after staging and before the model
   * starts (write-mode jobs only). Immutable after capture; the runner cannot
   * alter it because it is stored outside the workspace volume.
   */
  private beforeCapture: BeforeCaptureResult | null = null;

  constructor(
    private readonly job: KiroBackendJobInput,
    private readonly opts: KiroBackendOptions,
  ) {
    // A5: audit/plan/review AND implement are Kiro-servable. The capability
    // (workspace mode, tools, agent identity, allowed tool kinds) is resolved
    // from TRUSTED profile policy only — never from the prompt.
    assertKiroProfile(job.profile);
    this.capability = resolveProfileCapability(job.profile);
    this.writeMode = isWriteProfile(job.profile);
    // Unguessable per-job agent name (mcp_ro_ for read-only, mcp_impl_ for
    // implement): a staged/tracked project cannot ship a same-named
    // .kiro/agents/<name>.json to override the bridge agent.
    this.agentName = `${this.capability.agentNamePrefix}${randomBytes(16).toString('hex')}`;
    this.model = job.model || resolveModel(job.policy.modelClass);
  }

  /** Evidence accessor: whether this job runs in A5 write mode. */
  isWriteMode(): boolean { return this.writeMode; }
  /** Evidence accessor: the deterministic change set (implement jobs after validate). */
  getChangeSet(): ChangeSet | null { return this.changeSet; }
  /** Evidence accessor: A6-B2 STAGED_BEFORE capture result (implement jobs after prepare). */
  getBeforeCapture(): BeforeCaptureResult | null { return this.beforeCapture; }

  isAgentFailure(e: unknown): boolean { return e instanceof KiroAgentFailure; }

  /**
   * Trusted dry-run indicator (A6-B3 trust-gate remediation). Reports the
   * TRUSTED CONSTRUCTION-TIME configuration this backend instance was built
   * with (`KiroBackendOptions.dryRun`, wired from the executor's own
   * `AGENT_KIRO_DRY_RUN` startup flag in src/executor/index.ts via
   * kiroFactory.ts) — never the ACP turn's own `RunnerResult.dryRun` echo,
   * never `result.baseCommit`, never `result.writeMode`. Those are
   * execution-time/backend-returned values and must never be authority for
   * whether a B3 artifact is required.
   */
  isDryRun(): boolean { return Boolean(this.opts.dryRun); }

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
        // A5 fail-closed: an implement (write) job whose committed source tree
        // contains any tracked symlink is rejected at staging (FAILED_
        // PRECONDITION) before the provider is ever reached. Read-only profiles
        // are unaffected.
        rejectTrackedSymlinks: this.writeMode,
      });
      this.checkAbort(signal);

      if (this.writeMode) {
        // A6-B2: capture pristine STAGED_BEFORE evidence AFTER staging and BEFORE
        // any mutation-capable runner/model starts. Evidence is stored on a dedicated
        // per-job Docker volume (never host filesystem). Fail closed: if capture
        // fails, prepare() rethrows and the job never reaches run().
        log('kiro backend: capturing STAGED_BEFORE evidence', { jobId: this.job.jobId });
        this.beforeCapture = await captureBeforeEvidence({
          jobId: this.job.jobId,
          volumeName: this.staged.volumeName,
          helperImage: this.opts.helperImage,
          maxEvidenceBytes: this.job.policy.maxEvidenceBytes,
        });
        log('kiro backend: STAGED_BEFORE captured', {
          jobId: this.job.jobId,
          evidenceVolume: this.beforeCapture.evidenceVolume,
          entryCount: this.beforeCapture.entryCount,
          totalBytes: this.beforeCapture.totalBytes,
        });
        this.checkAbort(signal);

        // Capture the PRISTINE snapshot manifest before any write can occur.
        // This is the deterministic baseline change detection compares against.
        log('kiro backend: capturing baseline manifest', { jobId: this.job.jobId });
        this.baselineManifest = await this.computeManifest('base');
        this.checkAbort(signal);
      }

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
    const agentJson = JSON.stringify(bridgeAgentConfig(this.agentName, { write: this.writeMode }), null, 2);
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
      trustTools: this.capability.trustTools,
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
      // A5 core invariant: implement mounts the job workspace WRITABLE; all
      // read-only profiles keep the A4 read-only mount.
      workspaceReadOnly: !this.writeMode,
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
      // Enforce the trusted per-profile tool-kind allowlist. Read-only profiles
      // permit only read/grep/glob/search/list; implement additionally permits
      // the file-mutation kinds. Shell/web/mcp/aws/delegation kinds fail closed
      // for EVERY profile (defense in depth even though they were never granted).
      const r = this.turnResult;
      const allowed = this.capability.allowedToolKinds;
      const disallowed = r.toolCalls.filter((tc) => !allowed.has(tc.kind));
      if (disallowed.length > 0) {
        throw new KiroAgentFailure(
          `agent attempted tools outside the ${this.job.profile} profile policy: `
          + `${disallowed.map((t) => t.kind).join(', ')}`);
      }

      // A5 result-semantics correctness (root-cause of the two real failures):
      // a write/edit tool being CALLED is NOT proof it SUCCEEDED. Inspect the
      // bounded ACP tool OUTCOME/STATUS evidence — never the assistant prose. If
      // ANY file-mutation-kind tool call ended in a failure status (failed/
      // denied/refused/error/…), the implement job is a canonical agent failure
      // (FAILED_AGENT) even though the turn reached end_turn. Checked BEFORE the
      // (expensive) change-detection step so a denied write fails fast.
      if (this.writeMode && !r.dryRun) {
        const failed = failedMutationToolCalls(r.toolCalls);
        if (failed.length > 0) {
          throw new KiroAgentFailure(
            'sandbox implement job had failed file-mutation tool call(s): '
            + `${failed.map((t) => `${t.kind}:${t.status}`).join(', ')}; `
            + 'the write did not succeed — check allowedTools and '
            + 'toolsSettings.fsWrite.allowedPaths in the agent config');
        }
      }

      // A5: deterministic change detection against the pristine baseline. Done
      // here (before cleanup disposes the workspace) so the evidence is captured
      // even though A5 never applies it. A zero-diff run with NO failed mutation
      // is NOT an automatic failure — the change set is recorded as-is and the
      // job may reach COMPLETED (COMPLETED is never an apply; A6 owns apply).
      if (this.writeMode) {
        this.changeSet = await this.detectChanges();
      }

      const baseCommit = this.staged?.baseCommit ?? null;

      // A6-B3: For real Kiro writer non-dry-run jobs, construct the canonical
      // artifact BEFORE cleanup disposes the workspace volume. This requires
      // write-quiescence (runner removed) and POST capture from the workspace.
      let artifactResult: ArtifactResult | undefined;
      if (this.writeMode && !r.dryRun && baseCommit && this.beforeCapture && this.staged) {
        // Step 1: Remove runner container (write-quiescence gate)
        await this.removeRunner();
        assertWriteQuiescence(this.runnerContainerId);

        // Step 2: Capture POST workspace state
        log('kiro backend: capturing POST workspace', { jobId: this.job.jobId });
        const postCapture = await this.capturePost();

        // Step 3: Construct canonical artifact
        log('kiro backend: constructing B3 artifact', { jobId: this.job.jobId });
        const volumeIO = this.createEvidenceVolumeIO();
        const git = this.createGitObjectReader();
        artifactResult = await constructArtifact({
          jobId: this.job.jobId,
          projectId: this.job.project,
          principalId: this.job.principalId,
          backend: this.job.backend,
          profile: this.job.profile,
          baseCommit,
          evidenceVolume: this.beforeCapture.evidenceVolume,
          maxEvidenceBytes: this.job.policy.maxEvidenceBytes,
          beforeCapture: this.beforeCapture,
          postCapture,
          git,
          volumeIO,
        });
        log('kiro backend: B3 artifact constructed', {
          jobId: this.job.jobId,
          artifactHash: artifactResult.artifactHash,
          opCount: artifactResult.opCount,
          applicable: artifactResult.applicable,
          contentComplete: artifactResult.contentComplete,
        });
      }

      let summary: string;
      if (r.dryRun) {
        summary = `Kiro ACP dry-run OK (protocol=${r.protocolVersion}, agent=${r.agentInfo?.version ?? '?'}, `
          + `session=${r.sessionId ?? '?'}, model=${this.model})`;
      } else if (this.writeMode) {
        const c = this.changeSet;
        const head = r.assistantText.length > 0 ? r.assistantText.slice(0, 3072) + '\n\n' : '';
        summary = `${head}Kiro implementation completed in sandbox (base=${baseCommit ?? '?'}, `
          + `changed=${c?.changedCount ?? 0}: +${c?.added.length ?? 0} ~${c?.modified.length ?? 0} `
          + `-${c?.deleted.length ?? 0}, bytes=${c?.changedBytes ?? 0}). NOT applied to host.`;
      } else {
        summary = r.assistantText.length > 0
          ? r.assistantText.slice(0, 4096)
          : `Kiro analysis completed (profile=${this.job.profile}, tools=${r.toolCalls.length}, stop=${r.stopReason})`;
      }

      if (this.writeMode) {
        log('kiro backend: sandbox change evidence', {
          jobId: this.job.jobId, baseCommit,
          added: this.changeSet?.added.length ?? 0,
          modified: this.changeSet?.modified.length ?? 0,
          deleted: this.changeSet?.deleted.length ?? 0,
          changedBytes: this.changeSet?.changedBytes ?? 0,
          truncated: this.changeSet?.truncated ?? false,
          diffHash: this.changeSet?.diffHash,
        });
      }

      return {
        summary,
        exitCode: 0,
        sessionId: r.sessionId ?? null,
        toolCalls: r.toolCalls,
        stopReason: r.stopReason,
        baseCommit,
        changeSet: this.changeSet ?? undefined,
        changedFiles: this.changeSet?.changedFiles,
        writeMode: this.writeMode,
        artifactResult,
      };
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Compare the pristine baseline manifest with a fresh post-run manifest to
   * produce deterministic change evidence. Never trusts the model's own
   * account of what it changed. Fails closed if the baseline is missing.
   */
  private async detectChanges(): Promise<ChangeSet> {
    if (!this.baselineManifest) {
      throw new KiroAgentFailure('baseline manifest missing — cannot compute change evidence');
    }
    const post = await this.computeManifest('post');
    if (!post.ok) {
      throw new KiroAgentFailure(`post-run manifest failed: ${post.error ?? 'unknown'}`);
    }
    return diffManifests(this.baselineManifest, post);
  }

  /**
   * Run the hardened, READ-ONLY manifest helper against the staged workspace
   * volume and parse its single JSON manifest line. No network, non-root, RO
   * rootfs, no host bind, no docker.sock. Always removes the helper container.
   */
  private async computeManifest(phase: 'base' | 'post'): Promise<WorkspaceManifest> {
    if (!this.staged) {
      throw new KiroAgentFailure('cannot manifest before staging');
    }
    const limits = toRunnerLimits(this.job.policy);
    const body = buildManifestCreateBody({
      image: this.opts.runnerImage,
      jobId: this.job.jobId,
      volumeName: this.staged.volumeName,
      limits,
    });
    const name = manifestContainerName(this.job.jobId, phase);
    let containerId: string | undefined;
    try {
      containerId = await createContainer(name, body as unknown as Record<string, unknown>);
      await startContainer(containerId);
      const waited = await waitContainer(containerId, { timeoutMs: Math.min(limits.maxRuntimeMs, 120_000) });
      const logs = await getContainerLogs(containerId, limits.maxOutputBytes);
      if (waited.timedOut) throw new KiroAgentFailure(`${phase} manifest timed out`);
      const manifest = parseManifest(logs.stdout);
      if (!manifest) {
        throw new KiroAgentFailure(`${phase} manifest produced no parseable output (stderr: ${logs.stderr.slice(0, 200)})`);
      }
      return manifest;
    } finally {
      if (containerId) await removeContainer(containerId, true).catch(() => {});
      await removeContainer(name, true).catch(() => {});
    }
  }

  /**
   * Remove the runner container explicitly (write-quiescence gate). After this
   * call, this.runnerContainerId is null. Normal cleanup must tolerate the
   * runner already having been removed.
   */
  private async removeRunner(): Promise<void> {
    if (this.runnerContainerId) {
      await killContainer(this.runnerContainerId).catch(() => {});
      await removeContainer(this.runnerContainerId, true);
      this.runnerContainerId = null;
    }
    // Also ensure named container is gone (defense in depth)
    await killContainer(runnerContainerName(this.job.jobId)).catch(() => {});
    await removeContainer(runnerContainerName(this.job.jobId), true).catch(() => {});
  }

  /**
   * Capture the POST workspace state by streaming the workspace volume via
   * a short-lived helper container (same approach as B2 BEFORE capture).
   * Requires write-quiescence (runner already removed).
   */
  private async capturePost(): Promise<PostCaptureResult> {
    if (!this.staged) {
      throw new BridgeError('POST_CAPTURE_IO', 'cannot capture POST: workspace not staged', 500);
    }
    const name = `${ns()}-post-${this.job.jobId}`;
    const labels: Record<string, string> = {
      [LABEL_MANAGED]: 'true',
      [LABEL_RESOURCE]: 'post-capture',
      [LABEL_JOB]: this.job.jobId,
    };
    let containerId: string | undefined;
    try {
      containerId = await createContainer(name, {
        Image: this.opts.helperImage,
        User: RUNNER_USER,
        Cmd: ['true'],
        Labels: labels,
        NetworkDisabled: true,
        HostConfig: {
          AutoRemove: false,
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          NetworkMode: 'none',
          Mounts: [{
            Type: 'volume',
            Source: this.staged.volumeName,
            Target: WORKSPACE_PATH,
            ReadOnly: true,
          }],
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
          Memory: 64 * 1024 * 1024,
          PidsLimit: 8,
        },
      });
      await startContainer(containerId);
      await waitContainer(containerId, { timeoutMs: 10_000 });
      const { body } = await getArchive(containerId, WORKSPACE_PATH);
      // Remaining budget: compute from UNIQUE BEFORE blob bytes (not totalBytes).
      // Each unique SHA-256 hash contributes its size once. Duplicate BEFORE
      // entries with the same hash are counted once. Inconsistent sizes for
      // the same hash fail closed (B2 evidence integrity violation).
      const { uniqueBeforeBytes, knownBeforeHashes } = computeUniqueBeforeBudget(
        this.beforeCapture?.entries ?? [],
      );
      const remainingBudget = this.job.policy.maxEvidenceBytes - uniqueBeforeBytes;
      const result = await parsePostTarStream(body, remainingBudget, knownBeforeHashes,
        this.job.policy.maxEvidenceBytes);
      return result;
    } finally {
      if (containerId) await removeContainer(containerId, true).catch(() => {});
      await removeContainer(name, true).catch(() => {});
    }
  }

  /**
   * Create an EvidenceVolumeIO adapter that reads/writes to the B2 evidence
   * Docker volume via short-lived helper containers.
   * R2-G: fileExists is fail-closed (only FILE_NOT_FOUND → false; other errors throw).
   * R2-D: remove is restricted to .b3-temp paths only.
   */
  private createEvidenceVolumeIO(): EvidenceVolumeIO {
    const evidenceVol = this.beforeCapture!.evidenceVolume;
    const helperImage = this.opts.helperImage;
    const jobId = this.job.jobId;
    const helperCounter = { n: 0 };

    const withHelper = async <T>(fn: (containerId: string) => Promise<T>): Promise<T> => {
      const n = helperCounter.n++;
      const name = `${ns()}-evio-${jobId}-${n}`;
      let containerId: string | undefined;
      try {
        containerId = await createContainer(name, {
          Image: helperImage,
          User: '0:0',
          Cmd: ['true'],
          Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'evidence-io', [LABEL_JOB]: jobId },
          NetworkDisabled: true,
          HostConfig: {
            AutoRemove: false,
            Privileged: false,
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            NetworkMode: 'none',
            Mounts: [{ Type: 'volume', Source: evidenceVol, Target: '/evidence', ReadOnly: false }],
            Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
            Memory: 64 * 1024 * 1024,
            PidsLimit: 8,
          },
        });
        await startContainer(containerId);
        await waitContainer(containerId, { timeoutMs: 10_000 });
        return await fn(containerId);
      } finally {
        if (containerId) await removeContainer(containerId, true).catch(() => {});
        await removeContainer(name, true).catch(() => {});
      }
    };

    return {
      async readFile(path: string): Promise<Buffer> {
        return withHelper(async (cid) => {
          const { body } = await getArchive(cid, `/evidence/${path}`);
          return extractSingleFile(body);
        });
      },
      async fileExists(path: string): Promise<boolean> {
        // R2-G: fail-closed. Only structured FILE_NOT_FOUND → false.
        // Other errors (Docker/transport/archive) → THROW unchanged.
        try {
          return await withHelper(async (cid) => {
            const { body } = await getArchive(cid, `/evidence/${path}`);
            // Drain the response body to release resources
            const ex = (await import('tar-stream')).extract();
            await new Promise<void>((resolve, reject) => {
              ex.on('entry', (_h, stream, next) => { stream.resume(); next(); });
              ex.on('finish', resolve);
              ex.on('error', reject);
              body.pipe(ex);
            });
            return true;
          });
        } catch (e: unknown) {
          // R2-G: Only the structured FILE_NOT_FOUND error code → false.
          // Never decide based on error message substrings.
          if (e instanceof BridgeError && e.code === 'FILE_NOT_FOUND') {
            return false;
          }
          // All other errors propagate unchanged (fail-closed)
          throw e;
        }
      },
      async writeFile(path: string, content: Buffer): Promise<void> {
        await withHelper(async (cid) => {
          const { pack } = await import('tar-stream');
          const p = pack();
          const chunks: Buffer[] = [];
          const archiveP = new Promise<Buffer>((res, rej) => {
            p.on('data', (c: Buffer) => chunks.push(c));
            p.on('end', () => res(Buffer.concat(chunks)));
            p.on('error', rej);
          });
          // Create parent dirs in tar
          const parts = path.split('/');
          let dir = '/evidence';
          for (let i = 0; i < parts.length - 1; i++) {
            dir += '/' + parts[i];
            p.entry({ name: dir + '/', type: 'directory', mode: 0o755 }, '');
          }
          p.entry({ name: `/evidence/${path}`, type: 'file', mode: 0o644, size: content.length }, content);
          p.finalize();
          const tar = await archiveP;
          await putArchive(cid, '/', tar);
        });
      },
      async remove(path: string): Promise<void> {
        // R2-D: Path validation and spec construction via the shared pure function.
        // Production remove() MUST use buildCleanupHelperSpec (test seam).
        const spec = buildCleanupHelperSpec(path, evidenceVol, helperImage, jobId);

        const n = helperCounter.n++;
        const rmName = `${ns()}-evrm-${jobId}-${n}`;
        let rmContainerId: string | undefined;
        try {
          rmContainerId = await createContainer(rmName, spec as unknown as Record<string, unknown>);
          await startContainer(rmContainerId);
          const waited = await waitContainer(rmContainerId, { timeoutMs: 30_000 });
          if (waited.timedOut || (waited.statusCode !== null && waited.statusCode !== 0)) {
            throw new BridgeError(
              'ARTIFACT_STORAGE_INTEGRITY_FAILED',
              `temp cleanup helper failed: timeout=${waited.timedOut}, exitCode=${waited.statusCode}`,
              500,
            );
          }
        } finally {
          if (rmContainerId) await removeContainer(rmContainerId, true).catch(() => {});
          await removeContainer(rmName, true).catch(() => {});
        }
      },
    };
  }

  /**
   * Create a GitObjectReader via trusted Docker helper containers.
   * The host project is mounted READ-ONLY. No direct host Git execution.
   */
  private createGitObjectReader(): GitObjectReader {
    return createDockerGitObjectReader({
      helperImage: this.opts.helperImage,
      hostPath: this.job.hostPath,
      jobId: this.job.jobId,
    });
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
