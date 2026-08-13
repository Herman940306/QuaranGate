/**
 * Private executor HTTP routes for the Agent Control Plane (Phase A2).
 *
 * All routes sit behind the existing internal-token middleware on the
 * internal Docker network. Payloads are strictly validated here — gateway
 * validation is never assumed (defense in depth). There is deliberately no
 * route for raw Docker, shell, SQL, or arbitrary paths.
 *
 * The agent subsystem is OPTIONAL: when config/agents.yaml is absent the
 * bridge runs exactly as before and these routes fail closed with
 * AGENTS_UNAVAILABLE.
 */
import type express from 'express';
import { z } from 'zod';
import { BridgeError } from '../../shared/errors.js';
import { AGENT_JOB_ID_PATTERN, MAX_AGENT_PROMPT_CHARS } from '../../shared/agents.js';
import type { AgentJobEngine } from './jobEngine.js';
import type { AgentJobRow } from './jobStore.js';

const principalSchema = z.string().min(1).max(128);

const dispatchBody = z.object({
  principal: principalSchema,
  backend: z.string().min(1).max(64),
  project: z.string().min(1).max(64),
  profile: z.string().min(1).max(64),
  prompt: z.string().min(1).max(MAX_AGENT_PROMPT_CHARS),
  resourcePolicy: z.string().min(1).max(64).optional(),
  sessionPolicy: z.enum(['new', 'resume']).optional(),
}).strict();

const cancelBody = z.object({ principal: principalSchema }).strict();
const applyBody = z.object({ principal: principalSchema }).strict();
const discardBody = z.object({ principal: principalSchema }).strict();

/** Workspace-relative selection path — never an absolute/host/traversal path. */
const diffPath = z.string().min(1).max(512).refine(
  (p) => !p.startsWith('/') && !p.includes('..') && !p.includes('\0') && !p.includes('\\'),
  'workspace-relative path required',
);
const diffBody = z.object({
  principal: principalSchema,
  path: diffPath.optional(),
  cursor: z.string().max(256).optional(),
  maxBytes: z.number().int().min(1024).max(256 * 1024).optional(),
}).strict();

function requireJobId(id: unknown): string {
  if (typeof id !== 'string' || !AGENT_JOB_ID_PATTERN.test(id)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid job id', 400);
  }
  return id;
}

function requirePrincipalParam(req: express.Request): string {
  const p = principalSchema.safeParse(req.query.principal);
  if (!p.success) throw new BridgeError('MALFORMED_REQUEST', 'principal query parameter required', 400);
  return p.data;
}

/** Wire shape for job facts. The raw prompt is NEVER included. */
export function jobWire(job: AgentJobRow): Record<string, unknown> {
  return {
    jobId: job.jobId,
    principalId: job.principalId,
    backend: job.backend,
    project: job.project,
    profile: job.profile,
    resourcePolicy: job.resourcePolicy,
    status: job.status,
    failureCode: job.failureCode ?? undefined,
    failureReason: job.failureReason ?? undefined,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? undefined,
    completedAt: job.completedAt ?? undefined,
    promptHash: job.promptHash,
    summary: job.summary ?? undefined,
    exitCode: job.exitCode ?? undefined,
    writer: job.writer,
  };
}

type Handle = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;

export function registerAgentRoutes(
  app: express.Express,
  handle: Handle,
  getEngine: () => AgentJobEngine | null,
): void {
  const engine = (): AgentJobEngine => {
    const e = getEngine();
    if (!e) throw new BridgeError('AGENTS_UNAVAILABLE', 'agent control plane is not configured on this executor', 503);
    return e;
  };

  app.get('/agents', handle(async () => ({ backends: engine().listBackends() })));

  // Logical project info only — trusted hostPath never leaves the executor.
  app.get('/agent/projects', handle(async () => ({ projects: engine().listProjects() })));

  app.post('/agent/jobs', handle(async (req) => {
    const parsed = dispatchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BridgeError('MALFORMED_REQUEST', `dispatch: ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`, 400);
    }
    return { job: jobWire(engine().dispatch(parsed.data)) };
  }));

  app.get('/agent/jobs/:id', handle(async (req) => {
    const jobId = requireJobId(req.params.id);
    const principal = requirePrincipalParam(req);
    return { job: jobWire(engine().getOwnedJob(jobId, principal)) };
  }));

  app.get('/agent/jobs/:id/result', handle(async (req) => {
    const jobId = requireJobId(req.params.id);
    const principal = requirePrincipalParam(req);
    return { job: jobWire(engine().getOwnedJob(jobId, principal)) };
  }));

  app.post('/agent/jobs/:id/cancel', handle(async (req) => {
    const jobId = requireJobId(req.params.id);
    const parsed = cancelBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BridgeError('MALFORMED_REQUEST', 'cancel: principal required', 400);
    return { job: jobWire(engine().cancel(jobId, parsed.data.principal)) };
  }));

  // A6-B4: read-only canonical review. The executor re-derives job ownership +
  // trusted project + artifact volume from durable state (never caller input).
  app.post('/agent/jobs/:id/diff', handle(async (req) => {
    const jobId = requireJobId(req.params.id);
    const parsed = diffBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BridgeError('MALFORMED_REQUEST', `diff: ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`, 400);
    }
    const diff = await engine().diff({
      jobId,
      principal: parsed.data.principal,
      path: parsed.data.path,
      cursor: parsed.data.cursor,
      maxBytes: parsed.data.maxBytes,
    });
    return { diff };
  }));

  // A6-B5: apply the job's verified canonical artifact to its registered real
  // project. The executor re-derives job ownership + trusted project + base
  // commit + artifact volume from durable state (never caller input). The
  // request body carries only `principal` — no patch text, no host path, no
  // Docker options are expressible (agentApplyInput is `{jobId}` only at the
  // public contract; jobId arrives via the URL param exactly like /cancel).
  app.post('/agent/jobs/:id/apply', handle(async (req) => {
    const jobId = requireJobId(req.params.id);
    const parsed = applyBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BridgeError('MALFORMED_REQUEST', 'apply: principal required', 400);
    const result = await engine().apply({ jobId, principal: parsed.data.principal });
    return { apply: result, job: jobWire(engine().getOwnedJob(jobId, parsed.data.principal)) };
  }));

  // A6-B6: discard — a durable logical disposition change only (no Docker
  // I/O, no project filesystem access; see PHASE_A6_B6_AGENT_DISCARD.md
  // §11). The executor re-derives job ownership from durable state (never
  // caller input). Mirrors POST /agent/jobs/:id/cancel exactly.
  app.post('/agent/jobs/:id/discard', handle(async (req) => {
    const jobId = requireJobId(req.params.id);
    const parsed = discardBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BridgeError('MALFORMED_REQUEST', 'discard: principal required', 400);
    return { job: jobWire(engine().discard(jobId, parsed.data.principal)) };
  }));
}
