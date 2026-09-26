import "server-only";
import type { HardwareDto, NetworkDto, SecurityDto, TruthState } from "./types";

export interface HardwareTelemetryAdapter {
  status(): Promise<TruthState>;
  read(): Promise<HardwareDto>;
}

export class UnavailableHardwareTelemetryAdapter implements HardwareTelemetryAdapter {
  async status(): Promise<TruthState> { return "NOT_QUALIFIED"; }
  async read(): Promise<HardwareDto> { return { state: "NOT_QUALIFIED", metrics: [] }; }
}

export interface TraceSummaryAdapter {
  status(): Promise<TruthState>;
  safeLatencySummary(): Promise<{ state: TruthState; reason: string }>;
}

export class UnavailableTraceSummaryAdapter implements TraceSummaryAdapter {
  async status(): Promise<TruthState> { return "NOT_QUALIFIED"; }
  async safeLatencySummary(): Promise<{ state: TruthState; reason: string }> { return { state: "NOT_AVAILABLE", reason: "LIVE_TRACE_BACKEND_UNAVAILABLE_NOT_CLAIMED" }; }
}

export interface OperationalReadModelAdapter {
  network(): Promise<NetworkDto>;
  security(): Promise<SecurityDto>;
}

export class UnavailableOperationalReadModelAdapter implements OperationalReadModelAdapter {
  async network(): Promise<NetworkDto> { return { state: "NOT_QUALIFIED", metrics: [] }; }
  async security(): Promise<SecurityDto> { return { state: "NOT_QUALIFIED", metrics: [] }; }
}

export function loadZabbixConfig(): { endpoint?: URL; configured: boolean } {
  const raw = process.env.QG_PRODUCT_ZABBIX_URL?.trim();
  if (!raw) return { configured: false };
  const endpoint = new URL(raw);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("zabbix_endpoint_invalid");
  return { endpoint, configured: true };
}

export function loadTempoConfig(): { endpoint?: URL; configured: boolean } {
  const raw = process.env.QG_PRODUCT_TEMPO_URL?.trim();
  if (!raw) return { configured: false };
  const endpoint = new URL(raw);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("tempo_endpoint_invalid");
  return { endpoint, configured: true };
}
