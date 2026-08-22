/**
 * A6-B3 implement/writeMode artifact writes — Docker integration.
 *
 * Regression coverage for the second lane of the read-only-rootfs archive
 * defect. `KiroBackend.createEvidenceVolumeIO().writeFile()` runs a helper with
 * `ReadonlyRootfs: true` that mounts the evidence volume read-write at
 * `/evidence`, so an archive extracted at `/` is rejected by the real daemon
 * with `container rootfs is marked read-only`. That lane is reached only when
 * `writeMode` is true (the `implement` profile), so read-only jobs never hit it
 * while every implement job died at B3 artifact construction.
 *
 * These tests drive the REAL Docker Engine (no stubs) and the REAL production
 * adapter to prove:
 *
 *   1. the daemon genuinely rejects the pre-fix target/prefix pairing and
 *      accepts the fixed one (the constraint is real, not modelled)
 *   2. the production writeFile lands bytes in the evidence VOLUME at
 *      /evidence/<volume-relative path> — never /evidence/evidence/...
 *   3. the adapter reads its own writes back byte-exact
 *   4. `constructArtifact` — the stage implement previously failed at —
 *      completes end to end over that adapter, producing the exact layout
 *      downstream diff/apply/discard reads
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
import {
  KiroBackend, type KiroBackendJobInput, type KiroBackendOptions,
} from '../../src/executor/agents/kiroBackend.js';
import {
  constructArtifact, type EvidenceVolumeIO, type ArtifactConstructorInput,
} from '../../src/executor/agents/artifactConstructor.js';
import type { GitObjectReader, GitTreeEntry } from '../../src/executor/agents/baseCertifier.js';
import type { PostCaptureResult } from '../../src/executor/agents/postCapture.js';
import type { CredentialManager } from '../../src/executor/agents/credentialManager.js';
import type { RunnerSandbox } from '../../src/executor/agents/sandboxRunner.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const IMAGE = 'mcp-ide-bridge-sandbox:a3'; // same trusted helper image family as A3/B2/B5 — no new image
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast', maxRuntimeMs: 600_000, maxCpuMillicores: 1000,
  maxMemoryBytes: 1_073_741_824, maxPids: 128, maxOutputBytes: 262_144,
  maxEvidenceBytes: 10_485_760, networkPolicy: 'backend-only', retentionClass: 'ephemeral',
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
 * — exactly the shape of the production evidence-io helper.
 */
async function makeHelper(opts: { volume: string; mountTarget: string; readOnly: boolean }): Promise<string> {
  const name = `a6b3-itest-${randomBytes(6).toString('hex')}`;
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
  const name = `a6b3-itest-${randomBytes(8).toString('hex')}`;
  await createVolume(name, {});
  createdVolumes.add(name);
  return name;
}

function makeJob(jobId: string): KiroBackendJobInput {
  return {
    jobId, backend: 'kiro', project: 'test-project', profile: 'implement',
    prompt: 'Apply the change.', hostPath: '/tmp/test-project',
    policy, model: 'claude-haiku-4.5',
  };
}

function makeOpts(): KiroBackendOptions {
  return {
    runnerImage: IMAGE,
    helperImage: IMAGE,
    proxyImage: IMAGE,
    proxyCmd: ['true'],
    credentialManager: {} as unknown as CredentialManager,
    sandbox: {} as unknown as RunnerSandbox,
  };
}

/**
 * The PRODUCTION EvidenceVolumeIO an `implement` job uses at B3, reached
 * through the real (private) factory. No test-local reimplementation.
 */
function productionVolumeIO(jobId: string, evidenceVolume: string): EvidenceVolumeIO {
  const backend = new KiroBackend(makeJob(jobId), makeOpts());
  (backend as any).beforeCapture = { evidenceVolume };
  return (backend as any).createEvidenceVolumeIO() as EvidenceVolumeIO;
}

