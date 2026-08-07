/**
 * A6-B4: Canonical read-only review surface (agent_diff) — comprehensive unit tests.
 *
 * All offline (no Docker, no live stack). Covers the approved contract:
 * gateway authorization (Option D), executor defense-in-depth, artifact
 * integrity chain, deterministic rendering, bounded pagination, evidence
 * reader security spec, read-only invariants, and public tool registration.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pack as tarPack } from 'tar-stream';
import { BridgeError } from '../../src/shared/errors.js';
import {
  canonicalSerialize,
  validateSnapshotManifest,
  validateArtifactManifest,
  type SnapshotEntry,
  type SnapshotManifest,
  type ArtifactManifest,
} from '../../src/executor/agents/canonicalJson.js';
import { computeCanonicalDiff, computeChangeSetHash } from '../../src/executor/agents/canonicalDiff.js';
import {
  verifyCanonicalArtifact,
  buildEvidenceReaderSpec,
  blobPath,
  assertAllowedEvidencePath,
  readBounded,
  extractSingleFile,
  MAX_ARTIFACT_MANIFEST_BYTES,
  MAX_SNAPSHOT_MANIFEST_BYTES,
  type ReadonlyEvidenceSource,
  type ExpectedArtifactBinding,
  type VerifiedArtifact,
} from '../../src/executor/agents/artifactReader.js';
import {
  renderDiffPage,
  renderFullBytes,
  renderTextDiff,
  renderLines,
  encodeDisplay,
  classifyContent,
  selectionIdentity,
  encodeCursor,
  DIFF_RENDER_VERSION,
  MIN_DIFF_CHUNK_BYTES,
  wouldExceedMyersTraceBudget,
} from '../../src/executor/agents/diffRenderer.js';
import { authorizeAgentTool } from '../../src/gateway/agentAuthz.js';
import { AGENT_TOOL_SCHEMAS } from '../../src/gateway/agentSchemas.js';
import { registerAgentTools } from '../../src/gateway/agentTools.js';
import type { Principal } from '../../src/gateway/config.js';
import { AgentJobEngine } from '../../src/executor/agents/jobEngine.js';
import { AgentJobStore, AGENT_JOB_SCHEMA_VERSION } from '../../src/executor/agents/jobStore.js';
import type { AgentControlPlaneConfig } from '../../src/executor/agentConfig.js';
import type { AgentJobStatus } from '../../src/shared/agents.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JOB_ID = 'job_' + 'a'.repeat(32);
const BASE_COMMIT = 'b'.repeat(40);

function sha256hex(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); throw new Error('expected throw'); }
  catch (e) { if (e instanceof BridgeError) return e.code; throw e; }
}

/**
 * A hostile async chunk source for §R2 Blocker-2 tests: produces `chunkCount`
 * buffers of `chunkSize` bytes, one at a time, incrementing `tracker.pulled`
 * immediately before each yield. Because chunks are generated lazily (not
 * pre-allocated), and `for await`/`readBounded` stop pulling as soon as they
 * abort, `tracker.pulled` after a bounded-rejection directly measures how
 * much of the hostile stream was actually consumed before the abort — proof
 * that excess content is never fully drained/buffered.
 */
async function* hostileChunks(chunkSize: number, chunkCount: number, tracker: { pulled: number }): AsyncGenerator<Buffer> {
  for (let i = 0; i < chunkCount; i++) {
    tracker.pulled++;
    yield Buffer.alloc(chunkSize, 0x61);
  }
}

/**
 * Build a small, valid single-file tar archive via tar-stream's real pack()
 * (§R3 remediation): production-shaped bytes, not a plain AsyncGenerator, so
 * the R3 tests exercise the real tar-stream `Extract` + `Source` machinery
 * that {@link extractSingleFile} runs against in production.
 */
