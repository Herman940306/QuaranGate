/**
 * A6-B2 STAGED_BEFORE evidence capture — Docker integration.
 *
 * Regression coverage for the live E2E blocker: the evidence write helper runs
 * with `ReadonlyRootfs: true` and mounts the evidence volume read-write at
 * `/evidence`, so an archive extracted at `/` is rejected by the real daemon
 * with `container rootfs is marked read-only`. These tests drive the REAL
 * Docker Engine (no stubs) to prove:
 *
 *   1. the daemon genuinely rejects the pre-fix target/prefix pairing and
 *      accepts the fixed one (the constraint is real, not modelled)
 *   2. `captureBeforeEvidence` completes against a real staged workspace volume
 *   3. the evidence lands in the evidence VOLUME at /evidence/files/<relPath>
 *      and /evidence/manifest.json — never /evidence/evidence/...
 *   4. a later read-only container — the shape every downstream
 *      diff/apply/discard reader uses — reads those exact bytes back
 *
 * Self-contained: every volume/container is created and destroyed here, and
 * nothing targets a real user project.
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
  removeContainer, getArchive, putArchive, inspectContainerFull,
} from '../../src/executor/docker.js';
import { captureBeforeEvidence } from '../../src/executor/agents/beforeCapture.js';
import { BridgeError } from '../../src/shared/errors.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const IMAGE = 'mcp-ide-bridge-sandbox:a3'; // same trusted helper image family as A3/B5 — no new image
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast', maxRuntimeMs: 60_000, maxCpuMillicores: 1000,
  maxMemoryBytes: 268_435_456, maxPids: 64, maxOutputBytes: 65_536,
  maxEvidenceBytes: 10_485_760, networkPolicy: 'deny', retentionClass: 'ephemeral',
};

/** Resources this suite created, torn down unconditionally. */
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

/** Collect every regular-file entry of a Docker archive stream. */
async function readTar(stream: Readable): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    const ex = tarExtract();
    ex.on('entry', (header, s, next) => {
      const chunks: Buffer[] = [];
      s.on('data', (c: Buffer) => chunks.push(c));
      s.on('end', () => {
        if (String(header.type ?? 'file') === 'file') out.set(header.name, Buffer.concat(chunks));
        next();
      });
      s.on('error', reject);
      s.resume();
    });
    ex.on('finish', resolve);
    ex.on('error', reject);
    stream.pipe(ex);
  });
  return out;
}

/**
 * Create a hardened, exited helper whose ONLY writable path is `mountTarget`
 * — exactly the shape of the production evidence write helper.
 */
async function makeHelper(opts: {
  volume: string; mountTarget: string; readOnly: boolean;
}): Promise<string> {
  const name = `a6b2-itest-${randomBytes(6).toString('hex')}`;
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
  const name = `a6b2-itest-${randomBytes(8).toString('hex')}`;
  await createVolume(name, {});
  createdVolumes.add(name);
  return name;
}

