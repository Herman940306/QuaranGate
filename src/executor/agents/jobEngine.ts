/**
 * Executor-owned agent job engine (Phase A2).
 *
 * Owns dispatch validation against the TRUSTED agent configuration (defense
 * in depth — gateway grant checks are never assumed), durable state
 * transitions through the SQLite job store, serial execution of the
 * deterministic fake backend, cooperative cancellation, timeout enforcement
 * (maxRuntimeMs), and startup/shutdown reconciliation.
 *
 * The gateway is not job authority; it only authenticates, authorizes,
 * validates, delegates and audits.
 */
import { createHash, randomBytes } from 'node:crypto';
import { BridgeError } from '../../shared/errors.js';
import {
  MAX_AGENT_PROMPT_CHARS,
  AGENT_RETENTION_DURATION_MS,
  AGENT_RETENTION_CLASSES,
  type AgentJobStatus,
  type AgentResourcePolicy,
  type AgentRetentionClass,
} from '../../shared/agents.js';
import type { AgentControlPlaneConfig } from '../agentConfig.js';
import { AgentJobStore, type AgentJobRow } from './jobStore.js';
import { FakeAgentBackend, type FakeBackendOptions } from './fakeBackend.js';
import { verifyCanonicalArtifact, type ReadonlyEvidenceSource } from './artifactReader.js';
import { renderDiffPage, type DiffPageResult } from './diffRenderer.js';
import { runApplyAttempt, type ApplierIO, type ApplyAttemptSuccess } from './applyEngine.js';

/**
 * B3 artifact result returned by a backend that constructed a canonical
 * artifact. The engine uses this to drive atomic publication.
 */
export interface ArtifactResult {
  artifactHash: string;
  changeSetHash: string;
  contentComplete: boolean;
  applicable: boolean;
  reason: string | null;
  artifactVolume: string;
  artifactBytes: number;
  opCount: number;
}

/**
 * Generic backend interface. Both FakeAgentBackend and KiroBackend implement
 * this contract. The job engine uses it to drive the lifecycle.
 */
export interface AgentBackendAdapter {
  prepare(signal: AbortSignal): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  validate(signal: AbortSignal): Promise<{
    summary: string;
    exitCode: number;
    /**
     * Trusted source base commit of the staged workspace (A3+). When present
     * the engine persists it as job provenance. Set once; never re-inferred.
     */
    baseCommit?: string | null;
    /** Deterministic changed-path evidence (A5 implement jobs). */
    changedFiles?: string[];
    /** B3 canonical artifact result (real Kiro writer jobs only). */
    artifactResult?: ArtifactResult;
  }>;
  isAgentFailure(e: unknown): boolean;
  /**
   * Trusted dry-run indicator (A6-B3 trust-gate remediation). Reports the
   * TRUSTED CONFIGURATION the backend was constructed with (e.g. the
   * production-execution-gate flag threaded into KiroBackendOptions at
   * executor startup) — an adapter-identity fact set at construction time,
   * never derived from model/agent behavior, tool-call outcomes, or any
   * other execution RESULT (never inferred from validate()'s baseCommit or
   * writeMode). FakeAgentBackend always reports false (it never dry-runs).
   * The engine's artifact-requirement decision depends on this value and
   * must never fall back to inferring dry-run from execution results.
   */
  isDryRun(): boolean;
  /** Cleanup resources on failure/cancellation (best-effort). */
  cleanup?(): Promise<void>;
}

export interface DispatchRequest {
  principal: string;
  backend: string;
  project: string;
  profile: string;
  prompt: string;
  resourcePolicy?: string;
  sessionPolicy?: 'new' | 'resume';
}

/** A6-B4 review request. path/cursor/maxBytes are bounded caller inputs. */
export interface DiffRequest {
  jobId: string;
  principal: string;
  path?: string;
  cursor?: string;
  maxBytes?: number;
}

/**
 * A6-B4 reviewable job statuses. Explicit allowlist (§12): only a job that has
 * finished executing (COMPLETED) or reached a disposition (APPLIED/DISCARDED)
 * AND whose artifact_state is AVAILABLE is reviewable. Every other status
 * (QUEUED, PREPARING, RUNNING, VALIDATING, any FAILED_ code, CANCELLED) is not.
 */