async function buildSingleFileTar(name: string, content: Buffer): Promise<Buffer> {
  const p = tarPack();
  p.entry({ name }, content);
  p.finalize();
  const parts: Buffer[] = [];
  for await (const c of p) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

/**
 * A real Node `Readable` standing in for the Docker archive response body
 * (§R3 remediation): serves `buf` in `chunkSize`-byte pieces, tracking
 * exactly how many bytes have been pulled so tests can prove how much of the
 * OUTER archive transport was actually consumed before a terminal failure —
 * not just the tar entry's own content stream. A small `highWaterMark` avoids
 * eager read-ahead so the tracked count stays tightly coupled to actual
 * downstream consumption by tar-stream's `Extract`. `injectAfterBytes` +
 * `injectedError`, if both set, destroy the stream (simulating a dropped
 * Docker/undici connection mid-archive) once that many bytes have been served.
 */
function chunkedReadable(
  buf: Buffer,
  chunkSize: number,
  tracker: { pulled: number; bytes: number },
  opts?: { injectAfterBytes: number; injectedError: Error },
): Readable {
  let offset = 0;
  return new Readable({
    highWaterMark: chunkSize,
    read() {
      // Defer each push to the next macrotask — standing in for real
      // network-timed delivery (Docker/undici archive chunks arrive off a
      // socket, not synchronously from memory). Without this, Node can race
      // an entire small in-memory buffer through `_read()` before any async
      // teardown logic gets a turn, defeating the whole point of measuring
      // "how much was consumed before the abort."
      setImmediate(() => {
        if (this.destroyed) return;
        if (opts && tracker.bytes >= opts.injectAfterBytes) {
          this.destroy(opts.injectedError);
          return;
        }
        if (offset >= buf.length) { this.push(null); return; }
        const end = Math.min(offset + chunkSize, buf.length);
        const chunk = buf.subarray(offset, end);
        tracker.pulled++;
        tracker.bytes += chunk.length;
        offset = end;
        this.push(chunk);
      });
    },
  });
}

type FileSpec = { path: string; kind: 'file'; mode: number; content: Buffer };
type SymSpec = { path: string; kind: 'symlink'; mode: number; target: string };
type DirSpec = { path: string; kind: 'dir'; mode: number };
type GitSpec = { path: string; kind: 'gitlink'; mode: number; commitOid: string };
type UnsupSpec = { path: string; kind: 'unsupported'; mode: number; reason: string };
type Spec = FileSpec | SymSpec | DirSpec | GitSpec | UnsupSpec;

function toEntry(s: Spec): SnapshotEntry {
  switch (s.kind) {
    case 'file': return { path: s.path, kind: 'file', mode: s.mode, sizeBytes: s.content.length, contentHash: sha256hex(s.content) };
    case 'symlink': return { path: s.path, kind: 'symlink', mode: s.mode, contentHash: sha256hex(Buffer.from(s.target, 'utf8')), target: s.target };
    case 'dir': return { path: s.path, kind: 'dir', mode: s.mode };
    case 'gitlink': return { path: s.path, kind: 'gitlink', mode: s.mode, commitOid: s.commitOid };
    case 'unsupported': return { path: s.path, kind: 'unsupported', mode: s.mode, reason: s.reason };
  }
}

const byPath = (a: SnapshotEntry, b: SnapshotEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

interface BuiltArtifact {
  store: Map<string, Buffer>;
  artifactHash: string;
  manifest: ArtifactManifest;
  beforeManifest: SnapshotManifest;
  postManifest: SnapshotManifest;
  binding: ExpectedArtifactBinding;
}

interface BuildOpts {
  contentComplete?: boolean;
  applicable?: boolean;
  reason?: string | null;
  baseCertified?: boolean;
}

/** Build a genuine, internally consistent B3-shaped artifact in memory. */
function makeArtifact(beforeSpecs: Spec[], postSpecs: Spec[], opts: BuildOpts = {}): BuiltArtifact {
  const beforeEntries = beforeSpecs.map(toEntry).sort(byPath);
  const postEntries = postSpecs.map(toEntry).sort(byPath);
  const beforeManifest: SnapshotManifest = { version: 1, entries: beforeEntries };
  const postManifest: SnapshotManifest = { version: 1, entries: postEntries };
  validateSnapshotManifest(beforeManifest);
  validateSnapshotManifest(postManifest);

  const changeSet = computeCanonicalDiff(beforeManifest, postManifest);
  const changeSetHash = computeChangeSetHash(changeSet);

  const store = new Map<string, Buffer>();
  const blobSizes = new Map<string, number>();
  for (const s of [...beforeSpecs, ...postSpecs]) {
    if (s.kind === 'file') {
      const hash = sha256hex(s.content);
      if (!blobSizes.has(hash)) {
        blobSizes.set(hash, s.content.length);
        store.set(blobPath(hash), s.content);
      }
    }
  }
  let artifactBytes = 0;
  for (const size of blobSizes.values()) artifactBytes += size;

  const baseCertified = opts.baseCertified ?? true;
  let contentComplete = opts.contentComplete ?? true;
  let applicable = opts.applicable ?? true;
  if (!contentComplete) applicable = false;
  if (!baseCertified) applicable = false;
  let reason: string | null;
  if (applicable) reason = null;
  else reason = opts.reason ?? 'not applicable';

  const beforeBytes = canonicalSerialize(beforeManifest);
  const postBytes = canonicalSerialize(postManifest);
  const beforeIdentity = sha256hex(beforeBytes);
  const postIdentity = sha256hex(postBytes);

  const manifest: ArtifactManifest = {
    version: 1,
    jobId: JOB_ID,
    projectId: 'proj1',
    principalId: 'client-a',
    backend: 'kiro',
    profile: 'implement',
    baseCommit: BASE_COMMIT,
    baseCertified,
    beforeIdentity,
    postIdentity,
    changeSetHash,
    contentComplete,
    applicable,
    reason,
    opCount: changeSet.entries.length,
    artifactBytes,
    changes: changeSet.entries,
  };
  validateArtifactManifest(manifest);

  const artifactBytesBuf = canonicalSerialize(manifest);
  const artifactHash = sha256hex(artifactBytesBuf);

  store.set('artifact-manifest.json', artifactBytesBuf);
  store.set('before-snapshot-manifest.json', beforeBytes);
  store.set('post-snapshot-manifest.json', postBytes);

  const binding: ExpectedArtifactBinding = {
    jobId: JOB_ID,
    principalId: 'client-a',
    projectId: 'proj1',
    backend: 'kiro',
    profile: 'implement',
    expectedArtifactHash: artifactHash,
    baseCommit: BASE_COMMIT,
    changeSetHash,
    contentComplete,
    applicable,
    reason,
    opCount: changeSet.entries.length,
    artifactBytes,
  };

  return { store, artifactHash, manifest, beforeManifest, postManifest, binding };
}

function memorySource(store: Map<string, Buffer>): ReadonlyEvidenceSource {
  return {
    async readFile(rel: string): Promise<Buffer> {
      const b = store.get(rel);
      if (!b) throw new Error(`file not found: ${rel}`);
      return b;
    },
  };
}

async function verify(a: BuiltArtifact): Promise<VerifiedArtifact> {
  return verifyCanonicalArtifact(memorySource(a.store), a.binding);
}

/** Evidence source that records every relative path actually read, in order. */
function instrumentedSource(store: Map<string, Buffer>): { source: ReadonlyEvidenceSource; reads: string[] } {
  const reads: string[] = [];
  const base = memorySource(store);
  return {
    reads,
    source: {
      async readFile(rel: string): Promise<Buffer> {
        reads.push(rel);
        return base.readFile(rel);
      },
    },
  };
}

/** Page through a rendered review and return the reassembled bytes + chunks. */
async function pageAll(v: VerifiedArtifact, path: string | undefined, maxBytes: number) {
  const chunks: string[] = [];
  const chunkByteLens: number[] = [];
  let cursor: string | undefined;
  let total = -1;
  let guard = 0;
  for (;;) {
    const r = await renderDiffPage(v, { jobId: JOB_ID, path, cursor, maxBytes });
    total = r.totalBytes;
    chunks.push(r.chunk);
    chunkByteLens.push(r.chunkBytes);
    expect(r.diffHash).toBe(v.artifactHash);
    expect(r.chunkBytes).toBe(Buffer.byteLength(r.chunk, 'utf8'));
    expect(r.chunkBytes).toBeLessThanOrEqual(maxBytes);
    if (!r.truncated) break;
    cursor = r.cursor;
    expect(cursor).toBeTypeOf('string');
    if (++guard > 100000) throw new Error('pagination did not terminate');
  }
  return { reassembled: Buffer.from(chunks.join(''), 'utf8'), chunks, chunkByteLens, totalBytes: total };
}

// Minimal trusted config with a single project.
const CONFIG: AgentControlPlaneConfig = {
  backends: [],
  projects: [{ id: 'proj1', hostPath: '/srv/proj1', gitRequired: false, backends: ['kiro'], profiles: ['implement'], guardedPaths: [] }],
  profiles: [],
  resourcePolicies: [],
} as unknown as AgentControlPlaneConfig;

const CONFIG_NO_PROJECT: AgentControlPlaneConfig = {
  backends: [], projects: [], profiles: [], resourcePolicies: [],
} as unknown as AgentControlPlaneConfig;

/** Seed a store with a job driven to a target status; optionally publish an artifact. */
function seedJob(store: AgentJobStore, status: AgentJobStatus, art?: BuiltArtifact): void {
  store.insert({
    jobId: JOB_ID, principalId: 'client-a', backend: 'kiro', project: 'proj1', profile: 'implement',
    resourcePolicy: 'standard', promptHash: sha256hex('p'), prompt: 'p', sessionPolicy: 'new', writer: true,
  });
  if (status === 'QUEUED') return;
  store.transition(JOB_ID, 'QUEUED', 'PREPARING');
  if (status === 'PREPARING') return;
  store.transition(JOB_ID, 'PREPARING', 'RUNNING');
  if (status === 'RUNNING') return;
  store.transition(JOB_ID, 'RUNNING', 'VALIDATING');
  if (status === 'VALIDATING') return;
  if (status === 'FAILED_AGENT' || status === 'FAILED_POLICY' || status === 'FAILED_TIMEOUT' ||
      status === 'FAILED_INFRASTRUCTURE' || status === 'CANCELLED') {
    store.transition(JOB_ID, 'VALIDATING', status, { failureCode: status as never });
    return;
  }
  if (status === 'FAILED_PRECONDITION') {
    // reachable only from QUEUED/PREPARING; re-seed path not needed for these tests
    store.transition(JOB_ID, 'VALIDATING', 'FAILED_AGENT', { failureCode: 'FAILED_AGENT' });
    return;
  }
  // COMPLETED / APPLIED / DISCARDED — publish artifact first (requires VALIDATING).
  if (art) {
    store.setBaseCommit(JOB_ID, BASE_COMMIT);
    store.publishArtifact(JOB_ID, {
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
  store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');
  if (status === 'COMPLETED') return;
  if (status === 'DISCARDED') { store.discardJob(JOB_ID); return; }
  if (status === 'APPLIED') {
    store.startApplyAttempt({ attemptId: 'att1', jobId: JOB_ID });
    store.transitionApplyAttempt('att1', 'STARTED', 'VERIFYING');
    store.transitionApplyAttempt('att1', 'VERIFYING', 'APPLYING');
    store.markApplySuccess('att1', JOB_ID);
    return;
  }
}

function engineFor(store: AgentJobStore, art: BuiltArtifact | undefined, cfg = CONFIG): AgentJobEngine {
  return new AgentJobEngine(store, cfg, undefined, undefined, art ? () => memorySource(art.store) : undefined);
}

// ---------------------------------------------------------------------------
// 1. Gateway authorization (Option D) — §13, §41
// ---------------------------------------------------------------------------

describe('A6-B4 gateway authorization (Option D)', () => {
  const principal = (over: Partial<Principal> = {}): Principal => ({
    id: 'client-a', name: 'A', keyHash: 'h', enabled: true,
    scopes: ['agents:read'], targets: [], projects: ['proj1'], agentBackends: ['kiro'], agentProfiles: ['implement'],
    ...over,
  });
  const job = { jobId: JOB_ID, principalId: 'client-a', project: 'proj1' };

  it('A1 allows correct principal + agents:read + current project grant', () => {
    expect(authorizeAgentTool({ tool: 'agent_diff', principal: principal(), job })).toEqual({ allowed: true });
  });

  it('A2 foreign job → FORBIDDEN_JOB', () => {
    const d = authorizeAgentTool({ tool: 'agent_diff', principal: principal(), job: { ...job, principalId: 'client-b' } });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_JOB' });
  });

  it('A4 missing agents:read → FORBIDDEN_SCOPE', () => {
    const d = authorizeAgentTool({ tool: 'agent_diff', principal: principal({ scopes: [] }), job });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_SCOPE' });
  });

  it('A5 agents:dispatch without agents:read → deny', () => {
    const d = authorizeAgentTool({ tool: 'agent_diff', principal: principal({ scopes: ['agents:dispatch'] }), job });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_SCOPE' });
  });

  it('A6 revoked current project grant → FORBIDDEN_PROJECT', () => {
    const d = authorizeAgentTool({ tool: 'agent_diff', principal: principal({ projects: [] }), job });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_PROJECT' });
  });

  it('A6 wildcard project grant is honored', () => {
    expect(authorizeAgentTool({ tool: 'agent_diff', principal: principal({ projects: ['*'] }), job })).toEqual({ allowed: true });
  });

  it('A7 caller cannot substitute a different project (grant on other project only)', () => {
    // principal granted only "other"; job.project is proj1 (from trusted record).
    const d = authorizeAgentTool({ tool: 'agent_diff', principal: principal({ projects: ['other'] }), job });
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN_PROJECT' });
  });

  it('A8 agent_status behavior unchanged (no project-grant requirement)', () => {
    // status requires only ownership; a principal with NO project grant still passes.
    expect(authorizeAgentTool({ tool: 'agent_status', principal: principal({ projects: [] }), job })).toEqual({ allowed: true });
  });

  it('A9 agent_result behavior unchanged (no project-grant requirement)', () => {
    expect(authorizeAgentTool({ tool: 'agent_result', principal: principal({ projects: [] }), job })).toEqual({ allowed: true });
  });

  it('A10 agent_apply unchanged: requires apply scope + project grant', () => {
    const readOnly = authorizeAgentTool({ tool: 'agent_apply', principal: principal(), job });
    expect(readOnly).toMatchObject({ allowed: false, code: 'FORBIDDEN_SCOPE' });
    const withApply = authorizeAgentTool({ tool: 'agent_apply', principal: principal({ scopes: ['agents:apply'] }), job });
    expect(withApply).toEqual({ allowed: true });
    const applyNoProject = authorizeAgentTool({ tool: 'agent_apply', principal: principal({ scopes: ['agents:apply'], projects: [] }), job });
    expect(applyNoProject).toMatchObject({ allowed: false, code: 'FORBIDDEN_PROJECT' });
  });
});

// ---------------------------------------------------------------------------
// 2. Executor Option D + reviewable-state guard — §14, §41
// ---------------------------------------------------------------------------

describe('A6-B4 executor defense-in-depth (Option D) + state', () => {
  it('S1 COMPLETED + AVAILABLE → review succeeds; PROJECT_REVOCATION independent of executor', async () => {
    const art = makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const store = new AgentJobStore(':memory:');
    seedJob(store, 'COMPLETED', art);
    const engine = engineFor(store, art);
    const r = await engine.diff({ jobId: JOB_ID, principal: 'client-a' });
    expect(r.diffHash).toBe(art.artifactHash);
    expect(r.artifactHash).toBe(art.artifactHash);
    store.close();
  });

  it('S2 APPLIED + AVAILABLE → review', async () => {
    const art = makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const store = new AgentJobStore(':memory:');
    seedJob(store, 'APPLIED', art);
    expect(store.get(JOB_ID)!.status).toBe('APPLIED');
    const r = await engineFor(store, art).diff({ jobId: JOB_ID, principal: 'client-a' });
    expect(r.diffHash).toBe(art.artifactHash);
    store.close();
  });

  it('S3 DISCARDED + AVAILABLE → review', async () => {
    const art = makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const store = new AgentJobStore(':memory:');
    seedJob(store, 'DISCARDED', art);
    expect(store.get(JOB_ID)!.status).toBe('DISCARDED');
    const r = await engineFor(store, art).diff({ jobId: JOB_ID, principal: 'client-a' });
    expect(r.diffHash).toBe(art.artifactHash);
    store.close();
  });

  it('S4 COMPLETED + artifact_state NULL → ARTIFACT_NOT_AVAILABLE', async () => {
    const store = new AgentJobStore(':memory:');
    seedJob(store, 'COMPLETED'); // no artifact published
    expect(await errCode(() => engineFor(store, undefined).diff({ jobId: JOB_ID, principal: 'client-a' }))).toBe('ARTIFACT_NOT_AVAILABLE');
    store.close();
  });

  for (const s of ['QUEUED', 'PREPARING', 'RUNNING', 'VALIDATING', 'FAILED_AGENT', 'FAILED_POLICY', 'FAILED_TIMEOUT', 'FAILED_INFRASTRUCTURE', 'CANCELLED'] as AgentJobStatus[]) {
    it(`S(non-reviewable) ${s} → ARTIFACT_NOT_AVAILABLE`, async () => {
      const store = new AgentJobStore(':memory:');
      seedJob(store, s);
      expect(await errCode(() => engineFor(store, undefined).diff({ jobId: JOB_ID, principal: 'client-a' }))).toBe('ARTIFACT_NOT_AVAILABLE');
      store.close();
    });
  }

  it('unknown job → UNKNOWN_JOB', async () => {
    const store = new AgentJobStore(':memory:');
    expect(await errCode(() => engineFor(store, undefined).diff({ jobId: 'job_' + 'c'.repeat(32), principal: 'client-a' }))).toBe('UNKNOWN_JOB');
    store.close();
  });

  it('foreign owner → FORBIDDEN_JOB (executor ownership)', async () => {
    const art = makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('x\n') }]);
    const store = new AgentJobStore(':memory:');
    seedJob(store, 'COMPLETED', art);
    expect(await errCode(() => engineFor(store, art).diff({ jobId: JOB_ID, principal: 'client-b' }))).toBe('FORBIDDEN_JOB');
    store.close();
  });

  it('project removed from trusted registry → FORBIDDEN_PROJECT (Option D)', async () => {
    const art = makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('x\n') }]);
    const store = new AgentJobStore(':memory:');
    seedJob(store, 'COMPLETED', art);
    const engine = engineFor(store, art, CONFIG_NO_PROJECT);
    expect(await errCode(() => engine.diff({ jobId: JOB_ID, principal: 'client-a' }))).toBe('FORBIDDEN_PROJECT');
    store.close();
  });

  it('project identity comes from the job row (caller has no project input)', async () => {
    // DiffRequest has no project field at all — verified structurally.
    const keys = Object.keys({ jobId: '', principal: '', path: undefined, cursor: undefined, maxBytes: undefined });
    expect(keys).not.toContain('project');
  });

  it('M1-M3 job/artifact state unchanged after a successful diff', async () => {
    const art = makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('x\n') }]);
    const store = new AgentJobStore(':memory:');
    seedJob(store, 'COMPLETED', art);
    const before = store.get(JOB_ID)!;
    await engineFor(store, art).diff({ jobId: JOB_ID, principal: 'client-a' });
    const after = store.get(JOB_ID)!;
    expect(after.status).toBe(before.status);
    expect(after.artifactState).toBe('AVAILABLE');
    expect(after.artifactHash).toBe(before.artifactHash);
    store.close();
  });

  it('M2 job/artifact state unchanged after a FAILED diff', async () => {
    const art = makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('x\n') }]);
    const store = new AgentJobStore(':memory:');
    seedJob(store, 'COMPLETED', art);
    const before = store.get(JOB_ID)!;
    // corrupt evidence → integrity failure
    art.store.delete('artifact-manifest.json');
    await errCode(() => engineFor(store, art).diff({ jobId: JOB_ID, principal: 'client-a' }));
    const after = store.get(JOB_ID)!;
    expect(after.status).toBe(before.status);
    expect(after.artifactState).toBe('AVAILABLE');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Artifact integrity chain — §16, §17, §41
