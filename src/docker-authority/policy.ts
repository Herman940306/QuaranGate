/** SH-02/SH-11 Docker authority broker policy. Pure validation; no Docker I/O. */
import path from 'node:path';
import { BridgeError } from '../shared/errors.js';
import { APPLY_MUTATION_SCRIPT, GIT_HOST_CHECK_SCRIPT, LIVE_STAT_SCRIPT, MOUNTINFO_CHECK_SCRIPT } from '../executor/agents/sandboxSpec.js';

const CURRENT_NS = 'io.quarangate';
const LEGACY_NS = ['io.mcp-ide-bridge', 'io.mcp-bridge'] as const;
const ACCEPTED_NS = [CURRENT_NS, ...LEGACY_NS] as const;
const GITHUB_NS = 'io.quarangate.github';
const JOB_RE = /^job_[0-9a-f]{32}$/u;
const GH_OP_RE = /^gh_[0-9a-f]{24}$/u;
const PROVIDER_BINDING_RE = /^[0-9a-f]{64}$/u;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/u;
const MAX_MEMORY = 64 * 1024 ** 3;
const MAX_PIDS = 4096;
const MAX_NANO_CPUS = 64_000_000_000;

const ALLOWED_RESOURCES = new Set([
  'runner','stager','workspace','evidence','applier','ollama-read-helper','before-capture','post-capture','git-helper','net','provider-session','secret',
  'home','control','proxy','evidence-rm','evidence-io','evidence-read','github-git-helper',
]);
const GITHUB_RESOURCES = new Set(['head-check','push-helper','push-secret']);

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

export interface ManagedIdentity {
  scope: 'sandbox' | 'github';
  namespace: string;
  resource: string;
  job?: string;
  operation?: string;
  attempt?: string;
  providerBinding?: string;
}

export interface ManagedVolumeMount {
  Type: 'volume';
  Source: string;
  Target: string;
  ReadOnly: boolean;
}

function deny(message: string): never { throw new BridgeError('FORBIDDEN_POLICY', message, 403); }
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) deny('Docker authority payload must be an object');
  return v as Record<string, unknown>;
}
function strings(v: unknown): string[] { return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : []; }
function stringArray(v: unknown, what: string): string[] { if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) deny(`${what} must be a string array`); return v as string[]; }
function emptyArray(v: unknown, what: string): void { if (v !== undefined && (!Array.isArray(v) || v.length !== 0)) deny(`${what} is forbidden`); }
function emptyObject(v: unknown, what: string): void { if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v as object).length !== 0)) deny(`${what} is forbidden`); }
function exactStringArray(v: unknown, expected: readonly string[], what: string): void {
  const got = strings(v).map(x => x.toUpperCase()).sort();
  const want = [...expected].map(x => x.toUpperCase()).sort();
  if (got.length !== want.length || got.some((x, i) => x !== want[i])) deny(`${what} must be exactly ${expected.join(',') || '(empty)'}`);
}
function requirePositiveBoundedInt(v: unknown, max: number, what: string, optional = false): void {
  if (v === undefined && optional) return;
  if (!Number.isSafeInteger(v) || Number(v) <= 0 || Number(v) > max) deny(`${what} must be a positive bounded integer`);
}

