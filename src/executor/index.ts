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
import { inspectContainer, inspectImage, ping } from './docker.js';
import { controlTarget, readTargetLogs } from './targetControl.js';
import { loadAgentConfig, type AgentControlPlaneConfig } from './agentConfig.js';
import { loadGitHubConfig } from './githubConfig.js';
import { GitHubControl } from './githubControl.js';
import { registerGitHubRoutes } from './githubRoutes.js';
import { resolveExecutorStartupPolicy } from './startupPolicy.js';
import { validateImageRef } from '../shared/imageRef.js';
import { checkReadiness } from './readiness.js';
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
import {
  startIdeCompanionProduction,
  type IdeCompanionProductionRuntime,
  type IdeSessionControlRuntimeState,
} from './ide/ideCompanionProduction.js';

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
// AGENT_RUNNER_IMAGE is Kiro-specific. When it, AGENT_PROXY_IMAGE, and
// AGENT_KIRO_KEY_PATH are all set, the real read-only Kiro backend is wired for
// `backend: kiro`. Otherwise the deterministic fake backend remains the
// operational backend (unchanged A2/A3 behavior). None of these are ever
// caller-selectable.
const RUNNER_IMAGE = process.env.AGENT_RUNNER_IMAGE ?? '';
const PROXY_IMAGE = process.env.AGENT_PROXY_IMAGE ?? '';
const KIRO_KEY_PATH = process.env.AGENT_KIRO_KEY_PATH ?? '';
// Trusted zero-inference verification switch. When set truthy the real Kiro
// backend stops after ACP session/new (no session/prompt, no model turn) — used
// by the live deployment gate / as a health probe. Never caller-selectable.
const KIRO_DRY_RUN = /^(1|true|yes)$/i.test(process.env.AGENT_KIRO_DRY_RUN ?? '');

// O1: Ollama read-only backend (TRUSTED configuration, never caller-selectable).
// When the trusted config enables `backend: ollama`, its explicit environment
// is validated before the real backend is wired. AGENT_HELPER_IMAGE is the O1
// read-helper image; AGENT_STAGER_IMAGE is the O1 staging image. Neither falls
// back to AGENT_RUNNER_IMAGE or to the other O1 image. No defaults, no :latest,
// fail closed.
const EXPLICIT_HELPER_IMAGE = process.env.AGENT_HELPER_IMAGE ?? '';
const EXPLICIT_STAGER_IMAGE = process.env.AGENT_STAGER_IMAGE ?? '';
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? '';
const OLLAMA_MODEL_QUALIFIER = process.env.OLLAMA_MODEL_QUALIFIER ?? '';

// GitHub App control plane (optional, fail closed when not configured).
const GITHUB_CONFIG = process.env.GITHUB_CONFIG ?? '/config/github.yaml';
const GITHUB_GIT_HELPER_IMAGE = process.env.GITHUB_GIT_HELPER_IMAGE ?? '';
const GITHUB_CONTROL_NETWORK = process.env.GITHUB_CONTROL_NETWORK ?? '';

// Plane-B IDE Session Control is optional and independently trusted. The main
// Compose file does not expose a runtime namespace. compose.ide.yaml sets all
// three values together and bind-mounts IDE_RUNTIME_ROOT at the same absolute
// WSL/container pathname. None are caller-selectable.
const IDE_SESSIONS_CONFIG = process.env.IDE_SESSIONS_CONFIG ?? '/config/ide-sessions.yaml';
const IDE_SESSIONS_DB = process.env.IDE_SESSIONS_DB ?? '/jobs/ide-sessions.db';
const IDE_RUNTIME_ROOT = process.env.IDE_RUNTIME_ROOT ?? '';

// Mutable handles assigned inside the startup sequence; used by shutdown().
let agentEngine: AgentJobEngine | null = null;
let agentStore: AgentJobStore | null = null;
let githubControl: GitHubControl | null = null;
let ideCompanionRuntime: IdeCompanionProductionRuntime | null = null;
let ideSessionControlState: IdeSessionControlRuntimeState = 'NOT_CONFIGURED';

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
  // H1-2: Full authority readiness — socket type + Docker API ping (bounded).
  const SOCK = process.env.DOCKER_SOCK ?? '/var/run/docker.sock';
  const result = await checkReadiness(SOCK);
  if (!result.ready) {
    // 503 with a diagnostic code — never leaks the socket path or secrets.
    throw new BridgeError('DOCKER_UNAVAILABLE', `${result.code}: ${result.detail}`, 503);
  }
  return { ok: true, code: result.code };
}));


