/**
 * Gateway service: PUBLIC-facing MCP server. Holds NO Docker socket.
 * Transport: Streamable HTTP (stateless — fresh server per request for clean
 * cross-client isolation). Auth: per-client API key (Bearer or X-API-Key) or an
 * OAuth 2.1 bearer token mapping to the same principal.
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import { clientsLoadState, loadClients, principalById, type Principal } from './config.js';
import { authenticateKey } from './auth/apikeys.js';
import { mountOAuth, oauthResourceForPublicUrl, tokenToPrincipalId } from './auth/oauth.js';
import { withPrincipal } from './context.js';
import { checkRate } from './ratelimit.js';
import { buildServer } from './mcp.js';
import { executor } from './executorClient.js';
import { audit, newReqId } from './audit.js';

const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const PUBLIC_URL = (process.env.BRIDGE_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const MCP_RESOURCE = oauthResourceForPublicUrl(PUBLIC_URL);

if (!process.env.INTERNAL_TOKEN || process.env.INTERNAL_TOKEN === '<SET_SECURELY>') {
  console.error('FATAL: INTERNAL_TOKEN is not set');
  process.exit(1);
}
// A missing/unreadable/malformed/invalid clients config must NOT crash the
// process (it stays alive and diagnosable) and must NOT look healthy: the
// failure is recorded in the config load state and surfaces via /readyz.
try {
  loadClients();
} catch {
  // Category + safe message only; the raw error can echo file content.
}
{
  const st = clientsLoadState();
  if (st.status !== 'loaded') {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'clients config not loaded — gateway is NOT READY (all client authentication will fail)',
      status: st.status,
      reason: st.status === 'failed' ? st.reason : 'unknown',
      detail: st.status === 'failed' ? st.message : undefined,
    }));
  }
}

const app = express();
app.disable('x-powered-by');

// Liveness only: the process is running. Never depends on config or executor.
app.get('/healthz', (_req, res) => { res.json({ ok: true }); });
// Readiness: fail closed unless the clients config loaded AND the executor is
// reachable. `principalCount: 0` is a valid loaded config and stays ready.
// The body carries no reason: /readyz is unauthenticated (and may be exposed
// through remote ingress), so it must not disclose internal state.
app.get('/readyz', (_req, res) => {
  if (clientsLoadState().status !== 'loaded') { res.status(503).json({ ok: false }); return; }
  executor.readyz().then((ok) => res.status(ok ? 200 : 503).json({ ok }));
});

// OAuth façade (metadata, register, authorize, token). Uses its own body parsers.
mountOAuth(app, PUBLIC_URL);

/** Extract credential and resolve to an enabled principal. */
function authenticate(req: express.Request): Principal {
  const authz = req.header('authorization');
  const xkey = req.header('x-api-key');
  let raw: string | undefined;
  if (authz?.toLowerCase().startsWith('bearer ')) raw = authz.slice(7).trim();
  else if (xkey) raw = xkey.trim();

  if (!raw) throw new BridgeError('UNAUTHENTICATED', 'missing credential (Bearer token or X-API-Key)', 401);

  // OAuth bearer?
  if (raw.startsWith('mcpb_at_')) {
    const pid = tokenToPrincipalId(raw, MCP_RESOURCE);
    if (!pid) throw new BridgeError('INVALID_CREDENTIAL', 'invalid or expired token', 401);
    const p = principalById(pid);
    if (!p) throw new BridgeError('INVALID_CREDENTIAL', 'principal not found', 401);
    if (!p.enabled) throw new BridgeError('CLIENT_DISABLED', 'client disabled', 403);
    return p;
  }
  // Static API key
  return authenticateKey(raw);
}

app.post('/mcp', express.json({ limit: '8mb' }), async (req, res) => {
  const reqId = newReqId();
  let principal: Principal;
  try {
    principal = authenticate(req);
    checkRate(principal.id, principal.rateLimit);
  } catch (e) {
    const be = asBridgeError(e);
    audit({ reqId, principal: null, tool: 'mcp:auth', decision: 'deny', code: be.code });
    // For 401s, advertise the OAuth resource metadata per MCP auth spec.
    if (be.httpStatus === 401) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
    }
    res.status(be.httpStatus).json({ jsonrpc: '2.0', error: { code: -32001, message: be.message, data: be.code }, id: null });
    return;
  }

  // Stateless: a fresh server + transport per request, principal bound via ALS.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });

  try {
    await withPrincipal(principal, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  } catch (e) {
    const be = asBridgeError(e);
    audit({ reqId, principal: principal.id, tool: 'mcp:transport', decision: 'deny', code: be.code, detail: be.message });
    if (!res.headersSent) res.status(be.httpStatus).json({ jsonrpc: '2.0', error: { code: -32603, message: be.message }, id: null });
  }
});

// GET/DELETE on /mcp: stateless server does not support server-initiated streams.
app.get('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed (stateless server)' }, id: null }));
app.delete('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed' }, id: null }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'gateway listening', port: PORT, publicUrl: PUBLIC_URL }));
});

function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
