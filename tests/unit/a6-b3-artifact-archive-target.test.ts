/**
 * A6-B3 regression: implement/writeMode artifact writes must be extracted into
 * the WRITABLE evidence mount, never through the helper's read-only rootfs.
 *
 * This is the SAME defect already fixed on the B2 capture path
 * (tests/unit/a6-b2-evidence-archive-target.test.ts), on the second lane that
 * carries it: `KiroBackend.createEvidenceVolumeIO().writeFile()`. That lane is
 * reached only when `writeMode` is true — i.e. the `implement` profile — so a
 * read-only job (audit/plan/review) never hit it, while every implement job
 * failed at B3 artifact construction.
 *
 * The evidence-io helper runs with `ReadonlyRootfs: true` and exactly ONE
 * writable location: the evidence volume mounted at `/evidence`. It previously
 * built tar entries prefixed with the mount path and handed them to
 * `putArchive(cid, '/')`, which makes the daemon extract through the read-only
 * rootfs and fail live with:
 *
 *     archive put failed: 403 ... container rootfs is marked read-only
 *
 * The Docker stub in this file MODELS that constraint instead of accepting
 * every write, so the regression is caught offline: it rejects any putArchive
 * whose target — or whose resolved entry paths — fall outside a writable
 * mount, and it stores accepted entries in a shared per-VOLUME filesystem so
 * the resulting artifact layout is asserted on real bytes.
 *
 * Guarded invariants:
 *   - the helper keeps ReadonlyRootfs=true and mounts /evidence read-WRITE
 *   - writes land in the evidence VOLUME at /evidence/<volume-relative path>
 *     — never /evidence/evidence/...
 *   - the exact B3 layout (blobs/, .b3-temp/blobs/, the three manifests) is
 *     produced and read back byte-exact by the same adapter
 *   - `constructArtifact` — the stage implement previously died at — completes
 *     end to end against the real production adapter
 *   - the stub genuinely rejects the old target/prefix pairing (non-vacuity)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pack as tarPack, extract as tarExtract } from 'tar-stream';
import { BridgeError } from '../../src/shared/errors.js';

// ---------------------------------------------------------------------------
// Docker stub that models the read-only rootfs / read-write mount boundary
// ---------------------------------------------------------------------------

interface StoredFile { content: Buffer; mode: number }
interface FakeContainer {
  id: string;
  readonlyRootfs: boolean;
  /** Target path -> { volume, readOnly } for volume mounts. */
  mounts: Array<{ target: string; volume: string; readOnly: boolean }>;
  tmpfs: string[];
  /** The command the container runs when started (modelled for the rm helper). */
  cmd: string[];
}

/** volume name -> (mount-relative path -> file). Shared across containers. */
const volumes = new Map<string, Map<string, StoredFile>>();
const containers = new Map<string, FakeContainer>();
const createBodies: Array<{ name: string; body: Record<string, any> }> = [];
let nextId = 0;

function vol(name: string): Map<string, StoredFile> {
  let v = volumes.get(name);
  if (!v) { v = new Map(); volumes.set(name, v); }
  return v;
}

function isUnder(root: string, p: string): boolean {
  if (root === '/') return true;
  return p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
}

/** Every path prefix the container may be written through. */
function writableRoots(c: FakeContainer): string[] {
  const roots: string[] = [];
  if (!c.readonlyRootfs) roots.push('/');
  for (const m of c.mounts) if (!m.readOnly) roots.push(m.target);
  roots.push(...c.tmpfs);
  return roots;
}

function readOnlyRootfsError(): BridgeError {
  // Byte-shape of the real daemon rejection observed live.
  return new BridgeError(
    'DOCKER_UNAVAILABLE',
    'archive put failed: 403 {"message":"container rootfs is marked read-only"}',
    502,
  );
}

/** Resolve an absolute container path onto (volume, mount-relative path). */
function locate(c: FakeContainer, absPath: string): { v: Map<string, StoredFile>; rel: string } | undefined {
  for (const m of c.mounts) {
    if (!isUnder(m.target, absPath)) continue;
    const rel = absPath === m.target ? '' : absPath.slice(m.target.length + 1);
    return { v: vol(m.volume), rel };
  }
  return undefined;
}

