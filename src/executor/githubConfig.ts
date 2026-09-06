/** Trusted GitHub account registry plus local-project mappings for guarded push. */
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { BridgeError } from '../shared/errors.js';
import {
  GITHUB_BRANCH_PATTERN,
  GITHUB_OWNER_PATTERN,
  GITHUB_PROJECT_ID_PATTERN,
  GITHUB_REPO_PATTERN,
  GITHUB_REPOSITORY_KEY_PATTERN,
} from '../shared/github.js';

const accountSchema = z.object({
  owner: z.string().regex(GITHUB_OWNER_PATTERN),
}).strict();

const repoSchema = z.object({
  project: z.string().regex(GITHUB_PROJECT_ID_PATTERN),
  owner: z.string().regex(GITHUB_OWNER_PATTERN),
  repo: z.string().regex(GITHUB_REPO_PATTERN),
  protectedBranches: z.array(z.string().regex(GITHUB_BRANCH_PATTERN)).max(128).default([]),
}).strict();

const githubConfigSchema = z.object({
  accounts: z.array(accountSchema).min(1).max(64),
  repositories: z.array(repoSchema).max(512).default([]),
}).strict();

export interface GitHubAccountConfig extends z.infer<typeof accountSchema> {}
export interface GitHubRepositoryConfig extends z.infer<typeof repoSchema> {}
export interface GitHubControlConfig {
  accounts: GitHubAccountConfig[];
  repositories: GitHubRepositoryConfig[];
}

export function validateGitHubConfig(raw: unknown): GitHubControlConfig {
  const parsed = githubConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BridgeError('MALFORMED_REQUEST', `github config: ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`, 400);
  }

  const seenOwners = new Set<string>();
  for (const account of parsed.data.accounts) {
    const owner = account.owner.toLowerCase();
    if (seenOwners.has(owner)) throw new BridgeError('MALFORMED_REQUEST', `github config: duplicate account ${account.owner}`, 400);
    seenOwners.add(owner);
  }

  const seenProjects = new Set<string>();
  for (const r of parsed.data.repositories) {
    if (seenProjects.has(r.project)) throw new BridgeError('MALFORMED_REQUEST', `github config: duplicate project ${r.project}`, 400);
    seenProjects.add(r.project);
    if (!seenOwners.has(r.owner.toLowerCase())) {
      throw new BridgeError('MALFORMED_REQUEST', `github config: repository ${r.project} owner ${r.owner} is not a trusted account`, 400);
    }
  }
  return parsed.data;
}

export function loadGitHubConfig(path = process.env.GITHUB_CONFIG ?? '/config/github.yaml'): GitHubControlConfig {
  if (!fs.existsSync(path)) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'trusted GitHub registry is not configured', 503);
  let text: string;
  try { text = fs.readFileSync(path, 'utf8'); }
  catch { throw new BridgeError('GITHUB_NOT_CONFIGURED', 'trusted GitHub registry cannot be read', 503); }
  let raw: unknown;
  try { raw = YAML.parse(text); }
  catch { throw new BridgeError('GITHUB_NOT_CONFIGURED', 'trusted GitHub registry is not valid YAML', 503); }
  return validateGitHubConfig(raw);
}

export function resolveGitHubRepository(config: GitHubControlConfig, project: string): GitHubRepositoryConfig {
  const repo = config.repositories.find((r) => r.project === project);
  if (!repo) throw new BridgeError('UNKNOWN_GITHUB_PROJECT', `GitHub project ${project} is not registered for local push`, 404);
  return repo;
}

export function isTrustedGitHubOwner(config: GitHubControlConfig, owner: string): boolean {
  return config.accounts.some((a) => a.owner.toLowerCase() === owner.toLowerCase());
}

export function parseGitHubRepositoryKey(repository: unknown): { repository: string; owner: string; repo: string } {
  if (typeof repository !== 'string' || !GITHUB_REPOSITORY_KEY_PATTERN.test(repository)) {
    throw new BridgeError('MALFORMED_REQUEST', 'repository must be a validated owner/repository identifier', 400);
  }
  const slash = repository.indexOf('/');
  const owner = repository.slice(0, slash);
  const repo = repository.slice(slash + 1);
  return { repository: `${owner}/${repo}`, owner, repo };
}
