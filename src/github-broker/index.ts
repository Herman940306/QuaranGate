/**
 * Private GitHub App broker.
 *
 * Security boundary:
 * - the GitHub App private key is mounted ONLY into this service;
 * - this service has NO Docker socket and NO project filesystem mounts;
 * - it is unpublished and reachable only over the QuaranGate internal network;
 * - callers cannot provide arbitrary URLs: every route expands one fixed GitHub
 *   REST endpoint family from separately validated owner/repo/ref inputs;
 * - discovery tokens are installation-wide but metadata-read only and are used
 *   solely to enumerate repositories granted to a trusted All-repositories
 *   installation; operation tokens are scoped to one repository and the minimum
 *   permission set for that operation.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import { ProxyAgent, request } from 'undici';
import { BridgeError, asBridgeError } from '../shared/errors.js';
import { isTrustedGitHubOwner, loadGitHubConfig } from '../executor/githubConfig.js';
import {
  GITHUB_API_VERSION,
  GITHUB_BRANCH_PATTERN,
  GITHUB_COMMIT_PATTERN,
  GITHUB_MAX_API_RESPONSE_BYTES,
  GITHUB_MAX_BODY_CHARS,
  GITHUB_MAX_DISCOVERED_REPOSITORIES,
  GITHUB_MAX_INSTALLATION_PAGES,
  GITHUB_MAX_LIST_ITEMS,
  GITHUB_MAX_READ_BODY_CHARS,
  GITHUB_MAX_TITLE_CHARS,
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_PATTERN,
  type GitHubReviewEvent,
} from '../shared/github.js';

const PORT = Number(process.env.GITHUB_BROKER_PORT ?? 8789);
const TOKEN = process.env.INTERNAL_TOKEN ?? '';
const APP_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID ?? '';
const PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? '/run/secrets/github-app-private-key';
const GITHUB_CONFIG_PATH = process.env.GITHUB_CONFIG ?? '/config/github.yaml';
const PROXY_URL = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
const API = 'https://api.github.com';
const dispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

if (!TOKEN || TOKEN === '<SET_SECURELY>') {
  console.error('FATAL: INTERNAL_TOKEN is not set');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{8,128}$/.test(APP_CLIENT_ID)) {
  console.error('FATAL: GITHUB_APP_CLIENT_ID is missing or malformed');
  process.exit(1);
}
try {
  const proxy = new URL(PROXY_URL);
  if (proxy.protocol !== 'http:' || proxy.username || proxy.password || proxy.hostname !== 'github-egress-proxy' || proxy.port !== '8080') {
    throw new Error('unexpected proxy endpoint');
  }
} catch {
  console.error('FATAL: HTTPS_PROXY must be http://github-egress-proxy:8080');
  process.exit(1);
}
if (!fs.existsSync(PRIVATE_KEY_PATH)) {
  console.error('FATAL: GitHub App private key file is missing');
  process.exit(1);
}

let privateKey: crypto.KeyObject;
try {
  const pem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
} catch {
  console.error('FATAL: GitHub App private key file is not a readable RSA private key');
  process.exit(1);
}

let trustedConfig: ReturnType<typeof loadGitHubConfig>;
try {
  trustedConfig = loadGitHubConfig(GITHUB_CONFIG_PATH);
} catch {
  console.error('FATAL: trusted GitHub account registry is missing or invalid');
  process.exit(1);
}

function validateTrustedOwner(owner: string): void {
  if (!isTrustedGitHubOwner(trustedConfig, owner)) {
    throw new BridgeError('FORBIDDEN_GITHUB_ACCOUNT', `GitHub account ${owner} is not trusted by the broker`, 403);
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function appJwt(nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // GitHub recommends a small backwards skew for clock drift and a short JWT.
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: APP_CLIENT_ID }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

function validateRepo(owner: unknown, repo: unknown): { owner: string; repo: string } {
  if (typeof owner !== 'string' || !GITHUB_OWNER_PATTERN.test(owner)) throw new BridgeError('MALFORMED_REQUEST', 'invalid GitHub owner', 400);
  if (typeof repo !== 'string' || !GITHUB_REPO_PATTERN.test(repo)) throw new BridgeError('MALFORMED_REQUEST', 'invalid GitHub repository', 400);
  validateTrustedOwner(owner);
  return { owner, repo };
}

function validateRef(ref: unknown): string {
  if (typeof ref !== 'string' || !(GITHUB_BRANCH_PATTERN.test(ref) || GITHUB_COMMIT_PATTERN.test(ref))) {
    throw new BridgeError('MALFORMED_REQUEST', 'invalid GitHub ref', 400);
  }
  return ref;
}

function validateNumber(n: unknown, what: string): number {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 2_147_483_647) throw new BridgeError('MALFORMED_REQUEST', `invalid ${what}`, 400);
  return v;
}

function listLimit(n: unknown): number {
  const v = n === undefined ? 30 : Number(n);
  if (!Number.isInteger(v) || v < 1 || v > GITHUB_MAX_LIST_ITEMS) throw new BridgeError('MALFORMED_REQUEST', `maxItems must be 1..${GITHUB_MAX_LIST_ITEMS}`, 400);
  return v;
}

function boundedText(v: unknown, max: number, what: string, allowEmpty = true): string {
  if (typeof v !== 'string' || (!allowEmpty && v.length === 0) || v.length > max) throw new BridgeError('MALFORMED_REQUEST', `${what} must be ${allowEmpty ? '0' : '1'}..${max} characters`, 400);
  return v;
}

type Method = 'GET' | 'POST' | 'PATCH';

async function readBoundedBody(body: AsyncIterable<Uint8Array> & { destroy?: () => void }, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const b = Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      body.destroy?.();
      throw new BridgeError('GITHUB_API_ERROR', `GitHub API response exceeded ${maxBytes} bytes`, 502);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function rawGitHub(method: Method, path: string, auth: string, body?: unknown): Promise<{ status: number; json: any; requestId?: string }> {
  const res = await request(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${auth}`,
      'user-agent': 'QuaranGate-GitHub-Broker/0.1',
      'x-github-api-version': GITHUB_API_VERSION,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    dispatcher,
    headersTimeout: 15_000,
    bodyTimeout: 30_000,
  }).catch(() => {
    throw new BridgeError('GITHUB_UNAVAILABLE', 'GitHub API unreachable', 503);
  });
  const text = await readBoundedBody(res.body as unknown as AsyncIterable<Uint8Array> & { destroy?: () => void }, GITHUB_MAX_API_RESPONSE_BYTES);
  let json: any = {};
  if (text) {
    try { json = JSON.parse(text); }
    catch { json = {}; }
  }
  const requestId = typeof res.headers['x-github-request-id'] === 'string' ? res.headers['x-github-request-id'] : undefined;
  if (res.statusCode >= 400) {
    // Never echo GitHub response bodies: they can contain caller-controlled PR
    // text or permission diagnostics. Status + request id are sufficient.
    throw new BridgeError('GITHUB_API_ERROR', `GitHub API returned ${res.statusCode}${requestId ? ` request=${requestId}` : ''}`, res.statusCode >= 500 ? 502 : res.statusCode);
  }
  return { status: res.statusCode, json, requestId };
}

const installationCache = new Map<string, number>();
interface TokenCacheEntry { token: string; expiresAtMs: number }
const tokenCache = new Map<string, TokenCacheEntry>();

async function installationId(owner: string, repo: string): Promise<number> {
  const slug = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = installationCache.get(slug);
  if (cached) return cached;
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, appJwt());
  const id = Number(r.json?.id);
  if (!Number.isInteger(id) || id <= 0) throw new BridgeError('GITHUB_API_ERROR', 'GitHub installation response missing id', 502);
  installationCache.set(slug, id);
  return id;
}

async function installationToken(owner: string, repo: string, permissions: Record<string, 'read' | 'write'>): Promise<{ token: string; expiresAt: string }> {
  const permissionKey = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(',');
  const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}|${permissionKey}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60_000) {
    return { token: cached.token, expiresAt: new Date(cached.expiresAtMs).toISOString() };
  }
  const id = await installationId(owner, repo);
  const r = await rawGitHub('POST', `/app/installations/${id}/access_tokens`, appJwt(), {
    repositories: [repo],
    permissions,
  });
  const token = r.json?.token;
  const expiresAt = r.json?.expires_at;
  if (typeof token !== 'string' || token.length < 20 || typeof expiresAt !== 'string') {
    throw new BridgeError('GITHUB_API_ERROR', 'GitHub installation token response invalid', 502);
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) throw new BridgeError('GITHUB_API_ERROR', 'GitHub installation token expiry invalid', 502);
  tokenCache.set(cacheKey, { token, expiresAtMs });
  return { token, expiresAt };
}

async function installationIdForAccount(owner: string): Promise<number> {
  if (!GITHUB_OWNER_PATTERN.test(owner)) throw new BridgeError('MALFORMED_REQUEST', 'invalid GitHub owner', 400);
  const key = owner.toLowerCase();

  for (let page = 1; page <= GITHUB_MAX_INSTALLATION_PAGES; page++) {
    const r = await rawGitHub('GET', `/app/installations?per_page=100&page=${page}`, appJwt());
    const rows = Array.isArray(r.json) ? r.json : [];
    for (const installation of rows) {
      const login = typeof installation?.account?.login === 'string' ? installation.account.login : '';
      const id = Number(installation?.id);
      if (login.toLowerCase() === key && Number.isInteger(id) && id > 0) {
        if (installation?.suspended_at != null) {
          throw new BridgeError('GITHUB_NOT_CONFIGURED', `QuaranHUB installation on ${owner} is suspended`, 503);
        }
        if (installation?.repository_selection !== 'all') {
          throw new BridgeError('GITHUB_NOT_CONFIGURED', `QuaranHUB installation on ${owner} must use All repositories`, 503);
        }
        return id;
      }
    }
    if (rows.length < 100) break;
  }
  throw new BridgeError('GITHUB_API_ERROR', `QuaranHUB is not installed on trusted account ${owner}`, 404);
}

async function installationWideToken(owner: string, permissions: Record<string, 'read' | 'write'>): Promise<{ token: string; expiresAt: string }> {
  // Discovery deliberately does not cache account-wide installation state or
  // tokens. Every discovery call re-verifies that the trusted installation is
  // active and still configured for All repositories before minting a fresh,
  // metadata-only installation token. This makes a later GitHub-side scope
  // reduction fail closed instead of being masked by an hour-long cache.
  const id = await installationIdForAccount(owner);
  const r = await rawGitHub('POST', `/app/installations/${id}/access_tokens`, appJwt(), { permissions });
  const token = r.json?.token;
  const expiresAt = r.json?.expires_at;
  if (typeof token !== 'string' || token.length < 20 || typeof expiresAt !== 'string') {
    throw new BridgeError('GITHUB_API_ERROR', 'GitHub installation token response invalid', 502);
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) throw new BridgeError('GITHUB_API_ERROR', 'GitHub installation token expiry invalid', 502);
  return { token, expiresAt };
}

async function repositoriesForAccount(owner: string): Promise<any[]> {
  const token = (await installationWideToken(owner, { metadata: 'read' })).token;
  const repositories: any[] = [];
  for (let page = 1; page <= GITHUB_MAX_INSTALLATION_PAGES; page++) {
    const r = await rawGitHub('GET', `/installation/repositories?per_page=100&page=${page}`, token);
    const rows = Array.isArray(r.json?.repositories) ? r.json.repositories : [];
    for (const repo of rows) {
      if (repositories.length >= GITHUB_MAX_DISCOVERED_REPOSITORIES) {
        throw new BridgeError('GITHUB_API_ERROR', `GitHub repository discovery exceeded ${GITHUB_MAX_DISCOVERED_REPOSITORIES} entries`, 502);
      }
      repositories.push(repo);
    }
    if (rows.length < 100) break;
  }
  return repositories;
}

const app = express();
app.use(express.json({ limit: '512kb' }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  if (req.header('x-internal-token') !== TOKEN) { res.status(401).json({ error: 'UNAUTHENTICATED', message: 'bad internal token' }); return; }
  next();
});

function handle(fn: (body: any) => Promise<any>) {
  return (req: express.Request, res: express.Response) => {
    fn(req.body ?? {}).then((body) => res.json(body)).catch((e) => {
      const be = asBridgeError(e);
      res.status(be.httpStatus).json(be.toJSON());
    });
  };
}

async function metadataReadToken(owner: string, repo: string): Promise<string> {
  return (await installationToken(owner, repo, { metadata: 'read' })).token;
}
async function contentsReadToken(owner: string, repo: string): Promise<string> {
  return (await installationToken(owner, repo, { contents: 'read' })).token;
}
async function pullReadToken(owner: string, repo: string): Promise<string> {
  return (await installationToken(owner, repo, { pull_requests: 'read' })).token;
}
async function issuesReadToken(owner: string, repo: string): Promise<string> {
  return (await installationToken(owner, repo, { issues: 'read' })).token;
}
async function statusesReadToken(owner: string, repo: string): Promise<string> {
  return (await installationToken(owner, repo, { statuses: 'read' })).token;
}

app.post('/repositories', handle(async (body) => {
  if (typeof body.owner !== 'string' || !GITHUB_OWNER_PATTERN.test(body.owner)) throw new BridgeError('MALFORMED_REQUEST', 'invalid GitHub owner', 400);
  validateTrustedOwner(body.owner);
  return { repositories: await repositoriesForAccount(body.owner) };
}));

app.post('/repository', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const token = await metadataReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
  return { repository: r.json };
}));

app.post('/branches', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const maxItems = listLimit(body.maxItems);
  const token = await contentsReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${maxItems}`, token);
  return { branches: r.json };
}));

app.post('/branch', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const branch = validateRef(body.branch);
  if (GITHUB_COMMIT_PATTERN.test(branch)) throw new BridgeError('MALFORMED_REQUEST', 'branch route requires a branch name', 400);
  const token = await contentsReadToken(owner, repo);
  try {
    const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`, token);
    return { branch: r.json };
  } catch (e) {
    if (e instanceof BridgeError && e.httpStatus === 404) return { branch: null };
    throw e;
  }
}));

app.post('/commits', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const ref = validateRef(body.ref);
  const maxItems = listLimit(body.maxItems);
  const token = await contentsReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(ref)}&per_page=${maxItems}`, token);
  return { commits: r.json };
}));

app.post('/pulls', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const state = body.state === undefined ? 'open' : body.state;
  if (!['open', 'closed', 'all'].includes(state)) throw new BridgeError('MALFORMED_REQUEST', 'state must be open, closed, or all', 400);
  const maxItems = listLimit(body.maxItems);
  const token = await pullReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=${maxItems}`, token);
  return { pulls: r.json };
}));

app.post('/pull', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const number = validateNumber(body.number, 'pull request number');
  const token = await pullReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, token);
  return { pull: r.json };
}));

app.post('/pull/files', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const number = validateNumber(body.number, 'pull request number');
  const maxItems = listLimit(body.maxItems);
  const token = await pullReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=${maxItems}`, token);
  // Patches are caller-visible source; bound each one and the page remains bounded.
  const files = Array.isArray(r.json) ? r.json.map((f: any) => ({ ...f, patch: typeof f.patch === 'string' ? f.patch.slice(0, 8192) : undefined })) : [];
  return { files };
}));

app.post('/issues', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const state = body.state === undefined ? 'open' : body.state;
  if (!['open', 'closed', 'all'].includes(state)) throw new BridgeError('MALFORMED_REQUEST', 'state must be open, closed, or all', 400);
  const maxItems = listLimit(body.maxItems);
  const token = await issuesReadToken(owner, repo);
  const issues: any[] = [];
  for (let page = 1; page <= 10 && issues.length < maxItems; page++) {
    const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=100&page=${page}`, token);
    const rows = Array.isArray(r.json) ? r.json : [];
    for (const row of rows) {
      if (row?.pull_request) continue;
      issues.push(row);
      if (issues.length >= maxItems) break;
    }
    if (rows.length < 100) break;
  }
  return { issues };
}));

app.post('/issue', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const number = validateNumber(body.number, 'issue number');
  const token = await issuesReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, token);
  if (r.json?.pull_request) throw new BridgeError('GITHUB_API_ERROR', 'requested number is a pull request, not an issue', 404);
  return { issue: { ...r.json, body: typeof r.json?.body === 'string' ? r.json.body.slice(0, GITHUB_MAX_READ_BODY_CHARS) : undefined } };
}));

app.post('/issue/comments', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const number = validateNumber(body.number, 'issue number');
  const maxItems = listLimit(body.maxItems);
  const token = await issuesReadToken(owner, repo);
  const issue = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, token);
  if (issue.json?.pull_request) throw new BridgeError('GITHUB_API_ERROR', 'requested number is a pull request, not an issue', 404);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?per_page=${maxItems}`, token);
  const comments = Array.isArray(r.json) ? r.json.map((c: any) => ({ ...c, body: typeof c.body === 'string' ? c.body.slice(0, GITHUB_MAX_READ_BODY_CHARS) : '' })) : [];
  return { comments };
}));

app.post('/pull/reviews', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const number = validateNumber(body.number, 'pull request number');
  const maxItems = listLimit(body.maxItems);
  const token = await pullReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews?per_page=${maxItems}`, token);
  const reviews = Array.isArray(r.json) ? r.json.map((review: any) => ({ ...review, body: typeof review.body === 'string' ? review.body.slice(0, GITHUB_MAX_READ_BODY_CHARS) : undefined })) : [];
  return { reviews };
}));

app.post('/pull/review-comments', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const number = validateNumber(body.number, 'pull request number');
  const maxItems = listLimit(body.maxItems);
  const token = await pullReadToken(owner, repo);
  const r = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments?per_page=${maxItems}`, token);
  const comments = Array.isArray(r.json) ? r.json.map((c: any) => ({ ...c, body: typeof c.body === 'string' ? c.body.slice(0, GITHUB_MAX_READ_BODY_CHARS) : '' })) : [];
  return { comments };
}));

app.post('/checks', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const ref = validateRef(body.ref);
  // Owner-approved QuaranHUB policy intentionally does not grant Checks access.
  // Keep the public response shape stable while reading only commit statuses.
  const token = await statusesReadToken(owner, repo);
  const statuses = await rawGitHub('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/status`, token);
  return { checks: { total_count: 0, check_runs: [] }, statuses: statuses.json };
}));

app.post('/pull/create', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const head = validateRef(body.head);
  const base = validateRef(body.base);
  const title = boundedText(body.title, GITHUB_MAX_TITLE_CHARS, 'title', false);
  const prBody = boundedText(body.body ?? '', GITHUB_MAX_BODY_CHARS, 'body');
  const draft = Boolean(body.draft);
  const token = (await installationToken(owner, repo, { pull_requests: 'write' })).token;
  const r = await rawGitHub('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, token, { title, body: prBody, head, base, draft });
  return { pull: r.json };
}));

app.post('/pull/update', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const number = validateNumber(body.number, 'pull request number');
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = boundedText(body.title, GITHUB_MAX_TITLE_CHARS, 'title', false);
  if (body.body !== undefined) patch.body = boundedText(body.body, GITHUB_MAX_BODY_CHARS, 'body');
  if (body.state !== undefined) {
    if (!['open', 'closed'].includes(body.state)) throw new BridgeError('MALFORMED_REQUEST', 'state must be open or closed', 400);
    patch.state = body.state;
  }
  if (Object.keys(patch).length === 0) throw new BridgeError('MALFORMED_REQUEST', 'at least one PR field is required', 400);
  const token = (await installationToken(owner, repo, { pull_requests: 'write' })).token;
  const r = await rawGitHub('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, token, patch);
  return { pull: r.json };
}));

app.post('/pull/review', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  const number = validateNumber(body.number, 'pull request number');
  const event = body.event as GitHubReviewEvent;
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) throw new BridgeError('MALFORMED_REQUEST', 'invalid review event', 400);
  const reviewBody = boundedText(body.body ?? '', GITHUB_MAX_BODY_CHARS, 'review body', event === 'COMMENT' || event === 'APPROVE');
  if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && reviewBody.length === 0) throw new BridgeError('MALFORMED_REQUEST', `${event} requires a review body`, 400);
  const token = (await installationToken(owner, repo, { pull_requests: 'write' })).token;
  const r = await rawGitHub('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`, token, { event, body: reviewBody });
  return { review: r.json };
}));

app.post('/push-token', handle(async (body) => {
  const { owner, repo } = validateRepo(body.owner, body.repo);
  // Only the private executor may call this route. The token is one-repository,
  // contents-write only, and expires in at most one hour per GitHub's contract.
  return installationToken(owner, repo, { contents: 'write' });
}));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'github broker listening', port: PORT }));
});
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
