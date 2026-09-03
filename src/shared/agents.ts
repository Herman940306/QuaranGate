/**
 * Shared Agent Control Plane contracts (Phase A1).
 *
 * Typed contracts + pure job state-machine rules for the future governed
 * Agent Dispatch feature. Nothing in this module executes agents, creates
 * jobs, or touches Docker: A2+ implement the runtime against these
 * contracts. See docs/AGENT_CONTROL_PLANE.md and the Master PRD.
 */
import { BridgeError } from './errors.js';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const AGENT_BACKEND_IDS = ['kiro', 'copilot', 'ollama'] as const;
export type AgentBackendId = (typeof AGENT_BACKEND_IDS)[number];

export const AGENT_PROFILE_IDS = ['audit', 'plan', 'implement', 'review'] as const;
export type AgentProfileId = (typeof AGENT_PROFILE_IDS)[number];

export const RESOURCE_POLICY_IDS = ['economy', 'standard', 'deep'] as const;
export type ResourcePolicyId = (typeof RESOURCE_POLICY_IDS)[number];

/**
 * Same grammar as the proven target-ID grammar. A project ID is a logical
 * name only; the trusted executor-side registry resolves it to a source.
 * Public callers never supply host paths.
 */
export const AGENT_PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export type AgentProjectId = string;

/** Executor-generated job identity: `job_` + 32 lowercase hex chars. */
export const AGENT_JOB_ID_PATTERN = /^job_[0-9a-f]{32}$/;
export type AgentJobId = string;

/**
 * v1 caller prompt bound (characters). Matches the order of magnitude of the
 * existing 32 KiB terminal command cap: large enough for a bounded
 * implementation brief, small enough to prevent unbounded payload smuggling.
 */
export const MAX_AGENT_PROMPT_CHARS = 32_768;

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export const AGENT_JOB_ACTIVE_STATUSES = ['QUEUED', 'PREPARING', 'RUNNING', 'VALIDATING'] as const;

/** Failure/termination statuses. Never collapse these into a generic ERROR. */
export const AGENT_FAILURE_CODES = [
  'FAILED_PRECONDITION',
  'FAILED_POLICY',
  'FAILED_AGENT',
  'FAILED_TIMEOUT',
  'FAILED_INFRASTRUCTURE',
  'CANCELLED',
] as const;
export type AgentFailureCode = (typeof AGENT_FAILURE_CODES)[number];

/** Post-completion dispositions. COMPLETED is NOT equivalent to APPLIED. */
export const AGENT_JOB_DISPOSITIONS = ['APPLIED', 'DISCARDED'] as const;
export type AgentJobDisposition = (typeof AGENT_JOB_DISPOSITIONS)[number];

export const AGENT_JOB_STATUSES = [
  ...AGENT_JOB_ACTIVE_STATUSES,
  'COMPLETED',
  ...AGENT_FAILURE_CODES,
  ...AGENT_JOB_DISPOSITIONS,
] as const;
export type AgentJobStatus = (typeof AGENT_JOB_STATUSES)[number];

/**
 * The complete transition matrix. Anything not listed is rejected.
 *
 * Rationale per failure code:
 * - FAILED_PRECONDITION: precondition checks happen before execution
 *   (QUEUED/PREPARING only).
 * - FAILED_POLICY: a policy violation can be detected at any active point.
 * - FAILED_AGENT: the agent itself can only fail once it runs.
 * - FAILED_TIMEOUT: staging, execution, and validation are all time-bounded;
 *   queue admission is not (queue policy failures are precondition/policy).
 * - FAILED_INFRASTRUCTURE / CANCELLED: possible from any active state.
 *
 * Failure statuses and dispositions are terminal: a retry is a NEW job,
 * never mutation of historical truth.
 */