const REVIEWABLE_JOB_STATUSES: ReadonlySet<AgentJobStatus> = new Set<AgentJobStatus>([
  'COMPLETED', 'APPLIED', 'DISCARDED',
]);

/**
 * A6-B4 factory for a trusted read-only evidence source. Injected so the
 * engine never imports Docker directly for review and tests can supply an
 * in-memory source. The volume comes ONLY from AgentJobRow.artifactVolume.
 */
export type EvidenceReaderFactory = (volume: string, jobId: string) => ReadonlyEvidenceSource;

type AbortCause = 'cancel' | 'timeout' | 'shutdown';

interface ActiveExecution {
  controller: AbortController;
  cause?: AbortCause;
}

function log(msg: string, fields: Record<string, unknown>): void {
  // Never include prompt text or credentials here.
  console.log(JSON.stringify({ level: 'info', msg, ...fields }));
}

/** Authorization/policy BridgeError codes → a deliberate policy denial. */
const POLICY_ERROR_CODES: ReadonlySet<string> = new Set([
  'FORBIDDEN_PROFILE', 'FORBIDDEN_BACKEND', 'FORBIDDEN_POLICY',
  'FORBIDDEN_PROJECT', 'FORBIDDEN_JOB', 'FORBIDDEN_SCOPE',
]);

// ---------------------------------------------------------------------------
// Artifact-required predicate (A6-B3)
// ---------------------------------------------------------------------------

/**
 * Single trusted predicate: does this job require canonical B3 artifact
 * publication before it can reach COMPLETED?
 *
 * True IFF:
 *   - backend == 'kiro' (real Kiro ACP execution — trusted dispatch state,
 *     `AgentJobRow.backend`, set once at dispatch() and never caller-revised)
 *   - writer == true (mutation-capable sandbox — trusted dispatch state,
 *     `AgentJobRow.writer`, derived ONLY from the trusted profile contract
 *     at dispatch(), never from the prompt or from any execution result)
 *   - dryRun == false — a TRUSTED CONSTRUCTION-TIME fact reported by the
 *     backend adapter itself via {@link AgentBackendAdapter.isDryRun}. This
 *     traces back to the executor's own startup configuration
 *     (`AGENT_KIRO_DRY_RUN` -> `KIRO_DRY_RUN` -> `KiroBackendOptions.dryRun`
 *     -> `KiroBackend.isDryRun()`, wired in src/executor/index.ts and
 *     src/executor/agents/kiroFactory.ts) — NEVER from any backend-returned
 *     execution RESULT (result.baseCommit, result.writeMode, or any ACP
 *     turn/tool-call outcome). FakeAgentBackend.isDryRun() always returns
 *     false.
 *
 * This predicate governs:
 *   1. Whether B3 construction is required
 *   2. Whether JobEngine requires an ArtifactResult from validate()
 *   3. Whether COMPLETED requires AVAILABLE artifact metadata
 *
 * It does NOT use backend-returned result.baseCommit or result.writeMode as
 * authority, and it never falls back to inferring dry-run from either.
 * Read-only jobs, dry-run writer jobs, and fake backend jobs are unaffected.
 */
export function artifactRequired(job: AgentJobRow, dryRun: boolean): boolean {
  return job.backend === 'kiro' && job.writer === true && !dryRun;
}

/**
 * Map a non-cancel/non-timeout execution error onto the canonical failure
 * taxonomy. A deliberate profile/backend prohibition (e.g. the A4 read-only
 * backend refusing `implement`) is a POLICY failure, NOT infrastructure. A
 * failed trusted precondition (e.g. dirty staging source) is a PRECONDITION
 * failure. A genuine agent-execution error is FAILED_AGENT. Everything else is
 * infrastructure.
 */
