/**
 * OAuth 2.1 façade for remote MCP browser clients.
 *
 * Security properties:
 *  - Dynamic Client Registration (RFC 7591) with validated redirect URIs
 *  - Authorization Code + PKCE S256 for public clients
 *  - Exact registered redirect URI matching
 *  - RFC 8707 resource binding for authorization, token, and refresh flows
 *  - Opaque access/refresh tokens stored only as SHA-256 hashes
 *  - Rotating refresh tokens
 *  - Per-client principal mapping remains identical to static API-key auth
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { authenticateKey } from './apikeys.js';
import type { Principal } from '../config.js';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const TOKENS_FILE = path.join(DATA_DIR, 'oauth-tokens.json');
const CLIENTS_FILE = path.join(DATA_DIR, 'oauth-clients.json');
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const DCR_CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REGISTERED_CLIENTS = 1000;
const OAUTH_SCOPES = ['offline_access'] as const;

interface StoredToken {
  principalId: string;
  clientId: string;
  resource: string;
  scope?: string;
  expiresAt: number;
  refresh?: boolean;
}

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  created: number;
}

interface AuthorizationCode {
  principalId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope?: string;
  expiresAt: number;
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function saveJson(file: string, value: unknown) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Authorization codes are intentionally short-lived and process-local.
const codes = new Map<string, AuthorizationCode>();

export function oauthResourceForPublicUrl(publicUrl: string): string {
  const base = new URL(publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`);
  const resource = new URL('mcp', base);
  resource.hash = '';
  resource.username = '';
  resource.password = '';
  resource.protocol = resource.protocol.toLowerCase();
  resource.hostname = resource.hostname.toLowerCase();
  if ((resource.protocol === 'https:' && resource.port === '443') || (resource.protocol === 'http:' && resource.port === '80')) {
    resource.port = '';
  }
  resource.pathname = resource.pathname.replace(/\/+$/, '') || '/';
  return resource.toString().replace(/\/$/, '');
}

function canonicalResource(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    url.username = '';
    url.password = '';
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isValidRedirectUri(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

function validCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

function registeredClient(clientId: string): RegisteredClient | null {
  const clients = loadJson<Record<string, RegisteredClient>>(CLIENTS_FILE, {});
  return clients[clientId] ?? null;
}

function clientRedirectAllowed(clientId: string, redirectUri: string): boolean {
  const client = registeredClient(clientId);
  return Boolean(client?.redirect_uris.includes(redirectUri));
}

function normalizeScope(raw: string | undefined): string | undefined | null {
  if (!raw) return undefined;
  const requested = [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (requested.some((scope) => !OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]))) return null;
  return requested.join(' ') || undefined;
}

function noStore(res: express.Response) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

export function tokenToPrincipalId(bearer: string, expectedResource: string): string | null {
  const tokens = loadJson<Record<string, StoredToken>>(TOKENS_FILE, {});
  const rec = tokens[hash(bearer)];
  if (!rec || rec.refresh || Date.now() > rec.expiresAt) return null;
  const expected = canonicalResource(expectedResource);
  return expected && rec.resource === expected ? rec.principalId : null;
}

function issueTokens(principalId: string, clientId: string, resource: string, scope?: string) {
  const tokens = loadJson<Record<string, StoredToken>>(TOKENS_FILE, {});
  const now = Date.now();
  for (const [key, value] of Object.entries(tokens)) {
    if (value.expiresAt < now) delete tokens[key];
  }

  const access = 'mcpb_at_' + randomBytes(32).toString('base64url');
  const refresh = 'mcpb_rt_' + randomBytes(32).toString('base64url');
  tokens[hash(access)] = { principalId, clientId, resource, scope, expiresAt: now + ACCESS_TTL_MS };
  tokens[hash(refresh)] = { principalId, clientId, resource, scope, expiresAt: now + REFRESH_TTL_MS, refresh: true };
  saveJson(TOKENS_FILE, tokens);

  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    ...(scope ? { scope } : {}),
  };
}

function secureHtml(res: express.Response) {
  noStore(res);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mountOAuth(app: express.Express, publicUrl: string): void {
  const resource = oauthResourceForPublicUrl(publicUrl);
  const meta = {
    resource,
    authorization_servers: [publicUrl],
  };

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    noStore(res);
    res.json(meta);
  });
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    noStore(res);
    res.json(meta);
  });

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    noStore(res);
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...OAUTH_SCOPES],
    });
  });

  // RFC 7591 DCR uses application/json.
  app.post('/oauth/register', express.json({ limit: '64kb' }), (req, res) => {
    noStore(res);
    const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    if (
      redirectUris.length === 0 ||
      redirectUris.length > 20 ||
      !redirectUris.every((uri: unknown): uri is string => typeof uri === 'string' && isValidRedirectUri(uri))
    ) {
      res.status(400).json({ error: 'invalid_redirect_uri' });
      return;
    }

    if (req.body?.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== 'none') {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'only public clients are supported' });
      return;
    }

    const grantTypes = Array.isArray(req.body?.grant_types) ? req.body.grant_types : ['authorization_code', 'refresh_token'];
    const responseTypes = Array.isArray(req.body?.response_types) ? req.body.response_types : ['code'];
    if (grantTypes.some((grant: unknown) => grant !== 'authorization_code' && grant !== 'refresh_token') || responseTypes.some((type: unknown) => type !== 'code')) {
      res.status(400).json({ error: 'invalid_client_metadata' });
      return;
    }

    const safeRedirectUris = [...new Set(redirectUris as string[])];
    const clientId = 'mcpb-client-' + randomUUID();
    const clients = loadJson<Record<string, RegisteredClient>>(CLIENTS_FILE, {});
    const cutoff = Date.now() - DCR_CLIENT_TTL_MS;
    for (const [id, client] of Object.entries(clients)) {
      if (client.created < cutoff) delete clients[id];
    }
    if (Object.keys(clients).length >= MAX_REGISTERED_CLIENTS) {
      saveJson(CLIENTS_FILE, clients);
      res.status(503).json({ error: 'temporarily_unavailable', error_description: 'client registration capacity reached' });
      return;
    }
    const registered: RegisteredClient = {
      client_id: clientId,
      redirect_uris: safeRedirectUris,
      created: Date.now(),
    };
    clients[clientId] = registered;
    saveJson(CLIENTS_FILE, clients);

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: registered.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  app.get('/oauth/authorize', (req, res) => {
    const {
      response_type,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      client_id,
      resource: requestedResource,
      scope: rawScope,
    } = req.query as Record<string, string>;

    const requestedCanonical = canonicalResource(requestedResource ?? '');
    const scope = normalizeScope(rawScope);
    if (
      response_type !== 'code' ||
      !client_id ||
      !redirect_uri ||
      !clientRedirectAllowed(client_id, redirect_uri) ||
      !code_challenge ||
      !validCodeChallenge(code_challenge) ||
      code_challenge_method !== 'S256' ||
      !requestedCanonical ||
      requestedCanonical !== resource ||
      scope === null
    ) {
      res.status(400).send('invalid_request');
      return;
    }

    let redirectHost = 'registered client';
    try { redirectHost = new URL(redirect_uri).host; } catch { /* already validated */ }
    secureHtml(res);
    res.type('html').send(`<!doctype html><html><head><meta charset=utf-8><title>Authorize MCP IDE Bridge</title>
<style>body{font-family:system-ui;max-width:460px;margin:6rem auto;padding:1rem}input{width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box}button{padding:.6rem 1rem}</style></head>
<body><h2>MCP IDE Bridge</h2><p>Authorize connection to <strong>${escapeHtml(redirectHost)}</strong>.</p><p>Paste the API key for the intended bridge client principal.</p>
<form method="POST" action="/oauth/authorize">
<input type="password" name="apikey" placeholder="mcpb_..." autocomplete="off" required>
<input type="hidden" name="response_type" value="code">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
<input type="hidden" name="state" value="${escapeHtml(state ?? '')}">
<input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
<input type="hidden" name="code_challenge_method" value="S256">
<input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
<input type="hidden" name="resource" value="${escapeHtml(resource)}">
<input type="hidden" name="scope" value="${escapeHtml(scope ?? '')}">
<button type="submit">Authorize</button></form></body></html>`);
  });

  app.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
    const {
      apikey,
      response_type,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      client_id,
      resource: requestedResource,
      scope: rawScope,
    } = req.body as Record<string, string>;

    const requestedCanonical = canonicalResource(requestedResource ?? '');
    const scope = normalizeScope(rawScope);
    if (
      response_type !== 'code' ||
      !client_id ||
      !redirect_uri ||
      !clientRedirectAllowed(client_id, redirect_uri) ||
      !code_challenge ||
      !validCodeChallenge(code_challenge) ||
      code_challenge_method !== 'S256' ||
      !requestedCanonical ||
      requestedCanonical !== resource ||
      scope === null
    ) {
      res.status(400).send('invalid_request');
      return;
    }

    let principal: Principal;
    try {
      principal = authenticateKey(apikey);
    } catch {
      secureHtml(res);
      res.status(401).type('html').send('<p>Invalid API key. Go back and try again.</p>');
      return;
    }

    const code = 'mcpb_ac_' + randomBytes(24).toString('base64url');
    codes.set(code, {
      principalId: principal.id,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      resource,
      scope,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    noStore(res);
    res.redirect(url.toString());
  });

  app.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
    noStore(res);
    const body = req.body as Record<string, string>;

    if (body.grant_type === 'authorization_code') {
      const rec = codes.get(body.code ?? '');
      if (!rec || Date.now() > rec.expiresAt) {
        if (body.code) codes.delete(body.code);
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }

      const requestedCanonical = canonicalResource(body.resource ?? '');
      const verifier = body.code_verifier ?? '';
      const verifierHash = base64url(createHash('sha256').update(verifier).digest());
      const valid =
        validCodeVerifier(verifier) &&
        body.client_id === rec.clientId &&
        body.redirect_uri === rec.redirectUri &&
        requestedCanonical === rec.resource &&
        safeEqual(verifierHash, rec.codeChallenge);

      // Authorization codes are single-use even after a failed redemption attempt.
      codes.delete(body.code!);
      if (!valid) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }

      res.json(issueTokens(rec.principalId, rec.clientId, rec.resource, rec.scope));
      return;
    }

    if (body.grant_type === 'refresh_token') {
      const tokens = loadJson<Record<string, StoredToken>>(TOKENS_FILE, {});
      const refreshHash = hash(body.refresh_token ?? '');
      const rec = tokens[refreshHash];
      const requestedCanonical = canonicalResource(body.resource ?? '');
      if (
        !rec ||
        !rec.refresh ||
        Date.now() > rec.expiresAt ||
        body.client_id !== rec.clientId ||
        requestedCanonical !== rec.resource
      ) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }

      // Rotate the public-client refresh token before issuing a new pair.
      delete tokens[refreshHash];
      saveJson(TOKENS_FILE, tokens);
      res.json(issueTokens(rec.principalId, rec.clientId, rec.resource, rec.scope));
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
