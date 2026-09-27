import "server-only";
import { ProductDataError } from "../../data/errors";
import { canonicalSnapshot, verifySnapshot } from "./snapshot";
import { isTerminalAssessmentState, resolveAssessmentEvent } from "./state";
import {
  BE9_ASSESSMENT_EVENTS,
  BE9_ASSESSMENT_STATES,
  BE9_PENDING_OUTCOMES,
  type SecurityAssessmentBinding,
  type SecurityAssessmentCreateInput,
  type SecurityAssessmentReadScope,
  type SecurityAssessmentRecord,
  type SecurityAssessmentRepository,
  type SecurityAssessmentTransitionInput,
} from "./types";
import type { SecurityAssessmentPlan, SecurityDiscoveryResult } from "../types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertId(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", code);
  }
}

function assertPrincipalRef(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_principal_invalid");
  }
}

function assertDiscoveryId(value: string): void {
  if (!/^disc_[0-9a-f]{24}$/.test(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_discovery_id_invalid");
  }
}

function assertPlanId(value: string): void {
  if (!/^plan_[0-9a-f]{24}$/.test(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_id_invalid");
  }
}

function assertCorrelationId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_correlation_id_invalid");
  }
}

function assertReason(value: string): void {
  if (value.length < 1 || value.length > 500 || value.includes("\0")) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_reason_invalid");
  }
}

function assertActor(value: string): void {
  if (!["product-service", "operational-bridge", "worker", "recovery"].includes(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_actor_invalid");
  }
}

function assertTimestamp(value: string, code: string): void {
  if (value.length < 20 || value.length > 40) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", code);
  }
}

function assertTimestampOrder(
  earlier: string,
  later: string,
  code: string,
): void {
  if (new Date(later).getTime() < new Date(earlier).getTime()) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", code);
  }
}

function assertClosedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", code);
    }
  }
}

function assertRevision(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_source_revision_invalid");
  }
}

function assertOptionalIdentity(
  actual: unknown,
  expected: string | undefined,
  code: string,
): void {
  if (expected === undefined) {
    if (actual !== undefined) throw new ProductDataError("PRODUCT_DATA_INVALID", code);
    return;
  }
  if (actual !== expected) throw new ProductDataError("PRODUCT_DATA_INVALID", code);
}

function asObject(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", code);
  }
  return value as Record<string, unknown>;
}

const CONFIDENCE = new Set(["HIGH", "MEDIUM", "LOW"]);
const DETECTOR_SOURCE_TYPES = new Set([
  "manifest",
  "lockfile",
  "project_file",
  "build_file",
  "source_distribution",
  "framework_config",
  "container_iac",
  "ci_config",
  "deployment_descriptor",
  "dependency_manifest",
]);
const TECHNOLOGY_FAMILIES = new Set([
  "language",
  "framework",
  "runtime",
  "database",
  "container",
  "iac",
  "ci",
  "deployment",
  "auth",
  "unknown",
]);
const UNSUPPORTED_REASONS = new Set([
  "MALICIOUS_PATH",
  "SYMLINK_UNSUPPORTED",
  "OVERSIZED_MANIFEST",
  "OVERSIZED_SOURCE_FILE",
  "BINARY_UNPARSEABLE",
  "MALFORMED_MANIFEST",
  "UNSUPPORTED_FILE_TYPE",
]);
const CAPABILITY_IDS = new Set([
  "SAST",
  "SCA",
  "SECRET_SCAN",
  "SBOM",
  "DAST",
  "API_SECURITY",
  "CONTAINER_SCAN",
  "IAC_SCAN",
  "TLS_NETWORK",
  "HOST_RUNTIME",
  "RUNTIME_BEHAVIOR",
  "SUPPLY_CHAIN",
  "AUTH_IDENTITY",
  "CUSTOM_POLICY",
]);
const APPLICABILITY_STATES = new Set([
  "APPLICABLE",
  "NOT_APPLICABLE",
  "REQUIRES_RUNTIME",
  "REQUIRES_BUILD",
  "REQUIRES_DEPLOYMENT",
  "REQUIRES_CREDENTIAL",
  "REQUIRES_NETWORK",
  "UNAVAILABLE",
  "UNKNOWN",
]);

