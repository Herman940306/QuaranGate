import { beforeEach, describe, expect, it, vi } from 'vitest';

const docker = vi.hoisted(() => ({
  createContainer: vi.fn(),
  createVolume: vi.fn(),
  getContainerLogs: vi.fn(),
  killContainer: vi.fn(),
  listContainersByFilter: vi.fn(),
  listVolumesByFilter: vi.fn(),
  removeContainer: vi.fn(),
  removeVolume: vi.fn(),
  startContainer: vi.fn(),
  waitContainer: vi.fn(),
}));

vi.mock('../../src/executor/docker.js', () => docker);

import {
  AssessmentSourceStager,
  type AssessmentSourceStageReceipt,
  type StagedAssessmentSource,
} from '../../src/executor/securityAssessment/sourceStaging.js';

const ASSESSMENT = `assessment_${'a'.repeat(24)}`;
const EXECUTION = `job_${'b'.repeat(32)}`;
const REVISION = 'c'.repeat(40);
const IMAGE = `sha256:${'d'.repeat(64)}`;
const VOLUME = 'qg-be9-source-owned-volume';

function receipt(): AssessmentSourceStageReceipt {
  return {
    schemaVersion: 'BE9_SOURCE_STAGE_V1',
    mode: 'stage',
    assessmentId: ASSESSMENT,
    projectId: 'project-a',
    sourceRevision: REVISION,
    sourceTree: 'e'.repeat(40),
    fileCount: 1,
    totalBytes: 5,
    manifestBytes: 120,
    manifestDigest: 'f'.repeat(64),
    stagerImageId: IMAGE,
    stagingPolicyVersion: 'BE9_SOURCE_STAGING_POLICY_V1',
    createdAt: '2026-09-27T20:00:00.000Z',
  };
}

function staged(): StagedAssessmentSource & {
  expectedSourceRevision: string;
  stagerImageId: string;
  hostPath: string;
} {
  return {
    assessmentId: ASSESSMENT,
    projectId: 'project-a',
    executionId: EXECUTION,
    sourceVolume: VOLUME,
    receipt: receipt(),
    expectedSourceRevision: REVISION,
    stagerImageId: IMAGE,
    hostPath: '/trusted/project-a',
  };
}

