import { describe, expect, it } from 'vitest';
import {
  managedIdentity,
  validateManagedContainerCreate,
  validateManagedExecForIdentity,
  validateManagedNetworkAttachment,
  validateManagedNetworkCreate,
  validateManagedVolumeAttachment,
  validateManagedVolumeCreate,
  type ManagedVolumeMount,
} from '../../src/docker-authority/policy.js';
import { buildAssessmentStagerCreateBody } from '../../src/executor/securityAssessment/sourceStaging.js';

const JOB = `job_${'a'.repeat(32)}`;
const OTHER_JOB = `job_${'b'.repeat(32)}`;
const ASSESSMENT = `assessment_${'c'.repeat(24)}`;
const OTHER_ASSESSMENT = `assessment_${'d'.repeat(24)}`;
const IMAGE = `sha256:${'e'.repeat(64)}`;

function labels(resource: string, assessment = ASSESSMENT, job = JOB) {
  return {
    'io.quarangate.managed': 'true',
    'io.quarangate.resource': resource,
    'io.quarangate.job': job,
    'io.quarangate.assessment': assessment,
  };
}

function mount(Source: string, Target: string, ReadOnly: boolean): ManagedVolumeMount {
  return { Type: 'volume', Source, Target, ReadOnly };
}

function body(resource: 'assessment-stager' | 'assessment-runner' | 'assessment-evidence') {
  return {
    Image: IMAGE,
    User: '1000:1000',
    Labels: labels(resource),
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
      DeviceRequests: [],
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      UsernsMode: '',
      NetworkMode: 'none',
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 32,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
      Mounts: [],
      Binds: [],
    },
  };
}

