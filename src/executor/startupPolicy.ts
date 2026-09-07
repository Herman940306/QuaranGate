/**
 * Pure executor startup policy resolution.
 *
 * Keeps provider enablement and trusted environment requirements in the same
 * production path used to decide which real backend factories are wired.
 */
import { parseImageRef } from '../shared/imageRef.js';

export const APPROVED_OLLAMA_LOCAL_HOST = 'http://ollama:11434';

const O1_MODEL_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const O1_MODEL_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function isStrictOllamaModelName(value: string): boolean {
  if (!value || value.length > 255 || value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    return false;
  }

  return value.split('/').every((component) => O1_MODEL_COMPONENT.test(component));
}

function describeOllamaModelQualifierProblem(value: string): string | null {
  if (!value || /\s/.test(value) || value.includes('@')) {
    return 'must use an explicit non-latest tag (implicit latest is not allowed)';
  }
  const colon = value.lastIndexOf(':');
  if (colon <= 0 || colon === value.length - 1) {
    return 'must use an explicit non-latest tag (implicit latest is not allowed)';
  }
  const modelName = value.slice(0, colon);
  const tag = value.slice(colon + 1);
  if (!isStrictOllamaModelName(modelName) || !O1_MODEL_TAG.test(tag)) {
    return 'must use an explicit non-latest tag (implicit latest is not allowed)';
  }
  if (tag.toLowerCase() === 'latest') {
    return ':latest tag not allowed for OLLAMA_MODEL_QUALIFIER';
  }
  return null;
}

/** Production O1 endpoint is the exact private Compose service URL only. */
export function isApprovedOllamaLocalHost(value: string): boolean {
  return value === APPROVED_OLLAMA_LOCAL_HOST;
}

function describeO1ImageReferenceProblem(value: string): string | null {
  const parsed = parseImageRef(value);

  switch (parsed.kind) {
    case 'explicit-tag':
      return parsed.tag !== null && parsed.tag.toLowerCase() === 'latest'
        ? 'uses the explicit :latest tag (refused)'
        : null;
    case 'digest':
      return parsed.digest !== null && /^sha256:[0-9a-f]{64}$/.test(parsed.digest)
        ? null
        : 'must use explicit non-latest tags or sha256 digests';
    case 'explicit-latest':
      return 'uses the explicit :latest tag (refused)';
    case 'implicit-latest':
    case 'malformed':
      return 'must use explicit non-latest tags or sha256 digests';
  }
}

/** Docker image must use an explicit non-latest tag or an immutable sha256 digest. */
export function isExplicitO1ImageReference(value: string): boolean {
  return describeO1ImageReferenceProblem(value) === null;
}

/** Ollama model selection must carry an explicit non-latest tag. */
export function isExplicitOllamaModelQualifier(value: string): boolean {
  return describeOllamaModelQualifierProblem(value) === null;
}

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
  if (!isApprovedOllamaLocalHost(host)) {
    throw new Error(`Ollama backend OLLAMA_HOST must be the approved local endpoint ${APPROVED_OLLAMA_LOCAL_HOST}`);
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
  const helperErr = describeO1ImageReferenceProblem(explicitHelperImage);
  if (helperErr) throw new Error(`AGENT_HELPER_IMAGE: image reference "${explicitHelperImage}" ${helperErr}`);
  const stagerErr = describeO1ImageReferenceProblem(stagerImage);
  if (stagerErr) throw new Error(`AGENT_STAGER_IMAGE: image reference "${stagerImage}" ${stagerErr}`);
  const modelErr = describeOllamaModelQualifierProblem(modelQualifier);
  if (modelErr) {
    throw new Error(modelErr);
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
