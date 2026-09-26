import { describe, expect, it, vi } from "vitest";
import { createIdentityClient, projectIdentity } from "../../src/lib/identity/client";
import { IdentityStore } from "../../src/lib/identity/store";
import type { IdentityAdapter } from "../../src/lib/identity/contracts";
const now = Date.parse("2026-09-26T08:00:00Z");
function session(workspace = "ws-a", version = "v1") {
  return { kind: "active", session: { user: { id: "synthetic-user", displayName: "Synthetic Operator" }, organization: { id: "org-demo", name: "Synthetic Organization" }, workspace: { id: workspace, name: workspace }, workspaces: ["ws-a", "ws-b"].map(id => ({ id, name: id })), roles: ["Reviewer"], overrides: ["Workflow review only"], principal: { status: "mapped", reference: "principal-demo" }, capabilitySummary: ["Review eligibility"], version, issuedAt: "2026-09-26T07:00:00Z", expiresAt: "2026-09-26T09:00:00Z", federationLabel: "Synthetic Keycloak" } };
}
function adapter(read: () => Promise<unknown> = async () => session()): IdentityAdapter {
  return { getCurrentSession: read, beginLogin: async () => ({ kind: "redirecting" }), logout: async () => ({ kind: "signed_out" }), switchWorkspace: async (id, version) => session(id, `${version}-next`) };
}
function deferred() { let resolve!: (v: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return { promise, resolve }; }
function store(a = adapter(), clock = () => now, timeout = 1000) { return new IdentityStore(createIdentityClient(a, clock), clock, timeout); }

describe("FE2 boundary", () => {
  it("defaults unavailable without a live identity adapter", async () => { const s = new IdentityStore(createIdentityClient()); await s.refresh(); expect(s.getSnapshot().state.kind).toBe("unavailable"); expect(s.client.integrated).toBe(false); });
  it.each(["signed_out", "unavailable", "forbidden", "stale", "expired", "revoked", "workspace_conflict"])("handles %s with no retained session", async kind => { const s = store(adapter(async () => ({ kind, accessToken: "synthetic-extra" }))); await s.refresh(); expect(s.getSnapshot().state).toEqual({ kind }); });
  it("projects authenticated synthetic session without token, claims, email or cookie fields", async () => {
    const value = session(); const unsafe = { ...value, accessToken: "synthetic-extra", session: { ...value.session, refreshToken: "synthetic-extra", idToken: "synthetic-extra", claims: { admin: true }, email: "not-approved@example.invalid", pkceVerifier: "synthetic-extra", cookie: "synthetic-extra", user: { ...value.session.user, token: "synthetic-extra" } } };
    const s = store(adapter(async () => unsafe)); await s.refresh(); const result = s.getSnapshot().state;
    expect(result).toEqual(value); expect(JSON.stringify(result)).not.toMatch(/Token|claims|email|Verifier|cookie|synthetic-extra/);
  });
  it.each(["invalid time", "future issue", "unbounded", "duplicate membership", "missing current workspace", "invalid principal"])("rejects malformed session: %s", async condition => {
    const v = session();
    if (condition === "invalid time") v.session.expiresAt = "NaN";
    if (condition === "future issue") v.session.issuedAt = "2026-09-26T08:30:00Z";
    if (condition === "unbounded") v.session.roles = Array(101).fill("role");
    if (condition === "duplicate membership") v.session.workspaces.push(v.session.workspaces[0]);
    if (condition === "missing current workspace") v.session.workspaces = [];
    if (condition === "invalid principal") v.session.principal.status = "admin";
    const s = store(adapter(async () => v)); await s.refresh(); expect(s.getSnapshot().state.kind).toBe("unavailable");
  });
  it("maps raw provider exceptions to safe unavailable without message", async () => { const s = store(adapter(async () => { throw new Error("synthetic raw provider details"); })); await s.refresh(); expect(s.getSnapshot().state).toEqual({ kind: "unavailable" }); });
  it("expires by local time, removes context and invalidates projections", async () => { let time = now; const s = store(adapter(), () => time); await s.refresh(); const epoch = s.getSnapshot().projectionEpoch; time += 3_400_000; s.tick(); expect(s.getSnapshot().state.kind).toBe("expiring"); time += 200_000; s.tick(); expect(s.getSnapshot().state).toEqual({ kind: "expired" }); expect(s.getSnapshot().projectionEpoch).toBeGreaterThan(epoch); });
  it("never treats login intent as authenticated or unsuccessful logout as signed out", async () => { const a = adapter(); a.beginLogin = async () => session(); a.logout = async () => session(); const s = store(a); await s.beginLogin(); expect(s.getSnapshot().state.kind).toBe("unknown"); await s.logout(); expect(s.getSnapshot().state.kind).toBe("unknown"); });
  it("suppresses out-of-order responses even if adapter ignores abort", async () => { const first = deferred(); const second = deferred(); const a = adapter(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)); const s = store(a); const p1 = s.refresh(); const p2 = s.refresh(); second.resolve({ kind: "signed_out" }); await p2; first.resolve(session()); await p1; expect(s.getSnapshot().state).toEqual({ kind: "signed_out" }); });
  it("cancellation suppresses late response and sends abort", async () => { const d = deferred(); let signal: AbortSignal | undefined; const a = adapter(); a.getCurrentSession = next => { signal = next; return d.promise; }; const s = store(a); const p = s.refresh(); s.cancel(); expect(signal?.aborted).toBe(true); d.resolve(session()); await p; expect(s.getSnapshot().state).toEqual({ kind: "cancelled" }); });
  it("pre-aborted client call never invokes adapter", async () => { const a = adapter(); const spy = vi.spyOn(a, "getCurrentSession"); const controller = new AbortController(); controller.abort(); expect(await createIdentityClient(a).getCurrentSession(controller.signal)).toEqual({ kind: "cancelled" }); expect(spy).not.toHaveBeenCalled(); });
  it("disposal prevents late publishing", async () => { const d = deferred(); const s = store(adapter(() => d.promise)); const p = s.refresh(); s.dispose(); const snapshot = s.getSnapshot(); d.resolve(session()); await p; expect(s.getSnapshot()).toBe(snapshot); });
  it("timeout bounds hanging adapter", async () => { const s = store(adapter(() => new Promise(() => {})), () => now, 5); await s.refresh(); expect(s.getSnapshot().state).toEqual({ kind: "unavailable" }); expect(s.getSnapshot().pending).toBeNull(); });
  it("passes exact opaque expected version, clears context during switch", async () => { const d = deferred(); const a = adapter(); a.switchWorkspace = vi.fn(() => d.promise); const s = store(a); await s.refresh(); const epoch = s.getSnapshot().projectionEpoch; const p = s.switchWorkspace("ws-b", "v1"); expect(s.getSnapshot().state).toEqual({ kind: "unknown" }); expect(s.getSnapshot().projectionEpoch).toBeGreaterThan(epoch); expect(a.switchWorkspace).toHaveBeenCalledWith("ws-b", "v1", expect.any(AbortSignal)); d.resolve(session("ws-b", "v2")); await p; expect(s.getSnapshot().state).toEqual(session("ws-b", "v2")); });
  it.each(["wrong version", "not a member"])("fails closed before write: %s", async condition => { const a = adapter(); const spy = vi.spyOn(a, "switchWorkspace"); const s = store(a); await s.refresh(); await s.switchWorkspace(condition === "not a member" ? "ws-hidden" : "ws-b", condition === "wrong version" ? "old" : "v1"); expect(s.getSnapshot().state.kind).toBe(condition === "wrong version" ? "stale" : "forbidden"); expect(spy).not.toHaveBeenCalled(); });
  it.each([session("ws-a", "v2"), session("ws-b", "v1"), { kind: "stale" }, { kind: "forbidden" }])("does not optimistically switch or last-write-win", async result => { const a = adapter(); a.switchWorkspace = async () => result; const s = store(a); await s.refresh(); await s.switchWorkspace("ws-b", "v1"); expect(s.getSnapshot().state.kind).toBe(result.kind === "active" ? "workspace_conflict" : result.kind); });
  it("blocks duplicate writes and refresh during pending mutation; cancels then reconciles", async () => { const d = deferred(); const a = adapter(); a.switchWorkspace = vi.fn(() => d.promise); const s = store(a); await s.refresh(); const p = s.switchWorkspace("ws-b", "v1"); await s.switchWorkspace("ws-b", "v1"); await s.refresh(); await s.logout(); expect(a.switchWorkspace).toHaveBeenCalledTimes(1); expect(s.getSnapshot().pending).toBe("workspace"); s.cancel(); await s.refresh(); d.resolve(session("ws-b", "v2")); await p; expect(s.getSnapshot().state).toEqual(session()); });
  it.each(["unmapped", "unavailable", "forbidden"])("accepts explicit principal %s without a reference", status => { const v = session(); v.session.principal.status = status; expect(projectIdentity(v, now)).toMatchObject({ session: { principal: { status } } }); expect(JSON.stringify(projectIdentity(v, now))).not.toContain("principal-demo"); });
});

it("hydration always uses immutable initial server snapshot even after client refresh", async () => { const s = store(); const initial = s.getServerSnapshot(); await s.refresh(); expect(s.getServerSnapshot()).toBe(initial); expect(s.getServerSnapshot().state.kind).toBe("unknown"); expect(s.getSnapshot().state.kind).toBe("active"); });
