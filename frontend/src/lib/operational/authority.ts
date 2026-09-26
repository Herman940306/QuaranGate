import { bool, text } from "./contracts";
import { OperationalError } from "./state";
import { record } from "./transport";
import { knownTool, type ToolName } from "./tool-catalog";
export const grantFields = ["targets", "projects", "agentBackends", "agentProfiles", "githubAccounts", "githubProjects"] as const;
export type GrantField = typeof grantFields[number];
export interface AuthoritySnapshot {
  generatedAt: string;
  principal: { id: string | null; name: string | null; scopes: string[] | null } & Record<GrantField, string[] | null>;
  preflight: { evaluated: boolean | null; allowed: boolean | null; requiredScope: string | null; reason: string | null };
}
export interface PreflightRequest { tool: ToolName; target?: string; project?: string; backend?: string; profile?: string; githubAccount?: string; githubProject?: string }
export const preflightFields = ["target", "project", "backend", "profile", "githubAccount", "githubProject"] as const;
function nullableText(value: unknown) { return value === null || value === undefined ? null : text(value, 1024); }
function grants(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new OperationalError("unknown");
  return value.map(item => text(item, 256));
}
export function authority(value: Record<string, unknown>): AuthoritySnapshot {
  if (value.view !== "authority") throw new OperationalError("unknown");
  const data = record(value.data);
  const principal = data.principal === undefined || data.principal === null ? {} : record(data.principal);
  const preflight = data.preflight === undefined || data.preflight === null ? {} : record(data.preflight);
  const evaluated = preflight.evaluated == null ? null : bool(preflight.evaluated);
  const allowed = preflight.allowed == null ? null : bool(preflight.allowed);
  if (allowed !== null && evaluated !== true) throw new OperationalError("unknown");
  return { generatedAt: text(value.generatedAt, 64), principal: {
    id: nullableText(principal.id), name: nullableText(principal.name), scopes: grants(principal.scopes),
    targets: grants(principal.targets), projects: grants(principal.projects), agentBackends: grants(principal.agentBackends),
    agentProfiles: grants(principal.agentProfiles), githubAccounts: grants(principal.githubAccounts), githubProjects: grants(principal.githubProjects),
  }, preflight: { evaluated, allowed, requiredScope: nullableText(preflight.requiredScope), reason: nullableText(preflight.reason) } };
}
export function preflightArguments(request: PreflightRequest): Record<string, unknown> {
  if (!knownTool(request.tool) || Object.keys(request).some(key => key !== "tool" && !preflightFields.includes(key as typeof preflightFields[number]))) throw new OperationalError("unknown");
  const args: Record<string, unknown> = { view: "authority", tool: request.tool };
  for (const key of preflightFields) if (request[key] !== undefined) {
    const value = text(request[key], ["backend", "profile", "githubAccount"].includes(key) ? 128 : 256);
    if (!value || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new OperationalError("unknown");
    args[key] = value;
  }
  return args;
}
