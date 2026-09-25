/**
 * A3 runner-sandbox Docker integration (controlled, self-contained).
 *
 * Drives the Executor-owned RunnerSandbox DIRECTLY against the host Docker
 * socket — the trusted internal harness described by the A3 brief. It needs NO
 * MCP client, NO gateway, NO live stack and NO client credentials, and it does
 * NOT touch the public Agent Dispatch path or any unrelated Docker project.
 *
 * NO Kiro. NO Copilot. NO real AI backend. The runner is the deterministic
 * internal probe only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';
import { RunnerSandbox } from '../../src/executor/agents/sandboxRunner.js';
import {
  MANAGED_FILTER, LABEL_JOB, ownershipLabels, workspaceVolumeName, runnerContainerName,
  buildRunnerCreateBody, toRunnerLimits, resolveNetworkMode, WORKSPACE_PATH,
} from '../../src/executor/agents/sandboxSpec.js';
import {
  listContainersByFilter, listVolumesByFilter, inspectContainerFull,
  createContainer, startContainer, removeContainer, createVolume, removeVolume, inspectImage,
} from '../../src/executor/docker.js';

const IMAGE = 'mcp-ide-bridge-sandbox:a3';
const UNRELATED_IMAGE = 'node:24-alpine';
let imageId = '';
let unrelatedImageId = '';
function currentJobFilter(jobId: string): { label: string[] } { return { label: [`${LABEL_JOB}=${jobId}`] }; }
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast',
  maxRuntimeMs: 600_000, maxCpuMillicores: 1000, maxMemoryBytes: 1_073_741_824,
  maxPids: 128, maxOutputBytes: 262_144, maxEvidenceBytes: 10_485_760,
  networkPolicy: 'deny', retentionClass: 'ephemeral',
};

function newJobId(): string { return `job_${randomBytes(16).toString('hex')}`; }
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Build a clean git fixture: tracked files + a committed .gitignore + an IGNORED secret (clean per porcelain). */
function makeCleanFixture(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'a3-fixture-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a3@test.local');
  git(dir, 'config', 'user.name', 'a3');
  writeFileSync(join(dir, 'README.md'), 'hello A3\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.txt'), 'export const x = 1\n');
  writeFileSync(join(dir, '.gitignore'), '*.secret\n');
  git(dir, 'add', 'README.md', 'src/app.txt', '.gitignore');
  git(dir, 'commit', '-qm', 'initial');
  // Ignored sentinel — present on disk, clean per `git status`, must never stage.
  writeFileSync(join(dir, 'leak.secret'), 'IGNORED-SENTINEL-MUST-NOT-STAGE\n');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

let sandbox: RunnerSandbox;
const fixtures: string[] = [];
const recordedImageIds = new Set<string>();

