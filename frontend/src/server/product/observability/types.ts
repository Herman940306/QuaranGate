import "server-only";

export type TruthState = "READY" | "DEGRADED" | "UNKNOWN" | "NOT_AVAILABLE" | "NOT_IMPLEMENTED" | "NOT_QUALIFIED" | "DEFERRED";
export type MetricSource = "product_events" | "control_center" | "acp" | "provider_config" | "zabbix" | "tempo" | "external";
export type MetricUnit = "count" | "ratio" | "milliseconds" | "percent" | "bytes" | "celsius" | "state" | "none";

export interface ObservabilityScope {
  organizationId: string;
  workspaceId: string;
  projectId?: string;
}

export interface TimeWindow {
  requestedStart: string;
  requestedEnd: string;
  availableStart?: string;
  availableEnd?: string;
  supported: boolean;
  reason?: string;
}

export interface MetricProvenance {
  source: MetricSource;
  sourceDetail: string;
  qualified: boolean;
  retention?: string;
}

export interface SafeMetric<T = number | string | boolean> {
  id: string;
  label: string;
  scope: ObservabilityScope;
  observedAt: string;
  window: TimeWindow;
  freshness: TruthState;
  state: TruthState;
  unit: MetricUnit;
  value?: T;
  sampleCount: number;
  provenance: MetricProvenance;
  unavailableReason?: string;
}

export interface PercentileSummary {
  count: number;
  min?: number;
  max?: number;
  p50?: number;
  p95?: number;
  method: "nearest-rank";
}

export interface CountSummary {
  total: number;
  byState: Record<string, number>;
  sampleCount: number;
}

export interface MonitoringSummaryDto {
  scope: ObservabilityScope;
  observedAt: string;
  state: TruthState;
  tabs: {
    hardware: TruthState;
    jobs: TruthState;
    network: TruthState;
    security: TruthState;
  };
  metrics: SafeMetric[];
}

export interface HardwareDto {
  state: TruthState;
  metrics: SafeMetric[];
}

export interface JobFlowDto {
  state: TruthState;
  counts: SafeMetric<number>[];
  completedIsApplied: false;
  deferredConcurrency: SafeMetric<string>;
}

export interface NetworkDto {
  state: TruthState;
  metrics: SafeMetric[];
}

export interface SecurityDto {
  state: TruthState;
  metrics: SafeMetric[];
}

export interface StatisticsDto {
  scope: ObservabilityScope;
  observedAt: string;
  window: TimeWindow;
  eventCounts: CountSummary;
  topEventTypes: Array<{ key: string; count: number }>;
  latency: PercentileSummary & { state: TruthState; reason?: string };
  tokenUsage: SafeMetric<string>;
  cost: SafeMetric<string>;
  estimatedSavings: SafeMetric<string>;
}
