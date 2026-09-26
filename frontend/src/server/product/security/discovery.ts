import "server-only";
import { createHash } from "node:crypto";
import { basename, extname, posix } from "node:path";
import type { DetectedTechnology, DetectionProvenance, DetectorSourceType, DiscoveryUnsupportedFact, SecurityDiscoveryInput, SecurityDiscoveryResult } from "./types";

const DETECTOR_VERSION = "BE8_STATIC_DISCOVERY_V1" as const;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SOURCE_FILES = 1000;

function stableId(prefix: string, payload: unknown): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)}`;
}

function normalizeWorkspacePath(path: string): string | undefined {
  if (path.length === 0 || path.length > 240) return undefined;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return undefined;
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return undefined;
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return normalized;
}

function provenance(sourceType: DetectorSourceType, path: string, detail?: string, confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH"): DetectionProvenance {
  return { sourceType, path, confidence, detectorVersion: DETECTOR_VERSION, detail };
}

function tech(id: string, label: string, family: DetectedTechnology["family"], prov: DetectionProvenance[], version?: string): DetectedTechnology {
  const confidence = prov.some((item) => item.confidence === "HIGH") ? "HIGH" : prov.some((item) => item.confidence === "MEDIUM") ? "MEDIUM" : "LOW";
  return { id, label, family, version, confidence, provenance: prov };
}

function addTechnology(map: Map<string, DetectedTechnology>, next: DetectedTechnology): void {
  const current = map.get(next.id);
  if (!current) {
    map.set(next.id, next);
    return;
  }
  map.set(next.id, {
    ...current,
    version: current.version ?? next.version,
    confidence: current.confidence === "HIGH" || next.confidence === "HIGH" ? "HIGH" : current.confidence === "MEDIUM" || next.confidence === "MEDIUM" ? "MEDIUM" : "LOW",
    provenance: [...current.provenance, ...next.provenance],
  });
}

function safeJson(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function dependencyVersion(manifest: Record<string, unknown>, name: string): string | undefined {
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = manifest[key];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      const value = (deps as Record<string, unknown>)[name];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

function inspectPackageJson(path: string, content: string, map: Map<string, DetectedTechnology>, unsupported: DiscoveryUnsupportedFact[]): void {
  const parsed = safeJson(content);
  if (!parsed) {
    unsupported.push({ path, reason: "MALFORMED_MANIFEST" });
    return;
  }
  const prov = provenance("manifest", path, "package.json static metadata");
  addTechnology(map, tech("javascript", "JavaScript", "language", [prov]));
  addTechnology(map, tech("node", "Node.js", "runtime", [prov]));
  const next = dependencyVersion(parsed, "next");
  if (next) addTechnology(map, tech("nextjs", "Next.js", "framework", [provenance("manifest", path, "next dependency")], next));
  const react = dependencyVersion(parsed, "react");
  if (react) addTechnology(map, tech("react", "React", "framework", [provenance("manifest", path, "react dependency")], react));
  const angular = dependencyVersion(parsed, "@angular/core");
  if (angular) addTechnology(map, tech("angular", "Angular", "framework", [provenance("manifest", path, "@angular/core dependency")], angular));
  const pg = dependencyVersion(parsed, "pg");
  if (pg) addTechnology(map, tech("postgresql", "PostgreSQL", "database", [provenance("manifest", path, "pg dependency")], pg));
  const scripts = parsed.scripts;
  if (scripts && typeof scripts === "object") addTechnology(map, tech("package-scripts-present", "Package scripts present but not executed", "deployment", [provenance("manifest", path, "scripts key observed; no scripts executed", "MEDIUM")]));
}

function inspectProjectFile(path: string, content: string, map: Map<string, DetectedTechnology>): void {
  if (path.endsWith(".csproj") || path.endsWith(".sln")) {
    addTechnology(map, tech("dotnet", ".NET", "runtime", [provenance("project_file", path, ".NET project metadata")]));
    addTechnology(map, tech("csharp", "C#", "language", [provenance("project_file", path, ".NET project metadata")]));
    const target = content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/i)?.[1];
    if (target) addTechnology(map, tech("dotnet-target-framework", ".NET target framework", "runtime", [provenance("project_file", path, "TargetFramework")], target));
  }
}

function inspectStaticFile(path: string, content: string, map: Map<string, DetectedTechnology>): void {
  const name = basename(path).toLowerCase();
  const ext = extname(path).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") addTechnology(map, tech("typescript", "TypeScript", "language", [provenance("source_distribution", path, ext)]));
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") addTechnology(map, tech("javascript", "JavaScript", "language", [provenance("source_distribution", path, ext, "MEDIUM")]));
  if (ext === ".cs") addTechnology(map, tech("csharp", "C#", "language", [provenance("source_distribution", path, ext)]));
  if (ext === ".py") addTechnology(map, tech("python", "Python", "language", [provenance("source_distribution", path, ext)]));
  if (ext === ".go") addTechnology(map, tech("go", "Go", "language", [provenance("source_distribution", path, ext)]));
  if (ext === ".php") addTechnology(map, tech("php", "PHP", "language", [provenance("source_distribution", path, ext)]));
  if (name === "dockerfile" || path.toLowerCase().endsWith("/dockerfile")) addTechnology(map, tech("docker", "Docker", "container", [provenance("container_iac", path, "Dockerfile")]));
  if (ext === ".tf") addTechnology(map, tech("terraform", "Terraform", "iac", [provenance("container_iac", path, ".tf")]));
  if (name.endsWith(".gitlab-ci.yml") || path === ".gitlab-ci.yml") addTechnology(map, tech("gitlab-ci", "GitLab CI", "ci", [provenance("ci_config", path, "GitLab CI config")]));
  if (path.startsWith(".github/workflows/") && (ext === ".yml" || ext === ".yaml")) addTechnology(map, tech("github-actions", "GitHub Actions", "ci", [provenance("ci_config", path, "GitHub Actions workflow")]));
  if (name === "openapi.json" || name === "openapi.yaml" || name === "swagger.json") addTechnology(map, tech("openapi", "OpenAPI", "deployment", [provenance("deployment_descriptor", path, "API descriptor")]));
  if (content.includes("OIDC") || content.includes("openid-client") || content.includes("Keycloak") || content.includes("Entra")) {
    addTechnology(map, tech("auth-identity", "Authentication/identity integration", "auth", [provenance("source_distribution", path, "auth keyword", "MEDIUM")]));
  }
}

export function discoverSecurityStack(input: SecurityDiscoveryInput): SecurityDiscoveryResult {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.projectId)) throw new Error("security_discovery_project_invalid");
  if (!/^[0-9a-f]{7,64}$/i.test(input.sourceRevision)) throw new Error("security_discovery_revision_invalid");
  const map = new Map<string, DetectedTechnology>();
  const unsupported: DiscoveryUnsupportedFact[] = [];
  for (const file of input.files.slice(0, MAX_SOURCE_FILES)) {
    const path = normalizeWorkspacePath(file.path);
    if (!path) {
      unsupported.push({ path: file.path, reason: "MALICIOUS_PATH" });
      continue;
    }
    if (file.kind === "symlink") {
      unsupported.push({ path, reason: "SYMLINK_UNSUPPORTED" });
      continue;
    }
    if (file.binary) {
      unsupported.push({ path, reason: "BINARY_UNPARSEABLE" });
      continue;
    }
    const size = file.sizeBytes ?? file.content?.length ?? 0;
    const name = basename(path).toLowerCase();
    const isManifest = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "requirements.txt", "pyproject.toml", "go.mod"].includes(name) || path.endsWith(".csproj") || path.endsWith(".sln");
    if (isManifest && size > MAX_MANIFEST_BYTES) {
      unsupported.push({ path, reason: "OVERSIZED_MANIFEST" });
      continue;
    }
    const content = file.content ?? "";
    if (name === "package.json") inspectPackageJson(path, content, map, unsupported);
    if (name === "package-lock.json" || name === "pnpm-lock.yaml" || name === "yarn.lock") addTechnology(map, tech("node-lockfile", "Node lockfile", "deployment", [provenance("lockfile", path, name)]));
    if (name === "requirements.txt" || name === "pyproject.toml") addTechnology(map, tech("python", "Python", "language", [provenance("dependency_manifest", path, name)]));
    if (name === "go.mod") addTechnology(map, tech("go", "Go", "language", [provenance("dependency_manifest", path, name)]));
    inspectProjectFile(path, content, map);
    inspectStaticFile(path, content, map);
  }
  const detected = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    discoveryId: stableId("disc", { projectId: input.projectId, targetId: input.targetId, sourceRevision: input.sourceRevision, detected: detected.map((item) => item.id), unsupported }),
    projectId: input.projectId,
    targetId: input.targetId,
    sourceRevision: input.sourceRevision,
    detectorVersion: DETECTOR_VERSION,
    readOnly: true,
    detected,
    unsupported,
    callerDeclaredStackIgnored: Array.isArray(input.callerDeclaredStack) && input.callerDeclaredStack.length > 0,
    unknown: detected.length === 0,
    safety: {
      packageScriptsExecuted: false,
      networkUsed: false,
      dependencyInstallAttempted: false,
      arbitraryHostPathsAccepted: false,
    },
  };
}
