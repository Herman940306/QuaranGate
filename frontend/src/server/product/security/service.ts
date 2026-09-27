import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type {
  ProductAssessmentAdmissionRequest,
  SecurityAssessmentAdmissionReceipt,
  SecurityAssessmentOperationalBinding,
} from "../../../../../src/shared/securityAssessment";
import type { ProductContextAdapter } from "../adapters/workspace";
import { PostgresProductContextAdapter } from "../adapters/postgres-context";
import { ProductDataError } from "../data/errors";
import { productDataRepository } from "../data/runtime";
import type { ProductSession } from "../identity/types";
import type { PrincipalMappingAdapter } from "../principal/adapter";
import { PostgresPrincipalMappingAdapter } from "../principal/adapter";
import {
  MemorySecurityAssessmentRepository,
  type SecurityAssessmentReadScope,
  type SecurityAssessmentRecord,
  type SecurityAssessmentRepository,
} from "./assessment";
import type { SecurityAssessmentAdmissionAdapter } from "./bridge";
import { UnavailableSecurityAssessmentAdmissionAdapter } from "./bridge";
import { discoverSecurityStack } from "./discovery";
import type { SecurityAssessmentEvidenceStore } from "./evidence";
import { MemorySecurityAssessmentEvidenceStore } from "./evidence";
import { createSecurityAssessmentPlan } from "./planner";
import type { SecuritySourceAdapter } from "./source";
import { UnavailableSecuritySourceAdapter } from "./source";
import type { SecurityDiscoveryStore } from "./store";
import { MemorySecurityDiscoveryStore } from "./store";
import type {
  SecurityAssessmentPlan,
  SecurityDiscoveryRequest,
  SecurityDiscoveryResult,
  StoredSecurityDiscovery,
} from "./types";

interface EligibleSecurityContext {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  principalRef: string;
  principalMappingVersion: number;
}

function assertDiscoveryId(discoveryId: string): void {
  if (!/^disc_[0-9a-f]{24}$/.test(discoveryId)) throw new Error("security_discovery_id_invalid");
}

function assertAssessmentId(assessmentId: string): void {
  if (!/^assessment_[0-9a-f]{24}$/.test(assessmentId)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "security_assessment_id_invalid");
  }
}

function scopeDiscoveryId(context: EligibleSecurityContext, discovery: SecurityDiscoveryResult): string {
  const digest = createHash("sha256").update(JSON.stringify({
    productUserId: context.productUserId,
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    principalRef: context.principalRef,
    sourceDiscoveryId: discovery.discoveryId,
  })).digest("hex").slice(0, 24);
  return `disc_${digest}`;
}

function actorRef(context: EligibleSecurityContext): string {
  return `actor_${createHash("sha256").update(JSON.stringify({
    productUserId: context.productUserId,
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
  })).digest("hex").slice(0, 24)}`;
}

function readScope(context: EligibleSecurityContext): SecurityAssessmentReadScope {
  return {
    productUserId: context.productUserId,
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    principalRef: context.principalRef,
  };
}

export class SecurityAssessmentService {
  constructor(
    private readonly context: ProductContextAdapter = new PostgresProductContextAdapter(productDataRepository()),
    private readonly principalMappings: PrincipalMappingAdapter = new PostgresPrincipalMappingAdapter(productDataRepository()),
    private readonly sources: SecuritySourceAdapter = new UnavailableSecuritySourceAdapter(),
    private readonly discoveries: SecurityDiscoveryStore = new MemorySecurityDiscoveryStore(),
    private readonly assessments: SecurityAssessmentRepository = new MemorySecurityAssessmentRepository(),
    private readonly admission: SecurityAssessmentAdmissionAdapter = new UnavailableSecurityAssessmentAdmissionAdapter(),
    private readonly assessmentEvidence: SecurityAssessmentEvidenceStore = new MemorySecurityAssessmentEvidenceStore(),
  ) {}

