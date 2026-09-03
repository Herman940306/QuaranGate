/**
 * O1 Ollama sandbox spec — deterministic Docker spec tests (§24 Reqs 37-47).
 *
 * Proves that buildOllamaReadHelperCreateBody produces containers that are:
 * non-root, cap-dropped, read-only-rootfs, read-only workspace mount,
 * network-disabled, host-bind-free, device-free, and correctly labelled.
 *
 * These tests require no Docker daemon. All assertions are on the pure data
 * produced by the spec builder.
 */
import { describe, it, expect } from 'vitest';
import {
  buildOllamaReadHelperCreateBody,
  ollamaReadHelperContainerName,
  toRunnerLimits,
  RUNNER_USER,
  WORKSPACE_PATH,
  LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB, SANDBOX_LABEL_NS,
  ownershipLabels, isBridgeManaged, ownershipLabelValue,
} from '../../src/executor/agents/sandboxSpec.js';
import type { AgentResourcePolicy } from '../../src/shared/agents.js';
import { BridgeError } from '../../src/shared/errors.js';

const JOB = `job_${'f'.repeat(32)}`;

const POLICY: AgentResourcePolicy = {
  id: 'economy', modelClass: 'fast',
  maxRuntimeMs: 600_000, maxCpuMillicores: 1000, maxMemoryBytes: 1_073_741_824,
  maxPids: 128, maxOutputBytes: 262_144, maxEvidenceBytes: 10_485_760,
  networkPolicy: 'deny', retentionClass: 'ephemeral',
};

function makeBody(overrides: Partial<Parameters<typeof buildOllamaReadHelperCreateBody>[0]> = {}) {
  const limits = toRunnerLimits(POLICY);
  return buildOllamaReadHelperCreateBody({
    image: 'test-helper:v1.0.0',
    jobId: JOB,
    workspaceVolumeName: `io-quarangate-ws-${JOB}`,
    limits,
    ...overrides,
  });
}

describe('buildOllamaReadHelperCreateBody', () => {
  it('produces a valid container body', () => {
    const body = makeBody();
    expect(body).toBeTruthy();
    expect(body.Image).toBe('test-helper:v1.0.0');
  });

  // Req 37: workspace volume is read-only
  it('workspace volume mount is ReadOnly: true', () => {
    const body = makeBody();
    const mounts = body.HostConfig.Mounts as Array<{ Type: string; Target: string; ReadOnly: boolean; Source: string }>;
    const wsMnt = mounts?.find((m) => m.Target === WORKSPACE_PATH);
    expect(wsMnt).toBeDefined();
    expect(wsMnt!.ReadOnly).toBe(true);
    expect(wsMnt!.Type).toBe('volume');
  });

  it('workspace volume source name is passed through', () => {
    const body = makeBody({ workspaceVolumeName: `io-quarangate-ws-${JOB}` });
    const mounts = body.HostConfig.Mounts as Array<{ Source: string; Target: string }>;
    const wsMnt = mounts?.find((m) => m.Target === WORKSPACE_PATH);
    expect(wsMnt!.Source).toBe(`io-quarangate-ws-${JOB}`);
  });

  // Req 38: NetworkMode none + NetworkDisabled
  it('NetworkMode is "none"', () => {
    expect(makeBody().HostConfig.NetworkMode).toBe('none');
  });

  it('NetworkDisabled is true', () => {
    expect(makeBody().NetworkDisabled).toBe(true);
  });

  // Req 39: ReadonlyRootfs
  it('ReadonlyRootfs is true', () => {
    expect(makeBody().HostConfig.ReadonlyRootfs).toBe(true);
  });

  // Req 40: CapDrop ALL
  it('CapDrop contains ALL', () => {
    const capDrop = makeBody().HostConfig.CapDrop as string[];
    expect(capDrop).toContain('ALL');
  });

  it('CapAdd is empty (no extra capabilities)', () => {
    const capAdd = makeBody().HostConfig.CapAdd as string[];
    expect(capAdd).toEqual([]);
  });

  // Req 41: no-new-privileges
  it('SecurityOpt contains no-new-privileges', () => {
    const secOpts = makeBody().HostConfig.SecurityOpt as string[];
    expect(secOpts).toContain('no-new-privileges');
  });

  // Req 42: non-root user
  it('User is 1000:1000 (non-root)', () => {
    const body = makeBody();
    expect(body.User).toBe(RUNNER_USER); // '1000:1000'
    expect(body.User).not.toBe('root');
    expect(body.User).not.toBe('0:0');
  });

  // Req 43: no host binds, no docker.sock, no devices
  it('Binds array is empty (no host binds)', () => {
    const binds = makeBody().HostConfig.Binds as string[];
    expect(binds).toEqual([]);
  });

  it('Devices array is empty (no device passthrough)', () => {
    const devices = makeBody().HostConfig.Devices as unknown[];
    expect(devices).toEqual([]);
  });

  it('GroupAdd is empty (no docker group)', () => {
    const groups = makeBody().HostConfig.GroupAdd as string[];
    expect(groups).toEqual([]);
  });

  it('Privileged is false', () => {
    expect(makeBody().HostConfig.Privileged).toBe(false);
  });

  it('no host namespace sharing (PidMode, UTSMode, UsernsMode empty)', () => {
    const body = makeBody();
    expect(body.HostConfig.PidMode).toBe('');
    expect(body.HostConfig.UTSMode).toBe('');
    expect(body.HostConfig.UsernsMode).toBe('');
  });

  // Req 44: trusted bounded lifetime
  it('Cmd is sleep with a positive integer seconds derived from limits', () => {
    const body = makeBody();
    expect(body.Cmd[0]).toBe('sleep');
    const secs = Number(body.Cmd[1]);
    expect(Number.isInteger(secs)).toBe(true);
    expect(secs).toBeGreaterThan(0);
    // 600_000ms / 1000 + 60s grace = 660s
    expect(secs).toBe(660);
  });

  it('lifetime scales with maxRuntimeMs', () => {
    const limits30 = toRunnerLimits({ ...POLICY, maxRuntimeMs: 1_800_000 });
    const body30 = buildOllamaReadHelperCreateBody({ image: 'img:v1', jobId: JOB, workspaceVolumeName: 'vol', limits: limits30 });
    const limits5 = toRunnerLimits({ ...POLICY, maxRuntimeMs: 300_000 });
    const body5 = buildOllamaReadHelperCreateBody({ image: 'img:v1', jobId: JOB, workspaceVolumeName: 'vol', limits: limits5 });
    expect(Number(body30.Cmd[1])).toBeGreaterThan(Number(body5.Cmd[1]));
  });

  // Req 45: managed resource label
  it('Labels carry managed=true, resource=ollama-read-helper, job=JOB', () => {
    const body = makeBody();
    expect(body.Labels[LABEL_MANAGED]).toBe('true');
    expect(body.Labels[LABEL_RESOURCE]).toBe('ollama-read-helper');
    expect(body.Labels[LABEL_JOB]).toBe(JOB);
  });

  // Req 46: orphan reconciliation recognises ollama-read-helper
  it('isBridgeManaged recognises ollama-read-helper labels', () => {
    const labels = makeBody().Labels;
    expect(isBridgeManaged(labels)).toBe(true);
    expect(ownershipLabelValue(labels, 'resource')).toBe('ollama-read-helper');
  });

  // Req 47: explicit image, not a Kiro fallback
  it('uses the provided image reference, not a runtime default', () => {
    const body = buildOllamaReadHelperCreateBody({
      image: 'my-explicit-helper:sha256-cafebabe',
      jobId: JOB,
      workspaceVolumeName: 'vol',
      limits: toRunnerLimits(POLICY),
    });
    expect(body.Image).toBe('my-explicit-helper:sha256-cafebabe');
    expect(body.Image).not.toContain('kiro');
    expect(body.Image).not.toContain('runner');
  });

  it('rejects invalid job IDs', () => {
    const limits = toRunnerLimits(POLICY);
    expect(() => buildOllamaReadHelperCreateBody({ image: 'img:v1', jobId: '', workspaceVolumeName: 'vol', limits })).toThrow(BridgeError);
    expect(() => buildOllamaReadHelperCreateBody({ image: 'img:v1', jobId: 'bad-id', workspaceVolumeName: 'vol', limits })).toThrow(BridgeError);
    expect(() => buildOllamaReadHelperCreateBody({ image: 'img:v1', jobId: 'job_short', workspaceVolumeName: 'vol', limits })).toThrow(BridgeError);
  });
});

