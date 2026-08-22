/**
 * A6-B2 regression: evidence archives must be extracted into the WRITABLE
 * evidence mount, never through the helper's read-only rootfs.
 *
 * The B2 evidence write helper (beforeCapture.writeEvidenceToVolume) runs
 * with `ReadonlyRootfs: true` and exactly ONE writable location: the evidence
 * volume mounted at `/evidence`. It previously built tar entries prefixed
 * with the mount path and handed them to `putArchive(cid, '/')`, which makes
 * the daemon extract through the read-only rootfs and fail live with:
 *
 *     archive put failed: 403 ... container rootfs is marked read-only
 *
 * The Docker stub in this file MODELS that constraint instead of accepting
 * every write, so the regression is caught offline: it rejects any putArchive
 * whose target — or whose resolved entry paths — fall outside a writable
 * mount, and it stores accepted entries in a shared per-VOLUME filesystem so
 * the resulting evidence layout (and its availability to the downstream
 * readers used by diff/apply/discard) is asserted on real bytes.
 *
 * Guarded invariants:
 *   - the helper keeps ReadonlyRootfs=true and mounts /evidence read-WRITE
 *   - the archive lands in the evidence VOLUME, at /evidence/files/<relPath>
 *     and /evidence/manifest.json — never /evidence/evidence/...
 *   - a later container mounting the same volume reads those exact bytes
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
  });
  createBodies.push({ name, body });
  return Promise.resolve(id);
}

async function fakePutArchive(containerId: string, absDir: string, tarBuffer: Buffer): Promise<void> {
  const c = containers.get(containerId);
  if (!c) throw new BridgeError('DOCKER_UNAVAILABLE', `no such container: ${containerId}`, 502);

  const target = posix.resolve('/', absDir);
  const roots = writableRoots(c);
  // Docker extracts INTO `target`; if that path is served by the read-only
  // rootfs the whole request is rejected before any entry is written.
  if (!roots.some((r) => isUnder(r, target))) throw readOnlyRootfsError();

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
    startContainer: vi.fn().mockResolvedValue(undefined),
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
import { captureBeforeEvidence, evidenceVolumeName } from '../../src/executor/agents/beforeCapture.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const WS_VOLUME = 'fake-workspace-volume';
const HELPER_IMAGE = 'fake-helper-image';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Pre-stage the workspace volume the capture helper streams from. */
function stageWorkspace(files: Record<string, Buffer>): void {
  const v = vol(WS_VOLUME);
  v.clear();
  for (const [rel, content] of Object.entries(files)) v.set(rel, { content, mode: 0o644 });
}

/** The evidence-volume container spec created by writeEvidenceToVolume. */
function evidenceWriteSpec(): Record<string, any> {
  const found = createBodies.filter((c) => c.name.includes('-evwrite-'));
  expect(found).toHaveLength(1);
  return found[0]!.body;
}

/** Read a path back through a SEPARATE container, as downstream readers do. */
async function readBackFromVolume(volumeName: string, absPath: string): Promise<Buffer> {
  const cid = await fakeCreateContainer('downstream-reader', {
    Image: HELPER_IMAGE,
    HostConfig: {
      ReadonlyRootfs: true,
      Mounts: [{ Type: 'volume', Source: volumeName, Target: '/evidence', ReadOnly: true }],
    },
  });
  const { body } = await fakeGetArchive(cid, absPath);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const ex = tarExtract();
    ex.on('entry', (_h, stream, next) => {
      stream.on('data', (ch: Buffer) => chunks.push(ch));
      stream.on('end', next);
      stream.on('error', reject);
      stream.resume();
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
    body.pipe(ex);
  });
  return Buffer.concat(chunks);
}

beforeEach(() => {
  vi.clearAllMocks();
  volumes.clear();
  containers.clear();
  createBodies.length = 0;
  nextId = 0;
});

// ---------------------------------------------------------------------------
// Non-vacuity: the stub reproduces the live failure for the OLD pairing
// ---------------------------------------------------------------------------

