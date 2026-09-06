import { describe, expect, it } from 'vitest';
import { validateGitHubConfig } from '../../src/executor/githubConfig.js';
import { buildGitHubHeadCheckSpec, buildGitHubPushHelperSpec } from '../../src/executor/githubControl.js';
import { principalCanGithubAccount, principalCanGithubProject, type Principal } from '../../src/gateway/config.js';

const principal = (githubAccounts: string[], githubProjects: string[]): Principal => ({
  id: 'p', name: 'p', keyHash: 'a'.repeat(64), enabled: true,
  scopes: ['github:read', 'github:write', 'github:review'], targets: [], githubAccounts, githubProjects,
});

describe('GitHub trusted configuration', () => {
  it('accepts trusted accounts plus a local project mapping and preserves protected branches', () => {
    const cfg = validateGitHubConfig({
      accounts: [{ owner: 'Herman940306' }, { owner: 'JustAGameZA' }],
      repositories: [{
        project: 'atlas', owner: 'Herman940306', repo: 'Atlas', protectedBranches: ['main', 'release/stable'],
      }],
    });
    expect(cfg.accounts.map((a) => a.owner)).toEqual(['Herman940306', 'JustAGameZA']);
    expect(cfg.repositories).toHaveLength(1);
    expect(cfg.repositories[0]?.project).toBe('atlas');
    expect(cfg.repositories[0]?.protectedBranches).toEqual(['main', 'release/stable']);
  });

  it('allows account-only discovery with zero local push mappings', () => {
    const cfg = validateGitHubConfig({ accounts: [{ owner: 'Herman940306' }] });
    expect(cfg.repositories).toEqual([]);
  });

  it('rejects duplicate trusted accounts, duplicate projects, and mappings outside trusted accounts', () => {
    expect(() => validateGitHubConfig({
      accounts: [{ owner: 'Herman940306' }, { owner: 'herman940306' }], repositories: [],
    })).toThrow(/duplicate account/i);
    expect(() => validateGitHubConfig({
      accounts: [{ owner: 'Herman940306' }], repositories: [
        { project: 'atlas', owner: 'Herman940306', repo: 'Atlas', protectedBranches: [] },
        { project: 'atlas', owner: 'Herman940306', repo: 'Other', protectedBranches: [] },
      ],
    })).toThrow(/duplicate project atlas/);
    expect(() => validateGitHubConfig({
      accounts: [{ owner: 'Herman940306' }], repositories: [
        { project: 'atlas', owner: 'OtherOwner', repo: 'Atlas', protectedBranches: [] },
      ],
    })).toThrow(/not a trusted account/);
  });

  it('keeps remote-account and local-push grants independent and deny-by-default', () => {
    expect(principalCanGithubAccount(principal([], []), 'Herman940306')).toBe(false);
    expect(principalCanGithubAccount(principal(['Herman940306'], []), 'herman940306')).toBe(true);
    expect(principalCanGithubAccount(principal(['*'], []), 'JustAGameZA')).toBe(true);
    expect(principalCanGithubProject(principal([], []), 'atlas')).toBe(false);
    expect(principalCanGithubProject(principal([], ['atlas']), 'atlas')).toBe(true);
    expect(principalCanGithubProject(principal([], ['*']), 'mcp-ide-bridge')).toBe(true);
  });
});

describe('GitHub push helper hard boundary', () => {
  const base = {
    image: 'quarangate:git-helper-abc123',
    hostPath: '/home/herman/projects/Atlas',
    secretVolume: 'quarangate-github-secret-gh_123',
    controlNetwork: 'quarangate-github-control',
    operationId: 'gh_123',
    owner: 'Herman940306',
    repo: 'Atlas',
    expectedHead: 'a'.repeat(40),
    remoteBranch: 'feature/test',
  };

  it('preflights local HEAD with no network and no credential mount', () => {
    const spec: any = buildGitHubHeadCheckSpec({
      image: base.image, hostPath: base.hostPath, operationId: base.operationId,
    });
    expect(spec.Cmd).toEqual(['git', '-c', 'safe.directory=/src', '-C', '/src', 'rev-parse', 'HEAD']);
    expect(spec.NetworkDisabled).toBe(true);
    expect(spec.HostConfig.NetworkMode).toBe('none');
    expect(spec.HostConfig.Binds).toEqual(['/home/herman/projects/Atlas:/src:ro']);
    expect(spec.HostConfig.Mounts).toBeUndefined();
    expect(JSON.stringify(spec)).not.toContain('github-auth');
    expect(JSON.stringify(spec)).not.toContain('/var/run/docker.sock');
  });

  it('mounts only source RO + operation secret RO and can egress only through fixed GitHub proxy', () => {
    const spec: any = buildGitHubPushHelperSpec(base);
    expect(spec.Cmd).toEqual([
      'git', '-c', 'safe.directory=/src',
      '-c', 'https.proxy=http://github-egress-proxy:8080',
      '-C', '/src', 'push', '--porcelain',
      'https://github.com/Herman940306/Atlas.git', `${'a'.repeat(40)}:refs/heads/feature/test`,
    ]);
    expect(spec.Cmd.join(' ')).not.toContain('x-access-token');
    expect(spec.Env.join('\n')).not.toMatch(/ghs_|github_pat_|PRIVATE KEY/);
    expect(spec.HostConfig.Binds).toEqual(['/home/herman/projects/Atlas:/src:ro']);
    expect(spec.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: base.secretVolume, Target: '/run/github-auth', ReadOnly: true }]);
    expect(JSON.stringify(spec)).not.toContain('/var/run/docker.sock');
    expect(spec.HostConfig.Privileged).toBe(false);
    expect(spec.HostConfig.CapDrop).toEqual(['ALL']);
    expect(spec.HostConfig.NetworkMode).toBe('quarangate-github-control');
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
  });

  it('refuses mutable :latest helper images', () => {
    expect(() => buildGitHubPushHelperSpec({ ...base, image: 'anything:latest' })).toThrow(/non-latest/);
    expect(() => buildGitHubHeadCheckSpec({ image: 'anything:latest', hostPath: base.hostPath, operationId: base.operationId })).toThrow(/non-latest/);
  });
});
