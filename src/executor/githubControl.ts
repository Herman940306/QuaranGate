/**
 * Executor-owned GitHub control plane.
 *
 * Remote repository operations are bounded to GitHub App installations on
 * trusted accounts from github.yaml. Public callers identify a repository by
 * owner/repository; the executor rejects owners outside that trusted account
 * registry. Direct Git push remains stricter: it is available only through an
 * explicit local project mapping and is preflighted against the current local
 * HEAD before any write token is minted.
 */
import { randomBytes } from 'node:crypto';
import { BridgeError } from '../shared/errors.js';
import { validateImageRef } from '../shared/imageRef.js';
import {
  GITHUB_BRANCH_PATTERN,
  GITHUB_COMMIT_PATTERN,
  GITHUB_MAX_PUSH_OUTPUT_BYTES,
  GITHUB_MAX_PUSH_RUNTIME_MS,
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_PATTERN,
  type GitHubBranchSummary,
  type GitHubChecksSummary,
  type GitHubCommitSummary,
  type GitHubCommentSummary,
  type GitHubIssueDetail,
  type GitHubIssueSummary,
  type GitHubPullFileSummary,
  type GitHubPullReviewCommentSummary,
  type GitHubPullReviewSummary,
  type GitHubPullSummary,
  type GitHubRepoMetadata,
  type GitHubRepositorySummary,
  type GitHubReviewEvent,
} from '../shared/github.js';
import type { AgentControlPlaneConfig } from './agentConfig.js';
import type { GitHubControlConfig, GitHubRepositoryConfig } from './githubConfig.js';
import {
  isTrustedGitHubOwner,
  parseGitHubRepositoryKey,
  resolveGitHubRepository,
} from './githubConfig.js';
import { githubBroker } from './githubBrokerClient.js';
import {
  createContainer, startContainer, waitContainer, getContainerLogs,
  removeContainer, removeVolume, listContainersByFilter, listVolumesByFilter,
} from './docker.js';
import { buildTar, populateVolume } from './agents/runnerAssets.js';

const GITHUB_MANAGED = 'io.quarangate.github.managed';
const GITHUB_RESOURCE = 'io.quarangate.github.resource';
const GITHUB_OPERATION = 'io.quarangate.github.operation';
const SECRET_MOUNT = '/run/github-auth';
const SOURCE_MOUNT = '/src';

interface GitHubControlOptions {
  config: GitHubControlConfig;
  agents: AgentControlPlaneConfig;
  helperImage: string;
  controlNetwork: string;
}

function validateProjectId(project: unknown): string {
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid GitHub project id', 400);
  }
  return project;
}

function validateBranch(branch: unknown): string {
  if (typeof branch !== 'string' || !GITHUB_BRANCH_PATTERN.test(branch)) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid GitHub branch name', 400);
  }
  return branch;
}

function validateCommit(sha: unknown): string {
  if (typeof sha !== 'string' || !GITHUB_COMMIT_PATTERN.test(sha)) {
    throw new BridgeError('MALFORMED_REQUEST', 'expectedHead must be a 40-character lowercase commit SHA', 400);
  }
  return sha;
}

function boundedReadText(v: unknown): string | undefined {
  return typeof v === 'string' ? v.slice(0, 8_192) : undefined;
}

function issueSummary(i: any): GitHubIssueSummary {
  return {
    number: Number(i.number), title: String(i.title ?? ''), state: String(i.state ?? ''),
    author: typeof i.user?.login === 'string' ? i.user.login : undefined,
    labels: Array.isArray(i.labels) ? i.labels.slice(0, 100).map((l: any) => typeof l === 'string' ? l : String(l?.name ?? '')).filter(Boolean) : [],
    comments: Number(i.comments ?? 0),
    updatedAt: typeof i.updated_at === 'string' ? i.updated_at : undefined,
    htmlUrl: typeof i.html_url === 'string' ? i.html_url : undefined,
  };
}

