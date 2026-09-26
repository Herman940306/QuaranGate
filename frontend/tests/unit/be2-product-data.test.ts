import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ProductContextRepository } from "../../src/server/product/data/context";
import type { QueryExecutor, QueryResultLike, TransactionPool } from "../../src/server/product/data/db";
import { withTransaction } from "../../src/server/product/data/db";
import { ProductDataError } from "../../src/server/product/data/errors";
import { readSourceMigrations, runMigrations } from "../../src/server/product/data/migrations";
import { UserPreferencesRepository } from "../../src/server/product/data/preferences";
import { ProductUserRepository } from "../../src/server/product/data/users";
import { failure } from "../../src/server/product/http/errors";

type ScriptResult = { rows: QueryResultRow[]; rowCount: number | null };

class ScriptedExecutor implements QueryExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly results: ScriptResult[]) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResultLike<T>> {
    this.calls.push({ text, values });
    const next = this.results.shift();
    if (!next) throw new Error("unexpected_query");
    return next as QueryResultLike<T>;
  }
}

const userRow = {
  id: "11111111-1111-4111-8111-111111111111",
  keycloak_issuer: "https://id.example.invalid/realms/quarangate",
  keycloak_subject: "subject-a",
  display_name: "A",
  email: "a@example.invalid",
  email_verified: true,
  status: "active" as const,
  version: 0,
  created_at: "2026-09-26T00:00:00.000Z",
  updated_at: "2026-09-26T00:00:00.000Z",
};

const workspaceRow = {
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: "33333333-3333-4333-8333-333333333333",
  name: "Workspace A",
  status: "active" as const,
  version: 0,
  created_at: "2026-09-26T00:00:00.000Z",
  updated_at: "2026-09-26T00:00:00.000Z",
};

