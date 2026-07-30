/**
 * Executor service: PRIVATE. Holds the Docker socket, never published.
 * Authenticated only by the shared INTERNAL_TOKEN over the internal network.
 * Re-enforces target allowlist + workspace confinement independently of the gateway.
 */
import fs from 'node:fs';
import express from 'express';
import { asBridgeError, BridgeError } from '../shared/errors.js';
import { EXECUTOR_DEFAULTS } from '../shared/types.js';
import { loadTargetConfig, listTargets, invalidateCache } from './targets.js';
import { confinedTarget, confinePath, runArgv, runShell } from './execops.js';
import * as fsops from './fsops.js';
import { ping } from './docker.js';
import { loadAgentConfig } from './agentConfig.js';
import { AgentJobStore } from './agents/jobStore.js';
import { AgentJobEngine, type AgentBackendAdapter, type EvidenceReaderFactory } from './agents/jobEngine.js';
import { createDockerEvidenceReader } from './agents/artifactReader.js';
import { registerAgentRoutes } from './agents/routes.js';
import { RunnerSandbox } from './agents/sandboxRunner.js';
import { CredentialManager } from './agents/credentialManager.js';
import { createKiroBackendFactory } from './agents/kiroFactory.js';
import type { AgentJobRow } from './agents/jobStore.js';
import type { AgentResourcePolicy } from '../shared/agents.js';

const PORT = Number(process.env.EXECUTOR_PORT ?? 8990);
const TOKEN = process.env.INTERNAL_TOKEN ?? '';

if (!TOKEN || TOKEN === '<SET_SECURELY>') {
  console.error('FATAL: INTERNAL_TOKEN is not set');
  process.exit(1);
}

loadTargetConfig();

// Agent Control Plane (A2): OPTIONAL. Without config/agents.yaml the bridge
// runs exactly as before and agent routes fail closed (AGENTS_UNAVAILABLE).
const AGENTS_CONFIG = process.env.AGENTS_CONFIG ?? '/config/agents.yaml';
const JOBS_DB = process.env.JOBS_DB ?? '/jobs/agents.db';
// A3/A4 runner infrastructure is TRUSTED configuration (never caller-selectable).
// When AGENT_RUNNER_IMAGE / AGENT_PROXY_IMAGE / AGENT_KIRO_KEY_PATH are all set,
// the real read-only Kiro backend is wired for `backend: kiro`. Otherwise the
// deterministic fake backend remains the operational backend (unchanged A2/A3
// behavior). None of these are ever caller-selectable.
const RUNNER_IMAGE = process.env.AGENT_RUNNER_IMAGE ?? '';
const PROXY_IMAGE = process.env.AGENT_PROXY_IMAGE ?? '';
const HELPER_IMAGE = process.env.AGENT_HELPER_IMAGE ?? RUNNER_IMAGE;
const KIRO_KEY_PATH = process.env.AGENT_KIRO_KEY_PATH ?? '';
// Trusted zero-inference verification switch. When set truthy the real Kiro
// backend stops after ACP session/new (no session/prompt, no model turn) — used
// by the live deployment gate / as a health probe. Never caller-selectable.
const KIRO_DRY_RUN = /^(1|true|yes)$/i.test(process.env.AGENT_KIRO_DRY_RUN ?? '');
let agentEngine: AgentJobEngine | null = null;
let agentStore: AgentJobStore | null = null;
if (fs.existsSync(AGENTS_CONFIG)) {
  const agentConfig = loadAgentConfig(AGENTS_CONFIG);
  agentStore = new AgentJobStore(JOBS_DB);
  const sandbox = new RunnerSandbox({ image: RUNNER_IMAGE });

  // A4: wire the real Kiro backend when the trusted runner infrastructure is
  // configured. The factory selects KiroBackend ONLY for backend=kiro and falls
  // back to the fake backend otherwise. KiroBackend launches the runner purely
  // through the Docker Engine API (no docker CLI) and denies write profiles.
  let backendFactory:
    | ((job: AgentJobRow, policy: AgentResourcePolicy) => AgentBackendAdapter | null)
    | undefined;
  let kiroEnabled = false;
  if (RUNNER_IMAGE && PROXY_IMAGE && KIRO_KEY_PATH) {
    const credentialManager = new CredentialManager({ credentialPath: KIRO_KEY_PATH, helperImage: HELPER_IMAGE });
    backendFactory = createKiroBackendFactory(agentConfig.projects, {
      runnerImage: RUNNER_IMAGE,
      helperImage: HELPER_IMAGE,
      proxyImage: PROXY_IMAGE,
      // The proxy runs the bridge's own image, which contains the compiled
      // egress proxy — no host bind of the project or dist is needed.
      proxyCmd: ['node', '/app/dist/executor/agents/egressProxyMain.js'],
      credentialManager,
      sandbox,
      dryRun: KIRO_DRY_RUN,
    });
    kiroEnabled = true;
  }

  // A6-B4: trusted read-only evidence reader for agent_diff. Uses the same
  // trusted helper image as B3 evidence I/O; the volume is always taken from
  // AgentJobRow.artifactVolume (never caller input). Absent when no helper
  // image is configured (fake-only deployments never publish an AVAILABLE
  // artifact, so agent_diff fails closed with ARTIFACT_NOT_AVAILABLE first).
  const evidenceReaderFactory: EvidenceReaderFactory | undefined = HELPER_IMAGE
    ? (volume, jobId) => createDockerEvidenceReader(volume, HELPER_IMAGE, jobId)
    : undefined;

  agentEngine = new AgentJobEngine(agentStore, agentConfig, undefined, backendFactory, evidenceReaderFactory);
  const recovered = agentEngine.recover();
  console.log(JSON.stringify({
    level: 'info', msg: 'agent control plane active',
    projects: agentConfig.projects.length, backends: agentConfig.backends.length,
    schemaVersion: agentStore.schemaVersion, recoveredJobs: recovered.length,
    kiroBackend: kiroEnabled ? (KIRO_DRY_RUN ? 'enabled(dry-run)' : 'enabled') : 'fake-only',
  }));
  // A3: label-scoped reconciliation of any bridge-owned runner sandbox resources
  // left after a restart (fail closed). Only exact ownership labels are touched;
  // this never enumerates or deletes unrelated Docker resources.
  sandbox.reconcileOrphans()
    .then((r) => console.log(JSON.stringify({ level: 'info', msg: 'sandbox orphan reconciliation', removedContainers: r.removedContainers.length, removedVolumes: r.removedVolumes.length })))
    .catch((e) => console.log(JSON.stringify({ level: 'warn', msg: 'sandbox orphan reconciliation failed', error: e instanceof Error ? e.message.slice(0, 200) : String(e) })));
} else {
  console.log(JSON.stringify({ level: 'info', msg: 'agent control plane not configured (optional)' }));
}

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

registerAgentRoutes(app, handle, () => agentEngine);

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
  agentEngine?.shutdown();
  try { agentStore?.close(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
