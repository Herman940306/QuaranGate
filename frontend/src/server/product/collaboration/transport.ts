import "server-only";
import type { SafeProductEvent } from "./types";

export type RealtimeTransportStatus = "unavailable" | "available";

export interface RealtimeDeliveryContext {
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  resumeCursor?: string;
}

export interface RealtimeTransport {
  status(): Promise<RealtimeTransportStatus>;
  deliver(context: RealtimeDeliveryContext, events: readonly SafeProductEvent[]): Promise<void>;
}

export class UnavailableRealtimeTransport implements RealtimeTransport {
  async status(): Promise<RealtimeTransportStatus> { return "unavailable"; }
  async deliver(_context:RealtimeDeliveryContext,_events:readonly SafeProductEvent[]):Promise<void>{
    throw new Error("realtime_transport_unavailable");
  }
}
