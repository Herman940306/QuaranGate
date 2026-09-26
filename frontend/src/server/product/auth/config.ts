import "server-only";

export interface ProductOidcConfig {
  issuer: URL;
  clientId: string;
  clientSecret?: string;
  redirectUri: URL;
  scope: string;
  identityBroker: "keycloak";
  federationProviderId?: string;
  federationTenantId?: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("product_identity_not_configured");
  return value;
}

function trustedUrl(raw: string): URL {
  const url = new URL(raw);
  const production = process.env.NODE_ENV === "production";
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (production && url.protocol !== "https:") throw new Error("product_identity_insecure_url");
  if (!production && url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("product_identity_insecure_url");
  }
  if (url.username || url.password || url.hash) throw new Error("product_identity_invalid_url");
  return url;
}

function identityBroker(): "keycloak" {
  const raw = process.env.QG_PRODUCT_IDENTITY_BROKER?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("product_identity_broker_not_configured");
    return "keycloak";
  }
  if (raw !== "keycloak") throw new Error("product_identity_broker_unsupported");
  return "keycloak";
}

function federationMetadata(): { federationProviderId?: string; federationTenantId?: string } {
  const provider = process.env.QG_PRODUCT_FEDERATION_PROVIDER_ID?.trim();
  if (!provider) return {};

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider)) throw new Error("product_identity_federation_provider_invalid");

  if (provider !== "entra" && provider !== "entra-through-keycloak") throw new Error("product_identity_federation_provider_unsupported");

  const tenant = required("QG_PRODUCT_ENTRA_TENANT_ID");
  const normalized = tenant.toLowerCase();
  if (["common", "organizations", "consumers"].includes(normalized)) throw new Error("product_identity_entra_tenant_ambiguous");
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(tenant)) throw new Error("product_identity_entra_tenant_invalid");
  return { federationProviderId: provider, federationTenantId: tenant };
}

export function loadProductOidcConfig(): ProductOidcConfig {
  const issuer = trustedUrl(required("QG_PRODUCT_OIDC_ISSUER"));
  const redirectUri = trustedUrl(required("QG_PRODUCT_OIDC_REDIRECT_URI"));
  const scope = process.env.QG_PRODUCT_OIDC_SCOPE?.trim() || "openid profile email";
  if (!scope.split(/\s+/).includes("openid")) throw new Error("product_identity_scope_missing_openid");
  return {
    issuer,
    clientId: required("QG_PRODUCT_OIDC_CLIENT_ID"),
    clientSecret: process.env.QG_PRODUCT_OIDC_CLIENT_SECRET?.trim() || undefined,
    redirectUri,
    scope,
    identityBroker: identityBroker(),
    ...federationMetadata(),
  };
}

export function assertMemoryAdapterAllowed(): void {
  const adapter = process.env.QG_PRODUCT_SESSION_ADAPTER?.trim() || "memory";
  if (adapter !== "memory") throw new Error("product_session_adapter_unsupported");
  if (process.env.NODE_ENV === "production") throw new Error("product_session_non_durable_production_denied");
}
