import "server-only";
import type { ProductSession } from "../identity/types";
import type { ProductContextAdapter } from "../adapters/workspace";
import { PostgresProductContextAdapter } from "../adapters/postgres-context";
import { productDataRepository, productPool } from "../data/runtime";
import { ProductDataError } from "../data/errors";
import { parseWindow, percentileSummary, topN } from "./aggregation";
import { ObservabilityRepository } from "./repository";
import type { HardwareTelemetryAdapter, OperationalReadModelAdapter, TraceSummaryAdapter } from "./adapters";
import { UnavailableHardwareTelemetryAdapter, UnavailableOperationalReadModelAdapter, UnavailableTraceSummaryAdapter } from "./adapters";
import type { HardwareDto, JobFlowDto, MonitoringSummaryDto, NetworkDto, ObservabilityScope, SafeMetric, SecurityDto, StatisticsDto, TimeWindow } from "./types";

function metric<T extends number | string | boolean>(input: Omit<SafeMetric<T>, "observedAt"> & { observedAt?: string }): SafeMetric<T> {
  return { observedAt: input.observedAt ?? new Date().toISOString(), ...input };
}

function unavailable(scope: ObservabilityScope, id: string, label: string, sourceDetail: string, reason: string, window: TimeWindow): SafeMetric<string> {
  return metric({ id, label, scope, window, freshness: "NOT_AVAILABLE", state: "NOT_AVAILABLE", unit: "state", value: "NOT_AVAILABLE", sampleCount: 0, provenance: { source: "external", sourceDetail, qualified: false }, unavailableReason: reason });
}

export class ObservabilityService {
  constructor(
    private readonly repo: ObservabilityRepository = new ObservabilityRepository(productPool()),
    private readonly context: ProductContextAdapter = new PostgresProductContextAdapter(productDataRepository()),
    private readonly hardwareAdapter: HardwareTelemetryAdapter = new UnavailableHardwareTelemetryAdapter(),
    private readonly traceAdapter: TraceSummaryAdapter = new UnavailableTraceSummaryAdapter(),
    private readonly operationalAdapter: OperationalReadModelAdapter = new UnavailableOperationalReadModelAdapter(),
  ) {}

