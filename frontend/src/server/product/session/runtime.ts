import "server-only";
import { ProductSessionService } from "./service";

declare global {
  var __qgProductSessionService: ProductSessionService | undefined;
}

export function productSessionService(): ProductSessionService {
  if (!globalThis.__qgProductSessionService) globalThis.__qgProductSessionService = new ProductSessionService();
  return globalThis.__qgProductSessionService;
}
