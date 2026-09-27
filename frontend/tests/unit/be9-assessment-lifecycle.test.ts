import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ProductDataError } from "../../src/server/product/data/errors";
import { MemorySecurityAssessmentRepository } from "../../src/server/product/security/assessment/repository";
import { canonicalSnapshot } from "../../src/server/product/security/assessment/snapshot";
import { LEGAL_BE9_ASSESSMENT_TRANSITIONS, finalStateForCleanup } from "../../src/server/product/security/assessment/state";
import { BE9_ASSESSMENT_STATES, BE9_TERMINAL_STATES, type SecurityAssessmentRecord, type SecurityAssessmentState } from "../../src/server/product/security/assessment/types";

const REV = "324abd6da9360197b3af28bfcc95fc7c987a1cdd";
const owner = { productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a", principalRef: "principal-a", principalMappingVersion: 3 };
const binding = { projectId: "project-a", targetId: "target-a", sourceRevision: REV, assessmentIntent: "source" as const };
const discovery = { discoveryId: "disc_0123456789abcdef01234567", projectId: "project-a", sourceRevision: REV, detected: [{ id: "typescript" }] };
const plan = { planId: "plan_0123456789abcdef01234567", discoveryId: discovery.discoveryId, sourceRevision: REV, selectedCapabilities: [{ capabilityId: "SAST", state: "APPLICABLE" }], executionAuthority: false };

function createInput(id = "assessment-a") {
  return { assessmentId: id, owner, binding, discoveryId: discovery.discoveryId, planId: plan.planId, discoverySnapshot: discovery, planSnapshot: plan, requestedAt: "2026-09-27T05:00:00.000Z", correlationId: "corr-a" };
}

function recordAt(state: SecurityAssessmentState, version = 7): SecurityAssessmentRecord {
  return { id: `assessment-${state.toLowerCase().replaceAll("_", "-")}`, owner, binding, discoveryId: discovery.discoveryId, planId: plan.planId, discoverySnapshot: canonicalSnapshot(discovery), planSnapshot: canonicalSnapshot(plan), state, version, requestedAt: "2026-09-27T05:00:00.000Z", updatedAt: "2026-09-27T05:00:00.000Z", correlationId: "corr-a", transitionLog: [] };
}

function transitionInput(record: SecurityAssessmentRecord, nextState: SecurityAssessmentState) {
  return { assessmentId: record.id, expectedVersion: record.version, nextState, reason: "test", actor: "worker" as const, correlationId: "corr-t", at: "2026-09-27T05:01:00.000Z" };
}

describe("BE9.1 assessment lifecycle foundation", () => {
  it("uses the exact closed lifecycle vocabulary", () => {
    expect(BE9_ASSESSMENT_STATES).toEqual(["PLANNED", "ADMITTED", "PREPARING", "RUNNING", "CANCELLING", "CLEANUP", "COMPLETED", "FAILED_POLICY", "FAILED_PRECONDITION", "FAILED_TOOL", "FAILED_TIMEOUT", "FAILED_INFRASTRUCTURE", "CANCELLED", "CLEANUP_FAILED"]);
  });

  it("creates PLANNED assessments with tenant, workspace, Principal and immutable snapshot digests", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput());
    expect(created.state).toBe("PLANNED");
    expect(created.version).toBe(0);
    expect(created.owner).toEqual(owner);
    expect(created.binding).toEqual(binding);
    expect(created.discoverySnapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(created.planSnapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(created.planSnapshot.value).toMatchObject({ discoveryId: discovery.discoveryId, sourceRevision: REV, executionAuthority: false });
  });

  it("allows every legal lifecycle transition and records durable versioned transition metadata", async () => {
    for (const [current, nextStates] of Object.entries(LEGAL_BE9_ASSESSMENT_TRANSITIONS) as Array<[SecurityAssessmentState, readonly SecurityAssessmentState[]]>) {
      for (const next of nextStates) {
        const record = recordAt(current);
        const repo = new MemorySecurityAssessmentRepository([record]);
        const updated = await repo.transition({ ...transitionInput(record, next), pendingOutcome: next === "CLEANUP" ? "SUCCESS" : undefined });
        expect(updated.state).toBe(next);
        expect(updated.version).toBe(record.version + 1);
        expect(updated.transitionLog.at(-1)).toMatchObject({ priorState: current, nextState: next, version: record.version + 1, correlationId: "corr-t" });
      }
    }
  });

  it("rejects all non-authorized state edges without changing the record", async () => {
    for (const current of BE9_ASSESSMENT_STATES) {
      const legal = new Set(LEGAL_BE9_ASSESSMENT_TRANSITIONS[current]);
      for (const next of BE9_ASSESSMENT_STATES) {
        if (legal.has(next)) continue;
        const record = recordAt(current);
        const repo = new MemorySecurityAssessmentRepository([record]);
        await expect(repo.transition(transitionInput(record, next))).rejects.toBeInstanceOf(ProductDataError);
        await expect(repo.read(owner, record.id)).resolves.toMatchObject({ state: current, version: record.version });
      }
    }
  });

  it("keeps terminal states immutable", async () => {
    for (const state of BE9_TERMINAL_STATES) {
      const record = recordAt(state);
      const repo = new MemorySecurityAssessmentRepository([record]);
      await expect(repo.transition(transitionInput(record, "RUNNING"))).rejects.toMatchObject({ code: "PRODUCT_DATA_STALE_VERSION" });
      await expect(repo.read(owner, record.id)).resolves.toMatchObject({ state, version: record.version });
    }
  });

  it("makes cleanup uncertainty override ordinary success, timeout and cancellation", () => {
    expect(finalStateForCleanup({ pendingOutcome: "SUCCESS" })).toBe("COMPLETED");
    expect(finalStateForCleanup({ pendingOutcome: "FAILED_TIMEOUT" })).toBe("FAILED_TIMEOUT");
    expect(finalStateForCleanup({ pendingOutcome: "CANCELLED" })).toBe("CANCELLED");
    expect(finalStateForCleanup({ pendingOutcome: "SUCCESS", cleanupUncertain: true })).toBe("CLEANUP_FAILED");
    expect(finalStateForCleanup({ pendingOutcome: "FAILED_TIMEOUT", cleanupUncertain: true })).toBe("CLEANUP_FAILED");
    expect(finalStateForCleanup({ pendingOutcome: "CANCELLED", cleanupUncertain: true })).toBe("CLEANUP_FAILED");
  });

  it("persists cleanup failure as the final state when certainty is lost", async () => {
    const cleanup = recordAt("CLEANUP");
    const repo = new MemorySecurityAssessmentRepository([cleanup]);
    const updated = await repo.transition({ ...transitionInput(cleanup, "COMPLETED"), pendingOutcome: "SUCCESS", cleanupUncertain: true });
    expect(updated.state).toBe("CLEANUP_FAILED");
    expect(updated.pendingOutcome).toBe("SUCCESS");
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
    read1.discoverySnapshot.value = { tampered: true } as never;
    await expect(repo.read(owner, created.id)).resolves.toMatchObject({ discoverySnapshot: { digest: created.discoverySnapshot.digest } });
    const reloaded = new MemorySecurityAssessmentRepository(repo.exportForRestart());
    await expect(reloaded.read(owner, created.id)).resolves.toMatchObject({ state: "PLANNED", discoverySnapshot: { digest: created.discoverySnapshot.digest }, planSnapshot: { digest: created.planSnapshot.digest } });
  });

  it("rejects invalid and stale versions without writing lifecycle state", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    const created = await repo.create(createInput());
    await expect(repo.transition({ ...transitionInput(created, "ADMITTED"), expectedVersion: 99 })).rejects.toMatchObject({ code: "PRODUCT_DATA_STALE_VERSION" });
    await expect(repo.read(owner, created.id)).resolves.toMatchObject({ state: "PLANNED", version: 0 });
  });

  it("rejects mismatched plan binding and sensitive material in snapshots", async () => {
    const repo = new MemorySecurityAssessmentRepository();
    await expect(repo.create({ ...createInput("assessment-mismatch"), planSnapshot: { ...plan, sourceRevision: "0".repeat(40) } })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
    await expect(repo.create({ ...createInput("assessment-sensitive"), discoverySnapshot: { ...discovery, apiKey: "not-for-db" } })).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
  });

  it("keeps BE11 finding, report and retest concepts out of the BE9.1 source schema", () => {
    const files = ["types.ts", "snapshot.ts", "state.ts", "repository.ts"].map((name) => readFileSync(join(process.cwd(), "src/server/product/security/assessment", name), "utf8").toLowerCase()).join("\n");
    expect(files).not.toContain("finding");
    expect(files).not.toContain("report");
    expect(files).not.toContain("retest");
  });
});
