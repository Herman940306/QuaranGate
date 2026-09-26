import { describe, expect, it, vi } from "vitest";
import { createOperationalClient } from "../../src/lib/operational/client";
import type { Transport } from "../../src/lib/operational/transport";

function transport(data: unknown, onCall?: (args: Record<string, unknown>) => void): Transport {
  return async (_url, init) => {
    const request = JSON.parse(String(init.body));
    expect(request.params.name).toBe("control_center_query");
    onCall?.(request.params.arguments);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { structuredContent: { view: "statistics", generatedAt: "2026-09-26T10:00:00Z", data } },
    }), { headers: { "content-type": "application/json" } });
  };
}

const snapshot = {
  activity: {
    retained: 17, windowMs: 3_600_000, total: 12, allowed: 10, denied: 2, failures: 1,
    p50Ms: 20, p95Ms: 90, topTools: [{ tool: "control_center_query", count: 7 }, { tool: "targets_list", count: 5 }],
  },
  jobs: { active: 1, queued: null },
  targets: { visible: 3, running: 2 },
  backends: { visible: 2, available: 1 },
};

describe("FE11 operational statistics client", () => {
  it("requests only the bounded statistics view and selected sinceMs", async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await createOperationalClient(transport(snapshot, args => calls.push(args))).statistics(3_600_000);
    expect(calls).toEqual([{ view: "statistics", sinceMs: 3_600_000 }]);
    expect(result.data.activity.total).toBe(12);
    expect(result.data.jobs.queued).toBeNull();
  });

  it("projects the bounded aggregate shape and drops unknown fields", async () => {
    const result = await createOperationalClient(transport({ ...snapshot, secret: "hidden", activity: { ...snapshot.activity, rawRows: ["private"] } })).statistics(3_600_000);
    expect(result.data.activity.topTools).toEqual([{ tool: "control_center_query", count: 7 }, { tool: "targets_list", count: 5 }]);
    expect(JSON.stringify(result.data)).not.toContain("hidden");
    expect(JSON.stringify(result.data)).not.toContain("private");
  });

  it("rejects impossible aggregate invariants", async () => {
    const invalid = { ...snapshot, activity: { ...snapshot.activity, total: 5, allowed: 5, denied: 5 } };
    await expect(createOperationalClient(transport(invalid)).statistics(3_600_000)).rejects.toThrow();
  });

  it("rejects out-of-contract windows before transport", () => {
    const call = vi.fn();
    const client = createOperationalClient(call);
    expect(() => client.statistics(7 * 24 * 60 * 60 * 1000)).toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});
