/**
 * Pure executor startup policy resolution.
 *
 * Keeps provider enablement and trusted environment requirements in the same
 * production path used to decide which real backend factories are wired.
 */

export interface ExecutorStartupEnvironment {
  agentRunnerImage?: string;
  agentHelperImage?: string;
  ollamaHost?: string;
  ollamaModelQualifier?: string;
}

export interface EnabledOllamaStartupPolicy {
  enabled: true;
  host: string;
  modelQualifier: string;
  helperImage: string;
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
  if (modelQualifier.includes(':latest') || explicitHelperImage.includes(':latest')) {
    throw new Error(':latest tags not allowed for OLLAMA_MODEL_QUALIFIER or AGENT_HELPER_IMAGE');
  }

  return {
    ...policy,
    ollama: {
      enabled: true,
      host,
      modelQualifier,
      helperImage: explicitHelperImage,
    },
  };
}
