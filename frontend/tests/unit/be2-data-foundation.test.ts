import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PostgresProductContextAdapter } from "../../src/server/product/adapters/postgres-context";
import { ProductContextRepository } from "../../src/server/product/data/context";
import type { QueryExecutor, QueryResultLike, TransactionPool } from "../../src/server/product/data/db";
import { withTransaction } from "../../src/server/product/data/db";
import { ProductDataError } from "../../src/server/product/data/errors";
import { UserPreferencesRepository } from "../../src/server/product/data/preferences";
import { ProductUserRepository } from "../../src/server/product/data/users";
import { failure } from "../../src/server/product/http/errors";

type RecordedQuery = { text: string; values?: readonly unknown[] };

class QueueDb implements QueryExecutor {
  readonly calls: RecordedQuery[] = [];
  constructor(private readonly responses: QueryResultLike<Record<string, unknown>>[] = []) {}
  async query<T>(text: string, values?: readonly unknown[]): Promise<QueryResultLike<T>> {
    this.calls.push({ text, values });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as QueryResultLike<T>;
  }
}

const now = new Date("2026-09-26T00:00:00.000Z");
const userRow = {
  id: "11111111-1111-4111-8111-111111111111",
  keycloak_issuer: "https://id.example.invalid/realms/qg",
  keycloak_subject: "subject-a",
  display_name: "User A",
  email: "a@example.invalid",
  email_verified: true,
  status: "active" as const,
  version: 0,
  created_at: now,
  updated_at: now,
};

beforeEach(() => vi.restoreAllMocks());