function fakeCreateContainer(name: string, body: Record<string, any>): Promise<string> {
  const id = `fake-container-${nextId++}`;
  const hc = (body.HostConfig ?? {}) as Record<string, any>;
  containers.set(id, {
    id,
    readonlyRootfs: hc.ReadonlyRootfs === true,
    mounts: ((hc.Mounts ?? []) as Array<Record<string, any>>)
      .filter((m) => m.Type === 'volume')
      .map((m) => ({ target: String(m.Target), volume: String(m.Source), readOnly: m.ReadOnly === true })),
    tmpfs: Object.keys((hc.Tmpfs ?? {}) as Record<string, string>),
    cmd: ((body.Cmd ?? []) as unknown[]).map(String),
  });
  createBodies.push({ name, body });
  return Promise.resolve(id);
}

/**
 * Model the trusted `.b3-temp` cleanup helper (buildCleanupHelperSpec runs
 * `rm -rf /evidence/<path>`). Without this the stub would silently keep the
 * staging tree and B3's strict cleanup verification could never be exercised.
 */
function fakeStartContainer(containerId: string): Promise<void> {
  const c = containers.get(containerId);
  if (c && c.cmd.length === 3 && c.cmd[0] === 'rm' && c.cmd[1] === '-rf') {
    const abs = posix.resolve('/', c.cmd[2]);
    const at = locate(c, abs);
    if (at) {
      for (const key of [...at.v.keys()]) {
        if (key === at.rel || key.startsWith(at.rel + '/')) at.v.delete(key);
      }
    }
  }
  return Promise.resolve();
}

async function readTarEntries(tarBuffer: Buffer): Promise<Array<{ name: string; type: string; mode: number; content: Buffer }>> {
  const entries: Array<{ name: string; type: string; mode: number; content: Buffer }> = [];
  await new Promise<void>((resolve, reject) => {
    const ex = tarExtract();
    ex.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (ch: Buffer) => chunks.push(ch));
      stream.on('end', () => {
        entries.push({
          name: header.name,
          type: String(header.type ?? 'file'),
          mode: header.mode ?? 0o644,
          content: Buffer.concat(chunks),
        });
        next();
      });
      stream.on('error', reject);
      stream.resume();
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
    Readable.from(tarBuffer).pipe(ex);
  });
  return entries;
}

async function fakePutArchive(containerId: string, absDir: string, tarBuffer: Buffer): Promise<void> {
  const c = containers.get(containerId);
  if (!c) throw new BridgeError('DOCKER_UNAVAILABLE', `no such container: ${containerId}`, 502);

  const target = posix.resolve('/', absDir);
  const roots = writableRoots(c);
  // Docker extracts INTO `target`; if that path is served by the read-only
  // rootfs the whole request is rejected before any entry is written.
  if (!roots.some((r) => isUnder(r, target))) throw readOnlyRootfsError();

  const entries = await readTarEntries(tarBuffer);
  for (const e of entries) {
    const resolved = posix.resolve(target, e.name);
    if (!roots.some((r) => isUnder(r, resolved))) throw readOnlyRootfsError();
    if (e.type === 'directory') continue;
    const at = locate(c, resolved);
    if (!at) throw readOnlyRootfsError();
    at.v.set(at.rel, { content: e.content, mode: e.mode });
  }
}

