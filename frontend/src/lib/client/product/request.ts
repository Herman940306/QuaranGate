import type { Result } from "./contracts";
/** Memory-only request arbitration. Cancellation never claims server rollback. */
export class ProductRequest {
  private generation = 0;
  private active: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private timeoutMs = 15_000) {}
  get pending() { return this.active !== null; }
  async run<T>(call: (signal: AbortSignal) => Promise<Result<T>>, publish: (r: Result<T>) => void): Promise<void> {
    if (this.active) return;
    const controller = new AbortController(); this.active = controller; const generation = ++this.generation;
    const timeout = new Promise<Result<T>>(resolve => { this.timer = setTimeout(() => { controller.abort(); resolve({ kind: "conflict" }); }, this.timeoutMs); });
    try { const result = await Promise.race([call(controller.signal), timeout]); if (generation === this.generation) publish(result); }
    catch { if (generation === this.generation) publish({ kind: "unavailable" }); }
    finally { if (generation === this.generation) { clearTimeout(this.timer); this.active = null; } }
  }
  cancel() { ++this.generation; this.active?.abort(); this.active = null; clearTimeout(this.timer); }
}
