import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docker = vi.hoisted(() => ({
  createVolume: vi.fn(),
  removeVolume: vi.fn(),
  createContainer: vi.fn(),
  startContainer: vi.fn(),
  waitContainer: vi.fn(),
  removeContainer: vi.fn(),
  putArchive: vi.fn(),
  listVolumesByFilter: vi.fn(),
  listContainersByFilter: vi.fn(),
}));

vi.mock('../../src/executor/docker.js', () => docker);

import { CredentialManager } from '../../src/executor/agents/credentialManager.js';
import {
  managedIdentity,
  type ManagedVolumeMount,
  validateManagedArchivePath,
  validateManagedContainerCreate,
  validateManagedVolumeAttachment,
} from '../../src/docker-authority/policy.js';

const JOB = `job_${'1'.repeat(32)}`;
const OTHER_JOB = `job_${'2'.repeat(32)}`;
const IMAGE = `sha256:${'a'.repeat(64)}`;
const labels = (resource: string, job = JOB): Record<string, string> => ({
  'io.quarangate.managed': 'true',
  'io.quarangate.resource': resource,
  'io.quarangate.job': job,
});

function secretHelperBody(mounts: ManagedVolumeMount[]) {
  return {
    Image: IMAGE,
    User: '0:0',
    Cmd: ['true'],
    Labels: labels('secret'),
    NetworkDisabled: true,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      Mounts: mounts,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
      Memory: 32 * 1024 * 1024,
      PidsLimit: 8,
    },
  };
}

describe('Docker Authority secret-volume archive path contract', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secret-archive-policy-'));
    keyPath = join(dir, 'synthetic-key');
    writeFileSync(keyPath, 'synthetic-credential-only', { mode: 0o600 });
    vi.clearAllMocks();
    docker.createContainer.mockResolvedValue('synthetic-helper-id');
    docker.createVolume.mockResolvedValue(undefined);
    docker.startContainer.mockResolvedValue(undefined);
    docker.waitContainer.mockResolvedValue({ statusCode: 0, timedOut: false });
    docker.putArchive.mockResolvedValue(undefined);
    docker.removeContainer.mockResolvedValue(undefined);
    docker.removeVolume.mockResolvedValue(undefined);
    docker.listVolumesByFilter.mockResolvedValue([]);
    docker.listContainersByFilter.mockResolvedValue([]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts CredentialManager -> populateVolume -> archiveWriteManaged for the exact /secrets contract', async () => {
    const manager = new CredentialManager({ credentialPath: keyPath, helperImage: IMAGE });
    const volumeName = await manager.provisionSecret(JOB);

    expect(docker.createVolume).toHaveBeenCalledWith(volumeName, labels('secret'));
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(docker.putArchive).toHaveBeenCalledWith('synthetic-helper-id', '/secrets', expect.any(Buffer));

    const body = docker.createContainer.mock.calls[0]![1] as ReturnType<typeof secretHelperBody>;
    const mount = body.HostConfig.Mounts[0]!;
    const helper = validateManagedContainerCreate(body);
    const volume = managedIdentity(docker.createVolume.mock.calls[0]![1]);

    expect(helper).toMatchObject({ resource: 'secret', job: JOB });
    expect(volume).toMatchObject({ resource: 'secret', job: JOB });
    expect(mount).toEqual({ Type: 'volume', Source: volumeName, Target: '/secrets', ReadOnly: false });
    expect(() => validateManagedVolumeAttachment(helper, volume, mount)).not.toThrow();
    expect(() => validateManagedArchivePath(helper, 'write', '/secrets')).not.toThrow();
  });

  it.each(['/run/secrets', '/secret', '/secrets2', '/secrets/../other', '/', '/tmp/arbitrary'])(
    'rejects non-contract or non-canonical archive path %s',
    (archivePath) => {
      const identity = managedIdentity(labels('secret'));
      expect(() => validateManagedArchivePath(identity, 'write', archivePath)).toThrow();
    },
  );

  it('rejects the secret path for a different resource role', () => {
    expect(() => validateManagedArchivePath(managedIdentity(labels('home')), 'write', '/secrets')).toThrow();
  });

  it('rejects cross-job volume attachment', () => {
    const mount = { Type: 'volume', Source: 'secret-volume', Target: '/secrets', ReadOnly: false } as const;
    expect(() => validateManagedVolumeAttachment(
      managedIdentity(labels('secret')),
      managedIdentity(labels('secret', OTHER_JOB)),
      mount,
    )).toThrow();
  });

  it('rejects a secret initializer with no attached volume', () => {
    expect(() => validateManagedContainerCreate(secretHelperBody([]))).toThrow();
  });

  it('rejects a wrong-role volume and cross-resource attachment', () => {
    const mount = { Type: 'volume', Source: 'wrong-volume', Target: '/secrets', ReadOnly: false } as const;
    expect(() => validateManagedVolumeAttachment(
      managedIdentity(labels('secret')),
      managedIdentity(labels('workspace')),
      mount,
    )).toThrow();
  });

  it('rejects unmanaged and malformed ownership labels', () => {
    expect(() => managedIdentity({
      'io.quarangate.resource': 'secret',
      'io.quarangate.job': JOB,
    })).toThrow();
    expect(() => managedIdentity({
      'io.quarangate.managed': 'true',
      'io.quarangate.resource': 'not-a-role',
      'io.quarangate.job': JOB,
    })).toThrow();
  });

  it('rejects contradictory cross-namespace resource ownership', () => {
    expect(() => managedIdentity({
      ...labels('secret'),
      'io.mcp-bridge.managed': 'true',
      'io.mcp-bridge.resource': 'secret',
      'io.mcp-bridge.job': JOB,
    })).toThrow();
  });
});