  private async scope(session: ProductSession): Promise<ObservabilityScope> {
    if (!session.workspace) throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "observability_workspace_required");
    const workspace = await this.context.workspaceForUser(session.identity.userRef, session.workspace.id);
    if (!workspace || workspace.organizationId !== session.workspace.organizationId) throw new ProductDataError("PRODUCT_DATA_FORBIDDEN", "observability_forbidden");
    return { organizationId: workspace.organizationId, workspaceId: workspace.id };
  }

  async statistics(session: ProductSession, rawWindowMs?: string | null, top = 10): Promise<StatisticsDto> {
    const scope = await this.scope(session);
    const { start, end, window } = parseWindow(new Date(), rawWindowMs);
    const counts = window.supported ? await this.repo.eventCounts(session.identity.userRef, scope.organizationId, scope.workspaceId, start, end) : {};
    const trace = await this.traceAdapter.safeLatencySummary();
    return {
      scope,
      observedAt: new Date().toISOString(),
      window,
      eventCounts: { total: Object.values(counts).reduce((sum, value) => sum + value, 0), byState: counts, sampleCount: Object.values(counts).reduce((sum, value) => sum + value, 0) },
      topEventTypes: topN(counts, Math.max(1, Math.min(20, Math.trunc(top)))),
      latency: { ...percentileSummary([]), state: trace.state, reason: trace.reason },
      tokenUsage: unavailable(scope, "token_usage", "Token usage", "provider_usage", "AUTHORITATIVE_USAGE_UNAVAILABLE", window),
      cost: unavailable(scope, "cost", "Cost", "billing", "AUTHORITATIVE_USAGE_AND_RATE_UNAVAILABLE", window),
      estimatedSavings: unavailable(scope, "estimated_savings", "Estimated savings", "owner_formula", "OWNER_DECISION_REQUIRED", window),
    };
  }

  async summary(session: ProductSession, rawWindowMs?: string | null): Promise<MonitoringSummaryDto> {
    const scope = await this.scope(session);
    const { window } = parseWindow(new Date(), rawWindowMs);
    const stats = await this.statistics(session, rawWindowMs, 5);
    let providerMetric: SafeMetric<number>;
    try {
      const providerHealth = await this.repo.providerHealth(session.identity.userRef, scope.organizationId, scope.workspaceId);
      const providerTotal = Object.values(providerHealth).reduce((sum, value) => sum + value, 0);
      providerMetric = metric({ id: "provider_configurations", label: "Provider configurations", scope, window, freshness: "READY", state: providerTotal > 0 ? "READY" : "UNKNOWN", unit: "count", value: providerTotal, sampleCount: providerTotal, provenance: { source: "provider_config", sourceDetail: "product_providers.validation_status", qualified: true } });
    } catch {
      providerMetric = metric({ id: "provider_configurations", label: "Provider configurations", scope, window, freshness: "NOT_AVAILABLE", state: "NOT_AVAILABLE", unit: "count", sampleCount: 0, provenance: { source: "provider_config", sourceDetail: "product_providers.validation_status", qualified: false }, unavailableReason: "PROVIDER_CONFIGURATION_HEALTH_UNAVAILABLE" });
    }
    return { scope, observedAt: new Date().toISOString(), state: "DEGRADED", tabs: { hardware: "NOT_QUALIFIED", jobs: "DEGRADED", network: "NOT_QUALIFIED", security: "NOT_QUALIFIED" }, metrics: [providerMetric, ...stats.topEventTypes.map((entry) => metric<number>({ id: `event.${entry.key}`, label: entry.key, scope, window: stats.window, freshness: stats.window.supported ? "READY" : "NOT_AVAILABLE", state: stats.window.supported ? "READY" : "NOT_AVAILABLE", unit: "count", value: entry.count, sampleCount: stats.eventCounts.sampleCount, provenance: { source: "product_events", sourceDetail: "BE5 product_events", qualified: true } }))] };
  }

  async hardware(session: ProductSession): Promise<HardwareDto> {
    await this.scope(session);
    return this.hardwareAdapter.read();
  }

  async jobs(session: ProductSession, rawWindowMs?: string | null): Promise<JobFlowDto> {
    const scope = await this.scope(session);
    const { start, end, window } = parseWindow(new Date(), rawWindowMs);
    const counts = window.supported ? await this.repo.eventCounts(session.identity.userRef, scope.organizationId, scope.workspaceId, start, end) : {};
    const jobLike = Object.entries(counts).filter(([key]) => key.startsWith("approval.") || key.startsWith("provider.")).map(([key, value]) => metric<number>({ id: `job_flow.${key}`, label: key, scope, window, freshness: "READY", state: "READY", unit: "count", value, sampleCount: value, provenance: { source: "product_events", sourceDetail: "product event family only, not ACP job truth", qualified: true } }));
    return { state: "DEGRADED", counts: jobLike, completedIsApplied: false, deferredConcurrency: metric<string>({ id: "cross_project_concurrency", label: "Cross-project concurrency", scope, window, freshness: "DEFERRED", state: "DEFERRED", unit: "state", value: "DEFERRED", sampleCount: 0, provenance: { source: "acp", sourceDetail: "BE1A concurrency not accepted in this product lane", qualified: false }, unavailableReason: "BE1A_NOT_ACCEPTED" }) };
  }

  async network(session: ProductSession): Promise<NetworkDto> {
    await this.scope(session);
    return this.operationalAdapter.network();
  }

  async security(session: ProductSession): Promise<SecurityDto> {
    await this.scope(session);
    return this.operationalAdapter.security();
  }
}