function assertStringValue(
  value: unknown,
  code: string,
  options: { allowEmpty?: boolean; max?: number } = {},
): string {
  const { allowEmpty = false, max = 2048 } = options;
  if (
    typeof value !== "string"
    || value.length > max
    || (!allowEmpty && value.length === 0)
    || value.includes("\0")
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", code);
  }
  return value;
}

function assertArrayValue(value: unknown, code: string, max = 1024): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", code);
  }
  return value;
}

function assertStringArray(value: unknown, code: string): void {
  for (const item of assertArrayValue(value, code, 512)) {
    assertStringValue(item, code, { max: 512 });
  }
}

function assertDetectionProvenance(value: unknown): void {
  const item = asObject(value, "assessment_detection_provenance_invalid");
  assertClosedKeys(
    item,
    ["sourceType", "path", "confidence", "detectorVersion", "detail"],
    "assessment_detection_provenance_unknown_field",
  );
  if (!DETECTOR_SOURCE_TYPES.has(String(item.sourceType))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_detection_source_type_invalid");
  }
  assertStringValue(item.path, "assessment_detection_path_invalid", { max: 4096 });
  if (!CONFIDENCE.has(String(item.confidence))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_detection_confidence_invalid");
  }
  if (item.detectorVersion !== "BE8_STATIC_DISCOVERY_V1") {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_detection_version_invalid");
  }
  if (item.detail !== undefined) {
    assertStringValue(item.detail, "assessment_detection_detail_invalid", { max: 4096 });
  }
}

function assertDetectedTechnology(value: unknown): void {
  const item = asObject(value, "assessment_detected_technology_invalid");
  assertClosedKeys(
    item,
    ["id", "label", "family", "version", "confidence", "provenance"],
    "assessment_detected_technology_unknown_field",
  );
  assertStringValue(item.id, "assessment_detected_technology_id_invalid", { max: 256 });
  assertStringValue(item.label, "assessment_detected_technology_label_invalid", { max: 256 });
  if (!TECHNOLOGY_FAMILIES.has(String(item.family))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_detected_technology_family_invalid");
  }
  if (item.version !== undefined) {
    assertStringValue(item.version, "assessment_detected_technology_version_invalid", { max: 256 });
  }
  if (!CONFIDENCE.has(String(item.confidence))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_detected_technology_confidence_invalid");
  }
  for (const provenance of assertArrayValue(
    item.provenance,
    "assessment_detected_technology_provenance_invalid",
    256,
  )) {
    assertDetectionProvenance(provenance);
  }
}

function assertUnsupportedFact(value: unknown): void {
  const item = asObject(value, "assessment_unsupported_fact_invalid");
  assertClosedKeys(
    item,
    ["path", "reason"],
    "assessment_unsupported_fact_unknown_field",
  );
  assertStringValue(item.path, "assessment_unsupported_fact_path_invalid", { max: 4096 });
  if (!UNSUPPORTED_REASONS.has(String(item.reason))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_unsupported_fact_reason_invalid");
  }
}

function assertCapabilityApplicability(value: unknown): void {
  const item = asObject(value, "assessment_capability_applicability_invalid");
  assertClosedKeys(
    item,
    ["capabilityId", "state", "reason", "evidence"],
    "assessment_capability_applicability_unknown_field",
  );
  if (!CAPABILITY_IDS.has(String(item.capabilityId))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_capability_id_invalid");
  }
  if (!APPLICABILITY_STATES.has(String(item.state))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_capability_state_invalid");
  }
  assertStringValue(item.reason, "assessment_capability_reason_invalid", { max: 4096 });
  for (const evidence of assertArrayValue(
    item.evidence,
    "assessment_capability_evidence_invalid",
    256,
  )) {
    assertDetectionProvenance(evidence);
  }
}

