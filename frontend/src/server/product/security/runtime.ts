import "server-only";
import { SecurityAssessmentService } from "./service";

declare global { var __qgProductSecurityAssessmentService: SecurityAssessmentService | undefined; }

export function securityAssessmentService(): SecurityAssessmentService {
  if (!globalThis.__qgProductSecurityAssessmentService) globalThis.__qgProductSecurityAssessmentService = new SecurityAssessmentService();
  return globalThis.__qgProductSecurityAssessmentService;
}
