import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertCsrf } from "../../src/server/product/authority/csrf";
import type { AuditSink, SafeAuditRecord } from "../../src/server/product/audit/events";
import type { ProductOidcConfig } from "../../src/server/product/auth/config";
import type { OidcCallbackResult, OidcTokens, ProductOidcPort } from "../../src/server/product/auth/oidc";
import { NonDurableProductContextAdapter } from "../../src/server/product/adapters/workspace";
import type { SafeProductIdentity } from "../../src/server/product/identity/types";
import { failure } from "../../src/server/product/http/errors";
import { sessionCookie } from "../../src/server/product/http/cookies";
import { ProductSessionService } from "../../src/server/product/session/service";
import { MemoryProductSessionStore } from "../../src/server/product/session/store";

const env = { ...process.env };

const identity: SafeProductIdentity = {
  userRef: "usr_test",
  subject: "keycloak-subject",
  displayName: "Test User",
  email: "test@example.invalid",
  emailVerified: true,
  federationProviderId: "entra-through-keycloak",
};

class SyntheticOidc implements ProductOidcPort {
  callbackResult: OidcCallbackResult = {
    identity,
    tokens: {
      accessToken: "ACCESS_TOKEN_SECRET",
      refreshToken: "REFRESH_TOKEN_SECRET",
      idToken: "ID_TOKEN_SECRET",
      expiresAt: Date.now() + 60_000,
    },
  };
  callbackError?: Error;
  revoked: OidcTokens[] = [];
  expected?: { state: string; nonce: string; codeVerifier: string };

  async begin() {
    return {
      url: new URL("https://id.example.invalid/authorize?client_id=qg"),
      state: "STATE_SECRET",
      nonce: "NONCE_SECRET",
      codeVerifier: "PKCE_VERIFIER_SECRET",
    };
  }

  async callback(_config: ProductOidcConfig, _request: Request, expected: { state: string; nonce: string; codeVerifier: string }) {
    this.expected = expected;
    if (this.callbackError) throw this.callbackError;
    return this.callbackResult;
  }

  async revoke(_config: ProductOidcConfig, tokens: OidcTokens) {
    this.revoked.push(tokens);
  }
}

function request(method = "POST", headers: Record<string, string> = {}) {
  return new Request("https://app.example.invalid/api/product/session/workspace", { method, headers });
}

function configure() {
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.QG_PRODUCT_SESSION_ADAPTER = "memory";
  process.env.QG_PRODUCT_OIDC_ISSUER = "https://id.example.invalid/realms/quarangate";
  process.env.QG_PRODUCT_OIDC_CLIENT_ID = "quarangate-product";
  process.env.QG_PRODUCT_OIDC_REDIRECT_URI = "https://app.example.invalid/api/product/auth/callback";
  process.env.QG_PRODUCT_FEDERATION_PROVIDER_ID = "entra-through-keycloak";
}

async function fixture() {
  const now = Date.now();
  const store = new MemoryProductSessionStore();
  const oidc = new SyntheticOidc();
  const context = new NonDurableProductContextAdapter();
  const audit: SafeAuditRecord[] = [];
  const sink: AuditSink = (record) => audit.push(record);
  const service = new ProductSessionService(store, oidc, context, sink);
  const start = await service.beginLogin(now);
  const session = await service.completeLogin(
    new Request("https://app.example.invalid/api/product/auth/callback?code=synthetic&state=STATE_SECRET"),
    start.transaction.id,
    undefined,
    now + 1,
  );
  return { store, oidc, context, audit, service, start, session };
}

beforeEach(configure);
afterEach(() => {
  process.env = { ...env };
  vi.restoreAllMocks();
});

