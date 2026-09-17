/**
 * U1 Control Center bounded read model.
 *
 * One read-only MCP contract keeps observability on the existing authenticated
 * MCP authority plane. It exposes only metadata already safe for the current
 * principal plus bounded runtime health from the private executor. No prompts,
 * file contents, command output, credentials, Docker options or secrets are
 * returned or retained.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import { executor } from './executorClient.js';
import { audit, auditActivityStats, auditIntegrityState, newReqId, queryAuditActivity } from './audit.js';
import { currentPrincipal } from './context.js';
import { rateState } from './ratelimit.js';
import {
  principalCanGithubAccount,
  principalCanGithubProject,
  principalCanTarget,
  principalHasScope,
  type Principal,
  type Scope,
} from './config.js';
import {
  principalMayUseAgentBackend,
  principalMayUseAgentProfile,
  principalMayUseAgentProject,
} from './agentAuthz.js';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const VIEWS = [
  'summary', 'activity', 'authority', 'topology', 'egress', 'providers',
  'incidents', 'statistics', 'capabilities', 'resources', 'recovery',
] as const;
type View = typeof VIEWS[number];

const DIRECT_SCOPE: Record<string, Scope> = {
  targets_list: 'targets:read', target_inspect: 'targets:read', target_logs: 'targets:logs',
  target_start: 'targets:control', target_stop: 'targets:control', target_restart: 'targets:control',
  fs_list: 'files:read', fs_stat: 'files:read', fs_read: 'files:read', fs_search: 'files:read',
  fs_write: 'files:write', fs_patch: 'files:write', fs_delete: 'files:delete', terminal_exec: 'terminal:exec',
  git_status: 'git:read', git_diff: 'git:read', git_log: 'git:read', process_list: 'process:read',
  agents_list: 'agents:read', agent_projects: 'agents:read', agent_dispatch: 'agents:dispatch',
  agent_status: 'agents:read', agent_result: 'agents:read', agent_diff: 'agents:read',
  agent_cancel: 'agents:cancel', agent_apply: 'agents:apply', agent_discard: 'agents:dispatch',
  github_repositories: 'github:read', github_repository: 'github:read', github_branches: 'github:read',
  github_commits: 'github:read', github_pull_requests: 'github:read', github_pull_request: 'github:read',
  github_pull_request_files: 'github:read', github_issues: 'github:read', github_issue: 'github:read',
  github_issue_comments: 'github:read', github_pull_request_reviews: 'github:read',
  github_pull_request_review_comments: 'github:read', github_checks: 'github:read',
  github_push_branch: 'github:write', github_pull_request_create: 'github:write',
  github_pull_request_update: 'github:write', github_pull_request_review: 'github:review',
  control_center_query: 'targets:read',
};

function ok(data: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: { ...data } };
}

function visiblePrincipal(p: Principal) {
  return {
    id: p.id,
    name: p.name,
    scopes: [...p.scopes].sort(),
    targets: [...p.targets].sort(),
    projects: [...(p.projects ?? [])].sort(),
    agentBackends: [...(p.agentBackends ?? [])].sort(),
    agentProfiles: [...(p.agentProfiles ?? [])].sort(),
    githubAccounts: [...(p.githubAccounts ?? [])].sort(),
    githubProjects: [...(p.githubProjects ?? [])].sort(),
  };
}

function authorityEvaluation(p: Principal, args: any) {
  const tool = typeof args.tool === 'string' ? args.tool : '';
  if (!tool) return { evaluated: false, reason: 'Select a tool to run an advisory preflight.' };
  const requiredScope = DIRECT_SCOPE[tool];
  if (!requiredScope) return { evaluated: true, allowed: false, reason: 'Unknown tool in current Control Center policy map.' };
  if (!principalHasScope(p, requiredScope)) {
    return { evaluated: true, allowed: false, requiredScope, reason: `Missing scope ${requiredScope}.` };
  }
  if (args.target && !principalCanTarget(p, args.target)) {
    return { evaluated: true, allowed: false, requiredScope, reason: `Target ${args.target} is not granted to this principal.` };
  }
  if (args.project && !principalMayUseAgentProject(p, args.project)) {
    return { evaluated: true, allowed: false, requiredScope, reason: `Agent project ${args.project} is not granted to this principal.` };
  }
  if (args.backend && !principalMayUseAgentBackend(p, args.backend)) {
    return { evaluated: true, allowed: false, requiredScope, reason: `Backend ${args.backend} is not granted to this principal.` };
  }
  if (args.profile && !principalMayUseAgentProfile(p, args.profile)) {
    return { evaluated: true, allowed: false, requiredScope, reason: `Profile ${args.profile} is not granted to this principal.` };
  }
  if (args.githubAccount && !principalCanGithubAccount(p, args.githubAccount)) {
    return { evaluated: true, allowed: false, requiredScope, reason: `GitHub account ${args.githubAccount} is not granted to this principal.` };
  }
  if (args.githubProject && !principalCanGithubProject(p, args.githubProject)) {
    return { evaluated: true, allowed: false, requiredScope, reason: `GitHub project ${args.githubProject} is not granted to this principal.` };
  }
  return {
    evaluated: true,
    allowed: true,
    requiredScope,
    advisory: true,
    reason: 'Current principal grants satisfy this preflight. Runtime state and operation-specific server checks still apply.',
  };
}

async function snapshot(p: Principal) {
  const [runtime, targets, backends, projects] = await Promise.all([
    executor.controlCenterRuntime().catch(() => null),
    executor.listTargets().catch(() => []),
    executor.agentsList().catch(() => []),
    executor.agentProjects().catch(() => []),
  ]);
  return {
    runtime,
    targets: targets.filter((t) => principalCanTarget(p, t.id)).map((t) => ({
      id: t.id, name: t.name, running: t.running, source: t.source,
      image: t.image, status: t.status, health: t.health,
    })),
    backends: backends.filter((b) => principalMayUseAgentBackend(p, b.id)).map((b) => ({
      id: b.id, available: b.available,
      profiles: b.profiles.filter((profile) => principalMayUseAgentProfile(p, profile)),
    })),
    projects: projects.filter((project) => principalMayUseAgentProject(p, project.id)).map((project) => ({
      id: project.id, gitRequired: project.gitRequired,
      allowedBackends: project.allowedBackends.filter((b) => principalMayUseAgentBackend(p, b)),
      allowedProfiles: project.allowedProfiles.filter((profile) => principalMayUseAgentProfile(p, profile)),
    })),
  };
}

async function viewData(view: View, p: Principal, args: any): Promise<Record<string, unknown>> {
  const snap = await snapshot(p);
  const stats = auditActivityStats(p.id, args.sinceMs);
  if (view === 'activity') return {
    retention: { storage: 'memory', maxEntries: 2048, maxAgeMs: 86_400_000 },
    stdoutIntegrity: auditIntegrityState(),
    rows: queryAuditActivity({ principal: p.id, limit: args.limit, sinceMs: args.sinceMs }),
    stats,
  };
  if (view === 'authority') return { principal: visiblePrincipal(p), preflight: authorityEvaluation(p, args) };
  if (view === 'topology') return {
    buildRevision: process.env.QUARANGATE_BUILD_REVISION ?? 'unknown',
    components: [
      { id: 'gateway', role: 'public MCP/auth', health: 'RUNNING', dockerAuthority: false, published: true, buildRevision: process.env.QUARANGATE_BUILD_REVISION ?? 'unknown' },
      { id: 'executor', role: 'private trusted execution', health: snap.runtime?.dockerReachable ? 'READY' : 'DEGRADED', dockerAuthority: snap.runtime?.dockerAuthority ?? null, published: false, buildRevision: snap.runtime?.buildRevision ?? 'unknown' },
      ...snap.targets.map((t) => ({ id: `target:${t.id}`, role: 'governed target', health: t.health ?? (t.running ? 'RUNNING' : 'STOPPED'), dockerAuthority: null, published: null, image: t.image ?? 'unknown' })),
    ],
    provenance: {
      gatewayRevision: process.env.QUARANGATE_BUILD_REVISION ?? 'unknown',
      executorRevision: snap.runtime?.buildRevision ?? 'unknown',
      state: !snap.runtime ? 'UNKNOWN' : ((process.env.QUARANGATE_BUILD_REVISION ?? 'unknown') === snap.runtime.buildRevision ? 'MATCH' : 'DRIFT'),
    },
  };
  if (view === 'egress') return {
    policies: [
      { component: 'Ollama', expected: 'http://ollama:11434', liveState: snap.runtime?.ollama.endpointState ?? 'UNKNOWN', payloadCapture: false },
      { component: 'GitHub App', expected: ['api.github.com', 'github.com'], liveState: 'POLICY_DECLARED_LIVE_COUNTERS_UNAVAILABLE', payloadCapture: false },
      { component: 'Kiro', expected: 'bounded provider allowlist via egress proxy', liveState: 'LIVE_COUNTERS_UNAVAILABLE', payloadCapture: false },
      { component: 'Copilot', expected: 'operator-approved exact-host allowlist via egress proxy', liveState: snap.backends.some((b) => b.id === 'copilot' && b.available) ? 'AVAILABLE' : 'NOT_CONFIGURED_OR_EXTERNAL_ENTITLEMENT_DEFERRED', payloadCapture: false },
    ],
  };
  if (view === 'providers') return {
    backends: snap.backends,
    ollama: snap.runtime?.ollama ?? { configured: false, endpointState: 'UNKNOWN' },
    activeJobs: snap.runtime?.activeJobs ?? null,
    queuedJobs: snap.runtime?.queuedJobs ?? null,
    providerAdmissionControl: snap.runtime?.providerAdmissionControl ?? 'UNKNOWN',
    sessionContinuity: snap.runtime?.sessionContinuity ?? 'UNKNOWN',
  };
  if (view === 'incidents') {
    const rows = queryAuditActivity({ principal: p.id, limit: 200, sinceMs: args.sinceMs });
    const grouped = new Map<string, { code: string; count: number; lastSeen: string; tool: string }>();
    for (const row of rows.filter((r) => r.decision === 'deny' || r.code)) {
      const code = row.code ?? 'DENIED'; const key = `${code}:${row.tool}`; const prior = grouped.get(key);
      grouped.set(key, { code, tool: row.tool, count: (prior?.count ?? 0) + 1, lastSeen: prior && prior.lastSeen > row.ts ? prior.lastSeen : row.ts });
    }
    const runtimeIncidents = [] as Array<Record<string, unknown>>;
    if (snap.runtime && !snap.runtime.dockerReachable) runtimeIncidents.push({ severity: 'CRITICAL', code: 'EXECUTOR_DOCKER_NOT_READY', count: 1, lastSeen: new Date().toISOString() });
    if (snap.runtime?.ollama.endpointState === 'DRIFT') runtimeIncidents.push({ severity: 'HIGH', code: 'OLLAMA_ENDPOINT_DRIFT', count: 1, lastSeen: new Date().toISOString() });
    return { incidents: [...runtimeIncidents, ...[...grouped.values()].map((v) => ({ severity: v.code.startsWith('FORBIDDEN') ? 'WARNING' : 'INFO', ...v }))].slice(0, 100) };
  }
  if (view === 'statistics') return { activity: stats, jobs: { active: snap.runtime?.activeJobs ?? null, queued: snap.runtime?.queuedJobs ?? null }, targets: { visible: snap.targets.length, running: snap.targets.filter((t) => t.running).length }, backends: { visible: snap.backends.length, available: snap.backends.filter((b) => b.available).length } };
  if (view === 'resources') return {
    ownershipModel: 'QUARANGATE_LABELS_ONLY',
    cleanupAuthority: 'NO_GENERIC_CLEANUP_API',
    resources: [],
    state: 'RUNTIME_RESOURCE_ENUMERATION_NOT_EXPOSED',
    note: 'Generic Docker resource enumeration is intentionally not public. A future bounded executor read model may expose only resources whose QuaranGate ownership is proven.',
  };
  if (view === 'capabilities') return {
    matrix: [
      { component: 'Ollama', configured: snap.runtime?.ollama.configured ?? false, implementation: 'SOURCE_ACCEPTED', productionQualification: 'FINAL_CANDIDATE_REQUALIFICATION_PENDING', toolUse: 'SUPPORTED_READ_ONLY', sessionResume: 'NOT_APPLICABLE' },
      { component: 'Kiro', configured: snap.backends.some((b) => b.id === 'kiro'), implementation: 'SOURCE_ACCEPTED', productionQualification: 'LIVE_PROVIDER_DEFERRED_EXTERNAL_ENTITLEMENT', toolUse: 'SUPPORTED', sessionResume: 'SOURCE_IMPLEMENTED_LIVE_DEFERRED' },
      { component: 'Copilot', configured: snap.backends.some((b) => b.id === 'copilot'), implementation: 'SOURCE_ACCEPTED', productionQualification: 'LIVE_PROVIDER_DEFERRED_EXTERNAL_SUBSCRIPTION', toolUse: 'SUPPORTED_READ_ONLY', sessionResume: 'EXPLICITLY_UNSUPPORTED_UNTIL_QUALIFIED' },
      { component: 'VS Code', configured: snap.runtime?.ideSessionControl === 'AVAILABLE_NOT_LIVE_QUALIFIED', implementation: 'SOURCE_CLOSED', productionQualification: 'LIVE_REVERIFICATION_IN_PROGRESS', toolUse: 'QUARANGATE_GOVERNED_REVIEW', sessionResume: 'SOURCE_IMPLEMENTED_LIVE_OPEN' },
      { component: 'Cursor', configured: false, implementation: 'SOURCE_CLOSED', productionQualification: 'LIVE_BLOCKED_CURSOR_NOT_INSTALLED', toolUse: 'QUARANGATE_GOVERNED', sessionResume: 'SOURCE_IMPLEMENTED_LIVE_BLOCKED' },
      { component: 'Visual Studio', configured: false, implementation: 'SECONDARY_DEFERRED', productionQualification: 'DEFERRED', toolUse: 'UNQUALIFIED', sessionResume: 'UNQUALIFIED' },
      { component: 'Antigravity', configured: false, implementation: 'SECONDARY_DEFERRED', productionQualification: 'DEFERRED', toolUse: 'UNQUALIFIED', sessionResume: 'UNQUALIFIED' },
    ],
  };
  if (view === 'recovery') return {
    startupRecovery: snap.runtime?.agentControlConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    providerSessionRecovery: snap.runtime?.sessionContinuity ?? 'UNKNOWN',
    backups: 'MANAGED_OUTSIDE_CONSOLE',
    rollback: 'MANAGED_BY_BOUNDED_DEPLOYMENT_PATH',
    ownerHost: 'QUALIFICATION_PENDING',
  };
  return {
    principal: { id: p.id, name: p.name },
    buildRevision: process.env.QUARANGATE_BUILD_REVISION ?? 'unknown',
    executor: snap.runtime,
    targets: { visible: snap.targets.length, running: snap.targets.filter((t) => t.running).length },
    backends: snap.backends,
    projects: snap.projects,
    activity: stats,
    rateLimit: rateState(p.id, p.rateLimit),
    capabilityState: { sessionContinuity: snap.runtime?.sessionContinuity ?? 'UNKNOWN', providerAdmissionControl: snap.runtime?.providerAdmissionControl ?? 'UNKNOWN', ideSessionControl: snap.runtime?.ideSessionControl ?? 'UNKNOWN' },
  };
}

export function registerControlCenterTools(server: McpServer): void {
  server.registerTool('control_center_query', {
    title: 'Query bounded QuaranGate Control Center metadata',
    description: 'Read metadata-only operational views for the current authenticated principal. Never returns prompts, file contents, command output, credentials, Docker options or raw tool payloads.',
    inputSchema: z.strictObject({
      view: z.enum(VIEWS),
      limit: z.number().int().min(1).max(200).optional(),
      sinceMs: z.number().int().min(60_000).max(86_400_000).optional(),
      tool: z.string().max(128).optional(),
      target: z.string().max(256).optional(),
      project: z.string().max(256).optional(),
      backend: z.string().max(128).optional(),
      profile: z.string().max(128).optional(),
      githubAccount: z.string().max(128).optional(),
      githubProject: z.string().max(256).optional(),
    }),
    outputSchema: z.strictObject({ view: z.enum(VIEWS), generatedAt: z.string(), data: z.record(z.unknown()) }),
    annotations: READ,
  }, async (args: any) => {
    const reqId = newReqId();
    const started = Date.now();
    const p = currentPrincipal();
    try {
      if (!p) throw new BridgeError('UNAUTHENTICATED', 'no principal in context', 401);
      if (!principalHasScope(p, 'targets:read')) throw new BridgeError('FORBIDDEN_SCOPE', 'missing scope targets:read', 403);
      const data = await viewData(args.view as View, p, args);
      audit({ reqId, principal: p.id, tool: 'control_center_query', target: args.view, decision: 'allow', durationMs: Date.now() - started });
      return ok({ view: args.view, generatedAt: new Date().toISOString(), data });
    } catch (e) {
      const be = asBridgeError(e);
      audit({ reqId, principal: p?.id ?? null, tool: 'control_center_query', target: args?.view ?? null, decision: 'deny', code: be.code, durationMs: Date.now() - started, detail: be.message });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: be.code, message: be.message }) }], isError: true };
    }
  });
}
