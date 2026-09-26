import "server-only";
import { randomUUID } from "node:crypto";
import type { AuditSink } from "../audit/events";
import { defaultAuditSink } from "../audit/events";
import { assertCsrf } from "../authority/csrf";
import type { ProductContextAdapter } from "../adapters/workspace";
import { PostgresProductContextAdapter } from "../adapters/postgres-context";
import { productDataRepository } from "../data/runtime";
import type { PrincipalMappingAdapter } from "../principal/adapter";
import { PostgresPrincipalMappingAdapter, UnmappedTestPrincipalMappingAdapter } from "../principal/adapter";
import { loadProductOidcConfig } from "../auth/config";
import type { ProductOidcPort } from "../auth/oidc";
import { OpenIdClientPort } from "../auth/oidc";
import type { ProductSession, ProductSessionView } from "../identity/types";
import type { ProductSessionStore } from "./store";
import { MemoryProductSessionStore, opaqueId } from "./store";

const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function defaultPrincipalMappingAdapter(audit: AuditSink): PrincipalMappingAdapter {
  if (process.env.NODE_ENV === "test") return new UnmappedTestPrincipalMappingAdapter();
  return new PostgresPrincipalMappingAdapter(productDataRepository(), audit);
}

export class ProductSessionService {
  constructor(
    private readonly store: ProductSessionStore = new MemoryProductSessionStore(),
    private readonly oidc: ProductOidcPort = new OpenIdClientPort(),
    private readonly context: ProductContextAdapter = new PostgresProductContextAdapter(productDataRepository()),
    private readonly audit: AuditSink = defaultAuditSink,
    private readonly principalMappings: PrincipalMappingAdapter = defaultPrincipalMappingAdapter(audit),
  ) {}

  async beginLogin(now = Date.now()) {
    const config = loadProductOidcConfig();
    const start = await this.oidc.begin(config);
    const transaction = this.store.createTransaction({
      state: start.state,
      nonce: start.nonce,
      codeVerifier: start.codeVerifier,
      createdAt: now,
      expiresAt: now + LOGIN_TTL_MS,
    });
    this.audit({ event: "identity.login_started", outcome: "allowed", correlationId: randomUUID() });
    return { authorizationUrl: start.url, transaction };
  }

  async completeLogin(request: Request, transactionId: string, priorSessionId?: string, now = Date.now()) {
    const transaction = this.store.consumeTransaction(transactionId, now);
    if (!transaction) throw new Error("product_login_transaction_invalid");
    try {
      const result = await this.oidc.callback(loadProductOidcConfig(), request, {
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
      const expiresAt = Math.min(result.tokens.expiresAt, now + SESSION_TTL_MS);
      if (expiresAt <= now) throw new Error("product_identity_token_expired");
      const durableIdentity = await this.context.resolveIdentity(
        result.issuer ?? loadProductOidcConfig().issuer.href.replace(/\/$/, ""),
        result.identity,
      );
      if (priorSessionId) this.store.revokeSession(priorSessionId);
      const session = this.store.createSession({
        identity: durableIdentity,
        version: 1,
        issuedAt: now,
        expiresAt,
        correlationId: randomUUID(),
        csrfToken: opaqueId(),
        principalMapping: { state: "unmapped" },
        oidcTokens: {
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken,
          idToken: result.tokens.idToken,
        },
      });
      this.audit({ event: "identity.login_succeeded", outcome: "allowed", correlationId: session.correlationId, userRef: session.identity.userRef });
      return session;
    } catch (error) {
      this.audit({ event: "identity.login_failed", outcome: "denied", correlationId: randomUUID(), reason: "oidc_callback_rejected" });
      throw error;
    }
  }

  current(sessionId: string | undefined, now = Date.now()): ProductSession {
    if (!sessionId) throw new Error("product_session_missing");
    const session = this.store.getSession(sessionId, now);
    if (!session) throw new Error("product_session_invalid");
    this.audit({ event: "identity.session_read", outcome: "allowed", correlationId: session.correlationId, userRef: session.identity.userRef });
    return session;
  }

  async currentResolved(sessionId: string | undefined, now = Date.now()): Promise<ProductSession> {
    const session = this.current(sessionId, now);
    if (!session.workspace) {
      if (session.principalMapping.state === "unmapped") return session;
      const cleared = { ...session, principalMapping: { state: "unmapped" } as const };
      this.store.replaceSession(cleared);
      return cleared;
    }

    const expectedMappingVersion =
      session.principalMapping.state === "mapped-reference"
        ? session.principalMapping.mappingVersion
        : undefined;
    const principalMapping = await this.principalMappings.resolve({
      productUserId: session.identity.userRef,
      organizationId: session.workspace.organizationId,
      workspaceId: session.workspace.id,
      correlationId: session.correlationId,
      expectedMappingVersion,
    });
    const updated = { ...session, principalMapping };
    this.store.replaceSession(updated);
    return updated;
  }

  view(session: ProductSession): ProductSessionView {
    return {
      identity: session.identity,
      workspace: session.workspace,
      sessionVersion: session.version,
      issuedAt: new Date(session.issuedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      correlationId: session.correlationId,
      principalMapping: session.principalMapping,
      csrfToken: session.csrfToken,
    };
  }

  async switchWorkspace(request: Request, sessionId: string | undefined, workspaceId: string, expectedSessionVersion: number) {
    const session = this.current(sessionId);
    assertCsrf(request, session);
    if (session.version !== expectedSessionVersion) throw new Error("product_session_stale_version");
    const workspace = await this.context.workspaceForUser(session.identity.userRef, workspaceId);
    if (!workspace) throw new Error("product_workspace_forbidden");
    const principalMapping = await this.principalMappings.resolve({
      productUserId: session.identity.userRef,
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      correlationId: session.correlationId,
    });
    const updated: ProductSession = {
      ...session,
      workspace,
      principalMapping,
      version: session.version + 1,
      csrfToken: opaqueId(),
    };
    this.store.replaceSession(updated);
    this.audit({ event: "identity.workspace_switched", outcome: "allowed", correlationId: updated.correlationId, userRef: updated.identity.userRef, workspaceId });
    return updated;
  }

  async logout(request: Request, sessionId: string | undefined): Promise<void> {
    const session = this.current(sessionId);
    assertCsrf(request, session);
    this.store.revokeSession(session.id);
    this.audit({ event: "identity.logout", outcome: "allowed", correlationId: session.correlationId, userRef: session.identity.userRef });
    try {
      await this.oidc.revoke(loadProductOidcConfig(), { ...session.oidcTokens, expiresAt: session.expiresAt });
    } catch {
      // Local session termination is fail-closed even when remote revocation is unavailable.
    }
  }
}
