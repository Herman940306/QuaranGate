import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ProductDataError } from "../../src/server/product/data/errors";
import { MemorySecurityAssessmentRepository } from "../../src/server/product/security/assessment/repository";
import { canonicalSnapshot } from "../../src/server/product/security/assessment/snapshot";
import {
  BE9_ASSESSMENT_EVENTS,
  resolveAssessmentEvent,
} from "../../src/server/product/security/assessment/state";
import {
  BE9_ASSESSMENT_STATES,
  BE9_TERMINAL_STATES,
  type SecurityAssessmentEvent,
  type SecurityAssessmentPendingOutcome,
  type SecurityAssessmentRecord,
  type SecurityAssessmentState,
} from "../../src/server/product/security/assessment/types";
import type {
  SecurityAssessmentPlan,
  SecurityDiscoveryResult,
} from "../../src/server/product/security/types";

const REV = "324abd6da9360197b3af28bfcc95fc7c987a1cdd";
const OTHER_REV = "0".repeat(40);
const owner = {
  productUserId: "user-a",
  organizationId: "org-a",
  workspaceId: "ws-a",
  principalRef: "principal-a",
  principalMappingVersion: 3,
};
const binding = {
  projectId: "project-a",
  targetId: "target-a",
  sourceRevision: REV,
  assessmentIntent: "source" as const,
};

