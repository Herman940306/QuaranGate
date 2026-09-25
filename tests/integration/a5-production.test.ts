/**
 * A5 production path — runner-internal ACP driver with a WRITABLE workspace,
 * driven purely through the Docker Engine API (create → start → wait → logs),
 * NO interactive attach, NO host project bind in the runner, NO paid provider.
 *
 * Current-contract guarantees:
 *   - job resources use current io.quarangate ownership + canonical names,
 *   - authority-managed containers receive immutable image IDs,
 *   - disposable seed fixtures are baked into the test runner image and copied
 *     into each fresh job-owned volume by Docker's standard empty-volume copy-up,
 *   - the control archive carries runnerMain + AcpDriver + all runtime shared
 *     dependencies required by the accepted ACP bundle contract,
 *   - the runner is non-root, read-only rootfs, CapDrop ALL,
 *     no-new-privileges, network none, writable workspace + read-only control,
 *   - deterministic change detection proves the mock's in-process write path.
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
  buildManifestCreateBody,
  buildRunnerCreateBody as buildSandboxRunnerCreateBody,
  toRunnerLimits,
} from '../../src/executor/agents/sandboxSpec.js';

import {
  buildTar,
  populateVolume,
} from '../../src/executor/agents/runnerAssets.js';

import {
  parseRunnerResult,
  bridgeAgentConfig,
  controlVolumeName,
} from '../../src/executor/agents/kiroBackend.js';

import {
  parseManifest,
  diffManifests,
} from '../../src/executor/agents/changeDetection.js';

import {
  ACP_IMPL_AGENT_NAME_PATTERN,
  resolveProfileCapability,
} from '../../src/executor/agents/acpDriver.js';

import { canTransitionAgentJob } from '../../src/shared/agents.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO_ROOT, 'dist');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures');
const RUNNER_TAG = 'qg-itest-kiro-runner:a5-prod-current';
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

  const body = buildSandboxRunnerCreateBody({
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
): Promise<void> {
  const body = buildSandboxRunnerCreateBody({
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

  body.Cmd = ['sh', '-c', command];
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

async function seedWorkspace(jobId: string, volumeName: string): Promise<void> {
  await initializeWorkspace(jobId, volumeName);
  await runWorkspaceCommand(
    jobId,
    volumeName,
    [
      "printf 'export const target = 1;\\n' > /workspace/target.ts",
      "printf 'export const keep = true;\\n' > /workspace/keep.ts",
    ].join('; '),
  );
}

async function makeControlVolume(
  jobId: string,
  control: Record<string, unknown>,
): Promise<string> {
  const volumeName = controlVolumeName(jobId);
  const tar = await buildTar({
    dirs: [
      { name: 'executor/' },
      { name: 'executor/agents/' },
      { name: 'shared/' },
    ],
    files: [
      {
        name: 'executor/agents/runnerMain.js',
        content: readFileSync(join(DIST, 'executor/agents/runnerMain.js')),
        mode: 0o500,
      },
      {
        name: 'executor/agents/acpDriver.js',
        content: readFileSync(join(DIST, 'executor/agents/acpDriver.js')),
        mode: 0o500,
      },
      {
        name: 'shared/errors.js',
        content: readFileSync(join(DIST, 'shared/errors.js')),
        mode: 0o500,
      },
      {
        name: 'shared/agents.js',
        content: readFileSync(join(DIST, 'shared/agents.js')),
        mode: 0o500,
      },
      {
        name: 'mock-acp-impl-server.mjs',
        content: readFileSync(join(FIXTURES, 'mock-acp-impl-server.mjs')),
        mode: 0o500,
      },
      {
        name: 'control.json',
        content: Buffer.from(JSON.stringify(control), 'utf8'),
        mode: 0o400,
      },
    ],
  });

  await populateVolume({
    volumeName,
    labels: ownershipLabels('control', jobId),
    helperImage: runnerImageId,
    mountPath: '/run/control',
    tar,
  });

  return volumeName;
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
    const manifest = parseManifest(
      (await getContainerLogs(id, 262_144)).stdout,
    );
    expect(manifest).not.toBeNull();
    return manifest!;
  } finally {
    await removeContainer(id, true).catch(() => {});
  }
}

describe('A5 production path — implement write turn via Docker Engine API', () => {
  beforeAll(async () => {
    buildDir = mkdtempSync(join(tmpdir(), 'a5pb-'));
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

  const implControl = (jobId: string) => ({
    agent: 'mcp_impl_' + randomBytes(16).toString('hex'),
    model: 'claude-sonnet-4.5',
    trustTools: resolveProfileCapability('implement').trustTools,
    cwd: '/workspace',
    prompt: 'IMPLEMENT the feature',
    dryRun: false,
    acpCommand: 'node',
    acpPrefixArgs: ['/run/control/mock-acp-impl-server.mjs'],
  });

  it('drives an implement turn that writes files in a WRITABLE workspace; change detection is deterministic; no host bind; no apply', async () => {
    const jobId = newJobId();
    const workspaceVolume = workspaceVolumeName(jobId);

    await seedWorkspace(jobId, workspaceVolume);
    const baseline = await manifestOf(jobId, workspaceVolume);
    const controlVolume = await makeControlVolume(jobId, implControl(jobId));

    const limits = toRunnerLimits(policy);
    const runner = await createContainer(
      runnerContainerName(jobId),
      {
        Image: runnerImageId,
        User: '1000:1000',
        WorkingDir: '/workspace',
        Cmd: [
          'node',
          '/run/control/executor/agents/runnerMain.js',
          '/run/control/control.json',
        ],
        Env: [
          'HOME=/tmp',
          'ACP_MOCK_WORKSPACE=/workspace',
        ],
        Labels: ownershipLabels('runner', jobId),
        NetworkDisabled: true,
        HostConfig: {
          AutoRemove: false,
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: [],
          SecurityOpt: ['no-new-privileges'],
          GroupAdd: [],
          Devices: [],
          Binds: [],
          PidMode: '',
          IpcMode: 'private',
          UTSMode: '',
          UsernsMode: '',
          NetworkMode: 'none',
          Mounts: [
            {
              Type: 'volume',
              Source: workspaceVolume,
              Target: '/workspace',
              ReadOnly: false,
            },
            {
              Type: 'volume',
              Source: controlVolume,
              Target: '/run/control',
              ReadOnly: true,
            },
          ],
          Tmpfs: {
            '/tmp': 'rw,nosuid,nodev,size=16m',
          },
          Memory: limits.memoryBytes,
          MemorySwap: limits.memorySwapBytes,
          NanoCpus: limits.nanoCpus,
          PidsLimit: limits.pidsLimit,
        },
      },
    );

    try {
      await startContainer(runner);
      const waited = await waitContainer(runner, { timeoutMs: 30_000 });
      const logs = await getContainerLogs(runner, 262_144);

      const result = parseRunnerResult(logs.stdout);
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
      expect(result!.stopReason).toBe('end_turn');
      expect(result!.toolCalls.map((tool) => tool.kind).sort())
        .toEqual(['edit', 'read']);
      expect(waited.statusCode).toBe(0);

      const info = await inspectContainerFull(runner);
      expect(info.Config.Image).toBe(runnerImageId);
      expect(info.Config.User).toBe('1000:1000');
      expect(info.HostConfig.ReadonlyRootfs).toBe(true);
      expect(info.HostConfig.Privileged).toBe(false);
      expect(info.HostConfig.CapDrop).toEqual(['ALL']);
      expect(info.HostConfig.NetworkMode).toBe('none');
      expect(info.HostConfig.Binds ?? []).toEqual([]);
      expect(JSON.stringify(info.HostConfig ?? {})).not.toContain('docker.sock');

      // The manifest helper uses the same canonical runner name for this job.
      // Remove the completed implementation runner before creating the post-run
      // manifest helper rather than weakening the authority naming contract.
      await removeContainer(runner, true);

      const post = await manifestOf(jobId, workspaceVolume);
      const diff = diffManifests(baseline, post);

      expect(diff.added).toContain('generated.ts');
      expect(diff.modified).toContain('target.ts');
      expect(diff.changedFiles).not.toContain('keep.ts');
      expect(diff.changedCount).toBeGreaterThanOrEqual(2);

      expect(canTransitionAgentJob('VALIDATING', 'COMPLETED')).toBe(true);
      expect(canTransitionAgentJob('VALIDATING', 'APPLIED')).toBe(false);
      expect(canTransitionAgentJob('COMPLETED', 'APPLIED')).toBe(true);
    } finally {
      await removeContainer(runner, true).catch(() => {});
      await removeVolume(controlVolume, true).catch(() => {});
      await removeVolume(workspaceVolume, true).catch(() => {});
    }
  });

  it('the delivered implement agent config uses canonical write: available in tools, path-scoped, NOT in allowedTools', () => {
    const cfg = bridgeAgentConfig(
      'mcp_impl_' + 'a'.repeat(32),
      { write: true },
    );

    expect(cfg.tools).toEqual(['read', 'grep', 'glob', 'write']);
    expect(cfg.allowedTools).toEqual(['read', 'grep', 'glob']);

    for (const alias of ['write', 'fsWrite', 'fs_write']) {
      expect(cfg.allowedTools as string[]).not.toContain(alias);
    }

    expect((cfg.toolsSettings as any)?.write?.allowedPaths)
      .toEqual(['/workspace']);
    expect((cfg.toolsSettings as any)?.write?.deniedPaths)
      .toEqual(['/home/runner', '/tmp', '/run/secrets', '/run/control']);
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.includeMcpJson).toBe(false);
    expect(ACP_IMPL_AGENT_NAME_PATTERN.test(String(cfg.name))).toBe(true);
  });
}, 240_000);
