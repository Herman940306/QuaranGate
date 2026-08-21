/**
 * MCP Agent Control Plane tool contract schemas.
 *
 * Strict Zod input/output contracts for the nine agent tools. All nine are
 * registered with buildServer() via registerAgentTools() (see
 * src/gateway/agentTools.ts): the live MCP surface is the 14 IDE tools plus
 * these 9 agent tools (23 total).
 *
 * Security properties of every public input object:
 * - `.strict()`: unknown properties are rejected, so callers can never
 *   smuggle future Docker options (hostPath, runnerImage, mounts,
 *   privileged, networkMode, dockerSocket, ...);
 * - bounded strings everywhere (prompt <= MAX_AGENT_PROMPT_CHARS);
 * - callers address logical ids only — no host paths, images, volumes,
 *   networks or capability flags are expressible.
 */
import { z } from 'zod';
import {
  AGENT_BACKEND_IDS,
  AGENT_PROFILE_IDS,
  RESOURCE_POLICY_IDS,
  AGENT_JOB_STATUSES,
  AGENT_FAILURE_CODES,
  AGENT_JOB_ID_PATTERN,
  AGENT_PROJECT_ID_PATTERN,
  MAX_AGENT_PROMPT_CHARS,
} from '../shared/agents.js';

// -- shared field schemas ----------------------------------------------------

const jobId = z.string().regex(AGENT_JOB_ID_PATTERN, 'invalid job id');
const projectId = z.string().regex(AGENT_PROJECT_ID_PATTERN, 'invalid project id');
const backendId = z.enum(AGENT_BACKEND_IDS);
const profileId = z.enum(AGENT_PROFILE_IDS);
const resourcePolicyId = z.enum(RESOURCE_POLICY_IDS);
const jobStatus = z.enum(AGENT_JOB_STATUSES);
const failureCode = z.enum(AGENT_FAILURE_CODES);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().max(64);
/** Workspace-relative selection path — never an absolute/host path. */
const relPath = z.string().min(1).max(512).refine((p) => !p.startsWith('/') && !p.includes('..') && !p.includes('\0'), 'workspace-relative path required');

/** Bounded diff chunk: matches the existing 256 KiB output cap. */
export const MAX_AGENT_DIFF_CHUNK_BYTES = 256 * 1024;
export const MAX_AGENT_SUMMARY_CHARS = 16_384;
export const MAX_AGENT_CHANGED_FILES = 1000;

const usageSchema = z.object({
  usageAvailable: z.boolean(),
  backend: backendId.optional(),
  model: z.string().max(128).optional(),
  providerCredits: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
}).strict();

const telemetrySchema = z.object({
  runtimeMs: z.number().int().nonnegative().optional(),
  peakCpuMillicores: z.number().int().nonnegative().optional(),
  peakMemoryBytes: z.number().int().nonnegative().optional(),
  sandboxBytes: z.number().int().nonnegative().optional(),
  storedEvidenceBytes: z.number().int().nonnegative().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  peakProcessCount: z.number().int().nonnegative().optional(),
}).strict();

const evidenceRefSchema = z.object({
  kind: z.enum(['diff', 'result', 'transcript', 'log']),
  sha256: sha256Hex,
  bytes: z.number().int().nonnegative(),
}).strict();

// -- per-tool contracts ------------------------------------------------------

export const agentsListInput = z.object({}).strict();
export const agentsListOutput = z.object({
  backends: z.array(z.object({
    id: backendId,
    available: z.boolean(),
    profiles: z.array(profileId).max(16),
    /** Transport metadata only — never command paths or credentials. */
    transport: z.enum(['acp', 'sdk', 'cli']).optional(),
  }).strict()).max(16),
}).strict();

export const agentProjectsInput = z.object({}).strict();
/** Logical project info only. Trusted hostPath is NEVER exposed here. */
export const agentProjectsOutput = z.object({
  projects: z.array(z.object({
    id: projectId,
    gitRequired: z.boolean(),
    allowedBackends: z.array(backendId).max(16),
    allowedProfiles: z.array(profileId).max(16),
  }).strict()).max(256),
}).strict();

