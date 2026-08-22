/**
 * Executor-owned runner sandbox (Phase A3).
 *
 * Narrow trusted abstraction that turns internal policy into a tightly confined
 * ephemeral Docker runner lifecycle. It owns Docker MECHANICS only; public
 * authorization stays above this layer (gateway grants + jobEngine trusted
 * config). Nothing here is reachable from an MCP caller, and no method accepts
 * caller-controlled Docker options: images, mounts, commands, host paths and
 * limits all come from trusted inputs (agentConfig / resource policy).
 *
 * A3 proved the sandbox foundation with a deterministic internal probe.
 * KiroBackend (executor/agents/kiroBackend.ts) now invokes this from trusted
 * code as the real agent_dispatch execution path when the runner/proxy/Kiro
 * credential infrastructure is configured (src/executor/index.ts); dispatch
 * otherwise falls back to the fake backend.
 */
import { BridgeError } from '../../shared/errors.js';
import type { AgentResourcePolicy, AgentNetworkPolicy } from '../../shared/agents.js';
import {
  createVolume, removeVolume, listVolumesByFilter,
  createContainer, startContainer, inspectContainerFull, waitContainer,
  getContainerLogs, stopContainer, killContainer, removeContainer,
  listContainersByFilter,
  type ContainerSummary, type VolumeSummary,
} from '../docker.js';
import {
  managedLabelFilters, isBridgeManaged, ownershipLabelValue,
  ownershipLabels, workspaceVolumeName, runnerContainerName, stagerContainerName,
  toRunnerLimits, resolveNetworkMode, buildStagerCreateBody, buildRunnerCreateBody,
  type DockerCreateBody,
} from './sandboxSpec.js';

function log(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', msg, ...fields }));
}

export interface StageResult {
  volumeName: string;
  baseCommit: string;
}

export interface ManagedRunResult {
  containerId: string;
  imageId: string; // immutable image ID actually executed
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  runtimeMs: number;
  outputBytes: number;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
}

export interface SandboxProbeResult {
  jobId: string;
  baseCommit: string;
  volumeName: string;
  containerId: string;
  imageId: string;
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  runtimeMs: number;
  outputBytes: number;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
  /** Parsed probe evidence line when the probe emitted valid JSON. */
  probe?: {
    uid: number; gid: number; files: string[]; staged: string | null;
    marker: string | null; tmp: string | null; rootfsWrite: string | null;
    dockerSock: boolean; network: string | null;
  };
}

export interface SandboxRunnerOptions {
  /** Trusted runner/stager image reference (immutable ID resolved at run time). */
  image: string;
}

export class RunnerSandbox {
  constructor(private readonly opts: SandboxRunnerOptions) {}

  /**
   * Stage a trusted git project's committed HEAD into a fresh workspace volume.
   * Fails closed (PRECONDITION_FAILED) on a dirty/invalid source. The real
   * source is only ever visible to the trusted stager helper, read-only.
   */
  async stageWorkspace(opts: {
    jobId: string;
    hostPath: string;
    gitRequired: boolean;
    /**
     * A5 implement fail-closed policy: when true, staging rejects a source
     * whose committed HEAD contains ANY tracked symlink (Git mode 120000) with
     * PRECONDITION_FAILED, BEFORE the workspace is materialized. Read-only
     * profiles leave this false (A4 parity).
     */
    rejectTrackedSymlinks?: boolean;
  }): Promise<StageResult> {
    if (!opts.gitRequired) {
      // v1 is git-project-first; a non-git snapshot policy is a later decision.
      throw new BridgeError('PRECONDITION_FAILED', 'A3 staging requires a git project (gitRequired=true)', 412);
    }
    const volumeName = workspaceVolumeName(opts.jobId);
    await createVolume(volumeName, ownershipLabels('workspace', opts.jobId));

    const name = stagerContainerName(opts.jobId);
    const body = buildStagerCreateBody({
      image: this.opts.image, jobId: opts.jobId, hostPath: opts.hostPath, volumeName,
      rejectTrackedSymlinks: opts.rejectTrackedSymlinks,
    });
    let containerId: string | undefined;
    try {
      containerId = await createContainer(name, body as unknown as Record<string, unknown>);
      await startContainer(containerId);
      const waited = await waitContainer(containerId, { timeoutMs: 120_000 });
      const logs = await getContainerLogs(containerId, 65_536);
      if (waited.timedOut) throw new BridgeError('PRECONDITION_FAILED', 'staging timed out', 412);
      if (waited.statusCode !== 0) {
        const reason = waited.statusCode === 3 ? 'source working tree is not clean'
          : waited.statusCode === 4 ? 'source is not a git repository'
          : waited.statusCode === 5 ? 'source HEAD cannot be resolved'
          : waited.statusCode === 6 ? 'source contains a tracked symlink (Git mode 120000); rejected for an implement (write) job'
          : `staging failed (exit ${waited.statusCode})`;
        throw new BridgeError('PRECONDITION_FAILED', reason, 412);
      }
      const m = logs.stdout.match(/BASE_COMMIT=([0-9a-f]{40})/);
      if (!m?.[1]) throw new BridgeError('SANDBOX_FAILED', 'staging did not report a base commit', 500);
      const baseCommit = m[1];
      log('sandbox workspace staged', { jobId: opts.jobId, volumeName, baseCommit });
      return { volumeName, baseCommit };
    } catch (e) {
      // Fail closed: never leave partial owned resources behind.
      if (containerId) await removeContainer(containerId, true).catch(() => {});
      await removeVolume(volumeName, true).catch(() => {});
      throw e;
    } finally {
      if (containerId) await removeContainer(containerId, true).catch(() => {});
    }
  }

