/** Pure, fail-closed A7 Copilot startup configuration. */
import type { AgentProfileId } from '../shared/agents.js';
import { validateImageRef } from '../shared/imageRef.js';

export const COPILOT_SUPPORTED_PROFILES: readonly AgentProfileId[] = ['audit', 'plan', 'review'];

export interface CopilotStartupEnvironment {
  runnerImage?: string;
  helperImage?: string;
  proxyImage?: string;
  credentialPath?: string;
  model?: string;
  egressHosts?: string;
  dryRun?: string;
}

export type CopilotStartupPolicy =
  | { enabled: false }
  | {
      enabled: true;
      runnerImage: string;
      helperImage: string;
      proxyImage: string;
      credentialPath: string;
      model: string;
      egressHosts: string[];
      dryRun: boolean;
    };

function requireValue(value: string | undefined, name: string): string {
  const clean = value?.trim() ?? '';
  if (!clean) throw new Error(`Copilot backend enabled but ${name} is not set`);
  return clean;
}

export function parseCopilotEgressHosts(value: string): string[] {
  const hosts = value.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0) throw new Error('AGENT_COPILOT_EGRESS_HOSTS must contain owner-approved exact hostnames');
  const unique = [...new Set(hosts)];
  for (const host of unique) {
    if (host.includes('*') || host.includes('/') || host.includes(':')
      || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host)
      || host.includes('..') || !host.includes('.')) {
      throw new Error(`AGENT_COPILOT_EGRESS_HOSTS contains invalid exact hostname: ${host}`);
    }
  }
  return unique;
}

export function assertCopilotProfiles(profiles: readonly AgentProfileId[]): void {
  for (const profile of profiles) {
    if (!COPILOT_SUPPORTED_PROFILES.includes(profile)) {
      throw new Error(`Copilot backend does not support profile ${profile}; supported: ${COPILOT_SUPPORTED_PROFILES.join(', ')}`);
    }
  }
}

export function resolveCopilotStartupPolicy(
  enabled: boolean,
  profiles: readonly AgentProfileId[],
  env: CopilotStartupEnvironment,
): CopilotStartupPolicy {
  if (!enabled) return { enabled: false };
  assertCopilotProfiles(profiles);
  const runnerImage = requireValue(env.runnerImage, 'AGENT_COPILOT_RUNNER_IMAGE');
  const helperImage = requireValue(env.helperImage, 'AGENT_COPILOT_HELPER_IMAGE');
  const proxyImage = requireValue(env.proxyImage, 'AGENT_PROXY_IMAGE');
  for (const [name, value] of [['AGENT_COPILOT_RUNNER_IMAGE', runnerImage], ['AGENT_COPILOT_HELPER_IMAGE', helperImage], ['AGENT_PROXY_IMAGE', proxyImage]] as const) {
    const imageError = validateImageRef(value);
    if (imageError) throw new Error(`${name}: ${imageError}`);
  }
  const credentialPath = requireValue(env.credentialPath, 'AGENT_COPILOT_KEY_PATH');
  if (!credentialPath.startsWith('/') || credentialPath.split('/').includes('..') || credentialPath.includes('\0')) {
    throw new Error('AGENT_COPILOT_KEY_PATH must be an absolute path without traversal');
  }
  const model = requireValue(env.model, 'AGENT_COPILOT_MODEL');
  if (model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) {
    throw new Error('AGENT_COPILOT_MODEL has invalid format');
  }
  const egressHosts = parseCopilotEgressHosts(requireValue(env.egressHosts, 'AGENT_COPILOT_EGRESS_HOSTS'));
  return {
    enabled: true,
    runnerImage,
    helperImage,
    proxyImage,
    credentialPath,
    model,
    egressHosts,
    dryRun: /^(1|true|yes)$/i.test(env.dryRun ?? ''),
  };
}