function assertDiscoveryBinding(
  discoveryValue: SecurityDiscoveryResult,
  expected: {
    discoveryId: string;
    binding: SecurityAssessmentBinding;
  },
): void {
  const discovery = asObject(discoveryValue, "assessment_discovery_snapshot_invalid");
  assertClosedKeys(
    discovery,
    [
      "discoveryId",
      "projectId",
      "targetId",
      "sourceRevision",
      "detectorVersion",
      "readOnly",
      "detected",
      "unsupported",
      "unknown",
      "incomplete",
      "safety",
    ],
    "assessment_discovery_unknown_field",
  );

  if (discovery.discoveryId !== expected.discoveryId) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_discovery_id_mismatch");
  }
  if (discovery.projectId !== expected.binding.projectId) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_discovery_project_mismatch");
  }
  assertOptionalIdentity(
    discovery.targetId,
    expected.binding.targetId,
    "assessment_discovery_target_mismatch",
  );
  if (discovery.sourceRevision !== expected.binding.sourceRevision) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_discovery_revision_mismatch");
  }
  if (discovery.detectorVersion !== "BE8_STATIC_DISCOVERY_V1") {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_discovery_schema_invalid");
  }
  if (typeof discovery.unknown !== "boolean") {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_discovery_unknown_flag_invalid");
  }
  if (discovery.readOnly !== true || discovery.incomplete !== false) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_discovery_safety_invalid");
  }

  const safety = asObject(discovery.safety, "assessment_discovery_safety_invalid");
  assertClosedKeys(
    safety,
    [
      "packageScriptsExecuted",
      "networkUsed",
      "dependencyInstallAttempted",
      "arbitraryHostPathsAccepted",
    ],
    "assessment_discovery_safety_unknown_field",
  );
  for (const key of [
    "packageScriptsExecuted",
    "networkUsed",
    "dependencyInstallAttempted",
    "arbitraryHostPathsAccepted",
  ] as const) {
    if (safety[key] !== false) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_discovery_safety_invalid");
    }
  }

  for (const item of assertArrayValue(discovery.detected, "assessment_discovery_detected_invalid", 512)) {
    assertDetectedTechnology(item);
  }
  for (const item of assertArrayValue(discovery.unsupported, "assessment_discovery_unsupported_invalid", 512)) {
    assertUnsupportedFact(item);
  }
}

function assertPlanBinding(
  planValue: SecurityAssessmentPlan,
  expected: {
    planId: string;
    discoveryId: string;
    binding: SecurityAssessmentBinding;
  },
): void {
  const plan = asObject(planValue, "assessment_plan_snapshot_invalid");
  assertClosedKeys(
    plan,
    [
      "planId",
      "projectId",
      "targetId",
      "sourceRevision",
      "detectedStack",
      "selectedCapabilities",
      "prerequisites",
      "environmentRequirements",
      "ordering",
      "expectedEvidenceTypes",
      "safetyClassification",
      "destructiveClassification",
      "networkRequirements",
      "credentialRequirements",
      "unsupported",
      "unavailableSteps",
      "provenance",
      "executionAuthority",
    ],
    "assessment_plan_unknown_field",
  );

  if (plan.planId !== expected.planId) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_id_mismatch");
  }
  if (plan.projectId !== expected.binding.projectId) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_project_mismatch");
  }
  assertOptionalIdentity(
    plan.targetId,
    expected.binding.targetId,
    "assessment_plan_target_mismatch",
  );
  if (plan.sourceRevision !== expected.binding.sourceRevision) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_revision_mismatch");
  }
  if (plan.executionAuthority !== false) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_execution_authority_invalid");
  }
  if (
    plan.safetyClassification !== "NON_DESTRUCTIVE_STATIC_PLAN"
    || plan.destructiveClassification !== "NON_DESTRUCTIVE"
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_safety_classification_invalid");
  }
  if (!["NONE_FOR_BE8_PLAN", "FUTURE_PHASE_REQUIRED"].includes(String(plan.networkRequirements))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_network_requirements_invalid");
  }
  if (!["NONE_FOR_BE8_PLAN", "FUTURE_PHASE_REQUIRED"].includes(String(plan.credentialRequirements))) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_credential_requirements_invalid");
  }

  for (const item of assertArrayValue(plan.detectedStack, "assessment_plan_detected_stack_invalid", 512)) {
    assertDetectedTechnology(item);
  }
  for (const item of assertArrayValue(plan.selectedCapabilities, "assessment_plan_selected_capabilities_invalid", 512)) {
    assertCapabilityApplicability(item);
  }
  assertStringArray(plan.prerequisites, "assessment_plan_prerequisites_invalid");
  assertStringArray(plan.environmentRequirements, "assessment_plan_environment_requirements_invalid");
  assertStringArray(plan.ordering, "assessment_plan_ordering_invalid");
  assertStringArray(plan.expectedEvidenceTypes, "assessment_plan_expected_evidence_invalid");
  for (const item of assertArrayValue(plan.unsupported, "assessment_plan_unsupported_invalid", 512)) {
    assertUnsupportedFact(item);
  }
  for (const item of assertArrayValue(plan.unavailableSteps, "assessment_plan_unavailable_steps_invalid", 512)) {
    assertCapabilityApplicability(item);
  }

  const provenance = asObject(plan.provenance, "assessment_plan_provenance_invalid");
  assertClosedKeys(
    provenance,
    ["plannerVersion", "discoveryId", "sourceRevision"],
    "assessment_plan_provenance_unknown_field",
  );
  if (provenance.plannerVersion !== "BE8_SECURITY_PLANNER_V1") {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_schema_invalid");
  }
  if (provenance.discoveryId !== expected.discoveryId) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_discovery_mismatch");
  }
  if (provenance.sourceRevision !== expected.binding.sourceRevision) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_plan_provenance_revision_mismatch");
  }
}