export function managedIdentity(labels: unknown): ManagedIdentity {
  const l = record(labels);
  const hasGithub = l[`${GITHUB_NS}.managed`] !== undefined || l[`${GITHUB_NS}.resource`] !== undefined || l[`${GITHUB_NS}.operation`] !== undefined;
  if (hasGithub) {
    if (ACCEPTED_NS.some(ns => l[`${ns}.managed`] !== undefined || l[`${ns}.resource`] !== undefined || l[`${ns}.job`] !== undefined)) deny('contradictory QuaranGate ownership namespaces');
    const resource = String(l[`${GITHUB_NS}.resource`] ?? '');
    if (l[`${GITHUB_NS}.managed`] !== 'true' || !GITHUB_RESOURCES.has(resource)) deny('invalid QuaranGate GitHub ownership labels');
    const operation = l[`${GITHUB_NS}.operation`];
    if (typeof operation !== 'string' || !GH_OP_RE.test(operation)) deny('invalid QuaranGate GitHub operation label');
    return { scope: 'github', namespace: GITHUB_NS, resource, operation };
  }

  const found = ACCEPTED_NS.map(ns => ({
    ns,
    managed: l[`${ns}.managed`],
    resource: l[`${ns}.resource`],
    job: l[`${ns}.job`],
    attempt: l[`${ns}.attempt`],
    providerBinding: l[`${CURRENT_NS}.provider-binding`],
  })).filter(x => x.managed !== undefined || x.resource !== undefined || x.job !== undefined || x.attempt !== undefined);
  if (found.length !== 1) deny('exactly one accepted QuaranGate ownership namespace is required');
  const one = found[0]!;
  if (one.managed !== 'true' || typeof one.resource !== 'string' || !ALLOWED_RESOURCES.has(one.resource)) deny('invalid QuaranGate ownership labels');
  if (one.job !== undefined && (typeof one.job !== 'string' || one.job.length < 1 || one.job.length > 128)) deny('invalid job ownership label');
  if (one.attempt !== undefined && (typeof one.attempt !== 'string' || !/^att_[0-9a-f]{32}$/u.test(one.attempt))) deny('invalid attempt ownership label');
  if (one.providerBinding !== undefined && (typeof one.providerBinding !== 'string' || !PROVIDER_BINDING_RE.test(one.providerBinding))) deny('invalid provider binding label');
  return {
    scope: 'sandbox', namespace: one.ns, resource: one.resource,
    ...(typeof one.job === 'string' ? { job: one.job } : {}),
    ...(typeof one.attempt === 'string' ? { attempt: one.attempt } : {}),
    ...(typeof one.providerBinding === 'string' ? { providerBinding: one.providerBinding } : {}),
  };
}

function assertCreationIdentity(identity: ManagedIdentity): void {
  if (identity.scope === 'sandbox') {
    if (identity.namespace !== CURRENT_NS) deny('new managed resources must use the current QuaranGate ownership namespace');
    if (!identity.job || !JOB_RE.test(identity.job)) deny('new managed resources require a canonical job id');
    if (identity.resource === 'applier' && !identity.attempt) deny('applier resource requires an attempt id');
    if (identity.resource !== 'applier' && identity.attempt) deny('attempt label is reserved for applier resources');
  }
}

function allowedSandboxNetwork(identity: ManagedIdentity, mode: string): boolean {
  if (!identity.job) return false;
  const base = `io-quarangate-net-${identity.job}`;
  if (identity.resource === 'runner' || identity.resource === 'proxy') {
    return mode === 'none' || mode === base || mode === `${base}-copilot-int`;
  }
  return mode === 'none';
}

function validateNetworkMode(identity: ManagedIdentity, mode: string): void {
  if (identity.scope === 'github') {
    const ok = identity.resource === 'push-helper' ? mode === 'quarangate-github-control' : mode === 'none';
    if (!ok) deny('unapproved GitHub helper network mode');
    return;
  }
  if (!allowedSandboxNetwork(identity, mode)) deny('unapproved job network mode');
}

function validateHostBinds(identity: ManagedIdentity, bindsValue: unknown, trustedHostPaths: readonly string[]): void {
  const binds = bindsValue === undefined ? [] : stringArray(bindsValue, 'Binds');
  let allowedTarget: string | null = null;
  let allowedMode: 'ro' | 'rw' | null = null;
  if (identity.scope === 'github' && ['head-check','push-helper'].includes(identity.resource)) { allowedTarget = '/src'; allowedMode = 'ro'; }
  if (identity.scope === 'sandbox' && ['stager','git-helper'].includes(identity.resource)) { allowedTarget = '/src'; allowedMode = 'ro'; }
  if (identity.scope === 'sandbox' && identity.resource === 'applier') { allowedTarget = '/project'; allowedMode = 'rw'; }
  if (!allowedTarget && binds.length) deny('host binds are forbidden for this resource role');
  if (allowedTarget && binds.length !== 1) deny('resource role requires exactly one trusted host bind');
  for (const bind of binds) {
    const m = /^([^:\0]+):([^:\0]+):(ro|rw)$/u.exec(bind);
    if (!m) deny('host bind must use exact source:target:ro|rw form');
    const source = path.resolve(m[1]!);
    const target = m[2]!;
    const mode = m[3]!;
    if (source === '/var/run/docker.sock' || source.endsWith('/docker.sock')) deny('Docker socket bind is forbidden');
    if (!trustedHostPaths.some(root => source === path.resolve(root))) deny('host bind must equal an exact trusted configured root');
    if (target !== allowedTarget || mode !== allowedMode) deny('host bind target/mode is not permitted for this resource role');
  }
}

