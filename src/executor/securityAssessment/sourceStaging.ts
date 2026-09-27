import { randomBytes } from 'node:crypto';
import { BridgeError } from '../../shared/errors.js';
import {
  SECURITY_ASSESSMENT_ID_PATTERN,
  SECURITY_SOURCE_REVISION_PATTERN,
} from '../../shared/securityAssessment.js';
import {
  ASSESSMENT_STAGER_SCRIPT,
  BE9_SOURCE_STAGING_POLICY_VERSION,
} from '../../shared/securityAssessmentStaging.js';
import {
  createContainer,
  createVolume,
  getContainerLogs,
  killContainer,
  listVolumesByFilter,
  removeContainer,
  removeVolume,
  startContainer,
  waitContainer,
} from '../docker.js';

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECEIPT_PREFIX = 'BE9_STAGE_RECEIPT=';
const STAGE_TIMEOUT_MS = 120_000;
const STAGE_LOG_BYTES = 64 * 1024;

export interface AssessmentSourceStageReceipt {
  schemaVersion: 'BE9_SOURCE_STAGE_V1';
  mode: 'stage' | 'verify';
  assessmentId: string;
  projectId: string;
  sourceRevision: string;
  sourceTree: string;
  fileCount: number;
  totalBytes: number;
  manifestBytes: number;
  manifestDigest: string;
  stagerImageId: string;
  stagingPolicyVersion: typeof BE9_SOURCE_STAGING_POLICY_VERSION;
  createdAt: string;
}

export interface StagedAssessmentSource {
  assessmentId: string;
  projectId: string;
  executionId: string;
  sourceVolume: string;
  receipt: AssessmentSourceStageReceipt;
}

function assessmentLabels(
  resource: 'assessment-stager' | 'assessment-source',
  assessmentId: string,
  executionId: string,
): Record<string, string> {
  return {
    'io.quarangate.managed': 'true',
    'io.quarangate.resource': resource,
    'io.quarangate.job': executionId,
    'io.quarangate.assessment': assessmentId,
  };
}

