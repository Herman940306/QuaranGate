import { failureKinds, type ContextReference, type IdentityAdapter, type IdentityClient, type IdentityState, type PrincipalStatus, type SessionView } from "./contracts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid identity view");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("Invalid identity field");
  return value;
}
function list<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid identity list");
  return value.map(parse);
}
function reference(value: unknown): ContextReference { const v = record(value); return { id: text(v.id), name: text(v.name) }; }
function timestamp(value: unknown): string {
  const v = text(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error("Invalid session time");
  return v;
}
/** Whitelist projection at runtime: extra token/claim/cookie fields cannot reach state or UI. */
export function projectIdentity(input: unknown, now = Date.now()): IdentityState {
  const v = record(input);
  if (v.kind === "signed_out" || v.kind === "redirecting" || failureKinds.includes(v.kind as typeof failureKinds[number])) return { kind: v.kind as Exclude<IdentityState["kind"], "active" | "expiring"> };
  if (v.kind !== "active" && v.kind !== "expiring") throw new Error("Invalid session state");
  const s = record(v.session); const user = record(s.user); const principal = record(s.principal);
  if (!["mapped", "unmapped", "unavailable", "forbidden"].includes(String(principal.status))) throw new Error("Invalid principal status");
  const session: SessionView = {
    user: { id: text(user.id), displayName: text(user.displayName) },
    organization: reference(s.organization), workspace: reference(s.workspace), workspaces: list(s.workspaces, reference),
    roles: list(s.roles, text), overrides: list(s.overrides, text), capabilitySummary: list(s.capabilitySummary, text),
    principal: { status: principal.status as PrincipalStatus, ...(principal.status === "mapped" ? { reference: text(principal.reference) } : {}) },
    version: text(s.version), issuedAt: timestamp(s.issuedAt), expiresAt: timestamp(s.expiresAt),
    ...(s.federationLabel === undefined ? {} : { federationLabel: text(s.federationLabel) }),
  };
  if (new Set(session.workspaces.map(w => w.id)).size !== session.workspaces.length || !session.workspaces.some(w => w.id === session.workspace.id && w.name === session.workspace.name) || Date.parse(session.issuedAt) > now || Date.parse(session.issuedAt) >= Date.parse(session.expiresAt)) throw new Error("Invalid session context");
  if (Date.parse(session.expiresAt) <= now) return { kind: "expired" };
  return { kind: Date.parse(session.expiresAt) - now <= 300_000 ? "expiring" : "active", session };
}
export function createIdentityClient(adapter?: IdentityAdapter, now: () => number = Date.now): IdentityClient {
  async function invoke(signal: AbortSignal, operation: (adapter: IdentityAdapter) => Promise<unknown>): Promise<IdentityState> {
    if (signal.aborted) return { kind: "cancelled" };
    if (!adapter) return { kind: "unavailable" };
    try { const result = await operation(adapter); return signal.aborted ? { kind: "cancelled" } : projectIdentity(result, now()); }
    catch { return { kind: signal.aborted ? "cancelled" : "unavailable" }; }
  }
  return {
    integrated: Boolean(adapter),
    getCurrentSession: signal => invoke(signal, selected => selected.getCurrentSession(signal)),
    beginLogin: signal => invoke(signal, async selected => {
      const result = record(await selected.beginLogin(signal));
      // Redirect intent cannot fabricate an authenticated view.
      return result.kind === "redirecting" || failureKinds.includes(result.kind as typeof failureKinds[number]) ? { kind: result.kind } : { kind: "unknown" };
    }),
    switchWorkspace: (id, version, signal) => invoke(signal, selected => selected.switchWorkspace(text(id), text(version), signal)),
    logout: signal => invoke(signal, async selected => { const result = record(await selected.logout(signal)); return result.kind === "signed_out" || failureKinds.includes(result.kind as typeof failureKinds[number]) ? { kind: result.kind } : { kind: "unknown" }; }),
  };
}