  private async eligible(session: ProductSession): Promise<EligibleSecurityContext> {
    if (!session.workspace) throw new Error("security_workspace_required");

    const workspace = await this.context.workspaceForUser(session.identity.userRef, session.workspace.id);
    if (!workspace || workspace.organizationId !== session.workspace.organizationId) throw new Error("security_forbidden");

    if (session.principalMapping.state !== "mapped-reference") {
      if (session.principalMapping.state === "unavailable") throw new Error("security_principal_unavailable");
      throw new Error("security_forbidden");
    }

    const resolved = await this.principalMappings.resolve({
      productUserId: session.identity.userRef,
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      correlationId: session.correlationId,
      expectedMappingVersion: session.principalMapping.mappingVersion,
    });

    if (resolved.state === "unavailable") throw new Error("security_principal_unavailable");
    if (resolved.state !== "mapped-reference") throw new Error("security_forbidden");
    if (
      resolved.principalRef !== session.principalMapping.principalRef
      || resolved.mappingVersion !== session.principalMapping.mappingVersion
    ) {
      throw new Error("security_forbidden");
    }

    return {
      productUserId: session.identity.userRef,
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      principalRef: resolved.principalRef,
      principalMappingVersion: resolved.mappingVersion,
    };
  }

  private assertOwnedDiscovery(
    context: EligibleSecurityContext,
    entry: StoredSecurityDiscovery | undefined,
  ): StoredSecurityDiscovery {
    if (!entry) throw new Error("security_discovery_not_found");
    if (
      entry.productUserId !== context.productUserId
      || entry.organizationId !== context.organizationId
      || entry.workspaceId !== context.workspaceId
      || entry.principalRef !== context.principalRef
    ) {
      throw new Error("security_forbidden");
    }
    return entry;
  }

