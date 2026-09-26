import "server-only";
import type { ProductSession } from "../identity/types";
import { discoverSecurityStack } from "./discovery";
import { createSecurityAssessmentPlan } from "./planner";
import type { SecurityAssessmentPlan, SecurityDiscoveryInput, SecurityDiscoveryResult } from "./types";

function assertWorkspace(session: ProductSession, projectId: string): void {
  if (!session.workspace) throw new Error("security_workspace_required");
  if (projectId.includes("/") || projectId.includes("..")) throw new Error("security_project_invalid");
}

export class SecurityAssessmentService {
  discover(session: ProductSession, input: SecurityDiscoveryInput): SecurityDiscoveryResult {
    assertWorkspace(session, input.projectId);
    return discoverSecurityStack(input);
  }

  createPlan(session: ProductSession, discovery: SecurityDiscoveryResult): SecurityAssessmentPlan {
    assertWorkspace(session, discovery.projectId);
    return createSecurityAssessmentPlan(discovery);
  }
}
