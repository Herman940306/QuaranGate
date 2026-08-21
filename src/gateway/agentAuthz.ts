/**
 * Pure Agent Control Plane authorization helpers (Phase A1).
 *
 * These functions implement the authorization matrix for the nine agent tools.
 * They are deliberately pure: they take the principal and simple job-shaped
 * records as inputs and return decisions. Every registered agent tool routes
 * through `authorizeAgentTool` before acting (see `agentTools.ts`); job facts
 * come from the trusted stored job record, never from caller input.
 *
 * Deny-by-default everywhere:
 * - a missing agent scope denies;
 * - a missing project/backend/profile grant denies;
 * - job access requires ownership (no cross-principal admin override in v1);
 * - target permission NEVER implies any agent permission;
 * - permissions are never inferred from prompt text.
 */
import { type Principal, type Scope, principalHasScope } from './config.js';

/** Minimal job facts needed for ownership/project checks (no store in A1). */
export interface AgentJobRef {
  jobId: string;
  principalId: string;
  project: string;
}

export const AGENT_TOOL_NAMES = [
  'agents_list',
  'agent_projects',
  'agent_dispatch',
  'agent_status',
  'agent_result',
  'agent_diff',
  'agent_cancel',
  'agent_apply',
  'agent_discard',
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export type AgentAuthzDenialCode =
  | 'FORBIDDEN_SCOPE'
  | 'FORBIDDEN_PROJECT'
  | 'FORBIDDEN_BACKEND'
  | 'FORBIDDEN_PROFILE'
  | 'FORBIDDEN_JOB'
  | 'MALFORMED_REQUEST';

export type AgentAuthzDecision =
  | { allowed: true }
  | { allowed: false; code: AgentAuthzDenialCode; reason: string };

const allow: AgentAuthzDecision = { allowed: true };
const deny = (code: AgentAuthzDenialCode, reason: string): AgentAuthzDecision => ({ allowed: false, code, reason });

/**
 * Grant-list check shared by project/backend/profile grants.
 * "*" means every entry of the TRUSTED CONFIGURED registry (mirroring the
 * proven `targets` wildcard), never arbitrary host resources.
 */
function grantAllows(grants: string[] | undefined, id: string): boolean {
  if (!grants || grants.length === 0) return false;
  return grants.includes('*') || grants.includes(id);
}

export function principalMayUseAgentProject(p: Principal, project: string): boolean {
  return grantAllows(p.projects, project);
}

export function principalMayUseAgentBackend(p: Principal, backend: string): boolean {
  return grantAllows(p.agentBackends, backend);
}

export function principalMayUseAgentProfile(p: Principal, profile: string): boolean {
  return grantAllows(p.agentProfiles, profile);
}

/** Ownership is exact principal identity. There is no admin override in v1. */
export function principalOwnsAgentJob(p: Principal, job: AgentJobRef): boolean {
  return job.principalId === p.id;
}

/** Scope requirement per tool (the "operation" dimension of the matrix). */
export const AGENT_TOOL_REQUIRED_SCOPE: Record<AgentToolName, Scope> = {
  agents_list: 'agents:read',
  agent_projects: 'agents:read',
  agent_dispatch: 'agents:dispatch',
  agent_status: 'agents:read',
  agent_result: 'agents:read',
  agent_diff: 'agents:read',
  agent_cancel: 'agents:cancel',
  agent_apply: 'agents:apply',
  agent_discard: 'agents:dispatch',
};

export interface AgentAuthzRequest {
  tool: AgentToolName;
  principal: Principal;
  /** Required for agent_dispatch. */
  project?: string;
  backend?: string;
  profile?: string;
  /** Required for job-addressed tools (status/result/diff/cancel/apply/discard). */
  job?: AgentJobRef;
}

const JOB_ADDRESSED: readonly AgentToolName[] = [
  'agent_status',
  'agent_result',
  'agent_diff',
  'agent_cancel',
  'agent_apply',
  'agent_discard',
];

/**
 * Full authorization matrix:
 *
 *   agents_list     agents:read
 *   agent_projects  agents:read
 *   agent_status    agents:read      + job ownership
 *   agent_result    agents:read      + job ownership
 *   agent_diff      agents:read      + job ownership + CURRENT project grant (job's project)
 *   agent_dispatch  agents:dispatch  + project grant + backend grant + profile grant
 *   agent_cancel    agents:cancel    + job ownership
 *   agent_apply     agents:apply     + job ownership + project grant (job's project)
 *   agent_discard   agents:dispatch  + job ownership
 *
 * A6-B4 refinement (approved): agent_diff additionally requires the CURRENT
 * grant for the job's project — it exposes retained canonical source-code
 * contents, so a project-grant revocation must also revoke retained review
 * access. This is DELIBERATELY not applied to agent_status / agent_result
 * (bounded metadata only), and agent_apply behavior is unchanged.
 */
export function authorizeAgentTool(req: AgentAuthzRequest): AgentAuthzDecision {
  const { tool, principal } = req;
  const scope = AGENT_TOOL_REQUIRED_SCOPE[tool];
  if (!principalHasScope(principal, scope)) {
    return deny('FORBIDDEN_SCOPE', `missing scope ${scope}`);
  }

  if (tool === 'agent_dispatch') {
    if (!req.project || !req.backend || !req.profile) {
      return deny('MALFORMED_REQUEST', 'dispatch requires project, backend and profile');
    }
    if (!principalMayUseAgentProject(principal, req.project)) {
      return deny('FORBIDDEN_PROJECT', `project ${req.project} not granted to client ${principal.id}`);
    }
    if (!principalMayUseAgentBackend(principal, req.backend)) {
      return deny('FORBIDDEN_BACKEND', `backend ${req.backend} not granted to client ${principal.id}`);
    }
    if (!principalMayUseAgentProfile(principal, req.profile)) {
      return deny('FORBIDDEN_PROFILE', `profile ${req.profile} not granted to client ${principal.id}`);
    }
    return allow;
  }

  if (JOB_ADDRESSED.includes(tool)) {
    if (!req.job) return deny('MALFORMED_REQUEST', `${tool} requires a job reference`);
    if (!principalOwnsAgentJob(principal, req.job)) {
      return deny('FORBIDDEN_JOB', `job ${req.job.jobId} is not owned by client ${principal.id}`);
    }
    // agent_apply and agent_diff both require a CURRENT grant for the job's
    // project (the project is taken from the trusted job record, never caller
    // input, so a caller can never substitute a project it happens to hold).
    if ((tool === 'agent_apply' || tool === 'agent_diff') && !principalMayUseAgentProject(principal, req.job.project)) {
      return deny('FORBIDDEN_PROJECT', `project ${req.job.project} not granted to client ${principal.id}`);
    }
    return allow;
  }

  // agents_list / agent_projects: scope alone; the tool handlers then filter
  // results down to the principal's own grants.
  return allow;
}