function classifyExecutionFailure(
  e: unknown,
  backend: AgentBackendAdapter | null,
): 'FAILED_POLICY' | 'FAILED_PRECONDITION' | 'FAILED_AGENT' | 'FAILED_INFRASTRUCTURE' {
  if (e instanceof BridgeError) {
    if (POLICY_ERROR_CODES.has(e.code)) return 'FAILED_POLICY';
    if (e.code === 'PRECONDITION_FAILED') return 'FAILED_PRECONDITION';
  }
  if (backend?.isAgentFailure(e) ?? false) return 'FAILED_AGENT';
  return 'FAILED_INFRASTRUCTURE';
}

export class AgentJobEngine {
  private active = new Map<string, ActiveExecution>();
  private processing = false;
  private stopped = false;

  constructor(
    private readonly store: AgentJobStore,
    private readonly config: AgentControlPlaneConfig,
    /** Test seam: inject deterministic fake behaviors. Production uses defaults. */
    private readonly backendOptions: (job: AgentJobRow) => FakeBackendOptions = () => ({}),
    /**
     * Backend factory (A4+). If provided, the engine uses this to create the
     * backend adapter for a job. If it returns null, falls back to FakeAgentBackend.
     */
    private readonly backendFactory?: (job: AgentJobRow, policy: AgentResourcePolicy) => AgentBackendAdapter | null,
    /**
     * A6-B4 trusted evidence reader factory. Absent in fake-only deployments
     * (no real artifacts are ever AVAILABLE there, so agent_diff fails closed
     * with ARTIFACT_NOT_AVAILABLE before a reader would be needed).
     */
    private readonly evidenceReaderFactory?: EvidenceReaderFactory,
    /**
     * A6-B5: trusted applier image (same non-caller-selectable image family
     * as the A3 sandbox/A4 Kiro runner — see PHASE_A6_B5_AGENT_APPLY.md §9)
     * and the injectable Docker seam for the applier lifecycle. Both absent
     * in fake-only deployments — agent_apply then fails closed with
     * SANDBOX_FAILED before any admission occurs.
     */
    private readonly applierImage?: string,
    private readonly applierIO?: ApplierIO,
  ) {}

  /** Startup reconciliation per the documented A2 policy (fail closed). */
  recover(): string[] {
    const recovered = this.store.recoverActive('executor restarted during active fake execution');
    for (const id of recovered) log('agent job recovered as FAILED_INFRASTRUCTURE', { jobId: id });
    this.kick();
    return recovered;
  }

  listBackends(): { id: string; available: boolean; profiles: string[] }[] {
    return this.config.backends.map((b) => ({ id: b.id, available: b.enabled, profiles: [...b.profiles] }));
  }

  listProjects(): { id: string; gitRequired: boolean; allowedBackends: string[]; allowedProfiles: string[] }[] {
    return this.config.projects.map((p) => ({
      id: p.id,
      gitRequired: p.gitRequired,
      allowedBackends: [...p.backends],
      allowedProfiles: [...p.profiles],
    }));
  }

  private resolvePolicy(id: string): AgentResourcePolicy {
    const rp = this.config.resourcePolicies.find((r) => r.id === id);
    if (!rp) throw new BridgeError('MALFORMED_REQUEST', `unknown resource policy ${id}`, 400);
    return rp;
  }

