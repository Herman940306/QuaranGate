import "server-only";

export type SecurityCapabilityCategory =
  | "SAST"
  | "SCA"
  | "SECRET_SCAN"
  | "SBOM"
  | "DAST"
  | "API_SECURITY"
  | "CONTAINER_SCAN"
  | "IAC_SCAN"
  | "TLS_NETWORK"
  | "HOST_RUNTIME"
  | "RUNTIME_BEHAVIOR"
  | "SUPPLY_CHAIN"
  | "AUTH_IDENTITY"
  | "CUSTOM_POLICY";

export type ApplicabilityState =
  | "APPLICABLE"
  | "NOT_APPLICABLE"
  | "REQUIRES_RUNTIME"
  | "REQUIRES_BUILD"
  | "REQUIRES_DEPLOYMENT"
  | "REQUIRES_CREDENTIAL"
  | "REQUIRES_NETWORK"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type DetectorSourceType =
  | "manifest"
  | "lockfile"
  | "project_file"
  | "build_file"
  | "source_distribution"
  | "framework_config"
  | "container_iac"
  | "ci_config"
  | "deployment_descriptor"
  | "dependency_manifest";

export interface DetectionProvenance {
  sourceType: DetectorSourceType;
  path: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  detectorVersion: "BE8_STATIC_DISCOVERY_V1";
  detail?: string;
}

export interface DetectedTechnology {
  id: string;
  label: string;
  family: "language" | "framework" | "runtime" | "database" | "container" | "iac" | "ci" | "deployment" | "auth" | "unknown";
  version?: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  provenance: DetectionProvenance[];
}

export interface DiscoveryUnsupportedFact {
  path: string;
  reason:
    | "MALICIOUS_PATH"
    | "SYMLINK_UNSUPPORTED"
    | "OVERSIZED_MANIFEST"
    | "OVERSIZED_SOURCE_FILE"
    | "BINARY_UNPARSEABLE"
    | "MALFORMED_MANIFEST"
    | "UNSUPPORTED_FILE_TYPE";
}

export interface ProjectSourceFile {
  path: string;
  content?: string;
  sizeBytes?: number;
  binary?: boolean;
  kind?: "file" | "symlink";
}

export interface SecurityDiscoveryRequest {
  projectId: string;
  targetId?: string;
  assessmentIntent?: "source" | "runtime" | "pipeline";
}

export interface TrustedSecuritySourceSnapshot {
  projectId: string;
  targetId?: string;
  sourceRevision: string;
  files: ProjectSourceFile[];
}

export interface SecuritySourceResolveContext {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  principalRef: string;
  projectId: string;
  targetId?: string;
}

export interface SecurityDiscoveryResult {
  discoveryId: string;
  projectId: string;
  targetId?: string;
  sourceRevision: string;
  detectorVersion: "BE8_STATIC_DISCOVERY_V1";
  readOnly: true;
  detected: DetectedTechnology[];
  unsupported: DiscoveryUnsupportedFact[];
  unknown: boolean;
  incomplete: false;
  safety: {
    packageScriptsExecuted: false;
    networkUsed: false;
    dependencyInstallAttempted: false;
    arbitraryHostPathsAccepted: false;
  };
}

export interface StoredSecurityDiscovery {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  principalRef: string;
  result: SecurityDiscoveryResult;
}

export interface SecurityCapability {
  id: SecurityCapabilityCategory;
  displayName: string;
  futureScanner?: string;
  requiresRuntime: boolean;
  requiresBuild: boolean;
  requiresDeployment: boolean;
  requiresCredential: boolean;
  requiresNetwork: boolean;
  destructive: false;
  executionPhase: "BE8_PLAN_ONLY" | "FUTURE_GOVERNED_EXECUTION";
}

export interface CapabilityApplicability {
  capabilityId: SecurityCapabilityCategory;
  state: ApplicabilityState;
  reason: string;
  evidence: DetectionProvenance[];
}

export interface SecurityAssessmentPlan {
  planId: string;
  projectId: string;
  targetId?: string;
  sourceRevision: string;
  detectedStack: DetectedTechnology[];
  selectedCapabilities: CapabilityApplicability[];
  prerequisites: string[];
  environmentRequirements: string[];
  ordering: string[];
  expectedEvidenceTypes: string[];
  safetyClassification: "NON_DESTRUCTIVE_STATIC_PLAN";
  destructiveClassification: "NON_DESTRUCTIVE";
  networkRequirements: "NONE_FOR_BE8_PLAN" | "FUTURE_PHASE_REQUIRED";
  credentialRequirements: "NONE_FOR_BE8_PLAN" | "FUTURE_PHASE_REQUIRED";
  unsupported: DiscoveryUnsupportedFact[];
  unavailableSteps: CapabilityApplicability[];
  provenance: {
    plannerVersion: "BE8_SECURITY_PLANNER_V1";
    discoveryId: string;
    sourceRevision: string;
  };
  executionAuthority: false;
}