function commentSummary(c: any): GitHubCommentSummary {
  return {
    id: Number(c.id), author: typeof c.user?.login === 'string' ? c.user.login : undefined,
    body: boundedReadText(c.body) ?? '',
    createdAt: typeof c.created_at === 'string' ? c.created_at : undefined,
    updatedAt: typeof c.updated_at === 'string' ? c.updated_at : undefined,
    htmlUrl: typeof c.html_url === 'string' ? c.html_url : undefined,
  };
}

function pullSummary(p: any): GitHubPullSummary {
  return {
    number: Number(p.number),
    title: String(p.title ?? ''),
    state: String(p.state ?? ''),
    draft: Boolean(p.draft),
    headRef: String(p.head?.ref ?? ''),
    baseRef: String(p.base?.ref ?? ''),
    author: typeof p.user?.login === 'string' ? p.user.login : undefined,
    updatedAt: typeof p.updated_at === 'string' ? p.updated_at : undefined,
    htmlUrl: typeof p.html_url === 'string' ? p.html_url : undefined,
  };
}

export function buildGitHubHeadCheckSpec(opts: {
  image: string;
  hostPath: string;
  operationId: string;
}): Record<string, unknown> {
  // H1-1: central validator catches registry:port/repo (implicit latest) in addition to explicit :latest.
  const imgErr = validateImageRef(opts.image);
  if (!opts.image || imgErr) throw new BridgeError('GITHUB_NOT_CONFIGURED', `GitHub helper image must be an explicit immutable non-latest image: ${imgErr ?? 'empty'}`, 503);
  if (!opts.hostPath.startsWith('/') || opts.hostPath.includes('\0')) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GitHub project hostPath is invalid', 503);
  return {
    Image: opts.image,
    User: '1000:1000',
    WorkingDir: SOURCE_MOUNT,
    Cmd: ['git', '-c', `safe.directory=${SOURCE_MOUNT}`, '-C', SOURCE_MOUNT, 'rev-parse', 'HEAD'],
    Env: ['HOME=/tmp', 'GIT_OPTIONAL_LOCKS=0', 'GIT_CONFIG_NOSYSTEM=1'],
    Labels: {
      [GITHUB_MANAGED]: 'true',
      [GITHUB_RESOURCE]: 'head-check',
      [GITHUB_OPERATION]: opts.operationId,
    },
    NetworkDisabled: true,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges'],
      GroupAdd: [],
      Devices: [],
      PidMode: '',
      IpcMode: 'private',
      NetworkMode: 'none',
      Binds: [`${opts.hostPath}:${SOURCE_MOUNT}:ro`],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
      Memory: 128 * 1024 * 1024,
      MemorySwap: 128 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 16,
    },
  };
}

export function buildGitHubPushHelperSpec(opts: {
  image: string;
  hostPath: string;
  secretVolume: string;
  controlNetwork: string;
  operationId: string;
  owner: string;
  repo: string;
  expectedHead: string;
  remoteBranch: string;
}): Record<string, unknown> {
  const imgErr2 = validateImageRef(opts.image);
  if (!opts.image || imgErr2) throw new BridgeError('GITHUB_NOT_CONFIGURED', `GitHub helper image must be an explicit immutable non-latest image: ${imgErr2 ?? 'empty'}`, 503);
  if (!opts.hostPath.startsWith('/') || opts.hostPath.includes('\0')) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GitHub project hostPath is invalid', 503);
  if (!opts.controlNetwork) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GitHub control network is not configured', 503);
  const remoteUrl = `https://github.com/${opts.owner}/${opts.repo}.git`;
  return {
    Image: opts.image,
    User: '1000:1000',
    WorkingDir: SOURCE_MOUNT,
    Cmd: [
      'git', '-c', `safe.directory=${SOURCE_MOUNT}`,
      '-c', 'https.proxy=http://github-egress-proxy:8080',
      '-C', SOURCE_MOUNT, 'push', '--porcelain', remoteUrl,
      `${opts.expectedHead}:refs/heads/${opts.remoteBranch}`,
    ],
    Env: [
      'HOME=/tmp',
      'GIT_OPTIONAL_LOCKS=0',
      'GIT_TERMINAL_PROMPT=0',
      'GIT_CONFIG_NOSYSTEM=1',
      `GIT_ASKPASS=${SECRET_MOUNT}/askpass.sh`,
    ],
    Labels: {
      [GITHUB_MANAGED]: 'true',
      [GITHUB_RESOURCE]: 'push-helper',
      [GITHUB_OPERATION]: opts.operationId,
    },
    NetworkDisabled: false,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges'],
      GroupAdd: [],
      Devices: [],
      PidMode: '',
      IpcMode: 'private',
      NetworkMode: opts.controlNetwork,
      Binds: [`${opts.hostPath}:${SOURCE_MOUNT}:ro`],
      Mounts: [{ Type: 'volume', Source: opts.secretVolume, Target: SECRET_MOUNT, ReadOnly: true }],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=32m' },
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 32,
    },
  };
}

