import type { IdentityClient, IdentityOperation, IdentityState } from "./contracts";
import { projectIdentity } from "./client";
export interface IdentitySnapshot { state: IdentityState; pending: IdentityOperation | null; projectionEpoch: number }
/** Memory-only. Any identity transition invalidates all operational projections immediately. */
export class IdentityStore {
  private readonly serverSnapshot: IdentitySnapshot = { state: { kind: "unknown" }, pending: null, projectionEpoch: 0 };
  private snapshot: IdentitySnapshot = this.serverSnapshot;
  private listeners = new Set<() => void>();
  private active: AbortController | null = null;
  private generation = 0;
  constructor(readonly client: IdentityClient, private now: () => number = Date.now, private timeoutMs = 15_000) {}
  getServerSnapshot = (): IdentitySnapshot => this.serverSnapshot;
  getSnapshot = (): IdentitySnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: IdentityState, pending: IdentityOperation | null, invalidate = false) {
    this.snapshot = { state, pending, projectionEpoch: this.snapshot.projectionEpoch + Number(invalidate) };
    for (const listener of this.listeners) listener();
  }
  private async run(operation: IdentityOperation, call: (signal: AbortSignal) => Promise<IdentityState>, check?: (state: IdentityState) => boolean) {
    // No replacement/retry of an in-flight mutation. Reconcile after cancellation.
    if (this.snapshot.pending && this.snapshot.pending !== "session") return;
    this.active?.abort();
    const controller = new AbortController(); this.active = controller;
    const generation = ++this.generation;
    this.publish({ kind: "unknown" }, operation, true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<IdentityState>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ kind: operation === "workspace" || operation === "logout" ? "workspace_conflict" : "unavailable" }); }, this.timeoutMs); });
    try {
      let result = await Promise.race([call(controller.signal), timeout]);
      if (generation !== this.generation) return;
      result = projectIdentity(result, this.now());
      if (check && (result.kind === "active" || result.kind === "expiring") && !check(result)) result = { kind: "workspace_conflict" };
      this.publish(result, null, true);
    } catch { if (generation === this.generation) this.publish({ kind: "unavailable" }, null, true); }
    finally { clearTimeout(timer); if (generation === this.generation) this.active = null; }
  }
  refresh = () => this.run("session", signal => this.client.getCurrentSession(signal));
  beginLogin = () => this.run("login", signal => this.client.beginLogin(signal));
  logout = () => this.run("logout", signal => this.client.logout(signal));
  switchWorkspace = async (id: string, expectedVersion: string) => {
    if (this.snapshot.pending) return;
    this.tick();
    const state = this.snapshot.state;
    if (!(state.kind === "active" || state.kind === "expiring")) { this.publish({ kind: "stale" }, null, true); return; }
    if (expectedVersion !== state.session.version) { this.publish({ kind: "stale" }, null, true); return; }
    if (!state.session.workspaces.some(w => w.id === id)) { this.publish({ kind: "forbidden" }, null, true); return; }
    if (id === state.session.workspace.id) return;
    await this.run("workspace", signal => this.client.switchWorkspace(id, expectedVersion, signal), next => "session" in next && next.session.workspace.id === id && next.session.version !== expectedVersion && next.session.user.id === state.session.user.id);
  };
  tick = () => {
    const state = this.snapshot.state;
    if (state.kind !== "active" && state.kind !== "expiring") return;
    const next = projectIdentity(state, this.now());
    if (next.kind !== state.kind) this.publish(next, null, next.kind === "expired");
  };
  cancel = () => { this.active?.abort(); this.active = null; ++this.generation; this.publish({ kind: "cancelled" }, null, true); };
  dispose = () => { this.active?.abort(); this.active = null; ++this.generation; };
}