describe('BE9.2 assessment-specific Docker Authority policy', () => {
  it('requires dual scheduler-execution and assessment ownership labels', () => {
    const missingAssessment = body('assessment-runner') as any;
    delete missingAssessment.Labels['io.quarangate.assessment'];
    expect(() => validateManagedContainerCreate(missingAssessment, ['/trusted/project'])).toThrow();

    const missingJob = body('assessment-runner') as any;
    delete missingJob.Labels['io.quarangate.job'];
    expect(() => validateManagedContainerCreate(missingJob, ['/trusted/project'])).toThrow();
  });

  it('allows only assessment-stager to see the exact trusted host root and source volume RW', () => {
    const stager = buildAssessmentStagerCreateBody({
      assessmentId: ASSESSMENT,
      projectId: 'project-a',
      executionId: JOB,
      expectedSourceRevision: 'f'.repeat(40),
      stagerImageId: IMAGE,
      hostPath: '/trusted/project',
      sourceVolume: 'source-volume',
      mode: 'stage',
    }) as any;
    expect(() => validateManagedContainerCreate(stager, ['/trusted/project'])).not.toThrow();

    const verify = buildAssessmentStagerCreateBody({
      assessmentId: ASSESSMENT,
      projectId: 'project-a',
      executionId: JOB,
      expectedSourceRevision: 'f'.repeat(40),
      expectedManifestDigest: '1'.repeat(64),
      stagerImageId: IMAGE,
      hostPath: '/trusted/project',
      sourceVolume: 'source-volume',
      mode: 'verify',
    }) as any;
    expect(verify.HostConfig.Mounts[0].ReadOnly).toBe(true);
    expect(() => validateManagedContainerCreate(verify, ['/trusted/project'])).not.toThrow();

    const verifyWritable = structuredClone(verify);
    verifyWritable.HostConfig.Mounts[0].ReadOnly = false;
    expect(() => validateManagedContainerCreate(verifyWritable, ['/trusted/project'])).toThrow();

    const descendant = structuredClone(stager);
    descendant.HostConfig.Binds = ['/trusted/project/sub:/src:ro'];
    expect(() => validateManagedContainerCreate(descendant, ['/trusted/project'])).toThrow();

    const tampered = structuredClone(stager);
    tampered.Cmd = ['sh', '-c', 'git archive HEAD'];
    expect(() => validateManagedContainerCreate(tampered, ['/trusted/project'])).toThrow();

    const runner = body('assessment-runner') as any;
    runner.HostConfig.Binds = ['/trusted/project:/src:ro'];
    runner.HostConfig.Mounts = [mount('source-volume', '/workspace', true)];
    expect(() => validateManagedContainerCreate(runner, ['/trusted/project'])).toThrow();
  });

  it('restricts assessment-runner to one read-only source volume with no secret/home/control/evidence mounts', () => {
    const runner = body('assessment-runner') as any;
    runner.HostConfig.Mounts = [mount('source-volume', '/workspace', true)];
    expect(() => validateManagedContainerCreate(runner)).not.toThrow();

    for (const forbidden of [
      mount('source-volume', '/workspace', false),
      mount('secret-volume', '/run/secrets', true),
      mount('home-volume', '/home/runner', false),
      mount('control-volume', '/run/control', true),
      mount('evidence-volume', '/evidence', false),
    ]) {
      const bad = body('assessment-runner') as any;
      bad.HostConfig.Mounts = [forbidden];
      expect(() => validateManagedContainerCreate(bad)).toThrow();
    }
  });

  it('keeps initial assessment containers network-none and denies generic Docker exec', () => {
    const runner = body('assessment-runner') as any;
    runner.HostConfig.Mounts = [mount('source-volume', '/workspace', true)];
    runner.HostConfig.NetworkMode = `io-quarangate-net-${JOB}`;
    expect(() => validateManagedContainerCreate(runner)).toThrow();

    const identity = managedIdentity(labels('assessment-runner'));
    expect(() => validateManagedExecForIdentity(identity, {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ['id'],
      User: '1000:1000',
    })).toThrow();
  });

  it('allows only matching assessment source relationships and rejects generic runner inheritance', () => {
    const stager = managedIdentity(labels('assessment-stager'));
    const runner = managedIdentity(labels('assessment-runner'));
    const source = managedIdentity(labels('assessment-source'));

    expect(() => validateManagedVolumeAttachment(stager, source, mount('src', '/workspace', false))).not.toThrow();
    expect(() => validateManagedVolumeAttachment(runner, source, mount('src', '/workspace', true))).not.toThrow();

    const otherAssessment = managedIdentity(labels('assessment-source', OTHER_ASSESSMENT));
    expect(() => validateManagedVolumeAttachment(runner, otherAssessment, mount('src', '/workspace', true))).toThrow();

    const otherExecution = managedIdentity(labels('assessment-source', ASSESSMENT, OTHER_JOB));
    expect(() => validateManagedVolumeAttachment(runner, otherExecution, mount('src', '/workspace', true))).toThrow();

    const genericRunner = managedIdentity({
      'io.quarangate.managed': 'true',
      'io.quarangate.resource': 'runner',
      'io.quarangate.job': JOB,
    });
    expect(() => validateManagedVolumeAttachment(genericRunner, source, mount('src', '/workspace', true))).toThrow();
  });

  it('keeps scanner runner detached from assessment evidence authority', () => {
    const evidenceHelper = managedIdentity(labels('assessment-evidence'));
    const evidence = managedIdentity(labels('assessment-evidence'));
    const runner = managedIdentity(labels('assessment-runner'));

    expect(() => validateManagedVolumeAttachment(
      evidenceHelper,
      evidence,
      mount('ev', '/evidence', false),
    )).not.toThrow();
    expect(() => validateManagedVolumeAttachment(
      runner,
      evidence,
      mount('ev', '/evidence', false),
    )).toThrow();
  });

  it('permits only assessment source/evidence volume ownership and future-safe internal net shape', () => {
    expect(() => validateManagedVolumeCreate('be9-source', labels('assessment-source'))).not.toThrow();
    expect(() => validateManagedVolumeCreate('be9-evidence', labels('assessment-evidence'))).not.toThrow();
    expect(() => validateManagedVolumeCreate('be9-runner', labels('assessment-runner'))).toThrow();

    const netLabels = labels('assessment-net');
    expect(() => validateManagedNetworkCreate(
      `io-quarangate-assessment-net-${ASSESSMENT}`,
      true,
      netLabels,
    )).not.toThrow();
    expect(() => validateManagedNetworkCreate(
      `io-quarangate-assessment-net-${ASSESSMENT}`,
      false,
      netLabels,
    )).toThrow();

    expect(() => validateManagedNetworkAttachment(
      managedIdentity(netLabels),
      managedIdentity(labels('assessment-runner')),
    )).toThrow();
  });
});