const AGENT_JOB_TRANSITIONS: Record<AgentJobStatus, readonly AgentJobStatus[]> = {
  QUEUED: ['PREPARING', 'FAILED_PRECONDITION', 'FAILED_POLICY', 'FAILED_INFRASTRUCTURE', 'CANCELLED'],
  PREPARING: ['RUNNING', 'FAILED_PRECONDITION', 'FAILED_POLICY', 'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED'],
  RUNNING: ['VALIDATING', 'FAILED_POLICY', 'FAILED_AGENT', 'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED'],
  VALIDATING: ['COMPLETED', 'FAILED_POLICY', 'FAILED_AGENT', 'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED'],
  COMPLETED: ['APPLIED', 'DISCARDED'],
  FAILED_PRECONDITION: [],
  FAILED_POLICY: [],
  FAILED_AGENT: [],
  FAILED_TIMEOUT: [],
  FAILED_INFRASTRUCTURE: [],
  CANCELLED: [],
  APPLIED: [],
  DISCARDED: [],
};

export function canTransitionAgentJob(from: AgentJobStatus, to: AgentJobStatus): boolean {
  return (AGENT_JOB_TRANSITIONS[from] ?? []).includes(to);
}

export function assertAgentJobTransition(from: AgentJobStatus, to: AgentJobStatus): void {
  if (!canTransitionAgentJob(from, to)) {
    throw new BridgeError('INVALID_JOB_TRANSITION', `invalid agent job transition ${from} -> ${to}`, 409);
  }
}

/** QUEUED/PREPARING/RUNNING/VALIDATING: the job still occupies execution capacity. */
export function isActiveAgentJobStatus(s: AgentJobStatus): boolean {
  return (AGENT_JOB_ACTIVE_STATUSES as readonly string[]).includes(s);
}

export function isAgentFailureStatus(s: AgentJobStatus): boolean {
  return (AGENT_FAILURE_CODES as readonly string[]).includes(s);
}

/** Execution finished successfully (evidence exists): COMPLETED, APPLIED or DISCARDED. */
export function isExecutionComplete(s: AgentJobStatus): boolean {
  return s === 'COMPLETED' || isFinalDisposition(s);
}

/** APPLIED / DISCARDED: one-time, immutable outcomes of a COMPLETED job. */
export function isFinalDisposition(s: AgentJobStatus): boolean {
  return (AGENT_JOB_DISPOSITIONS as readonly string[]).includes(s);
}

/** No outgoing transitions exist: all failures and both dispositions. */
export function isTerminalAgentJobStatus(s: AgentJobStatus): boolean {
  return AGENT_JOB_TRANSITIONS[s].length === 0;
}

// ---------------------------------------------------------------------------
// A6 internal apply-attempt lifecycle (NOT public job status) — Phase A6-B1
// ---------------------------------------------------------------------------

/**
 * Internal apply-attempt lifecycle. This is durable state persisted
 * separately from the public {@link AgentJobStatus} above (see jobStore.ts
 * `apply_attempts` table). It is never returned as a job's public `status`
 * and no MCP tool exposes these values directly; only the public
 * COMPLETED -> APPLIED/DISCARDED disposition is ever visible.
 *
 * Invariant (drives restart recovery in jobStore.ts `recoverApplyAttempts`):
 * - STARTED / VERIFYING mean host mutation has NOT begun.
 * - APPLYING means host mutation MAY have begun.
 * Therefore an orphaned STARTED/VERIFYING attempt found at startup is safe to
 * abort with zero mutation; an orphaned APPLYING attempt is not — its
 * outcome is UNKNOWN and must never be auto-retried.
 */
export const AGENT_APPLY_ATTEMPT_STATES = [
  'STARTED',
  'VERIFYING',
  'APPLYING',
  'VERIFIED_SUCCESS',
  'PRECONDITION_FAILED',
  'ARTIFACT_INVALID',
  'FAILED_ROLLED_BACK',
  'ABORTED_NO_MUTATION',
  'UNCERTAIN',
] as const;
export type AgentApplyAttemptState = (typeof AGENT_APPLY_ATTEMPT_STATES)[number];

/** States during which an attempt owns exclusive per-project/per-job admission. */
export const AGENT_APPLY_ATTEMPT_ACTIVE_STATES = ['STARTED', 'VERIFYING', 'APPLYING'] as const;