describe('A3 runner sandbox — Docker integration', () => {
  beforeAll(async () => {
    // Build the trusted sandbox image from repository source (idempotent/cached),
    // then bind the integration fixture to the immutable local image ID required
    // by Docker Authority. The mutable tag remains only the build/lookup handle.
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '-f', join(REPO_ROOT, 'runner', 'Dockerfile'), join(REPO_ROOT, 'runner')], { stdio: 'pipe' });
    imageId = (await inspectImage(IMAGE)).Id;
    unrelatedImageId = (await inspectImage(UNRELATED_IMAGE)).Id;
    expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(unrelatedImageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    sandbox = new RunnerSandbox({ image: imageId });
  }, 120_000);

  afterAll(async () => {
    for (const d of fixtures) rmSync(d, { recursive: true, force: true });
    // Belt-and-suspenders: remove any bridge-managed resources this suite created.
    await sandbox.reconcileOrphans().catch(() => {});
  });

  it('runner container config is non-root, confined, and resource-limited (create → inspect → remove)', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);
    await createVolume(volumeName, ownershipLabels('workspace', jobId));
    const body = buildRunnerCreateBody({
      image: imageId, jobId, volumeName, limits: toRunnerLimits(policy),
      networkMode: resolveNetworkMode('deny'), readRelPath: 'README.md',
    });
    const id = await createContainer(runnerContainerName(jobId), body as unknown as Record<string, unknown>);
    try {
      const info = await inspectContainerFull(id);
      expect(info.Config.User).toBe('1000:1000');
      expect(info.HostConfig.Privileged).toBe(false);
      expect(info.HostConfig.CapDrop).toEqual(['ALL']);
      expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(info.HostConfig.ReadonlyRootfs).toBe(true);
      expect(info.HostConfig.NetworkMode).toBe('none');
      expect(info.HostConfig.Memory).toBe(policy.maxMemoryBytes);
      expect(info.HostConfig.NanoCpus).toBe(policy.maxCpuMillicores * 1_000_000);
      expect(info.HostConfig.PidsLimit).toBe(policy.maxPids);
      expect(info.HostConfig.PidMode).not.toBe('host');
      expect(info.HostConfig.IpcMode).not.toBe('host');
      expect(info.HostConfig.Devices ?? []).toEqual([]);
      // No host binds at all; exactly one workspace volume mount, RW.
      expect(info.HostConfig.Binds ?? []).toEqual([]);
      const volMounts = info.Mounts.filter((m) => m.Type === 'volume');
      expect(volMounts).toHaveLength(1);
      expect(volMounts[0]?.Destination).toBe(WORKSPACE_PATH);
      expect(volMounts[0]?.RW).toBe(true);
      // No docker.sock / host-path bind mount anywhere.
      for (const m of info.Mounts) expect(m.Type).not.toBe('bind');
      expect(JSON.stringify(info.Mounts)).not.toContain('docker.sock');
    } finally {
      await removeContainer(id, true);
      await removeVolume(volumeName, true);
    }
  }, 60_000);

  it('rejects arbitrary temp Git roots before staging and leaves no owned resources', async () => {
    const { dir } = makeCleanFixture();
    fixtures.push(dir);
    const before = createHash('sha256').update(readFileSync(join(dir, 'README.md'))).digest('hex');
    const jobId = newJobId();

    await expect(sandbox.runSandboxProbe({
      jobId, hostPath: dir, gitRequired: true, policy, networkPolicy: 'deny', readRelPath: 'README.md',
    })).rejects.toThrow(/host bind must equal an exact trusted configured root|FORBIDDEN_POLICY/i);

    const after = createHash('sha256').update(readFileSync(join(dir, 'README.md'))).digest('hex');
    expect(after).toBe(before);
    const runners = await listContainersByFilter(currentJobFilter(jobId), true);
    expect(runners).toHaveLength(0);
    const vols = await listVolumesByFilter(currentJobFilter(jobId));
    expect(vols).toHaveLength(0);
  }, 60_000);

  it('fails closed on an untrusted dirty source root and leaves no owned resources', async () => {
    const { dir } = makeCleanFixture();
    fixtures.push(dir);
    writeFileSync(join(dir, 'UNTRACKED.secret-plain'), 'UNTRACKED-SENTINEL\n');
    writeFileSync(join(dir, 'untracked.txt'), 'plain untracked\n');
    const jobId = newJobId();

    await expect(sandbox.stageWorkspace({ jobId, hostPath: dir, gitRequired: true }))
      .rejects.toThrow(/host bind must equal an exact trusted configured root|FORBIDDEN_POLICY/i);

    const vols = await listVolumesByFilter(currentJobFilter(jobId));
    expect(vols).toHaveLength(0);
    const containers = await listContainersByFilter(currentJobFilter(jobId), true);
    expect(containers).toHaveLength(0);
  }, 60_000);

  it('bounds runner output and truncates beyond maxOutputBytes', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);
    await createVolume(volumeName, ownershipLabels('workspace', jobId));
    // Reuse the hardened runner body but with a noisy deterministic command.
    const body = buildRunnerCreateBody({
      image: imageId, jobId, volumeName, limits: toRunnerLimits(policy),
      networkMode: resolveNetworkMode('deny'), readRelPath: 'README.md',
    });
    body.Cmd = ['sh', '-c', 'yes ABCDEFGHIJKLMNOP | head -c 2000000'];
    try {
      const run = await sandbox.runManagedContainer(runnerContainerName(jobId), body, { maxRuntimeMs: 30_000, maxOutputBytes: 4096 });
      expect(run.outputTruncated).toBe(true);
      expect(run.stdout.length).toBeLessThanOrEqual(4096);
      expect(run.exitCode).toBe(0);
      // Runner removed after success.
      const runners = await listContainersByFilter(currentJobFilter(jobId), true);
      expect(runners).toHaveLength(0);
    } finally {
      await removeVolume(volumeName, true);
    }
  }, 60_000);

  it('terminates a runner that exceeds maxRuntimeMs and removes it (timeout cleanup)', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);
    await createVolume(volumeName, ownershipLabels('workspace', jobId));
    const body = buildRunnerCreateBody({
      image: imageId, jobId, volumeName, limits: toRunnerLimits(policy),
      networkMode: resolveNetworkMode('deny'), readRelPath: 'README.md',
    });
    body.Cmd = ['sh', '-c', 'sleep 3600']; // runs far beyond the tiny timeout below
    try {
      const run = await sandbox.runManagedContainer(runnerContainerName(jobId), body, { maxRuntimeMs: 2000, maxOutputBytes: 4096 });
      expect(run.timedOut).toBe(true);
      expect(run.exitCode).toBeNull();
      // No live runner left after timeout.
      const runners = await listContainersByFilter(currentJobFilter(jobId), true);
      expect(runners).toHaveLength(0);
    } finally {
      await removeVolume(volumeName, true);
    }
  }, 60_000);

  it('reconciles bridge-owned runner and workspace orphans through current labels', async () => {
    const orphanJob = newJobId();
    const orphanVol = workspaceVolumeName(orphanJob);
    await createVolume(orphanVol, ownershipLabels('workspace', orphanJob));
    const orphanBody = buildRunnerCreateBody({
      image: imageId, jobId: orphanJob, volumeName: orphanVol, limits: toRunnerLimits(policy),
      networkMode: resolveNetworkMode('deny'), readRelPath: 'README.md',
    });
    orphanBody.Cmd = ['sh', '-c', 'sleep 300'];
    const orphanId = await createContainer(runnerContainerName(orphanJob), orphanBody as unknown as Record<string, unknown>);
    await startContainer(orphanId);

    try {
      await expect(createContainer(`a3-unrelated-${randomBytes(6).toString('hex')}`, {
        Image: unrelatedImageId,
        Cmd: ['sh', '-c', 'sleep 1'],
        Labels: { 'com.example.unrelated': 'true' },
        HostConfig: { NetworkMode: 'none', AutoRemove: false, Privileged: false },
      })).rejects.toThrow(/ownership namespace|required|FORBIDDEN_POLICY/i);

      const result = await sandbox.reconcileOrphans();
      expect(result.removedContainers).toContain(orphanId);
      expect(result.removedVolumes).toContain(orphanVol);
      expect(await listContainersByFilter(MANAGED_FILTER, true)).toHaveLength(0);
      expect(await listVolumesByFilter(MANAGED_FILTER)).toHaveLength(0);
    } finally {
      await removeContainer(orphanId, true).catch(() => {});
      await removeVolume(orphanVol, true).catch(() => {});
    }
  }, 60_000);
});
