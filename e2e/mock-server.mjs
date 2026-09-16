import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CURRENT_SOURCE_IDENTITY, SOURCE_ROOT } from './contracts/current-source.mjs';
import { SYNTHETIC_BROWSER_CREDENTIALS } from './contracts/synthetic-credentials.mjs';

const sourceRoot = SOURCE_ROOT;
const consoleRoot = path.join(sourceRoot, 'console');
const port = Number(process.env.QG_E2E_PORT || 4187);

const { TOOL_CATALOG } = await import(pathToFileURL(path.join(consoleRoot, 'tool-catalog.js')).href);
const baseTools = TOOL_CATALOG.map(({ name, summary }) => ({ name, description: summary, inputSchema: { type: 'object', additionalProperties: true } }));

const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'", "base-uri 'none'", "connect-src 'self'", "font-src 'self'",
    "form-action 'self'", "frame-ancestors 'none'", "img-src 'self' data:", "object-src 'none'",
    "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
};

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'],
]);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authScenario(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) return 'missing';
  return value.slice(7);
}

function toolListFor(scenario) {
  if (scenario === SYNTHETIC_BROWSER_CREDENTIALS.missingTool) return baseTools.filter((tool) => tool.name !== 'targets_list');
  if (scenario === SYNTHETIC_BROWSER_CREDENTIALS.extraTool) return [...baseTools, { name: 'future_tool', description: 'Synthetic drift', inputSchema: { type: 'object' } }];
  return baseTools;
}

function controlCenter(view) {
  const common = { state: 'READY', generatedAt: '2026-09-07T00:00:00.000Z' };
  switch (view) {
    case 'summary': return { ...common, principal: { id: 'e2e-browser', scopes: ['targets:read'] }, executor: { dockerAuthority: null }, capabilityState: { sessionContinuity: 'NOT_QUALIFIED', ideControl: 'NOT_IMPLEMENTED' }, activity: { total: 0 }, rateLimit: { state: 'READY' } };
    case 'activity': return { rows: [], stats: { total: 0, allowed: 0, denied: 0, p50Ms: null, p95Ms: null, topTools: [] } };
    case 'authority': return { principal: { id: 'e2e-browser', scopes: ['targets:read'], targets: ['e2e-target'], agentProjects: ['e2e-project'] }, preflight: null };
    case 'topology': return { ...common, gateway: { state: 'READY' }, executor: { state: 'READY', dockerAuthority: null }, targets: [] };
    case 'egress': return { state: 'UNKNOWN', policy: 'synthetic-e2e' };
    case 'providers': return { backends: [], activeJobs: 0, queuedJobs: 0, ollama: { state: 'NOT_QUALIFIED' } };
    case 'incidents': return { rows: [], incidents: [] };
    case 'statistics': return { activity: { total: 0 }, jobs: {}, targets: {}, backends: {} };
    case 'capabilities': return { matrix: [] };
    case 'resources': return { state: 'UNKNOWN', resources: [] };
    case 'recovery': return { state: 'UNKNOWN', quarantine: null, backups: 'MANAGED_OUTSIDE_CONSOLE' };
    default: return { state: 'UNKNOWN' };
  }
}

function toolPayload(name, args) {
  switch (name) {
    case 'targets_list': return { targets: [{ id: 'e2e-target', name: 'E2E Target', running: true, workspace: '/workspace' }] };
    case 'target_inspect': return { id: args.target || 'e2e-target', running: true, workspace: '/workspace', image: 'e2e:test', status: 'Up' };
    case 'agents_list': return { backends: [{ id: 'ollama', available: true, profiles: ['audit', 'plan'] }, { id: 'kiro', available: false, profiles: ['audit'] }] };
    case 'agent_projects': return { projects: [{ id: 'e2e-project', name: 'E2E Project' }] };
    case 'github_repositories': return { repositories: [] };
    case 'control_center_query': return { data: controlCenter(args.view) };
    case 'fs_list': return { entries: [] };
    case 'fs_stat': return { path: args.path || '', type: 'file', size: 0, mode: '0644', mtime: '2026-09-07T00:00:00.000Z' };
    case 'fs_read': return { path: args.path || '', content: 'synthetic-e2e', encoding: 'utf8', truncated: false };
    case 'fs_search': return { matches: [] };
    case 'terminal_exec': return { exitCode: 0, stdout: 'E2E_OK\n', stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    case 'git_status': return { stdout: '## source-bound-e2e\n' };
    case 'git_diff': return { stdout: '' };
    case 'git_log': return { stdout: `${CURRENT_SOURCE_IDENTITY.head.slice(0, 7)} source-bound candidate\n` };
    case 'process_list': return { exitCode: 0, stdout: 'PID COMMAND\n1 node\n', stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    default: return { ok: true, tool: name, synthetic: true };
  }
}

async function handleMcp(req, res) {
  const scenario = authScenario(req);
  let raw = '';
  for await (const chunk of req) raw += chunk;

  if (scenario === 'missing' || scenario === SYNTHETIC_BROWSER_CREDENTIALS.authFailure) return sendJson(res, 401, { error: { message: 'Synthetic authentication failure', data: 'INVALID_CREDENTIAL' } });
  if (scenario === SYNTHETIC_BROWSER_CREDENTIALS.scopeDenied) return sendJson(res, 403, { error: { message: 'Synthetic scope denial', data: 'FORBIDDEN_SCOPE' } });
  if (scenario === SYNTHETIC_BROWSER_CREDENTIALS.rateLimited) return sendJson(res, 429, { error: { message: 'Synthetic rate limit', data: 'RATE_LIMITED' } });
  if (scenario === SYNTHETIC_BROWSER_CREDENTIALS.slow) await new Promise((resolve) => setTimeout(resolve, 650));
  if (scenario === SYNTHETIC_BROWSER_CREDENTIALS.malformed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not-json'); return; }

  let body;
  try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: { message: 'bad request', data: 'INVALID_REQUEST' } }); }
  const responseId = scenario === SYNTHETIC_BROWSER_CREDENTIALS.mismatchedId ? Number(body.id || 0) + 99 : body.id;

  if (body.method === 'tools/list') return sendJson(res, 200, { jsonrpc: '2.0', id: responseId, result: { tools: toolListFor(scenario) } });
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    const args = body.params?.arguments || {};
    return sendJson(res, 200, { jsonrpc: '2.0', id: responseId, result: { structuredContent: toolPayload(name, args) } });
  }
  return sendJson(res, 200, { jsonrpc: '2.0', id: responseId, result: {} });
}

async function serveConsole(req, res) {
  Object.entries(securityHeaders).forEach(([key, value]) => res.setHeader(key, value));
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  let relative = decodeURIComponent(url.pathname.slice('/console'.length));
  if (!relative || relative === '/') relative = '/index.html';
  const candidate = path.resolve(consoleRoot, `.${relative}`);
  if (candidate !== consoleRoot && !candidate.startsWith(`${consoleRoot}${path.sep}`)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('not file');
    const data = await readFile(candidate);
    res.setHeader('content-type', mime.get(path.extname(candidate)) || 'application/octet-stream');
    res.setHeader('content-length', data.length);
    res.writeHead(200);
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/mcp') return await handleMcp(req, res);
    if (req.url === '/') { res.writeHead(302, { location: '/console/' }); res.end(); return; }
    if (req.url?.startsWith('/console')) return await serveConsole(req, res);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not Found');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Synthetic E2E server failure');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`QG_RELEASE_E2E_SERVER=READY port=${port} source=${sourceRoot} head=${CURRENT_SOURCE_IDENTITY.head} tree=${CURRENT_SOURCE_IDENTITY.tree}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