/** Zero-mutation terminal states: the host project was never touched. */
export const AGENT_APPLY_ATTEMPT_ZERO_MUTATION_TERMINALS = [
  'PRECONDITION_FAILED',
  'ARTIFACT_INVALID',
  'ABORTED_NO_MUTATION',
] as const;

/**
 * The complete internal transition matrix. Anything not listed is rejected.
 * Restart recovery uses these SAME legal edges (STARTED/VERIFYING ->
 * ABORTED_NO_MUTATION, APPLYING -> UNCERTAIN) — there is no separate
 * recovery-only transition rule.
 */
const AGENT_APPLY_ATTEMPT_TRANSITIONS: Record<AgentApplyAttemptState, readonly AgentApplyAttemptState[]> = {
  STARTED: ['VERIFYING', 'PRECONDITION_FAILED', 'ARTIFACT_INVALID', 'ABORTED_NO_MUTATION'],
  VERIFYING: ['APPLYING', 'PRECONDITION_FAILED', 'ARTIFACT_INVALID', 'ABORTED_NO_MUTATION'],
  APPLYING: ['VERIFIED_SUCCESS', 'FAILED_ROLLED_BACK', 'UNCERTAIN'],
  VERIFIED_SUCCESS: [],
  PRECONDITION_FAILED: [],
  ARTIFACT_INVALID: [],
  FAILED_ROLLED_BACK: [],
  ABORTED_NO_MUTATION: [],
  UNCERTAIN: [],
};

export function canTransitionApplyAttempt(from: AgentApplyAttemptState, to: AgentApplyAttemptState): boolean {
  return (AGENT_APPLY_ATTEMPT_TRANSITIONS[from] ?? []).includes(to);
}

export function assertApplyAttemptTransition(from: AgentApplyAttemptState, to: AgentApplyAttemptState): void {
  if (!canTransitionApplyAttempt(from, to)) {
    throw new BridgeError('INVALID_ATTEMPT_TRANSITION', `invalid apply attempt transition ${from} -> ${to}`, 409);
  }
}

export function isActiveApplyAttemptState(s: AgentApplyAttemptState): boolean {
  return (AGENT_APPLY_ATTEMPT_ACTIVE_STATES as readonly string[]).includes(s);
}

/** No outgoing transitions exist: every terminal apply-attempt outcome, including UNCERTAIN. */
export function isTerminalApplyAttemptState(s: AgentApplyAttemptState): boolean {
  return AGENT_APPLY_ATTEMPT_TRANSITIONS[s].length === 0;
}

/**
 * Project apply-admission state (Phase A6). Persisted separately from any
 * job. QUARANTINED is permanent within A6-B1: no MCP tool clears it, and
 * discarding a job never clears it either.
 */
export const AGENT_PROJECT_APPLY_STATES = ['NORMAL', 'QUARANTINED'] as const;
export type AgentProjectApplyState = (typeof AGENT_PROJECT_APPLY_STATES)[number];

/**
 * Internal artifact cache/index lifecycle state (Phase A6-B1 schema
 * foundation). Persisted in `agent_jobs.artifact_state`. This is NOT a
 * public job status and is never returned by any MCP tool directly.
 *
 * NONE     — no artifact has been produced for this job.
 * AVAILABLE — an artifact has been produced and is indexed; eligible for
 *             applicability evaluation (re-verification still required at
 *             apply time — this is cache/index state only, not authority).
 * EXPIRED  — artifact was previously available but has been invalidated
 *             (e.g. volume evicted, TTL expired). Cannot be applied.
 */
export const ARTIFACT_STATES = ['NONE', 'AVAILABLE', 'EXPIRED'] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

// ---------------------------------------------------------------------------
// Writer policy (v1)
// ---------------------------------------------------------------------------

/** Only `implement` may receive a writable sandbox in v1. */
export const WRITER_PROFILE_IDS: readonly AgentProfileId[] = ['implement'];

export function isWriterProfile(profile: AgentProfileId): boolean {
  return WRITER_PROFILE_IDS.includes(profile);
}

