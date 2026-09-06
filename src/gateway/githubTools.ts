/** Public MCP tools for the governed GitHub App control plane. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import {
  GITHUB_BRANCH_PATTERN,
  GITHUB_COMMIT_PATTERN,
  GITHUB_MAX_BODY_CHARS,
  GITHUB_MAX_LIST_ITEMS,
  GITHUB_MAX_TITLE_CHARS,
  GITHUB_PROJECT_ID_PATTERN,
  GITHUB_REPOSITORY_KEY_PATTERN,
} from '../shared/github.js';
import { executor } from './executorClient.js';
import { audit, newReqId } from './audit.js';
import { currentPrincipal } from './context.js';
import {
  principalCanGithubAccount,
  principalCanGithubProject,
  principalHasScope,
  type Scope,
} from './config.js';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const REMOTE_WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
function ok(data: object): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: { ...data } }; }

function repositoryOwner(repository: string): string {
  const slash = repository.indexOf('/');
  return slash > 0 ? repository.slice(0, slash) : '';
}

function requireGithub(scope: Scope, opts: { repository?: string; project?: string } = {}) {
  const p = currentPrincipal();
  if (!p) throw new BridgeError('UNAUTHENTICATED', 'no principal in context', 401);
  if (!principalHasScope(p, scope)) throw new BridgeError('FORBIDDEN_SCOPE', `missing scope ${scope}`, 403);
  if (opts.repository) {
    const owner = repositoryOwner(opts.repository);
    if (!principalCanGithubAccount(p, owner)) throw new BridgeError('FORBIDDEN_GITHUB_ACCOUNT', `GitHub account ${owner} not permitted for client ${p.id}`, 403);
  }
  if (opts.project && !principalCanGithubProject(p, opts.project)) {
    throw new BridgeError('FORBIDDEN_GITHUB_PROJECT', `GitHub project ${opts.project} not permitted for client ${p.id}`, 403);
  }
  return p;
}

function guarded(tool: string, fn: (args: any) => Promise<{ target?: string; result: object }>) {
  return async (args: any): Promise<ToolResult> => {
    const reqId = newReqId();
    const started = Date.now();
    const p = currentPrincipal();
    try {
      const { target, result } = await fn(args);
      audit({ reqId, principal: p?.id ?? null, tool, target: target ?? null, decision: 'allow', durationMs: Date.now() - started });
      return ok(result);
    } catch (e) {
      const be = asBridgeError(e);
      audit({ reqId, principal: p?.id ?? null, tool, target: args?.repository ?? args?.project ?? null, decision: 'deny', code: be.code, durationMs: Date.now() - started, detail: be.message });
      return { content: [{ type: 'text', text: JSON.stringify({ error: be.code, message: be.message }) }], isError: true };
    }
  };
}

const project = z.string().regex(GITHUB_PROJECT_ID_PATTERN);
const repository = z.string().regex(GITHUB_REPOSITORY_KEY_PATTERN);
const branch = z.string().regex(GITHUB_BRANCH_PATTERN);
const ref = z.string().refine((v) => GITHUB_BRANCH_PATTERN.test(v) || GITHUB_COMMIT_PATTERN.test(v), 'invalid GitHub ref');
const maxItems = z.number().int().min(1).max(GITHUB_MAX_LIST_ITEMS).optional();
const prNumber = z.number().int().min(1).max(2_147_483_647);

const REPOSITORY_SCHEMA = {
  repository: z.string(), localProject: z.string().optional(), fullName: z.string(), defaultBranch: z.string(), private: z.boolean(), archived: z.boolean(), disabled: z.boolean(), pushedAt: z.string().optional(),
} as const;
const PULL_SCHEMA = {
  number: z.number().int(), title: z.string(), state: z.string(), draft: z.boolean(), headRef: z.string(), baseRef: z.string(), author: z.string().optional(), updatedAt: z.string().optional(), htmlUrl: z.string().optional(),
} as const;
const ISSUE_SCHEMA = {
  number: z.number().int(), title: z.string(), state: z.string(), author: z.string().optional(), labels: z.array(z.string()), comments: z.number().int(), updatedAt: z.string().optional(), htmlUrl: z.string().optional(),
} as const;
const COMMENT_SCHEMA = {
  id: z.number().int(), author: z.string().optional(), body: z.string(), createdAt: z.string().optional(), updatedAt: z.string().optional(), htmlUrl: z.string().optional(),
} as const;
const REVIEW_SCHEMA = {
  id: z.number().int(), user: z.string().optional(), state: z.string(), body: z.string().optional(), submittedAt: z.string().optional(), commitId: z.string().optional(), htmlUrl: z.string().optional(),
} as const;

export function registerGitHubTools(server: McpServer): void {
  server.registerTool('github_repositories', {
    title: 'List governed GitHub repositories',
    description: 'Discover repositories available to QuaranHUB across this client\'s trusted GitHub accounts. Results come from GitHub App installations, not caller-supplied URLs.',
    inputSchema: {},
    outputSchema: { repositories: z.array(z.object({
      repository: z.string(), owner: z.string(), repo: z.string(), private: z.boolean(), archived: z.boolean(),
      localProject: z.string().optional(), protectedBranches: z.array(z.string()),
    })) },
    annotations: READ,
  }, guarded('github_repositories', async () => {
    const p = requireGithub('github:read');
    const repos = (await executor.githubRepositories()).filter((r) => principalCanGithubAccount(p, r.owner));
    return { result: { repositories: repos } };
  }));

  server.registerTool('github_repository', {
    title: 'Read GitHub repository metadata', description: 'Read bounded metadata for one repository on a trusted GitHub account.',
    inputSchema: { repository }, outputSchema: REPOSITORY_SCHEMA, annotations: READ,
  }, guarded('github_repository', async ({ repository }) => { requireGithub('github:read', { repository }); return { target: repository, result: await executor.githubRepository(repository) }; }));

  server.registerTool('github_branches', {
    title: 'List GitHub branches', description: 'List up to 100 branches for one repository on a trusted GitHub account.',
    inputSchema: { repository, maxItems }, outputSchema: { branches: z.array(z.object({ name: z.string(), sha: z.string(), protected: z.boolean() })) }, annotations: READ,
  }, guarded('github_branches', async ({ repository, maxItems }) => { requireGithub('github:read', { repository }); return { target: repository, result: { branches: await executor.githubBranches(repository, maxItems) } }; }));

  server.registerTool('github_commits', {
    title: 'List GitHub commits', description: 'List bounded commit metadata from a trusted repository branch or exact commit ref.',
    inputSchema: { repository, ref, maxItems },
    outputSchema: { commits: z.array(z.object({ sha: z.string(), message: z.string(), authorName: z.string().optional(), authoredAt: z.string().optional(), htmlUrl: z.string().optional() })) }, annotations: READ,
  }, guarded('github_commits', async ({ repository, ref, maxItems }) => { requireGithub('github:read', { repository }); return { target: repository, result: { commits: await executor.githubCommits(repository, ref, maxItems) } }; }));

  server.registerTool('github_pull_requests', {
    title: 'List GitHub pull requests', description: 'List bounded pull-request metadata for one repository on a trusted GitHub account.',
    inputSchema: { repository, state: z.enum(['open', 'closed', 'all']).optional(), maxItems }, outputSchema: { pulls: z.array(z.object(PULL_SCHEMA)) }, annotations: READ,
  }, guarded('github_pull_requests', async ({ repository, state, maxItems }) => { requireGithub('github:read', { repository }); return { target: repository, result: { pulls: await executor.githubPulls(repository, state, maxItems) } }; }));

  server.registerTool('github_pull_request', {
    title: 'Read a GitHub pull request', description: 'Read bounded metadata for one pull request on a trusted GitHub account.',
    inputSchema: { repository, number: prNumber }, outputSchema: PULL_SCHEMA, annotations: READ,
  }, guarded('github_pull_request', async ({ repository, number }) => { requireGithub('github:read', { repository }); return { target: repository, result: await executor.githubPull(repository, number) }; }));

  server.registerTool('github_pull_request_files', {
    title: 'Review GitHub pull-request files', description: 'Read a bounded page of changed files and bounded patch text for a pull request.',
    inputSchema: { repository, number: prNumber, maxItems },
    outputSchema: { files: z.array(z.object({ filename: z.string(), status: z.string(), additions: z.number().int(), deletions: z.number().int(), changes: z.number().int(), patch: z.string().optional() })) }, annotations: READ,
  }, guarded('github_pull_request_files', async ({ repository, number, maxItems }) => { requireGithub('github:read', { repository }); return { target: repository, result: { files: await executor.githubPullFiles(repository, number, maxItems) } }; }));

  server.registerTool('github_issues', {
    title: 'List GitHub issues', description: 'List bounded issue metadata for one repository on a trusted GitHub account. Pull requests are excluded from this issue list.',
    inputSchema: { repository, state: z.enum(['open', 'closed', 'all']).optional(), maxItems }, outputSchema: { issues: z.array(z.object(ISSUE_SCHEMA)) }, annotations: READ,
  }, guarded('github_issues', async ({ repository, state, maxItems }) => { requireGithub('github:read', { repository }); return { target: repository, result: { issues: await executor.githubIssues(repository, state, maxItems) } }; }));

  server.registerTool('github_issue', {
    title: 'Read a GitHub issue', description: 'Read bounded issue metadata and body for one issue on a trusted GitHub account.',
    inputSchema: { repository, number: prNumber }, outputSchema: { ...ISSUE_SCHEMA, body: z.string().optional(), locked: z.boolean() }, annotations: READ,
  }, guarded('github_issue', async ({ repository, number }) => { requireGithub('github:read', { repository }); return { target: repository, result: await executor.githubIssue(repository, number) }; }));

  server.registerTool('github_issue_comments', {
    title: 'Read GitHub issue comments', description: 'Read up to 100 bounded comments for one issue on a trusted GitHub account.',
    inputSchema: { repository, number: prNumber, maxItems }, outputSchema: { comments: z.array(z.object(COMMENT_SCHEMA)) }, annotations: READ,
  }, guarded('github_issue_comments', async ({ repository, number, maxItems }) => { requireGithub('github:read', { repository }); return { target: repository, result: { comments: await executor.githubIssueComments(repository, number, maxItems) } }; }));

  server.registerTool('github_pull_request_reviews', {
    title: 'Read GitHub pull-request reviews', description: 'Read up to 100 submitted reviews for one pull request on a trusted GitHub account.',
    inputSchema: { repository, number: prNumber, maxItems }, outputSchema: { reviews: z.array(z.object(REVIEW_SCHEMA)) }, annotations: READ,
  }, guarded('github_pull_request_reviews', async ({ repository, number, maxItems }) => { requireGithub('github:read', { repository }); return { target: repository, result: { reviews: await executor.githubPullReviews(repository, number, maxItems) } }; }));

  server.registerTool('github_pull_request_review_comments', {
    title: 'Read GitHub pull-request review comments', description: 'Read up to 100 bounded code-review comments for one pull request on a trusted GitHub account.',
    inputSchema: { repository, number: prNumber, maxItems }, outputSchema: { comments: z.array(z.object({ ...COMMENT_SCHEMA, path: z.string(), line: z.number().int().optional(), side: z.string().optional(), commitId: z.string().optional() })) }, annotations: READ,
  }, guarded('github_pull_request_review_comments', async ({ repository, number, maxItems }) => { requireGithub('github:read', { repository }); return { target: repository, result: { comments: await executor.githubPullReviewComments(repository, number, maxItems) } }; }));

  server.registerTool('github_checks', {
    title: 'Read GitHub commit statuses', description: 'Read bounded commit-status state for a branch or exact commit ref. checkRuns is retained for response compatibility and is empty because QuaranHUB does not request GitHub Checks permission.',
    inputSchema: { repository, ref },
    outputSchema: { ref: z.string(), checkRuns: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().optional(), htmlUrl: z.string().optional() })), statuses: z.array(z.object({ context: z.string(), state: z.string(), description: z.string().optional(), targetUrl: z.string().optional() })) }, annotations: READ,
  }, guarded('github_checks', async ({ repository, ref }) => { requireGithub('github:read', { repository }); return { target: repository, result: await executor.githubChecks(repository, ref) }; }));

  server.registerTool('github_push_branch', {
    title: 'Publish an exact local commit to a GitHub branch',
    description: 'Push one exact current HEAD from an explicitly mapped local QuaranGate project to its trusted non-protected remote branch. Force-push, arbitrary remote URLs, default/protected branch pushes, tag pushes, deletes, and Docker options are not expressible.',
    inputSchema: { project, expectedHead: z.string().regex(GITHUB_COMMIT_PATTERN), remoteBranch: branch },
    outputSchema: { project: z.string(), remoteBranch: z.string(), sha: z.string() }, annotations: REMOTE_WRITE,
  }, guarded('github_push_branch', async ({ project, expectedHead, remoteBranch }) => { requireGithub('github:write', { project }); return { target: project, result: await executor.githubPush(project, expectedHead, remoteBranch) }; }));

  server.registerTool('github_pull_request_create', {
    title: 'Create a GitHub pull request', description: 'Create a pull request in one repository on a trusted GitHub account. This cannot merge the pull request.',
    inputSchema: { repository, head: branch, base: branch, title: z.string().min(1).max(GITHUB_MAX_TITLE_CHARS), body: z.string().max(GITHUB_MAX_BODY_CHARS).optional(), draft: z.boolean().optional() },
    outputSchema: PULL_SCHEMA, annotations: REMOTE_WRITE,
  }, guarded('github_pull_request_create', async ({ repository, ...req }) => { requireGithub('github:write', { repository }); return { target: repository, result: await executor.githubPullCreate(repository, req) }; }));

  server.registerTool('github_pull_request_update', {
    title: 'Update a GitHub pull request', description: 'Update title/body or open/closed state for a pull request on a trusted GitHub account. Merge is not supported.',
    inputSchema: { repository, number: prNumber, title: z.string().min(1).max(GITHUB_MAX_TITLE_CHARS).optional(), body: z.string().max(GITHUB_MAX_BODY_CHARS).optional(), state: z.enum(['open', 'closed']).optional() },
    outputSchema: PULL_SCHEMA, annotations: REMOTE_WRITE,
  }, guarded('github_pull_request_update', async ({ repository, ...req }) => {
    requireGithub('github:write', { repository });
    if (req.title === undefined && req.body === undefined && req.state === undefined) throw new BridgeError('MALFORMED_REQUEST', 'at least one PR update field is required', 400);
    return { target: repository, result: await executor.githubPullUpdate(repository, req) };
  }));

  server.registerTool('github_pull_request_review', {
    title: 'Submit a GitHub pull-request review', description: 'Submit COMMENT, APPROVE, or REQUEST_CHANGES on a trusted-account pull request. This cannot merge or alter repository settings.',
    inputSchema: { repository, number: prNumber, event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']), body: z.string().max(GITHUB_MAX_BODY_CHARS).optional() },
    outputSchema: { id: z.number().int(), state: z.string(), htmlUrl: z.string().optional() }, annotations: REMOTE_WRITE,
  }, guarded('github_pull_request_review', async ({ repository, ...req }) => { requireGithub('github:review', { repository }); return { target: repository, result: await executor.githubPullReview(repository, req) }; }));
}