  /**
   * Internal runner lifecycle primitive: create → start → bounded wait
   * (maxRuntimeMs) → graceful stop then forced kill on timeout → bounded log
   * capture → inspect → ALWAYS remove. Success, failure and timeout all leave
   * no live container. The body is trusted (built by sandboxSpec); this method
   * adds no Docker options of its own beyond lifecycle control.
   */
  async runManagedContainer(
    name: string,
    body: DockerCreateBody,
    opts: { maxRuntimeMs: number; maxOutputBytes: number },
  ): Promise<ManagedRunResult> {
    let containerId: string | undefined;
    const start = Date.now();
    try {
      containerId = await createContainer(name, body as unknown as Record<string, unknown>);
      await startContainer(containerId);
      const waited = await waitContainer(containerId, { timeoutMs: opts.maxRuntimeMs });
      if (waited.timedOut) {
        // Bounded graceful stop, then forced kill — never an unbounded wait.
        await stopContainer(containerId, 2).catch(() => {});
        await killContainer(containerId).catch(() => {});
        await waitContainer(containerId, { timeoutMs: 5_000 }).catch(() => {});
      }
      const runtimeMs = Date.now() - start;
      const logs = await getContainerLogs(containerId, opts.maxOutputBytes);
      const info = await inspectContainerFull(containerId);
      return {
        containerId,
        imageId: info.Image,
        exitCode: waited.timedOut ? null : info.State.ExitCode,
        timedOut: waited.timedOut,
        oomKilled: info.State.OOMKilled,
        runtimeMs,
        outputBytes: logs.bytes,
        outputTruncated: logs.truncated,
        stdout: logs.stdout,
        stderr: logs.stderr,
      };
    } finally {
      if (containerId) await removeContainer(containerId, true).catch(() => {});
    }
  }

  /**
   * Run the deterministic probe against a staged workspace with hard limits and
   * network denial, capture bounded evidence, and always remove the runner.
   */
  async runProbe(opts: {
    jobId: string;
    volumeName: string;
    baseCommit: string;
    policy: AgentResourcePolicy;
    networkPolicy: AgentNetworkPolicy;
    readRelPath: string;
  }): Promise<SandboxProbeResult> {
    const limits = toRunnerLimits(opts.policy);
    const networkMode = resolveNetworkMode(opts.networkPolicy);
    const body = buildRunnerCreateBody({
      image: this.opts.image, jobId: opts.jobId, volumeName: opts.volumeName,
      limits, networkMode, readRelPath: opts.readRelPath,
    });
    const run = await this.runManagedContainer(runnerContainerName(opts.jobId), body, {
      maxRuntimeMs: limits.maxRuntimeMs, maxOutputBytes: limits.maxOutputBytes,
    });

    let probe: SandboxProbeResult['probe'];
    const line = run.stdout.split('\n').map((s) => s.trim()).reverse().find((s) => s.startsWith('{') && s.endsWith('}'));
    if (line) { try { probe = JSON.parse(line); } catch { /* leave undefined */ } }

    log('sandbox probe complete', {
      jobId: opts.jobId, exitCode: run.exitCode, timedOut: run.timedOut,
      oomKilled: run.oomKilled, runtimeMs: run.runtimeMs, outputBytes: run.outputBytes,
    });
    return {
      jobId: opts.jobId,
      baseCommit: opts.baseCommit,
      volumeName: opts.volumeName,
      containerId: run.containerId,
      imageId: run.imageId,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      oomKilled: run.oomKilled,
      runtimeMs: run.runtimeMs,
      outputBytes: run.outputBytes,
      outputTruncated: run.outputTruncated,
      stdout: run.stdout,
      stderr: run.stderr,
      probe,
    };
  }

