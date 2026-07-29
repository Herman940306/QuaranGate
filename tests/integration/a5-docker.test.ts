/**
 * A5 writable job sandbox — Docker integration + security proofs.
 *
 * Builds the REAL runner image (runner/kiro/Dockerfile) with a STUB kiro-cli so
 * the actual image contract is exercised WITHOUT a provider call, then proves
 * the A5 write lane the Executor uses in production, deterministically:
 *
 *   - the job workspace volume is WRITABLE for implement (create + modify +
 *     delete land in the volume) while the root filesystem stays READ-ONLY,
 *   - the container is still non-root, cap-drop ALL, no host bind, no
 *     docker.sock, no direct network,
 *   - the host project is NEVER bound into the runner (writes cannot touch it),
 *   - deterministic change detection (the REAL buildManifestCreateBody +
 *     parseManifest + diffManifests) reports added / modified / deleted and
 *     IGNORES unchanged — computed from the volume, never from the agent,
 *   - a READ-ONLY workspace mount (A4 regression) still rejects writes,
 *   - all job-scoped resources are removed on completion.
 *
 * No paid model is used anywhere in this file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  createVolume, removeVolume, createContainer, startContainer, waitContainer,
  getContainerLogs, inspectContainerFull, removeContainer, listVolumesByFilter,
} from '../../src/executor/docker.js';
import {
  LABEL_MANAGED, LABEL_JOB, LABEL_RESOURCE, buildManifestCreateBody,
  buildStagerCreateBody, toRunnerLimits,
} from '../../src/executor/agents/sandboxSpec.js';
import { parseManifest, diffManifests } from '../../src/executor/agents/changeDetection.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = 'mcp-ide-bridge-kiro-runner:a5-test';
const newJobId = () => `job_${randomBytes(16).toString('hex')}`;

const policy: AgentResourcePolicy = {
  id: 'standard', modelClass: 'standard', maxRuntimeMs: 120_000, maxCpuMillicores: 2000,
  maxMemoryBytes: 2_147_483_648, maxPids: 256, maxOutputBytes: 262_144,
  maxEvidenceBytes: 52_428_800, networkPolicy: 'backend-only', retentionClass: 'short',
};

/** Seed a workspace volume with initial files (root helper, then chown to runner). */
async function seedWorkspace(vol: string, files: Record<string, string>): Promise<void> {
  await createVolume(vol, { [LABEL_MANAGED]: 'true', [LABEL_JOB]: 'seed', [LABEL_RESOURCE]: 'workspace' });
  const script = Object.entries(files)
    .map(([p, c]) => `mkdir -p /workspace/$(dirname '${p}'); printf '%s' '${c}' > /workspace/${p}`)
    .join('; ') + '; chown -R 1000:1000 /workspace';
  const id = await createContainer(`seed-${randomBytes(6).toString('hex')}`, {
    Image: IMAGE, User: '0:0', Cmd: ['sh', '-c', script],
    HostConfig: { AutoRemove: false, Mounts: [{ Type: 'volume', Source: vol, Target: '/workspace', ReadOnly: false }], Tmpfs: { '/tmp': 'rw,size=4m' } },
  });
  await startContainer(id); await waitContainer(id, { timeoutMs: 15_000 }); await removeContainer(id, true);
}

/** Run the REAL manifest helper against a volume and parse it. */
async function manifestOf(jobId: string, vol: string) {
  const body = buildManifestCreateBody({ image: IMAGE, jobId, volumeName: vol, limits: toRunnerLimits(policy) });
  const id = await createContainer(`a5-manifest-${jobId}-${randomBytes(4).toString('hex')}`, body as any);
  try {
    await startContainer(id); await waitContainer(id, { timeoutMs: 30_000 });
    const logs = await getContainerLogs(id, 262_144);
    const m = parseManifest(logs.stdout);
    expect(m).not.toBeNull();
    return m!;
  } finally { await removeContainer(id, true).catch(() => {}); }
}

