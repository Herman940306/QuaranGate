import "server-only";
import { productPool } from "../data/runtime";
import { PostgresSecurityAssessmentRepository } from "./assessment";
import { HttpSecurityAssessmentAdmissionAdapter } from "./bridge";
import { PostgresSecurityAssessmentEvidenceStore } from "./evidence";
import { PostgresSecurityDiscoveryStore } from "./store";
import { SecurityAssessmentService } from "./service";

declare global {
  var __qgProductSecurityAssessmentService: SecurityAssessmentService | undefined;
}

export function securityAssessmentService(): SecurityAssessmentService {
  if (!globalThis.__qgProductSecurityAssessmentService) {
    const pool = productPool();
    globalThis.__qgProductSecurityAssessmentService = new SecurityAssessmentService(
      undefined,
      undefined,
      undefined,
      new PostgresSecurityDiscoveryStore(pool),
      new PostgresSecurityAssessmentRepository(pool),
      new HttpSecurityAssessmentAdmissionAdapter(),
      new PostgresSecurityAssessmentEvidenceStore(pool),
    );
  }
  return globalThis.__qgProductSecurityAssessmentService;
}
