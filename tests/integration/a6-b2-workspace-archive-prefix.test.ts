/**
 * A6-B2/B3 — workspace archive-root canonicalization, Docker integration.
 *
 * Current-contract modernization: the live daemon proof now uses current
 * QuaranGate labels, canonical job-scoped workspace volumes, immutable helper
 * image IDs, and role-correct helper containers. Workspace fixtures are seeded
 * by a hardened runner startup command into a disposable job-owned volume.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { extract as tarExtract } from 'tar-stream';
import {
  createVolume, removeVolume, createContainer, startContainer, waitContainer,
  removeContainer, getArchive, inspectImage,
} from '../../src/executor/docker.js';
import { captureBeforeEvidence } from '../../src/executor/agents/beforeCapture.js';
import { parsePostTarStream } from '../../src/executor/agents/postCapture.js';
import { computeCanonicalDiff } from '../../src/executor/agents/canonicalDiff.js';
import {
  LABEL_JOB, LABEL_MANAGED, LABEL_RESOURCE,
  PROJECT_PATH, WORKSPACE_PATH,
  runnerContainerName, workspaceVolumeName,
} from '../../src/executor/agents/sandboxSpec.js';
import type { SnapshotEntry, SnapshotManifest } from '../../src/executor/agents/canonicalJson.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const IMAGE_TAG = 'qg-itest-a6-prefix-helper:current';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast', maxRuntimeMs: 60_000, maxCpuMillicores: 1000,
  maxMemoryBytes: 268_435_456, maxPids: 64, maxOutputBytes: 65_536,
  maxEvidenceBytes: 10_485_760, networkPolicy: 'deny', retentionClass: 'ephemeral',
};

const createdVolumes = new Set<string>();
const createdContainers = new Set<string>();
let helperImageId = '';

function newJobId(): string {
  return 'job_' + randomBytes(16).toString('hex');
}
function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
function labels(resource: string, jobId: string): Record<string, string> {
  return { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: resource, [LABEL_JOB]: jobId };
}

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

function bufferStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function makeRoleHelper(opts: {
  jobId: string;
  role: 'runner' | 'before-capture';
  volume: string;
  readOnly: boolean;
  cmd?: string[];
}): Promise<string> {
  const name = opts.role === 'runner'
    ? runnerContainerName(opts.jobId)
    : `io-quarangate-${opts.role}-${opts.jobId}-${randomBytes(6).toString('hex')}`;
  const id = await createContainer(name, {
    Image: helperImageId,
    User: opts.role === 'runner' ? '1000:1000' : '0:0',
    Cmd: opts.cmd ?? ['true'],
    Labels: labels(opts.role, opts.jobId),
    NetworkDisabled: true,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      Binds: [],
      Mounts: [{ Type: 'volume', Source: opts.volume, Target: WORKSPACE_PATH, ReadOnly: opts.readOnly }],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
      Memory: 64 * 1024 * 1024,
      PidsLimit: 8,
      NanoCpus: 1_000_000_000,
    },
  });
  createdContainers.add(id);
  await startContainer(id);
  await waitContainer(id, { timeoutMs: 10_000 });
  return id;
}

function seedCommand(files: Record<string, Buffer>): string[] {
  const writes = Object.entries(files).map(([rel, content]) =>
    `fs.mkdirSync(path.dirname('/workspace/' + ${JSON.stringify(rel)}), { recursive: true });\n` +
    `fs.writeFileSync('/workspace/' + ${JSON.stringify(rel)}, Buffer.from(${JSON.stringify(content.toString('base64'))}, 'base64'));`,
  ).join('\n');
  return ['node', '-e', `const fs=require('fs'); const path=require('path');\n${writes}`];
}

async function stageWorkspace(jobId: string, files: Record<string, Buffer>): Promise<string> {
  const volume = workspaceVolumeName(jobId);
  await createVolume(volume, labels('workspace', jobId));
  createdVolumes.add(volume);
  const cid = await makeRoleHelper({ jobId, role: 'runner', volume, readOnly: false, cmd: seedCommand(files) });
  await removeContainer(cid, true).catch(() => {});
  createdContainers.delete(cid);
  return volume;
}

async function realWorkspaceArchive(jobId: string, volume: string): Promise<Buffer> {
  const cid = await makeRoleHelper({ jobId, role: 'before-capture', volume, readOnly: true });
  return bufferStream((await getArchive(cid, WORKSPACE_PATH)).body);
}

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

  beforeAll(async () => {
    execFileSync('docker', ['build', '--pull=false', '-q', '-t', IMAGE_TAG, '-f', join(REPO_ROOT, 'runner', 'Dockerfile'), join(REPO_ROOT, 'runner')], { stdio: 'pipe' });
    helperImageId = (await inspectImage(IMAGE_TAG)).Id;
    expect(helperImageId).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 120_000);

  afterEach(async () => {
    for (const id of createdContainers) await removeContainer(id, true).catch(() => {});
    createdContainers.clear();
  });

  afterAll(async () => {
    for (const id of createdContainers) await removeContainer(id, true).catch(() => {});
    for (const v of createdVolumes) await removeVolume(v, true).catch(() => {});
  });

  it('real daemon prefixes every getArchive("/workspace") entry with "workspace/"', async () => {
    const jobId = newJobId();
    const vol = await stageWorkspace(jobId, { 'README.md': README, 'src/index.ts': V1 });
    const cid = await makeRoleHelper({ jobId, role: 'before-capture', volume: vol, readOnly: true });

    const names = await readTarNames((await getArchive(cid, WORKSPACE_PATH)).body);
    expect(names).toContain('directory:workspace/');
    expect(names).toContain('file:workspace/README.md');
    expect(names).toContain('directory:workspace/src/');
    expect(names).toContain('file:workspace/src/index.ts');
  });

  it('BEFORE and POST canonicalize the SAME real archive to the SAME project-relative paths', async () => {
    const jobId = newJobId();
    const vol = await stageWorkspace(jobId, { 'README.md': README, 'src/index.ts': V1 });

    const before = await captureBeforeEvidence({
      jobId, volumeName: vol, helperImage: helperImageId, maxEvidenceBytes: policy.maxEvidenceBytes,
    });
    createdVolumes.add(before.evidenceVolume);

    const post = await parsePostTarStream(
      Readable.from(await realWorkspaceArchive(jobId, vol)),
      policy.maxEvidenceBytes, new Set<string>(), policy.maxEvidenceBytes,
    );

    const beforePaths = before.entries.map((e) => e.relPath).sort();
    const postPaths = post.entries.map((e) => e.snapshot.path).sort();
    expect(beforePaths).toEqual(postPaths);
    expect(beforePaths).toEqual(['README.md', 'src/', 'src/index.ts']);

    for (const p of beforePaths) {
      expect(p).not.toBe('workspace');
      expect(p.startsWith('workspace/'), p).toBe(false);
      expect(p.startsWith('/'), p).toBe(false);
    }

    const readme = before.entries.find((e) => e.relPath === 'README.md')!;
    expect(readme.storedAt).toBe('/evidence/files/README.md');
    expect(readme.sha256).toBe(sha256hex(README));
  }, 180_000);

  it('detects unchanged/MODIFY/ADD/DELETE on canonical paths from real archives, and resolves under /project', async () => {
    const beforeJobId = newJobId();
    const postJobId = newJobId();
    const beforeVol = await stageWorkspace(beforeJobId, {
      'README.md': README, 'src/index.ts': V1, 'removed.ts': REMOVED,
    });
    const postVol = await stageWorkspace(postJobId, {
      'README.md': README, 'src/index.ts': V2, 'src/added.ts': ADDED,
    });

    const before = await captureBeforeEvidence({
      jobId: beforeJobId, volumeName: beforeVol, helperImage: helperImageId, maxEvidenceBytes: policy.maxEvidenceBytes,
    });
    createdVolumes.add(before.evidenceVolume);

    const post = await parsePostTarStream(
      Readable.from(await realWorkspaceArchive(postJobId, postVol)),
      policy.maxEvidenceBytes, new Set<string>(), policy.maxEvidenceBytes,
    );

    const postEntries = post.entries.map((e) => e.snapshot)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const diff = computeCanonicalDiff(toSnapshot(before.entries), { version: 1, entries: postEntries });
    const byPath = new Map(diff.entries.map((e) => [e.path, e.op]));

    expect(byPath.get('src/index.ts')).toBe('CONTENT_MODIFY');
    expect(byPath.get('src/added.ts')).toBe('ADD');
    expect(byPath.get('removed.ts')).toBe('DELETE');
    expect(byPath.has('README.md')).toBe(false);

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
