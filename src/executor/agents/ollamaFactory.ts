/**
 * Production backend factory for the Ollama O1 read-only backend — Phase O1.
 *
 * Wires the governed {@link OllamaBackend} into {@link AgentJobEngine} without
 * the engine knowing Ollama specifics. The factory is the single trusted place
 * that selects the real Ollama backend ONLY for `backend === 'ollama'` (every
 * other backend falls back to deterministic fake or other real backend).
 *
 * Profiles are validated in {@link OllamaBackend}'s constructor: writer/implement
 * profiles are refused before inference. Read-only profiles (audit/plan/review)
 * are granted bounded read authority only.
 */
import { BridgeError } from '../../shared/errors.js';
import type { AgentProfileId, AgentResourcePolicy } from '../../shared/agents.js';
import type { AgentBackendAdapter } from './jobEngine.js';
import type { AgentJobRow } from './jobStore.js';
import type { AgentProjectConfig } from '../agentConfig.js';
import { OllamaBackend } from './ollamaBackend.js';

export interface OllamaFactoryDeps {
  ollamaHost: string;
  modelQualifier: string;
  /** Generic helper image for read-only workspace access. */
  helperImage: string;
  /** Stager image (same generic helper used for staging). */
  stagerImage: string;
  projects: AgentProjectConfig[];
  /** Injectable Ollama class for testing. */
  OllamaClass: typeof import('ollama').Ollama;
}

/**
 * Build the engine backend factory for Ollama O1. Returns null for non-ollama
 * backends so the engine uses its existing backend resolution (fake or other
 * real backend); returns a real {@link OllamaBackend} for ollama.
 */
export function createOllamaBackendFactory(
  deps: OllamaFactoryDeps,
): (job: AgentJobRow, policy: AgentResourcePolicy) => AgentBackendAdapter | null {
  const projectById = new Map(deps.projects.map((p) => [p.id, p]));

  return (job, policy) => {
    if (job.backend !== 'ollama') return null; // Not Ollama → use existing resolution

    const project = projectById.get(job.project);
    if (!project) {
      // Trusted config guarantees a dispatched project exists; fail closed.
      throw new BridgeError('UNKNOWN_PROJECT', `no trusted config for project ${job.project}`, 404);
    }

    return new OllamaBackend(
      {
        jobId: job.jobId,
        principalId: job.principalId,
        backend: 'ollama',
        project: job.project,
        profile: job.profile as AgentProfileId,
        prompt: job.prompt,
        hostPath: project.hostPath,
        policy,
      },
      {
        ollamaHost: deps.ollamaHost,
        modelQualifier: deps.modelQualifier,
        helperImage: deps.helperImage,
        stagerImage: deps.stagerImage,
        sensitiveReadGlobs: project.sensitiveReadGlobs,
        OllamaClass: deps.OllamaClass,
      },
    );
  };
}