describe('read-only rootfs model (stub fidelity)', () => {
  it('rejects the pre-fix pairing: `evidence/`-prefixed entries extracted at "/"', async () => {
    const cid = await fakeCreateContainer('evwrite-legacy', {
      HostConfig: {
        ReadonlyRootfs: true,
        Mounts: [{ Type: 'volume', Source: 'ev', Target: '/evidence', ReadOnly: false }],
        Tmpfs: { '/tmp': 'rw' },
      },
    });

    const p = tarPack();
    const chunks: Buffer[] = [];
    const built = new Promise<Buffer>((res) => { p.on('data', (c: Buffer) => chunks.push(c)); p.on('end', () => res(Buffer.concat(chunks))); });
    p.entry({ name: 'evidence/', type: 'directory', mode: 0o755 }, '');
    p.entry({ name: 'evidence/manifest.json', type: 'file', mode: 0o444, size: 2 }, '{}');
    p.finalize();

    await expect(fakePutArchive(cid, '/', await built)).rejects.toThrow(/read-only/);
  });

  it('accepts the fixed pairing: relative entries extracted at "/evidence"', async () => {
    const cid = await fakeCreateContainer('evwrite-fixed', {
      HostConfig: {
        ReadonlyRootfs: true,
        Mounts: [{ Type: 'volume', Source: 'ev', Target: '/evidence', ReadOnly: false }],
        Tmpfs: { '/tmp': 'rw' },
      },
    });

    const p = tarPack();
    const chunks: Buffer[] = [];
    const built = new Promise<Buffer>((res) => { p.on('data', (c: Buffer) => chunks.push(c)); p.on('end', () => res(Buffer.concat(chunks))); });
    p.entry({ name: 'manifest.json', type: 'file', mode: 0o444, size: 2 }, '{}');
    p.finalize();

    await expect(fakePutArchive(cid, '/evidence', await built)).resolves.toBeUndefined();
    expect(vol('ev').get('manifest.json')!.content.toString()).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// captureBeforeEvidence — the B2 regression
// ---------------------------------------------------------------------------

describe('captureBeforeEvidence — writes through the RW evidence mount', () => {
  const jobId = `job_${'c'.repeat(32)}`;
  const helloBytes = Buffer.from('hello evidence\n');
  const nestedBytes = Buffer.from('nested payload');

  async function capture() {
    stageWorkspace({ 'hello.txt': helloBytes, 'src/deep/nested.ts': nestedBytes });
    return captureBeforeEvidence({
      jobId, volumeName: WS_VOLUME, helperImage: HELPER_IMAGE, maxEvidenceBytes: MAX_EVIDENCE_BYTES,
    });
  }

  it('keeps ReadonlyRootfs=true and mounts the evidence volume read-WRITE', async () => {
    await capture();
    const hc = evidenceWriteSpec().HostConfig;

    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Mounts).toEqual([
      { Type: 'volume', Source: evidenceVolumeName(jobId), Target: '/evidence', ReadOnly: false },
    ]);
  });

  it('targets the writable evidence mount, not the read-only rootfs', async () => {
    await capture();

    const calls = (docker.putArchive as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe('/evidence');
  });

  it('lands the archive in the evidence VOLUME at the canonical layout', async () => {
    const result = await capture();
    const stored = [...vol(result.evidenceVolume).keys()].sort();

    expect(stored).toEqual(['files/hello.txt', 'files/src/deep/nested.ts', 'manifest.json']);
    // The pre-fix prefix/target pairing would have produced evidence/evidence/…
    expect(stored.some((k) => k.startsWith('evidence/'))).toBe(false);
  });

  it('reports storedAt paths that match where the bytes actually are', async () => {
    const result = await capture();
    const v = vol(result.evidenceVolume);

    for (const entry of result.entries) {
      if (entry.kind !== 'file') continue;
      expect(entry.storedAt).toBe(`/evidence/files/${entry.relPath}`);
      expect(v.has(`files/${entry.relPath}`)).toBe(true);
    }
  });

  it('makes byte-exact evidence available to a downstream reader container', async () => {
    const result = await capture();

    const hello = await readBackFromVolume(result.evidenceVolume, '/evidence/files/hello.txt');
    const nested = await readBackFromVolume(result.evidenceVolume, '/evidence/files/src/deep/nested.ts');
    expect(hello.equals(helloBytes)).toBe(true);
    expect(nested.equals(nestedBytes)).toBe(true);

    // Same bytes the manifest commits to — the input diff/apply/discard trust.
    const manifest = JSON.parse((await readBackFromVolume(result.evidenceVolume, '/evidence/manifest.json')).toString('utf8'));
    expect(manifest.jobId).toBe(jobId);
    const byPath = new Map<string, any>(manifest.entries.map((e: any) => [e.relPath, e]));
    expect(byPath.get('hello.txt').sha256).toBe(sha256(helloBytes));
    expect(byPath.get('src/deep/nested.ts').sha256).toBe(sha256(nestedBytes));
  });

  it('retains the evidence volume on success (not removed by the write path)', async () => {
    const result = await capture();
    expect(volumes.has(result.evidenceVolume)).toBe(true);
    expect(docker.removeVolume).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scope note
// ---------------------------------------------------------------------------
//
// KiroBackend.createEvidenceVolumeIO().writeFile carries the SAME
// target/prefix defect against the SAME helper hardening, but on the B3
// writer lane (`implement`), not the B2 capture path this candidate fixes.
// It is deliberately NOT changed or covered here — see
// PRE_EXISTING_EVIDENCE_IO_WRITE_PATH_FINDING in the candidate report.
