import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PostgresProductContextAdapter } from "../../src/server/product/adapters/postgres-context";
import type { ProductOidcConfig } from "../../src/server/product/auth/config";
import type { OidcCallbackResult, OidcTokens, ProductOidcPort } from "../../src/server/product/auth/oidc";
import type { ProductDataRepository } from "../../src/server/product/data/repository";
import { ProductSessionService } from "../../src/server/product/session/service";
import { MemoryProductSessionStore } from "../../src/server/product/session/store";

const originalEnv = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    QG_PRODUCT_SESSION_ADAPTER: "memory",
    QG_PRODUCT_OIDC_ISSUER: "https://id.example.invalid/realms/quarangate",
    QG_PRODUCT_OIDC_CLIENT_ID: "quarangate-product",
    QG_PRODUCT_OIDC_REDIRECT_URI: "https://app.example.invalid/api/product/auth/callback",
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("BE2 durable product-context integration", () => {
  it("replaces provisional OIDC userRef with the durable PostgreSQL product-user id", async () => {
    const users = {
      findOrCreateByIdentity: vi.fn().mockResolvedValue({
        id: "durable-user-id",
        issuer: "https://id.example.invalid/realms/quarangate",
        subject: "subject-a",
        status: "active",
        version: 0,
        createdAt: "2026-09-26T00:00:00.000Z",
        updatedAt: "2026-09-26T00:00:00.000Z",
      }),
    };
    const context = {
      resolveWorkspaceMembership: vi.fn(),
    };
    const adapter = new PostgresProductContextAdapter({ users, context } as unknown as ProductDataRepository);

    const resolved = await adapter.resolveIdentity("https://id.example.invalid/realms/quarangate", {
      userRef: "provisional-user-ref",
      subject: "subject-a",
      displayName: "User A",
    });

    expect(resolved.userRef).toBe("durable-user-id");
    expect(users.findOrCreateByIdentity).toHaveBeenCalledWith({
      issuer: "https://id.example.invalid/realms/quarangate",
      subject: "subject-a",
      displayName: "User A",
      email: undefined,
      emailVerified: undefined,
    });
  });

  it("uses durable identity resolution before creating the BE1 product session", async () => {
    const oidc: ProductOidcPort = {
      async begin() {
        return {
          url: new URL("https://id.example.invalid/authorize"),
          state: "state-a",
          nonce: "nonce-a",
          codeVerifier: "verifier-a",
        };
      },
      async callback(_config: ProductOidcConfig): Promise<OidcCallbackResult> {
        return {
          issuer: "https://id.example.invalid/realms/quarangate",
          identity: {
            userRef: "provisional-user-ref",
            subject: "subject-a",
            displayName: "User A",
          },
          tokens: {
            accessToken: "server-held-access-token",
            expiresAt: Date.now() + 60_000,
          },
        };
      },
      async revoke(_config: ProductOidcConfig, _tokens: OidcTokens) {},
    };

    const contextAdapter = {
      resolveIdentity: vi.fn().mockResolvedValue({
        userRef: "durable-user-id",
        subject: "subject-a",
        displayName: "User A",
      }),
      workspaceForUser: vi.fn(),
    };

    const service = new ProductSessionService(
      new MemoryProductSessionStore(),
      oidc,
      contextAdapter,
      () => {},
    );

    const start = await service.beginLogin();
    const session = await service.completeLogin(
      new Request("https://app.example.invalid/api/product/auth/callback?code=synthetic&state=state-a"),
      start.transaction.id,
    );

    expect(contextAdapter.resolveIdentity).toHaveBeenCalledWith(
      "https://id.example.invalid/realms/quarangate",
      expect.objectContaining({ subject: "subject-a" }),
    );
    expect(session.identity.userRef).toBe("durable-user-id");
    expect(JSON.stringify(service.view(session))).not.toContain("server-held-access-token");
  });

  it("resolves workspace membership through the durable context repository", async () => {
    const users = { findOrCreateByIdentity: vi.fn() };
    const context = {
      resolveWorkspaceMembership: vi.fn().mockResolvedValue({
        id: "workspace-a",
        organizationId: "org-a",
        name: "Workspace A",
        status: "active",
        version: 0,
        createdAt: "2026-09-26T00:00:00.000Z",
        updatedAt: "2026-09-26T00:00:00.000Z",
      }),
    };
    const adapter = new PostgresProductContextAdapter({ users, context } as unknown as ProductDataRepository);

    await expect(adapter.workspaceForUser("user-a", "workspace-a")).resolves.toEqual({
      id: "workspace-a",
      organizationId: "org-a",
      name: "Workspace A",
    });
    expect(context.resolveWorkspaceMembership).toHaveBeenCalledWith("user-a", "workspace-a");
  });
});