export function managedVolumeMounts(bodyValue: unknown): ManagedVolumeMount[] {
  const body = record(bodyValue);
  const host = record(body.HostConfig ?? {});
  const raw = host.Mounts;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) deny('HostConfig.Mounts must be an array');
  const out: ManagedVolumeMount[] = [];
  for (const item of raw) {
    const m = record(item);
    if (m.Type !== 'volume') deny('only Docker-managed volume mounts are permitted; structured bind/tmpfs mounts are forbidden');
    if (typeof m.Source !== 'string' || m.Source.length < 1 || m.Source.length > 255 || m.Source.includes('\0')) deny('invalid managed volume source');
    if (typeof m.Target !== 'string' || !m.Target.startsWith('/') || m.Target.length > 255 || m.Target.includes('\0')) deny('invalid managed volume target');
    if (typeof m.ReadOnly !== 'boolean') deny('managed volume mount must declare ReadOnly explicitly');
    const extra = Object.keys(m).filter(k => !['Type','Source','Target','ReadOnly'].includes(k));
    if (extra.length) deny(`unsupported managed volume mount fields: ${extra.join(',')}`);
    out.push({ Type: 'volume', Source: m.Source, Target: m.Target, ReadOnly: m.ReadOnly });
  }
  if (new Set(out.map(m => m.Target)).size !== out.length) deny('duplicate managed volume mount target');
  return out;
}

function validateMountShapeForRole(identity: ManagedIdentity, mounts: readonly ManagedVolumeMount[]): void {
  if (identity.scope === 'github') {
    if (identity.resource === 'push-helper') {
      if (mounts.length !== 1 || mounts[0]!.Target !== '/run/github-auth' || mounts[0]!.ReadOnly !== true) deny('GitHub push-helper requires exactly one read-only auth volume');
    } else if (identity.resource === 'push-secret') {
      if (mounts.length !== 1 || mounts[0]!.Target !== '/secrets' || mounts[0]!.ReadOnly !== false) deny('GitHub push-secret initializer requires exactly one writable secret volume');
    } else if (mounts.length) deny('GitHub head-check may not mount managed volumes');
    return;
  }
  const rules: Record<string, Array<readonly [string, boolean]>> = {
    stager: [['/workspace', false]],
    'ollama-read-helper': [['/workspace', true]],
    'before-capture': [['/workspace', true], ['/evidence', false]],
    'post-capture': [['/workspace', true]],
    'evidence-read': [['/evidence', true]],
    'evidence-io': [['/evidence', false]],
    'evidence-rm': [['/evidence', false]],
    applier: [['/artifact', true], ['/control', false]],
    secret: [['/secrets', false]],
    home: [['/home/runner', false]],
    control: [['/run/control', false]],
  };
  if (identity.resource === 'runner') {
    const allowed = new Map<string, boolean | 'either'>([
      ['/workspace', 'either'], ['/run/secrets', true], ['/home/runner', false],
      ['/home/runner/.kiro/sessions/cli', false], ['/run/control', true],
    ]);
    for (const m of mounts) {
      const expected = allowed.get(m.Target);
      if (expected === undefined || (expected !== 'either' && m.ReadOnly !== expected)) deny('runner volume target/mode is not permitted');
    }
    return;
  }
  if (identity.resource === 'proxy' || identity.resource === 'git-helper' || identity.resource === 'workspace' || identity.resource === 'evidence' || identity.resource === 'net' || identity.resource === 'provider-session') {
    if (mounts.length) deny('managed volume mounts are forbidden for this resource role');
    return;
  }
  const allowed = rules[identity.resource];
  if (!allowed) { if (mounts.length) deny('managed volume mounts are forbidden for this resource role'); return; }
  for (const m of mounts) if (!allowed.some(([target, ro]) => target === m.Target && ro === m.ReadOnly)) deny('managed volume target/mode is not permitted for this resource role');
  if (identity.resource !== 'before-capture' && mounts.length !== allowed.length) deny('resource role has an unexpected managed volume count');
  if (identity.resource === 'before-capture' && mounts.length !== 1) deny('before-capture helper must mount exactly one source or destination volume');
}

