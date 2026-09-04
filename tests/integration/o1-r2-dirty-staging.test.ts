/**
 * O1-R2 production staging proof for a deliberately dirty host worktree.
 *
 * Uses the real RunnerSandbox.stageWorkspace() boundary and the pre-existing,
 * locally qualified A3 image. This gate never builds or pulls that image.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';
import { BridgeError } from '../../src/shared/errors.js';
import { RunnerSandbox } from '../../src/executor/agents/sandboxRunner.js';
import {
  buildRunnerCreateBody,
  stagerContainerName,
  toRunnerLimits,
  workspaceVolumeName,
} from '../../src/executor/agents/sandboxSpec.js';
import {
  createContainer,
  getContainerLogs,
  inspectImage,
  removeContainer,
  removeVolume,
  startContainer,
  waitContainer,
} from '../../src/executor/docker.js';

const IMAGE = 'mcp-ide-bridge-sandbox:a3';
const COMMITTED_BYTES = 'COMMITTED';
const DIRTY_HOST_BYTES = 'DIRTY-HOST-BYTES';

const policy: AgentResourcePolicy = {
  id: 'economy',
  modelClass: 'fast',
  maxRuntimeMs: 600_000,
  maxCpuMillicores: 1000,
  maxMemoryBytes: 1_073_741_824,
  maxPids: 128,
  maxOutputBytes: 262_144,
  maxEvidenceBytes: 10_485_760,
  networkPolicy: 'deny',
  retentionClass: 'ephemeral',
};

function newJobId(): string {
  return `job_${randomBytes(16).toString('hex')}`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function inspectStagedWorkspace(volumeName: string): Promise<{
  trackedBytes: string;
  entries: string[];
}> {
  const jobId = newJobId();
  const containerName = `o1-r2-inspector-${jobId}`;
  const body = buildRunnerCreateBody({
    image: IMAGE,
    jobId,
    volumeName,
    limits: toRunnerLimits(policy),
    networkMode: 'none',
    readRelPath: 'tracked.txt',
  });
  // Fixed commands over the test-owned volume only; no package or network use.
  body.Cmd = [
    'sh',
    '-c',
    'cat /workspace/tracked.txt && printf "\\n__O1_R2_ENTRIES__\\n" && cd /workspace && find . -mindepth 1 -print | sort',
  ];

  let containerId: string | null = null;
  try {
    containerId = await createContainer(containerName, body as unknown as Record<string, unknown>);
    await startContainer(containerId);
    const waited = await waitContainer(containerId, { timeoutMs: 30_000 });
    expect(waited).toEqual({ statusCode: 0, timedOut: false });
    const logs = await getContainerLogs(containerId, 65_536);
    expect(logs.stderr).toBe('');
    const marker = '\n__O1_R2_ENTRIES__\n';
    const markerIndex = logs.stdout.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    return {
      trackedBytes: logs.stdout.slice(0, markerIndex),
      entries: logs.stdout.slice(markerIndex + marker.length).split('\n').filter(Boolean),
    };
  } finally {
    if (containerId) await removeContainer(containerId, true).catch(() => {});
  }
}

const sandbox = new RunnerSandbox({ image: IMAGE });
let localImageId = '';

describe('O1-R2 dirty-host committed-HEAD staging', () => {
  beforeAll(async () => {
    try {
      localImageId = (await inspectImage(IMAGE)).Id;
    } catch (error) {
      throw new Error(
        `UNMET_LOCAL_TEST_PREREQUISITE: required pre-existing image ${IMAGE} is absent or not inspectable; gate stopped without build or pull`,
        { cause: error },
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(localImageId)) {
      throw new Error(`UNMET_LOCAL_TEST_PREREQUISITE: ${IMAGE} has invalid local image identity ${localImageId}`);
    }
    console.log(JSON.stringify({
      evidence: 'O1_R2_A3_LOCAL_IMAGE',
      image: IMAGE,
      imageId: localImageId,
      imageBuilt: false,
      imagePulled: false,
    }));
  });

  it('stages exact committed bytes, excludes dirty host state, preserves the host, and keeps strict default refusal', async () => {
    expect(localImageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    const dir = mkdtempSync(join(tmpdir(), 'o1-r2-dirty-staging-'));
    let permissiveJobId: string | null = null;
    let strictJobId: string | null = null;
    let stagedVolume: string | null = null;

    try {
      permissiveJobId = newJobId();
      strictJobId = newJobId();
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 'o1@test.local');
      git(dir, 'config', 'user.name', 'o1-r2-test');
      writeFileSync(join(dir, '.gitignore'), 'ignored-secret.txt\n');
      writeFileSync(join(dir, 'tracked.txt'), COMMITTED_BYTES);
      git(dir, 'add', '.gitignore', 'tracked.txt');
      git(dir, 'commit', '-qm', 'fixture committed state');

      const baseCommit = git(dir, 'rev-parse', 'HEAD').trim();
      const committedBytes = git(dir, 'show', 'HEAD:tracked.txt');
      expect(committedBytes).toBe(COMMITTED_BYTES);

      writeFileSync(join(dir, 'tracked.txt'), DIRTY_HOST_BYTES);
      writeFileSync(join(dir, 'untracked.txt'), 'UNTRACKED\n');
      writeFileSync(join(dir, 'ignored-secret.txt'), 'IGNORED\n');
      expect(existsSync(join(dir, '.git'))).toBe(true);

      const hostBefore = {
        head: git(dir, 'rev-parse', 'HEAD'),
        status: git(dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'),
        tracked: readFileSync(join(dir, 'tracked.txt'), 'utf8'),
        untracked: readFileSync(join(dir, 'untracked.txt'), 'utf8'),
        ignored: readFileSync(join(dir, 'ignored-secret.txt'), 'utf8'),
      };
      expect(hostBefore.status).toContain(' M tracked.txt');
      expect(hostBefore.status).toContain('?? untracked.txt');
      expect(hostBefore.status).toContain('!! ignored-secret.txt');

      const staged = await sandbox.stageWorkspace({
        jobId: permissiveJobId,
        hostPath: dir,
        gitRequired: true,
        requireCleanWorktree: false,
      });
      stagedVolume = staged.volumeName;
      expect(staged.baseCommit).toBe(baseCommit);

      const snapshot = await inspectStagedWorkspace(staged.volumeName);
      expect(snapshot.trackedBytes).toBe(committedBytes);
      expect(snapshot.trackedBytes).not.toContain('DIRTY-HOST-BYTES');
      expect(snapshot.entries).toContain('./tracked.txt');
      expect(snapshot.entries).not.toContain('./untracked.txt');
      expect(snapshot.entries).not.toContain('./ignored-secret.txt');
      expect(snapshot.entries.some((entry) => entry === './.git' || entry.startsWith('./.git/'))).toBe(false);

      const hostAfterPermissiveStage = {
        head: git(dir, 'rev-parse', 'HEAD'),
        status: git(dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'),
        tracked: readFileSync(join(dir, 'tracked.txt'), 'utf8'),
        untracked: readFileSync(join(dir, 'untracked.txt'), 'utf8'),
        ignored: readFileSync(join(dir, 'ignored-secret.txt'), 'utf8'),
      };
      expect(hostAfterPermissiveStage).toEqual(hostBefore);
      expect(existsSync(join(dir, '.git'))).toBe(true);

      let strictError: unknown;
      try {
        await sandbox.stageWorkspace({
          jobId: strictJobId,
          hostPath: dir,
          gitRequired: true,
          // Intentionally omitted: the production default is strict.
        });
      } catch (error) {
        strictError = error;
      }
      expect(strictError).toBeInstanceOf(BridgeError);
      expect((strictError as BridgeError).code).toBe('PRECONDITION_FAILED');

      const hostAfter = {
        head: git(dir, 'rev-parse', 'HEAD'),
        status: git(dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'),
        tracked: readFileSync(join(dir, 'tracked.txt'), 'utf8'),
        untracked: readFileSync(join(dir, 'untracked.txt'), 'utf8'),
        ignored: readFileSync(join(dir, 'ignored-secret.txt'), 'utf8'),
      };
      expect(hostAfter).toEqual(hostBefore);
      expect(hostAfter.tracked).toBe(DIRTY_HOST_BYTES);
      expect(existsSync(join(dir, '.git'))).toBe(true);
    } finally {
      if (permissiveJobId) {
        await removeContainer(stagerContainerName(permissiveJobId), true).catch(() => {});
        await removeVolume(workspaceVolumeName(permissiveJobId), true).catch(() => {});
      }
      if (strictJobId) {
        await removeContainer(stagerContainerName(strictJobId), true).catch(() => {});
        await removeVolume(workspaceVolumeName(strictJobId), true).catch(() => {});
      }
      if (stagedVolume) await removeVolume(stagedVolume, true).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