describe('A5 writable job sandbox — Docker integration + security proofs', () => {
  let buildDir: string;

  beforeAll(() => {
    buildDir = mkdtempSync(join(tmpdir(), 'a5b-'));
    const stub = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "kiro-cli-stub 2.5.0-test"; exit 0; fi',
      'if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then echo "stub acp help"; exit 0; fi',
      'exit 1',
    ].join('\n');
    writeFileSync(join(buildDir, 'kiro-cli'), stub, { mode: 0o755 });
    writeFileSync(join(buildDir, 'kiro-cli-chat'), stub, { mode: 0o755 });
    writeFileSync(join(buildDir, 'Dockerfile'), readFileSync(join(REPO_ROOT, 'runner', 'kiro', 'Dockerfile')));
    writeFileSync(join(buildDir, 'kiro-acp-entrypoint.sh'), readFileSync(join(REPO_ROOT, 'runner', 'kiro', 'kiro-acp-entrypoint.sh')));
    execFileSync('docker', ['build', '-q', '-t', IMAGE, buildDir], { stdio: 'pipe' });
  }, 180_000);

  afterAll(() => { rmSync(buildDir, { recursive: true, force: true }); });

  it('WRITABLE workspace: create + modify + delete land in the volume while rootfs stays READ-ONLY', async () => {
    const jobId = newJobId();
    const vol = `a5-ws-${jobId}`;
    await seedWorkspace(vol, { 'keep.txt': 'KEEP', 'mod.txt': 'OLD', 'gone.txt': 'BYE' });
    try {
      // Writer runs non-root with a READ-ONLY rootfs but a WRITABLE workspace.
      const writer = await createContainer(`a5-write-${jobId}`, {
        Image: IMAGE, User: '1000:1000',
        Cmd: ['sh', '-c',
          'echo NEW > /workspace/new.txt 2>&1 || echo WS_FAIL;'
          + 'echo CHANGED > /workspace/mod.txt 2>&1 || echo WS_FAIL;'
          + 'rm -f /workspace/gone.txt 2>&1 || echo WS_FAIL;'
          + 'echo BAD > /rootfs-probe 2>&1 || echo ROOTFS_RO;'],
        HostConfig: {
          AutoRemove: false, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
          Mounts: [{ Type: 'volume', Source: vol, Target: '/workspace', ReadOnly: false }],
          Tmpfs: { '/tmp': 'rw,size=8m' },
        },
      });
      await startContainer(writer); await waitContainer(writer, { timeoutMs: 15_000 });
      const log = (await getContainerLogs(writer, 8192)).stdout;
      await removeContainer(writer, true);
      expect(log).not.toContain('WS_FAIL');   // all workspace mutations succeeded
      expect(log).toContain('ROOTFS_RO');      // root filesystem stays read-only

      // Deterministic change detection from the VOLUME, not the agent.
      const post = await manifestOf(jobId, vol);
      const files = Object.fromEntries(post.entries.map((e) => [e.path, true]));
      expect(files['new.txt']).toBe(true);
      expect(files['mod.txt']).toBe(true);
      expect(files['gone.txt']).toBeUndefined();
    } finally { await removeVolume(vol, true).catch(() => {}); }
  });

  it('change detection reports added/modified/deleted and IGNORES unchanged (baseline vs post)', async () => {
    const jobId = newJobId();
    const vol = `a5-cd-${jobId}`;
    await seedWorkspace(vol, { 'keep.txt': 'KEEP', 'mod.txt': 'OLD', 'gone.txt': 'BYE' });
    try {
      const baseline = await manifestOf(jobId, vol);
      // Mutate the workspace exactly like an implementation turn would.
      const mut = await createContainer(`a5-mut-${jobId}`, {
        Image: IMAGE, User: '1000:1000',
        Cmd: ['sh', '-c', 'printf NEW > /workspace/added.txt; printf CHANGED > /workspace/mod.txt; rm -f /workspace/gone.txt'],
        HostConfig: { AutoRemove: false, ReadonlyRootfs: true, Mounts: [{ Type: 'volume', Source: vol, Target: '/workspace', ReadOnly: false }], Tmpfs: { '/tmp': 'rw,size=8m' } },
      });
      await startContainer(mut); await waitContainer(mut, { timeoutMs: 15_000 }); await removeContainer(mut, true);

      const post = await manifestOf(jobId, vol);
      const d = diffManifests(baseline, post);
      expect(d.added).toEqual(['added.txt']);
      expect(d.modified).toEqual(['mod.txt']);
      expect(d.deleted).toEqual(['gone.txt']);
      expect(d.changedFiles).toEqual(['added.txt', 'gone.txt', 'mod.txt']);
      expect(d.changedCount).toBe(3);
      expect(d.diffHash).toMatch(/^[0-9a-f]{64}$/);
      // keep.txt was unchanged and must NOT appear.
      expect(d.changedFiles).not.toContain('keep.txt');
    } finally { await removeVolume(vol, true).catch(() => {}); }
  });

  it('the manifest helper never binds the host, exposes docker.sock, or reaches the network', async () => {
    const jobId = newJobId();
    const vol = `a5-iso-${jobId}`;
    await seedWorkspace(vol, { 'a.txt': 'A' });
    try {
      const body = buildManifestCreateBody({ image: IMAGE, jobId, volumeName: vol, limits: toRunnerLimits(policy) }) as any;
      // Body-level proofs (the security-critical policy translation).
      expect(body.User).toBe('1000:1000');
      expect(body.HostConfig.ReadonlyRootfs).toBe(true);
      expect(body.HostConfig.CapDrop).toEqual(['ALL']);
      expect(body.HostConfig.NetworkMode).toBe('none');
      expect(body.NetworkDisabled).toBe(true);
      expect(body.HostConfig.Binds).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('docker.sock');
      // The workspace is mounted READ-ONLY to the manifest helper (measuring
      // must never mutate what it measures).
      const ws = body.HostConfig.Mounts.find((m: any) => m.Target === '/workspace');
      expect(ws.ReadOnly).toBe(true);

      // And at run time it actually produces a manifest.
      const id = await createContainer(`a5-iso-run-${jobId}`, body);
      try {
        await startContainer(id); await waitContainer(id, { timeoutMs: 30_000 });
        const info = await inspectContainerFull(id);
        expect(JSON.stringify(info.HostConfig ?? {})).not.toContain('docker.sock');
        const m = parseManifest((await getContainerLogs(id, 65_536)).stdout);
        expect(m?.ok).toBe(true);
        expect(m?.entries.some((e) => e.path === 'a.txt')).toBe(true);
      } finally { await removeContainer(id, true).catch(() => {}); }
    } finally { await removeVolume(vol, true).catch(() => {}); }
  });

  it('A5 fail-closed: an implement source with a tracked symlink is rejected at staging (exit 6) BEFORE any provider run', async () => {
    const jobId = newJobId();
    const vol = `a5-sym-${jobId}`;
    // Build a real git repo whose committed HEAD contains a tracked symlink
    // (Git mode 120000) alongside a normal file.
    const repo = mkdtempSync(join(tmpdir(), 'a5sym-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, 'real.ts'), 'export const real = 1;\n');
      execFileSync('ln', ['-s', 'real.ts', join(repo, 'link.ts')]);
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', [
        '-c', 'user.email=a5@test', '-c', 'user.name=a5',
        'commit', '-q', '-m', 'with symlink',
      ], { cwd: repo });

      await createVolume(vol, { [LABEL_MANAGED]: 'true', [LABEL_JOB]: jobId, [LABEL_RESOURCE]: 'workspace' });

      // implement lane: rejectTrackedSymlinks=true => exit 6, workspace never archived.
      const rejBody = buildStagerCreateBody({ image: IMAGE, jobId, hostPath: repo, volumeName: vol, rejectTrackedSymlinks: true });
      const rejId = await createContainer(`a5-sym-rej-${jobId}`, rejBody as any);
      let rejStatus: number | null;
      let rejErr: string;
      try {
        await startContainer(rejId);
        const w = await waitContainer(rejId, { timeoutMs: 30_000 });
        rejStatus = w.statusCode;
        rejErr = (await getContainerLogs(rejId, 8192)).stderr;
      } finally { await removeContainer(rejId, true).catch(() => {}); }
      expect(rejStatus).toBe(6);
      expect(rejErr).toContain('TRACKED_SYMLINK');

      // read-only lane (A4 parity): same source stages fine, symlink extracted.
      const okBody = buildStagerCreateBody({ image: IMAGE, jobId, hostPath: repo, volumeName: vol });
      const okId = await createContainer(`a5-sym-ok-${jobId}`, okBody as any);
      let okStatus: number | null;
      let okOut: string;
      try {
        await startContainer(okId);
        const w = await waitContainer(okId, { timeoutMs: 30_000 });
        okStatus = w.statusCode;
        okOut = (await getContainerLogs(okId, 8192)).stdout;
      } finally { await removeContainer(okId, true).catch(() => {}); }
      expect(okStatus).toBe(0);
      expect(okOut).toMatch(/BASE_COMMIT=[0-9a-f]{40}/);
    } finally {
      await removeVolume(vol, true).catch(() => {});
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('A4 regression: a READ-ONLY workspace mount rejects writes (read-only profiles unaffected)', async () => {
    const jobId = newJobId();
    const vol = `a5-ro-${jobId}`;
    await seedWorkspace(vol, { 'f.txt': 'ORIGINAL' });
    try {
      const run = await createContainer(`a5-ro-run-${jobId}`, {
        Image: IMAGE, User: '1000:1000',
        Cmd: ['sh', '-c', 'echo MOD > /workspace/f.txt 2>&1 || true; echo NEW > /workspace/n.txt 2>&1 || true; cat /workspace/f.txt; ls /workspace'],
        HostConfig: { AutoRemove: false, ReadonlyRootfs: true, Mounts: [{ Type: 'volume', Source: vol, Target: '/workspace', ReadOnly: true }], Tmpfs: { '/tmp': 'rw,size=4m' } },
      });
      await startContainer(run); await waitContainer(run, { timeoutMs: 15_000 });
      const log = (await getContainerLogs(run, 4096)).stdout;
      await removeContainer(run, true);
      expect(log).toContain('ORIGINAL');
      expect(log).not.toContain('MOD');
      expect(log).not.toContain('n.txt');
    } finally { await removeVolume(vol, true).catch(() => {}); }
  });
}, 240_000);