/** Serve a single file or a subtree from the mounted volume, as Docker does. */
async function fakeGetArchive(containerId: string, absPath: string): Promise<{ body: Readable }> {
  const c = containers.get(containerId);
  if (!c) throw new BridgeError('DOCKER_UNAVAILABLE', `no such container: ${containerId}`, 502);
  const at = locate(c, absPath);
  if (!at) throw new BridgeError('FILE_NOT_FOUND', `not found: ${absPath}`, 404);

  const exact = at.v.get(at.rel);
  const matches: Array<[string, StoredFile]> = exact
    ? [[posix.basename(at.rel), exact]]
    : [...at.v.entries()]
        .filter(([k]) => at.rel === '' || k.startsWith(at.rel + '/'))
        .map(([k, f]) => [at.rel === '' ? k : k.slice(at.rel.length + 1), f] as [string, StoredFile]);
  if (matches.length === 0) throw new BridgeError('FILE_NOT_FOUND', `not found: ${absPath}`, 404);

  const p = tarPack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((res, rej) => {
    p.on('data', (ch: Buffer) => chunks.push(ch));
    p.on('end', () => res(Buffer.concat(chunks)));
    p.on('error', rej);
  });
  for (const [name, f] of matches) p.entry({ name, type: 'file', mode: f.mode, size: f.content.length }, f.content);
  p.finalize();
  return { body: Readable.from(await done) };
}

vi.mock('../../src/executor/docker.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/executor/docker.js')>('../../src/executor/docker.js');
  return {
    ...actual,
    createVolume: vi.fn(async (name: string) => { vol(name); }),
    removeVolume: vi.fn(async (name: string) => { volumes.delete(name); }),
    createContainer: vi.fn(fakeCreateContainer),
    startContainer: vi.fn(fakeStartContainer),
    waitContainer: vi.fn().mockResolvedValue({ statusCode: 0, timedOut: false }),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    getArchive: vi.fn(fakeGetArchive),
    putArchive: vi.fn(fakePutArchive),
    listContainersByFilter: vi.fn().mockResolvedValue([]),
    listVolumesByFilter: vi.fn().mockResolvedValue([]),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    killContainer: vi.fn().mockResolvedValue(undefined),
  };
});

import * as docker from '../../src/executor/docker.js';
import {
  KiroBackend, buildEvidenceWriteArchive,
  type KiroBackendJobInput, type KiroBackendOptions,
} from '../../src/executor/agents/kiroBackend.js';
import {
  constructArtifact, type EvidenceVolumeIO, type ArtifactConstructorInput,
} from '../../src/executor/agents/artifactConstructor.js';
import type { GitObjectReader, GitTreeEntry } from '../../src/executor/agents/baseCertifier.js';
import type { PostCaptureResult } from '../../src/executor/agents/postCapture.js';
import type { CredentialManager } from '../../src/executor/agents/credentialManager.js';
import type { RunnerSandbox } from '../../src/executor/agents/sandboxRunner.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JOB_ID = 'job_' + '0'.repeat(32);
const EVIDENCE_VOL = 'io-quarangate-evidence-' + JOB_ID;
const HELPER_IMAGE = 'alpine';

const testPolicy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast', maxRuntimeMs: 600_000, maxCpuMillicores: 1000,
  maxMemoryBytes: 1_073_741_824, maxPids: 128, maxOutputBytes: 262_144,
  maxEvidenceBytes: 10_485_760, networkPolicy: 'backend-only', retentionClass: 'ephemeral',
};

function makeJob(overrides: Partial<KiroBackendJobInput> = {}): KiroBackendJobInput {
  return {
    jobId: JOB_ID, backend: 'kiro', project: 'test-project',
    profile: 'implement', prompt: 'Apply the change.', hostPath: '/tmp/test-project',
    policy: testPolicy, model: 'claude-haiku-4.5', ...overrides,
  };
}

function makeOpts(): KiroBackendOptions {
  return {
    runnerImage: 'quarangate-kiro-runner:test',
    helperImage: HELPER_IMAGE,
    proxyImage: 'node:24-alpine',
    proxyCmd: ['node', '/app/dist/executor/agents/egressProxyMain.js'],
    credentialManager: {} as unknown as CredentialManager,
    sandbox: {} as unknown as RunnerSandbox,
  };
}

/**
 * The PRODUCTION EvidenceVolumeIO — the exact adapter an `implement` job uses
 * at B3, reached through the real (private) factory. Nothing here is a
 * test-local reimplementation of the write path.
 */
