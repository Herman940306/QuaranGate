/**
 * A3 runner-sandbox pure policy → Docker construction (no daemon).
 *
 * These tests are the security spec for the runner: they prove that the
 * container bodies are non-root, non-privileged, cap-dropped, read-only-rootfs,
 * network-isolated, docker.sock-free, host-bind-free, and correctly resource
 * limited — and that dangerous options simply cannot be produced through the
 * typed interface.
 */
import { describe, it, expect } from 'vitest';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';
import {
  LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB, MANAGED_FILTER,
  RUNNER_USER, WORKSPACE_PATH, SOURCE_PATH,
  ownershipLabels, isBridgeManaged, workspaceVolumeName, runnerContainerName, stagerContainerName,
  toRunnerLimits, resolveNetworkMode, buildStagerCreateBody, buildRunnerCreateBody,
} from '../../src/executor/agents/sandboxSpec.js';

const JOB = `job_${'a'.repeat(32)}`;
const policy: AgentResourcePolicy = {
  id: 'standard', modelClass: 'standard',
  maxRuntimeMs: 1_800_000, maxCpuMillicores: 2000, maxMemoryBytes: 2_147_483_648,
  maxPids: 256, maxOutputBytes: 262_144, maxEvidenceBytes: 52_428_800,
  networkPolicy: 'deny', retentionClass: 'short',
};

describe('ownership labels', () => {
  it('stamps the exact bridge namespace + resource kind + job', () => {
    const l = ownershipLabels('runner', JOB);
    expect(l[LABEL_MANAGED]).toBe('true');
    expect(l[LABEL_RESOURCE]).toBe('runner');
    expect(l[LABEL_JOB]).toBe(JOB);
  });
  it('managed filter targets only the exact managed label', () => {
    expect(MANAGED_FILTER).toEqual({ label: [`${LABEL_MANAGED}=true`] });
  });
  it('isBridgeManaged authority requires the exact label', () => {
    expect(isBridgeManaged({ [LABEL_MANAGED]: 'true' })).toBe(true);
    expect(isBridgeManaged({ [LABEL_MANAGED]: 'false' })).toBe(false);
    expect(isBridgeManaged({ foo: 'bar' })).toBe(false);
    expect(isBridgeManaged(null)).toBe(false);
    expect(isBridgeManaged(undefined)).toBe(false);
  });
  it('rejects an invalid job id (no label/name injection)', () => {
    expect(() => ownershipLabels('runner', 'not-a-job')).toThrow();
    expect(() => workspaceVolumeName('../evil')).toThrow();
    expect(() => runnerContainerName('job_bad')).toThrow();
  });
  it('derives deterministic, distinct resource names', () => {
    expect(workspaceVolumeName(JOB)).toBe(`io-mcp-ide-bridge-ws-${JOB}`);
    expect(runnerContainerName(JOB)).toBe(`io-mcp-ide-bridge-runner-${JOB}`);
    expect(stagerContainerName(JOB)).toBe(`io-mcp-ide-bridge-stager-${JOB}`);
  });
});

describe('resource policy conversion', () => {
  it('converts millicores to nanocpus and disables swap (exact integers)', () => {
    const l = toRunnerLimits(policy);
    expect(l.nanoCpus).toBe(2_000_000_000); // 2000 millicores == 2 CPU
    expect(l.memoryBytes).toBe(2_147_483_648);
    expect(l.memorySwapBytes).toBe(l.memoryBytes); // swap == memory ⇒ no swap
    expect(l.pidsLimit).toBe(256);
    expect(l.maxRuntimeMs).toBe(1_800_000);
    expect(l.maxOutputBytes).toBe(262_144);
  });
  it('rejects nonsensical limits rather than silently ignoring them', () => {
    expect(() => toRunnerLimits({ ...policy, maxMemoryBytes: 0 })).toThrow();
    expect(() => toRunnerLimits({ ...policy, maxPids: -1 })).toThrow();
    expect(() => toRunnerLimits({ ...policy, maxCpuMillicores: 1.5 })).toThrow();
  });
});

describe('network policy (fail closed)', () => {
  it('deny → real Docker isolation "none"', () => {
    expect(resolveNetworkMode('deny')).toBe('none');
  });
  it('backend-only fails closed in A3 (never unrestricted)', () => {
    expect(() => resolveNetworkMode('backend-only')).toThrow(/fail closed|no A3/i);
  });
});

