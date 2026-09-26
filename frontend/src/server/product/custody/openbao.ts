import "server-only";
import type { CustodyAvailability, SecretCustody } from "./types";

export interface OpenBaoConfig {
  endpoint: URL;
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

export function loadOpenBaoConfig(): OpenBaoConfig {
  const raw = process.env.QG_PRODUCT_OPENBAO_URL?.trim();
  if (!raw) throw new Error("openbao_not_configured");
  const endpoint = new URL(raw);
  const production = process.env.NODE_ENV === "production";
  if (production && endpoint.protocol !== "https:") throw new Error("openbao_endpoint_invalid");
  if (!production && endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname))) {
    throw new Error("openbao_endpoint_invalid");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("openbao_endpoint_invalid");
  return { endpoint, requestTimeoutMs: 5_000, maxResponseBytes: 64 * 1024 };
}

/**
 * Typed production boundary only. No accepted OpenBao auth/mount API exists yet.
 * All operations fail closed until a separately reviewed live adapter is supplied.
 */
export class UnwiredOpenBaoCustody implements SecretCustody {
  async availability(): Promise<CustodyAvailability> {
    try { loadOpenBaoConfig(); } catch { return "unavailable"; }
    return "unavailable";
  }
  async store(_reference: string, _secret: string): Promise<void> { throw new Error("openbao_adapter_unavailable"); }
  async resolve<T>(_reference: string, _use: (secret: string) => Promise<T>): Promise<T> { throw new Error("openbao_adapter_unavailable"); }
  async delete(_reference: string): Promise<void> { throw new Error("openbao_adapter_unavailable"); }
}