function validateCreationNetworking(identity: ManagedIdentity, body: Record<string, unknown>, mode: string): void {
  const cfg = body.NetworkingConfig;
  if (cfg === undefined) return;
  if (identity.scope !== 'sandbox' || identity.resource !== 'proxy') deny('creation-time NetworkingConfig is permitted only for the governed egress proxy');
  const endpoints = record(record(cfg).EndpointsConfig);
  const keys = Object.keys(endpoints);
  if (keys.length !== 1 || keys[0] !== mode || mode === 'none') deny('creation-time endpoint must match the single approved proxy network');
  const endpoint = record(endpoints[mode]);
  const aliases = endpoint.Aliases;
  if (!Array.isArray(aliases) || aliases.length !== 1 || aliases[0] !== 'egress-proxy') deny('proxy network alias must be exactly egress-proxy');
  const extra = Object.keys(endpoint).filter(k => k !== 'Aliases');
  if (extra.length) deny('unsupported creation-time endpoint configuration');
}

export function validateManagedContainerCreate(bodyValue: unknown, trustedHostPaths: readonly string[] = []): ManagedIdentity {
  const body = record(bodyValue);
  const identity = managedIdentity(body.Labels);
  assertCreationIdentity(identity);
  if (typeof body.Image !== 'string' || !IMAGE_ID_RE.test(body.Image)) deny('managed container Image must be an immutable local Docker image ID');
  const host = record(body.HostConfig ?? {});
  if (host.AutoRemove !== false) deny('AutoRemove must be false');
  if (host.Privileged !== false) deny('Privileged must be false');
  if (body.Volumes !== undefined && Object.keys(record(body.Volumes)).length) deny('anonymous/config-declared volumes are forbidden; use governed Mounts only');
  const readonlyRequired = !(identity.scope === 'sandbox' && identity.resource === 'evidence-rm');
  if (host.ReadonlyRootfs !== readonlyRequired) deny(`ReadonlyRootfs must be ${readonlyRequired}`);
  exactStringArray(host.CapDrop, ['ALL'], 'CapDrop');
  if (identity.scope === 'sandbox' && identity.resource === 'applier') exactStringArray(host.CapAdd, ['DAC_OVERRIDE','FOWNER'], 'applier CapAdd');
  else if (host.CapAdd !== undefined && stringArray(host.CapAdd, 'CapAdd').length) deny('capability additions are forbidden for this resource role');
  emptyArray(host.GroupAdd, 'supplementary groups');
  emptyArray(host.Devices, 'devices');
  emptyArray(host.DeviceRequests, 'device requests');
  emptyArray(host.VolumesFrom, 'VolumesFrom');
  emptyArray(host.Links, 'legacy container links');
  emptyArray(host.ExtraHosts, 'extra hosts');
  emptyArray(host.Dns, 'custom DNS servers');
  emptyArray(host.DnsSearch, 'custom DNS search');
  emptyArray(host.DnsOptions, 'custom DNS options');
  emptyObject(host.PortBindings, 'host port publication');
  if (host.PublishAllPorts === true) deny('PublishAllPorts is forbidden');
  if (host.OomKillDisable === true) deny('OomKillDisable is forbidden');
  if (host.PidMode && host.PidMode !== '') deny('host/custom PID namespace is forbidden');
  if (host.IpcMode && !['','private','none'].includes(String(host.IpcMode))) deny('host/custom IPC namespace is forbidden');
  if (host.UTSMode && host.UTSMode !== '') deny('host/custom UTS namespace is forbidden');
  if (host.UsernsMode && host.UsernsMode !== '') deny('custom user namespace mode is forbidden');
  if (host.CgroupnsMode && host.CgroupnsMode !== 'private') deny('host/custom cgroup namespace is forbidden');
  if (host.CgroupParent) deny('custom cgroup parent is forbidden');
  if (host.Runtime) deny('custom OCI runtime is forbidden');
  if (host.Isolation) deny('custom container isolation is forbidden');
  const restart = host.RestartPolicy === undefined ? undefined : record(host.RestartPolicy);
  if (restart && restart.Name !== undefined && !['','no'].includes(String(restart.Name))) deny('container restart policy is forbidden');
  if (host.LogConfig !== undefined && Object.keys(record(host.LogConfig)).length) deny('custom Docker logging configuration is forbidden');
  if (host.MaskedPaths !== undefined) deny('custom masked-path policy is forbidden');
  if (host.ReadonlyPaths !== undefined) deny('custom read-only path policy is forbidden');
  if (host.Sysctls !== undefined) deny('custom sysctls are forbidden');
  if (host.ShmSize !== undefined && Number(host.ShmSize) > 64 * 1024 * 1024) deny('shared memory size exceeds broker cap');
  if (host.Tmpfs !== undefined) {
    const tmpfs = record(host.Tmpfs);
    if (Object.keys(tmpfs).some(k => k !== '/tmp')) deny('tmpfs mounts are restricted to /tmp');
    const spec = tmpfs['/tmp'];
    if (spec !== undefined) {
      if (typeof spec !== 'string' || spec.length > 128 || !/(^|,)nosuid(,|$)/u.test(spec) || !/(^|,)nodev(,|$)/u.test(spec)) deny('/tmp tmpfs must include nosuid,nodev');
      const m = /(?:^|,)size=(\d+)([kmg]?)(?:,|$)/iu.exec(spec);
      if (!m) deny('/tmp tmpfs requires an explicit size cap');
      const factor = ({'':1,k:1024,m:1024**2,g:1024**3} as Record<string,number>)[m[2]!.toLowerCase()];
      if (!factor || Number(m[1]) * factor > 64 * 1024 * 1024) deny('/tmp tmpfs exceeds broker size cap');
    }
  }
  const sec = strings(host.SecurityOpt).map(x => x.toLowerCase());
  if (sec.length !== 1 || !['no-new-privileges','no-new-privileges:true'].includes(sec[0]!)) deny('SecurityOpt must contain only no-new-privileges');
  requirePositiveBoundedInt(host.Memory, MAX_MEMORY, 'Memory');
  requirePositiveBoundedInt(host.PidsLimit, MAX_PIDS, 'PidsLimit');
  requirePositiveBoundedInt(host.NanoCpus, MAX_NANO_CPUS, 'NanoCpus', true);
  if (host.MemorySwap !== undefined) {
    requirePositiveBoundedInt(host.MemorySwap, MAX_MEMORY, 'MemorySwap');
    if (Number(host.MemorySwap) < Number(host.Memory)) deny('MemorySwap may not be lower than Memory');
  }
  const mode = String(host.NetworkMode ?? 'none');
  validateNetworkMode(identity, mode);
  validateHostBinds(identity, host.Binds, trustedHostPaths);
  const mounts = managedVolumeMounts(body);
  validateMountShapeForRole(identity, mounts);
  validateCreationNetworking(identity, body, mode);
  return identity;
}

