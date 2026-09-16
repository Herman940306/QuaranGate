import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateKey, generateKey } from '../../src/gateway/auth/apikeys.js';
import {
  loadClients,
  principalById,
  principalCanGithubAccount,
  principalCanGithubProject,
  principalCanTarget,
  principalHasScope,
  type Principal,
} from '../../src/gateway/config.js';
import { authorizeAgentTool } from '../../src/gateway/agentAuthz.js';
import { checkRate, rateState } from '../../src/gateway/ratelimit.js';
import { BridgeError } from '../../src/shared/errors.js';

const owned: string[] = [];
afterEach(() => {
  delete process.env.DATA_DIR;
  for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'cross-plane',
    name: 'Cross Plane',
    keyHash: 'a'.repeat(64),
    enabled: true,
    scopes: [],
    targets: [],
    projects: [],
    agentBackends: [],
    agentProfiles: [],
    githubAccounts: [],
    githubProjects: [],
    ...overrides,
  };
}

describe('SH-07 cross-plane authentication and confused-deputy resistance', () => {
  it('maps static-key and OAuth bearer modes to one exact principal and one shared rate bucket', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qg-sh07-auth-'));
    owned.push(directory);
    const clientsPath = join(directory, 'clients.yaml');
    const key = generateKey('dual-auth');
    writeFileSync(clientsPath, `clients:\n  - id: dual-auth\n    name: Dual Auth\n    keyHash: "${key.hash}"\n    enabled: true\n    rateLimit: 1\n    scopes: [targets:read, agents:read]\n    targets: [demo]\n    projects: [proj]\n    agentBackends: [kiro]\n    agentProfiles: [audit]\n`);
    loadClients(clientsPath);

    const bearer = 'mcpb_at_sh07_equivalent_principal_token';
    const resource = 'https://quarangate.invalid/mcp';
    const bearerHash = createHash('sha256').update(bearer).digest('hex');
    writeFileSync(join(directory, 'oauth-tokens.json'), JSON.stringify({
      [bearerHash]: {
        principalId: 'dual-auth',
        clientId: 'sh07-client',
        resource,
        expiresAt: Date.now() + 60_000,
      },
    }), { mode: 0o600 });

    process.env.DATA_DIR = directory;
    vi.resetModules();
    const { tokenToPrincipalId } = await import('../../src/gateway/auth/oauth.js');

    const staticPrincipal = authenticateKey(key.key);
    const oauthPrincipalId = tokenToPrincipalId(bearer, resource);
    const oauthPrincipal = principalById(oauthPrincipalId ?? '');
    expect(oauthPrincipalId).toBe('dual-auth');
    expect(oauthPrincipal).toBe(staticPrincipal);
    expect(oauthPrincipal?.scopes).toEqual(staticPrincipal.scopes);
    expect(oauthPrincipal?.targets).toEqual(staticPrincipal.targets);
    expect(oauthPrincipal?.projects).toEqual(staticPrincipal.projects);

    checkRate(staticPrincipal.id, staticPrincipal.rateLimit);
    expect(rateState(oauthPrincipal!.id, oauthPrincipal!.rateLimit)).toMatchObject({ used: 1, remaining: 0 });
    expect(() => checkRate(oauthPrincipal!.id, oauthPrincipal!.rateLimit)).toThrowError(expect.objectContaining<Partial<BridgeError>>({ code: 'RATE_LIMITED' }));
  });

  it('never converts target authority into agent or GitHub authority', () => {
    const p = principal({
      id: 'target-only',
      scopes: ['targets:read', 'targets:control'],
      targets: ['prod-like-target'],
    });
    expect(principalCanTarget(p, 'prod-like-target')).toBe(true);
    expect(authorizeAgentTool({
      tool: 'agent_dispatch', principal: p, project: 'prod-like-target', backend: 'kiro', profile: 'audit',
    })).toEqual(expect.objectContaining({ allowed: false, code: 'FORBIDDEN_SCOPE' }));
    expect(principalCanGithubAccount(p, 'prod-like-target')).toBe(false);
    expect(principalCanGithubProject(p, 'prod-like-target')).toBe(false);
  });

  it('never converts agent authority into target or GitHub authority', () => {
    const p = principal({
      id: 'agent-only',
      scopes: ['agents:read', 'agents:dispatch'],
      projects: ['project-a'],
      agentBackends: ['kiro'],
      agentProfiles: ['audit'],
    });
    expect(authorizeAgentTool({
      tool: 'agent_dispatch', principal: p, project: 'project-a', backend: 'kiro', profile: 'audit',
    })).toEqual({ allowed: true });
    expect(principalHasScope(p, 'targets:read')).toBe(false);
    expect(principalCanTarget(p, 'project-a')).toBe(false);
    expect(principalCanGithubAccount(p, 'project-a')).toBe(false);
    expect(principalCanGithubProject(p, 'project-a')).toBe(false);
  });

  it('never converts GitHub authority into target or agent authority', () => {
    const p = principal({
      id: 'github-only',
      scopes: ['github:read'],
      githubAccounts: ['Acme'],
      githubProjects: ['project-a'],
    });
    expect(principalCanGithubAccount(p, 'acme')).toBe(true);
    expect(principalCanGithubProject(p, 'project-a')).toBe(true);
    expect(principalHasScope(p, 'targets:read')).toBe(false);
    expect(principalCanTarget(p, 'project-a')).toBe(false);
    expect(authorizeAgentTool({
      tool: 'agent_dispatch', principal: p, project: 'project-a', backend: 'kiro', profile: 'audit',
    })).toEqual(expect.objectContaining({ allowed: false, code: 'FORBIDDEN_SCOPE' }));
  });
});
