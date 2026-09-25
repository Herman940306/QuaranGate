/**
 * Hardened Docker-authority integration contract.
 *
 * This test intentionally exercises only current production helpers and
 * current io.quarangate ownership. It does not weaken broker policy and does
 * not use legacy ownership for newly-created resources.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createNetwork,
  removeNetwork,
  removeVolume,
  createVolume,
  createContainer,
  removeContainer,
  inspectContainerFull,
  inspectImage,
} from '../../src/executor/docker.js';

import {
  SANDBOX_LABEL_NS,
  LABEL_MANAGED,
  LABEL_RESOURCE,
  LABEL_JOB,
  ownershipLabels,
  workspaceVolumeName,
  runnerContainerName,
  buildRunnerCreateBody,
  toRunnerLimits,
} from '../../src/executor/agents/sandboxSpec.js';

import {
  buildTar,
  populateVolume,
} from '../../src/executor/agents/runnerAssets.js';

import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE_TAG = 'qg-itest-hardened-authority:a4-current';

const policy: AgentResourcePolicy = {
  id: 'economy',
  modelClass: 'fast',
  maxRuntimeMs: 60_000,
  maxCpuMillicores: 1000,
  maxMemoryBytes: 268_435_456,
  maxPids: 64,
  maxOutputBytes: 65_536,
  maxEvidenceBytes: 10_485_760,
  networkPolicy: 'deny',
  retentionClass: 'ephemeral',
};

const createdContainers: string[] = [];
const createdVolumes: string[] = [];
const createdNetworks: string[] = [];

const newJobId = (): string =>
  `job_${randomBytes(16).toString('hex')}`;

const currentLabels = (
  resource: string,
  jobId: string,
): Record<string, string> => ({
  [LABEL_MANAGED]: 'true',
  [LABEL_RESOURCE]: resource,
  [LABEL_JOB]: jobId,
});

const networkBase = (jobId: string): string =>
  `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-net-${jobId}`;

let imageId = '';

describe('hardened Docker-authority creation contract', () => {
  beforeAll(async () => {
    execFileSync(
      'docker',
      [
        'build',
        '--pull=false',
        '-q',
        '-t',
        IMAGE_TAG,
        '-f',
        join(REPO_ROOT, 'runner', 'Dockerfile'),
        join(REPO_ROOT, 'runner'),
      ],
      { stdio: 'pipe' },
    );

    imageId = (await inspectImage(IMAGE_TAG)).Id;
    expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 120_000);

  afterEach(async () => {
    while (createdContainers.length) {
      const id = createdContainers.pop()!;
      await removeContainer(id, true).catch(() => {});
    }

    while (createdNetworks.length) {
      const name = createdNetworks.pop()!;
      await removeNetwork(name).catch(() => {});
    }

    while (createdVolumes.length) {
      const name = createdVolumes.pop()!;
      await removeVolume(name, true).catch(() => {});
    }
  });

  it('accepts the production hardened runner body with immutable image identity', async () => {
    const jobId = newJobId();
    const volumeName = workspaceVolumeName(jobId);

    await createVolume(
      volumeName,
      ownershipLabels('workspace', jobId),
    );
    createdVolumes.push(volumeName);

    const body = buildRunnerCreateBody({
      image: imageId,
      jobId,
      volumeName,
      limits: toRunnerLimits(policy),
      networkMode: 'none',
      readRelPath: 'README.md',
    });

    const id = await createContainer(
      runnerContainerName(jobId),
      body as unknown as Record<string, unknown>,
    );
    createdContainers.push(id);

    const info = await inspectContainerFull(id);

    expect(info.Config.Image).toBe(imageId);
    expect(info.Config.Labels[LABEL_MANAGED]).toBe('true');
    expect(info.Config.Labels[LABEL_RESOURCE]).toBe('runner');
    expect(info.Config.Labels[LABEL_JOB]).toBe(jobId);
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.CapDrop).toEqual(['ALL']);
    expect(info.HostConfig.NetworkMode).toBe('none');
  });

  it('accepts production volume-population shape with current ownership', async () => {
    const jobId = newJobId();
    const volumeName =
      `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-home-${jobId}`;

    const tar = await buildTar({
      files: [{
        name: 'contract.txt',
        content: Buffer.from('current-authority-contract\n', 'utf8'),
      }],
    });

    await populateVolume({
      volumeName,
      labels: currentLabels('home', jobId),
      helperImage: imageId,
      mountPath: '/home/runner',
      tar,
    });

    createdVolumes.push(volumeName);
  });

  it('accepts only current canonical job-scoped network names', async () => {
    const jobId = newJobId();
    const internal = networkBase(jobId);
    const external = `${internal}-ext`;
    const labels = currentLabels('net', jobId);

    await createNetwork(internal, {
      internal: true,
      labels,
    });
    createdNetworks.push(internal);

    await createNetwork(external, {
      internal: false,
      labels,
    });
    createdNetworks.push(external);
  });
});
