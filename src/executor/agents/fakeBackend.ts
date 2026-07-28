/**
 * Deterministic fake agent backend (Phase A2).
 *
 * Pure local test/orchestration implementation. It NEVER:
 * - invokes a shell, Docker, HTTP, or any cloud/AI provider;
 * - starts Kiro or Copilot;
 * - reads or modifies project source.
 *
 * It only sleeps for deterministic bounded durations and returns a
 * deterministic result, so the durable job engine can be proven before any
 * real runner exists (A3+). Behavior variation (failure/delay) is selected by
 * dependency injection ONLY — never by caller-controlled MCP fields.
 */
export interface FakeBackendOptions {
  prepareMs?: number;
  runMs?: number;
  validateMs?: number;
  /** Inject a deterministic failure in the named phase (tests only). */
  failAt?: 'prepare' | 'run' | 'validate';
  failureMessage?: string;
}

export interface FakeBackendJobInput {
  jobId: string;
  backend: string;
  project: string;
  profile: string;
  /** Trusted resource policy runtime bound (ms). */
  maxRuntimeMs: number;
}

export interface FakeBackendResult {
  summary: string;
  exitCode: number;
}

class FakeAgentFailure extends Error {}

/** Abort-aware sleep. Rejects with the abort reason when signalled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeAgentBackend {
  private readonly opts: Required<Pick<FakeBackendOptions, 'prepareMs' | 'validateMs'>> & FakeBackendOptions;

  constructor(job: FakeBackendJobInput, opts: FakeBackendOptions = {}) {
    // Deterministic production defaults: total ~1.5–2 s so the asynchronous
    // lifecycle is observable (and cancellable) without long waits, always
    // well inside the trusted maxRuntimeMs.
    this.opts = {
      prepareMs: opts.prepareMs ?? 25,
      runMs: opts.runMs ?? Math.min(1500, Math.max(1, Math.floor(job.maxRuntimeMs / 4))),
      validateMs: opts.validateMs ?? 25,
      failAt: opts.failAt,
      failureMessage: opts.failureMessage,
    };
    this.job = job;
  }

  private readonly job: FakeBackendJobInput;

  isAgentFailure(e: unknown): boolean {
    return e instanceof FakeAgentFailure;
  }

  private async phase(name: 'prepare' | 'run' | 'validate', ms: number, signal: AbortSignal): Promise<void> {
    await sleep(ms, signal);
    if (this.opts.failAt === name) {
      throw new FakeAgentFailure(this.opts.failureMessage ?? `fake backend failed deterministically in ${name}`);
    }
  }

  prepare(signal: AbortSignal): Promise<void> {
    return this.phase('prepare', this.opts.prepareMs, signal);
  }

  run(signal: AbortSignal): Promise<void> {
    return this.phase('run', this.opts.runMs ?? 0, signal);
  }

  async validate(signal: AbortSignal): Promise<FakeBackendResult> {
    await this.phase('validate', this.opts.validateMs, signal);
    // Honest deterministic result: the fake backend did no real work, changed
    // no files, and used no provider resources.
    return {
      summary: `Fake backend completed successfully (job ${this.job.jobId}, backend ${this.job.backend}, project ${this.job.project}, profile ${this.job.profile}). No files were changed; no provider was invoked.`,
      exitCode: 0,
    };
  }
}
