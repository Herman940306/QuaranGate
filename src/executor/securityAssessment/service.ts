import { BridgeError } from '../../shared/errors.js';
import {
  executionResourceKey,
  type ExecutionResourceRef,
} from '../../shared/executionFabric.js';
import {
  SECURITY_ASSESSMENT_ID_PATTERN,
  SECURITY_SOURCE_REVISION_PATTERN,
  type SecurityAssessmentOperationalPreflight,
  type SecurityAssessmentOperationalPreflightRequest,
} from '../../shared/securityAssessment.js';
import {
  projectExecutionResources,
  type AgentControlPlaneConfig,
  type AgentProjectConfig,
} from '../agentConfig.js';
import type { AgentJobStore } from '../agents/jobStore.js';
import type {
  AssessmentSourceStageReceipt,
  StagedAssessmentSource,
} from './sourceStaging.js';
import {
  AssessmentSourceCleanupUncertainError,
  AssessmentSourceStager,
  parseAssessmentSourceStageReceipt,
} from './sourceStaging.js';

export interface SecurityAssessmentTargetFact {
  id: string;
  running: boolean;
}

export type SecurityAssessmentTargetResolver =
  (targetId: string) => Promise<SecurityAssessmentTargetFact>;

export interface SecurityAssessmentCapabilityRegistry {
  availability(capabilityClasses: readonly string[]): {
    status: 'AVAILABLE' | 'UNAVAILABLE';
    code: string;
  };
}

export class UnavailableSecurityAssessmentCapabilityRegistry
implements SecurityAssessmentCapabilityRegistry {
  availability(_capabilityClasses: readonly string[]) {
    return {
      status: 'UNAVAILABLE' as const,
      code: 'BE10_SCANNER_PLUGIN_UNAVAILABLE',
    };
  }
}

function assertPreflightRequest(request: SecurityAssessmentOperationalPreflightRequest): void {
  if (!SECURITY_ASSESSMENT_ID_PATTERN.test(request.assessmentId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment id', 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(request.projectId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment project id', 400);
  }
  if (request.targetId !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(request.targetId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment target id', 400);
  }
  if (!SECURITY_SOURCE_REVISION_PATTERN.test(request.expectedSourceRevision)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment source revision', 400);
  }
  if (!Array.isArray(request.requestedCapabilityClasses)
    || request.requestedCapabilityClasses.length < 1
    || request.requestedCapabilityClasses.length > 64
    || request.requestedCapabilityClasses.some(
      (value) => typeof value !== 'string'
        || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value),
    )) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid assessment capability classes', 400);
  }
}

function projectResourceKeys(project: AgentProjectConfig): string[] {
  const resources: ExecutionResourceRef[] = [
    ...projectExecutionResources(project),
    { category: 'worktree', id: project.worktreeId ?? project.id },
  ];
  return [...new Set(resources.map(executionResourceKey))].sort();
}

export interface PreparedSecurityAssessmentSource {
  assessmentId: string;
  projectId: string;
  expectedSourceRevision: string;
  staged: StagedAssessmentSource;
  resourceKeys: string[];
}

export class SecurityAssessmentOperationalService {
  private readonly prepared = new Map<string, PreparedSecurityAssessmentSource>();

  constructor(
    private readonly config: AgentControlPlaneConfig,
    private readonly store: AgentJobStore,
    private readonly sourceStager: AssessmentSourceStager,
    private readonly stagerImageId: string,
    private readonly resolveTarget: SecurityAssessmentTargetResolver,
    private readonly capabilityRegistry: SecurityAssessmentCapabilityRegistry =
      new UnavailableSecurityAssessmentCapabilityRegistry(),
  ) {}