// U1: bounded, secret-free runtime metadata for the authenticated Control Center.
// This private executor route exposes no Docker identifiers/options and performs no mutation.
app.get('/control-center/runtime', handle(async () => {
  const SOCK = process.env.DOCKER_SOCK ?? '/var/run/docker.sock';
  const readiness = await checkReadiness(SOCK);
  return {
    buildRevision: process.env.QUARANGATE_BUILD_REVISION ?? 'unknown',
    dockerReachable: readiness.ready,
    dockerAuthority: readiness.ready,
    readinessCode: readiness.code,
    agentControlConfigured: agentStore !== null,
    activeJobs: agentStore?.countActive() ?? 0,
    queuedJobs: agentStore?.countQueued() ?? 0,
    ollama: {
      configured: Boolean(OLLAMA_MODEL_QUALIFIER),
      endpointState: OLLAMA_HOST === 'http://ollama:11434' ? 'EXACT_LOCAL' : (OLLAMA_HOST ? 'DRIFT' : 'NOT_CONFIGURED'),
      modelQualifier: OLLAMA_MODEL_QUALIFIER || undefined,
    },
    sessionContinuity: 'NOT_QUALIFIED',
    providerAdmissionControl: 'DEFERRED',
    ideSessionControl: ideSessionControlState,
  };
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
  if (t.containerId) {
    const info = await inspectContainer(t.containerId).catch(() => null);
    if (info?.State.Health?.Status) t.health = info.State.Health.Status;
  }
  return { target: t };
}));

app.post('/target/logs', handle(async (req) => {
  const { targetId, maxBytes } = req.body ?? {};
  const bounded = Math.min(Math.max(Number(maxBytes ?? 65_536), 1_024), EXECUTOR_DEFAULTS.maxOutputBytes);
  return readTargetLogs(String(targetId ?? ''), bounded);
}));

