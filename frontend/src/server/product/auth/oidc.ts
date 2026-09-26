import "server-only";
import { createHash } from "node:crypto";
import * as oidc from "openid-client";
import type { ProductOidcConfig } from "./config";
import type { SafeProductIdentity } from "../identity/types";

export interface OidcTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
}

export interface OidcCallbackResult {
  issuer?: string;
  identity: SafeProductIdentity;
  tokens: OidcTokens;
}

export interface ProductOidcPort {
  begin(config: ProductOidcConfig): Promise<{ url: URL; state: string; nonce: string; codeVerifier: string }>;
  callback(config: ProductOidcConfig, request: Request, expected: { state: string; nonce: string; codeVerifier: string }): Promise<OidcCallbackResult>;
  revoke(config: ProductOidcConfig, tokens: OidcTokens): Promise<void>;
}

function provisionalUserRef(issuer: string, subject: string): string {
  return `usr_${createHash("sha256").update(`${issuer}\0${subject}`).digest("base64url").slice(0, 32)}`;
}

async function clientConfiguration(config: ProductOidcConfig): Promise<oidc.Configuration> {
  const auth = config.clientSecret ? oidc.ClientSecretPost(config.clientSecret) : oidc.None();
  return oidc.discovery(config.issuer, config.clientId, undefined, auth);
}

export class OpenIdClientPort implements ProductOidcPort {
  async begin(config: ProductOidcConfig) {
    const client = await clientConfiguration(config);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: config.redirectUri.href,
      scope: config.scope,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url, state, nonce, codeVerifier };
  }

  async callback(config: ProductOidcConfig, request: Request, expected: { state: string; nonce: string; codeVerifier: string }): Promise<OidcCallbackResult> {
    const client = await clientConfiguration(config);
    const result = await oidc.authorizationCodeGrant(client, request, {
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      pkceCodeVerifier: expected.codeVerifier,
      idTokenExpected: true,
    });
    const claims = result.claims();
    const configuredIssuer = config.issuer.href.replace(/\/$/, "");
    if (!claims?.sub || claims.iss !== configuredIssuer) throw new Error("product_identity_claims_invalid");
    const exp = typeof claims.exp === "number" ? claims.exp * 1000 : 0;
    if (!exp || exp <= Date.now()) throw new Error("product_identity_token_expired");
    return {
      issuer: claims.iss,
      identity: {
        userRef: provisionalUserRef(claims.iss, claims.sub),
        subject: claims.sub,
        displayName: typeof claims.name === "string" ? claims.name : undefined,
        email: typeof claims.email === "string" ? claims.email : undefined,
        emailVerified: typeof claims.email_verified === "boolean" ? claims.email_verified : undefined,
        federationProviderId: config.federationProviderId,
      },
      tokens: {
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        idToken: result.id_token,
        expiresAt: exp,
      },
    };
  }

  async revoke(config: ProductOidcConfig, tokens: OidcTokens): Promise<void> {
    const client = await clientConfiguration(config);
    if (tokens.refreshToken) await oidc.tokenRevocation(client, tokens.refreshToken, { token_type_hint: "refresh_token" });
    if (tokens.accessToken) await oidc.tokenRevocation(client, tokens.accessToken, { token_type_hint: "access_token" });
  }
}
