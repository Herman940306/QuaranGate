/**
 * A6-B5 agent_apply — Docker integration (controlled, self-contained).
 *
 * Drives the real trusted applier container + real embedded scripts
 * (MOUNTINFO_CHECK_SCRIPT, GIT_HOST_CHECK_SCRIPT, APPLY_MUTATION_SCRIPT)
 * against disposable fixture git repositories and a real Docker evidence
 * volume — proving the primitives tests/unit/a6-b5-apply-engine.test.ts
 * exercises through a faithful in-memory fake actually behave correctly
 * against a real container/filesystem. NO MCP client, NO gateway, NO live
 * stack, and — per the absolute rule governing this batch — this suite NEVER
 * targets /home/herman/projects/mcp-ide-bridge or any real user project; every
 * mutation test runs against a disposable git fixture created and destroyed
 * by this file alone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, linkSync, statSync, lstatSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack as tarPack } from 'tar-stream';
import {
  canonicalSerialize, validateSnapshotManifest, validateArtifactManifest,
  type SnapshotEntry, type SnapshotManifest, type ArtifactManifest,
} from '../../src/executor/agents/canonicalJson.js';
import { computeCanonicalDiff, computeChangeSetHash } from '../../src/executor/agents/canonicalDiff.js';
import { blobPath } from '../../src/executor/agents/artifactReader.js';
import {
  MOUNTINFO_CHECK_SCRIPT, GIT_HOST_CHECK_SCRIPT, APPLY_MUTATION_SCRIPT,
  buildApplierCreateBody, applierContainerName, controlVolumeName, applierOwnershipLabels, toRunnerLimits,
  CONTROL_PATH, MANAGED_FILTER, ownershipLabels, PROJECT_PATH,
} from '../../src/executor/agents/sandboxSpec.js';
import {
  createContainer, startContainer, removeContainer, inspectContainerFull,
  createVolume, removeVolume, listContainersByFilter, listVolumesByFilter,
} from '../../src/executor/docker.js';
import { createDockerApplierIO, runApplyAttempt } from '../../src/executor/agents/applyEngine.js';
import { AgentJobStore } from '../../src/executor/agents/jobStore.js';
import { BridgeError } from '../../src/shared/errors.js';
import type { AgentProjectConfig } from '../../src/executor/agentConfig.js';
import { AGENT_RETENTION_DURATION_MS, type AgentResourcePolicy } from '../../src/shared/agents.js';

const IMAGE = 'mcp-ide-bridge-sandbox:a3'; // same trusted helper image family as A3/B2/B3/B4 — no new image (§9)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JOB_ID = 'job_' + randomBytes(16).toString('hex');

const policy: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast',
  maxRuntimeMs: 60_000, maxCpuMillicores: 1000, maxMemoryBytes: 268_435_456,
  maxPids: 64, maxOutputBytes: 65536, maxEvidenceBytes: 10_485_760,
  networkPolicy: 'deny', retentionClass: 'ephemeral',
};

function sha256hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A clean, disposable git fixture — the ONLY kind of project this suite ever touches. */
function makeCleanFixture(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'b5-fixture-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'b5@test.local');
  git(dir, 'config', 'user.name', 'b5');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'modify.txt'), 'old content\n');
  writeFileSync(join(dir, 'src', 'delete.txt'), 'to be deleted\n');
  writeFileSync(join(dir, 'src', 'chmod.txt'), 'mode only\n');
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
  blobs: Map<string, Buffer>; // blobPath -> bytes
  manifestFiles: Map<string, Buffer>; // fixed filename -> bytes
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

/** Push a real artifact into a real Docker volume, mirroring beforeCapture.ts's writeEvidenceToVolume pattern. */
async function pushArtifactToVolume(volumeName: string, artifact: BuiltArtifact): Promise<void> {
  await createVolume(volumeName, { 'io.mcp-ide-bridge.managed': 'true', 'io.mcp-ide-bridge.resource': 'evidence', 'io.mcp-ide-bridge.job': JOB_ID });
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

  const name = `b5-evwrite-${randomBytes(6).toString('hex')}`;
  const id = await createContainer(name, {
    Image: IMAGE, User: '0:0', Cmd: ['true'],
    Labels: { 'io.mcp-ide-bridge.managed': 'true', 'io.mcp-ide-bridge.resource': 'evidence', 'io.mcp-ide-bridge.job': JOB_ID },
    NetworkDisabled: true,
    HostConfig: { AutoRemove: false, Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], NetworkMode: 'none', Mounts: [{ Type: 'volume', Source: volumeName, Target: '/evidence', ReadOnly: false }] },
  });
  try {
    await startContainer(id);
    const { putArchive } = await import('../../src/executor/docker.js');
    await putArchive(id, '/evidence', tarBuf);
  } finally {
    await removeContainer(id, true).catch(() => {});
  }
}

/** Create a real applier container (control volume + create, NOT started). Caller starts + tears down both. */
async function createApplier(attemptId: string, dir: string, evidenceVol: string, extraBinds: string[] = []): Promise<{ id: string; controlVolume: string }> {
  const controlVolume = controlVolumeName(attemptId);
  await createVolume(controlVolume, applierOwnershipLabels(JOB_ID, attemptId));
  const body = buildApplierCreateBody({
    image: IMAGE, jobId: JOB_ID, attemptId, hostPath: dir, artifactVolume: evidenceVol, controlVolume, limits: toRunnerLimits(policy),
  }) as unknown as { HostConfig: { Binds: string[] } };
  if (extraBinds.length > 0) body.HostConfig.Binds = [...body.HostConfig.Binds, ...extraBinds];
  const id = await createContainer(applierContainerName(attemptId), body as unknown as Record<string, unknown>);
  return { id, controlVolume };
}

