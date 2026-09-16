import { describe, expect, it } from 'vitest';
import { parseImageRef, validateImageRef } from '../../src/shared/imageRef.js';
import {
  GITHUB_BRANCH_PATTERN, GITHUB_COMMIT_PATTERN, GITHUB_OWNER_PATTERN,
  GITHUB_REPO_PATTERN, GITHUB_REPOSITORY_KEY_PATTERN,
} from '../../src/shared/github.js';
import { parseGitHubRepositoryKey } from '../../src/executor/githubConfig.js';
import {
  AGENT_JOB_ID_PATTERN, AGENT_PROJECT_ID_PATTERN,
} from '../../src/shared/agents.js';
import {
  assertIdeEnrollmentId, assertIdeInstanceId, assertIdeOperationId, assertIdePrincipalId,
  assertIdeSessionId, IDE_ENROLLMENT_ID_PATTERN, IDE_INSTANCE_ID_PATTERN,
  IDE_OPERATION_ID_PATTERN, IDE_SESSION_ID_PATTERN,
} from '../../src/shared/ideSessions.js';
import { oauthResourceForPublicUrl } from '../../src/gateway/auth/oauth.js';
import { redact } from '../../src/shared/redact.js';
import { HOSTILE_CODEPOINTS, runProperty, Sh08Prng } from '../helpers/sh08Property.js';

function ok(fn: () => unknown): boolean { try { fn(); return true; } catch { return false; } }
const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/:@[]{}!?*# $\\'.split('');

describe('SH-08 identity / canonicalization / redaction properties', () => {
  it('Docker image parsing never throws and validation only accepts explicit non-latest tags or valid digests', () => {
    runProperty('image-reference-totality', { seed: 0x08b001, iterations: 5000 }, (rng) => {
      const raw = rng.string([...ASCII, ...HOSTILE_CODEPOINTS], 96);
      const parsed = parseImageRef(raw);
      const error = validateImageRef(raw);
      expect(['implicit-latest', 'explicit-latest', 'explicit-tag', 'digest', 'malformed']).toContain(parsed.kind);
      if (error === null) {
        expect(['explicit-tag', 'digest']).toContain(parsed.kind);
        if (parsed.kind === 'explicit-tag') expect(parsed.tag?.toLowerCase()).not.toBe('latest');
        if (parsed.kind === 'digest') expect(parsed.digest).toMatch(/^sha(?:256|512):[0-9a-f]+$/u);
      }
    });
  });

  it('accepted GitHub repository keys round-trip exactly and cannot smuggle extra path components', () => {
    runProperty('github-repository-key', { seed: 0x08b002, iterations: 3500 }, (rng) => {
      const raw = rng.string(ASCII, 140);
      const accepted = ok(() => parseGitHubRepositoryKey(raw));
      expect(accepted).toBe(GITHUB_REPOSITORY_KEY_PATTERN.test(raw));
      if (!accepted) return;
      const parsed = parseGitHubRepositoryKey(raw);
      expect(parsed.repository).toBe(raw);
      expect(parsed.owner).toMatch(GITHUB_OWNER_PATTERN);
      expect(parsed.repo).toMatch(GITHUB_REPO_PATTERN);
      expect(raw.split('/')).toHaveLength(2);
      expect(`${parsed.owner}/${parsed.repo}`).toBe(raw);
    });
  });

  it('accepted GitHub branches and commits retain their fail-closed grammar invariants', () => {
    runProperty('github-ref-patterns', { seed: 0x08b003, iterations: 3500 }, (rng) => {
      const raw = rng.string(ASCII, 280);
      if (GITHUB_BRANCH_PATTERN.test(raw)) {
        expect(raw.length).toBeGreaterThan(0);
        expect(raw.length).toBeLessThanOrEqual(255);
        expect(raw.startsWith('/')).toBe(false);
        expect(raw.endsWith('/')).toBe(false);
        expect(raw.includes('..')).toBe(false);
        expect(/[~^:?*\[\\\s]/u.test(raw)).toBe(false);
        expect(raw.split('/').some((s) => s.startsWith('.'))).toBe(false);
        expect(raw.split('/').some((s) => s.endsWith('.lock'))).toBe(false);
      }
      if (GITHUB_COMMIT_PATTERN.test(raw)) expect(raw).toMatch(/^[0-9a-f]{40}$/u);
    });
  });

  it('agent and IDE generated identities accept exact grammar and reject single-character shape mutations', () => {
    runProperty('identity-shape', { seed: 0x08b004, iterations: 1500 }, (rng) => {
      let h32 = ''; for (let i = 0; i < 32; i++) h32 += rng.pick('0123456789abcdef'.split(''));
      const job = `job_${h32}`;
      expect(AGENT_JOB_ID_PATTERN.test(job)).toBe(true);
      expect(AGENT_JOB_ID_PATTERN.test(job.toUpperCase())).toBe(false);
      expect(AGENT_PROJECT_ID_PATTERN.test(`p${h32.slice(0, 20)}`)).toBe(true);
      const rows: Array<[string, RegExp, (x: unknown) => void]> = [
        [`iden_${h32}`, IDE_ENROLLMENT_ID_PATTERN, assertIdeEnrollmentId],
        [`ide_${h32}`, IDE_INSTANCE_ID_PATTERN, assertIdeInstanceId],
        [`ides_${h32}`, IDE_SESSION_ID_PATTERN, assertIdeSessionId],
        [`ideo_${h32}`, IDE_OPERATION_ID_PATTERN, assertIdeOperationId],
      ];
      for (const [value, pattern, assertFn] of rows) {
        expect(pattern.test(value)).toBe(true); expect(() => assertFn(value)).not.toThrow();
        expect(ok(() => assertFn(`${value}x`))).toBe(false);
        expect(ok(() => assertFn(value.toUpperCase()))).toBe(false);
      }
      const principal = `principal.${h32}`;
      expect(() => assertIdePrincipalId(principal)).not.toThrow();
    });
  });

  it('equivalent public OAuth URL identities canonicalize to one exact resource', () => {
    runProperty('oauth-resource-canonicalization', { seed: 0x08b005, iterations: 1000 }, (rng) => {
      const label = `host${rng.int(10000)}`;
      const path = `api${rng.int(100)}`;
      const a = `https://${label.toUpperCase()}.example.com:443/${path}`;
      const b = `https://${label}.example.com/${path}/`;
      expect(oauthResourceForPublicUrl(a)).toBe(oauthResourceForPublicUrl(b));
      expect(oauthResourceForPublicUrl(a)).toBe(`https://${label}.example.com/${path}/mcp`);
      const h1 = `http://${label.toUpperCase()}.example.com:80/${path}`;
      const h2 = `http://${label}.example.com/${path}/`;
      expect(oauthResourceForPublicUrl(h1)).toBe(oauthResourceForPublicUrl(h2));
    });
  });

  it('redaction is idempotent and removes generated credentials from supported secret-bearing forms', () => {
    const rng = new Sh08Prng(0x08b006);
    const alpha = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('');
    for (let i = 0; i < 1200; i++) {
      const secret = rng.string(alpha, 48, 16);
      const inputs = [
        `authorization: Bearer ${secret}`,
        `token=${secret}`,
        `api_key:${secret}`,
        `password=${secret}`,
        `mysql -p${secret}`,
        `credential=mcpb_${secret}`,
      ];
      for (const input of inputs) {
        const out = redact(input);
        expect(out).not.toContain(secret);
        expect(out).toContain('[REDACTED]');
        expect(redact(out)).toBe(out);
      }
    }
  });
});
