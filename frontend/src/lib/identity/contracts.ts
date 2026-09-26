/** Browser-safe semantic contract. No provider claims, credentials, email or redirect URL. */
export interface ContextReference { id: string; name: string }
export type PrincipalStatus = "mapped" | "unmapped" | "unavailable" | "forbidden";
export interface SessionView {
  user: { id: string; displayName: string };
  organization: ContextReference;
  workspace: ContextReference;
  workspaces: ContextReference[];
  roles: string[];
  overrides: string[];
  principal: { status: PrincipalStatus; reference?: string };
  capabilitySummary: string[];
  version: string;
  issuedAt: string;
  expiresAt: string;
  federationLabel?: string;
}
export const failureKinds = ["unknown", "unavailable", "forbidden", "stale", "expired", "revoked", "workspace_conflict", "cancelled"] as const;
export type FailureKind = typeof failureKinds[number];
export type IdentityState = { kind: FailureKind | "signed_out" | "redirecting" } | { kind: "active" | "expiring"; session: SessionView };
export type IdentityOperation = "session" | "login" | "workspace" | "logout";
export interface IdentityClient {
  readonly integrated: boolean;
  getCurrentSession(signal: AbortSignal): Promise<IdentityState>;
  beginLogin(signal: AbortSignal): Promise<IdentityState>;
  switchWorkspace(workspaceId: string, expectedSessionVersion: string, signal: AbortSignal): Promise<IdentityState>;
  logout(signal: AbortSignal): Promise<IdentityState>;
}
/** Adapter performs accepted cookie/CSRF transport and redirect navigation. Never returns a URL/token. */
export interface IdentityAdapter {
  getCurrentSession(signal: AbortSignal): Promise<unknown>;
  beginLogin(signal: AbortSignal): Promise<unknown>;
  switchWorkspace(workspaceId: string, expectedSessionVersion: string, signal: AbortSignal): Promise<unknown>;
  logout(signal: AbortSignal): Promise<unknown>;
}
export const identityCopy: Record<IdentityState["kind"], string> = {
  unknown: "Session status is unknown. Check the session before continuing.",
  unavailable: "Identity service unavailable. Identity integration pending until an accepted service is connected.",
  forbidden: "Product membership does not allow this request. Check your account with an administrator.",
  stale: "Session version changed. Check the session before switching again.",
  expired: "Session expired. Sign in again to restore your account context.",
  revoked: "Session revoked. Sign in again; prior access does not grant current authority.",
  workspace_conflict: "Workspace switch conflict. Check the session; no workspace change is assumed.",
  cancelled: "Request cancelled. A server change may have completed; check the session to reconcile.",
  signed_out: "Signed out. Sign in through the identity provider when integration is available.",
  redirecting: "Sign-in redirect requested. No authenticated session is assumed.",
  active: "Active product session. Every operation is re-authorized by the server.",
  expiring: "Session expires soon. Check the session or sign in again.",
};