function assertAssessmentBindings(record: SecurityAssessmentRecord): void {
  assertDiscoveryBinding(record.discoverySnapshot.value, {
    discoveryId: record.discoveryId,
    binding: record.binding,
  });
  assertPlanBinding(record.planSnapshot.value, {
    planId: record.planId,
    discoveryId: record.discoveryId,
    binding: record.binding,
  });
}

function assertTransitionLog(record: SecurityAssessmentRecord): void {
  if (!Array.isArray(record.transitionLog)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_invalid");
  }

  if (record.transitionLog.length === 0) return;

  let replayState: SecurityAssessmentRecord["state"] | undefined;
  let replayOutcome: SecurityAssessmentRecord["pendingOutcome"];
  let previousAt = record.requestedAt;
  let previousVersion: number | undefined;

  for (const entry of record.transitionLog) {
    assertClosedKeys(
      asObject(entry, "assessment_transition_log_entry_invalid"),
      [
        "assessmentId",
        "priorState",
        "event",
        "nextState",
        "version",
        "reason",
        "actor",
        "correlationId",
        "at",
        "pendingOutcome",
      ],
      "assessment_transition_log_unknown_field",
    );

    if (entry.assessmentId !== record.id) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_assessment_mismatch");
    }
    if (!BE9_ASSESSMENT_STATES.includes(entry.priorState) || !BE9_ASSESSMENT_STATES.includes(entry.nextState)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_state_invalid");
    }
    if (!BE9_ASSESSMENT_EVENTS.includes(entry.event)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_event_invalid");
    }
    if (!Number.isSafeInteger(entry.version) || entry.version < 1) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_version_invalid");
    }
    if (previousVersion !== undefined && entry.version !== previousVersion + 1) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_version_gap");
    }

    assertReason(entry.reason);
    assertActor(entry.actor);
    assertCorrelationId(entry.correlationId);
    assertTimestamp(entry.at, "assessment_transition_log_at_invalid");
    assertTimestampOrder(previousAt, entry.at, "assessment_transition_log_time_regression");

    if (replayState !== undefined && entry.priorState !== replayState) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_prior_state_mismatch");
    }

    const priorOutcome = replayState === undefined && entry.priorState === "CLEANUP"
      ? entry.pendingOutcome
      : replayOutcome;
    const resolution = resolveAssessmentEvent(entry.priorState, entry.event, priorOutcome);

    if (entry.nextState !== resolution.nextState) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_next_state_mismatch");
    }
    if (entry.pendingOutcome !== resolution.pendingOutcome) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_outcome_mismatch");
    }

    replayState = resolution.nextState;
    replayOutcome = resolution.pendingOutcome;
    previousAt = entry.at;
    previousVersion = entry.version;
  }

  const last = record.transitionLog.at(-1);
  if (!last) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_invalid");
  }
  if (record.version !== last.version) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_record_version_mismatch");
  }
  if (record.state !== replayState || record.pendingOutcome !== replayOutcome) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_record_state_mismatch");
  }
  if (record.updatedAt !== last.at) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_transition_log_updated_at_mismatch");
  }
}

