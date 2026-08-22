/**
 * A6-B2/B3 — workspace archive-root canonicalization, Docker integration.
 *
 * The unit suite (tests/unit/a6-b2-workspace-path-canonicalization.test.ts)
 * MODELS the daemon's archive naming. This suite proves the model is real:
 *
 *   1. the live daemon genuinely prefixes every entry of
 *      getArchive(cid, '/workspace') with 'workspace/'
 *   2. BEFORE capture over that REAL archive records project-relative paths
 *   3. POST capture over the SAME REAL archive records identical paths
 *   4. the archive root entry never becomes a project path
 *   5. the canonical path apply would resolve is /project/<relPath>
 *
 * Self-contained: every volume/container is created and destroyed here.
 * NOTHING here runs apply, and nothing targets a real user project — step 5
 * asserts the resolved path STRING only. Guarded apply against the disposable
 * acceptance project belongs to the runtime E2E, not to this suite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pack as tarPack, extract as tarExtract } from 'tar-stream';
import {
  createVolume, removeVolume, createContainer, startContainer, waitContainer,
  removeContainer, getArchive, putArchive,
} from '../../src/executor/docker.js';
import { captureBeforeEvidence } from '../../src/executor/agents/beforeCapture.js';
import { parsePostTarStream } from '../../src/executor/agents/postCapture.js';
import { computeCanonicalDiff } from '../../src/executor/agents/canonicalDiff.js';
import { WORKSPACE_PATH, PROJECT_PATH } from '../../src/executor/agents/sandboxSpec.js';
import type { SnapshotEntry, SnapshotManifest } from '../../src/executor/agents/canonicalJson.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const IMAGE = 'mcp-ide-bridge-sandbox:a3'; // same trusted helper image family as A3/B5 — no new image
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast', maxRuntimeMs: 60_000, maxCpuMillicores: 1000,
  maxMemoryBytes: 268_435_456, maxPids: 64, maxOutputBytes: 65_536,
  maxEvidenceBytes: 10_485_760, networkPolicy: 'deny', retentionClass: 'ephemeral',
};

const createdVolumes = new Set<string>();
const createdContainers = new Set<string>();

function newJobId(): string {
  return 'job_' + randomBytes(16).toString('hex');
}
function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function buildTar(entries: Array<{ name: string; type?: 'file' | 'directory'; mode?: number; content?: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = tarPack();
    const chunks: Buffer[] = [];
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('end', () => resolve(Buffer.concat(chunks)));
    p.on('error', reject);
    for (const e of entries) {
      if ((e.type ?? 'file') === 'directory') p.entry({ name: e.name, type: 'directory', mode: e.mode ?? 0o755 }, '');
      else p.entry({ name: e.name, type: 'file', mode: e.mode ?? 0o644, size: (e.content ?? Buffer.alloc(0)).length }, e.content ?? Buffer.alloc(0));
    }
    p.finalize();
  });
}

/** Every entry name in a Docker archive stream, directories included. */
async function readTarNames(stream: Readable): Promise<string[]> {
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const ex = tarExtract();
    ex.on('entry', (header, s, next) => {
      names.push(`${String(header.type ?? 'file')}:${header.name}`);
      s.on('end', next);
      s.on('error', reject);
      s.resume();
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
    stream.pipe(ex);
  });
  return names.sort();
}

/** Buffer a Docker archive stream so it can be replayed into a parser. */
function bufferStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function makeHelper(opts: { volume: string; mountTarget: string; readOnly: boolean }): Promise<string> {
  const name = `a6ws-itest-${randomBytes(6).toString('hex')}`;
  const id = await createContainer(name, {
    Image: IMAGE,
    User: '0:0',
    Cmd: ['true'],
    NetworkDisabled: true,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      Mounts: [{ Type: 'volume', Source: opts.volume, Target: opts.mountTarget, ReadOnly: opts.readOnly }],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
      Memory: 64 * 1024 * 1024,
      PidsLimit: 8,
    },
  });
  createdContainers.add(id);
  await startContainer(id);
  await waitContainer(id, { timeoutMs: 10_000 });
  return id;
}

