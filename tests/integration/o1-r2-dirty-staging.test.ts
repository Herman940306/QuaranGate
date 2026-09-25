/**
 * O1-R2 current-boundary staging proof.
 *
 * Historical O1 proved permissive committed-HEAD staging from a deliberately
 * dirty arbitrary temp worktree. The current Docker Authority contract is
 * stricter: a staging helper may bind only an exact trusted configured root.
 * This integration therefore proves the live boundary for an untrusted dirty
 * host root without broadening host-bind trust or mutating any trusted project.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError } from '../../src/shared/errors.js';
import { RunnerSandbox } from '../../src/executor/agents/sandboxRunner.js';
import { LABEL_JOB, stagerContainerName, workspaceVolumeName } from '../../src/executor/agents/sandboxSpec.js';
import {
  inspectImage,
  listContainersByFilter,
  listVolumesByFilter,
  removeContainer,
  removeVolume,
} from '../../src/executor/docker.js';

const IMAGE = 'mcp-ide-bridge-sandbox:a3';
const COMMITTED_BYTES = 'COMMITTED';
const DIRTY_HOST_BYTES = 'DIRTY-HOST-BYTES';

function newJobId(): string {
  return `job_${randomBytes(16).toString('hex')}`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function currentJobFilter(jobId: string): { label: string[] } {
  return { label: [`${LABEL_JOB}=${jobId}`] };
}

let localImageId = '';
let sandbox: RunnerSandbox;

describe('O1-R2 dirty-host committed-HEAD staging boundary', () => {
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
    sandbox = new RunnerSandbox({ image: localImageId });
    console.log(JSON.stringify({
      evidence: 'O1_R2_A3_LOCAL_IMAGE',
      image: IMAGE,
      imageId: localImageId,
      imageBuilt: false,
      imagePulled: false,
    }));
  });

  it('rejects a dirty arbitrary temp host worktree before staging and preserves host bytes/resources', async () => {
    expect(localImageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    const dir = mkdtempSync(join(tmpdir(), 'o1-r2-dirty-staging-'));
    const permissiveJobId = newJobId();
    const strictJobId = newJobId();

    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 'o1@test.local');
      git(dir, 'config', 'user.name', 'o1-r2-test');
      writeFileSync(join(dir, '.gitignore'), 'ignored-secret.txt\n');
      writeFileSync(join(dir, 'tracked.txt'), COMMITTED_BYTES);
      git(dir, 'add', '.gitignore', 'tracked.txt');
      git(dir, 'commit', '-qm', 'fixture committed state');

      const committedHead = git(dir, 'rev-parse', 'HEAD').trim();
      expect(git(dir, 'show', 'HEAD:tracked.txt')).toBe(COMMITTED_BYTES);

      writeFileSync(join(dir, 'tracked.txt'), DIRTY_HOST_BYTES);
      writeFileSync(join(dir, 'untracked.txt'), 'UNTRACKED\n');
      writeFileSync(join(dir, 'ignored-secret.txt'), 'IGNORED\n');
      expect(existsSync(join(dir, '.git'))).toBe(true);

      const hostBefore = {
        head: git(dir, 'rev-parse', 'HEAD').trim(),
        status: git(dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'),
        tracked: readFileSync(join(dir, 'tracked.txt'), 'utf8'),
        untracked: readFileSync(join(dir, 'untracked.txt'), 'utf8'),
        ignored: readFileSync(join(dir, 'ignored-secret.txt'), 'utf8'),
      };
      expect(hostBefore.head).toBe(committedHead);
      expect(hostBefore.status).toContain(' M tracked.txt');
      expect(hostBefore.status).toContain('?? untracked.txt');
      expect(hostBefore.status).toContain('!! ignored-secret.txt');

      await expect(sandbox.stageWorkspace({
        jobId: permissiveJobId,
        hostPath: dir,
        gitRequired: true,
        requireCleanWorktree: false,
      })).rejects.toMatchObject({
        code: 'FORBIDDEN_POLICY',
        message: expect.stringMatching(/trusted configured root|host bind/i),
      } satisfies Partial<BridgeError>);

      await expect(sandbox.stageWorkspace({
        jobId: strictJobId,
        hostPath: dir,
        gitRequired: true,
      })).rejects.toMatchObject({
        code: 'FORBIDDEN_POLICY',
        message: expect.stringMatching(/trusted configured root|host bind/i),
      } satisfies Partial<BridgeError>);

      const hostAfter = {
        head: git(dir, 'rev-parse', 'HEAD').trim(),
        status: git(dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'),
        tracked: readFileSync(join(dir, 'tracked.txt'), 'utf8'),
        untracked: readFileSync(join(dir, 'untracked.txt'), 'utf8'),
        ignored: readFileSync(join(dir, 'ignored-secret.txt'), 'utf8'),
      };
      expect(hostAfter).toEqual(hostBefore);
      expect(hostAfter.tracked).toBe(DIRTY_HOST_BYTES);
      expect(existsSync(join(dir, '.git'))).toBe(true);

      for (const jobId of [permissiveJobId, strictJobId]) {
        expect(await listContainersByFilter(currentJobFilter(jobId), true)).toHaveLength(0);
        expect(await listVolumesByFilter(currentJobFilter(jobId))).toHaveLength(0);
      }
    } finally {
      for (const jobId of [permissiveJobId, strictJobId]) {
        await removeContainer(stagerContainerName(jobId), true).catch(() => {});
        await removeVolume(workspaceVolumeName(jobId), true).catch(() => {});
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