describe("BE2 repository contracts", () => {
  it("finds or creates by verified issuer+subject using parameters", async () => {
    const db = new QueueDb([{ rows: [userRow], rowCount: 1 }]);
    const repo = new ProductUserRepository(db);
    const user = await repo.findOrCreateByIdentity({
      issuer: userRow.keycloak_issuer,
      subject: userRow.keycloak_subject,
      displayName: "User A",
      email: "a@example.invalid",
      emailVerified: true,
    });
    expect(user.id).toBe(userRow.id);
    expect(db.calls[0]?.text).toContain("ON CONFLICT (keycloak_issuer, keycloak_subject)");
    expect(db.calls[0]?.text).not.toContain(userRow.keycloak_subject);
    expect(db.calls[0]?.values).toContain(userRow.keycloak_subject);
  });

  it("resolves an existing duplicate identity without creating a second user", async () => {
    const db = new QueueDb([
      { rows: [], rowCount: 0 },
      { rows: [userRow], rowCount: 1 },
    ]);
    const user = await new ProductUserRepository(db).findOrCreateByIdentity({
      issuer: userRow.keycloak_issuer,
      subject: userRow.keycloak_subject,
      displayName: "User A",
      email: "a@example.invalid",
      emailVerified: true,
    });
    expect(user.id).toBe(userRow.id);
    expect(db.calls).toHaveLength(2);
  });

  it("lists only repository-returned visible organizations and workspaces for the bound user", async () => {
    const orgRow = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Org A",
      status: "active" as const,
      version: 0,
      created_at: now,
      updated_at: now,
      role_classification: "member",
    };
    const workspaceRow = {
      id: "33333333-3333-4333-8333-333333333333",
      organization_id: orgRow.id,
      name: "Workspace A",
      status: "active" as const,
      version: 0,
      created_at: now,
      updated_at: now,
      organization_name: "Org A",
      role_classification: "member",
    };
    const db = new QueueDb([
      { rows: [orgRow], rowCount: 1 },
      { rows: [workspaceRow], rowCount: 1 },
    ]);
    const repo = new ProductContextRepository(db);
    expect((await repo.listVisibleOrganizations(userRow.id))[0]?.organization.id).toBe(orgRow.id);
    expect((await repo.listVisibleWorkspaces(userRow.id))[0]?.workspace.id).toBe(workspaceRow.id);
    for (const call of db.calls) {
      expect(call.text).not.toContain(userRow.id);
      expect(call.values?.[0]).toBe(userRow.id);
      expect(call.text).toContain("m.product_user_id = $1");
    }
  });

  it("does not enumerate a cross-user or cross-workspace id", async () => {
    const db = new QueueDb([{ rows: [], rowCount: 0 }]);
    const result = await new ProductContextRepository(db).resolveWorkspaceMembership(userRow.id, "foreign-workspace");
    expect(result).toBeUndefined();
    expect(db.calls[0]?.values).toEqual([userRow.id, "foreign-workspace"]);
    expect(db.calls[0]?.text).toContain("m.product_user_id = $1");
    expect(db.calls[0]?.text).toContain("m.workspace_id = $2");
  });

  it("merges product role defaults with organization then workspace overrides without operational grants", async () => {
    const db = new QueueDb([
      { rows: [{ role_classification: "member", organization_id: "org-a" }], rowCount: 1 },
      { rows: [
        { permission_key: "product.workspace.read", enabled: true },
        { permission_key: "product.preference.write", enabled: true },
      ], rowCount: 2 },
      { rows: [
        { permission_key: "product.preference.write", effect: "deny", workspace_id: null },
        { permission_key: "product.workspace.read", effect: "allow", workspace_id: "ws-a" },
      ], rowCount: 2 },
    ]);
    const role = await new ProductContextRepository(db).effectiveProductRole(userRow.id, "ws-a");
    expect(role).toEqual({ roleClassification: "member", permissions: ["product.workspace.read"] });
    expect(JSON.stringify(role)).not.toMatch(/mcp|scope|target|docker|github|acp/i);
  });

  it("reads and updates preferences with expectedVersion and rejects stale updates", async () => {
    const preference = {
      product_user_id: userRow.id,
      appearance_mode: "dark" as const,
      palette: "mineral",
      density: "compact" as const,
      version: 2,
      created_at: now,
      updated_at: now,
    };
    const db = new QueueDb([
      { rows: [], rowCount: 0 },
      { rows: [preference], rowCount: 1 },
      { rows: [{ ...preference, version: 3, density: "comfortable" }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const repo = new UserPreferencesRepository(db);
    expect((await repo.read(userRow.id)).version).toBe(2);
    const updated = await repo.update(userRow.id, { appearanceMode: "dark", palette: "mineral", density: "comfortable", expectedVersion: 2 });
    expect(updated.version).toBe(3);
    expect(db.calls[2]?.text).toContain("version = version + 1");
    expect(db.calls[2]?.text).toContain("version = $5");
    await expect(repo.update(userRow.id, { appearanceMode: "dark", palette: "mineral", density: "compact", expectedVersion: 2 }))
      .rejects.toMatchObject({ code: "PRODUCT_DATA_STALE_VERSION" });
  });

  it("rolls back a failed transaction and releases the client", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as TransactionPool;
    await expect(withTransaction(pool, async () => {
      throw new Error("synthetic_failure");
    })).rejects.toThrow("synthetic_failure");
    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("binds verified OIDC identity to the durable product-user id without token or grant synthesis", async () => {
    const data = {
      users: {
        findOrCreateByIdentity: vi.fn(async (verified: { issuer: string; subject: string }) => ({
          ...userRow,
          issuer: verified.issuer,
          subject: verified.subject,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })),
      },
      context: {
        resolveWorkspaceMembership: vi.fn(async (userRef: string, workspaceId: string) =>
          userRef === userRow.id && workspaceId === "ws-a"
            ? { id: "ws-a", organizationId: "org-a", name: "Workspace A" }
            : undefined),
      },
    };
    const adapter = new PostgresProductContextAdapter(data as never);
    const safe = await adapter.resolveIdentity(userRow.keycloak_issuer, {
      userRef: "provisional",
      subject: userRow.keycloak_subject,
      displayName: "User A",
      email: "a@example.invalid",
    });
    expect(safe.userRef).toBe(userRow.id);
    expect(data.users.findOrCreateByIdentity).toHaveBeenCalledWith({
      issuer: userRow.keycloak_issuer,
      subject: userRow.keycloak_subject,
      displayName: "User A",
      email: "a@example.invalid",
      emailVerified: undefined,
    });
    expect(JSON.stringify(safe)).not.toMatch(/accessToken|refreshToken|idToken|scope|grant|docker|github|acp/i);
    expect((await adapter.workspaceForUser(userRow.id, "ws-a"))?.id).toBe("ws-a");
    expect(await adapter.workspaceForUser("other-user", "ws-a")).toBeUndefined();
  });

  it("maps product-data errors to bounded browser-safe responses", async () => {
    const response = failure(new ProductDataError("PRODUCT_DATA_FORBIDDEN", "sensitive internal detail /host/path"));
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain('"code":"FORBIDDEN"');
    expect(body).not.toContain("sensitive internal detail");
    expect(body).not.toContain("/host/path");
  });

  it("migration statically enforces tenant and authority constraints", () => {
    const sql = readFileSync(join(process.cwd(), "src/server/product/data/migrations/0001_product_context.sql"), "utf8");
    expect(sql).toContain("UNIQUE (keycloak_issuer, keycloak_subject)");
    expect(sql).toContain("FOREIGN KEY (workspace_id, organization_id)");
    expect(sql).toContain("REFERENCES workspaces(id, organization_id)");
    expect(sql).toContain("CHECK (version >= 0)");
    expect(sql).toContain("timestamptz");
    expect(sql).toContain("permission_key text NOT NULL CHECK (permission_key ~ '^product\\.");
    expect(sql).not.toMatch(/password|default credentials|access_token|refresh_token|id_token/i);
  });
});