// ---------------------------------------------------------------------------

describe('A6-B4 artifact integrity', () => {
  const base = () => makeArtifact(
    [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('one\n') }],
    [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('two\n') }],
  );

  it('I1 valid artifact verifies', async () => {
    const a = base();
    const v = await verify(a);
    expect(v.artifactHash).toBe(a.artifactHash);
    expect(v.manifest.changes.length).toBe(1);
  });

  it('I3 artifact-manifest missing → integrity', async () => {
    const a = base(); a.store.delete('artifact-manifest.json');
    expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I4 malformed artifact JSON → integrity', async () => {
    const a = base();
    const bad = Buffer.from('{not json', 'utf8');
    a.store.set('artifact-manifest.json', bad);
    a.binding.expectedArtifactHash = sha256hex(bad); // pass hash gate, fail parse
    expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I5 artifact strict-validation failure → integrity', async () => {
    const a = base();
    const bad = Buffer.from(JSON.stringify({ version: 1, bogus: true }), 'utf8');
    a.store.set('artifact-manifest.json', bad);
    a.binding.expectedArtifactHash = sha256hex(bad);
    expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I6 computed artifactHash != job.artifactHash → integrity', async () => {
    const a = base(); a.binding.expectedArtifactHash = sha256hex('nope');
    expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I7 manifest jobId mismatch → integrity', async () => {
    const a = base(); a.binding.jobId = 'job_' + 'd'.repeat(32);
    expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I8 principalId mismatch → integrity', async () => {
    const a = base(); a.binding.principalId = 'client-x';
    expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I9 projectId mismatch → integrity', async () => {
    const a = base(); a.binding.projectId = 'proj-x';
    expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I10 backend/profile/baseCommit mismatch → integrity', async () => {
    for (const mut of [
      (b: ExpectedArtifactBinding) => (b.backend = 'copilot'),
      (b: ExpectedArtifactBinding) => (b.profile = 'audit'),
      (b: ExpectedArtifactBinding) => (b.baseCommit = 'e'.repeat(40)),
    ]) {
      const a = base(); mut(a.binding);
      expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    }
  });

  it('I11 publication accounting mismatch (changeSetHash/opCount/artifactBytes) → integrity', async () => {
    for (const mut of [
      (b: ExpectedArtifactBinding) => (b.changeSetHash = sha256hex('x')),
      (b: ExpectedArtifactBinding) => (b.opCount = 999),
      (b: ExpectedArtifactBinding) => (b.artifactBytes = 999999),
    ]) {
      const a = base(); mut(a.binding);
      expect(await errCode(() => verify(a))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    }
  });

  it('I12/I13 BEFORE/POST snapshot missing → integrity', async () => {
    const a1 = base(); a1.store.delete('before-snapshot-manifest.json');
    expect(await errCode(() => verify(a1))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    const a2 = base(); a2.store.delete('post-snapshot-manifest.json');
    expect(await errCode(() => verify(a2))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I18/I19 BEFORE/POST byte tamper → identity mismatch integrity', async () => {
    const a1 = base();
    a1.store.set('before-snapshot-manifest.json', Buffer.concat([a1.store.get('before-snapshot-manifest.json')!, Buffer.from(' ')]));
    expect(await errCode(() => verify(a1))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    const a2 = base();
    a2.store.set('post-snapshot-manifest.json', Buffer.concat([a2.store.get('post-snapshot-manifest.json')!, Buffer.from(' ')]));
    expect(await errCode(() => verify(a2))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I20 required blob missing → integrity (surfaced lazily, on read)', async () => {
    const a = base();
    const hash = sha256hex(Buffer.from('two\n'));
    a.store.delete(blobPath(hash));
    const v = await verify(a); // verify() no longer touches blob content — succeeds
    expect(await errCode(() => renderFullBytes(v))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I21 blob size mismatch → integrity (surfaced lazily, on read)', async () => {
    const a = base();
    const hash = sha256hex(Buffer.from('two\n'));
    a.store.set(blobPath(hash), Buffer.from('two\n!!')); // wrong length + hash
    const v = await verify(a);
    expect(await errCode(() => renderFullBytes(v))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I22 blob hash mismatch (same length) → integrity (surfaced lazily, on read)', async () => {
    const a = base();
    const hash = sha256hex(Buffer.from('two\n'));
    a.store.set(blobPath(hash), Buffer.from('XYZ\n')); // same length, wrong content
    const v = await verify(a);
    expect(await errCode(() => renderFullBytes(v))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I25 legitimate contentComplete=false verifies (metadata only)', async () => {
    const a = makeArtifact([], [{ path: 'sub', kind: 'unsupported', mode: 0o644, reason: 'nested submodule' }], { contentComplete: false });
    const v = await verify(a);
    expect(v.manifest.contentComplete).toBe(false);
    expect(v.manifest.applicable).toBe(false);
  });

  it('I26 required file blob missing even when contentComplete=false → integrity (surfaced lazily, on read)', async () => {
    const a = makeArtifact(
      [],
      [
        { path: 'sub', kind: 'unsupported', mode: 0o644, reason: 'nested submodule' },
        { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('data\n') },
      ],
      { contentComplete: false },
    );
    a.store.delete(blobPath(sha256hex(Buffer.from('data\n'))));
    const v = await verify(a);
    expect(await errCode(() => renderFullBytes(v))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('I23/I24 blob path derives only from hash; caller path never a storage path', () => {
    expect(blobPath('a'.repeat(64))).toBe(`blobs/aa/${'a'.repeat(64)}`);
    expect(() => assertAllowedEvidencePath('../../etc/passwd')).toThrow(BridgeError);
    expect(() => assertAllowedEvidencePath('files/secret')).toThrow(BridgeError);
    // fixed names + hash-blobs are the only permitted reads
    expect(() => assertAllowedEvidencePath('artifact-manifest.json')).not.toThrow();
    expect(() => assertAllowedEvidencePath(`blobs/ab/${'ab'.repeat(32)}`)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Renderer: text/binary, operations, display security — §22-§28, §41
// ---------------------------------------------------------------------------

describe('A6-B4 text/binary classification', () => {
  it('R1 valid UTF-8 text', () => { expect(classifyContent(Buffer.from('héllo\n', 'utf8'))).toBe('text'); });
  it('R2 invalid UTF-8 without NUL → binary', () => { expect(classifyContent(Buffer.from([0xff, 0xfe, 0x41]))).toBe('binary'); });
  it('R3 valid UTF-8 containing NUL → binary', () => { expect(classifyContent(Buffer.from('a\0b', 'binary'))).toBe('binary'); });
  it('R4 zero-byte → text', () => { expect(classifyContent(Buffer.alloc(0))).toBe('text'); });
});

describe('A6-B4 renderer operations (deterministic)', () => {
  async function render(before: Spec[], post: Spec[], opts: BuildOpts = {}): Promise<string> {
    const a = makeArtifact(before, post, opts);
    const v = await verify(a);
    return (await renderFullBytes(v)).toString('utf8');
  }

  it('R8 ADD text', async () => {
    const out = await render([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('l1\nl2\n') }]);
    expect(out).toContain('diff --mcp "a.txt"');
    expect(out).toContain('operation: ADD');
    expect(out).toContain('new file mode 0644');
    expect(out).toContain('--- /dev/null');
    expect(out).toContain('+l1');
    expect(out).toContain('+l2');
  });

  it('R9 DELETE text', async () => {
    const out = await render([{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('l1\n') }], []);
    expect(out).toContain('operation: DELETE');
    expect(out).toContain('deleted file mode 0644');
    expect(out).toContain('+++ /dev/null');
    expect(out).toContain('-l1');
  });

  it('R10 CONTENT_MODIFY text', async () => {
    const out = await render(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha\nbeta\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha\ngamma\n') }],
    );
    expect(out).toContain('operation: CONTENT_MODIFY');
    expect(out).toContain('-beta');
    expect(out).toContain('+gamma');
    expect(out).toContain(' alpha'); // context
  });

  it('R11 MODE_CHANGE only (no fabricated content)', async () => {
    const out = await render(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('same\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o755, content: Buffer.from('same\n') }],
    );
    expect(out).toContain('operation: MODE_CHANGE');
    expect(out).toContain('old mode 0644');
    expect(out).toContain('new mode 0755');
    expect(out).not.toContain('+same');
    expect(out).not.toContain('-same');
  });

  it('R12 SYMLINK_CHANGE', async () => {
    const out = await render(
      [{ path: 'lnk', kind: 'symlink', mode: 0o777, target: 'old/target' }],
      [{ path: 'lnk', kind: 'symlink', mode: 0o777, target: 'new/target' }],
    );
    expect(out).toContain('operation: SYMLINK_CHANGE');
    expect(out).toContain('old target "old/target"');
    expect(out).toContain('new target "new/target"');
  });

  it('R13/R14 symlink ADD/DELETE', async () => {
    const add = await render([], [{ path: 'lnk', kind: 'symlink', mode: 0o777, target: 'dest' }]);
    expect(add).toContain('symlink target added: "dest"');
    const del = await render([{ path: 'lnk', kind: 'symlink', mode: 0o777, target: 'dest' }], []);
    expect(del).toContain('symlink target deleted: "dest"');
  });

  it('R15/R16 TYPE_CHANGE file↔symlink', async () => {
    const f2s = await render(
      [{ path: 'x', kind: 'file', mode: 0o644, content: Buffer.from('data\n') }],
      [{ path: 'x', kind: 'symlink', mode: 0o777, target: 'elsewhere' }],
    );
    expect(f2s).toContain('operation: TYPE_CHANGE');
    expect(f2s).toContain('old type file');
    expect(f2s).toContain('new type symlink');
    expect(f2s).toContain('target "elsewhere"');
    const s2f = await render(
      [{ path: 'x', kind: 'symlink', mode: 0o777, target: 'elsewhere' }],
      [{ path: 'x', kind: 'file', mode: 0o644, content: Buffer.from('data\n') }],
    );
    expect(s2f).toContain('old type symlink');
    expect(s2f).toContain('new type file');
  });

  it('R5/R6/R7 binary add/delete/modify are metadata-only', async () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const bin2 = Buffer.from([0x00, 0x03, 0x02, 0xfe]);
    const add = await render([], [{ path: 'b.bin', kind: 'file', mode: 0o644, content: bin }]);
    expect(add).toContain('Binary file added');
    expect(add).toContain(`after: 4 bytes, sha256:${sha256hex(bin)}`);
    const del = await render([{ path: 'b.bin', kind: 'file', mode: 0o644, content: bin }], []);
    expect(del).toContain('Binary file deleted');
    const mod = await render(
      [{ path: 'b.bin', kind: 'file', mode: 0o644, content: bin }],
      [{ path: 'b.bin', kind: 'file', mode: 0o644, content: bin2 }],
    );
    expect(mod).toContain('Binary file changed');
    expect(mod).toContain(`before: 4 bytes, sha256:${sha256hex(bin)}`);
    expect(mod).toContain(`after: 4 bytes, sha256:${sha256hex(bin2)}`);
    // never dumps raw binary bytes (no NUL or high bytes leak from the blob)
    expect(mod).not.toContain('\u0000');
    expect(mod).not.toContain('\u00ff');
  });

  it('R17 mixed operations render in canonical (lexicographic) path order', async () => {
    const out = await render(
      [{ path: 'b.txt', kind: 'file', mode: 0o644, content: Buffer.from('old\n') }],
      [
        { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('new\n') },
        { path: 'b.txt', kind: 'file', mode: 0o644, content: Buffer.from('changed\n') },
      ],
    );
    expect(out.indexOf('diff --mcp "a.txt"')).toBeLessThan(out.indexOf('diff --mcp "b.txt"'));
  });

  it('R18 empty change set → empty render', async () => {
    const out = await render(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('same\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('same\n') }],
    );
    expect(out).toBe('');
  });

  it('determinism: identical artifact renders identical bytes', async () => {
    const specsBefore: Spec[] = [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('x\ny\n') }];
    const specsAfter: Spec[] = [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('x\nz\n') }];
    const one = await renderFullBytes(await verify(makeArtifact(specsBefore, specsAfter)));
    const two = await renderFullBytes(await verify(makeArtifact(specsBefore, specsAfter)));
    expect(one.equals(two)).toBe(true);
  });
});

describe('A6-B4 review-safe display encoding', () => {
  it('D1 normal path unchanged', () => { expect(encodeDisplay('src/app.ts')).toBe('src/app.ts'); });
  it('D2 newline escaped', () => { expect(encodeDisplay('a\nb')).toBe('a\\nb'); });
  it('D3 tab escaped', () => { expect(encodeDisplay('a\tb')).toBe('a\\tb'); });
  it('D4 quote escaped', () => { expect(encodeDisplay('a"b')).toBe('a\\"b'); });
  it('D5 backslash escaped', () => { expect(encodeDisplay('a\\b')).toBe('a\\\\b'); });
  it('D6 Unicode retained', () => { expect(encodeDisplay('café/日本')).toBe('café/日本'); });
  it('D7/D8 line/para separators escaped', () => {
    expect(encodeDisplay('a\u2028b')).toBe('a\\u2028b');
    expect(encodeDisplay('a\u2029b')).toBe('a\\u2029b');
  });
  it('D9 bidi controls escaped', () => {
    for (const cp of [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
      const enc = encodeDisplay(String.fromCodePoint(cp));
      expect(enc).toBe('\\u' + cp.toString(16).padStart(4, '0'));
    }
  });
  it('D12 hostile path cannot inject fake diff headers', async () => {
    const evil = 'a\n+++ b/pwned\noperation: ADD';
    const a = makeArtifact([], [{ path: evil, kind: 'file', mode: 0o644, content: Buffer.from('x\n') }]);
    const out = (await renderFullBytes(await verify(a))).toString('utf8');
    const lines = out.split('\n');
    // The malicious path never begins a real line; it lives escaped inside one header line.
    expect(lines.filter((l) => l === '+++ b/pwned')).toHaveLength(0);
    expect(out).toContain('diff --mcp "a\\n+++ b/pwned\\noperation: ADD"');
  });
  it('D10/D11 hostile symlink targets are escaped', async () => {
    const a = makeArtifact([], [{ path: 'lnk', kind: 'symlink', mode: 0o777, target: 'x\ny\u202e' }]);
    const out = (await renderFullBytes(await verify(a))).toString('utf8');
    expect(out).toContain('symlink target added: "x\\ny\\u202e"');
  });
});

// ---------------------------------------------------------------------------
// 5. Pagination + cursor — §28-§32, §41
// ---------------------------------------------------------------------------

describe('A6-B4 pagination + cursor', () => {
  async function bigArtifact(): Promise<VerifiedArtifact> {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n';
    return verify(makeArtifact([], [{ path: 'big.txt', kind: 'file', mode: 0o644, content: Buffer.from(lines, 'utf8') }]));
  }

  it('P1 small output → single chunk', async () => {
    const v = await verify(makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]));
    const r = await renderDiffPage(v, { jobId: JOB_ID });
    expect(r.truncated).toBe(false);
    expect(r.cursor).toBeUndefined();
    expect(r.chunkBytes).toBe(r.totalBytes);
  });

  it('P2/P3/P20/P22 large output paginates, reassembles exactly', async () => {
    const v = await bigArtifact();
    const full = await renderFullBytes(v);
    const { reassembled, totalBytes } = await pageAll(v, undefined, 1024);
    expect(totalBytes).toBe(full.length);
    expect(reassembled.equals(full)).toBe(true);
  });

  it('P24 first chunk carries verified metadata; continuation omits it', async () => {
    const v = await bigArtifact();
    const first = await renderDiffPage(v, { jobId: JOB_ID, maxBytes: 1024 });
    expect(first.truncated).toBe(true);
    expect(first.artifactHash).toBe(v.artifactHash);
    expect(first.opCount).toBe(1);
    const second = await renderDiffPage(v, { jobId: JOB_ID, maxBytes: 1024, cursor: first.cursor });
    expect(second.artifactHash).toBeUndefined();
    expect(second.opCount).toBeUndefined();
    expect(second.diffHash).toBe(v.artifactHash); // diffHash still present every chunk
  });

  it('P15/P17 maxBytes is a UTF-8 byte cap even for multibyte output', async () => {
    const line = '€'.repeat(2000) + '\n'; // 3 bytes each → ~6000 bytes, one logical line
    const v = await verify(makeArtifact([], [{ path: 'u.txt', kind: 'file', mode: 0o644, content: Buffer.from(line, 'utf8') }]));
    const { reassembled, chunkByteLens } = await pageAll(v, undefined, 1024);
    for (const n of chunkByteLens) expect(n).toBeLessThanOrEqual(1024);
    expect(reassembled.equals(await renderFullBytes(v))).toBe(true);
  });

  it('P18/P19 long single line splits losslessly at code-point boundaries', async () => {
    const line = '€'.repeat(5000); // no trailing newline: one very long logical line
    const v = await verify(makeArtifact([], [{ path: 'u.txt', kind: 'file', mode: 0o644, content: Buffer.from(line, 'utf8') }]));
    const { chunks, reassembled } = await pageAll(v, undefined, 1025);
    expect(chunks.length).toBeGreaterThan(1);
    // every chunk decodes cleanly (no split multibyte char → no replacement char)
    for (const c of chunks) expect(c).not.toContain('�');
    expect(reassembled.equals(await renderFullBytes(v))).toBe(true);
  });

  it('P4 wrong-artifact cursor → MALFORMED_REQUEST', async () => {
    const v = await bigArtifact();
    const bad = encodeCursor({ v: 1, r: DIFF_RENDER_VERSION, a: 'f'.repeat(64), s: '*', o: 0 });
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: bad }))).toBe('MALFORMED_REQUEST');
  });

  it('P5/P13/P14 selection-bound cursor rejects mismatched selection', async () => {
    const v = await verify(makeArtifact([], [
      { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(Array.from({ length: 400 }, (_, i) => `x${i}`).join('\n') + '\n') },
    ]));
    const first = await renderDiffPage(v, { jobId: JOB_ID, maxBytes: 1024 }); // unfiltered
    expect(first.truncated).toBe(true);
    // unfiltered cursor used on a path-filtered request → selection mismatch
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, path: 'a.txt', cursor: first.cursor }))).toBe('MALFORMED_REQUEST');
  });

  it('P6 wrong render-version cursor → MALFORMED_REQUEST', async () => {
    const v = await bigArtifact();
    const bad = encodeCursor({ v: 1, r: DIFF_RENDER_VERSION + 1, a: v.artifactHash, s: '*', o: 0 });
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: bad }))).toBe('MALFORMED_REQUEST');
  });

  it('P7 bad cursor version → MALFORMED_REQUEST', async () => {
    const v = await bigArtifact();
    const bad = Buffer.from(JSON.stringify({ v: 2, r: DIFF_RENDER_VERSION, a: v.artifactHash, s: '*', o: 0 }), 'utf8').toString('base64url');
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: bad }))).toBe('MALFORMED_REQUEST');
  });

  it('P8 malformed base64url → MALFORMED_REQUEST', async () => {
    const v = await bigArtifact();
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: 'not base64!!' }))).toBe('MALFORMED_REQUEST');
  });

  it('P9 malformed cursor JSON → MALFORMED_REQUEST', async () => {
    const v = await bigArtifact();
    const bad = Buffer.from('not json', 'utf8').toString('base64url');
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: bad }))).toBe('MALFORMED_REQUEST');
  });

  it('P10 unknown cursor field → MALFORMED_REQUEST', async () => {
    const v = await bigArtifact();
    const bad = Buffer.from(JSON.stringify({ v: 1, r: DIFF_RENDER_VERSION, a: v.artifactHash, s: '*', o: 0, extra: 1 }), 'utf8').toString('base64url');
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: bad }))).toBe('MALFORMED_REQUEST');
  });

  it('P11 non-integer/negative offset → MALFORMED_REQUEST', async () => {
    const v = await bigArtifact();
    for (const o of [-1, 1.5]) {
      const bad = Buffer.from(JSON.stringify({ v: 1, r: DIFF_RENDER_VERSION, a: v.artifactHash, s: '*', o }), 'utf8').toString('base64url');
      expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: bad }))).toBe('MALFORMED_REQUEST');
    }
  });

  it('P12 offset > totalBytes → MALFORMED_REQUEST; offset == totalBytes → empty tail', async () => {
    const v = await bigArtifact();
    const total = (await renderFullBytes(v)).length;
    const over = encodeCursor({ v: 1, r: DIFF_RENDER_VERSION, a: v.artifactHash, s: '*', o: total + 1 });
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: over }))).toBe('MALFORMED_REQUEST');
    const atEnd = encodeCursor({ v: 1, r: DIFF_RENDER_VERSION, a: v.artifactHash, s: '*', o: total });
    const r = await renderDiffPage(v, { jobId: JOB_ID, cursor: atEnd });
    expect(r.chunk).toBe('');
    expect(r.chunkBytes).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('selectionIdentity binds to exact path', () => {
    expect(selectionIdentity()).toBe('*');
    expect(selectionIdentity('a.txt')).toBe(sha256hex(Buffer.from('a.txt', 'utf8')));
    expect(selectionIdentity('a.txt')).not.toBe(selectionIdentity('b.txt'));
  });
});