  /**
   * Validate a dispatch against the trusted configuration and enqueue it.
   * Nothing here trusts gateway-side validation.
   */
  dispatch(req: DispatchRequest): AgentJobRow {
    if (req.sessionPolicy === 'resume') {
      throw new BridgeError('MALFORMED_REQUEST', 'sessionPolicy "resume" is not supported until phase A8; use "new"', 400);
    }
    if (typeof req.prompt !== 'string' || req.prompt.length < 1 || req.prompt.length > MAX_AGENT_PROMPT_CHARS) {
      throw new BridgeError('MALFORMED_REQUEST', `prompt must be 1..${MAX_AGENT_PROMPT_CHARS} chars`, 400);
    }
    const project = this.config.projects.find((p) => p.id === req.project);
    if (!project) throw new BridgeError('UNKNOWN_PROJECT', `unknown project ${req.project}`, 404);
    const backend = this.config.backends.find((b) => b.id === req.backend);
    if (!backend) throw new BridgeError('FORBIDDEN_BACKEND', `unknown backend ${req.backend}`, 403);
    if (!backend.enabled) throw new BridgeError('FORBIDDEN_BACKEND', `backend ${req.backend} is disabled`, 403);
    if (!project.backends.includes(backend.id)) {
      throw new BridgeError('FORBIDDEN_BACKEND', `backend ${req.backend} not allowed for project ${req.project}`, 403);
    }
    const profile = this.config.profiles.find((p) => p.id === req.profile);
    if (!profile) throw new BridgeError('FORBIDDEN_PROFILE', `unknown profile ${req.profile}`, 403);
    if (!project.profiles.includes(profile.id)) {
      throw new BridgeError('FORBIDDEN_PROFILE', `profile ${req.profile} not allowed for project ${req.project}`, 403);
    }
    if (!backend.profiles.includes(profile.id)) {
      throw new BridgeError('FORBIDDEN_PROFILE', `profile ${req.profile} not supported by backend ${req.backend}`, 403);
    }
    const policyId = req.resourcePolicy ?? profile.defaultResourcePolicy;
    const policy = this.resolvePolicy(policyId);

    // Snapshot the immutable retention policy at dispatch time.
    // retentionClass comes from the trusted resource policy; retentionDurationMs
    // is resolved ONCE here from AGENT_RETENTION_DURATION_MS and persisted.
    // Historical GC MUST use the persisted retentionDurationMs — never re-resolve.
    const retentionClass: AgentRetentionClass = policy.retentionClass;
    if (!(AGENT_RETENTION_CLASSES as readonly string[]).includes(retentionClass)) {
      throw new BridgeError('MALFORMED_REQUEST', `resource policy ${policyId} has invalid retentionClass: ${String(retentionClass)}`, 400);
    }
    const retentionDurationMs = AGENT_RETENTION_DURATION_MS[retentionClass];
    if (!Number.isSafeInteger(retentionDurationMs) || retentionDurationMs <= 0) {
      throw new BridgeError('MALFORMED_REQUEST', `AGENT_RETENTION_DURATION_MS[${retentionClass}] is not a valid positive integer`, 500);
    }

    const job = this.store.insert({
      jobId: `job_${randomBytes(16).toString('hex')}`,
      principalId: req.principal,
      backend: backend.id,
      project: project.id,
      profile: profile.id,
      resourcePolicy: policyId,
      promptHash: createHash('sha256').update(req.prompt, 'utf8').digest('hex'),
      prompt: req.prompt,
      sessionPolicy: req.sessionPolicy ?? 'new',
      // Writer classification comes from the trusted profile contract only.
      writer: profile.workspaceAccess === 'sandbox-write',
      retentionClass,
      retentionDurationMs,
    });
    log('agent job queued', { jobId: job.jobId, principal: job.principalId, backend: job.backend, project: job.project, profile: job.profile, writer: job.writer });
    this.kick();
    return job;
  }

  getOwnedJob(jobId: string, principal: string): AgentJobRow {
    const job = this.store.get(jobId);
    if (!job) throw new BridgeError('UNKNOWN_JOB', `unknown job ${jobId}`, 404);
    if (job.principalId !== principal) {
      throw new BridgeError('FORBIDDEN_JOB', `job ${jobId} is not owned by client ${principal}`, 403);
    }
    return job;
  }

