import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { QueryExecutor, QueryResultLike } from "../../src/server/product/data/db";
import { readAllProductMigrations } from "../../src/server/product/data/migrations";
import { ProductDataRepository } from "../../src/server/product/data/repository";
import { PostgresPrincipalMappingAdapter } from "../../src/server/product/principal/adapter";
import { PrincipalMappingRepository } from "../../src/server/product/principal/repository";
import { ProductSessionService } from "../../src/server/product/session/service";
import { MemoryProductSessionStore } from "../../src/server/product/session/store";

type Recorded = { text: string; values?: readonly unknown[] };
class ScriptedDb implements QueryExecutor {
  readonly calls: Recorded[] = [];
  constructor(private readonly responses: QueryResultLike<Record<string, unknown>>[] = [], private readonly failure?: Error) {}
  async query<T>(text: string, values?: readonly unknown[]): Promise<QueryResultLike<T>> {
    this.calls.push({ text, values });
    if (this.failure) throw this.failure;
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as QueryResultLike<T>;
  }
}

const row = {
  id: "44444444-4444-4444-8444-444444444444",
  product_user_id: "user-a",
  organization_id: "org-a",
  workspace_id: "ws-a",
  principal_ref: "chatgpt-browser",
  status: "active" as const,
  version: 4,
  created_at: "2026-09-26T00:00:00.000Z",
  updated_at: "2026-09-26T00:00:00.000Z",
};