app.post('/target/control', handle(async (req) => {
  const { targetId, action } = req.body ?? {};
  if (!['start', 'stop', 'restart'].includes(action)) {
    throw new BridgeError('MALFORMED_REQUEST', 'action must be start, stop, or restart', 400);
  }
  return controlTarget(String(targetId ?? ''), action);
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
registerGitHubRoutes(app, handle, () => githubControl);

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
  let loadedAgentConfig: AgentControlPlaneConfig | null = null;
  // Steps 1-3: synchronous ACP setup (if agents.yaml exists).
  if (fs.existsSync(AGENTS_CONFIG)) {
    const agentConfig = loadAgentConfig(AGENTS_CONFIG);
    loadedAgentConfig = agentConfig;

    const ollamaBackend = agentConfig.backends.find((b) => b.id === 'ollama');
    const startupPolicy = resolveExecutorStartupPolicy(ollamaBackend?.enabled === true, {
      agentRunnerImage: RUNNER_IMAGE,
      agentHelperImage: EXPLICIT_HELPER_IMAGE,
      agentStagerImage: EXPLICIT_STAGER_IMAGE,
      ollamaHost: OLLAMA_HOST,
      ollamaModelQualifier: OLLAMA_MODEL_QUALIFIER,
    });
    const kiroHelperImage = startupPolicy.kiroHelperImage;

    // Step 1: construct + migrate DB.
    agentStore = new AgentJobStore(JOBS_DB);
    const sandbox = new RunnerSandbox({ image: startupPolicy.runnerImage });

    // O1 R2 architectural change: Create dedicated sandbox for O1 staging operations.
    // O1 uses its own sandbox from AGENT_STAGER_IMAGE, independent of the Kiro runner.
    // This sandbox is used exclusively for O1-specific staging (parsing job config,
    // preparing prompt artifacts) and is NOT shared with Kiro's execution sandbox.
    const ollamaSandbox = startupPolicy.ollama.enabled
      ? new RunnerSandbox({ image: startupPolicy.ollama.stagerImage })
      : null;

    // A4/P3: wire real provider adapters only when their trusted runtime
    // prerequisites are configured. Production passes the exact wired-backend
    // set into AgentJobEngine, so an explicitly requested provider that is not
    // wired fails closed and can never silently execute the deterministic fake.
    let backendFactory:
      | ((job: AgentJobRow, policy: AgentResourcePolicy) => AgentBackendAdapter | null)
      | undefined;
    let kiroEnabled = false;
    let ollamaEnabled = false;
    const runtimeAvailableBackends = new Set<string>();

    // Build composed factory chain (Ollama → Kiro → null)
    const factories: Array<(job: AgentJobRow, policy: AgentResourcePolicy) => AgentBackendAdapter | null> = [];

    if (startupPolicy.ollama.enabled) {
      if (!ollamaSandbox) {
        throw new BridgeError('PRECONDITION_FAILED', 'ollamaSandbox not initialized when ollama.enabled=true', 500);
      }
      const ollamaFactory = createOllamaBackendFactory({
        ollamaHost: startupPolicy.ollama.host,
        modelQualifier: startupPolicy.ollama.modelQualifier,
        helperImage: startupPolicy.ollama.helperImage,
        sandbox: ollamaSandbox,
        projects: agentConfig.projects,
        OllamaClass: Ollama,
      });
      factories.push(ollamaFactory);
      ollamaEnabled = true;
      runtimeAvailableBackends.add('ollama');
    }

    if (startupPolicy.runnerImage && PROXY_IMAGE && KIRO_KEY_PATH) {
      // H1-1: validate runner and proxy images using the central validator before wiring.
      const runnerImgErr = validateImageRef(startupPolicy.runnerImage);
      if (runnerImgErr) throw new BridgeError('PRECONDITION_FAILED', `AGENT_RUNNER_IMAGE: ${runnerImgErr}`, 503);
      const proxyImgErr = validateImageRef(PROXY_IMAGE);
      if (proxyImgErr) throw new BridgeError('PRECONDITION_FAILED', `AGENT_PROXY_IMAGE: ${proxyImgErr}`, 503);
      const credentialManager = new CredentialManager({ credentialPath: KIRO_KEY_PATH, helperImage: kiroHelperImage });
      const kiroFactory = createKiroBackendFactory(agentConfig.projects, {
        runnerImage: startupPolicy.runnerImage,
        helperImage: kiroHelperImage,
        proxyImage: PROXY_IMAGE,
        proxyCmd: ['node', '/app/dist/executor/agents/egressProxyMain.js'],
        credentialManager,
        sandbox,
        dryRun: KIRO_DRY_RUN,
      });
      factories.push(kiroFactory);
      kiroEnabled = true;
      runtimeAvailableBackends.add('kiro');
    }

    // Compose factories: try each real adapter in order. AgentJobEngine also
    // receives runtimeAvailableBackends and treats any missing/null real adapter
    // as PRECONDITION_FAILED in production.
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
        return null; // Production engine converts this to fail-closed for real backends
      };
    }

    const evidenceReaderFactory: EvidenceReaderFactory | undefined = kiroHelperImage
      ? (volume, jobId) => createDockerEvidenceReader(volume, kiroHelperImage, jobId)
      : undefined;

    const applierIO = kiroHelperImage ? createDockerApplierIO() : undefined;

    agentEngine = new AgentJobEngine(
      agentStore, agentConfig, undefined, backendFactory,
      evidenceReaderFactory, kiroHelperImage || undefined, applierIO,
      runtimeAvailableBackends,
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
    const protectedProviderState = new Set(agentEngine.protectedProviderStateRefs());
    const orphanResult = await sandbox.reconcileOrphans({ preserveManagedVolumeNames: protectedProviderState });
    console.log(JSON.stringify({
      level: 'info', msg: 'sandbox orphan reconciliation',
      removedContainers: orphanResult.removedContainers.length,
      removedVolumes: orphanResult.removedVolumes.length,
      removedNetworks: orphanResult.removedNetworks.length,
    }));

    // Steps 5-7: A6 evidence lifecycle (reconcile EXPIRED → Lane A → Lane B).
    // Global failure propagates and fails startup closed.
    // Per-resource failures are retained and reported inside the lifecycle.
    await runStartupEvidenceLifecycle(agentStore);

  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'agent control plane not configured (optional)' }));
  }

  // GitHub App control plane is separately optional and fail-closed. It reuses
  // the trusted logical project→hostPath registry from agents.yaml for local
  // push mappings. Remote repository discovery is separately bounded by trusted
  // GitHub accounts and gateway githubAccounts grants.
  if (fs.existsSync(GITHUB_CONFIG)) {
    if (!loadedAgentConfig) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GitHub control requires the trusted agent project registry', 503);
    // H1-1: central validator catches registry:port/repo (implicit latest) in addition to explicit :latest.
    const ghImgErr = validateImageRef(GITHUB_GIT_HELPER_IMAGE);
    if (!GITHUB_GIT_HELPER_IMAGE || ghImgErr) {
      throw new BridgeError('GITHUB_NOT_CONFIGURED', `GITHUB_GIT_HELPER_IMAGE must be an explicit non-latest image: ${ghImgErr ?? 'empty'}`, 503);
    }
    if (!GITHUB_CONTROL_NETWORK) throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GITHUB_CONTROL_NETWORK is required', 503);
    let githubHelperImageId: string;
    try {
      githubHelperImageId = (await inspectImage(GITHUB_GIT_HELPER_IMAGE)).Id;
    } catch {
      throw new BridgeError('GITHUB_NOT_CONFIGURED', 'GITHUB_GIT_HELPER_IMAGE is not available locally', 503);
    }
    const githubConfig = loadGitHubConfig(GITHUB_CONFIG);
    // Every GitHub project must resolve to an already-trusted local Git project.
    for (const repo of githubConfig.repositories) {
      const project = loadedAgentConfig.projects.find((p) => p.id === repo.project);
      if (!project || !project.gitRequired) {
        throw new BridgeError('GITHUB_NOT_CONFIGURED', `GitHub project ${repo.project} has no trusted gitRequired agent project`, 503);
      }
    }
    githubControl = new GitHubControl({
      config: githubConfig,
      agents: loadedAgentConfig,
      helperImage: githubHelperImageId,
      controlNetwork: GITHUB_CONTROL_NETWORK,
    });
    const swept = await githubControl.reconcileOrphans();
    console.log(JSON.stringify({
      level: 'info', msg: 'github control plane active', accounts: githubConfig.accounts.length, localRepositoryMappings: githubConfig.repositories.length,
      orphanContainersRemoved: swept.containers, orphanVolumesRemoved: swept.volumes,
    }));
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'github control plane not configured (optional)' }));
  }

  // Plane-B startup is an additional fail-closed startup barrier. When the
  // dedicated trusted config is absent it remains NOT_CONFIGURED. When present,
  // durable recovery/enrollment/runtime provisioning and every Unix listener
  // must complete before the HTTP executor can become externally reachable.
  ideCompanionRuntime = await startIdeCompanionProduction({
    configPath: IDE_SESSIONS_CONFIG,
    databasePath: IDE_SESSIONS_DB,
    runtimeRoot: IDE_RUNTIME_ROOT,
  });
  ideSessionControlState = ideCompanionRuntime.state;
  console.log(JSON.stringify({
    level: 'info', msg: 'ide session control startup', state: ideSessionControlState,
    enrollmentCount: ideCompanionRuntime.bootstrapBindings.length,
  }));

  // Step 8: all lifecycle steps complete — executor is now safe to accept requests.
  // P3: only after the socket binds successfully may recovered QUEUED work run.
  // If listen fails, no provider work is restarted.
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', msg: 'executor listening', port: PORT }));
    agentEngine?.kick();
  });

})().catch((e) => {
  console.error(JSON.stringify({
    level: 'fatal', msg: 'executor startup failed — fail closed',
    error: e instanceof Error ? e.message.slice(0, 500) : String(e),
  }));
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const hardExit = setTimeout(() => process.exit(0), 5000);
  hardExit.unref();
  try {
    // Plane-B listener shutdown owns its ordering: stop accepting/reconcile
    // channels, remove only owned sockets, then close the IDE session store.
    await ideCompanionRuntime?.stop();
  } catch { /* bounded fail-safe shutdown continues */ }
  agentEngine?.shutdown();
  try { agentStore?.close(); } catch { /* best effort */ }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