describe('A6-B2 before-capture — Docker integration', () => {
  beforeAll(() => {
    // Idempotent/cached build of the trusted helper image from repo source.
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

  // -------------------------------------------------------------------------
  // 1. The daemon constraint itself
  // -------------------------------------------------------------------------

  it('real daemon REJECTS extracting an `evidence/`-prefixed archive at "/" on a read-only rootfs', async () => {
    const volume = await makeVolume();
    const cid = await makeHelper({ volume, mountTarget: '/evidence', readOnly: false });

    expect((await inspectContainerFull(cid)).HostConfig.ReadonlyRootfs).toBe(true);

    const tar = await buildTar([
      { name: 'evidence/', type: 'directory' },
      { name: 'evidence/manifest.json', content: Buffer.from('{}') },
    ]);

    await expect(putArchive(cid, '/', tar)).rejects.toThrow(/read-only/i);
  });

  it('real daemon ACCEPTS extracting relative entries at the read-write "/evidence" mount', async () => {
    const volume = await makeVolume();
    const cid = await makeHelper({ volume, mountTarget: '/evidence', readOnly: false });

    const payload = Buffer.from('{"ok":true}');
    await putArchive(cid, '/evidence', await buildTar([
      { name: 'files/', type: 'directory' },
      { name: 'files/a.txt', content: Buffer.from('a') },
      { name: 'manifest.json', content: payload },
    ]));

    const back = await readTar((await getArchive(cid, '/evidence/manifest.json')).body);
    expect(back.get('manifest.json')!.equals(payload)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2-4. captureBeforeEvidence end to end against real Docker
  // -------------------------------------------------------------------------

  describe('captureBeforeEvidence against a real staged workspace volume', () => {
    const files: Record<string, Buffer> = {
      'README.md': Buffer.from('# fixture\n'),
      'src/index.ts': Buffer.from('export const x = 1;\n'),
      'src/deep/nested/value.json': Buffer.from('{"n":42}\n'),
    };

    /** Stage a real workspace volume with the fixture files. */
    async function stageWorkspace(): Promise<string> {
      const volume = await makeVolume();
      const cid = await makeHelper({ volume, mountTarget: '/workspace', readOnly: false });
      const entries: Array<{ name: string; type?: 'file' | 'directory'; content?: Buffer }> = [
        { name: 'src/', type: 'directory' },
        { name: 'src/deep/', type: 'directory' },
        { name: 'src/deep/nested/', type: 'directory' },
      ];
      for (const [rel, content] of Object.entries(files)) entries.push({ name: rel, content });
      await putArchive(cid, '/workspace', await buildTar(entries));
      await removeContainer(cid, true).catch(() => {});
      createdContainers.delete(cid);
      return volume;
    }

    it('captures evidence into the evidence volume and serves it byte-exact to a downstream reader', async () => {
      const jobId = newJobId();
      const wsVolume = await stageWorkspace();

      const result = await captureBeforeEvidence({
        jobId, volumeName: wsVolume, helperImage: IMAGE, maxEvidenceBytes: policy.maxEvidenceBytes,
      });
      createdVolumes.add(result.evidenceVolume);

      // Every staged fixture must be present exactly once, keyed by content
      // hash so this assertion stays independent of how the capture derives
      // relPath from the Docker archive stream.
      const captured = result.entries.filter((e) => e.kind === 'file');
      expect(captured).toHaveLength(Object.keys(files).length);
      const wantHashes = new Set(Object.values(files).map(sha256hex));
      expect(new Set(captured.map((e) => e.sha256))).toEqual(wantHashes);

      // Downstream shape: evidence volume mounted READ-ONLY in a fresh helper.
      const reader = await makeHelper({ volume: result.evidenceVolume, mountTarget: '/evidence', readOnly: true });

      const byHash = new Map(Object.values(files).map((c) => [sha256hex(c), c]));
      for (const entry of captured) {
        // storedAt is the contract downstream diff/apply/discard resolve; the
        // bytes must actually be readable there, and be byte-exact.
        expect(entry.storedAt).toBe(`/evidence/files/${entry.relPath}`);
        const back = await readTar((await getArchive(reader, entry.storedAt!)).body);
        const only = [...back.values()][0]!;
        expect(only.equals(byHash.get(entry.sha256)!)).toBe(true);
      }

      // The manifest downstream diff/apply/discard trust, and its hashes.
      const manifestTar = await readTar((await getArchive(reader, '/evidence/manifest.json')).body);
      const manifest = JSON.parse([...manifestTar.values()][0]!.toString('utf8'));
      expect(manifest.jobId).toBe(jobId);
      expect(manifest.entryCount).toBe(captured.length);
      const byPath = new Map<string, any>(manifest.entries.map((e: any) => [e.relPath, e]));
      for (const entry of captured) {
        expect(byPath.get(entry.relPath).sha256).toBe(entry.sha256);
        expect(byPath.get(entry.relPath).sizeBytes).toBe(byHash.get(entry.sha256)!.length);
      }
    }, 120_000);

    it('does NOT create a nested /evidence/evidence tree', async () => {
      const jobId = newJobId();
      const wsVolume = await stageWorkspace();

      const result = await captureBeforeEvidence({
        jobId, volumeName: wsVolume, helperImage: IMAGE, maxEvidenceBytes: policy.maxEvidenceBytes,
      });
      createdVolumes.add(result.evidenceVolume);

      const reader = await makeHelper({ volume: result.evidenceVolume, mountTarget: '/evidence', readOnly: true });

      let code: string | undefined;
      try {
        await getArchive(reader, '/evidence/evidence');
      } catch (e) {
        code = e instanceof BridgeError ? e.code : 'UNEXPECTED';
      }
      expect(code).toBe('FILE_NOT_FOUND');
    }, 120_000);
  });
});
