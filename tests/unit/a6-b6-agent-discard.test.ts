/**
 * A6-B6: agent_discard activation — engine matrix, real wiring, and
 * gateway/schema/lifecycle coverage, per docs/audits/PHASE_A6_B6_AGENT_DISCARD.md.
 *
 * ENGINE tests exercise AgentJobEngine.discard() directly against a real
 * in-memory AgentJobStore(':memory:') — no Docker.
 *
 * The WIRING suite builds a real, Docker-free executor HTTP server (real
 * Express + real registerAgentRoutes()) on an OS-assigned loopback port, then
 * dynamically imports gateway/executorClient.js and gateway/agentTools.js
 * AFTER pointing EXECUTOR_URL/INTERNAL_TOKEN at it, so the real gateway
 * handler -> real executorClient.agentJobDiscard -> real HTTP -> real route
 * -> real AgentJobEngine.discard() -> real store chain is proven end to end
 * with zero mocking (per architecture §15's WIRING mechanism).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import express from 'express';
import { request as undiciRequest } from 'undici';
import { BridgeError, asBridgeError } from '../../src/shared/errors.js';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { AgentJobEngine } from '../../src/executor/agents/jobEngine.js';
import { registerAgentRoutes } from '../../src/executor/agents/routes.js';
import { withPrincipal } from '../../src/gateway/context.js';
import { AGENT_TOOL_SCHEMAS } from '../../src/gateway/agentSchemas.js';
import {
  canonicalSerialize, validateSnapshotManifest, validateArtifactManifest,
  type SnapshotManifest, type ArtifactManifest,
} from '../../src/executor/agents/canonicalJson.js';
import { computeCanonicalDiff, computeChangeSetHash } from '../../src/executor/agents/canonicalDiff.js';
import type { AgentControlPlaneConfig } from '../../src/executor/agentConfig.js';
import type { AgentJobStatus } from '../../src/shared/agents.js';
import type { Principal } from '../../src/gateway/config.js';

// ---------------------------------------------------------------------------
// Fixed test config / helpers
// ---------------------------------------------------------------------------

const CONFIG: AgentControlPlaneConfig = {
  backends: [],
  projects: [{ id: 'proj1', hostPath: '/srv/proj1', gitRequired: false, backends: ['kiro'], profiles: ['implement'], guardedPaths: [] }],
  profiles: [],
  resourcePolicies: [],
} as unknown as AgentControlPlaneConfig;

const PRINCIPAL_ID = 'client-a';
const TEST_PRINCIPAL: Principal = {
  id: PRINCIPAL_ID,
  name: 'Test Client',
  keyHash: 'a'.repeat(64),
  scopes: ['agents:read', 'agents:dispatch'],
  targets: [],
  enabled: true,
  projects: ['proj1'],
  agentBackends: ['kiro'],
  agentProfiles: ['implement'],
};

function makeJobId(): string { return `job_${randomBytes(16).toString('hex')}`; }
function sha256hex(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }

/** Seed a store with a job driven to a target status — no Docker, mirrors a6-b4's seedJob. */
function seedJob(store: AgentJobStore, jobId: string, status: AgentJobStatus, principalId = PRINCIPAL_ID): void {
  store.insert({
    jobId, principalId, backend: 'kiro', project: 'proj1', profile: 'implement',
    resourcePolicy: 'standard', promptHash: 'h'.repeat(64), prompt: 'p', sessionPolicy: 'new', writer: true,
  });
  if (status === 'QUEUED') return;
  if (status === 'FAILED_PRECONDITION') {
    // Only reachable directly from QUEUED (or PREPARING) per the real state machine.
    store.transition(jobId, 'QUEUED', 'FAILED_PRECONDITION', { failureCode: 'FAILED_PRECONDITION' });
    return;
  }
  store.transition(jobId, 'QUEUED', 'PREPARING');
  if (status === 'PREPARING') return;
  store.transition(jobId, 'PREPARING', 'RUNNING');
  if (status === 'RUNNING') return;
  store.transition(jobId, 'RUNNING', 'VALIDATING');
  if (status === 'VALIDATING') return;
  if (status === 'FAILED_AGENT' || status === 'FAILED_POLICY' || status === 'FAILED_TIMEOUT' ||
      status === 'FAILED_INFRASTRUCTURE' || status === 'CANCELLED') {
    store.transition(jobId, 'VALIDATING', status, { failureCode: status as never });
    return;
  }
  store.transition(jobId, 'VALIDATING', 'COMPLETED');
  if (status === 'COMPLETED') return;
  if (status === 'DISCARDED') { store.discardJob(jobId); return; }
  if (status === 'APPLIED') {
    const attemptId = `att_${randomBytes(16).toString('hex')}`;
    store.startApplyAttempt({ attemptId, jobId });
    store.transitionApplyAttempt(attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attemptId, 'VERIFYING', 'APPLYING');
    store.markApplySuccess(attemptId, jobId);
    return;
  }
}

