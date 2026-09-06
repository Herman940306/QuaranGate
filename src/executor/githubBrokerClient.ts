/** Private HTTP client from executor to the GitHub App broker. */
import { request } from 'undici';
import { BridgeError } from '../shared/errors.js';
import { GITHUB_MAX_API_RESPONSE_BYTES } from '../shared/github.js';

const BASE = process.env.GITHUB_BROKER_URL ?? '';
const TOKEN = process.env.INTERNAL_TOKEN ?? '';

async function readBoundedBody(body: AsyncIterable<Uint8Array> & { destroy?: () => void }): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const b = Buffer.from(chunk);
    total += b.length;
    if (total > GITHUB_MAX_API_RESPONSE_BYTES) {
      body.destroy?.();
      throw new BridgeError('GITHUB_UNAVAILABLE', 'GitHub broker response exceeded bounded size', 502);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function call<T>(path: string, body: unknown): Promise<T> {
  if (!BASE) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GitHub broker URL is not configured', 503);
  const res = await request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-internal-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    headersTimeout: 15_000,
    bodyTimeout: 45_000,
  }).catch(() => {
    throw new BridgeError('GITHUB_UNAVAILABLE', 'GitHub broker unreachable', 503);
  });
  const text = await readBoundedBody(res.body as unknown as AsyncIterable<Uint8Array> & { destroy?: () => void });
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (res.statusCode >= 400) {
    throw new BridgeError((json.error ?? 'GITHUB_UNAVAILABLE') as never, json.message ?? 'GitHub broker error', res.statusCode);
  }
  return json as T;
}

export const githubBroker = {
  repositories: (owner: string) => call<{ repositories: any[] }>('/repositories', { owner }).then((r) => r.repositories),
  repository: (owner: string, repo: string) => call<{ repository: any }>('/repository', { owner, repo }).then((r) => r.repository),
  branches: (owner: string, repo: string, maxItems?: number) => call<{ branches: any[] }>('/branches', { owner, repo, maxItems }).then((r) => r.branches),
  branch: (owner: string, repo: string, branch: string) => call<{ branch: any | null }>('/branch', { owner, repo, branch }).then((r) => r.branch),
  commits: (owner: string, repo: string, ref: string, maxItems?: number) => call<{ commits: any[] }>('/commits', { owner, repo, ref, maxItems }).then((r) => r.commits),
  pulls: (owner: string, repo: string, state?: string, maxItems?: number) => call<{ pulls: any[] }>('/pulls', { owner, repo, state, maxItems }).then((r) => r.pulls),
  pull: (owner: string, repo: string, number: number) => call<{ pull: any }>('/pull', { owner, repo, number }).then((r) => r.pull),
  pullFiles: (owner: string, repo: string, number: number, maxItems?: number) => call<{ files: any[] }>('/pull/files', { owner, repo, number, maxItems }).then((r) => r.files),
  issues: (owner: string, repo: string, state?: string, maxItems?: number) => call<{ issues: any[] }>('/issues', { owner, repo, state, maxItems }).then((r) => r.issues),
  issue: (owner: string, repo: string, number: number) => call<{ issue: any }>('/issue', { owner, repo, number }).then((r) => r.issue),
  issueComments: (owner: string, repo: string, number: number, maxItems?: number) => call<{ comments: any[] }>('/issue/comments', { owner, repo, number, maxItems }).then((r) => r.comments),
  pullReviews: (owner: string, repo: string, number: number, maxItems?: number) => call<{ reviews: any[] }>('/pull/reviews', { owner, repo, number, maxItems }).then((r) => r.reviews),
  pullReviewComments: (owner: string, repo: string, number: number, maxItems?: number) => call<{ comments: any[] }>('/pull/review-comments', { owner, repo, number, maxItems }).then((r) => r.comments),
  checks: (owner: string, repo: string, ref: string) => call<{ checks: any; statuses: any }>('/checks', { owner, repo, ref }),
  createPull: (owner: string, repo: string, req: { head: string; base: string; title: string; body?: string; draft?: boolean }) =>
    call<{ pull: any }>('/pull/create', { owner, repo, ...req }).then((r) => r.pull),
  updatePull: (owner: string, repo: string, req: { number: number; title?: string; body?: string; state?: 'open' | 'closed' }) =>
    call<{ pull: any }>('/pull/update', { owner, repo, ...req }).then((r) => r.pull),
  reviewPull: (owner: string, repo: string, req: { number: number; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body?: string }) =>
    call<{ review: any }>('/pull/review', { owner, repo, ...req }).then((r) => r.review),
  pushToken: (owner: string, repo: string) => call<{ token: string; expiresAt: string }>('/push-token', { owner, repo }),
};