function assertStageInput(input: {
  assessmentId: string;
  projectId: string;
  expectedSourceRevision: string;
  stagerImageId: string;
  hostPath: string;
}): void {
  if (!SECURITY_ASSESSMENT_ID_PATTERN.test(input.assessmentId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment id for source staging', 400);
  }
  if (!PROJECT_ID.test(input.projectId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid project id for source staging', 400);
  }
  if (!SECURITY_SOURCE_REVISION_PATTERN.test(input.expectedSourceRevision)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid expected source revision for staging', 400);
  }
  if (!IMAGE_ID.test(input.stagerImageId)) {
    throw new BridgeError('PRECONDITION_FAILED', 'assessment stager image must be an immutable image ID', 503);
  }
  if (!input.hostPath.startsWith('/') || input.hostPath.includes('\0')) {
    throw new BridgeError('PRECONDITION_FAILED', 'registered project path is invalid', 503);
  }
}

export function buildAssessmentStagerCreateBody(input: {
  assessmentId: string;
  projectId: string;
  executionId: string;
  expectedSourceRevision: string;
  expectedManifestDigest?: string;
  stagerImageId: string;
  hostPath: string;
  sourceVolume: string;
  mode: 'stage' | 'verify';
}): Record<string, unknown> {
  assertStageInput(input);
  if (!/^job_[0-9a-f]{32}$/.test(input.executionId)) {
    throw new BridgeError('INTERNAL', 'invalid assessment execution id', 500);
  }
  if (input.mode === 'verify') {
    if (!input.expectedManifestDigest || !SHA256.test(input.expectedManifestDigest)) {
      throw new BridgeError('INTERNAL', 'assessment verification requires frozen manifest digest', 500);
    }
  } else if (input.expectedManifestDigest !== undefined) {
    throw new BridgeError('INTERNAL', 'assessment staging may not accept an expected manifest digest', 500);
  }

  const env = [
    'HOME=/tmp',
    'GIT_OPTIONAL_LOCKS=0',
    `EXPECTED_SOURCE_REVISION=${input.expectedSourceRevision}`,
    `ASSESSMENT_STAGE_MODE=${input.mode}`,
    `ASSESSMENT_ID=${input.assessmentId}`,
    `PROJECT_ID=${input.projectId}`,
    `STAGER_IMAGE_ID=${input.stagerImageId}`,
    `STAGING_POLICY_VERSION=${BE9_SOURCE_STAGING_POLICY_VERSION}`,
  ];
  if (input.expectedManifestDigest) {
    env.push(`EXPECTED_MANIFEST_DIGEST=${input.expectedManifestDigest}`);
  }

  return {
    Image: input.stagerImageId,
    User: '1000:1000',
    WorkingDir: '/tmp',
    Cmd: ['node', '-e', ASSESSMENT_STAGER_SCRIPT],
    Env: env,
    Labels: assessmentLabels('assessment-stager', input.assessmentId, input.executionId),
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
      VolumesFrom: [],
      Links: [],
      ExtraHosts: [],
      Dns: [],
      DnsSearch: [],
      DnsOptions: [],
      PortBindings: {},
      PublishAllPorts: false,
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      UsernsMode: '',
      NetworkMode: 'none',
      Binds: [`${input.hostPath}:/src:ro`],
      Mounts: [{
        Type: 'volume',
        Source: input.sourceVolume,
        Target: '/workspace',
        ReadOnly: input.mode === 'verify',
      }],
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m' },
    },
  };
}

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function parseAssessmentSourceStageReceipt(
  logs: { stdout: string; stderr: string; truncated: boolean },
): AssessmentSourceStageReceipt {
  if (logs.truncated) {
    throw new BridgeError('PRECONDITION_FAILED', 'assessment staging logs exceeded receipt bound', 412);
  }
  const lines = logs.stdout.split('\n').filter((line) => line.startsWith(RECEIPT_PREFIX));
  if (lines.length !== 1) {
    throw new BridgeError('PRECONDITION_FAILED', 'assessment staging receipt missing or ambiguous', 412);
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0]!.slice(RECEIPT_PREFIX.length));
  } catch {
    throw new BridgeError('PRECONDITION_FAILED', 'assessment staging receipt is malformed', 412);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('PRECONDITION_FAILED', 'assessment staging receipt is invalid', 412);
  }
  const r = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion', 'mode', 'assessmentId', 'projectId',
    'sourceRevision', 'sourceTree', 'fileCount', 'totalBytes',
    'manifestBytes', 'manifestDigest', 'stagerImageId',
    'stagingPolicyVersion', 'createdAt',
  ]);
  if (Object.keys(r).some((key) => !allowed.has(key)) || Object.keys(r).length !== allowed.size) {
    throw new BridgeError('PRECONDITION_FAILED', 'assessment staging receipt has unknown or missing fields', 412);
  }
  if (
    r.schemaVersion !== 'BE9_SOURCE_STAGE_V1'
    || !['stage', 'verify'].includes(String(r.mode))
    || !SECURITY_ASSESSMENT_ID_PATTERN.test(String(r.assessmentId))
    || !PROJECT_ID.test(String(r.projectId))
    || !SECURITY_SOURCE_REVISION_PATTERN.test(String(r.sourceRevision))
    || !SECURITY_SOURCE_REVISION_PATTERN.test(String(r.sourceTree))
    || !SHA256.test(String(r.manifestDigest))
    || !IMAGE_ID.test(String(r.stagerImageId))
    || r.stagingPolicyVersion !== BE9_SOURCE_STAGING_POLICY_VERSION
    || !validIso(r.createdAt)
    || !Number.isSafeInteger(r.fileCount) || Number(r.fileCount) < 0
    || !Number.isSafeInteger(r.totalBytes) || Number(r.totalBytes) < 0
    || !Number.isSafeInteger(r.manifestBytes) || Number(r.manifestBytes) < 2
  ) {
    throw new BridgeError('PRECONDITION_FAILED', 'assessment staging receipt failed runtime validation', 412);
  }
  return r as unknown as AssessmentSourceStageReceipt;
}

async function runStager(input: {
  assessmentId: string;
  projectId: string;
  executionId: string;
  expectedSourceRevision: string;
  expectedManifestDigest?: string;
  stagerImageId: string;
  hostPath: string;
  sourceVolume: string;
  mode: 'stage' | 'verify';
}): Promise<AssessmentSourceStageReceipt> {
  const suffix = randomBytes(6).toString('hex');
  const name = `qg-be9-stager-${input.assessmentId.slice('assessment_'.length)}-${suffix}`;
  let containerId: string | undefined;
  try {
    const body = buildAssessmentStagerCreateBody(input);
    containerId = await createContainer(name, body);
    await startContainer(containerId);
    const waited = await waitContainer(containerId, { timeoutMs: STAGE_TIMEOUT_MS });
    if (waited.timedOut) {
      await killContainer(containerId).catch(() => {});
      throw new BridgeError('PRECONDITION_FAILED', 'assessment source staging timed out', 412);
    }
    const logs = await getContainerLogs(containerId, STAGE_LOG_BYTES);
    if (waited.statusCode !== 0) {
      throw new BridgeError(
        'PRECONDITION_FAILED',
        `assessment source staging rejected source (exit ${String(waited.statusCode)}): ${logs.stderr.slice(0, 512)}`,
        412,
      );
    }
    const receipt = parseAssessmentSourceStageReceipt(logs);
    if (
      receipt.mode !== input.mode
      || receipt.assessmentId !== input.assessmentId
      || receipt.projectId !== input.projectId
      || receipt.sourceRevision !== input.expectedSourceRevision
      || receipt.stagerImageId !== input.stagerImageId
      || receipt.stagingPolicyVersion !== BE9_SOURCE_STAGING_POLICY_VERSION
      || (input.expectedManifestDigest !== undefined
        && receipt.manifestDigest !== input.expectedManifestDigest)
    ) {
      throw new BridgeError('PRECONDITION_FAILED', 'assessment staging receipt binding mismatch', 412);
    }
    return receipt;
  } finally {
    if (containerId) await removeContainer(containerId, true).catch(() => {});
    await removeContainer(name, true).catch(() => {});
  }
}

