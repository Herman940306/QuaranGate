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
import { createOllamaBackendFactory } from './agents/ollamaFactory.js';
import { Ollama } from 'ollama';
import { createDockerApplierIO } from './agents/applyEngine.js';
import { runStartupEvidenceLifecycle } from './agents/evidenceCollector.js';
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

// O1: Ollama read-only backend (TRUSTED configuration, never caller-selectable).
// When OLLAMA_HOST / OLLAMA_MODEL_QUALIFIER are both set, the real Ollama backend
// is wired for `backend: ollama`. AGENT_HELPER_IMAGE is also required (generic
// helper for read operations). No default model, no :latest, fail closed.
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? '';
const OLLAMA_MODEL_QUALIFIER = process.env.OLLAMA_MODEL_QUALIFIER ?? '';

// Mutable handles assigned inside the startup sequence; used by shutdown().
let agentEngine: AgentJobEngine | null = null;
let agentStore: AgentJobStore | null = null;

// ---------------------------------------------------------------------------
// Express app — constructed in memory here; does NOT accept requests until
// server.listen() is called at the end of the async startup sequence below.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Async startup sequence (A6 Decision R5 — startup-only collection).
//
// Security boundary: server.listen() is called ONLY after all steps 1-7
// complete. No externally reachable agent request can race the lifecycle pass.
//
// Required order:
//   1. AgentJobStore construction + migration      (synchronous, done above)
//   2. recoverActive — fail active jobs closed     (synchronous, in recover())
//   3. recoverApplyAttempts                        (synchronous)
//   4. AWAIT sandbox.reconcileOrphans()            (was fire-and-forget; now awaited)
//   5. AWAIT reconcileExpiredEvidence()            (via runStartupEvidenceLifecycle)
//   6. AWAIT collectExpiredEvidence()              (via runStartupEvidenceLifecycle)
//   7. AWAIT classifyIncompleteEvidence()          (via runStartupEvidenceLifecycle)
//   8. server.listen()                             (executor becomes externally reachable)
//
// Global lifecycle failure (Docker unavailable, SQLite corrupt, unexpected
// throw) propagates out of the IIFE and calls process.exit(1) — FAIL CLOSED.
// ---------------------------------------------------------------------------

let server: ReturnType<typeof app.listen>;