describe('ollamaReadHelperContainerName', () => {
  it('produces deterministic name containing ollama-helper and jobId', () => {
    const name = ollamaReadHelperContainerName(JOB);
    expect(name).toContain('ollama-helper');
    expect(name).toContain(JOB);
  });

  it('uses QuaranGate namespace prefix', () => {
    const name = ollamaReadHelperContainerName(JOB);
    expect(name.startsWith('io-quarangate-')).toBe(true);
  });

  it('is distinct from runner, stager container names', () => {
    const helperName = ollamaReadHelperContainerName(JOB);
    expect(helperName).not.toContain('-runner-');
    expect(helperName).not.toContain('-stager-');
    expect(helperName).not.toContain('-applier-');
  });

  it('rejects invalid job IDs', () => {
    expect(() => ollamaReadHelperContainerName('bad')).toThrow(BridgeError);
    expect(() => ollamaReadHelperContainerName('')).toThrow(BridgeError);
  });

  it('is deterministic for the same jobId', () => {
    expect(ollamaReadHelperContainerName(JOB)).toBe(ollamaReadHelperContainerName(JOB));
  });
});

describe('O1 ollama-read-helper orphan reconciliation', () => {
  it('ownershipLabels for ollama-read-helper are recognised by isBridgeManaged', () => {
    const labels = ownershipLabels('ollama-read-helper', JOB);
    expect(isBridgeManaged(labels)).toBe(true);
  });

  it('ownershipLabelValue returns ollama-read-helper for resource', () => {
    const labels = ownershipLabels('ollama-read-helper', JOB);
    expect(ownershipLabelValue(labels, 'resource')).toBe('ollama-read-helper');
    expect(ownershipLabelValue(labels, 'job')).toBe(JOB);
  });

  it('legacy namespace labels are still recognised on read', () => {
    // Pre-N1D labels would carry io.mcp-ide-bridge namespace
    const legacyLabels = {
      'io.mcp-ide-bridge.managed': 'true',
      'io.mcp-ide-bridge.resource': 'ollama-read-helper',
      'io.mcp-ide-bridge.job': JOB,
    };
    expect(isBridgeManaged(legacyLabels)).toBe(true);
  });
});