describe('runner create body — the security spec', () => {
  const body = buildRunnerCreateBody({
    image: 'sandbox:test', jobId: JOB, volumeName: workspaceVolumeName(JOB),
    limits: toRunnerLimits(policy), networkMode: 'none', readRelPath: 'README.md',
  });
  const hc = body.HostConfig as Record<string, any>;

  it('runs non-root as the fixed runner uid:gid', () => {
    expect(body.User).toBe(RUNNER_USER);
    expect(body.User).toBe('1000:1000');
    expect(body.WorkingDir).toBe(WORKSPACE_PATH);
  });
  it('is non-privileged with all capabilities dropped and no-new-privileges', () => {
    expect(hc.Privileged).toBe(false);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.CapAdd).toEqual([]);
    expect(hc.SecurityOpt).toContain('no-new-privileges');
  });
  it('has a read-only root filesystem with only tmpfs /tmp writable', () => {
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(Object.keys(hc.Tmpfs)).toEqual(['/tmp']);
  });
  it('denies the network', () => {
    expect(hc.NetworkMode).toBe('none');
    expect(body.NetworkDisabled).toBe(true);
  });
  it('receives ONLY the workspace volume — no host binds, no docker.sock mount', () => {
    expect(hc.Binds).toEqual([]);
    expect(hc.Mounts).toHaveLength(1);
    expect(hc.Mounts[0]).toMatchObject({ Type: 'volume', Target: WORKSPACE_PATH, ReadOnly: false });
    // No host authority is mounted (the probe body may *name* the socket path only
    // to prove it is absent at runtime — that is a check, not a mount).
    const mountConfig = JSON.stringify({ Binds: hc.Binds, Mounts: hc.Mounts });
    expect(mountConfig).not.toContain('docker.sock');
    expect(mountConfig).not.toContain('/var/run');
    expect(mountConfig).not.toContain(SOURCE_PATH); // the runner never sees the source
  });
  it('never shares host namespaces or devices', () => {
    expect(hc.PidMode).toBe('');
    expect(hc.IpcMode).toBe('private');
    expect(hc.UsernsMode).toBe('');
    expect(hc.Devices).toEqual([]);
    expect(hc.GroupAdd).toEqual([]);
  });
  it('applies the exact resource limits from policy', () => {
    expect(hc.Memory).toBe(2_147_483_648);
    expect(hc.MemorySwap).toBe(2_147_483_648);
    expect(hc.NanoCpus).toBe(2_000_000_000);
    expect(hc.PidsLimit).toBe(256);
  });
  it('carries runner ownership labels', () => {
    expect(body.Labels[LABEL_MANAGED]).toBe('true');
    expect(body.Labels[LABEL_RESOURCE]).toBe('runner');
  });
});

describe('stager create body — trusted helper, source read-only', () => {
  const body = buildStagerCreateBody({
    image: 'sandbox:test', jobId: JOB, hostPath: '/home/trusted/project', volumeName: workspaceVolumeName(JOB),
  });
  const hc = body.HostConfig as Record<string, any>;

  it('mounts the trusted source READ ONLY at /src and only there', () => {
    expect(hc.Binds).toEqual([`/home/trusted/project:${SOURCE_PATH}:ro`]);
    expect(hc.Binds[0].endsWith(':ro')).toBe(true);
  });
  it('is confined: non-root, non-privileged, cap-drop, ro-rootfs, network none, no socket', () => {
    expect(body.User).toBe('1000:1000');
    expect(hc.Privileged).toBe(false);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.NetworkMode).toBe('none');
    expect(body.NetworkDisabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain('docker.sock');
  });
  it('runs a deterministic git-archive staging command (no caller input)', () => {
    expect(body.Cmd[0]).toBe('sh');
    expect(body.Cmd[2]).toContain('archive --format=tar HEAD'); // tracked-committed staging step
    expect(body.Cmd[2]).toContain('--porcelain'); // clean checkpoint check present
    expect(body.Cmd[2]).toContain('DIRTY_WORKING_TREE'); // fail-closed on dirty
  });
  it('rejects a non-absolute trusted host path', () => {
    expect(() => buildStagerCreateBody({ image: 'x', jobId: JOB, hostPath: 'relative/path', volumeName: 'v' })).toThrow();
  });
  it('carries stager ownership labels', () => {
    expect(body.Labels[LABEL_RESOURCE]).toBe('stager');
  });
});