export class GitHubControl {
  constructor(private readonly opts: GitHubControlOptions) {}

  private mappedRepo(projectRaw: unknown): GitHubRepositoryConfig {
    return resolveGitHubRepository(this.opts.config, validateProjectId(projectRaw));
  }

  private remote(repositoryRaw: unknown): { repository: string; owner: string; repo: string; mapping?: GitHubRepositoryConfig } {
    const parsed = parseGitHubRepositoryKey(repositoryRaw);
    if (!isTrustedGitHubOwner(this.opts.config, parsed.owner)) {
      throw new BridgeError('FORBIDDEN_GITHUB_ACCOUNT', `GitHub account ${parsed.owner} is not trusted`, 403);
    }
    const mapping = this.opts.config.repositories.find((r) =>
      r.owner.toLowerCase() === parsed.owner.toLowerCase() && r.repo.toLowerCase() === parsed.repo.toLowerCase());
    return { ...parsed, mapping };
  }

  private hostPath(project: string): string {
    const p = this.opts.agents.projects.find((x) => x.id === project);
    if (!p) throw new BridgeError('GITHUB_NOT_CONFIGURED', `GitHub project ${project} has no trusted local project mapping`, 503);
    if (!p.gitRequired) throw new BridgeError('GITHUB_NOT_CONFIGURED', `GitHub project ${project} is not configured as a Git project`, 503);
    return p.hostPath;
  }

