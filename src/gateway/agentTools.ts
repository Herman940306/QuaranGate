/**
 * Agent Control Plane MCP tools (Phase A2) — the first six activated tools:
 * agents_list, agent_projects, agent_dispatch, agent_status, agent_result,
 * agent_cancel.
 *
 * agent_diff, agent_apply and agent_discard remain CONTRACT-ONLY (A6): a fake
 * diff or apply path must not establish a misleading production contract.
 *
 * Gateway stays thin: authenticate (transport) → authorize via the pure A1
 * matrix → validate (strict A1 Zod schemas, registered directly so unknown
 * properties are rejected, not stripped) → delegate to the private executor →
 * audit → return typed structuredContent + backward-compatible JSON text.
 *
 * The executor independently re-validates trusted config and job ownership.
 * Prompts are never audited or logged here.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeError, asBridgeError } from '../shared/errors.js';
import { executor, type AgentJobWire } from './executorClient.js';
import { audit, newReqId } from './audit.js';
import { currentPrincipal } from './context.js';
import { principalHasScope, type Principal } from './config.js';
import {
  authorizeAgentTool,
  principalMayUseAgentBackend,
  principalMayUseAgentProfile,
  principalMayUseAgentProject,
  AGENT_TOOL_REQUIRED_SCOPE,
  type AgentToolName,
} from './agentAuthz.js';
import { AGENT_TOOL_SCHEMAS } from './agentSchemas.js';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
/** Cancellation permanently terminates a job (a retry is a new job). */
const CANCEL = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: object): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: { ...data },
  };
}

/**
 * Audit + error mapping for agent tools. `meta` carries bounded job/project/
 * backend identifiers — never prompt text, never summaries.
 */
function agentGuarded(
  tool: AgentToolName,
  fn: (args: any, p: Principal) => Promise<{ meta?: string; result: object }>,
) {
  return async (args: any): Promise<ToolResult> => {
    const reqId = newReqId();
    const started = Date.now();
    const p = currentPrincipal();
    try {
      if (!p) throw new BridgeError('UNAUTHENTICATED', 'no principal in context', 401);
      if (!principalHasScope(p, AGENT_TOOL_REQUIRED_SCOPE[tool])) {
        throw new BridgeError('FORBIDDEN_SCOPE', `missing scope ${AGENT_TOOL_REQUIRED_SCOPE[tool]}`, 403);
      }
      const { meta, result } = await fn(args, p);
      audit({ reqId, principal: p.id, tool, target: null, decision: 'allow', durationMs: Date.now() - started, ...(meta ? { detail: meta } : {}) });
      return ok(result);
    } catch (e) {
      const be = asBridgeError(e);
      audit({ reqId, principal: p?.id ?? null, tool, target: null, decision: 'deny', code: be.code, durationMs: Date.now() - started, detail: be.message });
      return { content: [{ type: 'text', text: JSON.stringify({ error: be.code, message: be.message }) }], isError: true };
    }
  };
}

/** Enforce the full pure A1 authorization matrix; throw a typed error on deny. */
function requireAgentAuthz(req: Parameters<typeof authorizeAgentTool>[0]): void {
  const d = authorizeAgentTool(req);
  if (!d.allowed) throw new BridgeError(d.code === 'MALFORMED_REQUEST' ? 'MALFORMED_REQUEST' : d.code, d.reason, d.code === 'MALFORMED_REQUEST' ? 400 : 403);
}

const jobRef = (job: AgentJobWire) => ({ jobId: job.jobId, principalId: job.principalId, project: job.project });

