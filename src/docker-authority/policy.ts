/** SH-02 Docker authority broker policy. Pure validation; no Docker I/O. */
import path from 'node:path';
import { BridgeError } from '../shared/errors.js';

const CURRENT_NS = 'io.quarangate';
const LEGACY_NS = ['io.mcp-ide-bridge', 'io.mcp-bridge'] as const;
const ACCEPTED_NS = [CURRENT_NS, ...LEGACY_NS] as const;
const ALLOWED_RESOURCES = new Set([
  'runner','stager','workspace','evidence','applier','ollama-read-helper','before-capture','post-capture','git-helper','net','provider-session','secret',
  'home','control','proxy','evidence-rm','evidence-io','evidence-read','github-git-helper',
]);

export type DockerAuthorityOperation =
  | 'ping' | 'image.inspect'
  | 'container.listManaged' | 'container.inspectManaged' | 'container.createManaged'
  | 'container.startManaged' | 'container.waitManaged' | 'container.logsManaged'
  | 'container.stopManaged' | 'container.restartManaged' | 'container.killManaged' | 'container.removeManaged'
  | 'container.execManaged' | 'container.archiveReadManaged' | 'container.archiveWriteManaged'
  | 'volume.createManaged' | 'volume.listManaged' | 'volume.removeManaged'
  | 'network.createManaged' | 'network.listManaged' | 'network.connectManaged' | 'network.removeManaged';

export const DOCKER_AUTHORITY_OPERATIONS: readonly DockerAuthorityOperation[] = Object.freeze([
  'ping','image.inspect','container.listManaged','container.inspectManaged','container.createManaged',
  'container.startManaged','container.waitManaged','container.logsManaged','container.stopManaged','container.restartManaged',
  'container.killManaged','container.removeManaged','container.execManaged','container.archiveReadManaged',
  'container.archiveWriteManaged','volume.createManaged','volume.listManaged','volume.removeManaged',
  'network.createManaged','network.listManaged','network.connectManaged','network.removeManaged',
]);

function deny(message: string): never { throw new BridgeError('FORBIDDEN_POLICY', message, 403); }
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) deny('Docker authority payload must be an object');
  return v as Record<string, unknown>;
}
function strings(v: unknown): string[] { return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : []; }

export function managedIdentity(labels: unknown): { resource: string; job?: string } {
  const l = record(labels);
  if (l['io.quarangate.github.managed'] !== undefined || l['io.quarangate.github.resource'] !== undefined) {
    if (ACCEPTED_NS.some(ns => l[`${ns}.managed`] !== undefined || l[`${ns}.resource`] !== undefined || l[`${ns}.job`] !== undefined)) deny('contradictory QuaranGate ownership namespaces');
    if (l['io.quarangate.github.managed'] !== 'true' || !['head-check','push-helper','push-secret'].includes(String(l['io.quarangate.github.resource'] ?? ''))) deny('invalid QuaranGate GitHub ownership labels');
    const op=l['io.quarangate.github.operation']; if(typeof op!=='string'||!/^gh_[a-f0-9]{24}$/.test(op)) deny('invalid QuaranGate GitHub operation label');
    return { resource: String(l['io.quarangate.github.resource']) };
  }
  const found = ACCEPTED_NS.map(ns => ({ ns, managed: l[`${ns}.managed`], resource: l[`${ns}.resource`], job: l[`${ns}.job`] }))
    .filter(x => x.managed !== undefined || x.resource !== undefined || x.job !== undefined);
  if (found.length !== 1) deny('exactly one accepted QuaranGate ownership namespace is required');
  const one = found[0]!;
  if (one.managed !== 'true' || typeof one.resource !== 'string' || !ALLOWED_RESOURCES.has(one.resource)) deny('invalid QuaranGate ownership labels');
  if (one.job !== undefined && (typeof one.job !== 'string' || one.job.length < 1 || one.job.length > 128)) deny('invalid job ownership label');
  return { resource: one.resource, ...(typeof one.job === 'string' ? { job: one.job } : {}) };
}

export function validateManagedContainerCreate(bodyValue: unknown, trustedHostPaths: readonly string[] = []): void {
  const body = record(bodyValue);
  managedIdentity(body.Labels);
  const host = record(body.HostConfig ?? {});
  if (host.Privileged !== false) deny('Privileged must be false');
  if (strings(host.CapAdd).length) deny('capability additions are forbidden');
  const capDrop = strings(host.CapDrop).map(x => x.toUpperCase());
  if (!capDrop.includes('ALL')) deny('CapDrop ALL is required');
  if (host.PidMode && host.PidMode !== '') deny('host/custom PID namespace is forbidden');
  if (host.IpcMode && !['','private','none'].includes(String(host.IpcMode))) deny('host/custom IPC namespace is forbidden');
  if (Array.isArray(host.Devices) && host.Devices.length) deny('devices are forbidden');
  const sec = strings(host.SecurityOpt).map(x => x.toLowerCase());
  if (!sec.some(x => x === 'no-new-privileges' || x === 'no-new-privileges:true')) deny('no-new-privileges is required');
  const mode = String(host.NetworkMode ?? 'none');
  if (!(mode === 'none' || /^qg-[a-z0-9][a-z0-9_.-]{0,62}$/.test(mode))) deny('unapproved network mode');
  for (const bind of strings(host.Binds)) {
    const source = bind.split(':', 1)[0] ?? '';
    const canonical = path.resolve(source);
    if (canonical === '/var/run/docker.sock' || canonical.endsWith('/docker.sock')) deny('Docker socket bind is forbidden');
    if (!trustedHostPaths.some(root => canonical === path.resolve(root) || canonical.startsWith(`${path.resolve(root)}${path.sep}`))) deny('host bind is outside trusted roots');
  }
}

export function validateAuthorityRequest(value: unknown, trustedHostPaths: readonly string[] = []): { op: DockerAuthorityOperation; payload: Record<string, unknown> } {
  const req = record(value);
  if (typeof req.op !== 'string' || !DOCKER_AUTHORITY_OPERATIONS.includes(req.op as DockerAuthorityOperation)) deny('unsupported Docker authority operation');
  const payload = record(req.payload ?? {});
  if (req.op === 'container.createManaged') validateManagedContainerCreate(payload.body, trustedHostPaths);
  return { op: req.op as DockerAuthorityOperation, payload };
}
