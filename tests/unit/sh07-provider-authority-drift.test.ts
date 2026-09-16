import { describe, expect, it } from 'vitest';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { authorizeAgentTool } from '../../src/gateway/agentAuthz.js';
import type { Principal } from '../../src/gateway/config.js';
import { BridgeError } from '../../src/shared/errors.js';

const principal = (agentBackends: string[]): Principal => ({
  id: 'provider-sh07',
  name: 'Provider SH07',
  keyHash: 'a'.repeat(64),
  enabled: true,
  scopes: ['agents:dispatch'],
  targets: [],
  projects: ['project-a'],
  agentBackends,
  agentProfiles: ['audit'],
});

describe('SH-07 provider failure state cannot drift authority', () => {
  it('keeps cooldown state backend-scoped and does not create a grant or fallback', () => {
    const store = new AgentJobStore(':memory:');
    try {
      const now = 1_800_000_000_000;
      store.recordProviderFailure('kiro', 'RATE_LIMITED', 7_000, now, 0);
      expect(store.getProviderAdmissionState('kiro')).toMatchObject({
        consecutiveFailures: 1, lastFailureCode: 'RATE_LIMITED', circuitState: 'CLOSED',
      });
      expect(store.getProviderAdmissionState('copilot')).toMatchObject({
        consecutiveFailures: 0, cooldownUntil: null, circuitState: 'CLOSED',
      });
      expect(() => store.assertProviderAdmissible('kiro', now + 1)).toThrowError(
        expect.objectContaining<Partial<BridgeError>>({ code: 'RATE_LIMITED' }),
      );
      expect(() => store.assertProviderAdmissible('copilot', now + 1)).not.toThrow();

      // Provider state is operational admission only. It never grants a
      // principal a backend that trusted client configuration did not grant.
      expect(authorizeAgentTool({
        tool: 'agent_dispatch', principal: principal(['kiro']), project: 'project-a', backend: 'copilot', profile: 'audit',
      })).toEqual(expect.objectContaining({ allowed: false, code: 'FORBIDDEN_BACKEND' }));
      expect(authorizeAgentTool({
        tool: 'agent_dispatch', principal: principal(['kiro']), project: 'project-a', backend: 'kiro', profile: 'audit',
      })).toEqual({ allowed: true });
    } finally {
      store.close();
    }
  });
});