/**
 * v1 concurrency rule. Enforcement (persisted, restart-safe) begins in A2;
 * the contract is fixed here so A2 cannot weaken it silently.
 */
export const AGENT_WRITER_POLICY_V1 = {
  maxActiveGlobalWriterJobs: 1,
  maxActiveWriterJobsPerProject: 1,
} as const;

// ---------------------------------------------------------------------------
// Network / retention / model class
// ---------------------------------------------------------------------------

/**
 * v1 runner egress semantics. `unrestricted` is deliberately NOT an ordinary
 * option. `backend-only` means: only the backend provider's own API endpoints,
 * resolved by trusted configuration in A3. Tailscale control (`tailscale
 * serve`/`funnel`/ACLs) is host infrastructure and is never part of the agent
 * capability plane.
 */
export const AGENT_NETWORK_POLICIES = ['deny', 'backend-only'] as const;
export type AgentNetworkPolicy = (typeof AGENT_NETWORK_POLICIES)[number];

/** Evidence/sandbox retention classes. Lifecycle enforcement begins A2/A3. */
export const AGENT_RETENTION_CLASSES = ['ephemeral', 'short', 'audit'] as const;
export type AgentRetentionClass = (typeof AGENT_RETENTION_CLASSES)[number];

/**
 * Authoritative retention duration mapping (Phase A6). Product policy — NOT
 * operator configuration. Operators select retention classes in resource
 * policies; the duration mapping is fixed by the bridge implementation and
 * may not be overridden via agents.yaml or any runtime config.
 *
 * This map is consulted ONLY at job creation time to snapshot the duration
 * per-job. Historical GC MUST use the persisted per-job retention_duration_ms,
 * never this map — so future changes to these values affect only NEW jobs.
 *
 * Values:
 *   ephemeral =  24 hours  (86,400,000 ms)
 *   short     =  14 days   (1,209,600,000 ms)
 *   audit     = 180 days   (15,552,000,000 ms)
 */
export const AGENT_RETENTION_DURATION_MS: Record<AgentRetentionClass, number> = {
  ephemeral: 86_400_000,       // 24 * 60 * 60 * 1000
  short:     1_209_600_000,    // 14 * 24 * 60 * 60 * 1000
  audit:     15_552_000_000,   // 180 * 24 * 60 * 60 * 1000
};

/**
 * Provider-neutral model tier. Backend adapters (A4/A7) map a class to a
 * concrete pinned model; callers never name provider models directly.
 */
export const AGENT_MODEL_CLASSES = ['fast', 'standard', 'deep'] as const;
export type AgentModelClass = (typeof AGENT_MODEL_CLASSES)[number];

// ---------------------------------------------------------------------------
// Resource policy
// ---------------------------------------------------------------------------

/**
 * Deterministic, integer-unit resource limits. CPU is millicores (1000 =
 * one CPU) to avoid float ambiguity. `maxProviderCredits` is in
 * provider-specific units and is only meaningful where the backend exposes a
 * controllable limit — Kiro credits and Copilot credits are NOT economically
 * comparable, and no dollar estimate is derived from them.
 */
export interface AgentResourceLimits {
  modelClass: AgentModelClass;
  maxRuntimeMs: number;
  maxCpuMillicores: number;
  maxMemoryBytes: number;
  maxPids: number;
  maxOutputBytes: number;
  maxEvidenceBytes: number;
  maxProviderCredits?: number;
  networkPolicy: AgentNetworkPolicy;
  retentionClass: AgentRetentionClass;
}

export interface AgentResourcePolicy extends AgentResourceLimits {
  id: ResourcePolicyId;
}

// ---------------------------------------------------------------------------
// Profiles (enforcement policy, not prompt templates)
// ---------------------------------------------------------------------------

export type AgentWorkspaceAccess = 'read-only' | 'sandbox-write';
export type AgentShellPolicy = 'none' | 'read-only' | 'validation';
export type AgentGitPolicy = 'none' | 'read' | 'sandbox';

/**
 * Specification consumed by A3+ container enforcement. A1 does not pretend
 * the OS/container layer enforces this yet.
 */