describe("BE3 principal mapping repository", () => {
  it("returns unmapped without a privileged/default fallback", async () => {
    const repo = new PrincipalMappingRepository(new ScriptedDb([{ rows: [], rowCount: 0 }]));
    await expect(repo.resolve({ productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a" }))
      .resolves.toEqual({ state: "unmapped" });
  });

  it("returns only a mapped Principal reference and mapping revision", async () => {
    const db = new ScriptedDb([{ rows: [row], rowCount: 1 }]);
    await expect(new PrincipalMappingRepository(db).resolve({
      productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a",
    })).resolves.toEqual({ state: "mapped-reference", principalRef: "chatgpt-browser", mappingVersion: 4 });
    expect(db.calls[0]?.values).toEqual(["user-a", "org-a", "ws-a"]);
    expect(JSON.stringify(db.calls[0])).not.toMatch(/scopes|targets|agentBackends|githubAccounts/i);
  });

  it("creates mappings only through a server-side membership-bound parameterized write", async () => {
    const db = new ScriptedDb([{ rows: [{ ...row, version: 0 }], rowCount: 1 }]);
    await expect(new PrincipalMappingRepository(db).create({
      productUserId: "user-a",
      organizationId: "org-a",
      workspaceId: "ws-a",
      principalRef: "chatgpt-browser",
    })).resolves.toEqual({ state: "mapped-reference", principalRef: "chatgpt-browser", mappingVersion: 0 });
    expect(db.calls[0]?.text).toContain("m.product_user_id = pu.id");
    expect(db.calls[0]?.text).toContain("pu.status = 'active'");
    expect(db.calls[0]?.text).not.toContain("chatgpt-browser");
    expect(db.calls[0]?.values?.slice(1)).toEqual(["user-a", "org-a", "ws-a", "chatgpt-browser"]);
  });

  it("fails closed on stale mapping administration updates", async () => {
    const db = new ScriptedDb([{ rows: [], rowCount: 0 }]);
    await expect(new PrincipalMappingRepository(db).update({
      productUserId: "user-a",
      organizationId: "org-a",
      workspaceId: "ws-a",
      principalRef: "chatgpt-browser",
      status: "active",
      expectedVersion: 3,
    })).resolves.toEqual({ state: "unavailable" });
    expect(db.calls[0]?.text).toContain("version = $6");
    expect(db.calls[0]?.text).toContain("version = version + 1");
  });

  it("fails closed when the mapping backend is unavailable", async () => {
    const repo = new PrincipalMappingRepository(new ScriptedDb([], new Error("database secret host detail")));
    await expect(repo.resolve({ productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a" }))
      .resolves.toEqual({ state: "unavailable" });
  });

  it.each(["disabled", "revoked"] as const)("treats %s mappings as forbidden", async (status) => {
    const repo = new PrincipalMappingRepository(new ScriptedDb([{ rows: [{ ...row, status }], rowCount: 1 }]));
    await expect(repo.resolve({ productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a" }))
      .resolves.toEqual({ state: "forbidden" });
  });

  it("fails closed on an ambiguous mapping result", async () => {
    const repo = new PrincipalMappingRepository(new ScriptedDb([{ rows: [row, { ...row, id: "other" }], rowCount: 2 }]));
    await expect(repo.resolve({ productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a" }))
      .resolves.toEqual({ state: "unavailable" });
  });

  it("binds lookup to user, organization and workspace to prevent substitution", async () => {
    const db = new ScriptedDb([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }]);
    const repo = new PrincipalMappingRepository(db);
    await repo.resolve({ productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a" });
    await repo.resolve({ productUserId: "user-b", organizationId: "org-b", workspaceId: "ws-b" });
    expect(db.calls[0]?.text).toBe(db.calls[1]?.text);
    expect(db.calls[0]?.values).toEqual(["user-a", "org-a", "ws-a"]);
    expect(db.calls[1]?.values).toEqual(["user-b", "org-b", "ws-b"]);
    expect(db.calls[0]?.text).toContain("pu.status = 'active'");
    expect(db.calls[0]?.text).toContain("m.product_user_id = pm.product_user_id");
    expect(db.calls[0]?.text).toContain("m.workspace_id = pm.workspace_id");
  });

  it("fails closed when a cached mapping revision is stale", async () => {
    const repo = new PrincipalMappingRepository(new ScriptedDb([{ rows: [row], rowCount: 1 }]));
    await expect(repo.resolve({
      productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a", expectedMappingVersion: 3,
    })).resolves.toEqual({ state: "unavailable" });
  });

  it("rejects unsafe Principal reference shapes before exposure or audit", async () => {
    const repo = new PrincipalMappingRepository(new ScriptedDb([{ rows: [{ ...row, principal_ref: "principal\nsecret=oops" }], rowCount: 1 }]));
    await expect(repo.resolve({ productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a" }))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
  });
});

describe("BE3 session confused-deputy defenses", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("QG_PRODUCT_SESSION_ADAPTER", "memory");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("workspace switch discards prior mapping and re-resolves from server-held user/context", async () => {
    const store = new MemoryProductSessionStore();
    const mapping = { resolve: vi.fn(async (ctx: { workspaceId: string }) => ({
      state: "mapped-reference" as const,
      principalRef: ctx.workspaceId === "ws-b" ? "principal-b" : "principal-a",
      mappingVersion: 1,
    })) };
    const context = {
      resolveIdentity: vi.fn(),
      workspaceForUser: vi.fn(async (userRef: string, workspaceId: string) =>
        userRef === "user-a" && workspaceId === "ws-b"
          ? { id: "ws-b", organizationId: "org-b", name: "Workspace B" }
          : undefined),
    };
    const service = new ProductSessionService(store, {} as never, context, () => {}, mapping);
    const session = store.createSession({
      identity: { userRef: "user-a", subject: "subject-a" },
      workspace: { id: "ws-a", organizationId: "org-a", name: "Workspace A" },
      version: 2,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      correlationId: "corr-a",
      csrfToken: "csrf-a",
      principalMapping: { state: "mapped-reference", principalRef: "principal-a", mappingVersion: 9 },
      oidcTokens: {},
    });
    const request = new Request("https://app.example.invalid/api/product/session/workspace", {
      method: "POST",
      headers: { origin: "https://app.example.invalid", "sec-fetch-site": "same-origin", "x-csrf-token": "csrf-a" },
    });
    const switched = await service.switchWorkspace(request, session.id, "ws-b", 2);
    expect(switched.principalMapping).toEqual({ state: "mapped-reference", principalRef: "principal-b", mappingVersion: 1 });
    expect(mapping.resolve).toHaveBeenCalledWith({
      productUserId: "user-a",
      organizationId: "org-b",
      workspaceId: "ws-b",
      correlationId: "corr-a",
    });
  });

  it("same-context session read passes mapping revision and fails closed on stale resolution", async () => {
    const store = new MemoryProductSessionStore();
    const mapping = { resolve: vi.fn(async () => ({ state: "unavailable" as const })) };
    const service = new ProductSessionService(store, {} as never, {} as never, () => {}, mapping);
    const session = store.createSession({
      identity: { userRef: "user-a", subject: "subject-a" },
      workspace: { id: "ws-a", organizationId: "org-a", name: "Workspace A" },
      version: 1,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      correlationId: "corr-a",
      csrfToken: "csrf-a",
      principalMapping: { state: "mapped-reference", principalRef: "old-principal", mappingVersion: 7 },
      oidcTokens: {},
    });
    const refreshed = await service.currentResolved(session.id);
    expect(refreshed.principalMapping).toEqual({ state: "unavailable" });
    expect(mapping.resolve).toHaveBeenCalledWith(expect.objectContaining({
      productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a", expectedMappingVersion: 7,
    }));
    expect(JSON.stringify(service.view(refreshed))).not.toContain("old-principal");
  });

  it("browser session view exposes mapping metadata but no grants or tokens", () => {
    const service = new ProductSessionService(new MemoryProductSessionStore(), {} as never, {} as never, () => {}, { resolve: vi.fn() });
    const view = service.view({
      id: "session",
      identity: { userRef: "user-a", subject: "subject-a" },
      workspace: { id: "ws-a", organizationId: "org-a", name: "Workspace A" },
      version: 1,
      issuedAt: 1,
      expiresAt: 2,
      correlationId: "corr",
      csrfToken: "csrf",
      principalMapping: { state: "mapped-reference", principalRef: "principal-a", mappingVersion: 4 },
      oidcTokens: { accessToken: "secret-access", refreshToken: "secret-refresh", idToken: "secret-id" },
    });
    expect(view.principalMapping).toEqual({ state: "mapped-reference", principalRef: "principal-a", mappingVersion: 4 });
    expect(JSON.stringify(view)).not.toMatch(/secret-access|secret-refresh|secret-id|scopes|targets|githubAccounts|agentBackends/i);
  });

  it("composes accepted BE2 and BE3 migrations in deterministic order", async () => {
    const migrations = await readAllProductMigrations();
    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: "0001_product_context.sql" },
      { version: 2, name: "0002_principal_mapping.sql" },
    ]);
    expect(migrations.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum))).toBe(true);
  });

  it("product-role storage and mapping schema contain no operational grant synthesis", () => {
    const migration = readFileSync(join(process.cwd(), "src/server/product/principal/migrations/0002_principal_mapping.sql"), "utf8");
    expect(migration).toContain("UNIQUE (product_user_id, workspace_id)");
    expect(migration).toContain("FOREIGN KEY (workspace_id, organization_id)");
    expect(migration).toContain("CHECK (status IN ('active', 'disabled', 'revoked'))");
    expect(migration).not.toMatch(/mcp_scope|target_grant|agent_grant|github_grant|docker|host_authority/i);
  });

  it("browser route accepts workspace/session version only and never a Principal id", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/product/session/workspace/route.ts"), "utf8");
    expect(source).toContain("workspaceId");
    expect(source).toContain("expectedSessionVersion");
    expect(source).not.toMatch(/principalRef|principalId|principal_ref/);
  });

  it("mapping adapter redacts malformed repository details and fails closed", async () => {
    const records: unknown[] = [];
    const data = new ProductDataRepository(new ScriptedDb([{ rows: [{ ...row, principal_ref: "principal\\nsecret=oops" }], rowCount: 1 }]));
    const adapter = new PostgresPrincipalMappingAdapter(data, (record) => records.push(record));
    await expect(adapter.resolve({
      productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a", correlationId: "corr-a",
    })).resolves.toEqual({ state: "unavailable" });
    expect(JSON.stringify(records)).not.toContain("secret=oops");
  });

  it("mapping audit contains only safe correlation/context/reference metadata", async () => {
    const records: unknown[] = [];
    const data = new ProductDataRepository(new ScriptedDb([{ rows: [row], rowCount: 1 }]));
    const adapter = new PostgresPrincipalMappingAdapter(data, (record) => records.push(record));
    await adapter.resolve({ productUserId: "user-a", organizationId: "org-a", workspaceId: "ws-a", correlationId: "corr-a" });
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("chatgpt-browser");
    expect(serialized).not.toMatch(/accessToken|refreshToken|idToken|cookie|keyHash|scopes|targets|githubAccounts/i);
  });
});