async function makeVolume(): Promise<string> {
  const name = `a6ws-itest-${randomBytes(8).toString('hex')}`;
  await createVolume(name, {});
  createdVolumes.add(name);
  return name;
}

/** BEFORE-entry → snapshot mapping, as artifactConstructor step 2 performs it. */
function toSnapshot(entries: ReadonlyArray<{ relPath: string; kind: string; mode: number; sizeBytes: number; sha256: string }>): SnapshotManifest {
  const out: SnapshotEntry[] = [];
  for (const e of entries) {
    if (e.kind === 'file') out.push({ path: e.relPath, kind: 'file', mode: e.mode, sizeBytes: e.sizeBytes, contentHash: e.sha256 });
    else if (e.kind === 'dir') out.push({ path: e.relPath, kind: 'dir', mode: e.mode });
    else out.push({ path: e.relPath, kind: 'unsupported', mode: e.mode, reason: 'B2 evidence does not preserve symlink target identity' });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: 1, entries: out };
}

describe('A6-B2 workspace archive-root canonicalization — Docker integration', () => {
  const V1 = Buffer.from('export const x = 1;\n');
  const V2 = Buffer.from('export const x = 2;\n');
  const README = Buffer.from('# fixture\n');
  const ADDED = Buffer.from('added\n');
  const REMOVED = Buffer.from('bye\n');

  beforeAll(() => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '-f', join(REPO_ROOT, 'runner', 'Dockerfile'), join(REPO_ROOT, 'runner')], { stdio: 'pipe' });
  }, 120_000);

  afterEach(async () => {
    for (const id of createdContainers) await removeContainer(id, true).catch(() => {});
    createdContainers.clear();
  });

  afterAll(async () => {
    for (const id of createdContainers) await removeContainer(id, true).catch(() => {});
    for (const v of createdVolumes) await removeVolume(v, true).catch(() => {});
  });

  /** Stage a real workspace volume and return its name. */
  async function stageWorkspace(files: Record<string, Buffer>): Promise<string> {
    const volume = await makeVolume();
    const cid = await makeHelper({ volume, mountTarget: WORKSPACE_PATH, readOnly: false });
    const entries: Array<{ name: string; type?: 'file' | 'directory'; content?: Buffer }> = [
      { name: 'src/', type: 'directory' },
    ];
    for (const [rel, content] of Object.entries(files)) entries.push({ name: rel, content });
    await putArchive(cid, WORKSPACE_PATH, await buildTar(entries));
    await removeContainer(cid, true).catch(() => {});
    createdContainers.delete(cid);
    return volume;
  }

  /** Read the workspace exactly as both capture paths do. */
  async function realWorkspaceArchive(volume: string): Promise<Buffer> {
    const cid = await makeHelper({ volume, mountTarget: WORKSPACE_PATH, readOnly: true });
    return bufferStream((await getArchive(cid, WORKSPACE_PATH)).body);
  }

  // -------------------------------------------------------------------------
  // 1. The daemon behaviour the fix exists for
  // -------------------------------------------------------------------------

  it('real daemon prefixes every getArchive("/workspace") entry with "workspace/"', async () => {
    const volume = await stageWorkspace({ 'README.md': README, 'src/index.ts': V1 });
    const names = await readTarNames(Readable.from(await realWorkspaceArchive(volume)));

    expect(names).toContain('directory:workspace/');
    expect(names).toContain('file:workspace/README.md');
    expect(names).toContain('file:workspace/src/index.ts');
    // Nothing arrives already project-relative.
    expect(names).not.toContain('file:README.md');
    expect(names).not.toContain('file:src/index.ts');
  }, 120_000);

  // -------------------------------------------------------------------------
  // 2-4. Both parsers canonicalize the REAL archive, identically
  // -------------------------------------------------------------------------

  it('BEFORE and POST canonicalize the SAME real archive to the SAME project-relative paths', async () => {
    const volume = await stageWorkspace({ 'README.md': README, 'src/index.ts': V1 });
    const jobId = newJobId();

    const before = await captureBeforeEvidence({
      jobId, volumeName: volume, helperImage: IMAGE, maxEvidenceBytes: policy.maxEvidenceBytes,
    });
    createdVolumes.add(before.evidenceVolume);

    const post = await parsePostTarStream(
      Readable.from(await realWorkspaceArchive(volume)),
      policy.maxEvidenceBytes, new Set<string>(), policy.maxEvidenceBytes,
    );

    const beforeFiles = before.entries.filter((e) => e.kind === 'file').map((e) => e.relPath).sort();
    const postFiles = post.entries.filter((e) => e.snapshot.kind === 'file').map((e) => e.snapshot.path).sort();

    expect(beforeFiles).toEqual(['README.md', 'src/index.ts']);
    expect(postFiles).toEqual(beforeFiles);

    // 4. The archive root entry is not a project path on either side.
    const allBefore = before.entries.map((e) => e.relPath);
    const allPost = post.entries.map((e) => e.snapshot.path);
    for (const paths of [allBefore, allPost]) {
      expect(paths).not.toContain('workspace');
      expect(paths).not.toContain('workspace/');
      for (const p of paths) {
        expect(p.startsWith('workspace/'), p).toBe(false);
        expect(p.startsWith('/'), p).toBe(false);
      }
    }

    // Evidence is stored under the canonical path too.
    const readme = before.entries.find((e) => e.relPath === 'README.md')!;
    expect(readme.storedAt).toBe('/evidence/files/README.md');
    expect(readme.sha256).toBe(sha256hex(README));
  }, 180_000);

  // -------------------------------------------------------------------------
  // 5. Detection over real captures, and the path apply would resolve
  // -------------------------------------------------------------------------

  it('detects unchanged/MODIFY/ADD/DELETE on canonical paths from real archives, and resolves under /project', async () => {
    const beforeVol = await stageWorkspace({
      'README.md': README, 'src/index.ts': V1, 'removed.ts': REMOVED,
    });
    const postVol = await stageWorkspace({
      'README.md': README, 'src/index.ts': V2, 'src/added.ts': ADDED,
    });

    const before = await captureBeforeEvidence({
      jobId: newJobId(), volumeName: beforeVol, helperImage: IMAGE, maxEvidenceBytes: policy.maxEvidenceBytes,
    });
    createdVolumes.add(before.evidenceVolume);

    const post = await parsePostTarStream(
      Readable.from(await realWorkspaceArchive(postVol)),
      policy.maxEvidenceBytes, new Set<string>(), policy.maxEvidenceBytes,
    );

    const postEntries = post.entries.map((e) => e.snapshot)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const diff = computeCanonicalDiff(toSnapshot(before.entries), { version: 1, entries: postEntries });
    const byPath = new Map(diff.entries.map((e) => [e.path, e.op]));

    expect(byPath.get('src/index.ts')).toBe('CONTENT_MODIFY');
    expect(byPath.get('src/added.ts')).toBe('ADD');
    expect(byPath.get('removed.ts')).toBe('DELETE');
    expect(byPath.has('README.md')).toBe(false); // identical content → unchanged

    // The path apply resolves under PROJECT_PATH. Asserted as a STRING: this
    // suite never runs apply and never touches a real project.
    for (const e of diff.entries) {
      expect(e.path.startsWith('workspace/'), e.path).toBe(false);
    }
    expect(`${PROJECT_PATH}/${'src/index.ts'}`).toBe('/project/src/index.ts');
    const resolved = diff.entries.map((e) => `${PROJECT_PATH}/${e.path}`).sort();
    expect(resolved).toEqual([
      '/project/removed.ts', '/project/src/added.ts', '/project/src/index.ts',
    ]);
    for (const r of resolved) expect(r.startsWith('/project/workspace/')).toBe(false);
  }, 180_000);
});
