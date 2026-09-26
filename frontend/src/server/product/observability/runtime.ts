import "server-only";
import { ObservabilityService } from "./service";

declare global { var __qgProductObservabilityService: ObservabilityService | undefined; }

export function observabilityService(): ObservabilityService {
  if (!globalThis.__qgProductObservabilityService) globalThis.__qgProductObservabilityService = new ObservabilityService();
  return globalThis.__qgProductObservabilityService;
}
