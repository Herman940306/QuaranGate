import type { Appearance } from "../appearance";
/** Future per-user sync seam. Current UI uses only the F1 memory adapter. */
export interface PreferenceView { appearance: Appearance; version: string }
export type PreferenceReply = { kind: "available"; value: PreferenceView } | { kind: "integration_pending" | "unavailable" | "forbidden" | "stale" | "cancelled" };
export interface PreferenceSyncClient {
  read(expectedSessionVersion: string, signal: AbortSignal): Promise<PreferenceReply>;
  write(appearance: Appearance, expectedPreferenceVersion: string, expectedSessionVersion: string, signal: AbortSignal): Promise<PreferenceReply>;
}
/** No persistence backend, endpoint or successful sync is simulated. */
export function createPendingPreferenceSync(): PreferenceSyncClient {
  const pending = async (signal: AbortSignal): Promise<PreferenceReply> => ({ kind: signal.aborted ? "cancelled" : "integration_pending" });
  return { read: (_sessionVersion, signal) => pending(signal), write: (_appearance, _preferenceVersion, _sessionVersion, signal) => pending(signal) };
}
