import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ProductAssessmentAdmissionRequest, SecurityAssessmentAdmissionReceipt } from "../../../src/shared/securityAssessment";
import type { ProductContextAdapter } from "../../src/server/product/adapters/workspace";
import { MemorySecurityAssessmentRepository, PostgresSecurityAssessmentRepository } from "../../src/server/product/security/assessment";
import { canonicalSnapshot } from "../../src/server/product/security/assessment/snapshot";
import type { SecurityAssessmentAdmissionAdapter } from "../../src/server/product/security/bridge";
import { MemorySecurityAssessmentEvidenceStore } from "../../src/server/product/security/evidence";
import { readProductMigrationsThroughBe9 } from "../../src/server/product/security/migrations";
import { SecurityAssessmentService } from "../../src/server/product/security/service";
import { MemorySecurityDiscoveryStore, PostgresSecurityDiscoveryStore } from "../../src/server/product/security/store";
import type { PrincipalMappingAdapter } from "../../src/server/product/principal/adapter";
import type { ProductSession, ProductWorkspace } from "../../src/server/product/identity/types";
import type { QueryExecutor, QueryResultLike, TransactionPool } from "../../src/server/product/data/db";
import type { SecurityDiscoveryResult } from "../../src/server/product/security/types";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ORG_A = "33333333-3333-4333-8333-333333333333";
const ORG_B = "44444444-4444-4444-8444-444444444444";
const WS_A = "55555555-5555-4555-8555-555555555555";
const WS_B = "66666666-6666-4666-8666-666666666666";
const REV = "7".repeat(40);

function stable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stable((value as Record<string, unknown>)[key]);
  }
  return out;
}

function receipt(
  request: ProductAssessmentAdmissionRequest,
  decision: SecurityAssessmentAdmissionReceipt["decision"] = "ADMITTED",
): SecurityAssessmentAdmissionReceipt {
  const decisionAt = new Date(new Date(request.requestedAt).getTime() + 1).toISOString();
  const unsigned: Omit<SecurityAssessmentAdmissionReceipt, "admissionReceiptDigest"> = {
    schemaVersion: "BE9_ADMISSION_RECEIPT_V1",
    bridgeRequestId: request.bridgeRequestId,
    assessmentId: request.assessmentId,
    assessmentVersion: request.assessmentVersion,
    correlationId: request.correlationId,
    decision,
    decisionCode: decision === "ADMITTED" ? "ADMISSION_OK" : "EXECUTION_RESOURCE_BUSY",
    decisionAt,
    decisionExpiresAt: new Date(new Date(decisionAt).getTime() + 30_000).toISOString(),
    policyVersion: "BE9_ADMISSION_POLICY_V1",
    resourceClass: "STATIC_SOURCE",
    networkClass: "NONE",
    credentialClass: "NONE",
    ...(decision === "ADMITTED"
      ? {
          resolvedPrincipalId: request.principalRef,
          resolvedProjectId: request.projectId,
          ...(request.targetId ? { resolvedTargetId: request.targetId } : {}),
          resolvedSourceRevision: request.expectedSourceRevision,
        }
      : {}),
  };
  return {
    ...unsigned,
    admissionReceiptDigest: createHash("sha256")
      .update(JSON.stringify(stable(unsigned)))
      .digest("hex"),
  };
}

function discovery(id: string, projectId = "project-a"): SecurityDiscoveryResult {
  return {
    discoveryId: id,
    projectId,
    sourceRevision: REV,
    detectorVersion: "BE8_STATIC_DISCOVERY_V1",
    readOnly: true,
    detected: [],
    unsupported: [],
    unknown: false,
    incomplete: false,
    safety: {
      packageScriptsExecuted: false,
      networkUsed: false,
      dependencyInstallAttempted: false,
      arbitraryHostPathsAccepted: false,
    },
  };
}

function session(
  userRef: string,
  workspace: ProductWorkspace,
  principalRef: string,
  mappingVersion = 1,
): ProductSession {
  return {
    id: `sid-${userRef}`,
    identity: { userRef, subject: `sub-${userRef}` },
    workspace,
    version: 1,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    correlationId: `corr-${workspace.id.slice(0, 8)}`,
    csrfToken: "csrf",
    principalMapping: { state: "mapped-reference", principalRef, mappingVersion },
    oidcTokens: {},
  };
}