/** Read the whole evidence volume back as mount-relative path -> bytes. */
async function dumpEvidence(volume: string): Promise<Map<string, Buffer>> {
  const cid = await makeHelper({ volume, mountTarget: '/evidence', readOnly: true });
  const { body } = await getArchive(cid, '/evidence');
  const raw = await readTar(body);
  // getArchive('/evidence') returns entries prefixed with the basename.
  const out = new Map<string, Buffer>();
  for (const [k, v] of raw) out.set(k.replace(/^evidence\//, ''), v);
  await removeContainer(cid, true).catch(() => {});
  createdContainers.delete(cid);
  return out;
}

describe('A6-B3 evidence-io write path — Docker integration', () => {
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
  // 1. The daemon constraint itself, for the B3 entry shape
  // -------------------------------------------------------------------------

  it('real daemon REJECTS extracting `/evidence/`-prefixed B3 entries at "/" on a read-only rootfs', async () => {
    const volume = await makeVolume();
    const cid = await makeHelper({ volume, mountTarget: '/evidence', readOnly: false });

    expect((await inspectContainerFull(cid)).HostConfig.ReadonlyRootfs).toBe(true);

    // The exact pre-fix archive shape produced by writeFile('.b3-temp/blobs/ab/x').
    const tar = await buildTar([
      { name: '/evidence/.b3-temp/', type: 'directory' },
      { name: '/evidence/.b3-temp/blobs/', type: 'directory' },
      { name: '/evidence/.b3-temp/blobs/ab/', type: 'directory' },
      { name: '/evidence/.b3-temp/blobs/ab/x', content: Buffer.from('blob') },
    ]);

    await expect(putArchive(cid, '/', tar)).rejects.toThrow(/read-only/i);
  });

  it('real daemon ACCEPTS the fixed pairing: relative entries at the read-write "/evidence" mount', async () => {
    const volume = await makeVolume();
    const cid = await makeHelper({ volume, mountTarget: '/evidence', readOnly: false });

    const payload = Buffer.from('blob-bytes');
    await putArchive(cid, '/evidence', await buildTar([
      { name: '.b3-temp/', type: 'directory' },
      { name: '.b3-temp/blobs/', type: 'directory' },
      { name: '.b3-temp/blobs/ab/', type: 'directory' },
      { name: '.b3-temp/blobs/ab/x', content: payload },
    ]));

    const back = await readTar((await getArchive(cid, '/evidence/.b3-temp/blobs/ab/x')).body);
    expect(back.get('x')!.equals(payload)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2-3. The production adapter against the real daemon
  // -------------------------------------------------------------------------

  it('production writeFile succeeds and lands bytes at /evidence/<path>, byte-exact', async () => {
    const volume = await makeVolume();
    const io = productionVolumeIO(newJobId(), volume);

    const hash = sha256hex(Buffer.from('post-content'));
    const relPath = `blobs/${hash.slice(0, 2)}/${hash}`;
    const content = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x7f]);

    await io.writeFile(relPath, content);

    const dump = await dumpEvidence(volume);
    expect([...dump.keys()]).toEqual([relPath]);
    expect(dump.get(relPath)!.equals(content)).toBe(true);
  }, 60_000);

  it('introduces NO /evidence/evidence nesting on the real volume', async () => {
    const volume = await makeVolume();
    const io = productionVolumeIO(newJobId(), volume);

    await io.writeFile('.b3-temp/blobs/ab/deadbeef', Buffer.from('t'));
    await io.writeFile('artifact-manifest.json', Buffer.from('{}'));

    const dump = await dumpEvidence(volume);
    for (const key of dump.keys()) {
      expect(key.startsWith('evidence/')).toBe(false);
      expect(key).not.toContain('/evidence/');
    }
    expect([...dump.keys()].sort()).toEqual(['.b3-temp/blobs/ab/deadbeef', 'artifact-manifest.json']);
  }, 60_000);

  it('the adapter reads its own writes back byte-exact', async () => {
    const volume = await makeVolume();
    const io = productionVolumeIO(newJobId(), volume);

    const content = Buffer.from('round-trip\n', 'utf8');
    await io.writeFile('before-snapshot-manifest.json', content);

    expect(await io.fileExists('before-snapshot-manifest.json')).toBe(true);
    expect((await io.readFile('before-snapshot-manifest.json')).equals(content)).toBe(true);
    expect(await io.fileExists('post-snapshot-manifest.json')).toBe(false);
    // The pre-fix layout is genuinely absent, not merely unasserted.
    expect(await io.fileExists('evidence/before-snapshot-manifest.json')).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 4. implement advances past the B3 artifact stage, against real Docker
  // -------------------------------------------------------------------------

  it('constructArtifact completes over the real adapter and produces the downstream layout', async () => {
    const volume = await makeVolume();
    const jobId = newJobId();
    const io = productionVolumeIO(jobId, volume);

    const REL = 'src/main.ts';
    const GIT_OID = 'a'.repeat(40);
    const beforeContent = Buffer.from('export const x = 1;\n', 'utf8');
    const postContent = Buffer.from('export const x = 2;\n', 'utf8');
    const beforeHash = sha256hex(beforeContent);
    const postHash = sha256hex(postContent);

    // B2 has already stored the BEFORE bytes on the volume at files/<relPath>.
    await io.writeFile(`files/${REL}`, beforeContent);

    const git: GitObjectReader = {
      async listTree(): Promise<GitTreeEntry[]> {
        return [{ mode: '100644', type: 'blob', oid: GIT_OID, path: REL }];
      },
      async catBlob(oid: string): Promise<Buffer> {
        if (oid !== GIT_OID) throw new Error(`blob not found: ${oid}`);
        return beforeContent;
      },
    };

    const postCapture = {
      entries: [{
        snapshot: { path: REL, kind: 'file', mode: 0o644, sizeBytes: postContent.length, contentHash: postHash },
        content: postContent,
      }],
      totalFileBytes: postContent.length,
    } as unknown as PostCaptureResult;

    const input: ArtifactConstructorInput = {
      jobId, projectId: 'testproject', principalId: 'testuser', backend: 'kiro',
      profile: 'implement', baseCommit: GIT_OID, evidenceVolume: volume,
      maxEvidenceBytes: 10 * 1024 * 1024,
      beforeCapture: {
        jobId, evidenceVolume: volume, capturedAt: '2024-01-01T00:00:00.000Z',
        entryCount: 1, totalBytes: beforeContent.length,
        entries: [{
          relPath: REL, kind: 'file', mode: 0o644, sizeBytes: beforeContent.length,
          sha256: beforeHash, storedAt: `/evidence/files/${REL}`,
        }],
      } as any,
      postCapture, git, volumeIO: io,
    };

    const result = await constructArtifact(input);
    expect(result.artifactHash).toMatch(/^[0-9a-f]{64}$/);

    const dump = await dumpEvidence(volume);
    const keys = [...dump.keys()].sort();

    expect(keys).toContain('artifact-manifest.json');
    expect(keys).toContain('before-snapshot-manifest.json');
    expect(keys).toContain('post-snapshot-manifest.json');

    // The POST blob is content-addressed and byte-exact on the real volume.
    const blobPath = `blobs/${postHash.slice(0, 2)}/${postHash}`;
    expect(keys).toContain(blobPath);
    expect(dump.get(blobPath)!.equals(postContent)).toBe(true);
    expect(sha256hex(dump.get(blobPath)!)).toBe(postHash);

    // R2-D cleanup really removed the staging area.
    expect(keys.filter((k) => k.startsWith('.b3-temp'))).toEqual([]);

    // No prefix duplication anywhere in the finished artifact.
    for (const k of keys) {
      expect(k.startsWith('evidence/')).toBe(false);
      expect(k).not.toContain('/evidence/');
    }

    // The manifest is readable back through the same adapter downstream uses.
    const manifest = JSON.parse((await io.readFile('artifact-manifest.json')).toString('utf8'));
    expect(manifest.jobId).toBe(jobId);
  }, 180_000);
});