describe("BE2 migration and repository contracts", () => {
  it("defines tenant-safe schema constraints and no credential defaults", () => {
    const sql = readFileSync(join(process.cwd(), "src/server/product/data/migrations/0001_product_context.sql"), "utf8");
    expect(sql).toContain("UNIQUE (keycloak_issuer, keycloak_subject)");
    expect(sql).toContain("FOREIGN KEY (workspace_id, organization_id)");
    expect(sql).toContain("REFERENCES workspaces(id, organization_id)");
    expect(sql.match(/CHECK \(version >= 0\)/g)?.length).toBeGreaterThanOrEqual(7);
    expect(sql).toContain("timestamptz");
    expect(sql).toContain("permission_key text NOT NULL CHECK (permission_key ~ '^product\\.");
    expect(sql.toLowerCase()).not.toContain("password");
    expect(sql.toLowerCase()).not.toContain("default credential");
  });

  it("loads deterministic ordered source migrations with a stable checksum", async () => {
    const migrations = await readSourceMigrations();
    expect(migrations.map((migration) => migration.version)).toEqual([1]);
    expect(migrations[0]?.name).toBe("0001_product_context.sql");
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates a product user by verified issuer+subject with parameterized values", async () => {
    const db = new ScriptedExecutor([{ rows: [userRow], rowCount: 1 }]);
    const repository = new ProductUserRepository(db);
    const injectedSubject = "subject-a' OR 1=1 --";
    const user = await repository.findOrCreateByIdentity({
      issuer: userRow.keycloak_issuer,
      subject: injectedSubject,
      displayName: "A",
      email: "a@example.invalid",
      emailVerified: true,
    });
    expect(user.id).toBe(userRow.id);
    expect(db.calls[0]?.text).toContain("VALUES ($1, $2, $3, $4, $5, $6)");
    expect(db.calls[0]?.text).not.toContain(injectedSubject);
    expect(db.calls[0]?.values[2]).toBe(injectedSubject);
  });

  it("resolves an existing duplicate issuer+subject without creating a second identity", async () => {
    const db = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [userRow], rowCount: 1 },
    ]);
    const repository = new ProductUserRepository(db);
    const user = await repository.findOrCreateByIdentity({
      issuer: userRow.keycloak_issuer,
      subject: userRow.keycloak_subject,
      displayName: "A",
      email: "a@example.invalid",
      emailVerified: true,
    });
    expect(user.id).toBe(userRow.id);
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]?.values).toEqual([userRow.keycloak_issuer, userRow.keycloak_subject]);
  });

  it("scopes workspace visibility to the authenticated product user and tenant joins", async () => {
    const db = new ScriptedExecutor([
      { rows: [{ ...workspaceRow, organization_name: "Org A", role_classification: "member" }], rowCount: 1 },
    ]);
    const repository = new ProductContextRepository(db);
    const result = await repository.listVisibleWorkspaces("user-a");
    expect(result[0]?.workspace.id).toBe(workspaceRow.id);
    expect(db.calls[0]?.values).toEqual(["user-a"]);
    expect(db.calls[0]?.text).toContain("w.organization_id = m.organization_id");
    expect(db.calls[0]?.text).toContain("o.id = w.organization_id");
  });

  it("fails closed for forbidden cross-workspace membership", async () => {
    const db = new ScriptedExecutor([{ rows: [], rowCount: 0 }]);
    const repository = new ProductContextRepository(db);
    await expect(repository.resolveWorkspaceMembership("user-a", "workspace-b")).resolves.toBeUndefined();
    expect(db.calls[0]?.values).toEqual(["user-a", "workspace-b"]);
  });

  it("keeps cross-user workspace queries isolated in bound parameters", async () => {
    const db = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ProductContextRepository(db);
    await repository.listVisibleWorkspaces("user-a");
    await repository.listVisibleWorkspaces("user-b");
    expect(db.calls[0]?.text).toBe(db.calls[1]?.text);
    expect(db.calls[0]?.values).toEqual(["user-a"]);
    expect(db.calls[1]?.values).toEqual(["user-b"]);
  });

  it("merges product-role defaults with organization and workspace overrides only", async () => {
    const db = new ScriptedExecutor([
      { rows: [{ role_classification: "member", organization_id: workspaceRow.organization_id }], rowCount: 1 },
      {
        rows: [
          { permission_key: "product.workspace.view", enabled: true },
          { permission_key: "product.workspace.manage", enabled: false },
        ],
        rowCount: 2,
      },
      {
        rows: [
          { permission_key: "product.workspace.view", effect: "deny", workspace_id: null },
          { permission_key: "product.workspace.manage", effect: "allow", workspace_id: workspaceRow.id },
        ],
        rowCount: 2,
      },
    ]);
    const repository = new ProductContextRepository(db);
    const effective = await repository.effectiveProductRole("user-a", workspaceRow.id);
    expect(effective).toEqual({ roleClassification: "member", permissions: ["product.workspace.manage"] });
    expect(JSON.stringify(effective)).not.toMatch(/agents:|github:|target|docker/i);
  });

  it("reads preferences and rejects stale optimistic updates", async () => {
    const preferenceRow = {
      product_user_id: userRow.id,
      appearance_mode: "system" as const,
      palette: "mineral",
      density: "comfortable" as const,
      version: 0,
      created_at: "2026-09-26T00:00:00.000Z",
      updated_at: "2026-09-26T00:00:00.000Z",
    };
    const readDb = new ScriptedExecutor([
      { rows: [], rowCount: 1 },
      { rows: [preferenceRow], rowCount: 1 },
    ]);
    const readRepository = new UserPreferencesRepository(readDb);
    await expect(readRepository.read(userRow.id)).resolves.toMatchObject({ palette: "mineral", version: 0 });

    const staleDb = new ScriptedExecutor([{ rows: [], rowCount: 0 }]);
    const staleRepository = new UserPreferencesRepository(staleDb);
    await expect(staleRepository.update(userRow.id, {
      appearanceMode: "dark",
      palette: "mineral",
      density: "compact",
      expectedVersion: 7,
    })).rejects.toMatchObject({ code: "PRODUCT_DATA_STALE_VERSION" });
    expect(staleDb.calls[0]?.text).toContain("version = version + 1");
    expect(staleDb.calls[0]?.text).toContain("version = $5");
  });

  it("rolls back and releases a transaction when work fails", async () => {
    const commands: string[] = [];
    const client = {
      async query(text: string) {
        commands.push(text);
        return { rows: [], rowCount: 0 };
      },
      release() {
        commands.push("RELEASE");
      },
    } as unknown as PoolClient;
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => client,
    } as unknown as TransactionPool;

    await expect(withTransaction(pool, async () => {
      throw new Error("synthetic_failure");
    })).rejects.toThrow("synthetic_failure");
    expect(commands).toEqual(["BEGIN", "ROLLBACK", "RELEASE"]);
  });

  it("fails migration qualification when an applied checksum differs", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ checksum_sha256: "0".repeat(64) }], rowCount: 1 }),
      connect: vi.fn(),
    } as unknown as TransactionPool;
    const migrations = await readSourceMigrations();
    await expect(runMigrations(pool, migrations)).rejects.toMatchObject({ code: "PRODUCT_DATA_INVALID" });
  });

  it("maps product-data failures to bounded browser-safe errors", async () => {
    const response = failure(new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "postgres host /secret/path"));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('"code":"BACKEND_UNAVAILABLE"');
    expect(body).not.toContain("/secret/path");
    expect(body).not.toContain("postgres host");
  });
});