  /**
   * A6-B4: read-only canonical review of an owned job's artifact.
   *
   * Option D executor defense-in-depth (per-principal grant enforcement stays
   * at the gateway; this executor path is independent of clients.yaml):
   *   1. job exists                              (else UNKNOWN_JOB)
   *   2. requesting principal owns the job       (else FORBIDDEN_JOB)
   *   3. project comes ONLY from AgentJobRow.project (never caller input) and
   *      must still exist in the trusted registry (else FORBIDDEN_PROJECT)
   *   4. job is reviewable AND its artifact is AVAILABLE (else ARTIFACT_NOT_AVAILABLE)
   * Then the full B3 identity chain is verified from the trusted evidence
   * volume and the deterministic renderer produces a bounded page. Non-mutating.
   */
  async diff(req: DiffRequest): Promise<DiffPageResult> {
    const job = this.getOwnedJob(req.jobId, req.principal);

    // Option D: project identity is the trusted job row's project; it must
    // still be a currently-configured trusted project. Caller can never
    // substitute a project id here (there is no caller project field).
    const project = this.config.projects.find((p) => p.id === job.project);
    if (!project) {
      throw new BridgeError('FORBIDDEN_PROJECT', `project ${job.project} is not in the trusted registry`, 403);
    }

    // Reviewable status + AVAILABLE artifact guard (fail closed to a single code).
    if (
      !REVIEWABLE_JOB_STATUSES.has(job.status) ||
      job.artifactState !== 'AVAILABLE' ||
      !job.artifactHash ||
      !job.artifactVolume
    ) {
      throw new BridgeError('ARTIFACT_NOT_AVAILABLE', `job ${req.jobId} has no reviewable canonical artifact`, 404);
    }

    if (!this.evidenceReaderFactory) {
      throw new BridgeError('ARTIFACT_STORAGE_INTEGRITY_FAILED', 'no trusted evidence reader is configured', 500);
    }

    const source = this.evidenceReaderFactory(job.artifactVolume, job.jobId);
    try {
      const verified = await verifyCanonicalArtifact(source, {
        jobId: job.jobId,
        principalId: job.principalId,
        projectId: job.project,
        backend: job.backend,
        profile: job.profile,
        expectedArtifactHash: job.artifactHash,
        baseCommit: job.baseCommit,
        changeSetHash: job.changeSetHash,
        contentComplete: job.artifactContentComplete,
        applicable: job.artifactApplicable,
        reason: job.artifactReason,
        opCount: job.artifactOpCount,
        artifactBytes: job.artifactBytes,
      });
      return renderDiffPage(verified, {
        jobId: job.jobId,
        path: req.path,
        cursor: req.cursor,
        maxBytes: req.maxBytes,
      });
    } finally {
      if (source.close) await source.close().catch(() => {});
    }
  }

  /**
   * A6-B5: apply an owned, COMPLETED job's verified artifact to its
   * registered real project. Delegates the full flow (admission, artifact
   * re-verification, host preconditions, mutation, POST verification,
   * rollback/UNCERTAIN) to {@link runApplyAttempt} — this method only
   * resolves the trusted inputs runApplyAttempt needs (owned job, trusted
   * project, resource policy) and fails closed if the applier infrastructure
   * isn't configured, mirroring {@link diff}'s handling of a missing
   * evidence reader.
   */
  async apply(req: { jobId: string; principal: string }): Promise<ApplyAttemptSuccess> {
    const job = this.getOwnedJob(req.jobId, req.principal);

    const project = this.config.projects.find((p) => p.id === job.project);
    if (!project) {
      throw new BridgeError('FORBIDDEN_PROJECT', `project ${job.project} is not in the trusted registry`, 403);
    }
    if (!this.evidenceReaderFactory) {
      throw new BridgeError('ARTIFACT_STORAGE_INTEGRITY_FAILED', 'no trusted evidence reader is configured', 500);
    }
    if (!this.applierImage || !this.applierIO) {
      throw new BridgeError('SANDBOX_FAILED', 'no trusted applier is configured on this executor', 500);
    }

    const policy = this.resolvePolicy(job.resourcePolicy);
    return runApplyAttempt(
      { store: this.store, evidenceReaderFactory: this.evidenceReaderFactory, applierImage: this.applierImage, applierIO: this.applierIO },
      job,
      project,
      policy,
    );
  }