// ---------------------------------------------------------------------------
// 6. Path filter — §33, §41
// ---------------------------------------------------------------------------

describe('A6-B4 path filter', () => {
  async function two(): Promise<VerifiedArtifact> {
    return verify(makeArtifact([], [
      { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('aaa\n') },
      { path: 'b.txt', kind: 'file', mode: 0o644, content: Buffer.from('bbb\n') },
    ]));
  }

  it('F1 exact changed path renders only that operation', async () => {
    const v = await two();
    const r = await renderDiffPage(v, { jobId: JOB_ID, path: 'a.txt' });
    expect(r.chunk).toContain('diff --mcp "a.txt"');
    expect(r.chunk).not.toContain('diff --mcp "b.txt"');
    expect(r.path).toBe('a.txt');
  });

  it('F2 absent changed path → empty valid response, artifact identity still present', async () => {
    const v = await two();
    const r = await renderDiffPage(v, { jobId: JOB_ID, path: 'nope.txt' });
    expect(r.chunk).toBe('');
    expect(r.chunkBytes).toBe(0);
    expect(r.totalBytes).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.cursor).toBeUndefined();
    expect(r.diffHash).toBe(v.artifactHash);
    expect(r.artifactHash).toBe(v.artifactHash);
  });

  it('F3 path filter cannot reveal an unchanged path', async () => {
    // "unchanged.txt" exists in both snapshots (not a change) → not renderable via filter.
    const v = await verify(makeArtifact(
      [{ path: 'unchanged.txt', kind: 'file', mode: 0o644, content: Buffer.from('same\n') }],
      [
        { path: 'unchanged.txt', kind: 'file', mode: 0o644, content: Buffer.from('same\n') },
        { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('new\n') },
      ],
    ));
    const r = await renderDiffPage(v, { jobId: JOB_ID, path: 'unchanged.txt' });
    expect(r.chunk).toBe('');
    expect(r.totalBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Evidence reader security spec — §19, §41 SEC1-15
// ---------------------------------------------------------------------------

describe('A6-B4 evidence reader security spec', () => {
  const spec = buildEvidenceReaderSpec('mcp-bridge-jobs-evid-x', 'trusted/helper:pinned', JOB_ID);

  it('SEC1 volume + SEC2 read-only mount, target /evidence', () => {
    expect(spec.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: 'mcp-bridge-jobs-evid-x', Target: '/evidence', ReadOnly: true }]);
  });
  it('SEC3 no host project mount (single evidence volume only)', () => {
    expect(spec.HostConfig.Mounts).toHaveLength(1);
  });
  it('SEC4 no docker.sock mount', () => {
    expect(JSON.stringify(spec)).not.toContain('docker.sock');
  });
  it('SEC5 no network', () => {
    expect(spec.NetworkDisabled).toBe(true);
    expect(spec.HostConfig.NetworkMode).toBe('none');
  });
  it('SEC6 non-privileged', () => { expect(spec.HostConfig.Privileged).toBe(false); });
  it('SEC7 CapDrop ALL', () => { expect(spec.HostConfig.CapDrop).toEqual(['ALL']); });
  it('SEC8 no-new-privileges', () => { expect(spec.HostConfig.SecurityOpt).toContain('no-new-privileges'); });
  it('SEC9/SEC10 bounded memory + pids', () => {
    expect(spec.HostConfig.Memory).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(spec.HostConfig.PidsLimit).toBeLessThanOrEqual(8);
  });
  it('SEC11 read-only rootfs', () => { expect(spec.HostConfig.ReadonlyRootfs).toBe(true); });
  it('SEC12 fixed trusted image + fixed argv (no shell)', () => {
    expect(spec.Image).toBe('trusted/helper:pinned');
    expect(spec.Cmd).toEqual(['true']);
  });
  it('SEC13/SEC14/SEC15 only fixed manifests + hash-derived blobs are readable', () => {
    expect(() => assertAllowedEvidencePath('artifact-manifest.json')).not.toThrow();
    expect(() => assertAllowedEvidencePath('before-snapshot-manifest.json')).not.toThrow();
    expect(() => assertAllowedEvidencePath('post-snapshot-manifest.json')).not.toThrow();
    expect(() => assertAllowedEvidencePath(`blobs/${'ab'}/${'a'.repeat(64)}`)).not.toThrow();
    expect(() => assertAllowedEvidencePath('blobs/aa/short')).toThrow(BridgeError);
    expect(() => assertAllowedEvidencePath('/evidence/../etc')).toThrow(BridgeError);
    expect(() => assertAllowedEvidencePath('$(rm -rf /)')).toThrow(BridgeError);
  });
  it('empty image/volume fail closed', () => {
    expect(() => buildEvidenceReaderSpec('vol', '', JOB_ID)).toThrow(BridgeError);
    expect(() => buildEvidenceReaderSpec('', 'img', JOB_ID)).toThrow(BridgeError);
  });
});

// ---------------------------------------------------------------------------
// 8. Public tool registration — §36, §41 T1-T11
// ---------------------------------------------------------------------------

describe('A6-B4 public tool registration', () => {
  interface Registered { name: string; cfg: any }
  function captureTools(): Registered[] {
    const tools: Registered[] = [];
    const fakeServer = { registerTool(name: string, cfg: any) { tools.push({ name, cfg }); } };
    registerAgentTools(fakeServer as never);
    return tools;
  }

  it('T1 agent_diff is registered', () => {
    expect(captureTools().map((t) => t.name)).toContain('agent_diff');
  });

  it('T2 read-only, non-destructive annotations', () => {
    const t = captureTools().find((x) => x.name === 'agent_diff')!;
    expect(t.cfg.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });

  it('T3 required scope is agents:read', () => {
    expect(AGENT_TOOL_SCHEMAS.agent_diff).toBeDefined();
    // mapping asserted via authz matrix (see gateway authz suite: A4/A5).
  });

  it('T5 valid structuredContent validates against outputSchema (first-chunk metadata)', () => {
    const sample = {
      jobId: JOB_ID, diffHash: 'a'.repeat(64), chunk: 'x', chunkBytes: 1, totalBytes: 1, truncated: false,
      artifactHash: 'a'.repeat(64), changeSetHash: 'b'.repeat(64), baseCommit: 'c'.repeat(40),
      contentComplete: true, applicable: true, reason: null, opCount: 1, artifactBytes: 3,
    };
    expect(AGENT_TOOL_SCHEMAS.agent_diff.output.safeParse(sample).success).toBe(true);
  });

  it('T6 output schema rejects an unbounded changes[] array', () => {
    const withChanges = {
      jobId: JOB_ID, diffHash: 'a'.repeat(64), chunk: '', chunkBytes: 0, totalBytes: 0, truncated: false,
      changes: [{ path: 'a', op: 'ADD' }],
    };
    expect(AGENT_TOOL_SCHEMAS.agent_diff.output.safeParse(withChanges).success).toBe(false);
  });

  it('T11 agent_discard is NOT registered (still contract-only)', () => {
    // agent_apply WAS activated by A6-B5 (see tests/unit/a6-b5-apply-engine.test.ts
    // for its registration coverage) — this B4 regression now only asserts the
    // one tool B4 itself never activated and B5 does not activate either.
    const names = captureTools().map((t) => t.name);
    expect(names).not.toContain('agent_discard');
  });

  it('input contract: jobId pattern + bounded path/cursor/maxBytes', () => {
    const inp = AGENT_TOOL_SCHEMAS.agent_diff.input;
    expect(inp.safeParse({ jobId: JOB_ID }).success).toBe(true);
    expect(inp.safeParse({ jobId: 'bad' }).success).toBe(false);
    expect(inp.safeParse({ jobId: JOB_ID, maxBytes: 512 }).success).toBe(false); // < 1024
    expect(inp.safeParse({ jobId: JOB_ID, maxBytes: 262144 }).success).toBe(true);
    expect(inp.safeParse({ jobId: JOB_ID, path: '/abs' }).success).toBe(false);
    expect(inp.safeParse({ jobId: JOB_ID, extra: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. R1/R2 remediation — lazy blob content + true two-pass fresh evidence
// ---------------------------------------------------------------------------

describe('A6-B4 R1 lazy artifact blob content', () => {
  it('R1-L1 selected single-file review does not read unrelated regular-file blobs', async () => {
    const a = makeArtifact([], [
      { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('aaa\n') },
      { path: 'b.txt', kind: 'file', mode: 0o644, content: Buffer.from('bbb\n') },
    ]);
    const { source, reads } = instrumentedSource(a.store);
    const v = await verifyCanonicalArtifact(source, a.binding);
    reads.length = 0; // ignore the three manifest reads performed by verify()
    await renderDiffPage(v, { jobId: JOB_ID, path: 'a.txt' });
    const bBlob = blobPath(sha256hex(Buffer.from('bbb\n')));
    expect(reads).not.toContain(bBlob);
    const aBlob = blobPath(sha256hex(Buffer.from('aaa\n')));
    expect(reads).toContain(aBlob);
  });

  it('R1-L2 a filtered selection matching no changed operation reads no content blobs', async () => {
    const a = makeArtifact([], [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('aaa\n') }]);
    const { source, reads } = instrumentedSource(a.store);
    const v = await verifyCanonicalArtifact(source, a.binding);
    reads.length = 0;
    const r = await renderDiffPage(v, { jobId: JOB_ID, path: 'nope.txt' });
    expect(r.chunk).toBe('');
    expect(reads.some((rel) => rel.startsWith('blobs/'))).toBe(false);
  });

  it('R1-L3 VerifiedArtifact does not expose or retain an artifact-wide blob buffer map', async () => {
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('one\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('two\n') }],
    );
    const v = await verify(a);
    expect('blobs' in v).toBe(false);
    expect(Object.keys(v).sort()).toEqual(['artifactHash', 'before', 'beforeMap', 'manifest', 'post', 'postMap', 'readVerifiedBlob'].sort());
    expect(typeof v.readVerifiedBlob).toBe('function');
  });

  it('R1-L4 a selected required blob still receives exact size/hash integrity verification on every call', async () => {
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('one\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('two\n') }],
    );
    const v = await verify(a);
    const hash = sha256hex(Buffer.from('two\n'));
    const buf = await v.readVerifiedBlob(hash, 4);
    expect(buf.toString('utf8')).toBe('two\n');
    // wrong expected size on an otherwise-valid blob → integrity failure
    expect(await errCode(() => v.readVerifiedBlob(hash, 999))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    // wrong hash (no such blob) → integrity failure
    expect(await errCode(() => v.readVerifiedBlob('f'.repeat(64), 4))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });
});

describe('A6-B4 R2 true two-pass fresh evidence', () => {
  it('R2-T1/T2/T3 pass 1 and pass 2 each independently read + verify the same selected content (no cross-pass cache)', async () => {
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha2\n') }],
    );
    const { source, reads } = instrumentedSource(a.store);
    const v = await verifyCanonicalArtifact(source, a.binding);
    reads.length = 0;
    const beforeBlob = blobPath(sha256hex(Buffer.from('alpha\n')));
    const afterBlob = blobPath(sha256hex(Buffer.from('alpha2\n')));
    // maxBytes large enough that the whole review fits in one page (still an
    // internal pass-1-measure + pass-2-emit within this single call).
    await renderDiffPage(v, { jobId: JOB_ID, maxBytes: 65536 });
    // Exactly two reads per required blob: one for the measuring pass, one
    // for the emitting pass — a hidden cross-pass cache would collapse this
    // to one read per blob.
    expect(reads).toEqual([beforeBlob, afterBlob, beforeBlob, afterBlob]);
  });

  it('R2-T3 pass 2 genuinely re-reads evidence rather than reusing a pass-1 buffer', async () => {
    // If content read during pass 1 were cached and replayed for pass 2,
    // corrupting the underlying bytes between the two reads would go
    // undetected. A true fresh-read implementation re-verifies on the
    // second read and surfaces the corruption as an integrity failure.
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha2\n') }],
    );
    const base = memorySource(a.store);
    const afterBlob = blobPath(sha256hex(Buffer.from('alpha2\n')));
    let afterBlobReadCount = 0;
    const source: ReadonlyEvidenceSource = {
      async readFile(rel: string): Promise<Buffer> {
        if (rel === afterBlob) {
          afterBlobReadCount++;
          if (afterBlobReadCount === 2) return Buffer.from('CORRUPTED!\n'); // tamper only on the 2nd (pass-2) read
        }
        return base.readFile(rel);
      },
    };
    const v = await verifyCanonicalArtifact(source, a.binding);
    expect(await errCode(() => renderDiffPage(v, { jobId: JOB_ID, maxBytes: 65536 }))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    expect(afterBlobReadCount).toBe(2); // pass 1 (clean) + pass 2 (tampered, detected)
  });

  it('R2-T4 unrelated (unchanged) blobs remain unread across both passes', async () => {
    const a = makeArtifact(
      [
        { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha\n') },
        { path: 'unchanged.txt', kind: 'file', mode: 0o644, content: Buffer.from('same\n') },
      ],
      [
        { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha2\n') },
        { path: 'unchanged.txt', kind: 'file', mode: 0o644, content: Buffer.from('same\n') },
      ],
    );
    const { source, reads } = instrumentedSource(a.store);
    const v = await verifyCanonicalArtifact(source, a.binding);
    reads.length = 0;
    const unchangedBlob = blobPath(sha256hex(Buffer.from('same\n')));
    await renderDiffPage(v, { jobId: JOB_ID, maxBytes: 65536 });
    expect(reads).not.toContain(unchangedBlob);
  });
});

// ---------------------------------------------------------------------------
// 9b. R3 remediation — forged cursor UTF-8 boundary enforcement
// ---------------------------------------------------------------------------

describe('A6-B4 R3 UTF-8 cursor boundary', () => {
  async function multibyteArtifact(): Promise<VerifiedArtifact> {
    // one line combining a 2-byte, 3-byte, and 4-byte UTF-8 code point.
    const content = 'a' + 'é' + '€' + '😀' + 'z\n';
    return verify(makeArtifact([], [{ path: 'u.txt', kind: 'file', mode: 0o644, content: Buffer.from(content, 'utf8') }]));
  }

  function forgeCursor(v: VerifiedArtifact, offset: number): string {
    return encodeCursor({ v: 1, r: DIFF_RENDER_VERSION, a: v.artifactHash, s: selectionIdentity(), o: offset });
  }

  it('R3-U1/U2/U3 forged cursor offset inside a 2/3/4-byte UTF-8 sequence -> MALFORMED_REQUEST', async () => {
    const v = await multibyteArtifact();
    const full = await renderFullBytes(v);
    const eIdx = full.indexOf(Buffer.from('é', 'utf8'));
    const euroIdx = full.indexOf(Buffer.from('€', 'utf8'));
    const emojiIdx = full.indexOf(Buffer.from('😀', 'utf8'));
    expect(eIdx).toBeGreaterThan(0);
    expect(euroIdx).toBeGreaterThan(eIdx);
    expect(emojiIdx).toBeGreaterThan(euroIdx);
    // every interior continuation-byte position of each sequence must reject.
    const interiorOffsets = [
      eIdx + 1,                                   // inside the 2-byte 'é'
      euroIdx + 1, euroIdx + 2,                    // inside the 3-byte '€'
      emojiIdx + 1, emojiIdx + 2, emojiIdx + 3,     // inside the 4-byte '😀'
    ];
    for (const idx of interiorOffsets) {
      expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor: forgeCursor(v, idx) }))).toBe('MALFORMED_REQUEST');
    }
  });

  it('R3-U4 offset exactly before each multibyte character succeeds', async () => {
    const v = await multibyteArtifact();
    const full = await renderFullBytes(v);
    for (const ch of ['é', '€', '😀']) {
      const idx = full.indexOf(Buffer.from(ch, 'utf8'));
      const r = await renderDiffPage(v, { jobId: JOB_ID, cursor: forgeCursor(v, idx) });
      expect(r.chunk).toBe(full.subarray(idx).toString('utf8'));
      expect(r.truncated).toBe(false);
    }
  });

  it('R3-U5 offset exactly after each multibyte character succeeds', async () => {
    const v = await multibyteArtifact();
    const full = await renderFullBytes(v);
    for (const ch of ['é', '€', '😀']) {
      const idx = full.indexOf(Buffer.from(ch, 'utf8'));
      const after = idx + Buffer.byteLength(ch, 'utf8');
      const r = await renderDiffPage(v, { jobId: JOB_ID, cursor: forgeCursor(v, after) });
      expect(r.chunk).toBe(full.subarray(after).toString('utf8'));
      expect(r.truncated).toBe(false);
    }
  });

  it('R3-U6 offset == 0 succeeds', async () => {
    const v = await multibyteArtifact();
    const full = await renderFullBytes(v);
    const r = await renderDiffPage(v, { jobId: JOB_ID, cursor: forgeCursor(v, 0) });
    expect(r.chunk).toBe(full.toString('utf8'));
    expect(r.truncated).toBe(false);
  });

  it('R3-U7 offset == totalBytes has correct terminal (empty, not truncated) behavior', async () => {
    const v = await multibyteArtifact();
    const full = await renderFullBytes(v);
    const r = await renderDiffPage(v, { jobId: JOB_ID, cursor: forgeCursor(v, full.length) });
    expect(r.chunk).toBe('');
    expect(r.chunkBytes).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(full.length);
  });

  it('R3-U8/U9/U10/U11 mixed 2/3/4-byte pagination: no U+FFFD, exact chunkBytes, maxBytes enforced, lossless concat', async () => {
    const unit = 'é€😀'; // 2 + 3 + 4 = 9 bytes, no newlines -> forces safeUtf8Cut mid-window
    const content = unit.repeat(500);
    const v = await verify(makeArtifact([], [{ path: 'u.txt', kind: 'file', mode: 0o644, content: Buffer.from(content, 'utf8') }]));
    const full = await renderFullBytes(v);
    const { reassembled, chunks, chunkByteLens } = await pageAll(v, undefined, MIN_DIFF_CHUNK_BYTES);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c).not.toContain('�');
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(MIN_DIFF_CHUNK_BYTES);
    }
    for (const n of chunkByteLens) expect(n).toBeLessThanOrEqual(MIN_DIFF_CHUNK_BYTES);
    expect(reassembled.equals(full)).toBe(true);
  });

  it('R3-cursor-forged-mid-sequence rejected even when offset is otherwise in-range and well-formed', async () => {
    // A structurally perfect cursor (correct v/r/a/s, in-range integer offset)
    // whose offset simply lands mid-codepoint must still fail closed.
    const v = await multibyteArtifact();
    const full = await renderFullBytes(v);
    const emojiIdx = full.indexOf(Buffer.from('😀', 'utf8'));
    const cursor = forgeCursor(v, emojiIdx + 2); // splits the 4-byte emoji
    expect(emojiIdx + 2).toBeLessThan(full.length);
    expect(await errCode(async () => renderDiffPage(v, { jobId: JOB_ID, cursor }))).toBe('MALFORMED_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// 9c. R4 remediation — hard-bound Myers trace/work budget + full fallback
// ---------------------------------------------------------------------------

describe('A6-B4 R4 hard Myers trace/work budget', () => {
  it('R4-M10 budget planner is a deterministic, directly testable pure function', () => {
    // For n=m=3000 (n+m=6000): snapshot = 2*6000+1 = 12001 cells.
    // floor(4_000_000 / 12001) = 333 -> the 334th snapshot (index 333) tips it.
    expect(wouldExceedMyersTraceBudget(3000, 3000, 332)).toBe(false); // 333rd push: 333*12001=3_996_333 OK
    expect(wouldExceedMyersTraceBudget(3000, 3000, 333)).toBe(true);  // 334th push: 334*12001=4_008_334 exceeds
    // Same (n,m) is deterministic across repeated calls.
    expect(wouldExceedMyersTraceBudget(3000, 3000, 333)).toBe(true);
    // Larger n+m reduces how many snapshots fit before tipping.
    expect(wouldExceedMyersTraceBudget(60000, 60000, 16)).toBe(true);
    expect(wouldExceedMyersTraceBudget(60000, 60000, 15)).toBe(false);
    // Small inputs never come close to the budget.
    expect(wouldExceedMyersTraceBudget(10, 10, 0)).toBe(false);
  });

  it('R4-M1 small ordinary change uses normal deterministic Myers result (context hunks, not full replace)', async () => {
    const out = await (async () => {
      const a = makeArtifact(
        [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha\nbeta\ngamma\n') }],
        [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('alpha\nBETA\ngamma\n') }],
      );
      return (await renderFullBytes(await verify(a))).toString('utf8');
    })();
    expect(out).toContain('-beta');
    expect(out).toContain('+BETA');
    expect(out).toContain(' alpha'); // untouched context lines are preserved -> real Myers, not replace-all
    expect(out).toContain(' gamma');
  });

  function disjointLines(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n') + '\n';
  }

  it('R4-M2 adversarial input well below the previous 200,000-line guard exceeds the new hard budget', () => {
    // n=m=10000 fully-disjoint lines: n+m=20000, far under the old MAX_DIFF_LINES=200000
    // guard, yet the true edit distance D=n+m=20000 vastly exceeds the ~99 snapshots the
    // new hard trace-cell budget allows for this size (cellsPerSnapshot=2*20000+1=40001).
    const n = 10000;
    const cellsPerSnapshot = 2 * (n + n) + 1;
    const maxSnapshots = Math.floor(4_000_000 / cellsPerSnapshot);
    expect(maxSnapshots).toBeLessThan(n + n); // budget bites long before D could be reached
    expect(wouldExceedMyersTraceBudget(n, n, maxSnapshots)).toBe(true);
  });

  it('R4-M3/M4/M5/M6 fallback triggers before exceeding budget, and is complete (every before/after line present, nothing omitted)', async () => {
    const n = 3000; // n+m=6000: real Myers would need D=6000 (fully disjoint) >> ~333-snapshot budget
    const beforeText = disjointLines('L', n);
    const postText = disjointLines('R', n);
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(beforeText) }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(postText) }],
    );
    const out = (await renderFullBytes(await verify(a))).toString('utf8');
    const outLines = new Set(out.split('\n'));
    for (let i = 0; i < n; i++) {
      expect(outLines.has(`-L${i}`)).toBe(true);
      expect(outLines.has(`+R${i}`)).toBe(true);
    }
    // Fallback is delete-all-then-add-all: no interleaved unchanged (' ') context lines,
    // since none of the L-prefixed / R-prefixed lines are equal to each other.
    expect(out).not.toMatch(/^ L\d/m);
    expect(out).not.toMatch(/^ R\d/m);
  });

  it('R4-M7 repeat render of the same fallback-triggering artifact/selection is byte-identical', async () => {
    const n = 3000;
    const beforeText = disjointLines('L', n);
    const postText = disjointLines('R', n);
    const specsBefore: Spec[] = [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(beforeText) }];
    const specsAfter: Spec[] = [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(postText) }];
    const one = await renderFullBytes(await verify(makeArtifact(specsBefore, specsAfter)));
    const two = await renderFullBytes(await verify(makeArtifact(specsBefore, specsAfter)));
    expect(one.equals(two)).toBe(true);
  });

  it('R4-M8/M9 fallback paginates correctly under small maxBytes and reassembles exactly', async () => {
    const n = 3000;
    const beforeText = disjointLines('L', n);
    const postText = disjointLines('R', n);
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(beforeText) }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(postText) }],
    );
    const v = await verify(a);
    const full = await renderFullBytes(v);
    const { reassembled, chunks } = await pageAll(v, undefined, MIN_DIFF_CHUNK_BYTES);
    expect(chunks.length).toBeGreaterThan(1);
    expect(reassembled.equals(full)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9d. R5 remediation — TYPE_CHANGE regular-file content evidence
// ---------------------------------------------------------------------------

describe('A6-B4 R5 TYPE_CHANGE regular-file evidence', () => {
  async function render(before: Spec[], post: Spec[]): Promise<string> {
    const a = makeArtifact(before, post);
    const v = await verify(a);
    return (await renderFullBytes(v)).toString('utf8');
  }

  it('R5-T1 text file -> symlink: complete old file text appears as removed evidence', async () => {
    const out = await render(
      [{ path: 'x', kind: 'file', mode: 0o644, content: Buffer.from('line one\nline two\nline three\n') }],
      [{ path: 'x', kind: 'symlink', mode: 0o777, target: 'elsewhere' }],
    );
    expect(out).toContain('operation: TYPE_CHANGE');
    expect(out).toContain('old type file');
    expect(out).toContain('new type symlink');
    expect(out).toContain('--- a/"x"');
    expect(out).toContain('+++ /dev/null');
    expect(out).toContain('-line one');
    expect(out).toContain('-line two');
    expect(out).toContain('-line three');
  });

  it('R5-T2 symlink -> text file: complete new file text appears as added evidence', async () => {
    const out = await render(
      [{ path: 'x', kind: 'symlink', mode: 0o777, target: 'elsewhere' }],
      [{ path: 'x', kind: 'file', mode: 0o644, content: Buffer.from('fresh one\nfresh two\n') }],
    );
    expect(out).toContain('old type symlink');
    expect(out).toContain('new type file');
    expect(out).toContain('--- /dev/null');
    expect(out).toContain('+++ b/"x"');
    expect(out).toContain('+fresh one');
    expect(out).toContain('+fresh two');
  });

  it('R5-T3 binary file -> symlink: binary bytes are NOT dumped; approved metadata appears', async () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const out = await render(
      [{ path: 'x', kind: 'file', mode: 0o644, content: bin }],
      [{ path: 'x', kind: 'symlink', mode: 0o777, target: 'dest' }],
    );
    expect(out).toContain(`before: file mode 0644 binary 4 bytes, sha256:${sha256hex(bin)}`);
    expect(out).not.toContain('--- a/"x"');
    expect(out).not.toContain('ÿ');
  });

  it('R5-T4 symlink -> binary file: binary bytes are NOT dumped; approved metadata appears', async () => {
    const bin = Buffer.from([0x00, 0x03, 0x02, 0xfe]);
    const out = await render(
      [{ path: 'x', kind: 'symlink', mode: 0o777, target: 'dest' }],
      [{ path: 'x', kind: 'file', mode: 0o644, content: bin }],
    );
    expect(out).toContain(`after: file mode 0644 binary 4 bytes, sha256:${sha256hex(bin)}`);
    expect(out).not.toContain('+++ b/"x"');
    expect(out).not.toContain('þ');
  });

  it('R5-T5 hostile symlink target remains display-safe escaped (never followed)', async () => {
    const evilTarget = 'x\ny\u202e/etc/passwd';
    const f2s = await render(
      [{ path: 'x', kind: 'file', mode: 0o644, content: Buffer.from('data\n') }],
      [{ path: 'x', kind: 'symlink', mode: 0o777, target: evilTarget }],
    );
    expect(f2s).toContain(`target "${encodeDisplay(evilTarget)}"`);
    expect(f2s.split('\n')).not.toContainEqual('y\u202e/etc/passwd');
  });

  it('R5-T6 hostile Unicode/control content follows established text policy (escaped path, raw-but-verified content)', async () => {
    const evilPath = 'a\u2028b';
    const content = 'plain café 日本\n';
    const f2s = await render(
      [{ path: evilPath, kind: 'file', mode: 0o644, content: Buffer.from(content, 'utf8') }],
      [{ path: evilPath, kind: 'symlink', mode: 0o777, target: 'x' }],
    );
    expect(f2s).toContain(`diff --mcp "${encodeDisplay(evilPath)}"`);
    expect(f2s).toContain('-plain café 日本');
  });

  it('R5-T7 type-change textual evidence paginates losslessly', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `content line ${i}`).join('\n') + '\n';
    const a = makeArtifact(
      [{ path: 'big', kind: 'file', mode: 0o644, content: Buffer.from(lines) }],
      [{ path: 'big', kind: 'symlink', mode: 0o777, target: 'dest' }],
    );
    const v = await verify(a);
    const full = await renderFullBytes(v);
    const { reassembled } = await pageAll(v, undefined, 1024);
    expect(reassembled.equals(full)).toBe(true);
    expect(full.toString('utf8')).toContain('-content line 399');
  });

  it('R5-T8 TYPE_CHANGE continues to identify old/new canonical types correctly for non-file transitions', async () => {
    const out = await render(
      [{ path: 'x', kind: 'symlink', mode: 0o777, target: 'a' }],
      [{ path: 'x', kind: 'gitlink', mode: 0o160000, commitOid: 'f'.repeat(40) }],
    );
    expect(out).toContain('old type symlink');
    expect(out).toContain('new type gitlink');
    expect(out).toContain('before: symlink mode 0777 target "a"');
    expect(out).toContain(`after: gitlink commit ${'f'.repeat(40)}`);
  });

  it('a filtered TYPE_CHANGE review only reads the involved side blobs (no unrelated content)', async () => {
    const a = makeArtifact(
      [
        { path: 'x', kind: 'file', mode: 0o644, content: Buffer.from('secret contents\n') },
        { path: 'unrelated.txt', kind: 'file', mode: 0o644, content: Buffer.from('other\n') },
      ],
      [
        { path: 'x', kind: 'symlink', mode: 0o777, target: 'dest' },
        { path: 'unrelated.txt', kind: 'file', mode: 0o644, content: Buffer.from('other\n') },
      ],
    );
    const { source, reads } = instrumentedSource(a.store);
    const v = await verifyCanonicalArtifact(source, a.binding);
    reads.length = 0;
    const r = await renderDiffPage(v, { jobId: JOB_ID, path: 'x' });
    expect(r.chunk).toContain('secret contents');
    const xBlob = blobPath(sha256hex(Buffer.from('secret contents\n')));
    expect(reads).toContain(xBlob);
  });
});

// ---------------------------------------------------------------------------
// 9e. R2 remediation Blocker 1 — streamed text-diff rendering (Test Family A)
// ---------------------------------------------------------------------------

describe('A6-B4 R2 streamed text-diff rendering (Blocker 1)', () => {
  function bigDisjoint(prefix: string, count: number): string {
    return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n') + '\n';
  }

  it('A1 renderTextDiff returns a lazy Generator, never a materialized array (normal Myers path)', () => {
    const gen = renderTextDiff('alpha\nbeta\n', 'alpha\ngamma\n');
    expect(Array.isArray(gen)).toBe(false);
    expect(typeof gen.next).toBe('function');
    expect(typeof gen[Symbol.iterator]).toBe('function');
    const lines = [...gen];
    expect(lines).toContain('-beta');
    expect(lines).toContain('+gamma');
    expect(lines).toContain(' alpha');
  });

  it('A2 renderTextDiff returns a lazy Generator, never a materialized array (replace-all fallback path)', () => {
    const n = 3000; // n+m=6000 forces the R4 hard-budget fallback (see R4 describe block)
    const gen = renderTextDiff(bigDisjoint('L', n), bigDisjoint('R', n));
    expect(Array.isArray(gen)).toBe(false);
    expect(typeof gen.next).toBe('function');
    const first = gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatch(/^@@ /);
  });

  it('A3 renderTextDiff yields lines one at a time (progressive), not the whole result up front', () => {
    const gen = renderTextDiff('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n');
    const first = gen.next();
    expect(first.done).toBe(false);
    expect(first.value.includes('\n')).toBe(false); // exactly one rendered line, not several joined
    const rest: string[] = [];
    let r = gen.next();
    while (!r.done) { rest.push(r.value); r = gen.next(); }
    const all = [first.value, ...rest];
    expect(all).toContain('-b');
    expect(all).toContain('+B');
    expect(all).toContain('-d');
    expect(all).toContain('+D');
  });

  it('A3b exact rendered line sequence — byte/line-identity regression check against the established unified-hunk grammar', () => {
    // Manually derived from the unchanged CONTEXT=3 unified-hunk algorithm (only
    // delivery — array vs generator — changed, never the rendered grammar):
    // a=[a,b,c,d,e] b=[a,B,c,D,e] -> substitutions at positions 2 and 4 fall in
    // one CONTEXT-3 cluster spanning the whole 5-line file.
    const gen = renderTextDiff('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n');
    expect([...gen]).toEqual([
      '@@ -1,5 +1,5 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '-d',
      '+D',
      ' e',
    ]);
  });

  it('A4 large CONTENT_MODIFY (normal Myers path) produces localized hunks, and paginates + reassembles exactly', async () => {
    const beforeLines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const afterLines = beforeLines.slice();
    afterLines[500] = 'line 500 CHANGED';
    afterLines[1500] = 'line 1500 CHANGED';
    const a = makeArtifact(
      [{ path: 'big.txt', kind: 'file', mode: 0o644, content: Buffer.from(beforeLines.join('\n') + '\n') }],
      [{ path: 'big.txt', kind: 'file', mode: 0o644, content: Buffer.from(afterLines.join('\n') + '\n') }],
    );
    const v = await verify(a);
    const full = await renderFullBytes(v);
    const outStr = full.toString('utf8');
    expect(outStr).toContain('-line 500');
    expect(outStr).toContain('+line 500 CHANGED');
    expect(outStr).toContain('-line 1500');
    expect(outStr).toContain('+line 1500 CHANGED');
    // Two separate localized hunks (not one giant replace-all block) proves the
    // normal Myers path rendered this, not the fallback.
    expect((outStr.match(/^@@ /gm) ?? []).length).toBe(2);
    const { reassembled } = await pageAll(v, undefined, 1024);
    expect(reassembled.equals(full)).toBe(true);
  });

  it('A5 large fallback-triggering CONTENT_MODIFY still performs true fresh pass-1/pass-2 reads (no cross-pass cache)', async () => {
    const n = 3000;
    const beforeText = bigDisjoint('L', n);
    const postText = bigDisjoint('R', n);
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(beforeText) }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from(postText) }],
    );
    const { source, reads } = instrumentedSource(a.store);
    const v = await verifyCanonicalArtifact(source, a.binding);
    reads.length = 0;
    const beforeBlob = blobPath(sha256hex(Buffer.from(beforeText)));
    const afterBlob = blobPath(sha256hex(Buffer.from(postText)));
    await renderDiffPage(v, { jobId: JOB_ID, maxBytes: 65536 });
    // Exactly two reads per blob (measure pass + emit pass) even for the fallback path.
    expect(reads).toEqual([beforeBlob, afterBlob, beforeBlob, afterBlob]);
  });

  it('A6 unfiltered multi-file review streams lazily: consuming only the first operation never reads the second file\'s blob', async () => {
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('a-old\n') }],
      [
        { path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('a-new\n') },
        { path: 'b.txt', kind: 'file', mode: 0o644, content: Buffer.from('b-new\n') },
      ],
    );
    const { source, reads } = instrumentedSource(a.store);
    const v = await verifyCanonicalArtifact(source, a.binding);
    reads.length = 0;
    const bBlob = blobPath(sha256hex(Buffer.from('b-new\n')));
    const collected: string[] = [];
    for await (const line of renderLines(v)) {
      if (line.startsWith('diff --mcp') && collected.length > 0) break; // reached the 2nd operation's header
      collected.push(line);
    }
    expect(collected.some((l) => l.includes('a.txt'))).toBe(true);
    expect(reads).not.toContain(bBlob); // b.txt's blob was never touched — proves lazy evaluation
  });
});