export class AssessmentSourceStager {
  async probe(input: {
    assessmentId: string;
    projectId: string;
    expectedSourceRevision: string;
    stagerImageId: string;
    hostPath: string;
  }): Promise<AssessmentSourceStageReceipt> {
    assertStageInput(input);
    const executionId = `job_${randomBytes(16).toString('hex')}`;
    const sourceVolume = `qg-be9-probe-${input.assessmentId.slice('assessment_'.length)}-${executionId.slice(-12)}`;
    await createVolume(
      sourceVolume,
      assessmentLabels('assessment-source', input.assessmentId, executionId),
    );
    try {
      return await runStager({
        ...input,
        executionId,
        sourceVolume,
        mode: 'stage',
      });
    } finally {
      await removeVolume(sourceVolume, true).catch(() => {});
    }
  }

  async stage(input: {
    assessmentId: string;
    projectId: string;
    expectedSourceRevision: string;
    stagerImageId: string;
    hostPath: string;
  }): Promise<StagedAssessmentSource> {
    assertStageInput(input);
    const executionId = `job_${randomBytes(16).toString('hex')}`;
    const sourceVolume = `qg-be9-source-${input.assessmentId.slice('assessment_'.length)}-${executionId.slice(-12)}`;
    const labels = assessmentLabels('assessment-source', input.assessmentId, executionId);
    await createVolume(sourceVolume, labels);
    try {
      const receipt = await runStager({
        ...input,
        executionId,
        sourceVolume,
        mode: 'stage',
      });
      return {
        assessmentId: input.assessmentId,
        projectId: input.projectId,
        executionId,
        sourceVolume,
        receipt,
      };
    } catch (error) {
      await removeVolume(sourceVolume, true).catch(() => {});
      throw error;
    }
  }

  async revalidateBeforeRun(input: StagedAssessmentSource & {
    expectedSourceRevision: string;
    stagerImageId: string;
    hostPath: string;
  }): Promise<AssessmentSourceStageReceipt> {
    if (
      input.receipt.assessmentId !== input.assessmentId
      || input.receipt.projectId !== input.projectId
      || input.receipt.sourceRevision !== input.expectedSourceRevision
      || input.receipt.stagerImageId !== input.stagerImageId
      || input.receipt.stagingPolicyVersion !== BE9_SOURCE_STAGING_POLICY_VERSION
    ) {
      throw new BridgeError('PRECONDITION_FAILED', 'frozen assessment staging receipt binding is invalid', 412);
    }
    const receipt = await runStager({
      assessmentId: input.assessmentId,
      projectId: input.projectId,
      executionId: input.executionId,
      expectedSourceRevision: input.expectedSourceRevision,
      expectedManifestDigest: input.receipt.manifestDigest,
      stagerImageId: input.stagerImageId,
      hostPath: input.hostPath,
      sourceVolume: input.sourceVolume,
      mode: 'verify',
    });
    if (
      receipt.sourceRevision !== input.receipt.sourceRevision
      || receipt.sourceTree !== input.receipt.sourceTree
      || receipt.manifestDigest !== input.receipt.manifestDigest
      || receipt.fileCount !== input.receipt.fileCount
      || receipt.totalBytes !== input.receipt.totalBytes
      || receipt.manifestBytes !== input.receipt.manifestBytes
    ) {
      throw new BridgeError('PRECONDITION_FAILED', 'assessment source changed after staging', 412);
    }
    return receipt;
  }

  async recover(input: StagedAssessmentSource & {
    expectedSourceRevision: string;
    stagerImageId: string;
    hostPath: string;
  }): Promise<AssessmentSourceStageReceipt> {
    const volumes = await listVolumesByFilter({ name: [input.sourceVolume] });
    if (volumes.length !== 1 || volumes[0]!.Name !== input.sourceVolume) {
      throw new BridgeError('PRECONDITION_FAILED', 'prepared assessment source volume is missing or ambiguous', 412);
    }
    const labels = volumes[0]!.Labels ?? {};
    if (
      labels['io.quarangate.managed'] !== 'true'
      || labels['io.quarangate.resource'] !== 'assessment-source'
      || labels['io.quarangate.job'] !== input.executionId
      || labels['io.quarangate.assessment'] !== input.assessmentId
    ) {
      throw new BridgeError('PRECONDITION_FAILED', 'prepared assessment source volume ownership is not exact', 412);
    }
    return this.revalidateBeforeRun(input);
  }

  async remove(staged: StagedAssessmentSource): Promise<void> {
    await removeVolume(staged.sourceVolume, true);
  }
}
