import "server-only";
import { ProductDataError } from "../../data/errors";
import { canonicalSnapshot, verifySnapshot } from "./snapshot";
import { assertLegalAssessmentTransition, isTerminalAssessmentState } from "./state";
import type { SecurityAssessmentCreateInput, SecurityAssessmentReadScope, SecurityAssessmentRecord, SecurityAssessmentRepository, SecurityAssessmentTransitionInput } from "./types";

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function assertId(value: string, code: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ProductDataError("PRODUCT_DATA_INVALID", code); }
function assertRevision(value: string): void { if (!/^[0-9a-f]{40}$/.test(value)) throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_source_revision_invalid"); }

function assertOwner(scope: SecurityAssessmentReadScope, record: SecurityAssessmentRecord): void {
  if (scope.productUserId !== record.owner.productUserId || scope.organizationId !== record.owner.organizationId || scope.workspaceId !== record.owner.workspaceId || scope.principalRef !== record.owner.principalRef) {
    throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "assessment_forbidden");
  }
}

function validateRecord(record: SecurityAssessmentRecord): void {
  verifySnapshot(record.discoverySnapshot);
  verifySnapshot(record.planSnapshot);
  if (!Number.isSafeInteger(record.version) || record.version < 0) throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_version_invalid");
}

export class MemorySecurityAssessmentRepository implements SecurityAssessmentRepository {
  private readonly records = new Map<string, SecurityAssessmentRecord>();

  constructor(seed: SecurityAssessmentRecord[] = []) {
    for (const record of seed) { validateRecord(record); this.records.set(record.id, clone(record)); }
  }

  exportForRestart(): SecurityAssessmentRecord[] { return Array.from(this.records.values()).map(clone); }

  async create<TDiscovery, TPlan>(input: SecurityAssessmentCreateInput<TDiscovery, TPlan>): Promise<SecurityAssessmentRecord<TDiscovery, TPlan>> {
    assertId(input.assessmentId, "assessment_id_invalid");
    assertId(input.discoveryId, "assessment_discovery_id_invalid");
    assertId(input.planId, "assessment_plan_id_invalid");
    assertId(input.owner.productUserId, "assessment_product_user_invalid");
    assertId(input.owner.organizationId, "assessment_organization_invalid");
    assertId(input.owner.workspaceId, "assessment_workspace_invalid");
    assertId(input.owner.principalRef, "assessment_principal_invalid");
    assertId(input.binding.projectId, "assessment_project_invalid");
    if (input.binding.targetId) assertId(input.binding.targetId, "assessment_target_invalid");
    assertRevision(input.binding.sourceRevision);
    if (!Number.isSafeInteger(input.owner.principalMappingVersion) || input.owner.principalMappingVersion < 0) throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_principal_version_invalid");
    if (this.records.has(input.assessmentId)) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "assessment_id_reused");

    const discoverySnapshot = canonicalSnapshot(input.discoverySnapshot);
    const planSnapshot = canonicalSnapshot(input.planSnapshot);
    const planValue = planSnapshot.value as Record<string, unknown>;
    if (typeof planValue.discoveryId === "string" && planValue.discoveryId !== input.discoveryId) throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_discovery_mismatch");
    if (typeof planValue.sourceRevision === "string" && planValue.sourceRevision !== input.binding.sourceRevision) throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_revision_mismatch");

    const record: SecurityAssessmentRecord<TDiscovery, TPlan> = {
      id: input.assessmentId,
      owner: clone(input.owner),
      binding: clone(input.binding),
      discoveryId: input.discoveryId,
      planId: input.planId,
      discoverySnapshot,
      planSnapshot,
      state: "PLANNED",
      version: 0,
      requestedAt: input.requestedAt,
      updatedAt: input.requestedAt,
      correlationId: input.correlationId,
      transitionLog: [],
    };
    this.records.set(input.assessmentId, clone(record));
    return clone(record);
  }

  async read(scope: SecurityAssessmentReadScope, assessmentId: string): Promise<SecurityAssessmentRecord | undefined> {
    const record = this.records.get(assessmentId);
    if (!record) return undefined;
    assertOwner(scope, record);
    validateRecord(record);
    return clone(record);
  }

  async transition(input: SecurityAssessmentTransitionInput): Promise<SecurityAssessmentRecord> {
    const record = this.records.get(input.assessmentId);
    if (!record) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "assessment_not_found");
    validateRecord(record);
    if (record.version !== input.expectedVersion) throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "assessment_version_stale");
    const nextState = input.cleanupUncertain ? "CLEANUP_FAILED" : input.nextState;
    assertLegalAssessmentTransition(record.state, nextState);
    const nextVersion = record.version + 1;
    const next: SecurityAssessmentRecord = {
      ...clone(record),
      state: nextState,
      version: nextVersion,
      pendingOutcome: input.pendingOutcome ?? record.pendingOutcome,
      updatedAt: input.at,
      transitionLog: [...record.transitionLog, { assessmentId: input.assessmentId, priorState: record.state, nextState, version: nextVersion, reason: input.reason, actor: input.actor, correlationId: input.correlationId, at: input.at, ...(input.pendingOutcome ? { pendingOutcome: input.pendingOutcome } : {}) }],
    };
    this.records.set(input.assessmentId, clone(next));
    return clone(next);
  }

  async listActive(): Promise<SecurityAssessmentRecord[]> { return Array.from(this.records.values()).filter((record) => !isTerminalAssessmentState(record.state)).map(clone); }
}
