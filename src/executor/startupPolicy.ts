/**
 * Pure executor startup policy resolution.
 *
 * Keeps provider enablement and trusted environment requirements in the same
 * production path used to decide which real backend factories are wired.
 */
import { validateImageRef } from '../shared/imageRef.js';

export interface ExecutorStartupEnvironment {
  agentRunnerImage?: string;
  agentHelperImage?: string;
  agentStagerImage?: string;
  ollamaHost?: string;
  ollamaModelQualifier?: string;
}

export interface EnabledOllamaStartupPolicy {
  enabled: true;
  host: string;
  modelQualifier: string;
  helperImage: string;
  stagerImage: string;
}

export type OllamaStartupPolicy =
  | { enabled: false }
  | EnabledOllamaStartupPolicy;

export interface ExecutorStartupPolicy {
  runnerImage: string;
  /** Kiro historically permits its runner image to serve as its helper. */
  kiroHelperImage: string;
  ollama: OllamaStartupPolicy;
}

export function resolveExecutorStartupPolicy(
  ollamaEnabled: boolean,
  env: ExecutorStartupEnvironment,
): ExecutorStartupPolicy {
  const runnerImage = env.agentRunnerImage ?? '';
  const explicitHelperImage = env.agentHelperImage ?? '';
  const stagerImage = env.agentStagerImage ?? '';
  const policy: ExecutorStartupPolicy = {
    runnerImage,
    kiroHelperImage: explicitHelperImage || runnerImage,
    ollama: { enabled: false },
  };

  if (!ollamaEnabled) return policy;

  const host = env.ollamaHost ?? '';
  const modelQualifier = env.ollamaModelQualifier ?? '';

  if (!host) {
    throw new Error('Ollama backend enabled but OLLAMA_HOST is not set');
  }
  if (!modelQualifier) {
    throw new Error('Ollama backend enabled but OLLAMA_MODEL_QUALIFIER is not set');
  }
  if (!explicitHelperImage) {
    throw new Error('Ollama backend enabled but AGENT_HELPER_IMAGE is not set');
  }
  if (!stagerImage) {
    throw new Error('Ollama backend enabled but AGENT_STAGER_IMAGE is not set');
  }
  // H1-1: Use central image reference validator — catches registry:port/repo
  // (implicit latest) as well as explicit :latest and malformed references.
  // The old includes(':latest') check missed the implicit-latest failure class.
  const helperErr = validateImageRef(explicitHelperImage);
  if (helperErr) throw new Error(`AGENT_HELPER_IMAGE: ${helperErr}`);
  const stagerErr = validateImageRef(stagerImage);
  if (stagerErr) throw new Error(`AGENT_STAGER_IMAGE: ${stagerErr}`);
  // modelQualifier is a model specifier, not a Docker image reference; it uses
  // a different but overlapping format (name:tag or name). We keep the old
  // exact-string check for it since it is NOT a Docker image reference.
  if (modelQualifier.includes(':latest')) {
    throw new Error(':latest tag not allowed for OLLAMA_MODEL_QUALIFIER');
  }

  return {
    ...policy,
    ollama: {
      enabled: true,
      host,
      modelQualifier,
      helperImage: explicitHelperImage,
      stagerImage,
    },
  };
}
