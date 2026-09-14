/** Simple per-principal fixed-window rate limiter (in-memory). */
import { BridgeError } from '../shared/errors.js';

interface Window { count: number; resetAt: number }
const windows = new Map<string, Window>();

export function checkRate(principalId: string, limitPerMin: number | undefined): void {
  if (!limitPerMin || limitPerMin <= 0) return;
  const now = Date.now();
  let w = windows.get(principalId);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + 60_000 };
    windows.set(principalId, w);
  }
  w.count++;
  if (w.count > limitPerMin) {
    throw new BridgeError('RATE_LIMITED', `rate limit ${limitPerMin}/min exceeded`, 429);
  }
}


/** Read-only U1 metadata for the current principal rate-limit window. */
export function rateState(principalId: string, limitPerMin: number | undefined): {
  enabled: boolean; limitPerMin: number | null; used: number; remaining: number | null; resetAt: string | null;
} {
  if (!limitPerMin || limitPerMin <= 0) return { enabled: false, limitPerMin: null, used: 0, remaining: null, resetAt: null };
  const now = Date.now();
  const w = windows.get(principalId);
  if (!w || now >= w.resetAt) return { enabled: true, limitPerMin, used: 0, remaining: limitPerMin, resetAt: null };
  return { enabled: true, limitPerMin, used: w.count, remaining: Math.max(0, limitPerMin - w.count), resetAt: new Date(w.resetAt).toISOString() };
}