  /** Remove a workspace volume (ephemeral probe workspaces are disposed). */
  async disposeWorkspace(volumeName: string): Promise<void> {
    await removeVolume(volumeName, true).catch(() => {});
  }

  /**
   * Startup/recovery reconciliation. Only resources carrying the EXACT bridge
   * ownership label are candidates — never name/image/age/status. Any managed
   * runner/stager container or workspace volume found is an orphan (A3 runners
   * are ephemeral and not attachable) and is failed closed: containers are
   * killed+removed, workspace volumes removed.
   */
  async reconcileOrphans(): Promise<{ removedContainers: string[]; removedVolumes: string[] }> {
    const removedContainers: string[] = [];
    const removedVolumes: string[] = [];

    // N1D: sweep every accepted ownership namespace. A single Docker label
    // filter ANDs its entries, so legacy-labelled orphans need their own query;
    // results are de-duplicated because a resource may carry two namespaces.
    const containersById = new Map<string, ContainerSummary>();
    for (const filter of managedLabelFilters()) {
      for (const c of await listContainersByFilter(filter, true).catch(() => [])) {
        containersById.set(c.Id, c);
      }
    }
    for (const c of containersById.values()) {
      if (!isBridgeManaged(c.Labels)) continue; // defense in depth: verify the label locally
      await stopContainer(c.Id, 2).catch(() => {});
      await removeContainer(c.Id, true).catch(() => {});
      removedContainers.push(c.Id);
      log('sandbox orphan container reconciled', {
        containerId: c.Id,
        job: ownershipLabelValue(c.Labels, 'job'),
        resource: ownershipLabelValue(c.Labels, 'resource'),
      });
    }

    const volumesByName = new Map<string, VolumeSummary>();
    for (const filter of managedLabelFilters()) {
      for (const v of await listVolumesByFilter(filter).catch(() => [])) {
        volumesByName.set(v.Name, v);
      }
    }
    for (const v of volumesByName.values()) {
      if (!isBridgeManaged(v.Labels)) continue;
      // A6-B2: evidence volumes are retained (not ephemeral) — never reconcile
      // them. This read MUST be namespace-aware: a legacy evidence volume is
      // labelled io.mcp-ide-bridge.resource=evidence, and reading only the
      // current namespace would see `undefined`, fail this guard, and destroy
      // retained pre-cutover evidence.
      const resource = ownershipLabelValue(v.Labels, 'resource');
      if (resource === 'evidence') continue;
      // Fail-safe: an unreadable/contradictory resource label is not proof that
      // this is an ephemeral A3 resource. Retain rather than delete.
      if (resource === null) {
        log('sandbox orphan volume retained (resource label not provable)', { volume: v.Name });
        continue;
      }
      await removeVolume(v.Name, true).catch(() => {});
      removedVolumes.push(v.Name);
      log('sandbox orphan volume reconciled', { volume: v.Name, job: ownershipLabelValue(v.Labels, 'job') });
    }
    return { removedContainers, removedVolumes };
  }

  /** Convenience: stage → probe → dispose, guaranteeing cleanup. A4 replaces the probe step. */
  async runSandboxProbe(opts: {
    jobId: string;
    hostPath: string;
    gitRequired: boolean;
    policy: AgentResourcePolicy;
    networkPolicy: AgentNetworkPolicy;
    readRelPath: string;
    retainWorkspace?: boolean;
  }): Promise<SandboxProbeResult> {
    const staged = await this.stageWorkspace({ jobId: opts.jobId, hostPath: opts.hostPath, gitRequired: opts.gitRequired });
    try {
      return await this.runProbe({
        jobId: opts.jobId, volumeName: staged.volumeName, baseCommit: staged.baseCommit,
        policy: opts.policy, networkPolicy: opts.networkPolicy, readRelPath: opts.readRelPath,
      });
    } finally {
      if (!opts.retainWorkspace) await this.disposeWorkspace(staged.volumeName);
    }
  }
}