function assertOwner(scope: SecurityAssessmentReadScope, record: SecurityAssessmentRecord): void {
  if (
    scope.productUserId !== record.owner.productUserId
    || scope.organizationId !== record.owner.organizationId
    || scope.workspaceId !== record.owner.workspaceId
    || scope.principalRef !== record.owner.principalRef
  ) {
    throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "assessment_forbidden");
  }
}

function validateRecord(record: SecurityAssessmentRecord): void {
  verifySnapshot(record.discoverySnapshot);
  verifySnapshot(record.planSnapshot);

  assertId(record.id, "assessment_id_invalid");
  assertDiscoveryId(record.discoveryId);
  assertPlanId(record.planId);
  assertId(record.owner.productUserId, "assessment_product_user_invalid");
  assertId(record.owner.organizationId, "assessment_organization_invalid");
  assertId(record.owner.workspaceId, "assessment_workspace_invalid");
  assertPrincipalRef(record.owner.principalRef);
  assertId(record.binding.projectId, "assessment_project_invalid");
  if (record.binding.targetId) assertId(record.binding.targetId, "assessment_target_invalid");
  assertRevision(record.binding.sourceRevision);
  assertTimestamp(record.requestedAt, "assessment_requested_at_invalid");
  assertTimestamp(record.updatedAt, "assessment_updated_at_invalid");
  assertTimestampOrder(record.requestedAt, record.updatedAt, "assessment_updated_at_before_requested_at");
  assertCorrelationId(record.correlationId);

  if (
    !Number.isSafeInteger(record.owner.principalMappingVersion)
    || record.owner.principalMappingVersion < 0
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_principal_version_invalid");
  }
  if (!BE9_ASSESSMENT_STATES.includes(record.state)) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_state_invalid");
  }
  if (!Number.isSafeInteger(record.version) || record.version < 0) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_version_invalid");
  }
  if (
    record.pendingOutcome !== undefined
    && !BE9_PENDING_OUTCOMES.includes(record.pendingOutcome)
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_pending_outcome_invalid");
  }
  if (record.state === "CLEANUP" && record.pendingOutcome === undefined) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_cleanup_outcome_required");
  }
  if (
    ["PLANNED", "ADMITTED", "PREPARING", "RUNNING", "CANCELLING", "FAILED_POLICY"].includes(record.state)
    && record.pendingOutcome !== undefined
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_pending_outcome_state_mismatch");
  }
  if (record.state === "COMPLETED" && record.pendingOutcome !== "SUCCESS") {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_completed_without_success");
  }
  if (record.state === "FAILED_TOOL" && record.pendingOutcome !== "FAILED_TOOL") {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_tool_failure_outcome_mismatch");
  }
  if (record.state === "FAILED_TIMEOUT" && record.pendingOutcome !== "FAILED_TIMEOUT") {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_timeout_outcome_mismatch");
  }
  if (
    record.state === "FAILED_PRECONDITION"
    && record.pendingOutcome !== undefined
    && record.pendingOutcome !== "FAILED_PRECONDITION"
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_precondition_outcome_mismatch");
  }
  if (
    record.state === "CANCELLED"
    && record.pendingOutcome !== undefined
    && record.pendingOutcome !== "CANCELLED"
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_cancelled_outcome_mismatch");
  }
  if (record.state === "CLEANUP_FAILED" && record.pendingOutcome === undefined) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_cleanup_failed_outcome_required");
  }

  assertTransitionLog(record);
  assertAssessmentBindings(record);
}

export class MemorySecurityAssessmentRepository implements SecurityAssessmentRepository {
  private readonly records = new Map<string, SecurityAssessmentRecord>();

