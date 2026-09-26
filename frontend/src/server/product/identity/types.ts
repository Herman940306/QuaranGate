export type PrincipalMappingState =
  | { state: "unmapped" }
  | { state: "mapped-reference"; principalRef: string; mappingVersion: number }
  | { state: "unavailable" }
  | { state: "forbidden" }
  // BE1-R2 compatibility only. BE3 resolvers never emit this legacy shape.
  | { state: "mapped"; principalRef: string };

export interface ProductWorkspace {
  id: string;
  organizationId: string;
  name: string;
}

export interface SafeProductIdentity {
  userRef: string;
  subject: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
  federationProviderId?: string;
}

export interface ProductSession {
  id: string;
  identity: SafeProductIdentity;
  workspace?: ProductWorkspace;
  version: number;
  issuedAt: number;
  expiresAt: number;
  correlationId: string;
  csrfToken: string;
  principalMapping: PrincipalMappingState;
  oidcTokens: {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
  };
}

export interface LoginTransaction {
  id: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
  expiresAt: number;
}

export interface ProductSessionView {
  identity: SafeProductIdentity;
  workspace?: ProductWorkspace;
  sessionVersion: number;
  issuedAt: string;
  expiresAt: string;
  correlationId: string;
  principalMapping: PrincipalMappingState;
  csrfToken: string;
}
