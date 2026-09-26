export type OperationalState = "not_connected" | "unauthenticated" | "forbidden" | "unavailable" | "unknown" | "stale" | "not_implemented" | "available" | "cancelled";
export const stateCopy: Record<OperationalState, string> = {
  not_connected: "Not connected. Choose a read operation to check the connection.",
  unauthenticated: "Authentication is required. Product identity integration is pending.",
  forbidden: "The server denied this read. Current authority does not permit it.",
  unavailable: "The operational service is unavailable. Retry when it is reachable.",
  unknown: "The response could not be verified. Operational state is unknown.",
  stale: "This snapshot is stale. Refresh before relying on it.",
  not_implemented: "This capability is not implemented in the current contract.",
  available: "Read completed. Every operation still requires server authorization.",
  cancelled: "Read cancelled. No new result was accepted.",
};
export class OperationalError extends Error {
  constructor(public readonly state: OperationalState, public readonly correlationId?: string) {
    super(stateCopy[state]);
    this.name = "OperationalError";
  }
}
export function freshness(generatedAt: string, now = Date.now()): "available" | "stale" | "unknown" {
  const time = Date.parse(generatedAt);
  if (!Number.isFinite(time) || time > now + 5_000) return "unknown";
  return now - time > 60_000 ? "stale" : "available";
}