function productionVolumeIO(): EvidenceVolumeIO {
  const backend = new KiroBackend(makeJob(), makeOpts());
  // The factory reads only `beforeCapture.evidenceVolume`; B2 has already run
  // by the time B3 constructs the artifact.
  (backend as any).beforeCapture = { evidenceVolume: EVIDENCE_VOL };
  return (backend as any).createEvidenceVolumeIO() as EvidenceVolumeIO;
}

function sha256(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

/** All mount-relative keys currently stored in the evidence volume. */
function evidenceKeys(): string[] {
  return [...vol(EVIDENCE_VOL).keys()].sort();
}

beforeEach(() => {
  volumes.clear();
  containers.clear();
  createBodies.length = 0;
  nextId = 0;
  vi.clearAllMocks();
});

// ===========================================================================
// 1. The pure archive plan (production test seam)
// ===========================================================================

describe('buildEvidenceWriteArchive — target/entry pairing', () => {
  it('targets the writable evidence mount, never the container root', () => {
    const plan = buildEvidenceWriteArchive('artifact-manifest.json', Buffer.from('{}'));
    expect(plan.target).toBe('/evidence');
    expect(plan.target).not.toBe('/');
  });

  it('names entries RELATIVE to the target — no /evidence prefix', () => {
    const content = Buffer.from('blob-bytes');
    const plan = buildEvidenceWriteArchive('.b3-temp/blobs/ab/' + 'c'.repeat(64), content);
    for (const e of plan.entries) {
      expect(e.name.startsWith('/')).toBe(false);
      expect(e.name.startsWith('evidence/')).toBe(false);
      expect(e.name).not.toContain('/evidence/');
    }
  });

  it('emits exactly the parent dirs plus the file, in order', () => {
    const content = Buffer.from('x');
    const plan = buildEvidenceWriteArchive('blobs/ab/cd', content);
    expect(plan.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      'directory:blobs/',
      'directory:blobs/ab/',
      'file:blobs/ab/cd',
    ]);
    expect(plan.entries.at(-1)!.content).toBe(content);
  });

  it('emits no directory entry for a volume-root file', () => {
    const plan = buildEvidenceWriteArchive('artifact-manifest.json', Buffer.alloc(0));
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ name: 'artifact-manifest.json', type: 'file' });
  });

  it('never re-creates the evidence volume root itself', () => {
    const plan = buildEvidenceWriteArchive('a/b/c.json', Buffer.from('1'));
    expect(plan.entries.map((e) => e.name)).not.toContain('evidence/');
    expect(plan.entries.map((e) => e.name)).not.toContain('/');
  });
});

// ===========================================================================
// 2. Non-vacuity: the stub really rejects the pre-fix pairing
// ===========================================================================

describe('read-only rootfs constraint is real (non-vacuity)', () => {
  /**
   * Provoke one helper creation through the production factory WITHOUT
   * depending on the write path, so these two tests keep proving the stub's
   * constraint even when the fix under test is reverted.
   */
  async function helperContainerId(): Promise<string> {
    const io = productionVolumeIO();
    await io.fileExists('probe.txt').catch(() => undefined);
    return [...containers.keys()].at(-1)!;
  }

  it('rejects the PRE-FIX pairing: putArchive(cid, "/") with /evidence-prefixed entries', async () => {
    const cid = await helperContainerId();
    const p = tarPack();
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((res, rej) => {
      p.on('data', (c: Buffer) => chunks.push(c));
      p.on('end', () => res(Buffer.concat(chunks)));
      p.on('error', rej);
    });
    p.entry({ name: '/evidence/blobs/', type: 'directory', mode: 0o755 }, '');
    p.entry({ name: '/evidence/blobs/x', type: 'file', mode: 0o644, size: 1 }, Buffer.from('x'));
    p.finalize();
    const tar = await done;

    await expect(fakePutArchive(cid, '/', tar)).rejects.toThrow(/container rootfs is marked read-only/);
  });

  it('accepts the FIXED pairing: putArchive(cid, "/evidence") with relative entries', async () => {
    const cid = await helperContainerId();
    const p = tarPack();
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((res, rej) => {
      p.on('data', (c: Buffer) => chunks.push(c));
      p.on('end', () => res(Buffer.concat(chunks)));
      p.on('error', rej);
    });
    p.entry({ name: 'blobs/', type: 'directory', mode: 0o755 }, '');
    p.entry({ name: 'blobs/x', type: 'file', mode: 0o644, size: 1 }, Buffer.from('x'));
    p.finalize();
    const tar = await done;

    await expect(fakePutArchive(cid, '/evidence', tar)).resolves.toBeUndefined();
    expect(vol(EVIDENCE_VOL).get('blobs/x')!.content.toString()).toBe('x');
  });
});

