import { describe, expect, it } from 'vitest';
import { agentDiffInput, agentDispatchInput, MAX_AGENT_DIFF_CHUNK_BYTES } from '../../src/gateway/agentSchemas.js';
import { MAX_AGENT_PROMPT_CHARS } from '../../src/shared/agents.js';
import {
  GITHUB_BRANCH_PATTERN,
  GITHUB_REPOSITORY_KEY_PATTERN,
} from '../../src/shared/github.js';
import {
  IDE_COMPANION_MAX_AUTH_FRAME_BYTES,
  IdeCompanionAuthError,
  parseIdeCompanionAuthFrame,
} from '../../src/shared/ideCompanionAuth.js';
import { BridgeError } from '../../src/shared/errors.js';
import { validateRelativePath } from '../../src/shared/pathcheck.js';

function bridgeCode(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; }
  catch (error) { return error instanceof BridgeError ? error.code : 'OTHER_ERROR'; }
}

function ideCode(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; }
  catch (error) { return error instanceof IdeCompanionAuthError ? error.code : 'OTHER_ERROR'; }
}

describe('SH-07 malformed and oversized multi-plane boundary chain', () => {
  it('rejects one traversal/control payload independently at every expressible plane', () => {
    const hostile = '../escape\nAuthorization: Bearer sh07-secret';

    expect(agentDispatchInput.safeParse({
      backend: 'kiro', project: hostile, profile: 'audit', prompt: 'bounded',
    }).success).toBe(false);
    expect(bridgeCode(() => validateRelativePath(hostile))).toBe('PATH_VIOLATION');
    expect(GITHUB_REPOSITORY_KEY_PATTERN.test(`Acme/${hostile}`)).toBe(false);
    expect(GITHUB_BRANCH_PATTERN.test(hostile)).toBe(false);
    expect(ideCode(() => parseIdeCompanionAuthFrame(hostile))).toMatch(/^IDE_COMPANION_/u);
  });

  it('rejects oversized values at each public bounded contract instead of truncating into another meaning', () => {
    expect(agentDispatchInput.safeParse({
      backend: 'kiro', project: 'example-project', profile: 'audit',
      prompt: 'x'.repeat(MAX_AGENT_PROMPT_CHARS + 1),
    }).success).toBe(false);
    expect(agentDiffInput.safeParse({
      jobId: `job_${'a'.repeat(32)}`,
      maxBytes: MAX_AGENT_DIFF_CHUNK_BYTES + 1,
    }).success).toBe(false);
    expect(GITHUB_BRANCH_PATTERN.test('a'.repeat(256))).toBe(false);
    expect(ideCode(() => parseIdeCompanionAuthFrame('x'.repeat(IDE_COMPANION_MAX_AUTH_FRAME_BYTES + 1))))
      .toBe('IDE_COMPANION_FRAME_SIZE');
  });

  it('rejects caller attempts to smuggle host/Docker authority into strict agent inputs', () => {
    for (const injected of [
      { hostPath: '/host' },
      { runnerImage: 'attacker:latest' },
      { dockerSocket: '/var/run/docker.sock' },
      { privileged: true },
      { networkMode: 'host' },
    ]) {
      expect(agentDispatchInput.safeParse({
        backend: 'kiro', project: 'example-project', profile: 'audit', prompt: 'bounded', ...injected,
      }).success, JSON.stringify(injected)).toBe(false);
    }
  });
});