export function validateManagedExecCreate(bodyValue: unknown): void {
  const body = record(bodyValue);
  const allowed = new Set(['AttachStdout','AttachStderr','Tty','Cmd','WorkingDir','Env','User']);
  const extras = Object.keys(body).filter(k => !allowed.has(k));
  if (extras.length) deny(`unsupported Docker exec fields: ${extras.join(',')}`);
  if (body.AttachStdout !== true || body.AttachStderr !== true || body.Tty !== false) deny('Docker exec must use bounded non-TTY stdout/stderr framing');
  if (!Array.isArray(body.Cmd) || body.Cmd.length < 1 || body.Cmd.length > 256 || !body.Cmd.every(x => typeof x === 'string' && !x.includes('\0') && Buffer.byteLength(x,'utf8') <= 8192)) deny('Docker exec command is invalid or exceeds bounds');
  if (body.WorkingDir !== undefined && (typeof body.WorkingDir !== 'string' || !body.WorkingDir.startsWith('/') || body.WorkingDir.includes('\0') || Buffer.byteLength(body.WorkingDir,'utf8') > 4096)) deny('Docker exec working directory is invalid');
  if (body.Env !== undefined) {
    const env = stringArray(body.Env, 'Docker exec Env');
    if (env.length > 256 || env.some(x => x.includes('\0') || Buffer.byteLength(x,'utf8') > 8192) || env.reduce((n,x)=>n+Buffer.byteLength(x,'utf8'),0) > 64*1024) deny('Docker exec environment exceeds bounds');
  }
  if (body.User !== undefined && (typeof body.User !== 'string' || !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/u.test(body.User) || body.User.length > 128)) deny('Docker exec user is invalid');
}