class Admission implements SecurityAssessmentAdmissionAdapter {
  async admit(request: ProductAssessmentAdmissionRequest): Promise<SecurityAssessmentAdmissionReceipt> {
    return receipt(request);
  }
}

class EmptyDb implements QueryExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  async query<T>(text: string, values: readonly unknown[] = []): Promise<QueryResultLike<T>> {
    this.calls.push({ text, values });
    return { rows: [], rowCount: 0 } as QueryResultLike<T>;
  }
}

describe("BE9.2 durable assessment platform", () => {
  it("composes the accepted migration chain through the uniquely owned 0007 schema", async () => {
    const migrations = await readProductMigrationsThroughBe9();
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(migrations.at(-1)?.name).toBe("0007_security_assessments.sql");
    expect(migrations.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum))).toBe(true);

    const sql = readFileSync(
      join(process.cwd(), "src/server/product/security/migrations/0007_security_assessments.sql"),
      "utf8",
    );
    for (const table of [
      "security_discoveries",
      "security_assessments",
      "security_assessment_transitions",
      "security_assessment_admission_receipts",
      "security_assessment_evidence",
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(sql).toContain("security_assessments_recovery_idx");
    expect(sql).toContain("PREPARATION_ABORT_REQUIRING_CLEANUP");
    expect(sql).toContain("FOREIGN KEY (workspace_id, organization_id)");
    expect(sql).not.toMatch(/password|access_token|refresh_token|private_key|secret_value|raw_scanner_output/i);
  });

  it("rejects untrusted durable binding enums and discovery column/snapshot drift", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const disc = discovery(`disc_${"9".repeat(24)}`);
    const plan = {
      planId: `plan_${"8".repeat(24)}`,
      projectId: disc.projectId,
      sourceRevision: disc.sourceRevision,
      detectedStack: [],
      selectedCapabilities: [],
      prerequisites: [],
      environmentRequirements: [],
      ordering: [],
      expectedEvidenceTypes: [],
      safetyClassification: "NON_DESTRUCTIVE_STATIC_PLAN" as const,
      destructiveClassification: "NON_DESTRUCTIVE" as const,
      networkRequirements: "NONE_FOR_BE8_PLAN" as const,
      credentialRequirements: "NONE_FOR_BE8_PLAN" as const,
      unsupported: [],
      unavailableSteps: [],
      provenance: {
        plannerVersion: "BE8_SECURITY_PLANNER_V1" as const,
        discoveryId: disc.discoveryId,
        sourceRevision: disc.sourceRevision,
      },
      executionAuthority: false as const,
    };
    await expect(repo.create({
      assessmentId: `assessment_${"7".repeat(24)}`,
      owner: {
        productUserId: USER_A,
        organizationId: ORG_A,
        workspaceId: WS_A,
        principalRef: "principal-a",
        principalMappingVersion: 1,
      },
      binding: {
        projectId: disc.projectId,
        sourceRevision: disc.sourceRevision,
        assessmentIntent: "attacker-defined" as never,
      },
      discoveryId: disc.discoveryId,
      planId: plan.planId,
      discoverySnapshot: disc,
      planSnapshot: plan,
      requestedAt: "2026-09-27T20:00:00.000Z",
      correlationId: "corr-a",
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    const snap = canonicalSnapshot(disc);
    const db: QueryExecutor = {
      async query<T>() {
        return {
          rows: [{
            discovery_id: disc.discoveryId,
            product_user_id: USER_A,
            organization_id: ORG_A,
            workspace_id: WS_A,
            principal_ref: "principal-a",
            principal_mapping_version: 1,
            project_id: "project-tampered",
            target_id: null,
            source_revision: disc.sourceRevision,
            snapshot_schema_version: "BE9_DISCOVERY_SNAPSHOT_V1",
            snapshot_json: disc,
            snapshot_digest_sha256: snap.digest,
            snapshot_byte_length: snap.byteLength,
          }] as T[],
          rowCount: 1,
        };
      },
    };
    await expect(new PostgresSecurityDiscoveryStore(db).get(disc.discoveryId))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
  });

  it("production runtime is wired to Postgres discovery, assessment, and evidence stores", () => {
    const source = readFileSync(
      join(process.cwd(), "src/server/product/security/runtime.ts"),
      "utf8",
    );
    expect(source).toContain("new PostgresSecurityDiscoveryStore(pool)");
    expect(source).toContain("new PostgresSecurityAssessmentRepository(pool)");
    expect(source).toContain("new PostgresSecurityAssessmentEvidenceStore(pool)");
    expect(source).toContain("new HttpSecurityAssessmentAdmissionAdapter()");
  });

  it("Postgres discovery and assessment reads bind queries to durable identity scope", async () => {
    const discoveryDb = new EmptyDb();
    await expect(new PostgresSecurityDiscoveryStore(discoveryDb).getForPrincipal(
      `disc_${"a".repeat(24)}`,
      "principal-a",
    )).resolves.toBeUndefined();
    expect(discoveryDb.calls[0]?.values).toEqual([`disc_${"a".repeat(24)}`]);

    const assessmentDb = new EmptyDb();
    await expect(new PostgresSecurityAssessmentRepository(assessmentDb as unknown as TransactionPool).read(
      {
        productUserId: USER_A,
        organizationId: ORG_A,
        workspaceId: WS_A,
        principalRef: "principal-a",
      },
      `assessment_${"b".repeat(24)}`,
    )).resolves.toBeUndefined();
    expect(assessmentDb.calls[0]?.values).toEqual([
      `assessment_${"b".repeat(24)}`,
      USER_A,
      ORG_A,
      WS_A,
      "principal-a",
    ]);
    expect(assessmentDb.calls[0]?.text).toContain("product_user_id = $2");
    expect(assessmentDb.calls[0]?.text).toContain("organization_id = $3");
    expect(assessmentDb.calls[0]?.text).toContain("workspace_id = $4");
    expect(assessmentDb.calls[0]?.text).toContain("principal_ref = $5");
  });

  it("uses one assessment service for product create/read/cancel/evidence with concealment-safe tenant reads", async () => {
    const workspaces = new Map<string, ProductWorkspace>([
      [USER_A, { id: WS_A, organizationId: ORG_A, name: "A" }],
      [USER_B, { id: WS_B, organizationId: ORG_B, name: "B" }],
    ]);
    const context: ProductContextAdapter = {
      async resolveIdentity(_issuer, identity) { return identity; },
      async workspaceForUser(userRef, workspaceId) {
        const value = workspaces.get(userRef);
        return value?.id === workspaceId ? value : undefined;
      },
    };
    const mappings = new Map<string, { principalRef: string; mappingVersion: number }>([
      [USER_A, { principalRef: "principal-a", mappingVersion: 1 }],
      [USER_B, { principalRef: "principal-b", mappingVersion: 1 }],
    ]);
    const principalMappings: PrincipalMappingAdapter = {
      async resolve(input) {
        const value = mappings.get(input.productUserId);
        if (!value || (input.expectedMappingVersion !== undefined
          && input.expectedMappingVersion !== value.mappingVersion)) return { state: "forbidden" };
        return { state: "mapped-reference", ...value };
      },
    };
    const discoveries = new MemorySecurityDiscoveryStore();
    const discoveryId = `disc_${"c".repeat(24)}`;
    await discoveries.put({
      productUserId: USER_A,
      organizationId: ORG_A,
      workspaceId: WS_A,
      principalRef: "principal-a",
      principalMappingVersion: 1,
      result: discovery(discoveryId),
    });
    const service = new SecurityAssessmentService(
      context,
      principalMappings,
      {} as never,
      discoveries,
      new MemorySecurityAssessmentRepository(),
      new Admission(),
      new MemorySecurityAssessmentEvidenceStore(),
    );
    const workspaceA = workspaces.get(USER_A);
    const workspaceB = workspaces.get(USER_B);
    if (!workspaceA || !workspaceB) throw new Error("test workspace fixture missing");
    const sessionA = session(USER_A, workspaceA, "principal-a");
    const sessionB = session(USER_B, workspaceB, "principal-b");

    const created = await service.createAssessment(sessionA, discoveryId);
    expect(created.state).toBe("ADMITTED");
    await expect(service.assessment(sessionA, created.id)).resolves.toMatchObject({ id: created.id });
    await expect(service.evidence(sessionA, created.id)).resolves.toMatchObject({
      assessmentId: created.id,
      scannerExecutionAvailable: false,
    });
    await expect(service.assessment(sessionB, created.id)).rejects.toMatchObject({
      code: "PRODUCT_DATA_NOT_FOUND",
    });

    const cancelled = await service.cancelAssessment(sessionA, created.id);
    expect(cancelled.state).toBe("CANCELLING");
  });

  it("revalidates membership and Principal mapping rather than trusting stale product state", async () => {
    let membership = true;
    let mappingVersion = 1;
    const workspace = { id: WS_A, organizationId: ORG_A, name: "A" };
    const context: ProductContextAdapter = {
      async resolveIdentity(_issuer, identity) { return identity; },
      async workspaceForUser(userRef, workspaceId) {
        return membership && userRef === USER_A && workspaceId === WS_A ? workspace : undefined;
      },
    };
    const principalMappings: PrincipalMappingAdapter = {
      async resolve(input) {
        if (input.expectedMappingVersion !== undefined && input.expectedMappingVersion !== mappingVersion) {
          return { state: "forbidden" };
        }
        return { state: "mapped-reference", principalRef: "principal-a", mappingVersion };
      },
    };
    const discoveries = new MemorySecurityDiscoveryStore();
    const discoveryId = `disc_${"d".repeat(24)}`;
    await discoveries.put({
      productUserId: USER_A,
      organizationId: ORG_A,
      workspaceId: WS_A,
      principalRef: "principal-a",
      principalMappingVersion: 1,
      result: discovery(discoveryId),
    });
    const service = new SecurityAssessmentService(
      context,
      principalMappings,
      {} as never,
      discoveries,
      new MemorySecurityAssessmentRepository(),
      new Admission(),
      new MemorySecurityAssessmentEvidenceStore(),
    );
    const current = session(USER_A, workspace, "principal-a");
    const created = await service.createAssessment(current, discoveryId);

    membership = false;
    await expect(service.assessment(current, created.id)).rejects.toThrow("security_forbidden");

    membership = true;
    mappingVersion = 2;
    await expect(service.assessment(current, created.id)).rejects.toThrow("security_forbidden");
  });

  it("never infers the first workspace when one Principal is linked to two workspaces", async () => {
    const sharedPrincipal = "principal-shared";
    const workspaceA = { id: WS_A, organizationId: ORG_A, name: "A" };
    const workspaceB = { id: WS_B, organizationId: ORG_B, name: "B" };
    const membership = new Map<string, ProductWorkspace>([
      [`${USER_A}:${WS_A}`, workspaceA],
      [`${USER_B}:${WS_B}`, workspaceB],
    ]);
    const context: ProductContextAdapter = {
      async resolveIdentity(_issuer, identity) { return identity; },
      async workspaceForUser(userRef, workspaceId) {
        return membership.get(`${userRef}:${workspaceId}`);
      },
    };
    const principalMappings: PrincipalMappingAdapter = {
      async resolve(input) {
        return {
          state: "mapped-reference",
          principalRef: sharedPrincipal,
          mappingVersion: input.expectedMappingVersion ?? 1,
        };
      },
    };
    const discoveries = new MemorySecurityDiscoveryStore();
    const discA = `disc_${"e".repeat(24)}`;
    const discB = `disc_${"f".repeat(24)}`;
    await discoveries.put({
      productUserId: USER_A,
      organizationId: ORG_A,
      workspaceId: WS_A,
      principalRef: sharedPrincipal,
      principalMappingVersion: 1,
      result: discovery(discA, "project-a"),
    });
    await discoveries.put({
      productUserId: USER_B,
      organizationId: ORG_B,
      workspaceId: WS_B,
      principalRef: sharedPrincipal,
      principalMappingVersion: 1,
      result: discovery(discB, "project-b"),
    });
    const service = new SecurityAssessmentService(
      context,
      principalMappings,
      {} as never,
      discoveries,
      new MemorySecurityAssessmentRepository(),
      new Admission(),
      new MemorySecurityAssessmentEvidenceStore(),
    );

    const bindingB = await service.createOperationalIntent(sharedPrincipal, discB, "corr-mcp-b");
    const recordB = await service.operationalAssessment(sharedPrincipal, bindingB.assessmentId);
    expect(recordB.owner).toMatchObject({
      productUserId: USER_B,
      organizationId: ORG_B,
      workspaceId: WS_B,
      principalRef: sharedPrincipal,
    });
    expect(recordB.binding.projectId).toBe("project-b");

    const bindingA = await service.createOperationalIntent(sharedPrincipal, discA, "corr-mcp-a");
    const recordA = await service.operationalAssessment(sharedPrincipal, bindingA.assessmentId);
    expect(recordA.owner.workspaceId).toBe(WS_A);
    expect(recordA.binding.projectId).toBe("project-a");
  });
});