  private async ownAssessment(
    context: EligibleSecurityContext,
    assessmentId: string,
  ): Promise<SecurityAssessmentRecord> {
    assertAssessmentId(assessmentId);
    let record: SecurityAssessmentRecord | undefined;
    try {
      record = await this.assessments.read(readScope(context), assessmentId);
    } catch (error) {
      if (error instanceof ProductDataError && error.code === "PRODUCT_DATA_FORBIDDEN") {
        throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "assessment_not_found");
      }
      throw error;
    }
    if (!record) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "assessment_not_found");
    return record;
  }

  private async revalidateOperationalOwner(owner: {
    productUserId: string;
    organizationId: string;
    workspaceId: string;
    principalRef: string;
    principalMappingVersion: number;
  }, principalRef: string): Promise<void> {
    if (owner.principalRef !== principalRef) {
      throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "assessment_not_found");
    }
    const workspace = await this.context.workspaceForUser(owner.productUserId, owner.workspaceId);
    if (!workspace || workspace.organizationId !== owner.organizationId) {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "assessment_membership_revoked");
    }
    const mapping = await this.principalMappings.resolve({
      productUserId: owner.productUserId,
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      correlationId: `mcp_${randomBytes(8).toString("hex")}`,
      expectedMappingVersion: owner.principalMappingVersion,
    });
    if (
      mapping.state !== "mapped-reference"
      || mapping.principalRef !== principalRef
      || mapping.mappingVersion !== owner.principalMappingVersion
    ) {
      throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "assessment_principal_mapping_stale");
    }
  }

  async discover(session: ProductSession, request: SecurityDiscoveryRequest): Promise<SecurityDiscoveryResult> {
    const eligible = await this.eligible(session);
    const snapshot = await this.sources.resolve({
      productUserId: eligible.productUserId,
      organizationId: eligible.organizationId,
      workspaceId: eligible.workspaceId,
      principalRef: eligible.principalRef,
      projectId: request.projectId,
      ...(request.targetId ? { targetId: request.targetId } : {}),
    });

    if (snapshot.projectId !== request.projectId) throw new Error("security_project_forbidden");
    if ((request.targetId ?? undefined) !== (snapshot.targetId ?? undefined)) throw new Error("security_target_forbidden");

    const discovered = discoverSecurityStack(snapshot);
    const result = { ...discovered, discoveryId: scopeDiscoveryId(eligible, discovered) };
    await this.discoveries.put({
      productUserId: eligible.productUserId,
      organizationId: eligible.organizationId,
      workspaceId: eligible.workspaceId,
      principalRef: eligible.principalRef,
      principalMappingVersion: eligible.principalMappingVersion,
      result,
    });
    return result;
  }

  async result(session: ProductSession, discoveryId: string): Promise<SecurityDiscoveryResult> {
    assertDiscoveryId(discoveryId);
    const eligible = await this.eligible(session);
    return this.assertOwnedDiscovery(eligible, await this.discoveries.get(discoveryId)).result;
  }

  async createPlan(session: ProductSession, discoveryId: string): Promise<SecurityAssessmentPlan> {
    assertDiscoveryId(discoveryId);
    const eligible = await this.eligible(session);
    const entry = this.assertOwnedDiscovery(eligible, await this.discoveries.get(discoveryId));
    return createSecurityAssessmentPlan(entry.result);
  }

  async createAssessment(
    session: ProductSession,
    discoveryId: string,
  ): Promise<SecurityAssessmentRecord> {
    assertDiscoveryId(discoveryId);
    const eligible = await this.eligible(session);
    const discovery = this.assertOwnedDiscovery(
      eligible,
      await this.discoveries.get(discoveryId),
    ).result;
    const plan = createSecurityAssessmentPlan(discovery);
    const requestedAt = new Date().toISOString();
    const assessmentId = `assessment_${randomBytes(12).toString("hex")}`;
    let record = await this.assessments.create({
      assessmentId,
      owner: {
        productUserId: eligible.productUserId,
        organizationId: eligible.organizationId,
        workspaceId: eligible.workspaceId,
        principalRef: eligible.principalRef,
        principalMappingVersion: eligible.principalMappingVersion,
      },
      binding: {
        projectId: discovery.projectId,
        ...(discovery.targetId ? { targetId: discovery.targetId } : {}),
        sourceRevision: discovery.sourceRevision,
        assessmentIntent: "source",
      },
      discoveryId: discovery.discoveryId,
      planId: plan.planId,
      discoverySnapshot: discovery,
      planSnapshot: plan,
      requestedAt,
      correlationId: session.correlationId,
    });

    const now = new Date();
    const bridgeRequest: ProductAssessmentAdmissionRequest = {
      schemaVersion: "BE9_ADMISSION_V1",
      bridgeRequestId: `bar_${randomBytes(12).toString("hex")}`,
      productActorRef: actorRef(eligible),
      productUserId: eligible.productUserId,
      organizationId: eligible.organizationId,
      workspaceId: eligible.workspaceId,
      assessmentId: record.id,
      assessmentVersion: record.version,
      correlationId: record.correlationId,
      principalRef: eligible.principalRef,
      principalMappingVersion: eligible.principalMappingVersion,
      discoveryId: record.discoveryId,
      discoveryDigest: record.discoverySnapshot.digest,
      planId: record.planId,
      planDigest: record.planSnapshot.digest,
      projectId: record.binding.projectId,
      ...(record.binding.targetId ? { targetId: record.binding.targetId } : {}),
      expectedSourceRevision: record.binding.sourceRevision,
      assessmentIntent: record.binding.assessmentIntent ?? "source",
      requestedCapabilityClasses: plan.selectedCapabilities
        .filter((item) => item.state === "APPLICABLE")
        .map((item) => item.capabilityId),
      networkClass: "NONE",
      credentialClass: "NONE",
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
      nonce: randomBytes(16).toString("hex"),
    };

    let receipt: SecurityAssessmentAdmissionReceipt;
    try {
      receipt = await this.admission.admit(bridgeRequest);
    } catch (error) {
      if (error instanceof ProductDataError && error.code === "PRODUCT_DATA_UNAVAILABLE") {
        return this.assessments.transition({
          assessmentId: record.id,
          expectedVersion: record.version,
          event: "ADMISSION_TEMPORARILY_UNAVAILABLE",
          reason: "operational bridge unavailable",
          actor: "product-service",
          correlationId: record.correlationId,
          at: new Date().toISOString(),
        });
      }
      throw error;
    }

    if (
      receipt.assessmentId !== record.id
      || receipt.assessmentVersion !== record.version
      || receipt.correlationId !== record.correlationId
    ) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_admission_receipt_binding_invalid");
    }
    await this.assessmentEvidence.recordAdmission(readScope(eligible), receipt);

    const event = receipt.decision === "ADMITTED"
      ? "ADMISSION_REVALIDATION_PASS"
      : receipt.decision === "DENIED_POLICY"
        ? "ADMISSION_POLICY_DENIED"
        : receipt.decision === "FAILED_PRECONDITION"
          ? "ADMISSION_PRECONDITION_FAILED"
          : "ADMISSION_TEMPORARILY_UNAVAILABLE";

    record = await this.assessments.transition({
      assessmentId: record.id,
      expectedVersion: record.version,
      event,
      reason: `${receipt.decision}:${receipt.decisionCode}:${receipt.admissionReceiptDigest}`,
      actor: "operational-bridge",
      correlationId: record.correlationId,
      at: receipt.decisionAt,
    });
    return record;
  }

  async createOperationalIntent(
    principalRef: string,
    discoveryId: string,
    correlationId: string,
  ): Promise<SecurityAssessmentOperationalBinding> {
    assertDiscoveryId(discoveryId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(principalRef)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(correlationId)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_operational_identity_invalid");
    }
    const entry = await this.discoveries.getForPrincipal(discoveryId, principalRef);
    if (!entry) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "security_discovery_not_found");
    await this.revalidateOperationalOwner({
      productUserId: entry.productUserId,
      organizationId: entry.organizationId,
      workspaceId: entry.workspaceId,
      principalRef: entry.principalRef,
      principalMappingVersion: entry.principalMappingVersion,
    }, principalRef);

    const plan = createSecurityAssessmentPlan(entry.result);
    const requestedAt = new Date().toISOString();
    const record = await this.assessments.create({
      assessmentId: `assessment_${randomBytes(12).toString("hex")}`,
      owner: {
        productUserId: entry.productUserId,
        organizationId: entry.organizationId,
        workspaceId: entry.workspaceId,
        principalRef: entry.principalRef,
        principalMappingVersion: entry.principalMappingVersion,
      },
      binding: {
        projectId: entry.result.projectId,
        ...(entry.result.targetId ? { targetId: entry.result.targetId } : {}),
        sourceRevision: entry.result.sourceRevision,
        assessmentIntent: "source",
      },
      discoveryId: entry.result.discoveryId,
      planId: plan.planId,
      discoverySnapshot: entry.result,
      planSnapshot: plan,
      requestedAt,
      correlationId,
    });

    return {
      assessmentId: record.id,
      assessmentVersion: record.version,
      correlationId: record.correlationId,
      principalRef,
      principalMappingVersion: record.owner.principalMappingVersion,
      discoveryId: record.discoveryId,
      discoveryDigest: record.discoverySnapshot.digest,
      planId: record.planId,
      planDigest: record.planSnapshot.digest,
      projectId: record.binding.projectId,
      ...(record.binding.targetId ? { targetId: record.binding.targetId } : {}),
      expectedSourceRevision: record.binding.sourceRevision,
      assessmentIntent: record.binding.assessmentIntent ?? "source",
      requestedCapabilityClasses: plan.selectedCapabilities
        .filter((item) => item.state === "APPLICABLE")
        .map((item) => item.capabilityId),
      networkClass: "NONE",
      credentialClass: "NONE",
    };
  }

  async applyOperationalAdmission(
    principalRef: string,
    receipt: SecurityAssessmentAdmissionReceipt,
  ): Promise<SecurityAssessmentRecord> {
    assertAssessmentId(receipt.assessmentId);
    const record = await this.assessments.readForPrincipal(principalRef, receipt.assessmentId);
    if (!record) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "assessment_not_found");
    await this.revalidateOperationalOwner(record.owner, principalRef);
    if (
      receipt.assessmentVersion !== record.version
      || receipt.correlationId !== record.correlationId
      || receipt.assessmentId !== record.id
    ) {
      throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "assessment_admission_receipt_stale");
    }
    await this.assessmentEvidence.recordAdmission({
      productUserId: record.owner.productUserId,
      organizationId: record.owner.organizationId,
      workspaceId: record.owner.workspaceId,
      principalRef: record.owner.principalRef,
    }, receipt);
    const event = receipt.decision === "ADMITTED"
      ? "ADMISSION_REVALIDATION_PASS"
      : receipt.decision === "DENIED_POLICY"
        ? "ADMISSION_POLICY_DENIED"
        : receipt.decision === "FAILED_PRECONDITION"
          ? "ADMISSION_PRECONDITION_FAILED"
          : "ADMISSION_TEMPORARILY_UNAVAILABLE";
    return this.assessments.transition({
      assessmentId: record.id,
      expectedVersion: record.version,
      event,
      reason: `${receipt.decision}:${receipt.decisionCode}:${receipt.admissionReceiptDigest}`,
      actor: "operational-bridge",
      correlationId: record.correlationId,
      at: receipt.decisionAt,
    });
  }

  async operationalAssessment(
    principalRef: string,
    assessmentId: string,
  ): Promise<SecurityAssessmentRecord> {
    assertAssessmentId(assessmentId);
    const record = await this.assessments.readForPrincipal(principalRef, assessmentId);
    if (!record) throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "assessment_not_found");
    await this.revalidateOperationalOwner(record.owner, principalRef);
    return record;
  }

  async operationalCancel(
    principalRef: string,
    assessmentId: string,
  ): Promise<SecurityAssessmentRecord> {
    const record = await this.operationalAssessment(principalRef, assessmentId);
    if ([
      "COMPLETED", "FAILED_POLICY", "FAILED_PRECONDITION", "FAILED_TOOL",
      "FAILED_TIMEOUT", "FAILED_INFRASTRUCTURE", "CANCELLED", "CLEANUP_FAILED",
      "CANCELLING", "CLEANUP",
    ].includes(record.state)) return record;
    return this.assessments.transition({
      assessmentId: record.id,
      expectedVersion: record.version,
      event: "CANCEL_REQUEST",
      reason: "MCP cancellation requested",
      actor: "operational-bridge",
      correlationId: record.correlationId,
      at: new Date().toISOString(),
    });
  }

  async operationalEvidence(principalRef: string, assessmentId: string) {
    const record = await this.operationalAssessment(principalRef, assessmentId);
    return this.assessmentEvidence.list({
      productUserId: record.owner.productUserId,
      organizationId: record.owner.organizationId,
      workspaceId: record.owner.workspaceId,
      principalRef: record.owner.principalRef,
    }, record.id);
  }

  async assessment(
    session: ProductSession,
    assessmentId: string,
  ): Promise<SecurityAssessmentRecord> {
    const eligible = await this.eligible(session);
    return this.ownAssessment(eligible, assessmentId);
  }

  async cancelAssessment(
    session: ProductSession,
    assessmentId: string,
  ): Promise<SecurityAssessmentRecord> {
    const eligible = await this.eligible(session);
    const record = await this.ownAssessment(eligible, assessmentId);
    if ([
      "COMPLETED", "FAILED_POLICY", "FAILED_PRECONDITION", "FAILED_TOOL",
      "FAILED_TIMEOUT", "FAILED_INFRASTRUCTURE", "CANCELLED", "CLEANUP_FAILED",
      "CANCELLING", "CLEANUP",
    ].includes(record.state)) {
      return record;
    }
    return this.assessments.transition({
      assessmentId: record.id,
      expectedVersion: record.version,
      event: "CANCEL_REQUEST",
      reason: "product cancellation requested",
      actor: "product-service",
      correlationId: record.correlationId,
      at: new Date().toISOString(),
    });
  }

  async evidence(
    session: ProductSession,
    assessmentId: string,
  ) {
    const eligible = await this.eligible(session);
    const record = await this.ownAssessment(eligible, assessmentId);
    const index = await this.assessmentEvidence.list(readScope(eligible), record.id);
    return {
      assessmentId: record.id,
      admissions: index.admissions,
      evidence: index.evidence,
      scannerExecutionAvailable: false,
    };
  }
}
