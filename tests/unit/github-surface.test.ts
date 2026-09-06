import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const root = resolve(import.meta.dirname, '../..');

describe('GitHub App deployment boundary', () => {
  it('keeps the private-key broker unpublished, isolated from gateway, and limited to the exact trust-registry mount', () => {
    const raw = readFileSync(join(root, 'compose.github.yaml'), 'utf8');
    const cfg: any = YAML.parse(raw);
    const broker = cfg.services['github-broker'];
    expect(broker.ports).toBeUndefined();
    expect(broker.volumes).toEqual(['./config/github.yaml:/config/github.yaml:ro']);
    expect(JSON.stringify(broker)).not.toContain('/var/run/docker.sock');
    expect(JSON.stringify(broker)).not.toContain('/home/herman/projects');
    expect(broker.environment.GITHUB_CONFIG).toBe('/config/github.yaml');
    expect(broker.networks).toEqual(['github-control']);
    expect(cfg.services.gateway).toBeUndefined();
    expect(broker.read_only).toBe(true);
    expect(broker.cap_drop).toEqual(['ALL']);
    expect(broker.security_opt).toContain('no-new-privileges:true');
    expect(broker.secrets[0].target).toBe('github-app-private-key');
    expect(broker.environment.HTTPS_PROXY).toBe('http://github-egress-proxy:8080');
  });

  it('gives direct Internet routing only to an exact GitHub allowlist proxy', () => {
    const cfg: any = YAML.parse(readFileSync(join(root, 'compose.github.yaml'), 'utf8'));
    const proxy = cfg.services['github-egress-proxy'];
    expect(proxy.networks).toEqual(['github-control', 'github-egress']);
    expect(proxy.environment.EGRESS_PROXY_EXACT_ALLOWLIST).toBe('api.github.com,github.com');
    expect(proxy.ports).toBeUndefined();
    expect(proxy.volumes).toBeUndefined();
    expect(JSON.stringify(proxy)).not.toContain('/var/run/docker.sock');
    expect(cfg.networks['github-control'].internal).toBe(true);
    expect(cfg.networks['github-egress'].internal).toBe(false);
  });

  it('acceptance allows only the exact read-only trust registry under projects root', () => {
    const script = readFileSync(join(root, 'scripts', 'remote-owner-infra-acceptance.sh'), 'utf8');
    expect(script).toContain('expected_github_config_mount="$RUNTIME_ROOT/config/github.yaml|/config/github.yaml|false"');
    expect(script).toContain('GitHub broker has unexpected projects-root mount');
    expect(script).toContain('GitHub egress proxy has projects-root mount');
    expect(script).not.toContain("fail 'GitHub broker has projects-root mount'");
  });

  it('configures executor for the private broker/control network but never the App private key', () => {
    const cfg: any = YAML.parse(readFileSync(join(root, 'compose.github.yaml'), 'utf8'));
    const env = cfg.services.executor.environment;
    expect(env.GITHUB_BROKER_URL).toBe('http://github-broker:8789');
    expect(env.GITHUB_CONTROL_NETWORK).toBe('quarangate-github-control');
    expect(env.GITHUB_GIT_HELPER_IMAGE).toContain('GITHUB_GIT_HELPER_IMAGE');
    expect(JSON.stringify(cfg.services.executor)).not.toContain('github-app-private-key');
  });
});

describe('GitHub public authority surface', () => {
  it('exposes read/write/review scopes but deliberately no merge scope or merge tool', () => {
    const config = readFileSync(join(root, 'src', 'gateway', 'config.ts'), 'utf8');
    const tools = readFileSync(join(root, 'src', 'gateway', 'githubTools.ts'), 'utf8');
    expect(config).toContain("'github:read'");
    expect(config).toContain("'github:write'");
    expect(config).toContain("'github:review'");
    expect(config).not.toContain("'github:merge'");
    expect(tools).toContain("'github_push_branch'");
    expect(tools).toContain("'github_pull_request_review'");
    expect(tools).toContain("'github_issues'");
    expect(tools).toContain("'github_issue_comments'");
    expect(tools).toContain("'github_pull_request_reviews'");
    expect(tools).toContain("'github_pull_request_review_comments'");
    expect(tools).not.toContain("'github_merge'");
  });

  it('uses trusted-account repository identifiers for remote mutations and keeps direct push local-project driven', () => {
    const tools = readFileSync(join(root, 'src', 'gateway', 'githubTools.ts'), 'utf8');
    const config = readFileSync(join(root, 'src', 'gateway', 'config.ts'), 'utf8');
    expect(tools).toContain('inputSchema: { project, expectedHead:');
    expect(tools).toContain('inputSchema: { repository, head: branch');
    expect(tools).toContain("principalCanGithubAccount");
    expect(config).toContain('githubAccounts?: string[]');
    expect(tools).not.toMatch(/inputSchema:\s*\{[^}]*owner:/);
    expect(tools).not.toMatch(/inputSchema:\s*\{[^}]*repo:/);
    expect(tools).not.toMatch(/inputSchema:\s*\{[^}]*url:/);
  });

  it('uses repository-scoped read credentials for issues and existing PR review state', () => {
    const broker = readFileSync(join(root, 'src', 'github-broker', 'index.ts'), 'utf8');
    expect(broker).toContain("issues: 'read'");
    expect(broker).toContain("/issues?state=${state}&per_page=100&page=${page}");
    expect(broker).toContain("/issues/${number}/comments?per_page=${maxItems}");
    expect(broker).toContain("/pulls/${number}/reviews?per_page=${maxItems}");
    expect(broker).toContain("/pulls/${number}/comments?per_page=${maxItems}");
    expect(broker).not.toMatch(/issues:\s*'write'/);
  });

  it('honors the owner-approved no-Checks permission contract for github_checks', () => {
    const broker = readFileSync(join(root, 'src', 'github-broker', 'index.ts'), 'utf8');
    const tools = readFileSync(join(root, 'src', 'gateway', 'githubTools.ts'), 'utf8');
    expect(broker).toContain("installationToken(owner, repo, { statuses: 'read' })");
    expect(broker).not.toMatch(/checks:\s*'read'/);
    expect(broker).not.toContain('/check-runs?per_page=100');
    expect(broker).toContain("/commits/${encodeURIComponent(ref)}/status");
    expect(broker).toContain("checks: { total_count: 0, check_runs: [] }");
    expect(tools).toContain('checkRuns is retained for response compatibility and is empty');
  });

  it('discovers repositories only through QuaranHUB installations on trusted accounts', () => {
    const broker = readFileSync(join(root, 'src', 'github-broker', 'index.ts'), 'utf8');
    const control = readFileSync(join(root, 'src', 'executor', 'githubControl.ts'), 'utf8');
    expect(broker).toContain('/app/installations?per_page=100&page=');
    expect(broker).toContain('/installation/repositories?per_page=100&page=');
    expect(broker).toContain("{ metadata: 'read' }");
    expect(broker).toContain("repository_selection !== 'all'");
    expect(broker).toContain('installation?.suspended_at != null');
    expect(broker).not.toContain('accountInstallationCache');
    const discoveryToken = broker.slice(
      broker.indexOf('async function installationWideToken'),
      broker.indexOf('async function repositoriesForAccount'),
    );
    expect(discoveryToken).not.toContain('tokenCache');
    expect(control).toContain('isTrustedGitHubOwner');
    expect(broker).toContain('validateTrustedOwner');
    expect(control).toContain('owner.toLowerCase() !== account.owner.toLowerCase()');
  });
});
