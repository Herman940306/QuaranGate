/**
 * Target registry: manual targets from config + opt-in label discovery.
 * Discovery identifies; it never authorizes — authorization happens per-principal
 * in the gateway AND the executor only ever operates on targets present here.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { BridgeError } from '../shared/errors.js';
import type { TargetInfo } from '../shared/types.js';
import { listContainers, inspectContainer, type ContainerSummary } from './docker.js';

const LABEL_ENABLED = 'mcp.bridge.enabled';
const LABEL_WORKSPACE = 'mcp.bridge.workspace';
const LABEL_NAME = 'mcp.bridge.name';
const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_SERVICE = 'com.docker.compose.service';

export interface ManualTarget {
  id: string;
  composeProject?: string;
  composeService?: string;
  containerName?: string;
  workspace: string;
}

interface BridgeConfig {
  discovery?: { enabled?: boolean };
  targets?: ManualTarget[];
}

let config: BridgeConfig = {};

export function loadTargetConfig(path = process.env.BRIDGE_CONFIG ?? '/config/bridge.yaml'): void {
  if (!fs.existsSync(path)) {
    config = {};
    return;
  }
  const parsed = YAML.parse(fs.readFileSync(path, 'utf8')) as BridgeConfig | null;
  config = parsed ?? {};
  const seen = new Set<string>();
  for (const t of config.targets ?? []) {
    if (!t.id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id)) {
      throw new Error(`invalid target id: ${JSON.stringify(t.id)}`);
    }
    if (seen.has(t.id)) throw new Error(`duplicate target id: ${t.id}`);
    seen.add(t.id);
    if (!t.workspace || !t.workspace.startsWith('/')) {
      throw new Error(`target ${t.id}: workspace must be an absolute in-container path`);
    }
    if (!t.containerName && !(t.composeProject && t.composeService)) {
      throw new Error(`target ${t.id}: needs composeProject+composeService or containerName`);
    }
  }
}

interface ResolvedTarget extends TargetInfo {
  containerId: string;
}

let cache: { at: number; targets: TargetInfo[] } | null = null;
const CACHE_TTL_MS = 5_000;

function matchManual(t: ManualTarget, c: ContainerSummary): boolean {
  if (t.containerName) {
    return c.Names.some((n) => n.replace(/^\//, '') === t.containerName);
  }
  return (
    c.Labels[COMPOSE_PROJECT] === t.composeProject &&
    c.Labels[COMPOSE_SERVICE] === t.composeService
  );
}

/** Enumerate all configured/discovered targets with live status. */
export async function listTargets(): Promise<TargetInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.targets;
  const containers = await listContainers(true);
  const out: TargetInfo[] = [];
  const usedIds = new Set<string>();

  for (const t of config.targets ?? []) {
    const matches = containers.filter((c) => matchManual(t, c));
    const running = matches.filter((c) => c.State === 'running');
    const chosen = running[0] ?? matches[0];
    out.push({
      id: t.id,
      name: t.id,
      source: 'manual',
      composeProject: t.composeProject ?? null,
      composeService: t.composeService ?? null,
      workspace: t.workspace,
      running: running.length === 1,
      ...(chosen ? { image: chosen.Image, containerId: chosen.Id, status: chosen.Status } : {}),
      ...(running.length > 1 ? { status: 'ambiguous: multiple running matches' } : {}),
    });
    usedIds.add(t.id);
  }

  if (config.discovery?.enabled !== false) {
    for (const c of containers) {
      if (c.Labels[LABEL_ENABLED] !== 'true') continue;
      const workspace = c.Labels[LABEL_WORKSPACE];
      if (!workspace || !workspace.startsWith('/')) continue; // opt-in requires an absolute workspace
      const project = c.Labels[COMPOSE_PROJECT] ?? null;
      const service = c.Labels[COMPOSE_SERVICE] ?? null;
      const id = (c.Labels[LABEL_NAME] ?? (project && service ? `${project}-${service}` : c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12)))
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-');
      if (usedIds.has(id)) continue; // manual config wins; no silent conflicts
      usedIds.add(id);
      out.push({
        id,
        name: id,
        source: 'discovered',
        composeProject: project,
        composeService: service,
        workspace,
        running: c.State === 'running',
        image: c.Image,
        containerId: c.Id,
        status: c.Status,
      });
    }
  }

  cache = { at: Date.now(), targets: out };
  return out;
}

/** Resolve a target id to a single RUNNING container or fail closed. */
export async function resolveTarget(targetId: string): Promise<ResolvedTarget> {
  const targets = await listTargets();
  const t = targets.find((x) => x.id === targetId);
  if (!t) throw new BridgeError('UNKNOWN_TARGET', `unknown target: ${targetId}`, 404);
  if (t.status?.startsWith('ambiguous')) {
    throw new BridgeError('AMBIGUOUS_TARGET', `target ${targetId} matches multiple running containers`, 409);
  }
  if (!t.running || !t.containerId) {
    throw new BridgeError('TARGET_OFFLINE', `target ${targetId} has no running container`, 409);
  }
  // Re-verify liveness (cache may be stale up to 5s)
  const info = await inspectContainer(t.containerId).catch(() => null);
  if (!info?.State.Running) {
    cache = null;
    throw new BridgeError('TARGET_OFFLINE', `target ${targetId} is not running`, 409);
  }
  return { ...t, containerId: t.containerId };
}

export function invalidateCache(): void {
  cache = null;
}