  constructor(seed: SecurityAssessmentRecord[] = []) {
    for (const record of seed) {
      validateRecord(record);
      if (this.records.has(record.id)) {
        throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_seed_id_reused");
      }
      this.records.set(record.id, clone(record));
    }
  }

  exportForRestart(): SecurityAssessmentRecord[] {
    return Array.from(this.records.values()).map(clone);
  }

  async create(input: SecurityAssessmentCreateInput): Promise<SecurityAssessmentRecord> {
    assertId(input.assessmentId, "assessment_id_invalid");
    assertDiscoveryId(input.discoveryId);
    assertPlanId(input.planId);
    assertId(input.owner.productUserId, "assessment_product_user_invalid");
    assertId(input.owner.organizationId, "assessment_organization_invalid");
    assertId(input.owner.workspaceId, "assessment_workspace_invalid");
    assertPrincipalRef(input.owner.principalRef);
    assertId(input.binding.projectId, "assessment_project_invalid");
    if (input.binding.targetId) assertId(input.binding.targetId, "assessment_target_invalid");
    assertRevision(input.binding.sourceRevision);
    assertTimestamp(input.requestedAt, "assessment_requested_at_invalid");
    assertCorrelationId(input.correlationId);

    if (
      !Number.isSafeInteger(input.owner.principalMappingVersion)
      || input.owner.principalMappingVersion < 0
    ) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_principal_version_invalid");
    }
    if (this.records.has(input.assessmentId)) {
      throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "assessment_id_reused");
    }

    const discoverySnapshot = canonicalSnapshot(input.discoverySnapshot);
    const planSnapshot = canonicalSnapshot(input.planSnapshot);

    const record: SecurityAssessmentRecord = {
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

    validateRecord(record);
    this.records.set(input.assessmentId, clone(record));
    return clone(record);
  }

  async read(
    scope: SecurityAssessmentReadScope,
    assessmentId: string,
  ): Promise<SecurityAssessmentRecord | undefined> {
    const record = this.records.get(assessmentId);
    if (!record) return undefined;
    assertOwner(scope, record);
    validateRecord(record);
    return clone(record);
  }

  async transition(input: SecurityAssessmentTransitionInput): Promise<SecurityAssessmentRecord> {
    const record = this.records.get(input.assessmentId);
    if (!record) {
      throw new ProductDataError("PRODUCT_DATA_NOT_FOUND", "assessment_not_found");
    }
    validateRecord(record);

    if (record.version !== input.expectedVersion) {
      throw new ProductDataError("PRODUCT_DATA_STALE_VERSION", "assessment_version_stale");
    }
    assertReason(input.reason);
    assertActor(input.actor);
    assertCorrelationId(input.correlationId);
    assertTimestamp(input.at, "assessment_transition_at_invalid");
    assertTimestampOrder(record.updatedAt, input.at, "assessment_transition_time_regression");

    const resolution = resolveAssessmentEvent(
      record.state,
      input.event,
      record.pendingOutcome,
    );
    const nextVersion = record.version + 1;
    const next: SecurityAssessmentRecord = {
      ...clone(record),
      state: resolution.nextState,
      version: nextVersion,
      ...(resolution.pendingOutcome
        ? { pendingOutcome: resolution.pendingOutcome }
        : { pendingOutcome: undefined }),
      updatedAt: input.at,
      transitionLog: [
        ...record.transitionLog,
        {
          assessmentId: input.assessmentId,
          priorState: record.state,
          event: input.event,
          nextState: resolution.nextState,
          version: nextVersion,
          reason: input.reason,
          actor: input.actor,
          correlationId: input.correlationId,
          at: input.at,
          ...(resolution.pendingOutcome
            ? { pendingOutcome: resolution.pendingOutcome }
            : {}),
        },
      ],
    };

    validateRecord(next);
    this.records.set(input.assessmentId, clone(next));
    return clone(next);
  }

  async listActiveForRecovery(): Promise<SecurityAssessmentRecord[]> {
    return Array.from(this.records.values())
      .filter((record) => !isTerminalAssessmentState(record.state))
      .map(clone);
  }
}
