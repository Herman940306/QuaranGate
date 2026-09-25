/**
 * A6-B5 agent_apply — current Docker Authority integration contract.
 *
 * The hardened runtime no longer permits arbitrary disposable host directories
 * to be mounted as `/project`. Live apply is restricted to project roots with a
 * trusted worktree binding, and arbitrary temp-repo mutation is covered by the
 * unit-level apply-engine suite. This integration suite proves the live Docker
 * contract around that boundary: current ownership, immutable images, hardened
 * applier specs, evidence/control volume roles, untrusted-bind rejection, and
 * fail-closed project trust preconditions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack as tarPack, extract as tarExtract } from 'tar-stream';
import { Readable } from 'node:stream';
import {
  canonicalSerialize, validateSnapshotManifest, validateArtifactManifest,
  type SnapshotEntry, type SnapshotManifest, type ArtifactManifest,
} from '../../src/executor/agents/canonicalJson.js';
import { computeCanonicalDiff, computeChangeSetHash } from '../../src/executor/agents/canonicalDiff.js';
import { blobPath } from '../../src/executor/agents/artifactReader.js';
import {
  buildApplierCreateBody, controlVolumeName, ownershipLabels, toRunnerLimits,
  CONTROL_PATH,
} from '../../src/executor/agents/sandboxSpec.js';
import {
  createContainer, createVolume, getArchive, inspectImage, putArchive,
  removeContainer, removeVolume, startContainer, waitContainer,
} from '../../src/executor/docker.js';
import { createDockerApplierIO, runApplyAttempt } from '../../src/executor/agents/applyEngine.js';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { BridgeError } from '../../src/shared/errors.js';
import type { AgentProjectConfig } from '../../src/executor/agentConfig.js';
import { AGENT_RETENTION_DURATION_MS, type AgentResourcePolicy } from '../../src/shared/agents.js';

const IMAGE_TAG = 'qg-itest-a6-b5-applier:current';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JOB_ID = 'job_' + randomBytes(16).toString('hex');

const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast',
  maxRuntimeMs: 60_000, maxCpuMillicores: 1000, maxMemoryBytes: 268_435_456,
  maxPids: 64, maxOutputBytes: 65_536, maxEvidenceBytes: 10_485_760,
  networkPolicy: 'deny', retentionClass: 'ephemeral',
};

let helperImageId = '';
const createdVolumes = new Set<string>();
const createdContainers = new Set<string>();
const fixtures: string[] = [];

function sha256hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function makeCleanFixture(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'b5-fixture-'));
  fixtures.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'b5@test.local');
  git(dir, 'config', 'user.name', 'b5');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'modify.txt'), 'old content\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'initial');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

type FileSpec = { path: string; kind: 'file'; mode: number; content: Buffer };
function toEntry(s: FileSpec): SnapshotEntry {
  return { path: s.path, kind: 'file', mode: s.mode, sizeBytes: s.content.length, contentHash: sha256hex(s.content) };
}
const byPath = (a: SnapshotEntry, b: SnapshotEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

interface BuiltArtifact {
  artifactHash: string;
  manifest: ArtifactManifest;
  blobs: Map<string, Buffer>;
  manifestFiles: Map<string, Buffer>;
}

function buildArtifact(projectId: string, baseCommit: string, before: FileSpec[], after: FileSpec[]): BuiltArtifact {
  const beforeManifest: SnapshotManifest = { version: 1, entries: before.map(toEntry).sort(byPath) };
  const postManifest: SnapshotManifest = { version: 1, entries: after.map(toEntry).sort(byPath) };
  validateSnapshotManifest(beforeManifest);
  validateSnapshotManifest(postManifest);
  const changeSet = computeCanonicalDiff(beforeManifest, postManifest);
  const changeSetHash = computeChangeSetHash(changeSet);

  const blobs = new Map<string, Buffer>();
  for (const s of [...before, ...after]) {
    const hash = sha256hex(s.content);
    if (!blobs.has(blobPath(hash))) blobs.set(blobPath(hash), s.content);
  }
  let artifactBytes = 0;
  for (const b of blobs.values()) artifactBytes += b.length;

  const beforeBytes = canonicalSerialize(beforeManifest);
  const postBytes = canonicalSerialize(postManifest);
  const manifest: ArtifactManifest = {
    version: 1, jobId: JOB_ID, projectId, principalId: 'client-a', backend: 'kiro', profile: 'implement',
    baseCommit, baseCertified: true,
    beforeIdentity: sha256hex(beforeBytes), postIdentity: sha256hex(postBytes),
    changeSetHash, contentComplete: true, applicable: true, reason: null,
    opCount: changeSet.entries.length, artifactBytes, changes: changeSet.entries,
  };
  validateArtifactManifest(manifest);
  const artifactManifestBytes = canonicalSerialize(manifest);
  const artifactHash = sha256hex(artifactManifestBytes);

  const manifestFiles = new Map<string, Buffer>([
    ['artifact-manifest.json', artifactManifestBytes],
    ['before-snapshot-manifest.json', beforeBytes],
    ['post-snapshot-manifest.json', postBytes],
  ]);
  return { artifactHash, manifest, blobs, manifestFiles };
}

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

async function pushArtifactToVolume(volumeName: string, artifact: BuiltArtifact): Promise<void> {
  await createVolume(volumeName, ownershipLabels('evidence', JOB_ID));
  createdVolumes.add(volumeName);

  const p = tarPack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('end', () => resolve(Buffer.concat(chunks)));
    p.on('error', reject);
  });
  for (const [name, content] of artifact.manifestFiles) p.entry({ name, type: 'file', mode: 0o644, size: content.length }, content);
  for (const [path, content] of artifact.blobs) p.entry({ name: path, type: 'file', mode: 0o444, size: content.length }, content);
  p.finalize();
  const tarBuf = await done;

  const id = await createContainer(`io-quarangate-evidence-io-${JOB_ID}-${randomBytes(6).toString('hex')}`, {
    Image: helperImageId,
    User: '0:0',
    Cmd: ['true'],
    Labels: { 'io.quarangate.managed': 'true', 'io.quarangate.resource': 'evidence-io', 'io.quarangate.job': JOB_ID },
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
      Mounts: [{ Type: 'volume', Source: volumeName, Target: '/evidence', ReadOnly: false }],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
      Memory: 64 * 1024 * 1024,
      PidsLimit: 8,
      NanoCpus: 1_000_000_000,
    },
  });
  createdContainers.add(id);
  try {
    await startContainer(id);
    await waitContainer(id, { timeoutMs: 10_000 });
    await putArchive(id, '/evidence', tarBuf);
  } finally {
    await removeContainer(id, true).catch(() => {});
    createdContainers.delete(id);
  }
}

async function readEvidenceVolume(volumeName: string, path: string): Promise<Map<string, Buffer>> {
  const id = await createContainer(`io-quarangate-evidence-read-${JOB_ID}-${randomBytes(6).toString('hex')}`, {
    Image: helperImageId,
    User: '0:0',
    Cmd: ['true'],
    Labels: { 'io.quarangate.managed': 'true', 'io.quarangate.resource': 'evidence-read', 'io.quarangate.job': JOB_ID },
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
      Mounts: [{ Type: 'volume', Source: volumeName, Target: '/evidence', ReadOnly: true }],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
      Memory: 64 * 1024 * 1024,
      PidsLimit: 8,
      NanoCpus: 1_000_000_000,
    },
  });
  createdContainers.add(id);
  try {
    await startContainer(id);
    await waitContainer(id, { timeoutMs: 10_000 });
    return readTar((await getArchive(id, path)).body);
  } finally {
    await removeContainer(id, true).catch(() => {});
    createdContainers.delete(id);
  }
}

const project: AgentProjectConfig = {
  id: 'b5-fixture-project', hostPath: '', gitRequired: true, backends: ['kiro'], profiles: ['implement'], guardedPaths: [],
};

describe('A6-B5 agent_apply — current Docker Authority integration contract', () => {
  beforeAll(async () => {
    execFileSync('docker', ['build', '--pull=false', '-q', '-t', IMAGE_TAG, '-f', join(REPO_ROOT, 'runner', 'Dockerfile'), join(REPO_ROOT, 'runner')], { stdio: 'pipe' });
    helperImageId = (await inspectImage(IMAGE_TAG)).Id;
    expect(helperImageId).toMatch(/^sha256:[0-9a-f]{64}$/);
  }, 120_000);

  afterAll(async () => {
    for (const id of createdContainers) await removeContainer(id, true).catch(() => {});
    for (const v of createdVolumes) await removeVolume(v, true).catch(() => {});
    for (const d of fixtures) rmSync(d, { recursive: true, force: true });
  });

  it('buildApplierCreateBody creates a hardened applier spec with immutable image, evidence RO, control RW, and one project bind', () => {
    const { dir } = makeCleanFixture();
    const attemptId = 'att_' + randomBytes(16).toString('hex');
    const evidenceVol = `io-quarangate-evidence-${JOB_ID}`;
    const controlVol = controlVolumeName(attemptId);
    const body = buildApplierCreateBody({
      image: helperImageId,
      jobId: JOB_ID,
      attemptId,
      hostPath: dir,
      artifactVolume: evidenceVol,
      controlVolume: controlVol,
      limits: toRunnerLimits(policy),
    }) as any;

    expect(body.Image).toBe(helperImageId);
    expect(body.User).toBe('0:0');
    expect(body.Labels['io.quarangate.resource']).toBe('applier');
    expect(body.Labels['io.quarangate.job']).toBe(JOB_ID);
    expect(body.Labels['io.quarangate.attempt']).toBe(attemptId);
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.CapDrop).toEqual(['ALL']);
    expect(body.HostConfig.CapAdd).toEqual(['DAC_OVERRIDE', 'FOWNER']);
    expect(body.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(body.HostConfig.NetworkMode).toBe('none');
    expect(body.HostConfig.Binds).toEqual([`${dir}:/project:rw`]);
    expect(body.HostConfig.Mounts).toEqual(expect.arrayContaining([
      { Type: 'volume', Source: evidenceVol, Target: '/artifact', ReadOnly: true },
      { Type: 'volume', Source: controlVol, Target: CONTROL_PATH, ReadOnly: false },
    ]));
    expect(JSON.stringify(body)).not.toContain('docker.sock');
  });

  it('Docker Authority rejects an untrusted disposable host project bind before the applier can execute', async () => {
    const { dir } = makeCleanFixture();
    const attemptId = 'att_' + randomBytes(16).toString('hex');
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    const controlVol = controlVolumeName(attemptId);
    await createVolume(evidenceVol, ownershipLabels('evidence', JOB_ID));
    await createVolume(controlVol, ownershipLabels('control', JOB_ID));
    createdVolumes.add(evidenceVol);
    createdVolumes.add(controlVol);

    const body = buildApplierCreateBody({
      image: helperImageId,
      jobId: JOB_ID,
      attemptId,
      hostPath: dir,
      artifactVolume: evidenceVol,
      controlVolume: controlVol,
      limits: toRunnerLimits(policy),
    });

    await expect(createContainer(`io-quarangate-applier-${attemptId}`, body as unknown as Record<string, unknown>))
      .rejects.toThrow(/host bind must equal an exact trusted configured root|FORBIDDEN_POLICY/i);
  });

  it('writes and reads an apply artifact through current evidence volume roles', async () => {
    const { head } = makeCleanFixture();
    const before: FileSpec[] = [{ path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('old content\n') }];
    const after: FileSpec[] = [{ path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('new content\n') }];
    const artifact = buildArtifact(project.id, head, before, after);
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;

    await pushArtifactToVolume(evidenceVol, artifact);
    const manifestTar = await readEvidenceVolume(evidenceVol, '/evidence/artifact-manifest.json');
    const manifest = JSON.parse([...manifestTar.values()][0]!.toString('utf8'));
    expect(manifest.jobId).toBe(JOB_ID);
    expect(manifest.changeSetHash).toBe(artifact.manifest.changeSetHash);

    const blobEntry = [...artifact.blobs.keys()][0]!;
    const blobTar = await readEvidenceVolume(evidenceVol, `/evidence/${blobEntry}`);
    expect([...blobTar.values()][0]!.equals(artifact.blobs.get(blobEntry)!)).toBe(true);
  });

  it('runApplyAttempt fails closed before Docker mutation when the project has no trusted worktreeId', async () => {
    const { dir, head } = makeCleanFixture();
    const before: FileSpec[] = [{ path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('old content\n') }];
    const after: FileSpec[] = [{ path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('new content\n') }];
    const artifact = buildArtifact(project.id, head, before, after);

    const store = new AgentJobStore(':memory:');
    store.insert({
      jobId: JOB_ID, principalId: 'client-a', backend: 'kiro', project: project.id, profile: 'implement',
      resourcePolicy: 'economy', promptHash: 'h'.repeat(64), prompt: 'test', sessionPolicy: 'new', writer: true,
      retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral,
    });
    store.transition(JOB_ID, 'QUEUED', 'PREPARING');
    store.transition(JOB_ID, 'PREPARING', 'RUNNING');
    store.transition(JOB_ID, 'RUNNING', 'VALIDATING');
    store.setBaseCommit(JOB_ID, head);
    store.publishArtifact(JOB_ID, {
      artifactHash: artifact.artifactHash, changeSetHash: artifact.manifest.changeSetHash,
      contentComplete: true, applicable: true, reason: null,
      artifactVolume: 'unneeded-for-precondition', artifactBytes: artifact.manifest.artifactBytes, opCount: artifact.manifest.opCount,
    });
    store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');

    const evidenceReaderFactory = () => ({
      async readFile(relPath: string): Promise<Buffer> {
        const b = artifact.manifestFiles.get(relPath) ?? artifact.blobs.get(relPath);
        if (!b) throw new Error(`not found: ${relPath}`);
        return b;
      },
    });

    let code = '';
    try {
      await runApplyAttempt(
        { store, evidenceReaderFactory, applierImage: helperImageId, applierIO: createDockerApplierIO() },
        store.get(JOB_ID)!,
        { ...project, hostPath: dir },
        policy,
      );
    } catch (e) {
      if (e instanceof BridgeError) code = e.code;
      else throw e;
    }
    expect(code).toBe('PRECONDITION_FAILED');
    expect(store.get(JOB_ID)!.status).toBe('COMPLETED');
  });
});
