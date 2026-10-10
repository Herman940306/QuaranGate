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
    const executionId = this.store.assessmentAllocationExecutionId(request.assessmentId);
    let source: AssessmentSourceStageReceipt;
    try {
      source = await this.sourceStager.probe({
        assessmentId: request.assessmentId,
        executionId,
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
    const heldKeys = [...keys, ...(project.globalExclusive ? ['machine:global-exclusive'] : [])].sort();

    this.store.acquireExecutionLeasesForOwner({
      ownerKind: 'security-assessment',
      ownerId: request.assessmentId,
      projectId: project.id,
      resourceKeys: keys,
      globalExclusive: project.globalExclusive ?? false,
    });
    const executionId = this.store.assessmentAllocationExecutionId(request.assessmentId);

    let staged: StagedAssessmentSource | undefined;
    try {
      staged = await this.sourceStager.stage({
        assessmentId: request.assessmentId,
        executionId,
        projectId: project.id,
        expectedSourceRevision: request.expectedSourceRevision,
        stagerImageId: this.stagerImageId,
        hostPath: project.hostPath,
      });
      // If an internal cleanup or an external authority action invalidated
      // the allocation while staging awaited Docker, never publish a receipt.
      this.assertPreparedLeaseFresh({
        assessmentId: request.assessmentId,
        projectId: project.id,
        executionId,
        resourceKeys: heldKeys,
      });
      // The store validates the same binding again *inside* the atomic insert.
      this.store.saveSecurityAssessmentPrepared({
        assessmentId: request.assessmentId,
        projectId: project.id,
        expectedSourceRevision: request.expectedSourceRevision,
        executionId: staged.executionId,
        sourceVolume: staged.sourceVolume,
        stageReceipt: staged.receipt,
        resourceKeys: heldKeys,
      });
      this.prepared.set(request.assessmentId, {
        assessmentId: request.assessmentId,
        projectId: project.id,
        expectedSourceRevision: request.expectedSourceRevision,
        staged,
        resourceKeys: heldKeys,
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

  /** The BE1A lease must remain exact and ACTIVE across awaited source verification. */
  private assertPreparedLeaseFresh(input: {
    assessmentId: string; projectId: string; executionId: string; resourceKeys: readonly string[];
  }): void {
    try {
      this.store.assertSecurityAssessmentPreparedLeaseBinding(input);
    } catch {
      this.store.markExecutionLeasesUncertainForOwner(
        'security-assessment', input.assessmentId,
        'assessment prepared lease binding changed during source verification',
      );
      throw new BridgeError('PRECONDITION_FAILED', 'assessment prepared lease binding is invalid', 412);
    }
  }

  async recoverPrepared(): Promise<void> {
    const preparedIds = new Set(this.store.listSecurityAssessmentPreparedIds());
    const orphans = new Set(this.store.executionLeaseSummary()
      .filter((lease) => lease.ownerKind === 'security-assessment' && !preparedIds.has(lease.ownerId))
      .map((lease) => lease.ownerId));
    for (const assessmentId of orphans) {
      this.store.markExecutionLeasesUncertainForOwner(
        'security-assessment', assessmentId, 'assessment restart found no prepared source identity',
      );
      try {
        const executionId = this.store.assessmentAllocationExecutionId(assessmentId);
        const removedCount = await this.sourceStager.reconcileOrphan(assessmentId, executionId);
        this.store.recordAssessmentOrphanReconciliation(assessmentId, removedCount);
      } catch {
        this.store.recordAssessmentOrphanReconciliation(assessmentId, null);
      }
    }
    for (const assessmentId of preparedIds) {
      let item: ReturnType<AgentJobStore['getSecurityAssessmentPrepared']>;
      try { item = this.store.getSecurityAssessmentPrepared(assessmentId); }
      catch {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment', assessmentId, 'assessment prepared metadata is malformed',
        );
        continue;
      }
      if (!item) continue;
      if (this.prepared.has(item.assessmentId)) {
        throw new BridgeError('INTERNAL', 'duplicate in-memory assessment recovery identity', 500);
      }
      let project: AgentProjectConfig;
      try { project = this.project(item.projectId); }
      catch {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment', item.assessmentId, 'assessment prepared project metadata is invalid',
        );
        continue;
      }
      const expectedKeys = [...projectResourceKeys(project),
        ...(project.globalExclusive ? ['machine:global-exclusive'] : [])].sort();
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
      try {
        this.store.assertSecurityAssessmentPreparedLeaseBinding({
          assessmentId: item.assessmentId,
          projectId: item.projectId,
          executionId: item.executionId,
          resourceKeys: expectedKeys,
        });
      } catch {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment', item.assessmentId, 'assessment prepared lease binding is invalid',
        );
        throw new BridgeError('PRECONDITION_FAILED', 'assessment prepared lease binding is invalid', 412);
      }
      let receipt: AssessmentSourceStageReceipt;
      try {
        receipt = parseAssessmentSourceStageReceipt({
          stdout: `BE9_STAGE_RECEIPT=${JSON.stringify(item.stageReceipt)}\n`,
          stderr: '',
          truncated: false,
        });
      } catch {
        this.store.markExecutionLeasesUncertainForOwner(
          'security-assessment', item.assessmentId, 'assessment prepared receipt is malformed',
        );
        continue;
      }
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
      this.assertPreparedLeaseFresh({
        assessmentId: item.assessmentId,
        projectId: item.projectId,
        executionId: item.executionId,
        resourceKeys: expectedKeys,
      });
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
    const expectedKeys = [...projectResourceKeys(project),
      ...(project.globalExclusive ? ['machine:global-exclusive'] : [])].sort();
    if (prepared.resourceKeys.length !== expectedKeys.length
      || prepared.resourceKeys.some((key, index) => key !== expectedKeys[index])) {
      this.store.markExecutionLeasesUncertainForOwner(
        'security-assessment', assessmentId, 'assessment prepared resource identity drifted',
      );
      throw new BridgeError('PRECONDITION_FAILED', 'assessment prepared resource identity drifted', 412);
    }
    const binding = {
      assessmentId, projectId: prepared.projectId,
      executionId: prepared.staged.executionId, resourceKeys: expectedKeys,
    };
    this.assertPreparedLeaseFresh(binding);
    const result = await this.sourceStager.revalidateBeforeRun({
      ...prepared.staged,
      expectedSourceRevision: prepared.expectedSourceRevision,
      stagerImageId: this.stagerImageId,
      hostPath: project.hostPath,
    });
    this.assertPreparedLeaseFresh(binding);
    return result;
  }

  async cleanup(assessmentId: string, uncertain = false): Promise<void> {
    const prepared = this.prepared.get(assessmentId);
    if (!prepared) {
      // An ACTIVE lease is durable evidence of possible in-flight staging.
      // A persisted prepared row may also outlive this service instance.
      // Neither a missing in-memory handle nor an empty local map proves
      // Docker resource absence; quarantine instead of releasing.
      this.store.markExecutionLeasesUncertainForOwner(
        'security-assessment', assessmentId,
        'assessment cleanup cannot prove absence without a prepared source handle',
      );
      throw new BridgeError(
        'PRECONDITION_FAILED',
        'assessment cleanup requires governed source reconciliation',
        412,
      );
    }
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