const fixtures: string[] = [];
const project: AgentProjectConfig = {
  id: 'b5-fixture-project', hostPath: '', gitRequired: true, backends: ['kiro'], profiles: ['implement'], guardedPaths: [],
};

describe('A6-B5 agent_apply — Docker integration', () => {
  beforeAll(() => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '-f', join(REPO_ROOT, 'runner', 'Dockerfile'), join(REPO_ROOT, 'runner')], { stdio: 'pipe' });
  }, 120_000);

  afterEach(async () => {
    // Belt-and-suspenders: never leave a live applier/evidence resource from
    // a failed assertion lying around between tests.
    const containers = await listContainersByFilter(MANAGED_FILTER, true).catch(() => []);
    for (const c of containers) await removeContainer(c.Id, true).catch(() => {});
    const vols = await listVolumesByFilter(MANAGED_FILTER).catch(() => []);
    for (const v of vols) await removeVolume(v.Name, true).catch(() => {});
  });

  afterAll(() => {
    for (const d of fixtures) rmSync(d, { recursive: true, force: true });
  });

  it('applier container config: exactly one RW project bind + one RO artifact volume + one RW control volume, root+DAC_OVERRIDE+FOWNER, fully confined, no docker.sock', async () => {
    const { dir } = makeCleanFixture();
    fixtures.push(dir);
    const attemptId = 'att_' + randomBytes(16).toString('hex');
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await createVolume(evidenceVol, ownershipLabels('evidence', JOB_ID));
    const { id, controlVolume } = await createApplier(attemptId, dir, evidenceVol);
    try {
      await startContainer(id);
      const info = await inspectContainerFull(id);
      expect(info.Config.User).toBe('0:0');
      expect(info.HostConfig.Privileged).toBe(false);
      expect(info.HostConfig.CapDrop).toEqual(['ALL']);
      // The narrowest possible restoration of root's DAC-bypass behavior —
      // required for reliable access to a real (often 0700-owned) project
      // tree once every other capability is dropped (see sandboxSpec.ts).
      expect(info.HostConfig.CapAdd).toEqual(['DAC_OVERRIDE', 'FOWNER']);
      expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(info.HostConfig.ReadonlyRootfs).toBe(true);
      expect(info.HostConfig.NetworkMode).toBe('none');
      expect(info.HostConfig.PidMode).not.toBe('host');
      expect(info.HostConfig.IpcMode).not.toBe('host');

      const binds = info.HostConfig.Binds ?? [];
      expect(binds).toHaveLength(1);
      expect(binds[0]).toBe(`${dir}:/project:rw`);

      const volMounts = info.Mounts.filter((m) => m.Type === 'volume');
      expect(volMounts).toHaveLength(2);
      const artifactMount = volMounts.find((m) => m.Destination === '/artifact');
      const controlMount = volMounts.find((m) => m.Destination === CONTROL_PATH);
      expect(artifactMount?.RW).toBe(false);
      expect(controlMount?.RW).toBe(true);
      expect(artifactMount?.Source).toContain(evidenceVol);
      expect(controlMount?.Source).toContain(controlVolume);

      expect(JSON.stringify(info.Mounts)).not.toContain('docker.sock');
      expect(info.HostConfig.Binds?.join(',') ?? '').not.toContain('docker.sock');
    } finally {
      await removeContainer(id, true).catch(() => {});
      await removeVolume(evidenceVol, true).catch(() => {});
      await removeVolume(controlVolume, true).catch(() => {});
    }
  }, 60_000);

  it('mountinfo check rejects a real nested mount under the project bind, before any exec touches the project', async () => {
    const { dir } = makeCleanFixture();
    fixtures.push(dir);
    const nestedSource = mkdtempSync(join(tmpdir(), 'b5-nested-'));
    fixtures.push(nestedSource);
    const attemptId = 'att_' + randomBytes(16).toString('hex');
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await createVolume(evidenceVol, ownershipLabels('evidence', JOB_ID));
    // Deliberately inject an EXTRA bind nested under /project — exactly the
    // attack MOUNTINFO_CHECK_SCRIPT exists to catch. A legitimate applier
    // build never does this (buildApplierCreateBody only ever emits the one
    // project bind) — this test proves the DEFENSE fires when it happens.
    const { id, controlVolume } = await createApplier(attemptId, dir, evidenceVol, [`${nestedSource}:/project/nested:ro`]);
    try {
      await startContainer(id);
      const applier = createDockerApplierIO();
      const res = await applier.exec(id, ['node', '-e', MOUNTINFO_CHECK_SCRIPT]);
      expect(res.exitCode).not.toBe(0);
      const parsed = JSON.parse(res.stdout.trim().split('\n').pop()!);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/nested mount/i);
    } finally {
      await removeContainer(id, true).catch(() => {});
      await removeVolume(evidenceVol, true).catch(() => {});
      await removeVolume(controlVolume, true).catch(() => {});
    }
  }, 60_000);

  it('git host check: clean+matching HEAD succeeds; dirty tree -> exit 3; stale HEAD is caught by the caller comparing stdout', async () => {
    const { dir, head } = makeCleanFixture();
    fixtures.push(dir);
    const attemptId = 'att_' + randomBytes(16).toString('hex');
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await createVolume(evidenceVol, ownershipLabels('evidence', JOB_ID));
    const { id, controlVolume } = await createApplier(attemptId, dir, evidenceVol);
    try {
      await startContainer(id);
      const applier = createDockerApplierIO();

      const clean = await applier.exec(id, ['sh', '-c', GIT_HOST_CHECK_SCRIPT]);
      expect(clean.exitCode).toBe(0);
      expect(clean.stdout.trim()).toBe(`HEAD=${head}`);

      writeFileSync(join(dir, 'untracked.txt'), 'dirty\n');
      const dirty = await applier.exec(id, ['sh', '-c', GIT_HOST_CHECK_SCRIPT]);
      expect(dirty.exitCode).toBe(3);
      expect(dirty.stderr.trim()).toBe('DIRTY_WORKING_TREE');
    } finally {
      await removeContainer(id, true).catch(() => {});
      await removeVolume(evidenceVol, true).catch(() => {});
      await removeVolume(controlVolume, true).catch(() => {});
    }
  }, 60_000);

  it('symlink defense: a symlink planted at a changed-path location is refused, never followed, by both the live read and the mutation script', async () => {
    const { dir } = makeCleanFixture();
    fixtures.push(dir);
    const outsideTarget = mkdtempSync(join(tmpdir(), 'b5-outside-'));
    fixtures.push(outsideTarget);
    writeFileSync(join(outsideTarget, 'secret.txt'), 'should never be read or written through the link\n');
    // Replace a tracked file with a symlink pointing OUTSIDE the project.
    execFileSync('rm', [join(dir, 'src', 'modify.txt')]);
    symlinkSync(join(outsideTarget, 'secret.txt'), join(dir, 'src', 'modify.txt'));

    const attemptId = 'att_' + randomBytes(16).toString('hex');
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await createVolume(evidenceVol, ownershipLabels('evidence', JOB_ID));
    const { id, controlVolume } = await createApplier(attemptId, dir, evidenceVol);
    try {
      await startContainer(id);
      const applier = createDockerApplierIO();

      // Live read: the executor-side read must classify the symlink as
      // 'other', never following it into 'file' content.
      const read = await applier.readProjectPath(id, 'src/modify.txt');
      expect(read.exists).toBe(true);
      expect(read.kind).toBe('other');

      // Mutation script: attempt a CONTENT_MODIFY against the symlinked path
      // — requireSingleLinkRegularFile's lstat-based check must refuse it before ever
      // opening the file (which would follow the link).
      const control = {
        mode: 'apply',
        opIndex: 0,
        op: { path: 'src/modify.txt', op: 'CONTENT_MODIFY', beforeHash: 'f'.repeat(64), beforeMode: 0o644, postHash: 'f'.repeat(64), postSize: 1, postMode: 0o644 },
      };
      await applier.putArchive(id, CONTROL_PATH, await packControl(control));
      const res = await applier.exec(id, ['node', '-e', APPLY_MUTATION_SCRIPT]);
      expect(res.exitCode).not.toBe(0);
      const line = JSON.parse(res.stdout.trim());
      expect(line.ok).toBe(false);
      expect(line.error).toMatch(/not a regular file|symlink/i);

      // The outside target is completely untouched.
      expect(readFileSync(join(outsideTarget, 'secret.txt'), 'utf8')).toBe('should never be read or written through the link\n');
    } finally {
      await removeContainer(id, true).catch(() => {});
      await removeVolume(evidenceVol, true).catch(() => {});
      await removeVolume(controlVolume, true).catch(() => {});
    }
  }, 60_000);

  it('full end-to-end runApplyAttempt() against a real Docker applier: ADD + CONTENT_MODIFY + DELETE + MODE_CHANGE land exactly, job becomes APPLIED', async () => {
    const { dir, head } = makeCleanFixture();
    fixtures.push(dir);
    const before: FileSpec[] = [
      { path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('old content\n') },
      { path: 'src/delete.txt', kind: 'file', mode: 0o644, content: Buffer.from('to be deleted\n') },
      { path: 'src/chmod.txt', kind: 'file', mode: 0o644, content: Buffer.from('mode only\n') },
    ];
    const after: FileSpec[] = [
      { path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('new content\n') },
      { path: 'src/add.txt', kind: 'file', mode: 0o644, content: Buffer.from('brand new\n') },
      { path: 'src/chmod.txt', kind: 'file', mode: 0o755, content: Buffer.from('mode only\n') },
    ];
    const artifact = buildArtifact(project.id, head, before, after);
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await pushArtifactToVolume(evidenceVol, artifact);

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
      artifactVolume: evidenceVol, artifactBytes: artifact.manifest.artifactBytes, opCount: artifact.manifest.opCount,
    });
    store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');

    const evidenceReaderFactory = () => ({
      async readFile(relPath: string): Promise<Buffer> {
        const b = artifact.manifestFiles.get(relPath) ?? artifact.blobs.get(relPath);
        if (!b) throw new Error(`not found: ${relPath}`);
        return b;
      },
    });

    const result = await runApplyAttempt(
      { store, evidenceReaderFactory, applierImage: IMAGE, applierIO: createDockerApplierIO() },
      store.get(JOB_ID)!,
      { ...project, hostPath: dir },
      policy,
    );
    expect(result.status).toBe('APPLIED');

    expect(readFileSync(join(dir, 'src', 'modify.txt'), 'utf8')).toBe('new content\n');
    expect(existsSync(join(dir, 'src', 'delete.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'src', 'add.txt'), 'utf8')).toBe('brand new\n');
    expect(execFileSync('stat', ['-c', '%a', join(dir, 'src', 'chmod.txt')], { encoding: 'utf8' }).trim()).toBe('755');

    // HEAD unchanged (this is a working-tree mutation, not a commit).
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);

    expect(store.get(JOB_ID)!.status).toBe('APPLIED');
    const attempts = store.listApplyAttemptsForJob(JOB_ID);
    expect(attempts[0]!.state).toBe('VERIFIED_SUCCESS');
    expect(store.listApplyJournalForAttempt(attempts[0]!.attemptId)).toHaveLength(4);

    await removeVolume(evidenceVol, true).catch(() => {});
  }, 90_000);

  it('reconcileOrphans reaps an orphaned applier container AND its control volume, but retains the evidence volume', async () => {
    const { dir } = makeCleanFixture();
    fixtures.push(dir);
    const attemptId = 'att_' + randomBytes(16).toString('hex');
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await createVolume(evidenceVol, ownershipLabels('evidence', JOB_ID));
    const { id, controlVolume } = await createApplier(attemptId, dir, evidenceVol);
    await startContainer(id);

    const { RunnerSandbox } = await import('../../src/executor/agents/sandboxRunner.js');
    const sandbox = new RunnerSandbox({ image: IMAGE });
    const result = await sandbox.reconcileOrphans();

    expect(result.removedContainers).toContain(id);
    // The ephemeral control volume is reaped like any other 'applier'-kind
    // resource (it carries no evidence — the artifact stays on the RO
    // evidence volume). The evidence volume survives — protected by the
    // existing resource==='evidence' skip rule.
    expect(result.removedVolumes).toContain(controlVolume);
    expect(result.removedVolumes).not.toContain(evidenceVol);
    const vols = await listVolumesByFilter(MANAGED_FILTER);
    expect(vols.map((v) => v.Name)).toContain(evidenceVol);
    expect(vols.map((v) => v.Name)).not.toContain(controlVolume);

    await removeVolume(evidenceVol, true).catch(() => {});
  }, 60_000);

  // -------------------------------------------------------------------------
  // Shared helper for end-to-end runApplyAttempt tests.
  // -------------------------------------------------------------------------

  async function runE2E(dir: string, head: string, artifact: BuiltArtifact, evidenceVol: string): Promise<{ store: AgentJobStore }> {
    const store = new AgentJobStore(':memory:');
    store.insert({ jobId: JOB_ID, principalId: 'client-a', backend: 'kiro', project: project.id, profile: 'implement', resourcePolicy: 'economy', promptHash: 'h'.repeat(64), prompt: 'test', sessionPolicy: 'new', writer: true, retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral });
    store.transition(JOB_ID, 'QUEUED', 'PREPARING');
    store.transition(JOB_ID, 'PREPARING', 'RUNNING');
    store.transition(JOB_ID, 'RUNNING', 'VALIDATING');
    store.setBaseCommit(JOB_ID, head);
    store.publishArtifact(JOB_ID, { artifactHash: artifact.artifactHash, changeSetHash: artifact.manifest.changeSetHash, contentComplete: true, applicable: true, reason: null, artifactVolume: evidenceVol, artifactBytes: artifact.manifest.artifactBytes, opCount: artifact.manifest.opCount });
    store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');
    const evFactory = () => ({ async readFile(rel: string) { const b = artifact.manifestFiles.get(rel) ?? artifact.blobs.get(rel); if (!b) throw new Error(`not found: ${rel}`); return b; } });
    await runApplyAttempt({ store, evidenceReaderFactory: evFactory, applierImage: IMAGE, applierIO: createDockerApplierIO() }, store.get(JOB_ID)!, { ...project, hostPath: dir }, policy);
    return { store };
  }

  async function expectBridgeCode(p: Promise<unknown>): Promise<string> {
    try { await p; return 'NO_THROW'; }
    catch (e) { return e instanceof BridgeError ? e.code : `NON_BRIDGE:${e instanceof Error ? e.message.slice(0, 80) : String(e)}`; }
  }


