import "server-only";
import { ProductDataError } from "../data/errors";
import type { PercentileSummary, TimeWindow } from "./types";

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_WINDOW_MS = 60 * 1000;
const MAX_BUCKETS = 96;
const MAX_TOP_N = 20;

export function parseWindow(now = new Date(), rawWindowMs?: string | null): { start: Date; end: Date; window: TimeWindow } {
  const end = now;
  const requestedMs = rawWindowMs === undefined || rawWindowMs === null ? 60 * 60 * 1000 : Number(rawWindowMs);
  if (!Number.isInteger(requestedMs) || requestedMs < MIN_WINDOW_MS) throw new ProductDataError("PRODUCT_DATA_INVALID", "observability_window_invalid");
  if (requestedMs > MAX_WINDOW_MS) {
    const requestedStart = new Date(end.getTime() - requestedMs).toISOString();
    return {
      start: new Date(end.getTime() - MAX_WINDOW_MS),
      end,
      window: {
        requestedStart,
        requestedEnd: end.toISOString(),
        availableStart: new Date(end.getTime() - MAX_WINDOW_MS).toISOString(),
        availableEnd: end.toISOString(),
        supported: false,
        reason: "OWNER_DECISION_REQUIRED_LONG_HORIZON_RETENTION",
      },
    };
  }
  const start = new Date(end.getTime() - requestedMs);
  return { start, end, window: { requestedStart: start.toISOString(), requestedEnd: end.toISOString(), availableStart: start.toISOString(), availableEnd: end.toISOString(), supported: true } };
}

export function percentileSummary(values: readonly number[]): PercentileSummary {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return { count: 0, method: "nearest-rank" };
  const rank = (p: number): number => {
    const index = Math.max(0, Math.ceil((p / 100) * clean.length) - 1);
    const value = clean[index];
    if (value === undefined) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "percentile_unavailable");
    return value;
  };
  const min = clean[0];
  const max = clean.at(-1);
  if (min === undefined || max === undefined) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "percentile_unavailable");
  return { count: clean.length, min, max, p50: rank(50), p95: rank(95), method: "nearest-rank" };
}

export function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function topN(counts: Record<string, number>, n: number): Array<{ key: string; count: number }> {
  if (!Number.isInteger(n) || n < 1 || n > MAX_TOP_N) throw new ProductDataError("PRODUCT_DATA_INVALID", "top_n_invalid");
  return Object.entries(counts).sort(([aKey, a], [bKey, b]) => b - a || aKey.localeCompare(bKey)).slice(0, n).map(([key, count]) => ({ key, count }));
}

export function bucketWindow(start: Date, end: Date, bucketCount: number): Array<{ start: string; end: string }> {
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > MAX_BUCKETS) throw new ProductDataError("PRODUCT_DATA_INVALID", "bucket_count_invalid");
  const width = Math.max(1, Math.floor((end.getTime() - start.getTime()) / bucketCount));
  return Array.from({ length: bucketCount }, (_, index) => {
    const s = new Date(start.getTime() + width * index);
    const e = index === bucketCount - 1 ? end : new Date(start.getTime() + width * (index + 1));
    return { start: s.toISOString(), end: e.toISOString() };
  });
}