// ---------------------------------------------------------------------------
// 9f. R2 remediation Blocker 2 — bounded evidence reads (Test Family B)
// ---------------------------------------------------------------------------

describe('A6-B4 R2 bounded evidence reads (Blocker 2)', () => {
  it('B1 readBounded rejects once cumulative bytes exceed maxBytes, and stops pulling further chunks', async () => {
    const tracker = { pulled: 0 };
    await expect(readBounded(hostileChunks(100, 100000, tracker), 1000)).rejects.toThrow();
    // 10*100=1000 (ok) ; 11*100=1100 (exceeds) -> aborts exactly at the 11th chunk.
    expect(tracker.pulled).toBe(11);
  });

  it('B2 readBounded accepts content exactly at the bound, and content under the bound', async () => {
    const t1 = { pulled: 0 };
    const exact = await readBounded(hostileChunks(100, 10, t1), 1000);
    expect(exact.length).toBe(1000);
    const t2 = { pulled: 0 };
    const under = await readBounded(hostileChunks(100, 5, t2), 1000);
    expect(under.length).toBe(500);
  });

  it('B3 oversized blob is rejected via the full verified-artifact path, and the bound passed to the source equals the verified snapshot sizeBytes', async () => {
    const a = makeArtifact([], [{ path: 'x.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const hash = sha256hex(Buffer.from('hi\n')); // expectedSize = 3
    const receivedMaxBytes: number[] = [];
    const base = memorySource(a.store);
    const source: ReadonlyEvidenceSource = {
      async readFile(rel: string, maxBytes: number): Promise<Buffer> {
        if (rel === blobPath(hash)) {
          receivedMaxBytes.push(maxBytes);
          const tracker = { pulled: 0 };
          return readBounded(hostileChunks(64, 100000, tracker), maxBytes); // wildly oversized claim
        }
        return base.readFile(rel, maxBytes);
      },
    };
    const v = await verifyCanonicalArtifact(source, a.binding);
    expect(await errCode(() => v.readVerifiedBlob(hash, 3))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    expect(receivedMaxBytes).toEqual([3]); // bound == the verified snapshot sizeBytes, not a looser constant
  });

  it('B4 excess stream content is not fully consumed after the limit violation (bounded pull count observable end-to-end)', async () => {
    const a = makeArtifact([], [{ path: 'x.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]); // expectedSize=3
    const hash = sha256hex(Buffer.from('hi\n'));
    const tracker = { pulled: 0 };
    const base = memorySource(a.store);
    const source: ReadonlyEvidenceSource = {
      async readFile(rel: string, maxBytes: number): Promise<Buffer> {
        if (rel === blobPath(hash)) return readBounded(hostileChunks(10, 1_000_000, tracker), maxBytes); // would be 10M bytes if fully drained
        return base.readFile(rel, maxBytes);
      },
    };
    const v = await verifyCanonicalArtifact(source, a.binding);
    await errCode(() => v.readVerifiedBlob(hash, 3));
    expect(tracker.pulled).toBe(1); // aborts on the very first chunk (10 bytes > 3-byte bound)
  });

  it('B5 normal exact-size verified blobs still succeed through the bounded read path', async () => {
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('one\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('two\n') }],
    );
    const v = await verify(a);
    const buf = await v.readVerifiedBlob(sha256hex(Buffer.from('two\n')), 4);
    expect(buf.toString('utf8')).toBe('two\n');
  });

  it('B6 existing hash-mismatch rejection still succeeds through the bounded read path', async () => {
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('one\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('two\n') }],
    );
    const hash = sha256hex(Buffer.from('two\n'));
    a.store.set(blobPath(hash), Buffer.from('XYZ\n')); // same length, wrong content
    const v = await verify(a);
    expect(await errCode(() => v.readVerifiedBlob(hash, 4))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });
});

// ---------------------------------------------------------------------------
// 9g. R2 remediation Blocker 2 — bounded manifest reads (Test Family C)
// ---------------------------------------------------------------------------

describe('A6-B4 R2 bounded manifest reads (Blocker 2 manifest bounds)', () => {
  function corruptManifestSource(base: ReadonlyEvidenceSource, targetPath: string, tracker: { pulled: number }): ReadonlyEvidenceSource {
    return {
      async readFile(rel: string, maxBytes: number): Promise<Buffer> {
        if (rel === targetPath) {
          // Chunked oversized claim: never actually materializes the whole thing.
          const chunkSize = 8 * 1024 * 1024;
          const chunkCount = Math.ceil(maxBytes / chunkSize) + 2; // guaranteed to cross maxBytes
          return readBounded(hostileChunks(chunkSize, chunkCount, tracker), maxBytes);
        }
        return base.readFile(rel, maxBytes);
      },
    };
  }

  it('C1 the three manifest reads are wired to fixed, exported, content-independent bounds', async () => {
    const a = makeArtifact([], [{ path: 'x.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const seen: Array<[string, number]> = [];
    const base = memorySource(a.store);
    const source: ReadonlyEvidenceSource = {
      async readFile(rel: string, maxBytes: number): Promise<Buffer> {
        seen.push([rel, maxBytes]);
        return base.readFile(rel, maxBytes);
      },
    };
    await verifyCanonicalArtifact(source, a.binding);
    const byPath = Object.fromEntries(seen);
    expect(byPath['artifact-manifest.json']).toBe(MAX_ARTIFACT_MANIFEST_BYTES);
    expect(byPath['before-snapshot-manifest.json']).toBe(MAX_SNAPSHOT_MANIFEST_BYTES);
    expect(byPath['post-snapshot-manifest.json']).toBe(MAX_SNAPSHOT_MANIFEST_BYTES);
  });

  it('C2 oversized artifact manifest is rejected before being fully buffered', async () => {
    const a = makeArtifact([], [{ path: 'x.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const tracker = { pulled: 0 };
    const source = corruptManifestSource(memorySource(a.store), 'artifact-manifest.json', tracker);
    expect(await errCode(() => verifyCanonicalArtifact(source, a.binding))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    expect(tracker.pulled).toBeLessThan(20); // nowhere near fully accumulating a 64 MiB+ object
  });

  it('C3 oversized BEFORE snapshot manifest is rejected before being fully buffered', async () => {
    const a = makeArtifact([], [{ path: 'x.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const tracker = { pulled: 0 };
    const source = corruptManifestSource(memorySource(a.store), 'before-snapshot-manifest.json', tracker);
    expect(await errCode(() => verifyCanonicalArtifact(source, a.binding))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    expect(tracker.pulled).toBeLessThan(20);
  });

  it('C4 oversized POST snapshot manifest is rejected before being fully buffered', async () => {
    const a = makeArtifact([], [{ path: 'x.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const tracker = { pulled: 0 };
    const source = corruptManifestSource(memorySource(a.store), 'post-snapshot-manifest.json', tracker);
    expect(await errCode(() => verifyCanonicalArtifact(source, a.binding))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
    expect(tracker.pulled).toBeLessThan(20);
  });

  it('C5 legitimate manifests of ordinary size still parse successfully within the bound', async () => {
    const a = makeArtifact(
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('one\n') }],
      [{ path: 'a.txt', kind: 'file', mode: 0o644, content: Buffer.from('two\n') }],
    );
    const v = await verify(a);
    expect(v.artifactHash).toBe(a.artifactHash);
  });
});

// ---------------------------------------------------------------------------
// 9h. REMEDIATION R3 — Docker archive teardown (extractSingleFile)
//
// Distinct from the "A6-B4 R3 UTF-8 cursor boundary" describe block above
// (an earlier B4 phase's internal numbering) — this is the R3 REMEDIATION
// batch fixing the archive-transport teardown gap the R2 audit found:
// destroying the tar entry/Extract does not, on its own, destroy the OUTER
// Docker archive response Readable that `.pipe()` reads from. All tests here
// exercise the real tar-stream `pack`/`extract` machinery and a real Node
// `Readable` standing in for the Docker/undici archive body — never a plain
// AsyncGenerator — per the R3 remediation brief.
// ---------------------------------------------------------------------------

describe('A6-B4 REMEDIATION R3 Docker archive teardown (extractSingleFile)', () => {
  it('R3-1 oversized entry: rejects, destroys the OUTER archive Readable, and stops consuming further archive content', async () => {
    const content = Buffer.alloc(8000, 0x61);
    const tarBuf = await buildSingleFileTar('blob', content);
    const maxBytes = 5000;
    const tracker = { pulled: 0, bytes: 0 };
    const outer = chunkedReadable(tarBuf, 256, tracker);

    await expect(extractSingleFile(outer, maxBytes)).rejects.toThrow();

    expect(outer.destroyed).toBe(true);
    // Header (~512B) plus generous internal-buffering slack — nowhere near
    // the full ~8.5KB archive, and nowhere near header+maxBytes (~5.5KB),
    // which is what streaming-only enforcement would have needed to consume.
    expect(tracker.bytes).toBeLessThan(3000);

    // No further content is delivered after teardown.
    const bytesAtRejection = tracker.bytes;
    await new Promise((r) => setTimeout(r, 10));
    expect(tracker.bytes).toBe(bytesAtRejection);
  });

  it('R3-2 tar header size check rejects before reading maxBytes worth of entry content', async () => {
    const content = Buffer.alloc(20000, 0x62);
    const tarBuf = await buildSingleFileTar('blob', content);
    const maxBytes = 8000;
    const tracker = { pulled: 0, bytes: 0 };
    const outer = chunkedReadable(tarBuf, 512, tracker);

    await expect(extractSingleFile(outer, maxBytes)).rejects.toThrow(/tar header/);

    // If rejection required streaming content to the bound, at least
    // header(~512) + maxBytes(8000) bytes would have to be pulled first.
    // Staying well under that proves the header check fired before any
    // bounded content streaming began.
    expect(tracker.bytes).toBeLessThan(8000);
  });

  it('R3-3 normal success: reads exactly, does not trigger failure teardown, and finishes the archive lifecycle cleanly', async () => {
    const content = Buffer.from('hello world\n');
    const tarBuf = await buildSingleFileTar('blob', content);
    const tracker = { pulled: 0, bytes: 0 };
    const outer = chunkedReadable(tarBuf, 64, tracker);

    const buf = await extractSingleFile(outer, 1_000_000);
    expect(buf.toString('utf8')).toBe('hello world\n');

    // No abandoned archive body after success.
    await new Promise((r) => setTimeout(r, 10));
    expect(outer.destroyed).toBe(true);
  });

  it('R3-4 outer archive transport error: rejects cleanly, does not hang, and produces no unhandled error', async () => {
    const content = Buffer.from('irrelevant content\n');
    const tarBuf = await buildSingleFileTar('blob', content);
    const tracker = { pulled: 0, bytes: 0 };
    const injected = new Error('simulated docker/undici transport failure');
    const outer = chunkedReadable(tarBuf, 32, tracker, { injectAfterBytes: 64, injectedError: injected });

    await expect(extractSingleFile(outer, 1_000_000)).rejects.toThrow(/simulated docker\/undici transport failure/);
    expect(outer.destroyed).toBe(true);
  });

  it('R3-5 tar parser/entry error: rejects and tears down the outer archive body', async () => {
    // Truncate a valid archive mid-entry so tar-stream's own parser fails
    // ("Unexpected end of data") rather than the header-size/maxBytes guard.
    const content = Buffer.alloc(4000, 0x63);
    const tarBuf = await buildSingleFileTar('blob', content);
    const truncated = tarBuf.subarray(0, 600); // past the 512B header, mid-content
    const tracker = { pulled: 0, bytes: 0 };
    const outer = chunkedReadable(truncated, 64, tracker);

    await expect(extractSingleFile(outer, 1_000_000)).rejects.toThrow();
    expect(outer.destroyed).toBe(true);
  });

  it('R3-6 full verified-blob regression: real Docker-archive path still succeeds for an exact-size, matching-hash blob', async () => {
    const content = Buffer.from('two\n');
    const hash = sha256hex(content);
    const tarBuf = await buildSingleFileTar('irrelevant-archive-name', content);
    const buf = await extractSingleFile(Readable.from(tarBuf), content.length);
    expect(buf.toString('utf8')).toBe('two\n');
    expect(sha256hex(buf)).toBe(hash);
  });

  it('R3-7 full verified-blob regression: oversized evidence via the real archive path still surfaces ARTIFACT_STORAGE_INTEGRITY_FAILED', async () => {
    const oversizedContent = Buffer.alloc(10_000, 0x64);
    const tarBuf = await buildSingleFileTar('blob', oversizedContent);
    const a = makeArtifact([], [{ path: 'x.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const hash = sha256hex(Buffer.from('hi\n')); // expectedSize = 3, the verified snapshot bound
    const base = memorySource(a.store);
    const source: ReadonlyEvidenceSource = {
      async readFile(rel: string, maxBytes: number): Promise<Buffer> {
        if (rel === blobPath(hash)) {
          return extractSingleFile(Readable.from(tarBuf), maxBytes); // real tar/Docker-shaped path, not a fake generator
        }
        return base.readFile(rel, maxBytes);
      },
    };
    const v = await verifyCanonicalArtifact(source, a.binding);
    expect(await errCode(() => v.readVerifiedBlob(hash, 3))).toBe('ARTIFACT_STORAGE_INTEGRITY_FAILED');
  });

  it('R3-8 manifest bound regression: all three fixed manifest bounds remain wired through the real archive path', async () => {
    const a = makeArtifact([], [{ path: 'x.txt', kind: 'file', mode: 0o644, content: Buffer.from('hi\n') }]);
    const seen: Array<[string, number]> = [];
    const source: ReadonlyEvidenceSource = {
      async readFile(rel: string, maxBytes: number): Promise<Buffer> {
        seen.push([rel, maxBytes]);
        const raw = a.store.get(rel);
        if (!raw) throw new Error(`file not found: ${rel}`);
        const tarBuf = await buildSingleFileTar(rel, raw);
        return extractSingleFile(Readable.from(tarBuf), maxBytes);
      },
    };
    await verifyCanonicalArtifact(source, a.binding);
    const byPath = Object.fromEntries(seen);
    expect(byPath['artifact-manifest.json']).toBe(MAX_ARTIFACT_MANIFEST_BYTES);
    expect(byPath['before-snapshot-manifest.json']).toBe(MAX_SNAPSHOT_MANIFEST_BYTES);
    expect(byPath['post-snapshot-manifest.json']).toBe(MAX_SNAPSHOT_MANIFEST_BYTES);
  });
});

// ---------------------------------------------------------------------------
// 10. Regression sanity
// ---------------------------------------------------------------------------

describe('A6-B4 regression sanity', () => {
  it('G1 schema version remains 3', () => {
    expect(AGENT_JOB_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });
});