export function validateManagedExecForIdentity(identity: ManagedIdentity, bodyValue: unknown): void {
  validateManagedExecCreate(bodyValue);
  const body = record(bodyValue);
  if (identity.scope !== 'sandbox') deny('managed GitHub helpers do not permit Docker exec');
  const cmd = body.Cmd as string[];
  const env = body.Env === undefined ? [] : stringArray(body.Env, 'Docker exec Env');
  if (identity.resource === 'git-helper') {
    if (body.User !== '0:0' || body.WorkingDir !== undefined || env.length !== 0 || cmd[0] !== 'git') {
      deny('git-helper exec is restricted to root git argv without env/working-dir override');
    }
    return;
  }
  if (identity.resource !== 'applier') deny('Docker exec is forbidden for this managed resource role');
  if (body.User !== '0:0' || body.WorkingDir !== undefined) deny('applier exec requires exact root identity without working-dir override');
  const isExact = (expected: readonly string[]): boolean => cmd.length === expected.length && cmd.every((v, i) => v === expected[i]);
  if (isExact(['node','-e',MOUNTINFO_CHECK_SCRIPT]) || isExact(['sh','-c',GIT_HOST_CHECK_SCRIPT]) || isExact(['node','-e',APPLY_MUTATION_SCRIPT])) {
    if (env.length !== 0) deny('applier fixed script exec may not carry environment overrides');
    return;
  }
  if (isExact(['node','-e',LIVE_STAT_SCRIPT])) {
    if (env.length !== 1 || !env[0]!.startsWith('STAT_TARGET_PATH=')) deny('live-stat exec requires exactly STAT_TARGET_PATH');
    const rel = env[0]!.slice('STAT_TARGET_PATH='.length);
    if (!rel || rel.length > 4096 || rel.includes('\0') || path.posix.isAbsolute(rel) || path.posix.normalize(rel) !== rel || rel === '..' || rel.startsWith('../')) {
      deny('STAT_TARGET_PATH must be a canonical project-relative path');
    }
    return;
  }
  deny('applier Docker exec command is outside the fixed apply contract');
}

export function validateManagedArchivePath(identity: ManagedIdentity, action: 'read' | 'write', pathValue: unknown): void {
  if (typeof pathValue !== 'string' || pathValue.length < 1 || pathValue.length > 4096 || pathValue.includes('\0') || !pathValue.startsWith('/') || path.posix.normalize(pathValue) !== pathValue) {
    deny('managed archive path must be an absolute canonical bounded path');
  }
  if (identity.scope === 'github') {
    if (action === 'write' && identity.resource === 'push-secret' && pathValue === '/secrets') return;
    deny('managed GitHub helper archive operation is not permitted');
  }
  if (action === 'write') {
    const exact: Record<string, string> = {
      secret: '/secrets', home: '/home/runner', control: '/run/control',
      'before-capture': '/evidence', 'evidence-io': '/evidence', applier: '/control',
    };
    if (exact[identity.resource] === pathValue) return;
    deny('managed archive write path is outside the resource role contract');
  }
  const roots: Record<string, string> = {
    'before-capture': '/workspace', 'post-capture': '/workspace',
    'evidence-io': '/evidence', 'evidence-read': '/evidence', applier: '/project',
  };
  const root = roots[identity.resource];
  if (root && (pathValue === root || pathValue.startsWith(`${root}/`))) return;
  deny('managed archive read path is outside the resource role contract');
}

