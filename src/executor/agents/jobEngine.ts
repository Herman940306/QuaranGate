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
  type AgentJobStatus,
  type AgentResourcePolicy,
} from '../../shared/agents.js';
import type { AgentControlPlaneConfig } from '../agentConfig.js';
import { AgentJobStore, type AgentJobRow } from './jobStore.js';
import { FakeAgentBackend, type FakeBackendOptions } from './fakeBackend.js';

export interface DispatchRequest {
  principal: string;
  backend: string;
  project: string;
  profile: string;
  prompt: string;
  resourcePolicy?: string;
  sessionPolicy?: 'new' | 'resume';
}

type AbortCause = 'cancel' | 'timeout' | 'shutdown';

interface ActiveExecution {
  controller: AbortController;
  cause?: AbortCause;
}

function log(msg: string, fields: Record<string, unknown>): void {
  // Never include prompt text or credentials here.
  console.log(JSON.stringify({ level: 'info', msg, ...fields }));
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
    this.resolvePolicy(policyId);

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

    const backend = new FakeAgentBackend(
      { jobId: job.jobId, backend: job.backend, project: job.project, profile: job.profile, maxRuntimeMs: policy.maxRuntimeMs },
      this.backendOptions(job),
    );

    const step = (from: AgentJobStatus, to: AgentJobStatus, extras = {}): void => {
      if (!this.store.transition(job.jobId, from, to, extras)) {
        // A concurrent transition (cancellation) won — stop this execution.
        throw exec.controller.signal.reason ?? new Error('superseded');
      }
      log('agent job transition', { jobId: job.jobId, from, to });
    };

    try {
      // claimNext already moved QUEUED -> PREPARING.
      await backend.prepare(exec.controller.signal);
      step('PREPARING', 'RUNNING');
      await backend.run(exec.controller.signal);
      step('RUNNING', 'VALIDATING');
      const result = await backend.validate(exec.controller.signal);
      step('VALIDATING', 'COMPLETED', {
        completedAt: new Date().toISOString(),
        summary: result.summary,
        exitCode: result.exitCode,
      });
    } catch (e) {
      this.failActive(job.jobId, exec, backend, e);
    } finally {
      clearTimeout(timeout);
      this.active.delete(job.jobId);
    }
  }

  /** Map an execution error onto the failure taxonomy and persist it (CAS). */
  private failActive(jobId: string, exec: ActiveExecution, backend: FakeAgentBackend, e: unknown): void {
    const current = this.store.get(jobId);
    if (!current) return;
    const s = current.status;
    if (s !== 'PREPARING' && s !== 'RUNNING' && s !== 'VALIDATING') return; // already terminal (e.g. CANCELLED)
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    const failureCode = exec.cause === 'timeout' ? 'FAILED_TIMEOUT'
      : exec.cause === 'shutdown' ? 'FAILED_INFRASTRUCTURE'
      : exec.cause === 'cancel' ? 'CANCELLED'
      : backend.isAgentFailure(e) ? 'FAILED_AGENT'
      : 'FAILED_INFRASTRUCTURE';
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