  /**
   * A6-B6: discard an owned, COMPLETED job — a durable logical disposition
   * change only (PHASE_A6_B6_AGENT_DISCARD.md §11: no Docker I/O, no
   * artifact read, no project filesystem access, no cleanup/retention
   * operation — there is no physical sandbox left to remove by the time a
   * job reaches COMPLETED). `store.discardJob(jobId)` is called exactly
   * once and is the sole mutating call; its `false` return (job was not
   * COMPLETED — already DISCARDED, already APPLIED, still active, or
   * failed/cancelled) is never retried and never treated as success.
   */
  discard(jobId: string, principal: string): AgentJobRow {
    const job = this.getOwnedJob(jobId, principal);
    const ok = this.store.discardJob(job.jobId);
    if (!ok) {
      const current = this.store.get(job.jobId)!;
      throw new BridgeError(
        'PRECONDITION_FAILED',
        `job ${jobId} is ${current.status}, not COMPLETED; discard may only be performed on a COMPLETED job`,
        409,
      );
    }
    return this.store.get(job.jobId)!;
  }

  /**
   * Cancel a job the principal owns. QUEUED jobs cancel directly; active jobs
   * are CAS-transitioned to CANCELLED and then cooperatively aborted.
   * Terminal jobs return their current status unchanged.
   */
  cancel(jobId: string, principal: string): AgentJobRow {
    let job = this.getOwnedJob(jobId, principal);
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = job.status;
      if (s !== 'QUEUED' && s !== 'PREPARING' && s !== 'RUNNING' && s !== 'VALIDATING') {
        return job; // terminal — nothing to cancel
      }
      const ok = this.store.transition(jobId, s, 'CANCELLED', {
        completedAt: new Date().toISOString(),
        failureCode: 'CANCELLED',
        failureReason: 'cancelled by owner',
      });
      if (ok) {
        const exec = this.active.get(jobId);
        if (exec) { exec.cause = 'cancel'; exec.controller.abort(new Error('cancelled by owner')); }
        log('agent job cancelled', { jobId, principal });
        this.kick();
        return this.store.get(jobId)!;
      }
      job = this.getOwnedJob(jobId, principal); // raced — re-read and retry
    }
    return job;
  }

  /** Start queue processing if idle. */
  kick(): void {
    if (this.processing || this.stopped) return;
    void this.processLoop();
  }

  private async processLoop(): Promise<void> {
    this.processing = true;
    try {
      while (!this.stopped) {
        const job = this.store.claimNext();
        if (!job) break;
        await this.execute(job);
      }
    } catch (e) {
      log('agent engine loop error', { error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    } finally {
      this.processing = false;
    }
    if (!this.stopped && this.store.hasQueued() && this.store.countActive() === 0) this.kick();
  }

  private async execute(job: AgentJobRow): Promise<void> {
    const policy = this.resolvePolicy(job.resourcePolicy);
    const exec: ActiveExecution = { controller: new AbortController() };
    this.active.set(job.jobId, exec);
    const timeout = setTimeout(() => {
      exec.cause = 'timeout';
      exec.controller.abort(new Error(`exceeded maxRuntimeMs ${policy.maxRuntimeMs}`));
    }, policy.maxRuntimeMs);

    // Backend construction can legitimately FAIL CLOSED (e.g. the Kiro backend
    // denies a write profile). Construct inside the guarded block so such a
    // denial fails the job rather than leaving it stuck in PREPARING.
    let backend: AgentBackendAdapter | null = null;

    const step = (from: AgentJobStatus, to: AgentJobStatus, extras = {}): void => {
      if (!this.store.transition(job.jobId, from, to, extras)) {
        // A concurrent transition (cancellation) won — stop this execution.
        throw exec.controller.signal.reason ?? new Error('superseded');
      }
      log('agent job transition', { jobId: job.jobId, from, to });
    };

    try {
      // Select backend: factory (A4 real Kiro) or fallback (A2 fake).
      backend = this.backendFactory?.(job, policy) ?? new FakeAgentBackend(
        { jobId: job.jobId, backend: job.backend, project: job.project, profile: job.profile, maxRuntimeMs: policy.maxRuntimeMs },
        this.backendOptions(job),
      );
      // claimNext already moved QUEUED -> PREPARING.
      await backend.prepare(exec.controller.signal);
      step('PREPARING', 'RUNNING');
      await backend.run(exec.controller.signal);
      step('RUNNING', 'VALIDATING');
      const result = await backend.validate(exec.controller.signal);
      // Persist trusted provenance BEFORE completion. base_commit is set once
      // (independent of the status CAS) so it survives and is available to the
      // review/apply lifecycle (A6). Reaching COMPLETED is NOT an apply.
      if (result.baseCommit) {
        this.store.setBaseCommit(job.jobId, result.baseCommit);
        log('agent job base commit recorded', { jobId: job.jobId, changedFiles: result.changedFiles?.length ?? 0 });
      }

      // A6-B3: if this job requires a canonical artifact, validate() must have
      // produced one. Publish it atomically before COMPLETED transition.
      // Trust-gate remediation: dry-run status comes ONLY from the backend
      // adapter's own trusted construction-time flag (isDryRun()) — never
      // inferred from result.baseCommit or result.writeMode. A missing
      // baseCommit on a REQUIRED (non-dry-run) job is a hard failure below,
      // not a silent bypass of the artifact requirement.
      const required = artifactRequired(job, backend.isDryRun());
      if (required) {
        if (!result.baseCommit) {
          throw new BridgeError(
            'ARTIFACT_REQUIRED',
            `job ${job.jobId} is a real Kiro writer (non-dry-run) but validate() did not produce a baseCommit`,
            500,
          );
        }
        if (!result.artifactResult) {
          throw new BridgeError(
            'ARTIFACT_REQUIRED',
            `job ${job.jobId} is a real Kiro writer but validate() did not produce an artifact`,
            500,
          );
        }
        // Atomic publication via JobStore (CAS: artifact_state must be NULL)
        this.store.publishArtifact(job.jobId, result.artifactResult);
        log('agent job artifact published', {
          jobId: job.jobId,
          artifactHash: result.artifactResult.artifactHash,
          opCount: result.artifactResult.opCount,
          applicable: result.artifactResult.applicable,
        });
      }

      step('VALIDATING', 'COMPLETED', {
        completedAt: new Date().toISOString(),
        summary: result.summary,
        exitCode: result.exitCode,
      });
    } catch (e) {
      // Ensure cleanup on any failure path.
      if (backend?.cleanup) { await backend.cleanup().catch(() => {}); }
      this.failActive(job.jobId, exec, backend, e);
    } finally {
      clearTimeout(timeout);
      this.active.delete(job.jobId);
    }
  }

  /** Map an execution error onto the failure taxonomy and persist it (CAS). */
  private failActive(jobId: string, exec: ActiveExecution, backend: AgentBackendAdapter | null, e: unknown): void {
    const current = this.store.get(jobId);
    if (!current) return;
    const s = current.status;
    if (s !== 'PREPARING' && s !== 'RUNNING' && s !== 'VALIDATING') return; // already terminal (e.g. CANCELLED)
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    const failureCode = exec.cause === 'timeout' ? 'FAILED_TIMEOUT'
      : exec.cause === 'shutdown' ? 'FAILED_INFRASTRUCTURE'
      : exec.cause === 'cancel' ? 'CANCELLED'
      : classifyExecutionFailure(e, backend);
    if (failureCode === 'CANCELLED') return; // cancel() persists CANCELLED itself
    this.store.transition(jobId, s, failureCode, {
      completedAt: new Date().toISOString(),
      failureCode,
      failureReason: message,
    });
    log('agent job failed', { jobId, failureCode });
  }

  /** Graceful shutdown: stop claiming, abort active work, fail closed. */
  shutdown(): void {
    this.stopped = true;
    for (const [jobId, exec] of this.active) {
      exec.cause = 'shutdown';
      exec.controller.abort(new Error('executor shutdown during active fake execution'));
      const current = this.store.get(jobId);
      if (current && (current.status === 'PREPARING' || current.status === 'RUNNING' || current.status === 'VALIDATING')) {
        this.store.transition(jobId, current.status, 'FAILED_INFRASTRUCTURE', {
          completedAt: new Date().toISOString(),
          failureCode: 'FAILED_INFRASTRUCTURE',
          failureReason: 'executor shutdown during active fake execution',
        });
      }
    }
    this.active.clear();
  }
}