  private project(projectId: string): AgentProjectConfig {
    const project = this.config.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new BridgeError('PRECONDITION_FAILED', 'security assessment project is not registered', 412);
    }
    if (!project.gitRequired) {
      throw new BridgeError('PRECONDITION_FAILED', 'security assessment project must require Git', 412);
    }
    return project;
  }

  private resourceAvailable(keys: readonly string[], globalExclusive: boolean): boolean {
    const held = this.store.executionLeaseSummary();
    if (held.some((lease) => lease.resourceKey === 'machine:global-exclusive')) return false;
    if (globalExclusive && held.length > 0) return false;
    const wanted = new Set(keys);
    return !held.some((lease) => wanted.has(lease.resourceKey));
  }

  claimReplay(input: {
    bridgeRequestId: string;
    nonce: string;
    assessmentId: string;
    assessmentVersion: number;
    expiresAt: string;
  }): boolean {
    return this.store.claimSecurityAssessmentReplay(input);
  }

  async preflight(
    request: SecurityAssessmentOperationalPreflightRequest,
  ): Promise<SecurityAssessmentOperationalPreflight> {
    assertPreflightRequest(request);
    const project = this.project(request.projectId);

    if (request.targetId) {
      const target = await this.resolveTarget(request.targetId);
      if (target.id !== request.targetId) {
        throw new BridgeError('PRECONDITION_FAILED', 'security assessment target resolution mismatch', 412);
      }
      if (request.requireRunningTarget && !target.running) {
        throw new BridgeError('PRECONDITION_FAILED', 'security assessment target is not running', 412);
      }
    }

    if (!this.stagerImageId) {
      throw new BridgeError('PRECONDITION_FAILED', 'assessment stager image is not configured', 503);
    }

    const resources = projectResourceKeys(project);
    this.store.acquireExecutionLeasesForOwner({
      ownerKind: 'security-assessment',
      ownerId: request.assessmentId,
      projectId: project.id,
      resourceKeys: resources,
      globalExclusive: project.globalExclusive ?? false,
    });
    let source: AssessmentSourceStageReceipt;
    try {
      source = await this.sourceStager.probe({
        assessmentId: request.assessmentId,
        projectId: project.id,
        expectedSourceRevision: request.expectedSourceRevision,
        stagerImageId: this.stagerImageId,
        hostPath: project.hostPath,
      });
    } catch (error) {
      if (error instanceof AssessmentSourceCleanupUncertainError) {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment', request.assessmentId,
          'assessment preflight allocated resource cleanup could not be proven',
        );
      } else {
        this.store.releaseExecutionLeasesForOwner(
          'security-assessment', request.assessmentId, 'assessment preflight cleanup proven',
        );
      }
      throw error instanceof BridgeError ? error
        : new BridgeError('DOCKER_UNAVAILABLE', 'assessment source preflight failed', 503);
    }
    this.store.releaseExecutionLeasesForOwner(
      'security-assessment', request.assessmentId, 'assessment preflight cleanup proven',
    );
    if (source.sourceRevision !== request.expectedSourceRevision) {
      throw new BridgeError('PRECONDITION_FAILED', 'security assessment source revision drifted', 412);
    }

    const capability = this.capabilityRegistry.availability(request.requestedCapabilityClasses);
    return {
      projectId: project.id,
      ...(request.targetId ? { targetId: request.targetId } : {}),
      sourceRevision: source.sourceRevision,
      sourceTree: source.sourceTree,
      clean: true,
      gitRequired: true,
      resourceAvailable: this.resourceAvailable(resources, project.globalExclusive ?? false),
      capabilityStatus: capability.status,
      capabilityCode: capability.code,
    };
  }

  async prepare(
    request: SecurityAssessmentOperationalPreflightRequest,
  ): Promise<{
    projectId: string;
    sourceRevision: string;
    sourceTree: string;
    manifestDigest: string;
  }> {
    assertPreflightRequest(request);
    if (this.prepared.has(request.assessmentId)) {
      throw new BridgeError('CONCURRENCY_LIMIT', 'assessment source is already prepared in this executor instance', 409);
    }
    const project = this.project(request.projectId);
    const keys = projectResourceKeys(project);

    this.store.acquireExecutionLeasesForOwner({
      ownerKind: 'security-assessment',
      ownerId: request.assessmentId,
      projectId: project.id,
      resourceKeys: keys,
      globalExclusive: project.globalExclusive ?? false,
    });

    let staged: StagedAssessmentSource | undefined;
    try {
      staged = await this.sourceStager.stage({
        assessmentId: request.assessmentId,
        projectId: project.id,
        expectedSourceRevision: request.expectedSourceRevision,
        stagerImageId: this.stagerImageId,
        hostPath: project.hostPath,
      });
      this.store.saveSecurityAssessmentPrepared({
        assessmentId: request.assessmentId,
        projectId: project.id,
        expectedSourceRevision: request.expectedSourceRevision,
        executionId: staged.executionId,
        sourceVolume: staged.sourceVolume,
        stageReceipt: staged.receipt,
        resourceKeys: keys,
      });
      this.prepared.set(request.assessmentId, {
        assessmentId: request.assessmentId,
        projectId: project.id,
        expectedSourceRevision: request.expectedSourceRevision,
        staged,
        resourceKeys: keys,
      });
      return {
        projectId: project.id,
        sourceRevision: staged.receipt.sourceRevision,
        sourceTree: staged.receipt.sourceTree,
        manifestDigest: staged.receipt.manifestDigest,
      };
    } catch (error) {
      if (staged) {
        try {
          await this.sourceStager.remove(staged);
          this.store.deleteSecurityAssessmentPrepared(request.assessmentId);
        } catch {
          this.store.markExecutionLeasesUncertainForOwner(
            'security-assessment',
            request.assessmentId,
            'assessment preparation failed after source creation and cleanup could not be proven',
          );
          throw new AssessmentSourceCleanupUncertainError(
            error instanceof BridgeError ? error.code : undefined,
          );
        }
      }
      if (error instanceof AssessmentSourceCleanupUncertainError) {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment', request.assessmentId,
          'assessment staging allocated resource cleanup could not be proven',
        );
        throw error;
      }
      this.store.releaseExecutionLeasesForOwner(
        'security-assessment',
        request.assessmentId,
        'assessment staging failed before execution',
      );
      throw error instanceof BridgeError ? error
        : new BridgeError('DOCKER_UNAVAILABLE', 'assessment preparation failed', 503);
    }
  }

  async recoverPrepared(): Promise<void> {
    const durable = this.store.listSecurityAssessmentPrepared();
    for (const item of durable) {
      if (this.prepared.has(item.assessmentId)) {
        throw new BridgeError('INTERNAL', 'duplicate in-memory assessment recovery identity', 500);
      }
      const project = this.project(item.projectId);
      const expectedKeys = projectResourceKeys(project);
      if (
        item.resourceKeys.length !== expectedKeys.length
        || item.resourceKeys.some((key, index) => key !== expectedKeys[index])
      ) {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment',
          item.assessmentId,
          'assessment recovery resource identity mismatch',
        );
        throw new BridgeError('PRECONDITION_FAILED', 'assessment recovery resource identity mismatch', 412);
      }
      const receipt = parseAssessmentSourceStageReceipt({
        stdout: `BE9_STAGE_RECEIPT=${JSON.stringify(item.stageReceipt)}\n`,
        stderr: '',
        truncated: false,
      });
      if (
        receipt.mode !== 'stage'
        || receipt.assessmentId !== item.assessmentId
        || receipt.projectId !== item.projectId
        || receipt.sourceRevision !== item.expectedSourceRevision
        || receipt.stagerImageId !== this.stagerImageId
      ) {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment',
          item.assessmentId,
          'assessment recovery staging receipt binding mismatch',
        );
        throw new BridgeError('PRECONDITION_FAILED', 'assessment recovery staging receipt binding mismatch', 412);
      }
      const staged: StagedAssessmentSource = {
        assessmentId: item.assessmentId,
        projectId: item.projectId,
        executionId: item.executionId,
        sourceVolume: item.sourceVolume,
        receipt,
      };
      try {
        await this.sourceStager.recover({
          ...staged,
          expectedSourceRevision: item.expectedSourceRevision,
          stagerImageId: this.stagerImageId,
          hostPath: project.hostPath,
        });
      } catch (error) {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment',
          item.assessmentId,
          'assessment recovery could not prove exact staged source ownership',
        );
        throw error;
      }
      this.prepared.set(item.assessmentId, {
        assessmentId: item.assessmentId,
        projectId: item.projectId,
        expectedSourceRevision: item.expectedSourceRevision,
        staged,
        resourceKeys: item.resourceKeys,
      });
    }
  }

  async revalidateBeforeRun(assessmentId: string): Promise<AssessmentSourceStageReceipt> {
    const prepared = this.prepared.get(assessmentId);
    if (!prepared) {
      throw new BridgeError(
        'PRECONDITION_FAILED',
        'prepared assessment source is unavailable; recovery may not silently restage or rerun',
        412,
      );
    }
    const project = this.project(prepared.projectId);
    return this.sourceStager.revalidateBeforeRun({
      ...prepared.staged,
      expectedSourceRevision: prepared.expectedSourceRevision,
      stagerImageId: this.stagerImageId,
      hostPath: project.hostPath,
    });
  }

  async cleanup(assessmentId: string, uncertain = false): Promise<void> {
    const prepared = this.prepared.get(assessmentId);
    if (prepared) {
      try {
        await this.sourceStager.remove(prepared.staged);
      } catch (error) {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment',
          assessmentId,
          'assessment source cleanup could not be proven',
        );
        throw error;
      } finally {
        this.prepared.delete(assessmentId);
      }
    }

    if (prepared) {
      this.store.deleteSecurityAssessmentPrepared(assessmentId);
    }

    if (uncertain) {
      this.store.markExecutionLeasesUncertainForOwner(
        'security-assessment',
        assessmentId,
        'assessment cleanup was reported uncertain',
      );
    } else {
      this.store.releaseExecutionLeasesForOwner(
        'security-assessment',
        assessmentId,
        'assessment cleanup proven',
      );
    }
  }
}