export function validateManagedVolumeAttachment(container: ManagedIdentity, volume: ManagedIdentity, mount: ManagedVolumeMount): void {
  if (container.scope !== volume.scope) deny('managed volume and container ownership domains must match');
  if (container.scope === 'github') {
    if (container.operation !== volume.operation) deny('GitHub managed volume operation does not match container operation');
    const allowed = (container.resource === 'push-helper' && volume.resource === 'push-secret' && mount.Target === '/run/github-auth' && mount.ReadOnly)
      || (container.resource === 'push-secret' && volume.resource === 'push-secret' && mount.Target === '/secrets' && !mount.ReadOnly);
    if (!allowed) deny('GitHub managed volume is not permitted for this container role');
    return;
  }
  if (volume.resource === 'provider-session') {
    if (container.resource !== 'runner' || !container.providerBinding || container.providerBinding !== volume.providerBinding
      || mount.Target !== '/home/runner/.kiro/sessions/cli' || mount.ReadOnly) deny('provider-session volume binding does not match runner authority');
    return;
  }
  if (!container.job || container.job !== volume.job) deny('cross-job managed volume attachment is forbidden');
  const allowedPairs = new Set([
    'stager:workspace:/workspace:rw',
    'runner:workspace:/workspace:rw','runner:workspace:/workspace:ro','runner:secret:/run/secrets:ro','runner:home:/home/runner:rw','runner:control:/run/control:ro',
    'ollama-read-helper:workspace:/workspace:ro',
    'before-capture:workspace:/workspace:ro','before-capture:evidence:/evidence:rw',
    'post-capture:workspace:/workspace:ro',
    'evidence-read:evidence:/evidence:ro','evidence-io:evidence:/evidence:rw','evidence-rm:evidence:/evidence:rw',
    'applier:evidence:/artifact:ro','applier:control:/control:rw',
    'secret:secret:/secrets:rw','home:home:/home/runner:rw','control:control:/run/control:rw',
  ]);
  const key = `${container.resource}:${volume.resource}:${mount.Target}:${mount.ReadOnly ? 'ro' : 'rw'}`;
  if (!allowedPairs.has(key)) deny('managed volume resource is not permitted for this container role');
}

export function validateManagedVolumeCreate(name: unknown, labels: unknown): ManagedIdentity {
  if (typeof name !== 'string' || name.length < 1 || name.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name)) deny('managed volume name is invalid');
  const identity = managedIdentity(labels);
  assertCreationIdentity(identity);
  if (identity.scope === 'github') {
    if (identity.resource !== 'push-secret') deny('GitHub managed volume creation is restricted to push-secret');
    return identity;
  }
  if (!['workspace','evidence','provider-session','secret','home','control'].includes(identity.resource)) deny('resource role may not own a managed volume');
  if (identity.resource === 'provider-session' && !identity.providerBinding) deny('provider-session volume requires provider binding');
  return identity;
}

export function validateManagedNetworkCreate(name: unknown, internal: unknown, labels: unknown): ManagedIdentity {
  if (typeof name !== 'string') deny('managed network name must be a string');
  const identity = managedIdentity(labels);
  assertCreationIdentity(identity);
  if (identity.scope !== 'sandbox' || identity.resource !== 'net' || !identity.job) deny('managed network requires current job-scoped net labels');
  const base = `io-quarangate-net-${identity.job}`;
  const expected = new Map<string, boolean>([[base,true],[`${base}-ext`,false],[`${base}-copilot-int`,true],[`${base}-copilot-ext`,false]]);
  if (!expected.has(name) || expected.get(name) !== Boolean(internal)) deny('managed network name/internal policy mismatch');
  return identity;
}

export function validateManagedNetworkAttachment(network: ManagedIdentity, container: ManagedIdentity): void {
  if (network.scope !== 'sandbox' || network.resource !== 'net' || container.scope !== 'sandbox') deny('managed network attachment requires sandbox ownership');
  if (!network.job || !container.job || network.job !== container.job) deny('cross-job managed network attachment is forbidden');
  if (container.resource !== 'proxy') deny('only governed egress proxy containers may receive a second managed network attachment');
}

export function validateAuthorityRequest(value: unknown, trustedHostPaths: readonly string[] = []): { op: DockerAuthorityOperation; payload: Record<string, unknown> } {
  const req = record(value);
  if (typeof req.op !== 'string' || !DOCKER_AUTHORITY_OPERATIONS.includes(req.op as DockerAuthorityOperation)) deny('unsupported Docker authority operation');
  const payload = record(req.payload ?? {});
  if (req.op === 'container.createManaged') validateManagedContainerCreate(payload.body, trustedHostPaths);
  if (req.op === 'container.execManaged' && payload.action === 'create') validateManagedExecCreate(payload.body);
  if (req.op === 'volume.createManaged') validateManagedVolumeCreate(payload.name, payload.labels);
  if (req.op === 'network.createManaged') validateManagedNetworkCreate(payload.name, payload.internal, payload.labels);
  return { op: req.op as DockerAuthorityOperation, payload };
}