describe('BE9.2 staged-volume recovery authority', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    docker.createVolume.mockResolvedValue(undefined);
    docker.createContainer.mockResolvedValue('owned-container-id');
    docker.startContainer.mockResolvedValue(undefined);
    docker.waitContainer.mockResolvedValue({ statusCode: 0, timedOut: false });
    docker.getContainerLogs.mockResolvedValue({ stdout: `BE9_STAGE_RECEIPT=${JSON.stringify(receipt())}\n`, stderr: '', truncated: false });
    docker.removeContainer.mockResolvedValue(undefined);
    docker.removeVolume.mockResolvedValue(undefined);
    docker.listContainersByFilter.mockResolvedValue([]);
    docker.listVolumesByFilter.mockResolvedValue([]);
  });

  const input = {
    assessmentId: ASSESSMENT, executionId: EXECUTION,
    projectId: 'project-a', expectedSourceRevision: REVISION,
    stagerImageId: IMAGE, hostPath: '/trusted/project-a',
  };

  it('denies probe success when its allocated volume cannot be removed', async () => {
    docker.removeVolume.mockRejectedValue(new Error('private Docker metadata'));
    await expect(new AssessmentSourceStager().probe(input)).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
  });

  it('denies probe success when its stager container cannot be removed', async () => {
    docker.removeContainer.mockRejectedValue(new Error('private Docker metadata'));
    await expect(new AssessmentSourceStager().probe(input)).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    expect(docker.removeContainer).toHaveBeenCalledTimes(1);
    expect(docker.removeContainer).toHaveBeenCalledWith('owned-container-id', true);
  });

  it('denies stage success when the stager container cannot be removed, even before a handle returns', async () => {
    docker.removeContainer.mockRejectedValue(new Error('private Docker metadata'));
    await expect(new AssessmentSourceStager().stage(input)).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    expect(docker.removeVolume).toHaveBeenCalledTimes(1);
  });

  it('denies stage success when failed staging also leaves its volume unremoved', async () => {
    docker.waitContainer.mockResolvedValue({ statusCode: 1, timedOut: false });
    docker.removeVolume.mockRejectedValue(new Error('private Docker metadata'));
    await expect(new AssessmentSourceStager().stage(input)).rejects.toMatchObject({
      code: 'DOCKER_UNAVAILABLE', primaryCode: 'PRECONDITION_FAILED',
      message: 'assessment source resource cleanup could not be proven',
    });
  });

  it('preserves the source rejection when both removals are proven', async () => {
    docker.waitContainer.mockResolvedValue({ statusCode: 1, timedOut: false });
    await expect(new AssessmentSourceStager().stage(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(docker.removeContainer).toHaveBeenCalledTimes(1);
    expect(docker.removeVolume).toHaveBeenCalledTimes(1);
  });

  it('treats ambiguous container creation as uncertain without removing by guessed name', async () => {
    docker.createContainer.mockRejectedValue(new Error('private Docker metadata'));
    await expect(new AssessmentSourceStager().stage(input)).rejects.toMatchObject({
      code: 'DOCKER_UNAVAILABLE', message: 'assessment source resource cleanup could not be proven',
    });
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.removeVolume).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the durable volume is missing', async () => {
    docker.listVolumesByFilter.mockResolvedValue([]);
    await expect(new AssessmentSourceStager().recover(staged()))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(docker.createVolume).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('reconciles only exact assessment-owned crash resources and verifies absence', async () => {
    const labels = { 'io.quarangate.managed': 'true', 'io.quarangate.resource': 'assessment-source',
      'io.quarangate.assessment': ASSESSMENT, 'io.quarangate.job': EXECUTION };
    docker.listVolumesByFilter.mockResolvedValueOnce([{ Name: VOLUME, Labels: labels }]).mockResolvedValueOnce([]);
    await new AssessmentSourceStager().reconcileOrphan(ASSESSMENT, EXECUTION);
    expect(docker.removeVolume).toHaveBeenCalledWith(VOLUME, true, {
      assessmentId: ASSESSMENT, executionId: EXECUTION,
    });
    expect(docker.listVolumesByFilter).toHaveBeenCalledWith({ label: [
      'io.quarangate.managed=true', 'io.quarangate.resource=assessment-source',
      `io.quarangate.assessment=${ASSESSMENT}`,
      `io.quarangate.job=${EXECUTION}`,
    ] });
  });

  it('retains uncertainty and never deletes a false-label or ambiguously enumerated resource', async () => {
    docker.listVolumesByFilter.mockResolvedValue([{ Name: VOLUME, Labels: {
      'io.quarangate.managed': 'true', 'io.quarangate.resource': 'assessment-source',
      'io.quarangate.assessment': ASSESSMENT, 'io.quarangate.job': 'foreign',
    } }]);
    await expect(new AssessmentSourceStager().reconcileOrphan(ASSESSMENT, EXECUTION)).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    expect(docker.removeVolume).not.toHaveBeenCalled();
    docker.listVolumesByFilter.mockRejectedValue(new Error('private Docker details'));
    await expect(new AssessmentSourceStager().reconcileOrphan(ASSESSMENT, EXECUTION)).rejects.toMatchObject({
      code: 'DOCKER_UNAVAILABLE', message: 'assessment source resource cleanup could not be proven',
    });
  });

  it('removes an exact orphan stager before its source volume', async () => {
    const labels = { 'io.quarangate.managed': 'true', 'io.quarangate.resource': 'assessment-stager',
      'io.quarangate.assessment': ASSESSMENT, 'io.quarangate.job': EXECUTION };
    const id = 'f'.repeat(64);
    docker.listContainersByFilter.mockResolvedValueOnce([{ Id: id, Labels: labels }]).mockResolvedValueOnce([]);
    await new AssessmentSourceStager().reconcileOrphan(ASSESSMENT, EXECUTION);
    expect(docker.removeContainer).toHaveBeenCalledWith(id, true);
    expect(docker.listContainersByFilter).toHaveBeenCalledWith({ label: [
      'io.quarangate.managed=true', 'io.quarangate.resource=assessment-stager',
      `io.quarangate.assessment=${ASSESSMENT}`,
      `io.quarangate.job=${EXECUTION}`,
    ] });
  });

  it('does not remove an orphan volume when container enumeration fails', async () => {
    docker.listContainersByFilter.mockRejectedValue(new Error('private daemon detail'));
    await expect(new AssessmentSourceStager().reconcileOrphan(ASSESSMENT, EXECUTION))
      .rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    expect(docker.removeVolume).not.toHaveBeenCalled();
  });

  it('retains uncertainty after deletion failure or ambiguous post-delete enumeration', async () => {
    const labels = { 'io.quarangate.managed': 'true', 'io.quarangate.resource': 'assessment-source',
      'io.quarangate.assessment': ASSESSMENT, 'io.quarangate.job': EXECUTION };
    docker.listVolumesByFilter.mockResolvedValue([{ Name: VOLUME, Labels: labels }]);
    docker.removeVolume.mockRejectedValueOnce(new Error('private daemon detail'));
    await expect(new AssessmentSourceStager().reconcileOrphan(ASSESSMENT, EXECUTION))
      .rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    docker.removeVolume.mockResolvedValue(undefined);
    await expect(new AssessmentSourceStager().reconcileOrphan(ASSESSMENT, EXECUTION))
      .rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
  });

  it('fails closed when volume resolution is ambiguous', async () => {
    const volume = { Name: VOLUME, Labels: {} };
    docker.listVolumesByFilter.mockResolvedValue([volume, volume]);
    await expect(new AssessmentSourceStager().recover(staged()))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(docker.createVolume).not.toHaveBeenCalled();
  });

  it.each([
    ['managed marker', { 'io.quarangate.managed': 'false' }],
    ['resource class', {
      'io.quarangate.managed': 'true',
      'io.quarangate.resource': 'agent-workspace',
      'io.quarangate.job': EXECUTION,
      'io.quarangate.assessment': ASSESSMENT,
    }],
    ['execution identity', {
      'io.quarangate.managed': 'true',
      'io.quarangate.resource': 'assessment-source',
      'io.quarangate.job': `job_${'1'.repeat(32)}`,
      'io.quarangate.assessment': ASSESSMENT,
    }],
    ['assessment identity', {
      'io.quarangate.managed': 'true',
      'io.quarangate.resource': 'assessment-source',
      'io.quarangate.job': EXECUTION,
      'io.quarangate.assessment': `assessment_${'2'.repeat(24)}`,
    }],
  ])('does not adopt a foreign volume with wrong %s', async (_name, labels) => {
    docker.listVolumesByFilter.mockResolvedValue([{ Name: VOLUME, Labels: labels }]);
    await expect(new AssessmentSourceStager().recover(staged()))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(docker.createVolume).not.toHaveBeenCalled();
  });
});