  async listRepositories(): Promise<GitHubRepositorySummary[]> {
    const out: GitHubRepositorySummary[] = [];
    const seen = new Set<string>();
    for (const account of this.opts.config.accounts) {
      const rows = await githubBroker.repositories(account.owner);
      for (const row of rows) {
        const owner = typeof row?.owner?.login === 'string' ? row.owner.login : '';
        const repo = typeof row?.name === 'string' ? row.name : '';
        if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo) || owner.toLowerCase() !== account.owner.toLowerCase()) {
          throw new BridgeError('GITHUB_API_ERROR', 'GitHub repository discovery returned an unexpected repository identity', 502);
        }
        const key = `${owner}/${repo}`;
        const dedupe = key.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const mapping = this.opts.config.repositories.find((r) =>
          r.owner.toLowerCase() === owner.toLowerCase() && r.repo.toLowerCase() === repo.toLowerCase());
        out.push({
          repository: key,
          owner,
          repo,
          private: Boolean(row.private),
          archived: Boolean(row.archived),
          localProject: mapping?.project,
          protectedBranches: mapping ? [...mapping.protectedBranches] : [],
        });
      }
    }
    return out.sort((a, b) => a.repository.localeCompare(b.repository));
  }

  async repository(repository: string): Promise<GitHubRepoMetadata> {
    const r = this.remote(repository);
    const data = await githubBroker.repository(r.owner, r.repo);
    return {
      repository: r.repository,
      localProject: r.mapping?.project,
      fullName: String(data.full_name ?? r.repository),
      defaultBranch: String(data.default_branch ?? ''),
      private: Boolean(data.private),
      archived: Boolean(data.archived),
      disabled: Boolean(data.disabled),
      pushedAt: typeof data.pushed_at === 'string' ? data.pushed_at : undefined,
    };
  }

  async branches(repository: string, maxItems?: number): Promise<GitHubBranchSummary[]> {
    const r = this.remote(repository);
    const rows = await githubBroker.branches(r.owner, r.repo, maxItems);
    return rows.map((b: any) => ({ name: String(b.name ?? ''), sha: String(b.commit?.sha ?? ''), protected: Boolean(b.protected) }));
  }

  async commits(repository: string, ref: string, maxItems?: number): Promise<GitHubCommitSummary[]> {
    const r = this.remote(repository);
    const rows = await githubBroker.commits(r.owner, r.repo, validateBranchOrCommit(ref), maxItems);
    return rows.map((c: any) => ({
      sha: String(c.sha ?? ''),
      message: String(c.commit?.message ?? '').slice(0, 4096),
      authorName: typeof c.commit?.author?.name === 'string' ? c.commit.author.name : undefined,
      authoredAt: typeof c.commit?.author?.date === 'string' ? c.commit.author.date : undefined,
      htmlUrl: typeof c.html_url === 'string' ? c.html_url : undefined,
    }));
  }

  async pulls(repository: string, state?: string, maxItems?: number): Promise<GitHubPullSummary[]> {
    const r = this.remote(repository);
    return (await githubBroker.pulls(r.owner, r.repo, state, maxItems)).map(pullSummary);
  }

  async pull(repository: string, number: number): Promise<GitHubPullSummary> {
    const r = this.remote(repository);
    return pullSummary(await githubBroker.pull(r.owner, r.repo, number));
  }

  async pullFiles(repository: string, number: number, maxItems?: number): Promise<GitHubPullFileSummary[]> {
    const r = this.remote(repository);
    return (await githubBroker.pullFiles(r.owner, r.repo, number, maxItems)).map((f: any) => ({
      filename: String(f.filename ?? ''),
      status: String(f.status ?? ''),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
      changes: Number(f.changes ?? 0),
      patch: typeof f.patch === 'string' ? f.patch : undefined,
    }));
  }

  async issues(repository: string, state?: string, maxItems?: number): Promise<GitHubIssueSummary[]> {
    const r = this.remote(repository);
    return (await githubBroker.issues(r.owner, r.repo, state, maxItems)).map(issueSummary);
  }

  async issue(repository: string, number: number): Promise<GitHubIssueDetail> {
    const r = this.remote(repository);
    const data = await githubBroker.issue(r.owner, r.repo, number);
    return { ...issueSummary(data), body: boundedReadText(data.body), locked: Boolean(data.locked) };
  }

  async issueComments(repository: string, number: number, maxItems?: number): Promise<GitHubCommentSummary[]> {
    const r = this.remote(repository);
    return (await githubBroker.issueComments(r.owner, r.repo, number, maxItems)).map(commentSummary);
  }

  async pullReviews(repository: string, number: number, maxItems?: number): Promise<GitHubPullReviewSummary[]> {
    const r = this.remote(repository);
    return (await githubBroker.pullReviews(r.owner, r.repo, number, maxItems)).map((review: any) => ({
      id: Number(review.id), user: typeof review.user?.login === 'string' ? review.user.login : undefined,
      state: String(review.state ?? ''), body: boundedReadText(review.body),
      submittedAt: typeof review.submitted_at === 'string' ? review.submitted_at : undefined,
      commitId: typeof review.commit_id === 'string' ? review.commit_id : undefined,
      htmlUrl: typeof review.html_url === 'string' ? review.html_url : undefined,
    }));
  }

  async pullReviewComments(repository: string, number: number, maxItems?: number): Promise<GitHubPullReviewCommentSummary[]> {
    const r = this.remote(repository);
    return (await githubBroker.pullReviewComments(r.owner, r.repo, number, maxItems)).map((c: any) => ({
      ...commentSummary(c), path: String(c.path ?? ''),
      line: Number.isInteger(c.line) ? c.line : undefined,
      side: typeof c.side === 'string' ? c.side : undefined,
      commitId: typeof c.commit_id === 'string' ? c.commit_id : undefined,
    }));
  }

  async checks(repository: string, ref: string): Promise<GitHubChecksSummary> {
    const r = this.remote(repository);
    const data = await githubBroker.checks(r.owner, r.repo, validateBranchOrCommit(ref));
    return {
      ref,
      checkRuns: Array.isArray(data.checks?.check_runs) ? data.checks.check_runs.slice(0, 100).map((c: any) => ({
        name: String(c.name ?? ''), status: String(c.status ?? ''),
        conclusion: typeof c.conclusion === 'string' ? c.conclusion : undefined,
        htmlUrl: typeof c.html_url === 'string' ? c.html_url : undefined,
      })) : [],
      statuses: Array.isArray(data.statuses?.statuses) ? data.statuses.statuses.slice(0, 100).map((s: any) => ({
        context: String(s.context ?? ''), state: String(s.state ?? ''),
        description: typeof s.description === 'string' ? s.description : undefined,
        targetUrl: typeof s.target_url === 'string' ? s.target_url : undefined,
      })) : [],
    };
  }

  async createPull(repository: string, req: { head: string; base: string; title: string; body?: string; draft?: boolean }): Promise<GitHubPullSummary> {
    const r = this.remote(repository);
    const data = await githubBroker.createPull(r.owner, r.repo, { ...req, head: validateBranch(req.head), base: validateBranch(req.base) });
    return pullSummary(data);
  }

  async updatePull(repository: string, req: { number: number; title?: string; body?: string; state?: 'open' | 'closed' }): Promise<GitHubPullSummary> {
    const r = this.remote(repository);
    return pullSummary(await githubBroker.updatePull(r.owner, r.repo, req));
  }

  async reviewPull(repository: string, req: { number: number; event: GitHubReviewEvent; body?: string }): Promise<{ id: number; state: string; htmlUrl?: string }> {
    const r = this.remote(repository);
    const data = await githubBroker.reviewPull(r.owner, r.repo, req);
    return { id: Number(data.id), state: String(data.state ?? ''), htmlUrl: typeof data.html_url === 'string' ? data.html_url : undefined };
  }

  private async verifyLocalHead(hostPath: string, expectedHead: string, operationId: string): Promise<void> {
    let containerId: string | undefined;
    try {
      const spec = buildGitHubHeadCheckSpec({ image: this.opts.helperImage, hostPath, operationId });
      containerId = await createContainer(`quarangate-github-head-${operationId}`, spec);
      await startContainer(containerId);
      const waited = await waitContainer(containerId, { timeoutMs: 30_000 });
      const logs = await getContainerLogs(containerId, 4096).catch(() => ({ stdout: '', stderr: '', bytes: 0, truncated: false }));
      if (waited.timedOut) throw new BridgeError('GITHUB_PUSH_FAILED', 'local Git HEAD verification timed out', 504);
      if (waited.statusCode !== 0) throw new BridgeError('GITHUB_PUSH_FAILED', 'local Git HEAD could not be verified', 409);
      const observed = logs.stdout.trim();
      if (!GITHUB_COMMIT_PATTERN.test(observed)) throw new BridgeError('GITHUB_PUSH_FAILED', 'local Git HEAD verification returned an invalid commit id', 409);
      if (observed !== expectedHead) throw new BridgeError('STALE_BASE_COMMIT', `local HEAD changed; expected ${expectedHead} but observed ${observed}`, 409);
    } finally {
      if (containerId) await removeContainer(containerId, true).catch(() => {});
    }
  }

  async pushBranch(project: string, expectedHeadRaw: string, remoteBranchRaw: string): Promise<{ project: string; remoteBranch: string; sha: string }> {
    const r = this.mappedRepo(project);
    const expectedHead = validateCommit(expectedHeadRaw);
    const remoteBranch = validateBranch(remoteBranchRaw);
    const metadata = await this.repository(`${r.owner}/${r.repo}`);
    if (metadata.archived || metadata.disabled) throw new BridgeError('GITHUB_REMOTE_REFUSED', 'GitHub repository is archived or disabled', 409);
    if (!metadata.defaultBranch) throw new BridgeError('GITHUB_API_ERROR', 'GitHub repository default branch is unavailable', 502);
    if (remoteBranch === metadata.defaultBranch || r.protectedBranches.includes(remoteBranch)) {
      throw new BridgeError('GITHUB_REMOTE_REFUSED', `direct push to protected branch ${remoteBranch} is refused`, 403);
    }
    const existing = await githubBroker.branch(r.owner, r.repo, remoteBranch);
    if (existing?.protected) throw new BridgeError('GITHUB_REMOTE_REFUSED', `direct push to GitHub-protected branch ${remoteBranch} is refused`, 403);

    const hostPath = this.hostPath(project);
    if (!this.opts.helperImage || !this.opts.controlNetwork) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GitHub push helper infrastructure is not configured', 503);
    const operationId = `gh_${randomBytes(12).toString('hex')}`;
    await this.verifyLocalHead(hostPath, expectedHead, operationId);
    const { token } = await githubBroker.pushToken(r.owner, r.repo);
    const secretVolume = `quarangate-github-secret-${operationId}`;
    const labels = { [GITHUB_MANAGED]: 'true', [GITHUB_RESOURCE]: 'push-secret', [GITHUB_OPERATION]: operationId };
    const askpass = [
      '#!/bin/sh',
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      `  *Password*) cat ${SECRET_MOUNT}/token ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n');
    const tar = await buildTar({ files: [
      { name: 'token', content: Buffer.from(token, 'utf8'), mode: 0o400, uid: 1000, gid: 1000 },
      { name: 'askpass.sh', content: Buffer.from(askpass, 'utf8'), mode: 0o500, uid: 1000, gid: 1000 },
    ] });

    let containerId: string | undefined;
    try {
      await populateVolume({ volumeName: secretVolume, labels, helperImage: this.opts.helperImage, mountPath: '/secrets', tar });
      const spec = buildGitHubPushHelperSpec({
        image: this.opts.helperImage, hostPath, secretVolume, controlNetwork: this.opts.controlNetwork,
        operationId, owner: r.owner, repo: r.repo, expectedHead, remoteBranch,
      });
      containerId = await createContainer(`quarangate-github-push-${operationId}`, spec);
      await startContainer(containerId);
      const waited = await waitContainer(containerId, { timeoutMs: GITHUB_MAX_PUSH_RUNTIME_MS });
      await getContainerLogs(containerId, GITHUB_MAX_PUSH_OUTPUT_BYTES).catch(() => ({ stdout: '', stderr: '', bytes: 0, truncated: false }));
      if (waited.timedOut) throw new BridgeError('GITHUB_PUSH_FAILED', 'GitHub push helper timed out', 504);
      if (waited.statusCode !== 0) {
        throw new BridgeError('GITHUB_PUSH_FAILED', `GitHub push failed (exit ${waited.statusCode ?? 'unknown'})`, 409);
      }
    } finally {
      if (containerId) await removeContainer(containerId, true).catch(() => {});
      await removeVolume(secretVolume, true).catch(() => {});
    }

    const post = await githubBroker.branch(r.owner, r.repo, remoteBranch);
    const postSha = typeof post?.commit?.sha === 'string' ? post.commit.sha : '';
    if (postSha !== expectedHead) {
      throw new BridgeError('GITHUB_PUSH_FAILED', 'GitHub push post-verification did not observe the expected remote branch SHA', 502);
    }
    return { project, remoteBranch, sha: expectedHead };
  }

  async reconcileOrphans(): Promise<{ containers: number; volumes: number }> {
    const filter = { label: [`${GITHUB_MANAGED}=true`] };
    const containers = await listContainersByFilter(filter, true).catch(() => []);
    const volumes = await listVolumesByFilter(filter).catch(() => []);
    for (const c of containers) await removeContainer(c.Id, true).catch(() => {});
    for (const v of volumes) await removeVolume(v.Name, true).catch(() => {});
    return { containers: containers.length, volumes: volumes.length };
  }
}

function validateBranchOrCommit(ref: string): string {
  if (GITHUB_COMMIT_PATTERN.test(ref)) return ref;
  return validateBranch(ref);
}
