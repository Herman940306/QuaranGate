/**
 * Minimal OAuth 2.1 façade so browser clients (Claude / ChatGPT) that require
 * OAuth can authenticate. It is deliberately the smallest compatible surface:
 *  - Dynamic Client Registration (public clients, PKCE S256 required)
 *  - Authorization endpoint renders a form where the user pastes their bridge
 *    API key (that IS the login) -> maps to the same per-client principal.
 *  - Token endpoint exchanges code+PKCE for an opaque bearer (1h) + refresh (30d).
 * Tokens are stored hashed on disk (bridge-data volume). No user database.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

interface StoredToken { principalId: string; expiresAt: number; refresh?: boolean }
interface RegisteredClient { client_id: string; redirect_uris: string[]; created: number }

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function loadJson<T>(f: string, dflt: T): T {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return dflt; }
}
function saveJson(f: string, v: unknown) { ensureDir(); fs.writeFileSync(f, JSON.stringify(v), { mode: 0o600 }); }

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

// In-memory auth codes (short-lived).
const codes = new Map<string, { principalId: string; codeChallenge: string; redirectUri: string; clientId: string; expiresAt: number }>();

export function tokenToPrincipalId(bearer: string): string | null {
  const tokens = loadJson<Record<string, StoredToken>>(TOKENS_FILE, {});
  const rec = tokens[hash(bearer)];
  if (!rec || rec.refresh) return null;
  if (Date.now() > rec.expiresAt) return null;
  return rec.principalId;
}

function issueTokens(principalId: string) {
  const tokens = loadJson<Record<string, StoredToken>>(TOKENS_FILE, {});
  // prune expired
  const now = Date.now();
  for (const [k, v] of Object.entries(tokens)) if (v.expiresAt < now) delete tokens[k];
  const access = 'mcpb_at_' + randomBytes(32).toString('base64url');
  const refresh = 'mcpb_rt_' + randomBytes(32).toString('base64url');
  tokens[hash(access)] = { principalId, expiresAt: now + ACCESS_TTL_MS };
  tokens[hash(refresh)] = { principalId, expiresAt: now + REFRESH_TTL_MS, refresh: true };
  saveJson(TOKENS_FILE, tokens);
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000 };
}

export function mountOAuth(app: express.Express, publicUrl: string): void {
  const meta = {
    resource: `${publicUrl}/mcp`,
    authorization_servers: [publicUrl],
  };

  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(meta));
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(meta));

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  // Dynamic Client Registration (RFC 7591) — public clients only.
  app.post('/oauth/register', (req, res) => {
    const redirectUris: string[] = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    const clientId = 'mcpb-client-' + randomUUID();
    const clients = loadJson<Record<string, RegisteredClient>>(CLIENTS_FILE, {});
    clients[clientId] = { client_id: clientId, redirect_uris: redirectUris, created: Date.now() };
    saveJson(CLIENTS_FILE, clients);
    res.status(201).json({
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // Authorization endpoint: render a minimal login form.
  app.get('/oauth/authorize', (req, res) => {
    const { redirect_uri, state, code_challenge, code_challenge_method, client_id } = req.query as Record<string, string>;
    if (!redirect_uri || !code_challenge || code_challenge_method !== 'S256') {
      res.status(400).send('invalid_request: PKCE S256 and redirect_uri required');
      return;
    }
    res.type('html').send(`<!doctype html><html><head><meta charset=utf-8><title>Authorize MCP IDE Bridge</title>
<style>body{font-family:system-ui;max-width:420px;margin:6rem auto;padding:1rem}input{width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box}button{padding:.6rem 1rem}</style></head>
<body><h2>MCP IDE Bridge</h2><p>Paste your client API key to authorize this connection.</p>
<form method="POST" action="/oauth/authorize">
<input type="password" name="apikey" placeholder="mcpb_..." autocomplete="off" required>
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
<input type="hidden" name="state" value="${escapeHtml(state ?? '')}">
<input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
<input type="hidden" name="client_id" value="${escapeHtml(client_id ?? '')}">
<button type="submit">Authorize</button></form></body></html>`);
  });

  app.post('/oauth/authorize', express.urlencoded({ extended: false }), (req, res) => {
    const { apikey, redirect_uri, state, code_challenge, client_id } = req.body as Record<string, string>;
    if (!redirect_uri || !code_challenge) {
      res.status(400).send('invalid_request');
      return;
    }
    let p: Principal;
    try {
      p = authenticateKey(apikey);
    } catch {
      res.status(401).type('html').send('<p>Invalid API key. <a href="javascript:history.back()">Back</a></p>');
      return;
    }
    const code = 'mcpb_ac_' + randomBytes(24).toString('base64url');
    codes.set(code, { principalId: p.id, codeChallenge: code_challenge, redirectUri: redirect_uri, clientId: client_id ?? '', expiresAt: Date.now() + CODE_TTL_MS });
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.post('/oauth/token', express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body as Record<string, string>;
    if (body.grant_type === 'authorization_code') {
      const rec = codes.get(body.code ?? '');
      if (!rec || Date.now() > rec.expiresAt) { res.status(400).json({ error: 'invalid_grant' }); return; }
      codes.delete(body.code!);
      // PKCE verify
      const challenge = base64url(createHash('sha256').update(body.code_verifier ?? '').digest());
      if (challenge !== rec.codeChallenge) { res.status(400).json({ error: 'invalid_grant', error_description: 'pkce' }); return; }
      if (body.redirect_uri && body.redirect_uri !== rec.redirectUri) { res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri' }); return; }
      res.json(issueTokens(rec.principalId));
      return;
    }
    if (body.grant_type === 'refresh_token') {
      const tokens = loadJson<Record<string, StoredToken>>(TOKENS_FILE, {});
      const rec = tokens[hash(body.refresh_token ?? '')];
      if (!rec || !rec.refresh || Date.now() > rec.expiresAt) { res.status(400).json({ error: 'invalid_grant' }); return; }
      delete tokens[hash(body.refresh_token!)];
      saveJson(TOKENS_FILE, tokens);
      res.json(issueTokens(rec.principalId));
      return;
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  });
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