/** Pack a single-op control file in the remediated format: { mode, opIndex, op }. */
async function packControl(content: unknown): Promise<Buffer> {
  const buf = Buffer.from(JSON.stringify(content), 'utf8');
  const p = tarPack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('end', () => resolve(Buffer.concat(chunks)));
    p.on('error', reject);
  });
  p.entry({ name: 'mcp-apply-ops.json', type: 'file', mode: 0o600, size: buf.length }, buf);
  p.finalize();
  return done;
}

  // F4: hardlink — real filesystem nlink>1 refused before APPLYING.
  it('F4 hardlink: project file with nlink>1 refused (HOST_PRECERTIFICATION_FAILED), outside inode untouched', async () => {
    const { dir, head } = makeCleanFixture();
    fixtures.push(dir);
    const outsideDir = mkdtempSync(join(tmpdir(), 'b5-hl-'));
    fixtures.push(outsideDir);
    // src/chmod.txt exists from makeCleanFixture. Create a hardlink to it from outsideDir.
    // linkSync(existingPath, newLinkPath) — existingPath = src/chmod.txt, newLink = outside.txt
    linkSync(join(dir, 'src', 'chmod.txt'), join(outsideDir, 'outside.txt'));
    expect(statSync(join(dir, 'src', 'chmod.txt')).nlink).toBe(2); // confirm hardlink
    const content = Buffer.from('mode only\n');
    const before: FileSpec[] = [
      { path: 'src/chmod.txt', kind: 'file', mode: 0o644, content },
      { path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('old content\n') },
    ];
    const after: FileSpec[] = [
      { path: 'src/chmod.txt', kind: 'file', mode: 0o755, content },
      { path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('old content\n') },
    ];
    const artifact = buildArtifact(project.id, head, before, after);
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await pushArtifactToVolume(evidenceVol, artifact);
    const store = new AgentJobStore(':memory:');
    store.insert({ jobId: JOB_ID, principalId: 'client-a', backend: 'kiro', project: project.id, profile: 'implement', resourcePolicy: 'economy', promptHash: 'h'.repeat(64), prompt: 'test', sessionPolicy: 'new', writer: true, retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral });
    store.transition(JOB_ID, 'QUEUED', 'PREPARING'); store.transition(JOB_ID, 'PREPARING', 'RUNNING');
    store.transition(JOB_ID, 'RUNNING', 'VALIDATING'); store.setBaseCommit(JOB_ID, head);
    store.publishArtifact(JOB_ID, { artifactHash: artifact.artifactHash, changeSetHash: artifact.manifest.changeSetHash, contentComplete: true, applicable: true, reason: null, artifactVolume: evidenceVol, artifactBytes: artifact.manifest.artifactBytes, opCount: artifact.manifest.opCount });
    store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');
    const evFactory = () => ({ async readFile(rel: string) { const b = artifact.manifestFiles.get(rel) ?? artifact.blobs.get(rel); if (!b) throw new Error(`not found: ${rel}`); return b; } });
    const code = await expectBridgeCode(runApplyAttempt({ store, evidenceReaderFactory: evFactory, applierImage: IMAGE, applierIO: createDockerApplierIO() }, store.get(JOB_ID)!, { ...project, hostPath: dir }, policy));
    expect(code).toBe('HOST_PRECERTIFICATION_FAILED');
    expect((statSync(join(dir, 'src', 'chmod.txt')).mode & 0o7777).toString(8)).toBe('644'); // mode unchanged
    expect(readFileSync(join(outsideDir, 'outside.txt'), 'utf8')).toBe('mode only\n'); // outside file untouched
    expect(statSync(join(dir, 'src', 'chmod.txt')).nlink).toBe(2); // still hardlinked
    await removeVolume(evidenceVol, true).catch(() => {});
  }, 90_000);

  // FIFO special-file defense: gitignored path used so git tree stays clean.
  it('FIFO at changed-path location is refused (HOST_PRECERTIFICATION_FAILED), zero mutation', async () => {
    const { dir } = makeCleanFixture();
    fixtures.push(dir);
    // Commit a .gitignore so the FIFO path is ignored by git status — this
    // keeps the working tree clean so the git-host-check passes.
    writeFileSync(join(dir, '.gitignore'), 'src/fifo-target.txt\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-qm', 'add gitignore');
    const headWithIgnore = git(dir, 'rev-parse', 'HEAD');
    // Create a FIFO at the ignored path (git never tracks it)
    execFileSync('mkfifo', [join(dir, 'src', 'fifo-target.txt')]);
    // Confirm the working tree is still clean from git's perspective
    const statusOut = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    expect(statusOut.trim()).toBe('');
    const before: FileSpec[] = [
      { path: 'src/fifo-target.txt', kind: 'file', mode: 0o644, content: Buffer.from('old content\n') },
    ];
    const after: FileSpec[] = [
      { path: 'src/fifo-target.txt', kind: 'file', mode: 0o644, content: Buffer.from('new content\n') },
    ];
    const artifact = buildArtifact(project.id, headWithIgnore, before, after);
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await pushArtifactToVolume(evidenceVol, artifact);
    const store = new AgentJobStore(':memory:');
    store.insert({ jobId: JOB_ID, principalId: 'client-a', backend: 'kiro', project: project.id, profile: 'implement', resourcePolicy: 'economy', promptHash: 'h'.repeat(64), prompt: 'test', sessionPolicy: 'new', writer: true, retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral });
    store.transition(JOB_ID, 'QUEUED', 'PREPARING'); store.transition(JOB_ID, 'PREPARING', 'RUNNING');
    store.transition(JOB_ID, 'RUNNING', 'VALIDATING'); store.setBaseCommit(JOB_ID, headWithIgnore);
    store.publishArtifact(JOB_ID, { artifactHash: artifact.artifactHash, changeSetHash: artifact.manifest.changeSetHash, contentComplete: true, applicable: true, reason: null, artifactVolume: evidenceVol, artifactBytes: artifact.manifest.artifactBytes, opCount: artifact.manifest.opCount });
    store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');
    const evFactory = () => ({ async readFile(rel: string) { const b = artifact.manifestFiles.get(rel) ?? artifact.blobs.get(rel); if (!b) throw new Error(`not found: ${rel}`); return b; } });
    const code = await expectBridgeCode(runApplyAttempt({ store, evidenceReaderFactory: evFactory, applierImage: IMAGE, applierIO: createDockerApplierIO() }, store.get(JOB_ID)!, { ...project, hostPath: dir }, policy));
    expect(code).toBe('HOST_PRECERTIFICATION_FAILED');
    expect(lstatSync(join(dir, 'src', 'fifo-target.txt')).isFIFO()).toBe(true); // FIFO untouched
    await removeVolume(evidenceVol, true).catch(() => {});
  }, 90_000);

  // SYMLINK_CHANGE refused by applyEngine before any Docker exec.
  it('SYMLINK_CHANGE op refused (APPLY_UNSUPPORTED_OPERATION) before any mutation exec', async () => {
    const { dir, head } = makeCleanFixture();
    fixtures.push(dir);
    const { canonicalSerialize: cs, validateSnapshotManifest: vsm, validateArtifactManifest: vam } = await import('../../src/executor/agents/canonicalJson.js');
    const { computeCanonicalDiff, computeChangeSetHash } = await import('../../src/executor/agents/canonicalDiff.js');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const bm = { version: 1 as const, entries: [{ path: 'link.txt', kind: 'symlink' as const, mode: 0o120777, contentHash: sha(Buffer.from('target-a.txt')), target: 'target-a.txt' }] };
    const am = { version: 1 as const, entries: [{ path: 'link.txt', kind: 'symlink' as const, mode: 0o120777, contentHash: sha(Buffer.from('target-b.txt')), target: 'target-b.txt' }] };
    vsm(bm); vsm(am);
    const changeSet = computeCanonicalDiff(bm, am);
    expect(changeSet.entries[0]!.op).toBe('SYMLINK_CHANGE');
    const csHash = computeChangeSetHash(changeSet);
    const bb = cs(bm); const ab = cs(am);
    const mf = { version: 1 as const, jobId: JOB_ID, projectId: project.id, principalId: 'client-a', backend: 'kiro' as const, profile: 'implement', baseCommit: head, baseCertified: true, beforeIdentity: sha(bb), postIdentity: sha(ab), changeSetHash: csHash, contentComplete: true, applicable: true, reason: null, opCount: 1, artifactBytes: 0, changes: changeSet.entries };
    vam(mf);
    const mb = cs(mf); const mhash = sha(mb);
    const es = new Map<string, Buffer>([['artifact-manifest.json', mb], ['before-snapshot-manifest.json', bb], ['post-snapshot-manifest.json', ab]]);
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await pushArtifactToVolume(evidenceVol, { artifactHash: mhash, manifest: mf, blobs: new Map(), manifestFiles: es });
    const store = new AgentJobStore(':memory:');
    store.insert({ jobId: JOB_ID, principalId: 'client-a', backend: 'kiro', project: project.id, profile: 'implement', resourcePolicy: 'economy', promptHash: 'h'.repeat(64), prompt: 'test', sessionPolicy: 'new', writer: true, retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral });
    store.transition(JOB_ID, 'QUEUED', 'PREPARING'); store.transition(JOB_ID, 'PREPARING', 'RUNNING');
    store.transition(JOB_ID, 'RUNNING', 'VALIDATING'); store.setBaseCommit(JOB_ID, head);
    store.publishArtifact(JOB_ID, { artifactHash: mhash, changeSetHash: csHash, contentComplete: true, applicable: true, reason: null, artifactVolume: evidenceVol, artifactBytes: 0, opCount: 1 });
    store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');
    const code = await expectBridgeCode(runApplyAttempt({ store, evidenceReaderFactory: () => ({ async readFile(rel: string) { const b = es.get(rel); if (!b) throw new Error(`not found: ${rel}`); return b; } }), applierImage: IMAGE, applierIO: createDockerApplierIO() }, store.get(JOB_ID)!, { ...project, hostPath: dir }, policy));
    expect(code).toBe('APPLY_UNSUPPORTED_OPERATION');
    expect(existsSync(join(dir, 'link.txt'))).toBe(false);
    await removeVolume(evidenceVol, true).catch(() => {});
  }, 90_000);

  // F5: ADD no-clobber — script refuses rename over existing target.
  it('F5 ADD no-clobber: script refuses to overwrite a concurrently-created file at the ADD target', async () => {
    const { dir, head } = makeCleanFixture();
    fixtures.push(dir);
    const newContent = Buffer.from('brand new\n');
    const newHash = createHash('sha256').update(newContent).digest('hex');
    writeFileSync(join(dir, 'src', 'new-file.txt'), 'competing content\n');
    const attemptId = 'att_' + randomBytes(16).toString('hex');
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await createVolume(evidenceVol, ownershipLabels('evidence', JOB_ID));
    const { id, controlVolume } = await createApplier(attemptId, dir, evidenceVol);
    try {
      await startContainer(id);
      const applier = createDockerApplierIO();
      const ctrl = { mode: 'apply', opIndex: 0, op: { path: 'src/new-file.txt', op: 'ADD', postHash: newHash, postSize: newContent.length, postMode: 0o644 } };
      await applier.putArchive(id, CONTROL_PATH, await packControl(ctrl));
      const res = await applier.exec(id, ['node', '-e', APPLY_MUTATION_SCRIPT]);
      expect(res.exitCode).not.toBe(0);
      const line = JSON.parse(res.stdout.trim().split('\n').pop()!);
      expect(line.ok).toBe(false);
      expect(line.error).toMatch(/unexpectedly exists|appeared between/i);
      expect(readFileSync(join(dir, 'src', 'new-file.txt'), 'utf8')).toBe('competing content\n');
    } finally {
      await removeContainer(id, true).catch(() => {});
      await removeVolume(evidenceVol, true).catch(() => {});
      await removeVolume(controlVolume, true).catch(() => {});
    }
  }, 90_000);

  // Later-operation in-flight ambiguity: op 0 runs to completion for real and
  // is durably journaled; op 1's mutation syscall genuinely lands on the real
  // host bind, but its completion line is synchronously blocked (real
  // Atomics.wait inside the container process — never an unresolved Promise,
  // never a sleep) from ever reaching the executor, before the container is
  // killed. This proves ambiguity attaches to the CURRENT (later) op, not to
  // an already-journaled earlier op.
  it('later-operation in-flight ambiguity: op 0 journaled for real, op 1 mutates but completion is synchronously blocked -> UNCERTAIN + QUARANTINED, journal=[op0] only, subsequent apply refused', async () => {
    const { dir, head } = makeCleanFixture();
    fixtures.push(dir);
    const before: FileSpec[] = [
      { path: 'src/delete.txt', kind: 'file', mode: 0o644, content: Buffer.from('to be deleted\n') },
      { path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('old content\n') },
    ];
    const after: FileSpec[] = [
      { path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('new content\n') },
    ];
    // Canonical sort order: 'src/delete.txt' < 'src/modify.txt' -> op0=DELETE, op1=CONTENT_MODIFY.
    const artifact = buildArtifact(project.id, head, before, after);
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await pushArtifactToVolume(evidenceVol, artifact);
    const store = new AgentJobStore(':memory:');
    store.insert({ jobId: JOB_ID, principalId: 'client-a', backend: 'kiro', project: project.id, profile: 'implement', resourcePolicy: 'economy', promptHash: 'h'.repeat(64), prompt: 'test', sessionPolicy: 'new', writer: true, retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral });
    store.transition(JOB_ID, 'QUEUED', 'PREPARING'); store.transition(JOB_ID, 'PREPARING', 'RUNNING');
    store.transition(JOB_ID, 'RUNNING', 'VALIDATING'); store.setBaseCommit(JOB_ID, head);
    store.publishArtifact(JOB_ID, { artifactHash: artifact.artifactHash, changeSetHash: artifact.manifest.changeSetHash, contentComplete: true, applicable: true, reason: null, artifactVolume: evidenceVol, artifactBytes: artifact.manifest.artifactBytes, opCount: artifact.manifest.opCount });
    store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');

    const realIO = createDockerApplierIO();
    let mutCount = 0;
    let capturedContainerId: string | undefined;
    const sentinelName = `sentinel-op1-${randomBytes(6).toString('hex')}`;

    const wrappedIO: typeof realIO = Object.assign(Object.create(Object.getPrototypeOf(realIO)), realIO, {
      async createContainer(name: string, body: Record<string, unknown>) {
        const id = await realIO.createContainer(name, body);
        capturedContainerId = id;
        return id;
      },
      async exec(cid: string, cmd: string[]) {
        if (cmd[2] === APPLY_MUTATION_SCRIPT) {
          mutCount++;
          if (mutCount === 1) {
            // Op 0 (DELETE) — the REAL production script, entirely unintercepted.
            return realIO.exec(cid, cmd);
          }
          if (mutCount === 2) {
            // Op 0's journal row must already be durably observable BEFORE we
            // create op 1's ambiguity.
            const attemptIdNow = store.listApplyAttemptsForJob(JOB_ID)[0]!.attemptId;
            const journalBefore = store.listApplyJournalForAttempt(attemptIdNow);
            expect(journalBefore).toHaveLength(1);
            expect(journalBefore[0]!.path).toBe('src/delete.txt');
            expect(existsSync(join(dir, 'src', 'delete.txt'))).toBe(false);

            // Wrap the REAL production mutation script. The interception point
            // is process.stdout.write, and it fires ONLY when the production
            // success completion line is attempted — i.e. strictly AFTER the
            // real filesystem mutation already happened (APPLY_MUTATION_SCRIPT
            // always mutates before it emits). Once triggered, this blocks
            // SYNCHRONOUSLY via Atomics.wait (bounded, never an unresolved
            // Promise, never an arbitrary sleep) so the container process
            // cannot reach process.exit(0) until the test kills the container.
            const wrapperScript = [
              'const sab=new SharedArrayBuffer(4);',
              'const ia=new Int32Array(sab);',
              'const origWrite=process.stdout.write.bind(process.stdout);',
              'let intercepted=false;',
              'process.stdout.write=function(chunk,...args){',
              '  const str=chunk.toString();',
              '  if(!intercepted && str.indexOf(\'"ok":true\')!==-1){',
              '    intercepted=true;',
              `    require('fs').writeFileSync('${CONTROL_PATH}/${sentinelName}','done',{mode:0o600});`,
              '    Atomics.wait(ia,0,0,60000);',
              '    return true;',
              '  }',
              '  return origWrite(chunk,...args);',
              '};',
              APPLY_MUTATION_SCRIPT,
            ].join('\n');

            const execPromise = realIO.exec(cid, ['node', '-e', wrapperScript]);

            // Wait deterministically for the sentinel (poll on the actual
            // condition, not a fixed sleep) — its existence proves the
            // intercepted write, and therefore op 1's real filesystem
            // mutation preceding it, has already happened in the container.
            const sentinelInContainer = `${CONTROL_PATH}/${sentinelName}`;
            let sentinelFound = false;
            for (let i = 0; i < 100; i++) {
              try {
                const { getArchive } = await import('../../src/executor/docker.js');
                await getArchive(cid, sentinelInContainer);
                sentinelFound = true;
                break;
              } catch {
                await new Promise((r) => setTimeout(r, 100));
              }
            }
            if (!sentinelFound) throw new Error('op 1 sentinel never appeared — mutation exec may not have run');

            // Independently verify op 1's filesystem mutation is visible on
            // the real host bind (dir is bind-mounted RW into the container).
            expect(readFileSync(join(dir, 'src', 'modify.txt'), 'utf8')).toBe('new content\n');

            // Journal still contains EXACTLY op 0 — op 1's completion never
            // reached the executor, so it was never journaled.
            const journalAfter = store.listApplyJournalForAttempt(attemptIdNow);
            expect(journalAfter).toHaveLength(1);
            expect(journalAfter[0]!.path).toBe('src/delete.txt');

            // Kill/remove the applier container. Op 1's completion can now
            // never reach the executor.
            if (capturedContainerId) await removeContainer(capturedContainerId, true).catch(() => {});
            try { await execPromise; } catch { /* expected: container killed mid-exec */ }

            throw new Error('applier container killed after op 1 mutation landed but before its completion reached the executor (test)');
          }
        }
        return realIO.exec(cid, cmd);
      },
    });

    const evFactory = () => ({ async readFile(rel: string) { const b = artifact.manifestFiles.get(rel) ?? artifact.blobs.get(rel); if (!b) throw new Error(`not found: ${rel}`); return b; } });
    const code = await expectBridgeCode(runApplyAttempt({ store, evidenceReaderFactory: evFactory, applierImage: IMAGE, applierIO: wrappedIO }, store.get(JOB_ID)!, { ...project, hostPath: dir }, policy));

    expect(code).toBe('APPLY_ROLLBACK_FAILED');
    const attempt = store.listApplyAttemptsForJob(JOB_ID)[0]!;
    expect(attempt.state).toBe('UNCERTAIN');
    expect(attempt.state).not.toBe('FAILED_ROLLED_BACK');
    expect(store.getProjectApplyState(project.id)?.state).toBe('QUARANTINED');

    const finalJournal = store.listApplyJournalForAttempt(attempt.attemptId);
    expect(finalJournal).toHaveLength(1);
    expect(finalJournal[0]!.path).toBe('src/delete.txt');

    // Op 1's mutation remains, unreconciled: it landed on disk but was never
    // journaled/verified — exactly the "ambiguous" outcome under test.
    expect(readFileSync(join(dir, 'src', 'modify.txt'), 'utf8')).toBe('new content\n');

    // A subsequent apply attempt against the now-quarantined project is refused
    // (fail closed, before any container is even created).
    const secondCode = await expectBridgeCode(runApplyAttempt(
      { store, evidenceReaderFactory: evFactory, applierImage: IMAGE, applierIO: createDockerApplierIO() },
      store.get(JOB_ID)!,
      { ...project, hostPath: dir },
      policy,
    ));
    expect(secondCode).toBe('PROJECT_QUARANTINED');

    await removeVolume(evidenceVol, true).catch(() => {});
  }, 120_000);

  // F3: ADD rollback interference — real Docker.
  it('F3 ADD rollback interference: externally-replaced ADD target causes UNCERTAIN, replacement preserved', async () => {
    const { dir, head } = makeCleanFixture();
    fixtures.push(dir);
    const newContent = Buffer.from('brand new\n');
    // Use 'src/aaa-new.txt' — sorts before 'src/modify.txt' — so ADD runs as op 0,
    // gets journaled, then CONTENT_MODIFY on modify.txt (which we'll force to fail)
    // triggers rollback of the ADD. The external replacement happens between
    // ADD landing and rollback running.
    const before: FileSpec[] = [
      { path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('old content\n') },
    ];
    const after: FileSpec[] = [
      { path: 'src/aaa-new.txt', kind: 'file', mode: 0o644, content: newContent },
      { path: 'src/modify.txt', kind: 'file', mode: 0o644, content: Buffer.from('new content\n') },
    ];
    const artifact = buildArtifact(project.id, head, before, after);
    const evidenceVol = `b5-ev-${randomBytes(6).toString('hex')}`;
    await pushArtifactToVolume(evidenceVol, artifact);
    const store = new AgentJobStore(':memory:');
    store.insert({ jobId: JOB_ID, principalId: 'client-a', backend: 'kiro', project: project.id, profile: 'implement', resourcePolicy: 'economy', promptHash: 'h'.repeat(64), prompt: 'test', sessionPolicy: 'new', writer: true, retentionClass: 'ephemeral', retentionDurationMs: AGENT_RETENTION_DURATION_MS.ephemeral });
    store.transition(JOB_ID, 'QUEUED', 'PREPARING'); store.transition(JOB_ID, 'PREPARING', 'RUNNING');
    store.transition(JOB_ID, 'RUNNING', 'VALIDATING'); store.setBaseCommit(JOB_ID, head);
    store.publishArtifact(JOB_ID, { artifactHash: artifact.artifactHash, changeSetHash: artifact.manifest.changeSetHash, contentComplete: true, applicable: true, reason: null, artifactVolume: evidenceVol, artifactBytes: artifact.manifest.artifactBytes, opCount: artifact.manifest.opCount });
    store.transition(JOB_ID, 'VALIDATING', 'COMPLETED');
    const realIO = createDockerApplierIO();
    let forwardMutCount = 0;
    let capturedContainerId: string | undefined;
    const wrappedIO: typeof realIO = Object.assign(Object.create(Object.getPrototypeOf(realIO)), realIO, {
      async createContainer(name: string, body: Record<string, unknown>) {
        const id = await realIO.createContainer(name, body);
        capturedContainerId = id;
        return id;
      },
      async putArchive(cid: string, absDir: string, tarBuffer: Buffer) {
        await realIO.putArchive(cid, absDir, tarBuffer);
        // Check if this is an apply-mode control file
        const text = tarBuffer.toString('utf8');
        if (text.includes('"mode":"apply"')) {
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          const control = JSON.parse(text.slice(start, end + 1));
          if (control.mode === 'apply' && control.opIndex === 0) {
            // This is op 0 (ADD) control file uploaded - mark it
            forwardMutCount = 1;
          }
        }
      },
      async exec(cid: string, cmd: string[]) {
        if (cmd[2] === APPLY_MUTATION_SCRIPT) {
          if (forwardMutCount === 1) {
            // Op 0 (ADD) — let it run normally
            const res = await realIO.exec(cid, cmd);
            // After successful ADD, use Docker exec to replace the file as root
            if (res.exitCode === 0 && capturedContainerId) {
              const replaceScript = [
                `const fs=require("fs");`,
                `const path=require("path");`,
                `const target=path.join("${PROJECT_PATH}","src/aaa-new.txt");`,
                `fs.writeFileSync(target,"REPLACED BY EXTERNAL\\n",{mode:0o644});`,
              ].join('');
              await realIO.exec(capturedContainerId, ['node', '-e', replaceScript]);
            }
            forwardMutCount = 2;
            return res;
          } else if (forwardMutCount === 2) {
            // Op 1 — force failure to trigger rollback
            forwardMutCount = 3;
            return { stdout: JSON.stringify({ opIndex: 1, ok: false, error: 'forced test failure to trigger rollback' }) + '\n', stderr: '', exitCode: 1 };
          }
          // Rollback phase — let it run normally (it will detect the replacement and fail cleanly)
        }
        return realIO.exec(cid, cmd);
      },
    });
    const evFactory = () => ({ async readFile(rel: string) { const b = artifact.manifestFiles.get(rel) ?? artifact.blobs.get(rel); if (!b) throw new Error(`not found: ${rel}`); return b; } });
    const code = await expectBridgeCode(runApplyAttempt({ store, evidenceReaderFactory: evFactory, applierImage: IMAGE, applierIO: wrappedIO }, store.get(JOB_ID)!, { ...project, hostPath: dir }, policy));
    expect(code).toBe('APPLY_ROLLBACK_FAILED');
    expect(store.listApplyAttemptsForJob(JOB_ID)[0]!.state).toBe('UNCERTAIN');
    expect(store.getProjectApplyState(project.id)?.state).toBe('QUARANTINED');
    expect(readFileSync(join(dir, 'src', 'aaa-new.txt'), 'utf8')).toBe('REPLACED BY EXTERNAL\n');
    await removeVolume(evidenceVol, true).catch(() => {});
  }, 120_000);
});