async function errCode(fn: () => unknown): Promise<string> {
  try { await fn(); return 'NO_THROW'; }
  catch (e) { return e instanceof BridgeError ? e.code : `NON_BRIDGE:${e instanceof Error ? e.message.slice(0, 120) : String(e)}`; }
}

/** Build a minimal real canonical artifact + in-memory evidence source (no Docker). */
function buildTinyArtifact(jobId: string, projectId: string) {
  const baseCommit = 'a'.repeat(40);
  const beforeManifest: SnapshotManifest = { version: 1, entries: [] };
  const afterContent = Buffer.from('hello\n');
  const afterManifest: SnapshotManifest = {
    version: 1,
    entries: [{ path: 'a.txt', kind: 'file', mode: 0o644, sizeBytes: afterContent.length, contentHash: sha256hex(afterContent) }],
  };
  validateSnapshotManifest(beforeManifest);
  validateSnapshotManifest(afterManifest);
  const changeSet = computeCanonicalDiff(beforeManifest, afterManifest);
  const changeSetHash = computeChangeSetHash(changeSet);
  const beforeBytes = canonicalSerialize(beforeManifest);
  const afterBytes = canonicalSerialize(afterManifest);
  const manifest: ArtifactManifest = {
    version: 1, jobId, projectId, principalId: PRINCIPAL_ID, backend: 'kiro', profile: 'implement',
    baseCommit, baseCertified: true,
    beforeIdentity: sha256hex(beforeBytes), postIdentity: sha256hex(afterBytes),
    changeSetHash, contentComplete: true, applicable: true, reason: null,
    opCount: changeSet.entries.length, artifactBytes: afterContent.length, changes: changeSet.entries,
  };
  validateArtifactManifest(manifest);
  const manifestBytes = canonicalSerialize(manifest);
  const artifactHash = sha256hex(manifestBytes);
  const files = new Map<string, Buffer>([
    ['artifact-manifest.json', manifestBytes],
    ['before-snapshot-manifest.json', beforeBytes],
    ['post-snapshot-manifest.json', afterBytes],
  ]);
  const blobPrefix = sha256hex(afterContent).slice(0, 2);
  files.set(`blobs/${blobPrefix}/${sha256hex(afterContent)}`, afterContent);
  return {
    artifactHash, manifest,
    evidenceReaderFactory: () => ({
      async readFile(rel: string): Promise<Buffer> {
        const b = files.get(rel);
        if (!b) throw new Error(`not found: ${rel}`);
        return b;
      },
    }),
  };
}

function publishTinyArtifact(store: AgentJobStore, jobId: string, art: ReturnType<typeof buildTinyArtifact>): void {
  store.publishArtifact(jobId, {
    artifactHash: art.artifactHash,
    changeSetHash: art.manifest.changeSetHash,
    contentComplete: art.manifest.contentComplete,
    applicable: art.manifest.applicable,
    reason: art.manifest.reason,
    artifactVolume: 'vol-1',
    artifactBytes: art.manifest.artifactBytes,
    opCount: art.manifest.opCount,
  });
}

/**
 * Seed a job to COMPLETED with a real published artifact. publishArtifact()
 * requires VALIDATING (CAS: artifact_state must be NULL), so the artifact
 * must be published BEFORE the final VALIDATING -> COMPLETED transition —
 * mirrors a6-b4-agent-diff.test.ts's own seedJob(..., art) ordering exactly.
 */
