import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { QueryExecutor, QueryResultLike } from "../../src/server/product/data/db";
import { ProductDataError } from "../../src/server/product/data/errors";
import { bucketWindow, parseWindow, percentileSummary, topN } from "../../src/server/product/observability/aggregation";
import { loadTempoConfig, loadZabbixConfig, UnavailableHardwareTelemetryAdapter, UnavailableTraceSummaryAdapter } from "../../src/server/product/observability/adapters";
import { ObservabilityRepository } from "../../src/server/product/observability/repository";
import { ObservabilityService } from "../../src/server/product/observability/service";

class ScriptedDb implements QueryExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly responses: QueryResultLike<Record<string, unknown>>[] = []) {}
  async query<T>(text: string, values?: readonly unknown[]): Promise<QueryResultLike<T>> {
    this.calls.push({ text, values });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as QueryResultLike<T>;
  }
}

const session = {
  id: "sid",
  identity: { userRef: "user-a", subject: "sub-a" },
  workspace: { id: "ws-a", organizationId: "org-a", name: "Workspace" },
  version: 1,
  issuedAt: 1,
  expiresAt: Date.now() + 60_000,
  correlationId: "corr",
  csrfToken: "csrf",
  principalMapping: { state: "unmapped" as const },
  oidcTokens: {},
};
const context = { resolveIdentity: vi.fn(), workspaceForUser: vi.fn(async (user: string, workspaceId: string) => user === "user-a" && workspaceId === "ws-a" ? session.workspace : undefined) };

describe("BE6 aggregation and adapter contracts", () => {
  it("uses deterministic nearest-rank percentiles", () => {
    expect(percentileSummary([100, 10, 50, 40]).p50).toBe(40);
    expect(percentileSummary([100, 10, 50, 40]).p95).toBe(100);
    expect(percentileSummary([])).toEqual({ count: 0, method: "nearest-rank" });
  });

  it("keeps unsupported long windows unavailable rather than stretching retained data", () => {
    const { window } = parseWindow(new Date("2026-09-26T00:00:00.000Z"), String(7 * 24 * 60 * 60 * 1000));
    expect(window.supported).toBe(false);
    expect(window.reason).toBe("OWNER_DECISION_REQUIRED_LONG_HORIZON_RETENTION");
  });

  it("bounds top-N and buckets", () => {
    expect(topN({ b: 2, a: 2, c: 1 }, 2)).toEqual([{ key: "a", count: 2 }, { key: "b", count: 2 }]);
    expect(() => topN({}, 21)).toThrow(ProductDataError);
    expect(bucketWindow(new Date("2026-09-26T00:00:00Z"), new Date("2026-09-26T01:00:00Z"), 4)).toHaveLength(4);
  });

  it("hardware and trace adapters fail closed without live contracts", async () => {
    await expect(new UnavailableHardwareTelemetryAdapter().status()).resolves.toBe("NOT_QUALIFIED");
    await expect(new UnavailableTraceSummaryAdapter().safeLatencySummary()).resolves.toMatchObject({ state: "NOT_AVAILABLE" });
  });

  it("trusted adapter config rejects insecure or credential-bearing URLs", () => {
    vi.stubEnv("QG_PRODUCT_ZABBIX_URL", "http://zabbix.example.test");
    expect(() => loadZabbixConfig()).toThrow("zabbix_endpoint_invalid");
    vi.stubEnv("QG_PRODUCT_TEMPO_URL", "https://user:pass@tempo.example.test");
    expect(() => loadTempoConfig()).toThrow("tempo_endpoint_invalid");
    vi.unstubAllEnvs();
  });
});