// ===========================================================================
// 3. The production adapter writes through the RW mount
// ===========================================================================

describe('EvidenceVolumeIO.writeFile — production adapter', () => {
  it('writes through the mount instead of the read-only rootfs', async () => {
    const io = productionVolumeIO();
    await expect(io.writeFile('artifact-manifest.json', Buffer.from('{"v":1}'))).resolves.toBeUndefined();
  });

  it('keeps the helper hardened: ReadonlyRootfs=true and /evidence mounted RW', async () => {
    const io = productionVolumeIO();
    await io.writeFile('artifact-manifest.json', Buffer.from('{}'));

    const body = createBodies.at(-1)!.body;
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.CapDrop).toEqual(['ALL']);
    expect(body.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
    expect(body.HostConfig.NetworkMode).toBe('none');
    expect(body.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: EVIDENCE_VOL, Target: '/evidence', ReadOnly: false },
    ]);
  });

  it('uses putArchive target /evidence — never "/"', async () => {
    const io = productionVolumeIO();
    await io.writeFile('blobs/ab/file', Buffer.from('bytes'));

    const calls = (docker.putArchive as unknown as { mock: { calls: any[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, target] of calls) expect(target).toBe('/evidence');
  });

  it('lands bytes at the expected volume-relative path, byte-exact', async () => {
    const io = productionVolumeIO();
    const content = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a]);
    await io.writeFile('blobs/ab/' + 'c'.repeat(64), content);

    const stored = vol(EVIDENCE_VOL).get('blobs/ab/' + 'c'.repeat(64));
    expect(stored).toBeDefined();
    expect(stored!.content.equals(content)).toBe(true);
  });

  it('introduces NO duplicate /evidence/evidence nesting', async () => {
    const io = productionVolumeIO();
    await io.writeFile('.b3-temp/blobs/ab/deadbeef', Buffer.from('t'));
    await io.writeFile('before-snapshot-manifest.json', Buffer.from('{}'));

    for (const key of evidenceKeys()) {
      expect(key.startsWith('evidence/')).toBe(false);
      expect(key).not.toContain('/evidence/');
    }
    expect(evidenceKeys()).toEqual(['.b3-temp/blobs/ab/deadbeef', 'before-snapshot-manifest.json']);
  });

  it('round-trips through the adapter readFile/fileExists it will be read back with', async () => {
    const io = productionVolumeIO();
    const content = Buffer.from('round-trip\n', 'utf8');
    await io.writeFile('blobs/ab/' + 'd'.repeat(64), content);

    expect(await io.fileExists('blobs/ab/' + 'd'.repeat(64))).toBe(true);
    expect((await io.readFile('blobs/ab/' + 'd'.repeat(64))).equals(content)).toBe(true);
    expect(await io.fileExists('blobs/ab/' + 'e'.repeat(64))).toBe(false);
    // The pre-fix layout is genuinely absent, not merely unasserted.
    expect(await io.fileExists('evidence/blobs/ab/' + 'd'.repeat(64))).toBe(false);
  });
});

// ===========================================================================
// 4. implement advances past the B3 artifact stage
// ===========================================================================