export const agentDispatchInput = z.object({
  backend: backendId,
  project: projectId,
  profile: profileId,
  prompt: z.string().min(1).max(MAX_AGENT_PROMPT_CHARS),
  /** Optional; defaults to the profile's default policy. */
  resourcePolicy: resourcePolicyId.optional(),
  /** A8 direction; A2 MUST reject 'resume' explicitly until supported. */
  sessionPolicy: z.enum(['new', 'resume']).optional(),
}).strict();
export const agentDispatchOutput = z.object({
  jobId,
  status: jobStatus,
  backend: backendId,
  project: projectId,
  profile: profileId,
  resourcePolicy: resourcePolicyId,
  createdAt: isoTime,
}).strict();

export const agentStatusInput = z.object({ jobId }).strict();
export const agentStatusOutput = z.object({
  jobId,
  status: jobStatus,
  failureCode: failureCode.optional(),
  createdAt: isoTime,
  startedAt: isoTime.optional(),
  completedAt: isoTime.optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  /** Bounded progress metadata — never a transcript. */
  phase: z.string().max(64).optional(),
  progress: z.string().max(256).optional(),
}).strict();

export const agentResultInput = z.object({ jobId }).strict();
/** Concise normalized summary; large evidence stays local (see evidence refs). */
export const agentResultOutput = z.object({
  jobId,
  status: jobStatus,
  backend: backendId,
  project: projectId,
  profile: profileId,
  summary: z.string().max(MAX_AGENT_SUMMARY_CHARS),
  exitCode: z.number().int().nullable().optional(),
  changedFiles: z.array(relPath).max(MAX_AGENT_CHANGED_FILES).optional(),
  baseCommit: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
  diffHash: sha256Hex.optional(),
  evidence: z.array(evidenceRefSchema).max(16).optional(),
  usage: usageSchema.optional(),
  telemetry: telemetrySchema.optional(),
}).strict();

export const agentDiffInput = z.object({
  jobId,
  /** Optional single-file selection (workspace-relative). */
  path: relPath.optional(),
  /** Opaque continuation token from a previous truncated chunk. */
  cursor: z.string().max(256).optional(),
  maxBytes: z.number().int().min(1024).max(MAX_AGENT_DIFF_CHUNK_BYTES).optional(),
}).strict();
export const agentDiffOutput = z.object({
  jobId,
  /** Verified artifactHash — the sole approval identity, present on every chunk. */
  diffHash: sha256Hex,
  path: relPath.optional(),
  chunk: z.string().max(MAX_AGENT_DIFF_CHUNK_BYTES),
  chunkBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  cursor: z.string().max(256).optional(),
  // First-chunk verified canonical metadata (A6-B4). Present only on the first
  // chunk (absent cursor / validated cursor offset 0). Unknown fields remain
  // rejected by .strict(); there is deliberately NO structured changes[] array.
  artifactHash: sha256Hex.optional(),
  changeSetHash: sha256Hex.optional(),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  contentComplete: z.boolean().optional(),
  applicable: z.boolean().optional(),
  reason: z.string().max(4096).nullable().optional(),
  opCount: z.number().int().nonnegative().optional(),
  artifactBytes: z.number().int().nonnegative().optional(),
}).strict();

export const agentCancelInput = z.object({ jobId }).strict();
export const agentCancelOutput = z.object({ jobId, status: jobStatus }).strict();

/**
 * Apply takes NO patch text: the operation applies stored, verified
 * job evidence only. A caller-injected patch is not expressible.
 */
export const agentApplyInput = z.object({ jobId }).strict();
export const agentApplyOutput = z.object({
  jobId,
  status: jobStatus,
  project: projectId,
  appliedAt: isoTime.optional(),
}).strict();

export const agentDiscardInput = z.object({ jobId }).strict();
export const agentDiscardOutput = z.object({ jobId, status: jobStatus }).strict();

// -- registry ---------------------------------------------------------------

export const AGENT_TOOL_SCHEMAS = {
  agents_list: { input: agentsListInput, output: agentsListOutput },
  agent_projects: { input: agentProjectsInput, output: agentProjectsOutput },
  agent_dispatch: { input: agentDispatchInput, output: agentDispatchOutput },
  agent_status: { input: agentStatusInput, output: agentStatusOutput },
  agent_result: { input: agentResultInput, output: agentResultOutput },
  agent_diff: { input: agentDiffInput, output: agentDiffOutput },
  agent_cancel: { input: agentCancelInput, output: agentCancelOutput },
  agent_apply: { input: agentApplyInput, output: agentApplyOutput },
  agent_discard: { input: agentDiscardInput, output: agentDiscardOutput },
} as const;

export type AgentToolContractName = keyof typeof AGENT_TOOL_SCHEMAS;
