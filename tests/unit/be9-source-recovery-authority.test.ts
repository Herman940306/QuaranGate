import { beforeEach, describe, expect, it, vi } from 'vitest';

const docker = vi.hoisted(() => ({
  createContainer: vi.fn(),
  createVolume: vi.fn(),
  getContainerLogs: vi.fn(),
  killContainer: vi.fn(),
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
  beforeEach(() => vi.clearAllMocks());

  it('fails closed when the durable volume is missing', async () => {
    docker.listVolumesByFilter.mockResolvedValue([]);
    await expect(new AssessmentSourceStager().recover(staged()))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(docker.createVolume).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
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
