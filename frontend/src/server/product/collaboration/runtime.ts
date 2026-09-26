import "server-only";
import { CollaborationService } from "./service";
declare global { var __qgCollaborationService: CollaborationService | undefined; }
export function collaborationService(): CollaborationService {
  if (!globalThis.__qgCollaborationService) globalThis.__qgCollaborationService = new CollaborationService();
  return globalThis.__qgCollaborationService;
}