function seedCompletedJobWithArtifact(store: AgentJobStore, jobId: string): ReturnType<typeof buildTinyArtifact> {
  store.insert({
    jobId, principalId: PRINCIPAL_ID, backend: 'kiro', project: 'proj1', profile: 'implement',
    resourcePolicy: 'standard', promptHash: 'h'.repeat(64), prompt: 'p', sessionPolicy: 'new', writer: true,
  });
  store.transition(jobId, 'QUEUED', 'PREPARING');
  store.transition(jobId, 'PREPARING', 'RUNNING');
  store.transition(jobId, 'RUNNING', 'VALIDATING');
  const art = buildTinyArtifact(jobId, 'proj1');
  store.setBaseCommit(jobId, art.manifest.baseCommit);
  publishTinyArtifact(store, jobId, art);
  store.transition(jobId, 'VALIDATING', 'COMPLETED');
  return art;
}

// ---------------------------------------------------------------------------
// ENGINE matrix — AgentJobEngine.discard() against a real in-memory store.
// ---------------------------------------------------------------------------

describe('A6-B6 ENGINE: AgentJobEngine.discard()', () => {
  it('SUCCESS: COMPLETED -> DISCARDED', () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const engine = new AgentJobEngine(store, CONFIG);
    const updated = engine.discard(jobId, PRINCIPAL_ID);
    expect(updated.status).toBe('DISCARDED');
    expect(store.get(jobId)!.status).toBe('DISCARDED');
    store.close();
  });

  it('UNKNOWN: unknown job -> UNKNOWN_JOB', () => {
    const store = new AgentJobStore(':memory:');
    const engine = new AgentJobEngine(store, CONFIG);
    expect(() => engine.discard(makeJobId(), PRINCIPAL_ID)).toThrow(BridgeError);
    let code = '';
    try { engine.discard(makeJobId(), PRINCIPAL_ID); } catch (e) { code = (e as BridgeError).code; }
    expect(code).toBe('UNKNOWN_JOB');
    store.close();
  });

  it('OWNERSHIP: non-owner -> FORBIDDEN_JOB', () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED', PRINCIPAL_ID);
    const engine = new AgentJobEngine(store, CONFIG);
    let code = '';
    try { engine.discard(jobId, 'someone-else'); } catch (e) { code = (e as BridgeError).code; }
    expect(code).toBe('FORBIDDEN_JOB');
    expect(store.get(jobId)!.status).toBe('COMPLETED'); // unchanged
    store.close();
  });

  const WRONG_STATES: AgentJobStatus[] = [
    'QUEUED', 'PREPARING', 'RUNNING', 'VALIDATING',
    'FAILED_PRECONDITION', 'FAILED_POLICY', 'FAILED_AGENT', 'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED',
    'APPLIED', 'DISCARDED',
  ];
  for (const s of WRONG_STATES) {
    it(`WRONG STATE: ${s} -> PRECONDITION_FAILED with the frozen message shape`, () => {
      const store = new AgentJobStore(':memory:');
      const jobId = makeJobId();
      seedJob(store, jobId, s);
      expect(store.get(jobId)!.status).toBe(s);
      const engine = new AgentJobEngine(store, CONFIG);
      let thrown: BridgeError | undefined;
      try { engine.discard(jobId, PRINCIPAL_ID); } catch (e) { thrown = e as BridgeError; }
      expect(thrown).toBeInstanceOf(BridgeError);
      expect(thrown!.code).toBe('PRECONDITION_FAILED');
      expect(thrown!.message).toBe(`job ${jobId} is ${s}, not COMPLETED; discard may only be performed on a COMPLETED job`);
      expect(store.get(jobId)!.status).toBe(s); // unchanged
      store.close();
    });
  }

  it('ACTIVE APPLY: STARTED attempt -> APPLY_ATTEMPT_ACTIVE', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    store.startApplyAttempt({ attemptId: `att_${randomBytes(16).toString('hex')}`, jobId });
    const engine = new AgentJobEngine(store, CONFIG);
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('APPLY_ATTEMPT_ACTIVE');
    expect(store.get(jobId)!.status).toBe('COMPLETED');
    store.close();
  });

  it('ACTIVE APPLY: VERIFYING attempt -> APPLY_ATTEMPT_ACTIVE', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const attemptId = `att_${randomBytes(16).toString('hex')}`;
    store.startApplyAttempt({ attemptId, jobId });
    store.transitionApplyAttempt(attemptId, 'STARTED', 'VERIFYING');
    const engine = new AgentJobEngine(store, CONFIG);
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('APPLY_ATTEMPT_ACTIVE');
    store.close();
  });

  it('ACTIVE APPLY: APPLYING attempt -> APPLY_ATTEMPT_ACTIVE', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const attemptId = `att_${randomBytes(16).toString('hex')}`;
    store.startApplyAttempt({ attemptId, jobId });
    store.transitionApplyAttempt(attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attemptId, 'VERIFYING', 'APPLYING');
    const engine = new AgentJobEngine(store, CONFIG);
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('APPLY_ATTEMPT_ACTIVE');
    store.close();
  });

  it('UNCERTAIN APPLY: recovered UNCERTAIN attempt -> APPLY_ATTEMPT_UNCERTAIN', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const attemptId = `att_${randomBytes(16).toString('hex')}`;
    store.startApplyAttempt({ attemptId, jobId });
    store.transitionApplyAttempt(attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('simulated crash');
    expect(store.getApplyAttempt(attemptId)!.state).toBe('UNCERTAIN');
    const engine = new AgentJobEngine(store, CONFIG);
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('APPLY_ATTEMPT_UNCERTAIN');
    expect(store.get(jobId)!.status).toBe('COMPLETED'); // never disposed
    store.close();
  });
});