describe("BE1-R2 product identity/session foundation", () => {
  it("starts login with bounded synthetic OIDC state", async () => {
    const oidc = new SyntheticOidc();
    const service = new ProductSessionService(new MemoryProductSessionStore(), oidc, new NonDurableProductContextAdapter(), () => {});
    const start = await service.beginLogin(1_000);
    expect(start.authorizationUrl.origin).toBe("https://id.example.invalid");
    expect(start.transaction).toMatchObject({ state: "STATE_SECRET", nonce: "NONCE_SECRET", codeVerifier: "PKCE_VERIFIER_SECRET" });
    expect(start.transaction.expiresAt).toBeGreaterThan(start.transaction.createdAt);
  });

  it("establishes a safe session and forwards state/nonce/PKCE expectations", async () => {
    const { oidc, service, session } = await fixture();
    expect(oidc.expected).toEqual({ state: "STATE_SECRET", nonce: "NONCE_SECRET", codeVerifier: "PKCE_VERIFIER_SECRET" });
    const publicView = service.view(session);
    expect(publicView.identity.subject).toBe("keycloak-subject");
    expect(publicView.principalMapping).toEqual({ state: "unmapped" });
    expect(JSON.stringify(publicView)).not.toContain("ACCESS_TOKEN_SECRET");
    expect(JSON.stringify(publicView)).not.toContain("REFRESH_TOKEN_SECRET");
    expect(JSON.stringify(publicView)).not.toContain("ID_TOKEN_SECRET");
  });

  it.each([
    ["invalid issuer", "product_identity_claims_invalid"],
    ["invalid audience", "product_identity_audience_invalid"],
    ["bad state", "product_identity_state_invalid"],
    ["missing state", "product_identity_state_missing"],
    ["bad nonce", "product_identity_nonce_invalid"],
    ["missing nonce", "product_identity_nonce_missing"],
    ["PKCE mismatch", "product_identity_pkce_invalid"],
    ["expired identity", "product_identity_token_expired"],
  ])("fails closed for %s", async (_name, message) => {
    const store = new MemoryProductSessionStore();
    const oidc = new SyntheticOidc();
    oidc.callbackError = new Error(message);
    const service = new ProductSessionService(store, oidc, new NonDurableProductContextAdapter(), () => {});
    const start = await service.beginLogin(1_000);
    await expect(service.completeLogin(new Request("https://app.example.invalid/api/product/auth/callback"), start.transaction.id, undefined, 2_000)).rejects.toThrow(message);
  });

  it("rejects missing, expired and revoked sessions", async () => {
    const { store, service, session } = await fixture();
    expect(() => service.current(undefined)).toThrow("product_session_missing");
    expect(() => service.current(session.id, session.expiresAt)).toThrow("product_session_invalid");
    const fresh = store.createSession({ ...session, id: undefined } as never);
    store.revokeSession(fresh.id);
    expect(() => service.current(fresh.id)).toThrow("product_session_invalid");
  });

  it("requires CSRF and same-origin for state changes", async () => {
    const { session } = await fixture();
    expect(() => assertCsrf(request(), session)).toThrow("product_csrf_denied");
    expect(() => assertCsrf(request("POST", { "x-csrf-token": "wrong" }), session)).toThrow("product_csrf_denied");
    expect(() => assertCsrf(new Request("https://app.example.invalid/api/product/session/workspace", {
      method: "POST",
      headers: { "x-csrf-token": session.csrfToken, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    }), session)).toThrow("product_csrf_origin_denied");
    expect(() => assertCsrf(request("POST", { "x-csrf-token": session.csrfToken, origin: "https://app.example.invalid" }), session)).not.toThrow();
  });

  it("rejects stale workspace switch and forbidden membership, then rotates session version/CSRF", async () => {
    const { context, service, session } = await fixture();
    context.seedForTests(session.identity.userRef, [{ id: "ws-a", organizationId: "org-a", name: "A" }]);
    const headers = { "x-csrf-token": session.csrfToken, origin: "https://app.example.invalid" };
    await expect(service.switchWorkspace(request("POST", headers), session.id, "ws-a", 99)).rejects.toThrow("product_session_stale_version");
    await expect(service.switchWorkspace(request("POST", headers), session.id, "ws-b", 1)).rejects.toThrow("product_workspace_forbidden");
    const updated = await service.switchWorkspace(request("POST", headers), session.id, "ws-a", 1);
    expect(updated.version).toBe(2);
    expect(updated.csrfToken).not.toBe(session.csrfToken);
    expect(updated.workspace?.id).toBe("ws-a");
  });

  it("keeps mapped principal reference informational and does not expose grants", async () => {
    const { store, service, session } = await fixture();
    store.replaceSession({ ...session, principalMapping: { state: "mapped", principalRef: "principal-ref-only" } });
    const view = service.view(service.current(session.id));
    expect(view.principalMapping).toEqual({ state: "mapped", principalRef: "principal-ref-only" });
    expect(JSON.stringify(view)).not.toMatch(/scope|grant|target/i);
  });

  it("isolates users by opaque session id", async () => {
    const { store, service, session } = await fixture();
    const other = store.createSession({
      ...session,
      identity: { ...identity, userRef: "usr_other", subject: "other-subject" },
      correlationId: "other-correlation",
      csrfToken: "other-csrf",
    });
    expect(service.current(session.id).identity.userRef).toBe("usr_test");
    expect(service.current(other.id).identity.userRef).toBe("usr_other");
  });

  it("revokes local session on logout and does not leak token material to audit", async () => {
    const { oidc, audit, service, session } = await fixture();
    await service.logout(request("POST", { "x-csrf-token": session.csrfToken, origin: "https://app.example.invalid" }), session.id);
    expect(() => service.current(session.id)).toThrow("product_session_invalid");
    expect(oidc.revoked).toHaveLength(1);
    const logs = JSON.stringify(audit);
    expect(logs).not.toContain("ACCESS_TOKEN_SECRET");
    expect(logs).not.toContain("REFRESH_TOKEN_SECRET");
    expect(logs).not.toContain("ID_TOKEN_SECRET");
    expect(logs).not.toContain("PKCE_VERIFIER_SECRET");
  });

  it("sanitizes browser errors and sets production cookie protections", async () => {
    const response = failure(new Error("provider ACCESS_TOKEN_SECRET PKCE_VERIFIER_SECRET /host/private/path"));
    const body = await response.text();
    expect(body).toContain('"code":"INTERNAL"');
    expect(body).not.toContain("ACCESS_TOKEN_SECRET");
    expect(body).not.toContain("PKCE_VERIFIER_SECRET");
    expect(body).not.toContain("/host/private/path");
    const cookie = sessionCookie("opaque-session", 60, true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/product");
  });

  it("denies the non-durable adapter in production", () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    expect(() => new MemoryProductSessionStore()).toThrow("product_session_non_durable_production_denied");
    expect(() => new NonDurableProductContextAdapter()).toThrow("product_context_non_durable_production_denied");
  });
});
