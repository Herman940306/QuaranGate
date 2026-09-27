import "server-only";
import { createHash } from "node:crypto";
import { SECURITY_CAPABILITIES } from "./capabilities";
import type { ApplicabilityState, CapabilityApplicability, DetectionProvenance, SecurityAssessmentPlan, SecurityCapabilityCategory, SecurityDiscoveryResult } from "./types";

const PLANNER_VERSION = "BE8_SECURITY_PLANNER_V1" as const;

function id(payload: unknown): string {
  return `plan_${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)}`;
}

function has(discovery: SecurityDiscoveryResult, ...ids: string[]): boolean {
  return discovery.detected.some((tech) => ids.includes(tech.id));
}

function evidence(discovery: SecurityDiscoveryResult, ...ids: string[]): DetectionProvenance[] {
  return discovery.detected.filter((tech) => ids.includes(tech.id)).flatMap((tech) => tech.provenance).slice(0, 20);
}

function stateFor(capabilityId: SecurityCapabilityCategory, discovery: SecurityDiscoveryResult): { state: ApplicabilityState; reason: string; evidence: DetectionProvenance[] } {
  const source = has(discovery, "typescript", "javascript", "csharp", "python", "go", "php", "nextjs", "react", "angular", "dotnet");
  const manifests = has(discovery, "node", "node-lockfile", "python", "go", "dotnet");
  switch (capabilityId) {
    case "SAST": return source ? { state: "APPLICABLE", reason: "source language or framework detected", evidence: evidence(discovery, "typescript", "javascript", "csharp", "python", "go", "php", "nextjs", "react", "angular", "dotnet") } : { state: discovery.unknown ? "UNKNOWN" : "NOT_APPLICABLE", reason: "no supported source language detected", evidence: [] };
    case "SCA": return manifests ? { state: "REQUIRES_NETWORK", reason: "dependency metadata detected; vulnerability lookup requires governed future network", evidence: evidence(discovery, "node", "node-lockfile", "python", "go", "dotnet") } : { state: "NOT_APPLICABLE", reason: "no dependency manifest detected", evidence: [] };
    case "SECRET_SCAN": return discovery.detected.length > 0 ? { state: "APPLICABLE", reason: "static files detected; no execution required", evidence: discovery.detected[0]?.provenance ?? [] } : { state: "UNKNOWN", reason: "no scannable source metadata detected", evidence: [] };
    case "SBOM": return manifests ? { state: "REQUIRES_BUILD", reason: "manifest detected; SBOM generation deferred to governed build phase", evidence: evidence(discovery, "node", "node-lockfile", "python", "go", "dotnet") } : { state: "NOT_APPLICABLE", reason: "no package manifest detected", evidence: [] };
    case "DAST": return { state: "REQUIRES_DEPLOYMENT", reason: "dynamic testing requires a governed deployed/runtime target", evidence: [] };
    case "API_SECURITY": return has(discovery, "openapi") ? { state: "APPLICABLE", reason: "API descriptor detected", evidence: evidence(discovery, "openapi") } : { state: "UNKNOWN", reason: "no OpenAPI or accepted API contract descriptor detected", evidence: [] };
    case "CONTAINER_SCAN": return has(discovery, "docker") ? { state: "REQUIRES_BUILD", reason: "Docker metadata detected; image scan requires governed image/build phase", evidence: evidence(discovery, "docker") } : { state: "NOT_APPLICABLE", reason: "no container metadata detected", evidence: [] };
    case "IAC_SCAN": return has(discovery, "terraform") ? { state: "APPLICABLE", reason: "IaC metadata detected", evidence: evidence(discovery, "terraform") } : { state: "NOT_APPLICABLE", reason: "no IaC metadata detected", evidence: [] };
    case "TLS_NETWORK": return { state: "REQUIRES_NETWORK", reason: "TLS checks require governed network target qualification", evidence: [] };
    case "HOST_RUNTIME": return { state: "REQUIRES_CREDENTIAL", reason: "host runtime checks require explicit governed host/runtime authority", evidence: [] };
    case "RUNTIME_BEHAVIOR": return { state: "REQUIRES_RUNTIME", reason: "runtime behavior checks require a qualified runtime target", evidence: [] };
    case "SUPPLY_CHAIN": return manifests ? { state: "APPLICABLE", reason: "dependency/release metadata can be planned without executing tools", evidence: evidence(discovery, "node", "node-lockfile", "docker") } : { state: "UNKNOWN", reason: "no supply-chain metadata detected", evidence: [] };
    case "AUTH_IDENTITY": return has(discovery, "auth-identity") ? { state: "APPLICABLE", reason: "identity/auth code or configuration indicator detected", evidence: evidence(discovery, "auth-identity") } : { state: "UNKNOWN", reason: "auth surface not established by static discovery", evidence: [] };
    case "CUSTOM_POLICY": return { state: "APPLICABLE", reason: "server-owned QuaranGate policy planning is available", evidence: [] };
  }
}

export function applicabilityFor(discovery: SecurityDiscoveryResult): CapabilityApplicability[] {
  return SECURITY_CAPABILITIES.map((capability) => ({ capabilityId: capability.id, ...stateFor(capability.id, discovery) }));
}

export function createSecurityAssessmentPlan(discovery: SecurityDiscoveryResult): SecurityAssessmentPlan {
  const selectedCapabilities = applicabilityFor(discovery);
  const unavailableSteps = selectedCapabilities.filter((item) => item.state !== "APPLICABLE");
  const applicableIds = selectedCapabilities.filter((item) => item.state === "APPLICABLE").map((item) => item.capabilityId);
  return {
    planId: id({ discoveryId: discovery.discoveryId, sourceRevision: discovery.sourceRevision, applicableIds, unavailableSteps: unavailableSteps.map((item) => [item.capabilityId, item.state]) }),
    projectId: discovery.projectId,
    ...(discovery.targetId !== undefined ? { targetId: discovery.targetId } : {}),
    sourceRevision: discovery.sourceRevision,
    detectedStack: discovery.detected,
    selectedCapabilities,
    prerequisites: unavailableSteps.map((item) => `${item.capabilityId}:${item.state}`),
    environmentRequirements: ["governed_project_root", "read_only_static_metadata", "server_owned_capability_registry"],
    ordering: ["DISCOVERY", "APPLICABILITY", "PLAN", "FUTURE_GOVERNED_EXECUTION"],
    expectedEvidenceTypes: ["detected_stack_provenance", "capability_applicability", "unsupported_capabilities", "plan_manifest"],
    safetyClassification: "NON_DESTRUCTIVE_STATIC_PLAN",
    destructiveClassification: "NON_DESTRUCTIVE",
    networkRequirements: unavailableSteps.some((item) => item.state === "REQUIRES_NETWORK" || item.state === "REQUIRES_DEPLOYMENT") ? "FUTURE_PHASE_REQUIRED" : "NONE_FOR_BE8_PLAN",
    credentialRequirements: unavailableSteps.some((item) => item.state === "REQUIRES_CREDENTIAL") ? "FUTURE_PHASE_REQUIRED" : "NONE_FOR_BE8_PLAN",
    unsupported: discovery.unsupported,
    unavailableSteps,
    provenance: { plannerVersion: PLANNER_VERSION, discoveryId: discovery.discoveryId, sourceRevision: discovery.sourceRevision },
    executionAuthority: false,
  };
}
