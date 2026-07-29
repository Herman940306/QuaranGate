/**
 * A5 production path — runner-internal ACP driver with a WRITABLE workspace,
 * driven purely through the Docker Engine API (create → start → wait → logs),
 * NO `docker` CLI, NO interactive attach, NO host bind, NO paid provider call.
 *
 * This exercises the exact production mechanism for an IMPLEMENT job:
 *   - the driver bundle (runnerMain + the SAME AcpDriver + its dep) and a
 *     trusted control.json with the implement trust-tools (read,grep,glob —
 *     write is path-scoped via toolsSettings, never globally trusted) are
 *     delivered on a READ-ONLY control volume,
 *   - `node runnerMain.js` runs in the hardened runner with the workspace
 *     mounted WRITABLE and drives ACP over a child's stdio to a delivered
 *     deterministic mock that writes files IN-PROCESS (the correct write path —
 *     Kiro's fsWrite operates directly, no server->client fs/* delegation),
 *   - the single __ACP_RESULT__ line is parsed by the real parseRunnerResult(),
 *   - deterministic change detection (the real buildManifestCreateBody +
 *     parseManifest + diffManifests) reports what changed in the volume,
 *   - the host project is never bound and no APPLY occurs (COMPLETED != APPLIED).
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
  getContainerLogs, inspectContainerFull, removeContainer,
} from '../../src/executor/docker.js';
import {
  LABEL_MANAGED, LABEL_JOB, LABEL_RESOURCE, buildManifestCreateBody, toRunnerLimits,
} from '../../src/executor/agents/sandboxSpec.js';
import { buildTar, populateVolume } from '../../src/executor/agents/runnerAssets.js';
import { parseRunnerResult, bridgeAgentConfig } from '../../src/executor/agents/kiroBackend.js';
import { parseManifest, diffManifests } from '../../src/executor/agents/changeDetection.js';
import { ACP_IMPL_AGENT_NAME_PATTERN, resolveProfileCapability } from '../../src/executor/agents/acpDriver.js';
import { canTransitionAgentJob } from '../../src/shared/agents.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO_ROOT, 'dist');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures');
const IMAGE = 'mcp-ide-bridge-kiro-runner:a5-prodtest';
const newJobId = () => `job_${randomBytes(16).toString('hex')}`;

const policy: AgentResourcePolicy = {
  id: 'standard', modelClass: 'standard', maxRuntimeMs: 120_000, maxCpuMillicores: 2000,
  maxMemoryBytes: 2_147_483_648, maxPids: 256, maxOutputBytes: 262_144,
  maxEvidenceBytes: 52_428_800, networkPolicy: 'backend-only', retentionClass: 'short',
};

async function seedWorkspace(vol: string, files: Record<string, string>): Promise<void> {
  await createVolume(vol, { [LABEL_MANAGED]: 'true', [LABEL_JOB]: 'seed', [LABEL_RESOURCE]: 'workspace' });
  const script = Object.entries(files)
    .map(([p, c]) => `printf '%s' '${c}' > /workspace/${p}`)
    .join('; ') + '; chown -R 1000:1000 /workspace';
  const id = await createContainer(`seed-${randomBytes(6).toString('hex')}`, {
    Image: IMAGE, User: '0:0', Cmd: ['sh', '-c', script],
    HostConfig: { AutoRemove: false, Mounts: [{ Type: 'volume', Source: vol, Target: '/workspace', ReadOnly: false }], Tmpfs: { '/tmp': 'rw,size=4m' } },
  });
  await startContainer(id); await waitContainer(id, { timeoutMs: 15_000 }); await removeContainer(id, true);
}

async function makeControlVolume(jobId: string, control: Record<string, unknown>): Promise<string> {
  const vol = `io-mcp-ide-bridge-control-${jobId}`;
  const tar = await buildTar({
    dirs: [{ name: 'executor/' }, { name: 'executor/agents/' }, { name: 'shared/' }],
    files: [
      { name: 'executor/agents/runnerMain.js', content: readFileSync(join(DIST, 'executor/agents/runnerMain.js')), mode: 0o500 },
      { name: 'executor/agents/acpDriver.js', content: readFileSync(join(DIST, 'executor/agents/acpDriver.js')), mode: 0o500 },
      { name: 'shared/errors.js', content: readFileSync(join(DIST, 'shared/errors.js')), mode: 0o500 },
      { name: 'mock-acp-impl-server.mjs', content: readFileSync(join(FIXTURES, 'mock-acp-impl-server.mjs')), mode: 0o500 },
      { name: 'control.json', content: Buffer.from(JSON.stringify(control), 'utf8'), mode: 0o400 },
    ],
  });
  await populateVolume({
    volumeName: vol,
    labels: { [LABEL_MANAGED]: 'true', [LABEL_JOB]: jobId, [LABEL_RESOURCE]: 'control' },
    helperImage: IMAGE, mountPath: '/run/control', tar,
  });
  return vol;
}

async function manifestOf(jobId: string, vol: string) {
  const body = buildManifestCreateBody({ image: IMAGE, jobId, volumeName: vol, limits: toRunnerLimits(policy) });
  const id = await createContainer(`a5p-manifest-${jobId}-${randomBytes(4).toString('hex')}`, body as any);
  try {
    await startContainer(id); await waitContainer(id, { timeoutMs: 30_000 });
    const m = parseManifest((await getContainerLogs(id, 262_144)).stdout);
    expect(m).not.toBeNull();
    return m!;
  } finally { await removeContainer(id, true).catch(() => {}); }
}

describe('A5 production path — implement write turn via Docker Engine API', () => {
  let buildDir: string;

  beforeAll(() => {
    buildDir = mkdtempSync(join(tmpdir(), 'a5pb-'));
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

  const implControl = (jobId: string) => ({
    agent: 'mcp_impl_' + randomBytes(16).toString('hex'),
    model: 'claude-sonnet-4.5',
    trustTools: resolveProfileCapability('implement').trustTools, // read,grep,glob (write is path-scoped)
    cwd: '/workspace',
    prompt: 'IMPLEMENT the feature',
    dryRun: false,
    acpCommand: 'node',
    acpPrefixArgs: ['/run/control/mock-acp-impl-server.mjs'],
    // No clientFsRoot / clientFsWrite — Kiro writes IN-PROCESS via fsWrite.
  });

  it('drives an implement turn that writes files in a WRITABLE workspace; change detection is deterministic; no host bind; no apply', async () => {
    const jobId = newJobId();
    const wsVol = `io-mcp-ide-bridge-ws-${jobId}`;
    await seedWorkspace(wsVol, { 'target.ts': 'export const target = 1;\n', 'keep.ts': 'export const keep = true;\n' });
    const baseline = await manifestOf(jobId, wsVol);
    const ctlVol = await makeControlVolume(jobId, implControl(jobId));
    const runner = await createContainer(`a5prod-${jobId}`, {
      Image: IMAGE, User: '1000:1000',
      Cmd: ['node', '/run/control/executor/agents/runnerMain.js', '/run/control/control.json'],
      HostConfig: {
        AutoRemove: false, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        Mounts: [
          // A5 core: workspace WRITABLE; control READ-ONLY. No host bind anywhere.
          { Type: 'volume', Source: wsVol, Target: '/workspace', ReadOnly: false },
          { Type: 'volume', Source: ctlVol, Target: '/run/control', ReadOnly: true },
        ],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
      },
    });
    try {
      await startContainer(runner);
      const waited = await waitContainer(runner, { timeoutMs: 30_000 });
      const logs = await getContainerLogs(runner, 262_144);

      // Result-line proofs (production mechanism).
      const r = parseRunnerResult(logs.stdout);
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(true);
      expect(r!.stopReason).toBe('end_turn');
      // The mock emits read + edit tool_call updates — both kinds present.
      expect(r!.toolCalls.map((t) => t.kind).sort()).toEqual(['edit', 'read']);
      expect(waited.statusCode).toBe(0);

      // Host-bind proof: the runner's HostConfig has ONLY volume mounts.
      const info = await inspectContainerFull(runner);
      const binds = (info.HostConfig as any)?.Binds ?? [];
      expect(binds).toEqual([]);
      expect(JSON.stringify(info.HostConfig ?? {})).not.toContain('docker.sock');
      expect(JSON.stringify(info.HostConfig ?? {})).not.toContain(REPO_ROOT);

      // Deterministic change detection from the volume.
      const post = await manifestOf(jobId, wsVol);
      const d = diffManifests(baseline, post);
      expect(d.added).toContain('generated.ts');
      expect(d.modified).toContain('target.ts');
      expect(d.changedFiles).not.toContain('keep.ts'); // unchanged ignored
      expect(d.changedCount).toBeGreaterThanOrEqual(2);

      // No apply: COMPLETED is reachable, but APPLY is never automatic.
      expect(canTransitionAgentJob('VALIDATING', 'COMPLETED')).toBe(true);
      expect(canTransitionAgentJob('VALIDATING', 'APPLIED')).toBe(false);
      expect(canTransitionAgentJob('COMPLETED', 'APPLIED')).toBe(true); // A6-owned, explicit only
    } finally {
      await removeContainer(runner, true).catch(() => {});
      await removeVolume(ctlVol, true).catch(() => {});
      await removeVolume(wsVol, true).catch(() => {});
    }
  });

  it('the delivered implement agent config uses canonical `write`: available in tools, path-scoped, NOT in allowedTools', () => {
    const cfg = bridgeAgentConfig('mcp_impl_' + 'a'.repeat(32), { write: true });
    // tools available to agent (canonical write name)
    expect(cfg.tools).toEqual(['read', 'grep', 'glob', 'write']);
    // allowedTools pre-approves ONLY read-only tools; write is path-scoped, so
    // it must NOT appear here (allowedTools would override toolsSettings).
    expect(cfg.allowedTools).toEqual(['read', 'grep', 'glob']);
    for (const alias of ['write', 'fsWrite', 'fs_write']) {
      expect(cfg.allowedTools as string[]).not.toContain(alias);
    }
    // toolsSettings confines write to /workspace and denies non-workspace paths
    expect((cfg.toolsSettings as any)?.write?.allowedPaths).toEqual(['/workspace']);
    expect((cfg.toolsSettings as any)?.write?.deniedPaths).toEqual(['/home/runner', '/tmp', '/run/secrets', '/run/control']);
    // No MCP, no hooks, no wildcards
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.includeMcpJson).toBe(false);
    expect(ACP_IMPL_AGENT_NAME_PATTERN.test(String(cfg.name))).toBe(true);
  });
}, 240_000);
