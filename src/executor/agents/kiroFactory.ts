/**
 * Production backend factory for the Kiro read-only backend — Phase A4.
 *
 * Wires the trusted {@link KiroBackend} into {@link AgentJobEngine} without the
 * engine knowing any Kiro specifics. The factory is the single trusted place
 * that:
 *   - selects the real Kiro backend ONLY for `backend === 'kiro'`
 *     (every other backend falls back to the deterministic fake), and
 *   - resolves the logical project id to its trusted host path (never from a
 *     caller), the concrete model, and the per-job resource policy.
 *
 * Profiles are NOT special-cased here: {@link KiroBackend}'s constructor calls
 * `assertKiroProfile` and resolves the trusted per-profile capability. As of
 * A5 the `implement` profile is accepted and granted a writable JOB SANDBOX
 * (read/grep/glob + fsWrite, mcp_impl_ identity); audit/plan/review remain
 * strictly read-only. Reaching COMPLETED is never an apply — the host project
 * is never modified (A6 owns review/apply/discard).
 */
import type { AgentProfileId, AgentResourcePolicy } from '../../shared/agents.js';
import type { AgentBackendAdapter } from './jobEngine.js';
import type { AgentJobRow } from './jobStore.js';
import { KiroBackend, resolveModel, type KiroBackendOptions } from './kiroBackend.js';
import { BridgeError } from '../../shared/errors.js';

export interface KiroFactoryDeps extends Omit<KiroBackendOptions, never> {}

export interface KiroFactoryProject {
  id: string;
  hostPath: string;
}

/**
 * Build the engine backend factory. Returns null for non-kiro backends so the
 * engine uses its fake backend; returns a real {@link KiroBackend} for kiro.
 */
export function createKiroBackendFactory(
  projects: KiroFactoryProject[],
  deps: KiroFactoryDeps,
): (job: AgentJobRow, policy: AgentResourcePolicy) => AgentBackendAdapter | null {
  const hostPathById = new Map(projects.map((p) => [p.id, p.hostPath]));
  return (job, policy) => {
    if (job.backend !== 'kiro') return null; // deterministic fake for everything else
    const hostPath = hostPathById.get(job.project);
    if (!hostPath) {
      // Trusted config guarantees a dispatched project exists; if not, fail
      // closed rather than silently running the fake backend for kiro.
      throw new BridgeError('UNKNOWN_PROJECT', `no trusted host path for project ${job.project}`, 404);
    }
    return new KiroBackend(
      {
        jobId: job.jobId,
        backend: 'kiro',
        project: job.project,
        profile: job.profile as AgentProfileId,
        prompt: job.prompt,
        hostPath,
        policy,
        model: resolveModel(policy.modelClass),
      },
      deps,
    );
  };
}
