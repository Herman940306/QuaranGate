/** Private executor routes for the bounded GitHub control plane. */
import type express from 'express';
import { z } from 'zod';
import { BridgeError } from '../shared/errors.js';
import {
  GITHUB_BRANCH_PATTERN,
  GITHUB_COMMIT_PATTERN,
  GITHUB_MAX_BODY_CHARS,
  GITHUB_MAX_LIST_ITEMS,
  GITHUB_MAX_TITLE_CHARS,
  GITHUB_PROJECT_ID_PATTERN,
  GITHUB_REPOSITORY_KEY_PATTERN,
} from '../shared/github.js';
import type { GitHubControl } from './githubControl.js';

type Handle = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;

const project = z.string().regex(GITHUB_PROJECT_ID_PATTERN);
const repository = z.string().regex(GITHUB_REPOSITORY_KEY_PATTERN);
const branch = z.string().regex(GITHUB_BRANCH_PATTERN);
const ref = z.string().refine((v) => GITHUB_BRANCH_PATTERN.test(v) || GITHUB_COMMIT_PATTERN.test(v), 'invalid GitHub ref');
const number = z.number().int().min(1).max(2_147_483_647);
const maxItems = z.number().int().min(1).max(GITHUB_MAX_LIST_ITEMS).optional();

function parse<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const p = schema.safeParse(raw);
  if (!p.success) {
    const issue = p.error.issues[0];
    throw new BridgeError('MALFORMED_REQUEST', `${what}: ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`, 400);
  }
  return p.data;
}

export function registerGitHubRoutes(app: express.Express, handle: Handle, getControl: () => GitHubControl | null): void {
  const control = (): GitHubControl => {
    const c = getControl();
    if (!c) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GitHub control plane is not configured on this executor', 503);
    return c;
  };

  app.get('/github/repositories', handle(async () => ({ repositories: await control().listRepositories() })));

  app.post('/github/repository', handle(async (req) => {
    const body = parse(z.object({ repository }).strict(), req.body ?? {}, 'github repository');
    return { repository: await control().repository(body.repository) };
  }));

  app.post('/github/branches', handle(async (req) => {
    const body = parse(z.object({ repository, maxItems }).strict(), req.body ?? {}, 'github branches');
    return { branches: await control().branches(body.repository, body.maxItems) };
  }));

  app.post('/github/commits', handle(async (req) => {
    const body = parse(z.object({ repository, ref, maxItems }).strict(), req.body ?? {}, 'github commits');
    return { commits: await control().commits(body.repository, body.ref, body.maxItems) };
  }));

  app.post('/github/pulls', handle(async (req) => {
    const body = parse(z.object({ repository, state: z.enum(['open', 'closed', 'all']).optional(), maxItems }).strict(), req.body ?? {}, 'github pulls');
    return { pulls: await control().pulls(body.repository, body.state, body.maxItems) };
  }));

  app.post('/github/pull', handle(async (req) => {
    const body = parse(z.object({ repository, number }).strict(), req.body ?? {}, 'github pull');
    return { pull: await control().pull(body.repository, body.number) };
  }));

  app.post('/github/pull/files', handle(async (req) => {
    const body = parse(z.object({ repository, number, maxItems }).strict(), req.body ?? {}, 'github pull files');
    return { files: await control().pullFiles(body.repository, body.number, body.maxItems) };
  }));

  app.post('/github/issues', handle(async (req) => {
    const body = parse(z.object({ repository, state: z.enum(['open', 'closed', 'all']).optional(), maxItems }).strict(), req.body ?? {}, 'github issues');
    return { issues: await control().issues(body.repository, body.state, body.maxItems) };
  }));

  app.post('/github/issue', handle(async (req) => {
    const body = parse(z.object({ repository, number }).strict(), req.body ?? {}, 'github issue');
    return { issue: await control().issue(body.repository, body.number) };
  }));

  app.post('/github/issue/comments', handle(async (req) => {
    const body = parse(z.object({ repository, number, maxItems }).strict(), req.body ?? {}, 'github issue comments');
    return { comments: await control().issueComments(body.repository, body.number, body.maxItems) };
  }));

  app.post('/github/pull/reviews', handle(async (req) => {
    const body = parse(z.object({ repository, number, maxItems }).strict(), req.body ?? {}, 'github pull reviews');
    return { reviews: await control().pullReviews(body.repository, body.number, body.maxItems) };
  }));

  app.post('/github/pull/review-comments', handle(async (req) => {
    const body = parse(z.object({ repository, number, maxItems }).strict(), req.body ?? {}, 'github pull review comments');
    return { comments: await control().pullReviewComments(body.repository, body.number, body.maxItems) };
  }));

  app.post('/github/checks', handle(async (req) => {
    const body = parse(z.object({ repository, ref }).strict(), req.body ?? {}, 'github checks');
    return { checks: await control().checks(body.repository, body.ref) };
  }));

  // Direct push is intentionally NOT repository-driven. It requires an explicit
  // trusted local project mapping so the executor can verify the exact local
  // HEAD and resolve the remote itself.
  app.post('/github/push', handle(async (req) => {
    const body = parse(z.object({ project, expectedHead: z.string().regex(GITHUB_COMMIT_PATTERN), remoteBranch: branch }).strict(), req.body ?? {}, 'github push');
    return { push: await control().pushBranch(body.project, body.expectedHead, body.remoteBranch) };
  }));

  app.post('/github/pull/create', handle(async (req) => {
    const body = parse(z.object({
      repository, head: branch, base: branch,
      title: z.string().min(1).max(GITHUB_MAX_TITLE_CHARS),
      body: z.string().max(GITHUB_MAX_BODY_CHARS).optional(),
      draft: z.boolean().optional(),
    }).strict(), req.body ?? {}, 'github pull create');
    return { pull: await control().createPull(body.repository, body) };
  }));

  app.post('/github/pull/update', handle(async (req) => {
    const body = parse(z.object({
      repository, number,
      title: z.string().min(1).max(GITHUB_MAX_TITLE_CHARS).optional(),
      body: z.string().max(GITHUB_MAX_BODY_CHARS).optional(),
      state: z.enum(['open', 'closed']).optional(),
    }).strict().refine((v) => v.title !== undefined || v.body !== undefined || v.state !== undefined, 'at least one update field required'), req.body ?? {}, 'github pull update');
    return { pull: await control().updatePull(body.repository, body) };
  }));

  app.post('/github/pull/review', handle(async (req) => {
    const body = parse(z.object({
      repository, number,
      event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
      body: z.string().max(GITHUB_MAX_BODY_CHARS).optional(),
    }).strict(), req.body ?? {}, 'github pull review');
    return { review: await control().reviewPull(body.repository, body) };
  }));
}
