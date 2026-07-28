/**
 * A4 production execution path — deterministic Docker integration.
 *
 * Proves the RUNNER-INTERNAL ACP driver mechanism the Executor uses in
 * production, end-to-end in the REAL runner image, driven purely through the
 * Docker Engine API (create → start → wait → logs) — NO `docker` CLI, NO
 * interactive attach, NO host bind of the driver code, NO paid provider call:
 *
 *   - the driver bundle (runnerMain + the SAME AcpDriver + its one dep) and the
 *     trusted control.json are delivered on a job-scoped READ-ONLY control
 *     volume via the Docker archive API (exactly as KiroBackend does),
 *   - `node runnerMain.js` runs inside the hardened runner and drives ACP over
 *     a child's stdio to a DELIVERED deterministic mock Kiro ACP server,
 *   - the single bounded __ACP_RESULT__ line is emitted on stdout and parsed by
 *     the real parseRunnerResult().
 *
 * The real `kiro-cli`/`kiro-cli-chat` are stubbed here (image contract only);
 * the ACP conversation is exercised against the mock. The credentialed, real
 * kiro-cli path is proven separately by the live production-path check.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  createContainer, startContainer, waitContainer, getContainerLogs, removeContainer,
} from '../../src/executor/docker.js';
import { LABEL_MANAGED, LABEL_JOB, LABEL_RESOURCE } from '../../src/executor/agents/sandboxSpec.js';
import { buildTar, populateVolume } from '../../src/executor/agents/runnerAssets.js';
import { removeVolume } from '../../src/executor/docker.js';
import { parseRunnerResult, bridgeAgentConfig } from '../../src/executor/agents/kiroBackend.js';
import { newBridgeAgentName } from '../../src/executor/agents/acpDriver.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO_ROOT, 'dist');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures');
const IMAGE = 'mcp-ide-bridge-kiro-runner:a4-prodtest';
const newJobId = () => `job_${randomBytes(16).toString('hex')}`;

/** Deliver the runner-internal driver bundle + control.json onto a control volume. */
async function makeControlVolume(jobId: string, control: Record<string, unknown>): Promise<string> {
  const vol = `io-mcp-ide-bridge-control-${jobId}`;
  const tar = await buildTar({
    dirs: [{ name: 'executor/' }, { name: 'executor/agents/' }, { name: 'shared/' }],
    files: [
      { name: 'executor/agents/runnerMain.js', content: readFileSync(join(DIST, 'executor/agents/runnerMain.js')), mode: 0o500 },
      { name: 'executor/agents/acpDriver.js', content: readFileSync(join(DIST, 'executor/agents/acpDriver.js')), mode: 0o500 },
      { name: 'shared/errors.js', content: readFileSync(join(DIST, 'shared/errors.js')), mode: 0o500 },
      { name: 'mock-acp-server.mjs', content: readFileSync(join(FIXTURES, 'mock-acp-server.mjs')), mode: 0o500 },
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

async function runDriver(control: Record<string, unknown>): Promise<{ stdout: string; exit: number | null }> {
  const jobId = newJobId();
  const vol = await makeControlVolume(jobId, control);
  const id = await createContainer(`a4prod-${jobId}`, {
    Image: IMAGE, User: '1000:1000',
    // The image ENTRYPOINT (kiro-acp-entrypoint) exec's this. Mirrors the exact
    // production Cmd. No API key here — dry driver run against the mock.
    Cmd: ['node', '/run/control/executor/agents/runnerMain.js', '/run/control/control.json'],
    HostConfig: {
      AutoRemove: false, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Mounts: [{ Type: 'volume', Source: vol, Target: '/run/control', ReadOnly: true }],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=8m' },
    },
  });
  try {
    await startContainer(id);
    const waited = await waitContainer(id, { timeoutMs: 20_000 });
    const logs = await getContainerLogs(id, 262_144);
    return { stdout: logs.stdout, exit: waited.statusCode };
  } finally {
    await removeContainer(id, true).catch(() => {});
    await removeVolume(vol, true).catch(() => {});
  }
}

describe('A4 production path — runner-internal ACP driver via Docker Engine API', () => {
  let buildDir: string;

  beforeAll(() => {
    // Build the REAL runner Dockerfile with stub binaries (contract only). The
    // driver runs on `node` (present in the glibc base); the ACP conversation
    // uses the delivered mock, so no real kiro-cli is invoked here.
    buildDir = mkdtempSync(join(tmpdir(), 'a4pb-'));
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

  const baseControl = () => ({
    agent: newBridgeAgentName(() => randomBytes(16).toString('hex')),
    model: 'claude-sonnet-4',
    trustTools: 'read,grep,glob',
    cwd: '/workspace',
    prompt: 'IGNORED',
    dryRun: true,
    acpCommand: 'node',
    acpPrefixArgs: ['/run/control/mock-acp-server.mjs'],
  });

  it('dry run reaches initialize + session/new then STOPS (no prompt)', async () => {
    const { stdout, exit } = await runDriver({ ...baseControl(), dryRun: true });
    const r = parseRunnerResult(stdout);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    expect(r!.protocolVersion).toBe(1);
    expect(r!.agentInfo?.version).toBe('2.5.0');
    expect(r!.sessionId).toMatch(/^sess-/);
    expect(r!.stopReason).toBe('dry_run');
    expect(r!.toolCalls).toEqual([]);
    expect(exit).toBe(0);
  });

  it('full run drives a prompt turn and aggregates read-only tool calls', async () => {
    const { stdout, exit } = await runDriver({ ...baseControl(), dryRun: false, prompt: 'FIND-TOKEN' });
    const r = parseRunnerResult(stdout);
    expect(r!.ok).toBe(true);
    expect(r!.stopReason).toBe('end_turn');
    expect(r!.toolCalls).toEqual([{ kind: 'read', count: 1 }]);
    expect(r!.assistantText).toContain('MARKER:FIND-TOKEN');
    expect(exit).toBe(0);
  });

  it('the delivered per-job bridge agent config is read-only (no wildcard/mcp/hooks)', () => {
    const cfg = bridgeAgentConfig(newBridgeAgentName(() => randomBytes(16).toString('hex')));
    expect(cfg.tools).toEqual(['read', 'grep', 'glob']);
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.includeMcpJson).toBe(false);
  });
}, 240_000);
