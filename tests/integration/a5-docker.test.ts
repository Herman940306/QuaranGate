/**
 * A5 writable job sandbox — Docker integration + security proofs.
 *
 * Exercises the current hardened Docker-Authority contract:
 *   - every new resource uses current io.quarangate ownership + canonical job ids,
 *   - managed containers use an immutable local image ID,
 *   - disposable seed fixtures are baked into the test runner image and copied
 *     into fresh Docker volumes by Docker's standard empty-volume copy-up,
 *   - write helpers reuse the production hardened runner body,
 *   - no host project bind reaches a runner, no docker.sock, no network,
 *   - deterministic manifest diffing reports added / modified / deleted only,
 *   - read-only workspace mounts still reject writes.
 *
 * No paid model is used anywhere in this file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import {
  createVolume,
  removeVolume,
  createContainer,
  startContainer,
  waitContainer,
  getContainerLogs,
  inspectContainerFull,
  removeContainer,
  inspectImage,
} from '../../src/executor/docker.js';

import {
  ownershipLabels,
  workspaceVolumeName,
  runnerContainerName,
  stagerContainerName,
  buildManifestCreateBody,
  buildStagerCreateBody,
  buildRunnerCreateBody,
  toRunnerLimits,
} from '../../src/executor/agents/sandboxSpec.js';

import {
  parseManifest,
  diffManifests,
} from '../../src/executor/agents/changeDetection.js';

import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER_TAG = 'qg-itest-kiro-runner:a5-current';
const newJobId = (): string => `job_${randomBytes(16).toString('hex')}`;

const policy: AgentResourcePolicy = {
  id: 'standard',
  modelClass: 'standard',
  maxRuntimeMs: 120_000,
  maxCpuMillicores: 2000,
  maxMemoryBytes: 2_147_483_648,
  maxPids: 256,
  maxOutputBytes: 262_144,
  maxEvidenceBytes: 52_428_800,
  networkPolicy: 'backend-only',
  retentionClass: 'short',
};

let buildDir = '';
let runnerImageId = '';

async function initializeWorkspace(
  jobId: string,
  volumeName: string,
): Promise<void> {
  await createVolume(
    volumeName,
    ownershipLabels('workspace', jobId),
  );

  const body = buildRunnerCreateBody({
    image: runnerImageId,
    jobId,
    volumeName,
    limits: toRunnerLimits(policy),
    networkMode: 'none',
    readRelPath: 'package.json',
  }) as unknown as {
    Cmd: string[];
    Env: string[];
  };

  // Starting the first container against an empty named volume triggers
  // Docker's normal image-to-volume copy-up for /workspace. The seed bytes
  // are baked into this disposable test image, never read from a host bind.
  body.Cmd = ['sh', '-c', 'test -f /workspace/.a5-seed-ready'];
  body.Env = ['HOME=/tmp'];

  const id = await createContainer(
    runnerContainerName(jobId),
    body as unknown as Record<string, unknown>,
  );

  try {
    await startContainer(id);
    const waited = await waitContainer(id, { timeoutMs: 30_000 });
    expect(waited.statusCode).toBe(0);
  } finally {
    await removeContainer(id, true).catch(() => {});
  }
}

async function runWorkspaceCommand(
  jobId: string,
  volumeName: string,
  command: string,
  readOnly = false,
): Promise<{ stdout: string; stderr: string; statusCode: number | null }> {
  const body = buildRunnerCreateBody({
    image: runnerImageId,
    jobId,
    volumeName,
    limits: toRunnerLimits(policy),
    networkMode: 'none',
    readRelPath: 'package.json',
  }) as unknown as {
    Cmd: string[];
    Env: string[];
    HostConfig: {
      Mounts: Array<{ Type: 'volume'; Source: string; Target: string; ReadOnly: boolean }>;
    };
  };

  body.Cmd = ['sh', '-c', command];
  body.Env = ['HOME=/tmp'];
  body.HostConfig.Mounts = [{
    Type: 'volume',
    Source: volumeName,
    Target: '/workspace',
    ReadOnly: readOnly,
  }];

  const id = await createContainer(
    runnerContainerName(jobId),
    body as unknown as Record<string, unknown>,
  );

  try {
    await startContainer(id);
    const waited = await waitContainer(id, { timeoutMs: 30_000 });
    const logs = await getContainerLogs(id, 65_536);
    return {
      stdout: logs.stdout,
      stderr: logs.stderr,
      statusCode: waited.statusCode,
    };
  } finally {
    await removeContainer(id, true).catch(() => {});
  }
}

async function seedWorkspace(
  jobId: string,
  volumeName: string,
  files: Record<string, string>,
): Promise<void> {
  await initializeWorkspace(jobId, volumeName);

  const script = Object.entries(files)
    .map(([path, content]) =>
      `mkdir -p "/workspace/$(dirname '${path}')"; printf '%s' '${content}' > "/workspace/${path}"`)
    .join('; ');

  const seeded = await runWorkspaceCommand(
    jobId,
    volumeName,
    script,
  );
  expect(seeded.statusCode).toBe(0);
}

async function manifestOf(jobId: string, volumeName: string) {
  const body = buildManifestCreateBody({
    image: runnerImageId,
    jobId,
    volumeName,
    limits: toRunnerLimits(policy),
  });

  const id = await createContainer(
    runnerContainerName(jobId),
    body as unknown as Record<string, unknown>,
  );

  try {
    await startContainer(id);
    await waitContainer(id, { timeoutMs: 30_000 });
    const logs = await getContainerLogs(id, 262_144);
    const manifest = parseManifest(logs.stdout);
    expect(manifest).not.toBeNull();
    return manifest!;
  } finally {
    await removeContainer(id, true).catch(() => {});
  }
}

describe('A5 writable job sandbox — Docker integration + security proofs', () => {
  beforeAll(async () => {
    buildDir = mkdtempSync(join(tmpdir(), 'a5b-'));
    const stub = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "kiro-cli-stub 2.5.0-test"; exit 0; fi',
      'if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then echo "stub acp help"; exit 0; fi',
      'exit 1',
    ].join('\n');

    writeFileSync(join(buildDir, 'kiro-cli'), stub, { mode: 0o755 });
    writeFileSync(join(buildDir, 'kiro-cli-chat'), stub, { mode: 0o755 });
    writeFileSync(
      join(buildDir, 'Dockerfile'),
      readFileSync(join(REPO_ROOT, 'runner', 'kiro', 'Dockerfile')),
    );
    writeFileSync(
      join(buildDir, 'kiro-acp-entrypoint.sh'),
      readFileSync(join(REPO_ROOT, 'runner', 'kiro', 'kiro-acp-entrypoint.sh')),
    );
    writeFileSync(join(buildDir, '.a5-seed-ready'), 'ready\n');
    writeFileSync(join(buildDir, 'package.json'), '{"name":"a5-seed"}\n');
    writeFileSync(
      join(buildDir, 'Dockerfile'),
      readFileSync(join(buildDir, 'Dockerfile'), 'utf8')
        + '\nCOPY --chown=1000:1000 .a5-seed-ready /workspace/.a5-seed-ready'
        + '\nCOPY --chown=1000:1000 package.json /workspace/package.json\n',
    );

    execFileSync(
      'docker',
      ['build', '--pull=false', '-q', '-t', RUNNER_TAG, buildDir],
      { stdio: 'pipe' },
    );

    runnerImageId = (await inspectImage(RUNNER_TAG)).Id;
    expect(runnerImageId).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 180_000);

  afterAll(() => {
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  });

  it('WRITABLE workspace: create + modify + delete land in the volume while rootfs stays READ-ONLY', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);

    await seedWorkspace(jobId, volumeName, {
      'keep.txt': 'KEEP',
      'mod.txt': 'OLD',
      'gone.txt': 'BYE',
    });

    try {
      const result = await runWorkspaceCommand(
        jobId,
        volumeName,
        [
          'echo NEW > /workspace/new.txt 2>&1 || echo WS_FAIL',
          'echo CHANGED > /workspace/mod.txt 2>&1 || echo WS_FAIL',
          'rm -f /workspace/gone.txt 2>&1 || echo WS_FAIL',
          'echo BAD > /rootfs-probe 2>&1 || echo ROOTFS_RO',
        ].join('; '),
      );

      expect(result.statusCode).toBe(0);
      expect(result.stdout).not.toContain('WS_FAIL');
      expect(result.stderr).not.toContain('WS_FAIL');
      expect(result.stdout + result.stderr).toContain('ROOTFS_RO');

      const post = await manifestOf(jobId, volumeName);
      const files = Object.fromEntries(post.entries.map((entry) => [entry.path, true]));
      expect(files['new.txt']).toBe(true);
      expect(files['mod.txt']).toBe(true);
      expect(files['gone.txt']).toBeUndefined();
    } finally {
      await removeVolume(volumeName, true).catch(() => {});
    }
  });

  it('change detection reports added/modified/deleted and IGNORES unchanged (baseline vs post)', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);

    await seedWorkspace(jobId, volumeName, {
      'keep.txt': 'KEEP',
      'mod.txt': 'OLD',
      'gone.txt': 'BYE',
    });

    try {
      const baseline = await manifestOf(jobId, volumeName);

      const result = await runWorkspaceCommand(
        jobId,
        volumeName,
        'printf NEW > /workspace/added.txt; printf CHANGED > /workspace/mod.txt; rm -f /workspace/gone.txt',
      );
      expect(result.statusCode).toBe(0);

      const post = await manifestOf(jobId, volumeName);
      const diff = diffManifests(baseline, post);

      expect(diff.added).toEqual(['added.txt']);
      expect(diff.modified).toEqual(['mod.txt']);
      expect(diff.deleted).toEqual(['gone.txt']);
      expect(diff.changedFiles).toEqual(['added.txt', 'gone.txt', 'mod.txt']);
      expect(diff.changedCount).toBe(3);
      expect(diff.diffHash).toMatch(/^[0-9a-f]{64}$/);
      expect(diff.changedFiles).not.toContain('keep.txt');
    } finally {
      await removeVolume(volumeName, true).catch(() => {});
    }
  });

  it('the manifest helper never binds the host, exposes docker.sock, or reaches the network', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);

    await seedWorkspace(jobId, volumeName, { 'a.txt': 'A' });

    try {
      const body = buildManifestCreateBody({
        image: runnerImageId,
        jobId,
        volumeName,
        limits: toRunnerLimits(policy),
      }) as unknown as {
        User: string;
        Labels: Record<string, string>;
        HostConfig: {
          ReadonlyRootfs: boolean;
          CapDrop: string[];
          NetworkMode: string;
          Binds: string[];
          Mounts: Array<{ Target: string; ReadOnly: boolean }>;
        };
        NetworkDisabled: boolean;
      };

      expect(body.User).toBe('1000:1000');
      expect(body.HostConfig.ReadonlyRootfs).toBe(true);
      expect(body.HostConfig.CapDrop).toEqual(['ALL']);
      expect(body.HostConfig.NetworkMode).toBe('none');
      expect(body.NetworkDisabled).toBe(true);
      expect(body.HostConfig.Binds).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('docker.sock');

      const workspaceMount =
        body.HostConfig.Mounts.find((mount) => mount.Target === '/workspace');
      expect(workspaceMount?.ReadOnly).toBe(true);

      const id = await createContainer(
        runnerContainerName(jobId),
        body as unknown as Record<string, unknown>,
      );

      try {
        await startContainer(id);
        await waitContainer(id, { timeoutMs: 30_000 });
        const info = await inspectContainerFull(id);
        expect(info.Config.Image).toBe(runnerImageId);
        expect(JSON.stringify(info.HostConfig ?? {})).not.toContain('docker.sock');

        const manifest = parseManifest(
          (await getContainerLogs(id, 65_536)).stdout,
        );
        expect(manifest?.ok).toBe(true);
        expect(manifest?.entries.some((entry) => entry.path === 'a.txt')).toBe(true);
      } finally {
        await removeContainer(id, true).catch(() => {});
      }
    } finally {
      await removeVolume(volumeName, true).catch(() => {});
    }
  });

  it('authority rejects an untrusted stager source before execution; implement stager still carries the tracked-symlink guard', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);
    const repo = mkdtempSync(join(tmpdir(), 'a5-untrusted-'));

    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, 'real.ts'), 'export const real = 1;\n');
      execFileSync('ln', ['-s', 'real.ts', join(repo, 'link.ts')]);
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync(
        'git',
        ['-c', 'user.email=a5@test', '-c', 'user.name=a5', 'commit', '-q', '-m', 'with symlink'],
        { cwd: repo },
      );

      await createVolume(
        volumeName,
        ownershipLabels('workspace', jobId),
      );

      const body = buildStagerCreateBody({
        image: runnerImageId,
        jobId,
        hostPath: repo,
        volumeName,
        rejectTrackedSymlinks: true,
      });

      expect(body.Env).toContain('REJECT_SYMLINKS=1');

      let caught: unknown;
      try {
        await createContainer(
          stagerContainerName(jobId),
          body as unknown as Record<string, unknown>,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(String((caught as Error).message))
        .toContain('host bind must equal an exact trusted configured root');
    } finally {
      await removeVolume(volumeName, true).catch(() => {});
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('A4 regression: a READ-ONLY workspace mount rejects writes (read-only profiles unaffected)', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);

    await seedWorkspace(jobId, volumeName, { 'f.txt': 'ORIGINAL' });

    try {
      const result = await runWorkspaceCommand(
        jobId,
        volumeName,
        'echo MOD > /workspace/f.txt 2>&1 || true; echo NEW > /workspace/n.txt 2>&1 || true; cat /workspace/f.txt; ls /workspace',
        true,
      );

      expect(result.statusCode).toBe(0);
      expect(result.stdout).toContain('ORIGINAL');
      expect(result.stdout).not.toContain('MOD');
      expect(result.stdout).not.toContain('n.txt');
    } finally {
      await removeVolume(volumeName, true).catch(() => {});
    }
  });
}, 240_000);