describe("BE6 product event read model", () => {
  it("event counts are user/org/workspace/window scoped and bounded", async () => {
    const db = new ScriptedDb([{ rows: [{ event_type: "approval.requested", count: "2" }], rowCount: 1 }]);
    const counts = await new ObservabilityRepository(db).eventCounts("user-a", "org-a", "ws-a", new Date("2026-09-26T00:00:00Z"), new Date("2026-09-26T01:00:00Z"));
    expect(counts).toEqual({ "approval.requested": 2 });
    expect(db.calls[0]?.values).toEqual(["user-a", "org-a", "ws-a", "2026-09-26T00:00:00.000Z", "2026-09-26T01:00:00.000Z"]);
    expect(db.calls[0]?.text).toContain("m.product_user_id = $1");
    expect(db.calls[0]?.text).toContain("LIMIT 100");
  });

  it("statistics expose unavailable token/cost/savings instead of estimates", async () => {
    const db = new ScriptedDb([{ rows: [{ event_type: "approval.requested", count: 1 }], rowCount: 1 }]);
    const service = new ObservabilityService(new ObservabilityRepository(db), context as never);
    const stats = await service.statistics(session as never, "3600000", 5);
    expect(stats.eventCounts.total).toBe(1);
    expect(stats.tokenUsage.state).toBe("NOT_AVAILABLE");
    expect(stats.cost.unavailableReason).toBe("AUTHORITATIVE_USAGE_AND_RATE_UNAVAILABLE");
    expect(stats.estimatedSavings.unavailableReason).toBe("OWNER_DECISION_REQUIRED");
    expect(JSON.stringify(stats)).not.toMatch(/secret|tokenValue|Authorization|cookie/i);
  });

  it("keeps a successful empty provider-health result as a qualified legitimate zero", async () => {
    const repo = {
      eventCounts: vi.fn(async () => ({})),
      providerHealth: vi.fn(async () => ({})),
    } as unknown as ObservabilityRepository;
    const service = new ObservabilityService(repo, context as never);
    const summary = await service.summary(session as never, "3600000");
    const providerMetric = summary.metrics.find((metric) => metric.id === "provider_configurations");
    expect(providerMetric).toMatchObject({
      state: "UNKNOWN",
      value: 0,
      sampleCount: 0,
      provenance: { qualified: true },
    });
    expect(providerMetric).not.toHaveProperty("unavailableReason");
  });

  it("keeps provider-health read failure unavailable instead of coercing missing telemetry to zero", async () => {
    const repo = {
      eventCounts: vi.fn(async () => ({})),
      providerHealth: vi.fn(async () => { throw new Error("raw database failure with secret-token"); }),
    } as unknown as ObservabilityRepository;
    const service = new ObservabilityService(repo, context as never);
    const summary = await service.summary(session as never, "3600000");
    const providerMetric = summary.metrics.find((metric) => metric.id === "provider_configurations");
    expect(providerMetric).toMatchObject({
      state: "NOT_AVAILABLE",
      sampleCount: 0,
      provenance: { qualified: false },
      unavailableReason: "PROVIDER_CONFIGURATION_HEALTH_UNAVAILABLE",
    });
    expect(providerMetric).not.toHaveProperty("value");
    expect(JSON.stringify(providerMetric)).not.toContain("raw database failure");
    expect(JSON.stringify(providerMetric)).not.toContain("secret-token");
  });

  it("cross-workspace session reads fail closed", async () => {
    const service = new ObservabilityService(new ObservabilityRepository(new ScriptedDb()), { resolveIdentity: vi.fn(), workspaceForUser: vi.fn(async () => undefined) } as never);
    await expect(service.statistics(session as never, "3600000", 5)).rejects.toMatchObject({ code: "PRODUCT_DATA_FORBIDDEN" });
  });

  it("completed is not represented as applied and concurrency remains deferred", async () => {
    const db = new ScriptedDb([{ rows: [{ event_type: "approval.decided", count: 1 }], rowCount: 1 }]);
    const service = new ObservabilityService(new ObservabilityRepository(db), context as never);
    const jobs = await service.jobs(session as never, "3600000");
    expect(jobs.completedIsApplied).toBe(false);
    expect(jobs.deferredConcurrency.state).toBe("DEFERRED");
  });
});