(async () => {
  // Steps 1-3: synchronous ACP setup (if agents.yaml exists).
  if (fs.existsSync(AGENTS_CONFIG)) {
    const agentConfig = loadAgentConfig(AGENTS_CONFIG);

    // O1: Fail-closed startup validation (§7) — if Ollama backend is enabled,
    // require all environment variables; if disabled, permit them to be absent.
    const ollamaBackend = agentConfig.backends.find((b) => b.id === 'ollama');
    if (ollamaBackend?.enabled) {
      if (!OLLAMA_HOST) {
        console.error('FATAL: Ollama backend enabled but OLLAMA_HOST is not set');
        process.exit(1);
      }
      if (!OLLAMA_MODEL_QUALIFIER) {
        console.error('FATAL: Ollama backend enabled but OLLAMA_MODEL_QUALIFIER is not set');
        process.exit(1);
      }
      if (!HELPER_IMAGE) {
        console.error('FATAL: Ollama backend enabled but AGENT_HELPER_IMAGE is not set');
        process.exit(1);
      }
      // Reject :latest tags (§8)
      if (OLLAMA_MODEL_QUALIFIER.includes(':latest') || HELPER_IMAGE.includes(':latest')) {
        console.error('FATAL: :latest tags not allowed for OLLAMA_MODEL_QUALIFIER or AGENT_HELPER_IMAGE');
        process.exit(1);
      }
    }

    // Step 1: construct + migrate DB.
    agentStore = new AgentJobStore(JOBS_DB);
    const sandbox = new RunnerSandbox({ image: RUNNER_IMAGE });

    // A4: wire the real Kiro backend when the trusted runner infrastructure is
    // configured. The factory selects KiroBackend ONLY for backend=kiro and
    // falls back to the fake backend otherwise.
    // O1: wire the real Ollama backend when OLLAMA_HOST and OLLAMA_MODEL_QUALIFIER
    // are configured. The factory chain selects OllamaBackend for backend=ollama,
    // KiroBackend for backend=kiro, and falls back to fake backend otherwise.
    let backendFactory:
      | ((job: AgentJobRow, policy: AgentResourcePolicy) => AgentBackendAdapter | null)
      | undefined;
    let kiroEnabled = false;
    let ollamaEnabled = false;

    // Build composed factory chain (Ollama → Kiro → null)
    const factories: Array<(job: AgentJobRow, policy: AgentResourcePolicy) => AgentBackendAdapter | null> = [];

    if (OLLAMA_HOST && OLLAMA_MODEL_QUALIFIER && HELPER_IMAGE) {
      const ollamaFactory = createOllamaBackendFactory({
        ollamaHost: OLLAMA_HOST,
        modelQualifier: OLLAMA_MODEL_QUALIFIER,
        helperImage: HELPER_IMAGE,
        stagerImage: HELPER_IMAGE,
        projects: agentConfig.projects,
        OllamaClass: Ollama,
      });
      factories.push(ollamaFactory);
      ollamaEnabled = true;
    }

    if (RUNNER_IMAGE && PROXY_IMAGE && KIRO_KEY_PATH) {
      const credentialManager = new CredentialManager({ credentialPath: KIRO_KEY_PATH, helperImage: HELPER_IMAGE });
      const kiroFactory = createKiroBackendFactory(agentConfig.projects, {
        runnerImage: RUNNER_IMAGE,
        helperImage: HELPER_IMAGE,
        proxyImage: PROXY_IMAGE,
        proxyCmd: ['node', '/app/dist/executor/agents/egressProxyMain.js'],
        credentialManager,
        sandbox,
        dryRun: KIRO_DRY_RUN,
      });
      factories.push(kiroFactory);
      kiroEnabled = true;
    }

    // Compose factories: try each in order, return first non-null result.
    // CRITICAL (R1.7): Explicit backend=ollama when ollamaEnabled but factory
    // returns null must FAIL CLOSED (not silently fall back to fake backend).
    if (factories.length > 0) {
      backendFactory = (job, policy) => {
        // Explicit backend=ollama when Ollama is enabled requires Ollama factory success
        if (job.backend === 'ollama' && ollamaEnabled) {
          const ollamaFactory = factories[0];
          if (!ollamaFactory) {
            throw new BridgeError('PRECONDITION_FAILED', 'Ollama factory not configured', 500);
          }
          const ollamaBackend = ollamaFactory(job, policy);
          if (ollamaBackend === null) {
            throw new BridgeError(
              'PRECONDITION_FAILED',
              `backend=ollama explicitly requested but Ollama factory returned null (backend disabled or job.backend mismatch)`,
              500,
            );
          }
          return ollamaBackend;
        }

        // For other backends, try factories in order
        for (const factory of factories) {
          const backend = factory(job, policy);
          if (backend !== null) return backend;
        }
        return null; // All factories returned null → fake backend
      };
    }

    const evidenceReaderFactory: EvidenceReaderFactory | undefined = HELPER_IMAGE
      ? (volume, jobId) => createDockerEvidenceReader(volume, HELPER_IMAGE, jobId)
      : undefined;

    const applierIO = HELPER_IMAGE ? createDockerApplierIO() : undefined;

    agentEngine = new AgentJobEngine(
      agentStore, agentConfig, undefined, backendFactory,
      evidenceReaderFactory, HELPER_IMAGE || undefined, applierIO,
    );

    // Step 2: recover active jobs (fail closed to FAILED_INFRASTRUCTURE).
    const recovered = agentEngine.recover();

    // Step 3: recover apply attempts (APPLYING → UNCERTAIN + quarantine).
    const applyRecovery = agentStore.recoverApplyAttempts('executor restarted with an active apply attempt');

    console.log(JSON.stringify({
      level: 'info', msg: 'agent control plane active',
      projects: agentConfig.projects.length, backends: agentConfig.backends.length,
      schemaVersion: agentStore.schemaVersion, recoveredJobs: recovered.length,
      kiroBackend: kiroEnabled ? (KIRO_DRY_RUN ? 'enabled(dry-run)' : 'enabled') : 'fake-only',
      ollamaBackend: ollamaEnabled ? 'enabled' : 'fake-only',
      applierConfigured: !!applierIO,
      abortedApplyAttempts: applyRecovery.abortedNoMutation.length,
      uncertainApplyAttempts: applyRecovery.uncertain.length,
    }));

    // Step 4: AWAIT sandbox orphan reconciliation (was fire-and-forget; A6 requires
    // synchronous completion before evidence lifecycle runs). Global failure here
    // propagates and fails startup closed.
    const orphanResult = await sandbox.reconcileOrphans();
    console.log(JSON.stringify({
      level: 'info', msg: 'sandbox orphan reconciliation',
      removedContainers: orphanResult.removedContainers.length,
      removedVolumes: orphanResult.removedVolumes.length,
    }));

    // Steps 5-7: A6 evidence lifecycle (reconcile EXPIRED → Lane A → Lane B).
    // Global failure propagates and fails startup closed.
    // Per-resource failures are retained and reported inside the lifecycle.
    await runStartupEvidenceLifecycle(agentStore);

  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'agent control plane not configured (optional)' }));
  }

  // Step 8: all lifecycle steps complete — executor is now safe to accept requests.
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', msg: 'executor listening', port: PORT }));
  });

})().catch((e) => {
  console.error(JSON.stringify({
    level: 'fatal', msg: 'executor startup failed — fail closed',
    error: e instanceof Error ? e.message.slice(0, 500) : String(e),
  }));
  process.exit(1);
});

function shutdown() {
  agentEngine?.shutdown();
  try { agentStore?.close(); } catch { /* best effort */ }
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
