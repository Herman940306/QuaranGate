/**
 * Executor service: PRIVATE. Holds the Docker socket, never published.
 * Authenticated only by the shared INTERNAL_TOKEN over the internal network.
 * Re-enforces target allowlist + workspace confinement independently of the gateway.
 */
import express from 'express';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import { EXECUTOR_DEFAULTS } from '../shared/types.js';
import { loadTargetConfig, listTargets, invalidateCache } from './targets.js';
import { confinedTarget, confinePath, runArgv, runShell } from './execops.js';
import * as fsops from './fsops.js';
import { ping } from './docker.js';

const PORT = Number(process.env.EXECUTOR_PORT ?? 8990);
const TOKEN = process.env.INTERNAL_TOKEN ?? '';

if (!TOKEN || TOKEN === '<SET_SECURELY>') {
  console.error('FATAL: INTERNAL_TOKEN is not set');
  process.exit(1);
}

loadTargetConfig();

const app = express();
app.use(express.json({ limit: '8mb' }));

// Internal auth
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  const got = req.header('x-internal-token');
  if (!got || got !== TOKEN) {
    res.status(401).json({ error: 'UNAUTHENTICATED', message: 'bad internal token' });
    return;
  }
  next();
});

function handle(fn: (req: express.Request, res: express.Response) => Promise<unknown>) {
  return (req: express.Request, res: express.Response) => {
    fn(req, res)
      .then((body) => {
        if (!res.headersSent) res.json(body ?? { ok: true });
      })
      .catch((e) => {
        const be = asBridgeError(e);
        res.status(be.httpStatus).json(be.toJSON());
      });
  };
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/readyz', handle(async () => {
  const ok = await ping();
  if (!ok) throw new BridgeError('DOCKER_UNAVAILABLE', 'docker not reachable', 503);
  return { ok: true };
}));

app.post('/reload', handle(async () => {
  loadTargetConfig();
  invalidateCache();
  return { ok: true };
}));

app.get('/targets', handle(async () => ({ targets: await listTargets() })));

app.post('/target/inspect', handle(async (req) => {
  const { targetId } = req.body ?? {};
  const targets = await listTargets();
  const t = targets.find((x) => x.id === targetId);
  if (!t) throw new BridgeError('UNKNOWN_TARGET', `unknown target: ${targetId}`, 404);
  return { target: t };
}));

app.post('/fs/list', handle(async (req) => {
  const { targetId, path: rel, maxDepth } = req.body ?? {};
  const t = await confinedTarget(targetId);
  return { entries: await fsops.listDir(t, rel ?? '', maxDepth ?? 1) };
}));

app.post('/fs/stat', handle(async (req) => {
  const { targetId, path: rel } = req.body ?? {};
  const t = await confinedTarget(targetId);
  return { stat: await fsops.statPath(t, rel ?? '') };
}));

app.post('/fs/read', handle(async (req) => {
  const { targetId, path: rel } = req.body ?? {};
  const t = await confinedTarget(targetId);
  const buf = await fsops.readFile(t, rel);
  return { contentBase64: buf.toString('base64'), bytes: buf.length };
}));

app.post('/fs/search', handle(async (req) => {
  const { targetId, path: rel, query, maxResults } = req.body ?? {};
  const t = await confinedTarget(targetId);
  return { matches: await fsops.search(t, rel ?? '', query, maxResults ?? 200) };
}));

app.post('/fs/write', handle(async (req) => {
  const { targetId, path: rel, contentBase64, mode } = req.body ?? {};
  if (typeof contentBase64 !== 'string') throw new BridgeError('MALFORMED_REQUEST', 'contentBase64 required', 400);
  const t = await confinedTarget(targetId);
  await fsops.writeFile(t, rel, Buffer.from(contentBase64, 'base64'), mode ?? 0o644);
  return { ok: true };
}));

app.post('/fs/patch', handle(async (req) => {
  const { targetId, path: rel, oldText, newText } = req.body ?? {};
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    throw new BridgeError('MALFORMED_REQUEST', 'oldText and newText required', 400);
  }
  const t = await confinedTarget(targetId);
  await fsops.patchFile(t, rel, oldText, newText);
  return { ok: true };
}));

app.post('/fs/delete', handle(async (req) => {
  const { targetId, path: rel, recursive } = req.body ?? {};
  const t = await confinedTarget(targetId);
  await fsops.deletePath(t, rel, Boolean(recursive));
  return { ok: true };
}));

app.post('/exec/shell', handle(async (req) => {
  const { targetId, command, cwd, timeoutMs, maxOutputBytes, principal } = req.body ?? {};
  const t = await confinedTarget(targetId);
  const cwdAbs = cwd ? await confinePath(t, cwd, { mustExist: true }) : t.workspace;
  return runShell(t, command, {
    cwdAbs,
    timeoutMs: Math.min(timeoutMs ?? EXECUTOR_DEFAULTS.timeoutMs, EXECUTOR_DEFAULTS.maxTimeoutMs),
    maxOutputBytes: maxOutputBytes ?? EXECUTOR_DEFAULTS.maxOutputBytes,
    principal: String(principal ?? 'unknown'),
  });
}));

app.post('/exec/argv', handle(async (req) => {
  const { targetId, argv, cwd, timeoutMs, principal } = req.body ?? {};
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
    throw new BridgeError('MALFORMED_REQUEST', 'argv must be string[]', 400);
  }
  const t = await confinedTarget(targetId);
  const cwdAbs = cwd ? await confinePath(t, cwd, { mustExist: true }) : t.workspace;
  return runArgv(t, argv, { cwdAbs, timeoutMs: timeoutMs ?? EXECUTOR_DEFAULTS.timeoutMs, principal: String(principal ?? 'unknown') });
}));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'executor listening', port: PORT }));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
