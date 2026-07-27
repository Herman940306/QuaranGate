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