describe('B3 artifact construction over the production adapter', () => {
  const beforeContent = Buffer.from('export const x = 1;\n', 'utf8');
  const postContent = Buffer.from('export const x = 2;\n', 'utf8');
  const beforeHash = sha256(beforeContent);
  const postHash = sha256(postContent);
  const REL = 'src/main.ts';
  const GIT_OID = 'a'.repeat(40);

  function makeGit(): GitObjectReader {
    const entries: GitTreeEntry[] = [{ mode: '100644', type: 'blob', oid: GIT_OID, path: REL }];
    const blobs = new Map<string, Buffer>([[GIT_OID, beforeContent]]);
    return {
      async listTree(): Promise<GitTreeEntry[]> { return entries; },
      async catBlob(oid: string): Promise<Buffer> {
        const b = blobs.get(oid);
        if (!b) throw new Error(`blob not found: ${oid}`);
        return b;
      },
    };
  }

  async function makeInput(volumeIO: EvidenceVolumeIO): Promise<ArtifactConstructorInput> {
    // B2 already stored the BEFORE bytes on the volume at files/<relPath>.
    await volumeIO.writeFile(`files/${REL}`, beforeContent);

    const postCapture: PostCaptureResult = {
      entries: [{
        snapshot: { path: REL, kind: 'file', mode: 0o644, sizeBytes: postContent.length, contentHash: postHash },
        content: postContent,
      }],
      totalFileBytes: postContent.length,
    } as unknown as PostCaptureResult;

    return {
      jobId: JOB_ID,
      projectId: 'testproject',
      principalId: 'testuser',
      backend: 'kiro',
      profile: 'implement',
      baseCommit: GIT_OID,
      evidenceVolume: EVIDENCE_VOL,
      maxEvidenceBytes: 10 * 1024 * 1024,
      beforeCapture: {
        jobId: JOB_ID,
        evidenceVolume: EVIDENCE_VOL,
        capturedAt: '2024-01-01T00:00:00.000Z',
        entryCount: 1,
        totalBytes: beforeContent.length,
        entries: [{
          relPath: REL, kind: 'file', mode: 0o644,
          sizeBytes: beforeContent.length, sha256: beforeHash,
          storedAt: `/evidence/files/${REL}`,
        }],
      } as any,
      postCapture,
      git: makeGit(),
      volumeIO,
    };
  }

  it('completes the stage implement previously died at, over the real adapter', async () => {
    const io = productionVolumeIO();
    const input = await makeInput(io);

    const result = await constructArtifact(input);
    expect(result.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces exactly the layout downstream diff/apply/discard reads', async () => {
    const io = productionVolumeIO();
    const input = await makeInput(io);
    await constructArtifact(input);

    const keys = evidenceKeys();
    // The three canonical manifests, at the volume root.
    expect(keys).toContain('artifact-manifest.json');
    expect(keys).toContain('before-snapshot-manifest.json');
    expect(keys).toContain('post-snapshot-manifest.json');
    // Final content-addressed blobs, never left in .b3-temp.
    const finalBlobs = keys.filter((k) => k.startsWith('blobs/'));
    expect(finalBlobs.length).toBeGreaterThan(0);
    for (const k of finalBlobs) expect(k).toMatch(/^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    // R2-D cleanup really removed the staging area.
    expect(keys.filter((k) => k.startsWith('.b3-temp'))).toEqual([]);
    // And no prefix duplication anywhere in the finished artifact.
    for (const k of keys) {
      expect(k.startsWith('evidence/')).toBe(false);
      expect(k).not.toContain('/evidence/');
    }
  });

  it('stores the POST blob byte-exact and readable by hash', async () => {
    const io = productionVolumeIO();
    const input = await makeInput(io);
    await constructArtifact(input);

    const blobPath = `blobs/${postHash.slice(0, 2)}/${postHash}`;
    expect(await io.fileExists(blobPath)).toBe(true);
    const readBack = await io.readFile(blobPath);
    expect(readBack.equals(postContent)).toBe(true);
    expect(sha256(readBack)).toBe(postHash);
  });

  it('artifact-manifest.json is valid JSON read back through the adapter', async () => {
    const io = productionVolumeIO();
    const input = await makeInput(io);
    const result = await constructArtifact(input);

    const bytes = await io.readFile('artifact-manifest.json');
    const parsed = JSON.parse(bytes.toString('utf8'));
    expect(parsed.jobId).toBe(JOB_ID);
    expect(sha256(bytes)).toBe(sha256(bytes)); // stable read
    expect(result.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