const discovery: SecurityDiscoveryResult = {
  discoveryId: "disc_0123456789abcdef01234567",
  projectId: binding.projectId,
  targetId: binding.targetId,
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

const plan: SecurityAssessmentPlan = {
  planId: "plan_0123456789abcdef01234567",
  projectId: binding.projectId,
  targetId: binding.targetId,
  sourceRevision: REV,
  detectedStack: [],
  selectedCapabilities: [
    {
      capabilityId: "SAST",
      state: "APPLICABLE",
      reason: "test fixture",
      evidence: [],
    },
  ],
  prerequisites: [],
  environmentRequirements: [],
  ordering: ["SAST"],
  expectedEvidenceTypes: ["SAST"],
  safetyClassification: "NON_DESTRUCTIVE_STATIC_PLAN",
  destructiveClassification: "NON_DESTRUCTIVE",
  networkRequirements: "NONE_FOR_BE8_PLAN",
  credentialRequirements: "NONE_FOR_BE8_PLAN",
  unsupported: [],
  unavailableSteps: [],
  provenance: {
    plannerVersion: "BE8_SECURITY_PLANNER_V1",
    discoveryId: discovery.discoveryId,
    sourceRevision: REV,
  },
  executionAuthority: false,
};

function createInput(id = "assessment-a") {
  return {
    assessmentId: id,
    owner,
    binding,
    discoveryId: discovery.discoveryId,
    planId: plan.planId,
    discoverySnapshot: discovery,
    planSnapshot: plan,
    requestedAt: "2026-09-27T05:00:00.000Z",
    correlationId: "corr-a",
  };
}

function recordAt(
  state: SecurityAssessmentState,
  version = 7,
  pendingOutcome?: SecurityAssessmentPendingOutcome,
): SecurityAssessmentRecord {
  const defaultPending: Partial<Record<SecurityAssessmentState, SecurityAssessmentPendingOutcome>> = {
    CLEANUP: "FAILED_INFRASTRUCTURE",
    COMPLETED: "SUCCESS",
    FAILED_TOOL: "FAILED_TOOL",
    FAILED_TIMEOUT: "FAILED_TIMEOUT",
    CLEANUP_FAILED: "FAILED_INFRASTRUCTURE",
  };
  const effectivePending = pendingOutcome ?? defaultPending[state];

  return {
    id: `assessment-${state.toLowerCase().replaceAll("_", "-")}`,
    owner,
    binding,
    discoveryId: discovery.discoveryId,
    planId: plan.planId,
    discoverySnapshot: canonicalSnapshot(discovery),
    planSnapshot: canonicalSnapshot(plan),
    state,
    version,
    ...(effectivePending ? { pendingOutcome: effectivePending } : {}),
    requestedAt: "2026-09-27T05:00:00.000Z",
    updatedAt: "2026-09-27T05:00:00.000Z",
    correlationId: "corr-a",
    transitionLog: [],
  };
}

function transitionAt(record: SecurityAssessmentRecord, index: number) {
  const entry = record.transitionLog[index];
  if (!entry) throw new Error(`missing_transition_${index}`);
  return entry;
}

function transitionInput(record: SecurityAssessmentRecord, event: SecurityAssessmentEvent) {
  return {
    assessmentId: record.id,
    expectedVersion: record.version,
    event,
    reason: "test",
    actor: "worker" as const,
    correlationId: "corr-t",
    at: "2026-09-27T05:01:00.000Z",
  };
}

describe("BE9.1 assessment lifecycle foundation", () => {
  it("uses the exact closed lifecycle vocabulary", () => {
    expect(BE9_ASSESSMENT_STATES).toEqual([
      "PLANNED",
      "ADMITTED",
      "PREPARING",
      "RUNNING",
      "CANCELLING",
      "CLEANUP",
      "COMPLETED",
      "FAILED_POLICY",
      "FAILED_PRECONDITION",
      "FAILED_TOOL",
      "FAILED_TIMEOUT",
      "FAILED_INFRASTRUCTURE",
      "CANCELLED",
      "CLEANUP_FAILED",
    ]);
  });

  it("creates PLANNED assessments from the real BE8 discovery and plan shape", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput());
    expect(created.state).toBe("PLANNED");
    expect(created.version).toBe(0);
    expect(created.owner).toEqual(owner);
    expect(created.binding).toEqual(binding);
    expect(created.discoverySnapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(created.planSnapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(created.planSnapshot.value).toMatchObject({
      planId: plan.planId,
      projectId: binding.projectId,
      targetId: binding.targetId,
      sourceRevision: REV,
      provenance: {
        discoveryId: discovery.discoveryId,
        sourceRevision: REV,
      },
      executionAuthority: false,
    });
  });

  it.each([
    ["discovery identity", { discoverySnapshot: { ...discovery, discoveryId: "disc_other" } }],
    ["plan identity", { planSnapshot: { ...plan, planId: "plan_other" } }],
    ["plan provenance discovery", { planSnapshot: { ...plan, provenance: { ...plan.provenance, discoveryId: "disc_other" } } }],
    ["discovery project", { discoverySnapshot: { ...discovery, projectId: "project-b" } }],
    ["plan project", { planSnapshot: { ...plan, projectId: "project-b" } }],
    ["discovery target", { discoverySnapshot: { ...discovery, targetId: "target-b" } }],
    ["plan target", { planSnapshot: { ...plan, targetId: "target-b" } }],
    ["discovery revision", { discoverySnapshot: { ...discovery, sourceRevision: OTHER_REV } }],
    ["plan revision", { planSnapshot: { ...plan, sourceRevision: OTHER_REV } }],
    ["plan provenance revision", { planSnapshot: { ...plan, provenance: { ...plan.provenance, sourceRevision: OTHER_REV } } }],
    ["execution authority escalation", { planSnapshot: { ...plan, executionAuthority: true } as unknown as SecurityAssessmentPlan }],
  ])("rejects %s substitution before assessment creation", async (_name, patch) => {
    const repo = new MemorySecurityAssessmentRepository();
    await expect(repo.create({ ...createInput(`assessment-${_name.toString().replaceAll(" ", "-")}`), ...patch }))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
  });

  const eventCases: Array<{
    state: SecurityAssessmentState;
    event: SecurityAssessmentEvent;
    next: SecurityAssessmentState;
    pending?: SecurityAssessmentPendingOutcome;
  }> = [
    { state: "PLANNED", event: "ADMISSION_REVALIDATION_PASS", next: "ADMITTED" },
    { state: "PLANNED", event: "ADMISSION_POLICY_DENIED", next: "FAILED_POLICY" },
    { state: "PLANNED", event: "ADMISSION_PRECONDITION_FAILED", next: "FAILED_PRECONDITION" },
    { state: "PLANNED", event: "ADMISSION_TEMPORARILY_UNAVAILABLE", next: "PLANNED" },
    { state: "PLANNED", event: "CANCEL_REQUEST", next: "CANCELLED" },
    { state: "ADMITTED", event: "PREPARE_BEGIN", next: "PREPARING" },
    { state: "ADMITTED", event: "CANCEL_REQUEST", next: "CANCELLING" },
    { state: "ADMITTED", event: "PREPARATION_INFRASTRUCTURE_FAILURE_NO_RESOURCES", next: "FAILED_INFRASTRUCTURE" },
    { state: "ADMITTED", event: "PREPARATION_INFRASTRUCTURE_FAILURE_WITH_RESOURCES", next: "CLEANUP", pending: "FAILED_INFRASTRUCTURE" },
    { state: "PREPARING", event: "PREPARATION_COMPLETE", next: "RUNNING" },
    { state: "PREPARING", event: "CANCEL_REQUEST", next: "CANCELLING" },
    { state: "PREPARING", event: "PRECONDITION_DRIFT_NO_RESOURCES", next: "FAILED_PRECONDITION" },
    { state: "PREPARING", event: "PRECONDITION_DRIFT_WITH_RESOURCES", next: "CLEANUP", pending: "FAILED_PRECONDITION" },
    { state: "PREPARING", event: "PREPARATION_INFRASTRUCTURE_FAILURE_NO_RESOURCES", next: "FAILED_INFRASTRUCTURE" },
    { state: "PREPARING", event: "PREPARATION_INFRASTRUCTURE_FAILURE_WITH_RESOURCES", next: "CLEANUP", pending: "FAILED_INFRASTRUCTURE" },
    { state: "RUNNING", event: "TOOL_SUCCESS", next: "CLEANUP", pending: "SUCCESS" },
    { state: "RUNNING", event: "TOOL_FAILURE", next: "CLEANUP", pending: "FAILED_TOOL" },
    { state: "RUNNING", event: "EXECUTION_TIMEOUT", next: "CLEANUP", pending: "FAILED_TIMEOUT" },
    { state: "RUNNING", event: "EXECUTION_INFRASTRUCTURE_FAILURE", next: "CLEANUP", pending: "FAILED_INFRASTRUCTURE" },
    { state: "RUNNING", event: "CANCEL_REQUEST", next: "CANCELLING" },
    { state: "CANCELLING", event: "EXECUTION_STOPPED_OR_ABSENT", next: "CLEANUP", pending: "CANCELLED" },
    { state: "CANCELLING", event: "STOP_STATE_AMBIGUOUS", next: "CLEANUP", pending: "FAILED_INFRASTRUCTURE" },
  ];

  it.each(eventCases)(
    "derives $state + $event as $next rather than accepting caller-selected state/outcome",
    async ({ state, event, next, pending }) => {
      const record = recordAt(state);
      const repo = new MemorySecurityAssessmentRepository([record]);
      const updated = await repo.transition(transitionInput(record, event));
      expect(updated.state).toBe(next);
      expect(updated.pendingOutcome).toBe(pending);
      expect(updated.version).toBe(record.version + 1);
      expect(updated.transitionLog.at(-1)).toMatchObject({
        priorState: state,
        event,
        nextState: next,
        version: record.version + 1,
        correlationId: "corr-t",
      });
    },
  );

  it("rejects events outside the frozen source-state contract without writing state", async () => {
    const allowed = new Set(eventCases.map(({ state, event }) => `${state}:${event}`));
    const cleanupEvents = new Set(["CLEANUP_PROVEN", "EVIDENCE_FINALIZATION_FAILED", "CLEANUP_NOT_PROVABLE"]);

    for (const state of BE9_ASSESSMENT_STATES) {
      if (BE9_TERMINAL_STATES.includes(state as never)) continue;
      for (const event of BE9_ASSESSMENT_EVENTS) {
        if (allowed.has(`${state}:${event}`)) continue;
        if (state === "CLEANUP" && cleanupEvents.has(event)) continue;
        const record = recordAt(state);
        const repo = new MemorySecurityAssessmentRepository([record]);
        await expect(repo.transition(transitionInput(record, event))).rejects.toBeInstanceOf(ProductDataError);
        await expect(repo.read(owner, record.id)).resolves.toMatchObject({ state, version: record.version });
      }
    }
  });

  it("makes SUCCESS unreachable from ADMITTED or PREPARING", () => {
    expect(() => resolveAssessmentEvent("ADMITTED", "TOOL_SUCCESS")).toThrow(ProductDataError);
    expect(() => resolveAssessmentEvent("PREPARING", "TOOL_SUCCESS")).toThrow(ProductDataError);
  });

  it.each([
    ["SUCCESS", "COMPLETED"],
    ["CANCELLED", "CANCELLED"],
    ["FAILED_PRECONDITION", "FAILED_PRECONDITION"],
    ["FAILED_TOOL", "FAILED_TOOL"],
    ["FAILED_TIMEOUT", "FAILED_TIMEOUT"],
    ["FAILED_INFRASTRUCTURE", "FAILED_INFRASTRUCTURE"],
  ] as Array<[SecurityAssessmentPendingOutcome, SecurityAssessmentState]>)(
    "derives CLEANUP_PROVEN with %s as %s",
    async (pendingOutcome, expectedState) => {
      const record = recordAt("CLEANUP", 7, pendingOutcome);
      const repo = new MemorySecurityAssessmentRepository([record]);
      const updated = await repo.transition(transitionInput(record, "CLEANUP_PROVEN"));
      expect(updated.state).toBe(expectedState);
      expect(updated.pendingOutcome).toBe(pendingOutcome);
    },
  );

  it("refuses durable CLEANUP state when no execution/cancellation/failure outcome exists", () => {
    const invalid = recordAt("CLEANUP");
    delete invalid.pendingOutcome;
    expect(() => new MemorySecurityAssessmentRepository([invalid]))
      .toThrowError(ProductDataError);
  });

  it("maps evidence-finalization failure to FAILED_INFRASTRUCTURE after cleanup proof", async () => {
    const record = recordAt("CLEANUP", 7, "SUCCESS");
    const repo = new MemorySecurityAssessmentRepository([record]);
    const updated = await repo.transition(transitionInput(record, "EVIDENCE_FINALIZATION_FAILED"));
    expect(updated.state).toBe("FAILED_INFRASTRUCTURE");
    expect(updated.pendingOutcome).toBe("SUCCESS");
  });

  it("maps unprovable cleanup to CLEANUP_FAILED and never ordinary success", async () => {
    const record = recordAt("CLEANUP", 7, "SUCCESS");
    const repo = new MemorySecurityAssessmentRepository([record]);
    const updated = await repo.transition(transitionInput(record, "CLEANUP_NOT_PROVABLE"));
    expect(updated.state).toBe("CLEANUP_FAILED");
    expect(updated.pendingOutcome).toBe("SUCCESS");
  });

  it("keeps terminal states immutable for every event", async () => {
    for (const state of BE9_TERMINAL_STATES) {
      for (const event of BE9_ASSESSMENT_EVENTS) {
        const record = recordAt(state);
        const repo = new MemorySecurityAssessmentRepository([record]);
        await expect(repo.transition(transitionInput(record, event))).rejects.toMatchObject({
          code: "PRODUCT_DATA_STALE_VERSION",
        });
      }
    }
  });

  it("isolates tenant, user, workspace and Principal scoped reads", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput());
    await expect(repo.read(owner, created.id)).resolves.toMatchObject({ id: created.id });
    await expect(repo.read({ ...owner, productUserId: "user-b" }, created.id)).rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
    await expect(repo.read({ ...owner, organizationId: "org-b" }, created.id)).rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
    await expect(repo.read({ ...owner, workspaceId: "ws-b" }, created.id)).rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
    await expect(repo.read({ ...owner, principalRef: "principal-b" }, created.id)).rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
  });

  it("preserves immutable snapshot digests across idempotent reads and reload", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput());
    const read1 = await repo.read(owner, created.id);
    const read2 = await repo.read(owner, created.id);
    expect(read1).toEqual(read2);
    if (!read1) throw new Error("missing_assessment");
    read1.discoverySnapshot.value = { ...discovery, projectId: "tampered" };
    await expect(repo.read(owner, created.id)).resolves.toMatchObject({
      discoverySnapshot: { digest: created.discoverySnapshot.digest },
    });
    const reloaded = new MemorySecurityAssessmentRepository(repo.exportForRestart());
    await expect(reloaded.read(owner, created.id)).resolves.toMatchObject({
      state: "PLANNED",
      discoverySnapshot: { digest: created.discoverySnapshot.digest },
      planSnapshot: { digest: created.planSnapshot.digest },
    });
  });

  it("rejects invalid and stale versions without writing lifecycle state", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput());
    await expect(repo.transition({
      ...transitionInput(created, "ADMISSION_REVALIDATION_PASS"),
      expectedVersion: 99,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_STALE_VERSION" });
    await expect(repo.read(owner, created.id)).resolves.toMatchObject({ state: "PLANNED", version: 0 });
  });

  it("rejects sensitive material in snapshots", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    await expect(repo.create({
      ...createInput("assessment-sensitive"),
      discoverySnapshot: { ...discovery, apiKey: "not-for-db" } as unknown as SecurityDiscoveryResult,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
  });

  it("rejects unknown BE8 top-level/provenance fields instead of silently schema-upgrading", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    await expect(repo.create({
      ...createInput("assessment-discovery-unknown"),
      discoverySnapshot: { ...discovery, unexpectedAuthority: false } as unknown as SecurityDiscoveryResult,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    await expect(repo.create({
      ...createInput("assessment-plan-unknown"),
      planSnapshot: { ...plan, unexpectedAuthority: false } as unknown as SecurityAssessmentPlan,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    await expect(repo.create({
      ...createInput("assessment-provenance-unknown"),
      planSnapshot: {
        ...plan,
        provenance: { ...plan.provenance, unexpectedAuthority: false },
      } as unknown as SecurityAssessmentPlan,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
  });

  it("rejects unknown nested BE8 detector and capability fields", async () => {
    const repo = new MemorySecurityAssessmentRepository();

    await expect(repo.create({
      ...createInput("assessment-nested-discovery-unknown"),
      discoverySnapshot: {
        ...discovery,
        detected: [{
          id: "typescript",
          label: "TypeScript",
          family: "language",
          confidence: "HIGH",
          provenance: [{
            sourceType: "manifest",
            path: "package.json",
            confidence: "HIGH",
            detectorVersion: "BE8_STATIC_DISCOVERY_V1",
            unexpectedAuthority: false,
          }],
        }],
      } as unknown as SecurityDiscoveryResult,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    const baseCapability = plan.selectedCapabilities[0];
    if (!baseCapability) throw new Error("missing_capability_fixture");
    await expect(repo.create({
      ...createInput("assessment-nested-capability-unknown"),
      planSnapshot: {
        ...plan,
        selectedCapabilities: [{
          ...baseCapability,
          unexpectedAuthority: false,
        }],
      } as unknown as SecurityAssessmentPlan,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    await expect(repo.create({
      ...createInput("assessment-nested-enum-invalid"),
      discoverySnapshot: {
        ...discovery,
        detected: [{
          id: "typescript",
          label: "TypeScript",
          family: "unexpected-family",
          confidence: "HIGH",
          provenance: [],
        }],
      } as unknown as SecurityDiscoveryResult,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
  });

  it("rejects non-JSON snapshot values before canonical hashing", () => {
    expect(() => canonicalSnapshot({ safe: "value", dropped: undefined }))
      .toThrowError(ProductDataError);
    expect(() => canonicalSnapshot({ safe: Number.NaN }))
      .toThrowError(ProductDataError);
    expect(() => canonicalSnapshot({ safe: new Date("2026-09-27T05:00:00.000Z") }))
      .toThrowError(ProductDataError);
  });

  it("accepts the full BE3 principalRef length contract instead of narrowing authority linkage", async () => {
    const principalRef = "p".repeat(200);
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create({
      ...createInput("assessment-long-principal"),
      owner: { ...owner, principalRef },
    });
    await expect(repo.read({ ...owner, principalRef }, created.id))
      .resolves.toMatchObject({ owner: { principalRef } });
  });

  it("rejects malformed transition metadata before writing durable state", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput("assessment-transition-metadata"));

    await expect(repo.transition({
      ...transitionInput(created, "ADMISSION_REVALIDATION_PASS"),
      reason: "",
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    await expect(repo.transition({
      ...transitionInput(created, "ADMISSION_REVALIDATION_PASS"),
      correlationId: "bad correlation with spaces",
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    await expect(repo.transition({
      ...transitionInput(created, "ADMISSION_REVALIDATION_PASS"),
      at: "not-a-time",
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    await expect(repo.transition({
      ...transitionInput(created, "ADMISSION_REVALIDATION_PASS"),
      actor: "browser" as never,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    await expect(repo.read(owner, created.id))
      .resolves.toMatchObject({ state: "PLANNED", version: 0 });
  });

  it("rejects backward lifecycle timestamps without changing durable state", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput("assessment-time-regression"));

    await expect(repo.transition({
      ...transitionInput(created, "ADMISSION_REVALIDATION_PASS"),
      at: "2026-09-27T04:59:59.000Z",
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });

    await expect(repo.read(owner, created.id))
      .resolves.toMatchObject({ state: "PLANNED", version: 0 });
  });

  it("rejects contradictory terminal pending outcomes on restart", () => {
    const cancelled = recordAt("CANCELLED");
    cancelled.pendingOutcome = "FAILED_TIMEOUT";
    expect(() => new MemorySecurityAssessmentRepository([cancelled]))
      .toThrowError(ProductDataError);

    const precondition = recordAt("FAILED_PRECONDITION");
    precondition.pendingOutcome = "SUCCESS";
    expect(() => new MemorySecurityAssessmentRepository([precondition]))
      .toThrowError(ProductDataError);

    const cleanupFailed = recordAt("CLEANUP_FAILED");
    delete cleanupFailed.pendingOutcome;
    expect(() => new MemorySecurityAssessmentRepository([cleanupFailed]))
      .toThrowError(ProductDataError);
  });

  it("rejects corrupted persisted transition-journal suffixes", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput("assessment-journal"));
    const admitted = await repo.transition(transitionInput(created, "ADMISSION_REVALIDATION_PASS"));
    await repo.transition({
      ...transitionInput(admitted, "PREPARE_BEGIN"),
      at: "2026-09-27T05:02:00.000Z",
    });

    const [valid] = repo.exportForRestart();
    if (!valid) throw new Error("missing_assessment");

    const badPrior = JSON.parse(JSON.stringify(valid)) as SecurityAssessmentRecord;
    transitionAt(badPrior, 1).priorState = "RUNNING";
    expect(() => new MemorySecurityAssessmentRepository([badPrior]))
      .toThrowError(ProductDataError);

    const badVersion = JSON.parse(JSON.stringify(valid)) as SecurityAssessmentRecord;
    const badVersionEntry = transitionAt(badVersion, 1);
    badVersionEntry.version += 2;
    badVersion.version = badVersionEntry.version;
    expect(() => new MemorySecurityAssessmentRepository([badVersion]))
      .toThrowError(ProductDataError);

    const badNext = JSON.parse(JSON.stringify(valid)) as SecurityAssessmentRecord;
    transitionAt(badNext, 1).nextState = "RUNNING";
    badNext.state = "RUNNING";
    expect(() => new MemorySecurityAssessmentRepository([badNext]))
      .toThrowError(ProductDataError);

    const badTime = JSON.parse(JSON.stringify(valid)) as SecurityAssessmentRecord;
    const badTimeEntry = transitionAt(badTime, 1);
    badTimeEntry.at = "2026-09-27T04:59:59.000Z";
    badTime.updatedAt = badTimeEntry.at;
    expect(() => new MemorySecurityAssessmentRepository([badTime]))
      .toThrowError(ProductDataError);

    const badRecordVersion = JSON.parse(JSON.stringify(valid)) as SecurityAssessmentRecord;
    badRecordVersion.version += 1;
    expect(() => new MemorySecurityAssessmentRepository([badRecordVersion]))
      .toThrowError(ProductDataError);
  });

  it("keeps BE11 finding, report and retest concepts out of the BE9.1 source schema", () => {
    const files = ["types.ts", "snapshot.ts", "state.ts", "repository.ts"]
      .map((name) => readFileSync(join(process.cwd(), "src/server/product/security/assessment", name), "utf8").toLowerCase())
      .join("\n");
    expect(files).not.toContain("finding");
    expect(files).not.toContain("report");
    expect(files).not.toContain("retest");
  });
});
