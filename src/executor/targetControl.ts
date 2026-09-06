import { BridgeError } from '../shared/errors.js';
import type { TargetInfo } from '../shared/types.js';
import {
  getContainerLogs,
  inspectContainer,
  restartContainer,
  startContainer,
  stopContainer,
} from './docker.js';
import { invalidateCache, resolveTargetForControl } from './targets.js';

export type TargetControlAction = 'start' | 'stop' | 'restart';

export interface TargetControlResult {
  ok: true;
  target: string;
  action: TargetControlAction;
  running: boolean;
  status: string;
  health?: string;
}

async function afterState(target: TargetInfo & { containerId: string }): Promise<{ running: boolean; status: string; health?: string }> {
  invalidateCache();
  const info = await inspectContainer(target.containerId);
  return { running: info.State.Running, status: info.State.Status, ...(info.State.Health?.Status ? { health: info.State.Health.Status } : {}) };
}

/**
 * Lifecycle control is intentionally narrower than raw Docker authority:
 * - only manually configured targets are eligible;
 * - the caller cannot provide a container id/name, image, mount, network or Docker option;
 * - exactly one existing container must match the trusted target definition.
 */
export async function controlTarget(targetId: string, action: TargetControlAction): Promise<TargetControlResult> {
  const target = await resolveTargetForControl(targetId);
  const before = await inspectContainer(target.containerId);

  if (action === 'restart') {
    if (!before.State.Running) {
      throw new BridgeError('PRECONDITION_FAILED', `target ${targetId} is stopped; use target_start instead of restart`, 409);
    }
    await restartContainer(target.containerId, 10);
  } else if (action === 'start') {
    if (!before.State.Running) await startContainer(target.containerId);
  } else {
    if (before.State.Running) await stopContainer(target.containerId, 10);
  }

  const after = await afterState(target);
  const expectedRunning = action !== 'stop';
  if (after.running !== expectedRunning) {
    throw new BridgeError(
      'DOCKER_UNAVAILABLE',
      `target ${targetId} ${action} did not reach expected running=${expectedRunning}`,
      502,
    );
  }
  return { ok: true, target: targetId, action, ...after };
}

/** Bounded logs for a manually configured target, including stopped containers. */
export async function readTargetLogs(targetId: string, maxBytes: number): Promise<{
  target: string;
  stdout: string;
  stderr: string;
  bytes: number;
  truncated: boolean;
}> {
  const target = await resolveTargetForControl(targetId);
  const logs = await getContainerLogs(target.containerId, maxBytes);
  return { target: targetId, ...logs };
}