function statusOutput(job: AgentJobWire): Record<string, unknown> {
  const end = job.completedAt ? Date.parse(job.completedAt) : Date.now();
  return {
    jobId: job.jobId,
    status: job.status,
    failureCode: job.failureCode,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    elapsedMs: job.startedAt ? Math.max(0, end - Date.parse(job.startedAt)) : undefined,
  };
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool('agents_list', {
    title: 'List agent backends',
    description: 'List agent backends this client may use. In phase A2 execution is performed by a deterministic local fake engine; no real agent runs.',
    inputSchema: AGENT_TOOL_SCHEMAS.agents_list.input,
    outputSchema: AGENT_TOOL_SCHEMAS.agents_list.output,
    annotations: READ,
  }, agentGuarded('agents_list', async (_args, p) => {
    requireAgentAuthz({ tool: 'agents_list', principal: p });
    const backends = (await executor.agentsList())
      .filter((b) => principalMayUseAgentBackend(p, b.id))
      .map((b) => ({ id: b.id, available: b.available, profiles: b.profiles.filter((pr) => principalMayUseAgentProfile(p, pr)) }));
    return { result: { backends } };
  }));

  server.registerTool('agent_projects', {
    title: 'List agent projects',
    description: 'List logical projects this client may dispatch agents against. Never exposes host paths.',
    inputSchema: AGENT_TOOL_SCHEMAS.agent_projects.input,
    outputSchema: AGENT_TOOL_SCHEMAS.agent_projects.output,
    annotations: READ,
  }, agentGuarded('agent_projects', async (_args, p) => {
    requireAgentAuthz({ tool: 'agent_projects', principal: p });
    const projects = (await executor.agentProjects())
      .filter((pr) => principalMayUseAgentProject(p, pr.id))
      .map((pr) => ({
        id: pr.id,
        gitRequired: pr.gitRequired,
        allowedBackends: pr.allowedBackends.filter((b) => principalMayUseAgentBackend(p, b)),
        allowedProfiles: pr.allowedProfiles.filter((pf) => principalMayUseAgentProfile(p, pf)),
      }));
    return { result: { projects } };
  }));

  server.registerTool('agent_dispatch', {
    title: 'Dispatch an agent job',
    description: 'Create a governed asynchronous agent job and return its jobId immediately. Phase A2: executed by a deterministic local fake backend in a durable job engine — no real agent, no file changes.',
    inputSchema: AGENT_TOOL_SCHEMAS.agent_dispatch.input,
    outputSchema: AGENT_TOOL_SCHEMAS.agent_dispatch.output,
    annotations: WRITE,
  }, agentGuarded('agent_dispatch', async (args, p) => {
    // Full grant matrix BEFORE any executor work: unauthorized dispatch never persists a job.
    requireAgentAuthz({ tool: 'agent_dispatch', principal: p, project: args.project, backend: args.backend, profile: args.profile });
    const job = await executor.agentDispatch({
      principal: p.id,
      backend: args.backend,
      project: args.project,
      profile: args.profile,
      prompt: args.prompt,
      resourcePolicy: args.resourcePolicy,
      sessionPolicy: args.sessionPolicy,
    });
    return {
      meta: `job=${job.jobId} project=${job.project} backend=${job.backend} profile=${job.profile}`,
      result: {
        jobId: job.jobId, status: job.status, backend: job.backend, project: job.project,
        profile: job.profile, resourcePolicy: job.resourcePolicy, createdAt: job.createdAt,
      },
    };
  }));

  server.registerTool('agent_status', {
    title: 'Get agent job status',
    description: 'Get lifecycle status of an agent job this client owns.',
    inputSchema: AGENT_TOOL_SCHEMAS.agent_status.input,
    outputSchema: AGENT_TOOL_SCHEMAS.agent_status.output,
    annotations: READ,
  }, agentGuarded('agent_status', async (args, p) => {
    const job = await executor.agentJob(args.jobId, p.id); // executor enforces ownership
    requireAgentAuthz({ tool: 'agent_status', principal: p, job: jobRef(job) });
    return { meta: `job=${job.jobId} status=${job.status}`, result: statusOutput(job) };
  }));

  server.registerTool('agent_result', {
    title: 'Get agent job result',
    description: 'Get the concise normalized result of an agent job this client owns. Large evidence stays local; the raw prompt is never returned.',
    inputSchema: AGENT_TOOL_SCHEMAS.agent_result.input,
    outputSchema: AGENT_TOOL_SCHEMAS.agent_result.output,
    annotations: READ,
  }, agentGuarded('agent_result', async (args, p) => {
    const job = await executor.agentJobResult(args.jobId, p.id);
    requireAgentAuthz({ tool: 'agent_result', principal: p, job: jobRef(job) });
    const summary = job.summary
      ?? (job.failureReason ? `Job ${job.status}: ${job.failureReason}` : `Job is ${job.status}; no result yet.`);
    return {
      meta: `job=${job.jobId} status=${job.status}`,
      result: {
        jobId: job.jobId, status: job.status, backend: job.backend, project: job.project, profile: job.profile,
        summary: summary.slice(0, 16_384),
        exitCode: job.exitCode ?? undefined,
        // A2 fake backend changes nothing and uses no provider resources:
        changedFiles: [],
        usage: { usageAvailable: false },
      },
    };
  }));

  server.registerTool('agent_diff', {
    title: 'Review agent job diff',
    description: 'Review the canonical change set produced by an agent job. Returns verified evidence derived only from the immutable canonical artifact. Read-only; does not mutate the job, project, apply state, or evidence.',
    inputSchema: AGENT_TOOL_SCHEMAS.agent_diff.input,
    outputSchema: AGENT_TOOL_SCHEMAS.agent_diff.output,
    annotations: READ,
  }, agentGuarded('agent_diff', async (args, p) => {
    // Executor enforces ownership on this read (UNKNOWN_JOB / FORBIDDEN_JOB).
    const job = await executor.agentJob(args.jobId, p.id);
    // Full A1 matrix incl. the A6-B4 refinement: agents:read + ownership +
    // CURRENT grant for the job's project (project taken from the trusted job
    // record, never caller input) → FORBIDDEN_PROJECT on revocation.
    requireAgentAuthz({ tool: 'agent_diff', principal: p, job: jobRef(job) });
    const diff = await executor.agentDiff({
      jobId: args.jobId, principal: p.id, path: args.path, cursor: args.cursor, maxBytes: args.maxBytes,
    });
    const result: Record<string, unknown> = {
      jobId: diff.jobId,
      diffHash: diff.diffHash,
      chunk: diff.chunk,
      chunkBytes: diff.chunkBytes,
      totalBytes: diff.totalBytes,
      truncated: diff.truncated,
    };
    if (diff.path !== undefined) result.path = diff.path;
    if (diff.cursor !== undefined) result.cursor = diff.cursor;
    if (diff.artifactHash !== undefined) result.artifactHash = diff.artifactHash;
    if (diff.changeSetHash !== undefined) result.changeSetHash = diff.changeSetHash;
    if (diff.baseCommit !== undefined) result.baseCommit = diff.baseCommit;
    if (diff.contentComplete !== undefined) result.contentComplete = diff.contentComplete;
    if (diff.applicable !== undefined) result.applicable = diff.applicable;
    if (diff.reason !== undefined) result.reason = diff.reason;
    if (diff.opCount !== undefined) result.opCount = diff.opCount;
    if (diff.artifactBytes !== undefined) result.artifactBytes = diff.artifactBytes;
    // Bounded audit metadata only — never the diff text or the raw selection path.
    return {
      meta: `job=${job.jobId} artifact=${diff.diffHash.slice(0, 12)} bytes=${diff.chunkBytes}/${diff.totalBytes} sel=${diff.path !== undefined ? 'path' : 'all'}${diff.truncated ? ' more' : ''}`,
      result,
    };
  }));

  server.registerTool('agent_cancel', {
    title: 'Cancel an agent job',
    description: 'Cancel a queued or running agent job this client owns. Cancellation is final: the job cannot resume (a retry is a new job).',
    inputSchema: AGENT_TOOL_SCHEMAS.agent_cancel.input,
    outputSchema: AGENT_TOOL_SCHEMAS.agent_cancel.output,
    annotations: CANCEL,
  }, agentGuarded('agent_cancel', async (args, p) => {
    const job = await executor.agentJob(args.jobId, p.id); // ownership enforced executor-side
    requireAgentAuthz({ tool: 'agent_cancel', principal: p, job: jobRef(job) });
    const cancelled = await executor.agentJobCancel(args.jobId, p.id);
    return { meta: `job=${cancelled.jobId} status=${cancelled.status}`, result: { jobId: cancelled.jobId, status: cancelled.status } };
  }));
}