export interface AgentProfilePolicy {
  id: AgentProfileId;
  workspaceAccess: AgentWorkspaceAccess;
  shellPolicy: AgentShellPolicy;
  gitPolicy: AgentGitPolicy;
  networkPolicy: AgentNetworkPolicy;
  defaultResourcePolicy: ResourcePolicyId;
}

// ---------------------------------------------------------------------------
// Job / result / evidence records
// ---------------------------------------------------------------------------

export interface AgentJob {
  jobId: AgentJobId;
  principalId: string;
  backend: AgentBackendId;
  project: AgentProjectId;
  profile: AgentProfileId;
  resourcePolicy: ResourcePolicyId;
  status: AgentJobStatus;
  /** Set iff status is a failure status; mirrors it for persistence queries. */
  failureCode?: AgentFailureCode;
  createdAt: string; // ISO 8601
  startedAt?: string;
  completedAt?: string;
  dispositionAt?: string;
  /** sha256 hex of the dispatched prompt (identity/audit; raw prompt retention is a separate policy). */
  promptHash: string;
  baseCommit?: string;
  /** Whether this job counts against the writer policy (derived from profile). */
  writer: boolean;
}

/** Reference to locally stored evidence — retrieved on demand, never dumped. */
export interface AgentEvidenceRef {
  kind: 'diff' | 'result' | 'transcript' | 'log';
  sha256: string;
  bytes: number;
}

/**
 * Optional provider usage evidence. `usageAvailable: false` is a first-class
 * honest answer — metrics are never fabricated as zeros.
 */
export interface AgentUsage {
  usageAvailable: boolean;
  backend?: AgentBackendId;
  model?: string;
  providerCredits?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Locally measured job telemetry. Types only in A1; collection begins A3+. */
export interface AgentResourceTelemetry {
  runtimeMs?: number;
  peakCpuMillicores?: number;
  peakMemoryBytes?: number;
  sandboxBytes?: number;
  storedEvidenceBytes?: number;
  outputBytes?: number;
  peakProcessCount?: number;
}

/**
 * Concise normalized result. Large evidence (transcript, full logs, full
 * diff) stays local and is referenced via AgentEvidenceRef — there is
 * deliberately no unbounded raw transcript field.
 */
export interface AgentResult {
  jobId: AgentJobId;
  status: AgentJobStatus;
  backend: AgentBackendId;
  project: AgentProjectId;
  profile: AgentProfileId;
  summary: string;
  exitCode?: number | null;
  changedFiles?: string[];
  baseCommit?: string;
  /** sha256 hex of the full machine-derived diff. */
  diffHash?: string;
  evidence?: AgentEvidenceRef[];
  usage?: AgentUsage;
  telemetry?: AgentResourceTelemetry;
}

/**
 * One bounded chunk of the machine-derived diff (selective retrieval).
 *
 * A6-B4: the review surface is derived ONLY from the immutable canonical B3
 * artifact. `diffHash` is the verified artifactHash (the sole approval
 * identity — there is deliberately no second approval hash). The optional
 * verified canonical metadata fields are populated only on the first chunk
 * (absent cursor or a validated cursor at byte offset 0); they are read back
 * from the VERIFIED artifact manifest, never copied blindly from SQLite.
 */
export interface AgentDiff {
  jobId: AgentJobId;
  /** sha256 hex of the FULL diff identity == verified artifactHash. */
  diffHash: string;
  /** Optional single-file selection (workspace-relative). */
  path?: string;
  chunk: string;
  chunkBytes: number;
  totalBytes: number;
  truncated: boolean;
  /** Opaque continuation token when truncated. */
  cursor?: string;

  // First-chunk verified canonical metadata (A6-B4). Optional because it is
  // only carried on the first chunk; never an unbounded structured changes[].
  artifactHash?: string;
  changeSetHash?: string;
  baseCommit?: string;
  contentComplete?: boolean;
  applicable?: boolean;
  reason?: string | null;
  opCount?: number;
  artifactBytes?: number;
}