// ---------------------------------------------------------------------------
// A6-B6 resource-scope negative proof (§17 of the bounded implementation
// task): AgentJobEngine.discard() performs no Docker I/O and touches only
// the job store. Proven behaviorally here (no fake Docker primitive is ever
// invoked because none is even constructed/injected for this engine).
// ---------------------------------------------------------------------------

describe('A6-B6 resource-scope negative proof', () => {
  it('discard() succeeds with an engine that has NO applierImage/applierIO/evidenceReaderFactory configured at all', () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    // Constructed with only (store, config) — no backend factory, no evidence
    // reader, no applier image/IO. discard() cannot possibly reach any Docker
    // or evidence code path, because none exists on this engine instance.
    const engine = new AgentJobEngine(store, CONFIG);
    const updated = engine.discard(jobId, PRINCIPAL_ID);
    expect(updated.status).toBe('DISCARDED');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// LIFECYCLE MATRIX — engine-level, no Docker.
// ---------------------------------------------------------------------------

describe('A6-B6 lifecycle matrix', () => {
  it('discard -> apply: PRECONDITION_FAILED (engine-level reconfirmation of the store-level proof)', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const engine = new AgentJobEngine(store, CONFIG);
    engine.discard(jobId, PRINCIPAL_ID);
    expect(store.get(jobId)!.status).toBe('DISCARDED');
    // apply() requires evidenceReaderFactory/applierIO to get past its own
    // config guards; what matters here is the store-level admission check
    // (startApplyAttempt) that apply() delegates to — already proven
    // directly at the store level (agent-apply-state.test.ts). Reconfirm
    // via the store primitive apply() itself would call:
    expect(await errCode(async () => store.startApplyAttempt({ attemptId: `att_${randomBytes(16).toString('hex')}`, jobId }))).toBe('PRECONDITION_FAILED');
    store.close();
  });

  it('apply -> discard: PRECONDITION_FAILED', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'APPLIED');
    expect(store.get(jobId)!.status).toBe('APPLIED');
    const engine = new AgentJobEngine(store, CONFIG);
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('PRECONDITION_FAILED');
    expect(store.get(jobId)!.status).toBe('APPLIED'); // unchanged
    store.close();
  });

  it('discard twice: second call PRECONDITION_FAILED, no second side effect', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const engine = new AgentJobEngine(store, CONFIG);
    const first = engine.discard(jobId, PRINCIPAL_ID);
    expect(first.status).toBe('DISCARDED');
    const dispositionAt = store.get(jobId)!.dispositionAt;
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('PRECONDITION_FAILED');
    expect(store.get(jobId)!.status).toBe('DISCARDED');
    expect(store.get(jobId)!.dispositionAt).toBe(dispositionAt); // unchanged
    store.close();
  });

  it('apply active -> discard: APPLY_ATTEMPT_ACTIVE', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    store.startApplyAttempt({ attemptId: `att_${randomBytes(16).toString('hex')}`, jobId });
    const engine = new AgentJobEngine(store, CONFIG);
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('APPLY_ATTEMPT_ACTIVE');
    store.close();
  });

  it('apply uncertain -> discard: APPLY_ATTEMPT_UNCERTAIN', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const attemptId = `att_${randomBytes(16).toString('hex')}`;
    store.startApplyAttempt({ attemptId, jobId });
    store.transitionApplyAttempt(attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attemptId, 'VERIFYING', 'APPLYING');
    store.recoverApplyAttempts('simulated crash');
    const engine = new AgentJobEngine(store, CONFIG);
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('APPLY_ATTEMPT_UNCERTAIN');
    store.close();
  });

  it('discard -> diff: DISCARDED remains reviewable (real artifact + evidence reader, engine.discard() specifically, no Docker)', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    const art = seedCompletedJobWithArtifact(store, jobId);
    const engine = new AgentJobEngine(store, CONFIG, undefined, undefined, art.evidenceReaderFactory);
    engine.discard(jobId, PRINCIPAL_ID);
    expect(store.get(jobId)!.status).toBe('DISCARDED');
    const r = await engine.diff({ jobId, principal: PRINCIPAL_ID });
    expect(r.artifactHash).toBe(art.artifactHash);
    store.close();
  });

  it('diff -> discard: review before discard, then discard succeeds and diff remains valid after', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    const art = seedCompletedJobWithArtifact(store, jobId);
    const engine = new AgentJobEngine(store, CONFIG, undefined, undefined, art.evidenceReaderFactory);
    const before = await engine.diff({ jobId, principal: PRINCIPAL_ID });
    expect(before.artifactHash).toBe(art.artifactHash);
    engine.discard(jobId, PRINCIPAL_ID);
    expect(store.get(jobId)!.status).toBe('DISCARDED');
    const after = await engine.diff({ jobId, principal: PRINCIPAL_ID });
    expect(after.artifactHash).toBe(art.artifactHash);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// RESTART / DURABILITY
// ---------------------------------------------------------------------------

describe('A6-B6 restart / durability', () => {
  it('lost-response/retry model: second engine.discard() after a durable DISCARDED sees PRECONDITION_FAILED, no second side effect', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const engine = new AgentJobEngine(store, CONFIG);
    engine.discard(jobId, PRINCIPAL_ID);
    const dispositionAt = store.get(jobId)!.dispositionAt;
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('PRECONDITION_FAILED');
    expect(store.get(jobId)!.dispositionAt).toBe(dispositionAt);
    store.close();
  });

  it('simulated apply recovery: recoverApplyAttempts() UNCERTAIN+quarantine, then discard sees APPLY_ATTEMPT_UNCERTAIN, no disposition mutation', async () => {
    const store = new AgentJobStore(':memory:');
    const jobId = makeJobId();
    seedJob(store, jobId, 'COMPLETED');
    const attemptId = `att_${randomBytes(16).toString('hex')}`;
    store.startApplyAttempt({ attemptId, jobId });
    store.transitionApplyAttempt(attemptId, 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt(attemptId, 'VERIFYING', 'APPLYING');
    const recovered = store.recoverApplyAttempts('executor restarted');
    expect(recovered.uncertain).toContain(attemptId);
    expect(store.getProjectApplyState('proj1')?.state).toBe('QUARANTINED');
    const engine = new AgentJobEngine(store, CONFIG);
    expect(await errCode(async () => engine.discard(jobId, PRINCIPAL_ID))).toBe('APPLY_ATTEMPT_UNCERTAIN');
    expect(store.get(jobId)!.status).toBe('COMPLETED');
    expect(store.get(jobId)!.dispositionAt).toBeNull();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// WIRING + strict route validation + gateway registration/schema proof.
//
// Real, Docker-free, unmocked end-to-end HTTP mechanism per architecture
// §15's WIRING bullet: real Express + real registerAgentRoutes() + real
// AgentJobEngine + real AgentJobStore(':memory:') on an OS-assigned loopback
// port; EXECUTOR_URL/INTERNAL_TOKEN are set BEFORE the first (dynamic)
// import of executorClient.js/agentTools.js in this test file.
// ---------------------------------------------------------------------------

const TEST_TOKEN = `b6-test-token-${randomBytes(8).toString('hex')}`;

describe('A6-B6 WIRING: gateway -> executor-client -> HTTP -> route -> engine (real, unmocked)', () => {
  let server: Server;
  let port: number;
  let wiredStore: AgentJobStore;
  let wiredEngine: AgentJobEngine;
  let discardHandler: (args: unknown) => Promise<{ content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>;
  let registeredTools: { name: string; cfg: { annotations?: Record<string, unknown>; inputSchema?: unknown; outputSchema?: unknown } }[];

  beforeAll(async () => {
    wiredStore = new AgentJobStore(':memory:');
    wiredEngine = new AgentJobEngine(wiredStore, CONFIG);

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use((req, res, next) => {
      const got = req.header('x-internal-token');
      if (!got || got !== TEST_TOKEN) { res.status(401).json({ error: 'UNAUTHENTICATED', message: 'bad internal token' }); return; }
      next();
    });
    function handle(fn: (req: express.Request, res: express.Response) => Promise<unknown>) {
      return (req: express.Request, res: express.Response) => {
        fn(req, res)
          .then((body) => { if (!res.headersSent) res.json(body ?? { ok: true }); })
          .catch((e) => { const be = asBridgeError(e); res.status(be.httpStatus).json(be.toJSON()); });
      };
    }
    registerAgentRoutes(app, handle, () => wiredEngine);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind an ephemeral loopback port for the B6 wiring harness');
    port = addr.port;

    // Set env BEFORE the first import of executorClient.js/agentTools.js —
    // both read EXECUTOR_URL/INTERNAL_TOKEN into top-level consts at import
    // time. Neither module is statically imported anywhere in this file.
    process.env.INTERNAL_TOKEN = TEST_TOKEN;
    process.env.EXECUTOR_URL = `http://127.0.0.1:${port}`;

    const agentToolsMod = await import('../../src/gateway/agentTools.js');

    const captured: { name: string; cfg: never; handler: never }[] = [];
    const fakeServer = {
      registerTool(name: string, cfg: never, handler: never) { captured.push({ name, cfg, handler }); },
    };
    agentToolsMod.registerAgentTools(fakeServer as never);
    registeredTools = captured as never;
    const found = captured.find((t) => t.name === 'agent_discard');
    if (!found) throw new Error('agent_discard was not registered by registerAgentTools()');
    discardHandler = found.handler as never;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    wiredStore.close();
  });

  it('full chain: gateway handler -> agentJobDiscard -> HTTP -> strict route -> AgentJobEngine.discard() -> store, real end to end', async () => {
    const jobId = makeJobId();
    seedJob(wiredStore, jobId, 'COMPLETED');

    const result = await withPrincipal(TEST_PRINCIPAL, () => discardHandler({ jobId }));

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ jobId, status: 'DISCARDED' });
    // Independently verify the REAL underlying store — proves the HTTP round
    // trip actually reached AgentJobStore.discardJob(), not just that the
    // handler returned a plausible-looking object.
    expect(wiredStore.get(jobId)!.status).toBe('DISCARDED');
  });

  it('non-owner is refused end to end: FORBIDDEN_JOB surfaces through the real HTTP chain', async () => {
    const jobId = makeJobId();
    seedJob(wiredStore, jobId, 'COMPLETED', 'someone-else');
    const result = await withPrincipal(TEST_PRINCIPAL, () => discardHandler({ jobId }));
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { error: string };
    expect(parsed.error).toBe('FORBIDDEN_JOB');
    expect(wiredStore.get(jobId)!.status).toBe('COMPLETED'); // unchanged
  });

  it('wrong state is refused end to end: PRECONDITION_FAILED surfaces through the real HTTP chain', async () => {
    const jobId = makeJobId();
    seedJob(wiredStore, jobId, 'RUNNING');
    const result = await withPrincipal(TEST_PRINCIPAL, () => discardHandler({ jobId }));
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text) as { error: string };
    expect(parsed.error).toBe('PRECONDITION_FAILED');
  });

  describe('strict route defense-in-depth (raw HTTP, bypassing the gateway entirely)', () => {
    it('TEST A: missing principal -> MALFORMED_REQUEST', async () => {
      const jobId = makeJobId();
      seedJob(wiredStore, jobId, 'COMPLETED');
      const res = await undiciRequest(`http://127.0.0.1:${port}/agent/jobs/${jobId}/discard`, {
        method: 'POST',
        headers: { 'x-internal-token': TEST_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.body.json() as { error: string };
      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('MALFORMED_REQUEST');
      expect(wiredStore.get(jobId)!.status).toBe('COMPLETED'); // unchanged
    });

    it('TEST B: valid principal PLUS an unexpected extra property -> MALFORMED_REQUEST (proves discardBody.strict())', async () => {
      const jobId = makeJobId();
      seedJob(wiredStore, jobId, 'COMPLETED');
      const res = await undiciRequest(`http://127.0.0.1:${port}/agent/jobs/${jobId}/discard`, {
        method: 'POST',
        headers: { 'x-internal-token': TEST_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ principal: PRINCIPAL_ID, extra: 'x' }),
      });
      const body = await res.body.json() as { error: string };
      expect(res.statusCode).toBe(400);
      expect(body.error).toBe('MALFORMED_REQUEST');
      expect(wiredStore.get(jobId)!.status).toBe('COMPLETED'); // unchanged — no mutation from a rejected request
    });
  });

  describe('gateway registration / schema proof', () => {
    it('agent_discard is registered with the frozen DISCARD annotations (non-read-only)', () => {
      const t = registeredTools.find((x) => x.name === 'agent_discard')!;
      expect(t).toBeDefined();
      expect(t.cfg.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    });

    it('agent_discard uses the frozen AGENT_TOOL_SCHEMAS entry', () => {
      const t = registeredTools.find((x) => x.name === 'agent_discard')!;
      expect(t.cfg.inputSchema).toBe(AGENT_TOOL_SCHEMAS.agent_discard.input);
      expect(t.cfg.outputSchema).toBe(AGENT_TOOL_SCHEMAS.agent_discard.output);
    });

    it('agentDiscardInput rejects unknown properties (host path / Docker / artifact controls are inexpressible)', () => {
      const input = AGENT_TOOL_SCHEMAS.agent_discard.input;
      expect(input.safeParse({ jobId: makeJobId() }).success).toBe(true);
      expect(input.safeParse({ jobId: makeJobId(), hostPath: '/etc' }).success).toBe(false);
      expect(input.safeParse({ jobId: makeJobId(), dockerOptions: {} }).success).toBe(false);
      expect(input.safeParse({ jobId: makeJobId(), artifactId: 'x' }).success).toBe(false);
      expect(input.safeParse({ jobId: makeJobId(), patch: 'x' }).success).toBe(false);
      expect(input.safeParse({}).success).toBe(false);
    });

    it('agentDiscardOutput rejects unknown properties', () => {
      const output = AGENT_TOOL_SCHEMAS.agent_discard.output;
      expect(output.safeParse({ jobId: makeJobId(), status: 'DISCARDED' }).success).toBe(true);
      expect(output.safeParse({ jobId: makeJobId(), status: 'DISCARDED', project: 'proj1' }).success).toBe(false);
      expect(output.safeParse({ jobId: makeJobId(), status: 'DISCARDED', hostPath: '/etc' }).success).toBe(false);
    });
  });
});
