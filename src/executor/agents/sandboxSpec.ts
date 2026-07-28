/**
 * Pure runner-sandbox policy → Docker request construction (Phase A3).
 *
 * This module contains NO Docker I/O. It deterministically translates trusted
 * internal policy (resource limits, network policy, ownership) into the exact
 * Docker Engine `create` bodies and the exact ownership labels used by
 * sandboxRunner.ts. Keeping it pure makes the security-critical container
 * configuration (non-root, non-privileged, cap-drop, read-only rootfs, no host
 * binds, no docker.sock, network isolation, resource limits) unit-testable
 * without a Docker daemon, and makes it impossible for a caller-controlled MCP
 * field to reach any of these fields — they are constructed here from trusted
 * inputs only.
 */
import { BridgeError } from '../../shared/errors.js';
import {
  AGENT_JOB_ID_PATTERN,
  type AgentNetworkPolicy,
  type AgentResourcePolicy,
} from '../../shared/agents.js';

// ---------------------------------------------------------------------------
// Ownership labels — the single authority for cleanup/reconciliation.
// ---------------------------------------------------------------------------

export const SANDBOX_LABEL_NS = 'io.mcp-ide-bridge';
export const LABEL_MANAGED = `${SANDBOX_LABEL_NS}.managed`;
export const LABEL_RESOURCE = `${SANDBOX_LABEL_NS}.resource`;
export const LABEL_JOB = `${SANDBOX_LABEL_NS}.job`;

export type SandboxResourceKind = 'runner' | 'stager' | 'workspace';

/** The Docker `filters` selector that matches ALL bridge-owned A3 resources. */
export const MANAGED_FILTER: Record<string, string[]> = { label: [`${LABEL_MANAGED}=true`] };

export function ownershipLabels(kind: SandboxResourceKind, jobId: string): Record<string, string> {
  assertJobId(jobId);
  return { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: kind, [LABEL_JOB]: jobId };
}

/** Authority for destructive cleanup: exact managed label must be present. */
export function isBridgeManaged(labels: Record<string, string> | null | undefined): boolean {
  return labels?.[LABEL_MANAGED] === 'true';
}

// ---------------------------------------------------------------------------
// Fixed trusted runtime identity.
// ---------------------------------------------------------------------------

/** Runner + stager execute non-root as this uid:gid (the sandbox image's `node`). */
export const RUNNER_UID = 1000;
export const RUNNER_GID = 1000;
export const RUNNER_USER = `${RUNNER_UID}:${RUNNER_GID}`;
export const WORKSPACE_PATH = '/workspace';
export const SOURCE_PATH = '/src';

function assertJobId(jobId: string): void {
  if (!AGENT_JOB_ID_PATTERN.test(jobId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'sandbox resource requires a valid job id', 400);
  }
}

export function workspaceVolumeName(jobId: string): string {
  assertJobId(jobId);
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-ws-${jobId}`;
}
export function runnerContainerName(jobId: string): string {
  assertJobId(jobId);
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-runner-${jobId}`;
}
export function stagerContainerName(jobId: string): string {
  assertJobId(jobId);
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-stager-${jobId}`;
}

// ---------------------------------------------------------------------------
// Resource policy → container limits (exact integer conversions).
// ---------------------------------------------------------------------------

export interface RunnerLimits {
  memoryBytes: number;
  memorySwapBytes: number; // == memoryBytes: swap disabled
  nanoCpus: number;
  pidsLimit: number;
  maxRuntimeMs: number;
  maxOutputBytes: number;
}

function requirePositiveInt(n: number, what: string): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new BridgeError('MALFORMED_REQUEST', `resource policy: ${what} must be a positive integer (got ${n})`, 400);
  }
  return n;
}

export function toRunnerLimits(policy: AgentResourcePolicy): RunnerLimits {
  const memoryBytes = requirePositiveInt(policy.maxMemoryBytes, 'maxMemoryBytes');
  const pidsLimit = requirePositiveInt(policy.maxPids, 'maxPids');
  const millicores = requirePositiveInt(policy.maxCpuMillicores, 'maxCpuMillicores');
  const maxRuntimeMs = requirePositiveInt(policy.maxRuntimeMs, 'maxRuntimeMs');
  const maxOutputBytes = requirePositiveInt(policy.maxOutputBytes, 'maxOutputBytes');
  // 1000 millicores == 1 CPU == 1e9 nanocpus  ⇒  nanocpus = millicores * 1e6.
  const nanoCpus = millicores * 1_000_000;
  return { memoryBytes, memorySwapBytes: memoryBytes, nanoCpus, pidsLimit, maxRuntimeMs, maxOutputBytes };
}

// ---------------------------------------------------------------------------
// Network policy → Docker NetworkMode (fail closed).
// ---------------------------------------------------------------------------

/**
 * A3 implements `deny` as real Docker isolation (NetworkMode "none"). The
 * `backend-only` contract exists but has no safe generic egress implementation
 * yet, so it FAILS CLOSED here — it is never silently treated as unrestricted.
 * A4 owns concrete provider egress.
 */
export function resolveNetworkMode(policy: AgentNetworkPolicy): 'none' {
  if (policy === 'deny') return 'none';
  throw new BridgeError(
    'FORBIDDEN_POLICY',
    `network policy "${policy}" has no A3 sandbox implementation; only "deny" is supported (fail closed)`,
    403,
  );
}

// ---------------------------------------------------------------------------
// Deterministic trusted commands.
// ---------------------------------------------------------------------------

/**
 * Staging command for a git project: verify a clean checkpoint, then stage the
 * tracked committed content of HEAD ONLY (no untracked, no ignored, no .git,
 * no host secrets). Emits `BASE_COMMIT=<sha>` on stdout. Fails closed:
 *   exit 3 = dirty working tree, 4 = not a git repo, 5 = no resolvable HEAD.
 */
export const GIT_STAGING_SCRIPT = [
  'set -e',
  `SD=${SOURCE_PATH}`,
  'GIT="git -c safe.directory=$SD -C $SD"',
  'if ! $GIT rev-parse --git-dir >/dev/null 2>&1; then echo NOT_A_GIT_REPO >&2; exit 4; fi',
  'if ! HEAD=$($GIT rev-parse HEAD 2>/dev/null); then echo NO_RESOLVABLE_HEAD >&2; exit 5; fi',
  'STATUS=$($GIT status --porcelain --untracked-files=all)',
  'if [ -n "$STATUS" ]; then echo DIRTY_WORKING_TREE >&2; exit 3; fi',
  `$GIT archive --format=tar HEAD | tar -x -C ${WORKSPACE_PATH}`,
  'echo "BASE_COMMIT=$HEAD"',
].join('\n');

/**
 * Deterministic internal probe. NOT caller-configurable. Proves: runs non-root,
 * reads the staged workspace, writes a marker ONLY inside /workspace, /tmp is
 * writable, the root filesystem is NOT writable, docker.sock is absent, and the
 * network is unreachable. Emits a single JSON evidence line on stdout.
 */
export const PROBE_SCRIPT = [
  'const fs=require("fs"),net=require("net");',
  'const out={uid:process.getuid(),gid:process.getgid(),files:[],staged:null,marker:null,tmp:null,rootfsWrite:null,dockerSock:false,network:null};',
  'function walk(d,b){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=b?b+"/"+e.name:e.name;const a=d+"/"+e.name;if(e.isDirectory())walk(a,p);else out.files.push(p);}}',
  'try{walk("' + WORKSPACE_PATH + '","");}catch(e){out.files=["ERR:"+e.code];}',
  'try{out.staged=fs.readFileSync(process.env.PROBE_READ_PATH,"utf8").trim();}catch(e){out.staged="ERR:"+e.code;}',
  'out.dockerSock=fs.existsSync("/var/run/docker.sock");',
  'try{fs.writeFileSync("' + WORKSPACE_PATH + '/.sandbox-marker","probe-"+(process.env.PROBE_JOB||""));out.marker="WROTE";}catch(e){out.marker="ERR:"+e.code;}',
  'try{fs.writeFileSync("/tmp/.probe-tmp","x");out.tmp="WROTE";}catch(e){out.tmp="ERR:"+e.code;}',
  'try{fs.writeFileSync("/.probe-rootfs","x");out.rootfsWrite="WROTE_BAD";}catch(e){out.rootfsWrite="DENIED:"+e.code;}',
  'const s=net.connect({host:"192.0.2.1",port:80});let done=false;',
  'const fin=(r)=>{if(done)return;done=true;try{s.destroy();}catch(_){}out.network=r;process.stdout.write(JSON.stringify(out)+"\\n");};',
  's.setTimeout(1500);',
  's.on("connect",()=>fin("CONNECTED_BAD"));',
  's.on("timeout",()=>fin("TIMEOUT"));',
  's.on("error",(e)=>fin("DENIED:"+e.code));',
].join('');

// ---------------------------------------------------------------------------
// Container create bodies (the security-critical policy translation).
// ---------------------------------------------------------------------------

export interface DockerCreateBody {
  Image: string;
  User: string;
  WorkingDir: string;
  Cmd: string[];
  Env: string[];
  Labels: Record<string, string>;
  NetworkDisabled?: boolean;
  HostConfig: Record<string, unknown>;
}

function hardenedHostConfig(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    AutoRemove: false,
    Privileged: false,
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    CapAdd: [],
    SecurityOpt: ['no-new-privileges'],
    GroupAdd: [],
    Devices: [],
    // Never share host namespaces.
    PidMode: '',
    IpcMode: 'private',
    UTSMode: '',
    UsernsMode: '',
    ...overrides,
  };
}

/**
 * Staging helper: the ONLY container that ever sees the trusted source, mounted
 * READ ONLY at /src. It writes the tracked snapshot into the RW workspace
 * volume. No docker.sock, no network, non-root, non-privileged, cap-drop ALL.
 */
export function buildStagerCreateBody(opts: {
  image: string;
  jobId: string;
  hostPath: string;
  volumeName: string;
}): DockerCreateBody {
  assertJobId(opts.jobId);
  if (!opts.hostPath.startsWith('/') || opts.hostPath.includes('\0')) {
    throw new BridgeError('MALFORMED_REQUEST', 'stager hostPath must be a trusted absolute path', 400);
  }
  return {
    Image: opts.image,
    User: RUNNER_USER,
    WorkingDir: '/tmp',
    Cmd: ['sh', '-c', GIT_STAGING_SCRIPT],
    Env: ['HOME=/tmp', 'GIT_OPTIONAL_LOCKS=0'],
    Labels: ownershipLabels('stager', opts.jobId),
    NetworkDisabled: true,
    HostConfig: hardenedHostConfig({
      // Read-only source bind is visible ONLY to this trusted helper.
      Binds: [`${opts.hostPath}:${SOURCE_PATH}:ro`],
      Mounts: [{ Type: 'volume', Source: opts.volumeName, Target: WORKSPACE_PATH, ReadOnly: false }],
      NetworkMode: 'none',
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m' },
    }),
  };
}

/**
 * Deterministic probe runner: receives ONLY the RW workspace volume (no host
 * bind at all, no docker.sock), runs non-root with a read-only root filesystem,
 * network denied, and hard resource limits derived from the trusted policy.
 */
export function buildRunnerCreateBody(opts: {
  image: string;
  jobId: string;
  volumeName: string;
  limits: RunnerLimits;
  networkMode: 'none';
  readRelPath: string;
}): DockerCreateBody {
  assertJobId(opts.jobId);
  const l = opts.limits;
  return {
    Image: opts.image,
    User: RUNNER_USER,
    WorkingDir: WORKSPACE_PATH,
    Cmd: ['node', '-e', PROBE_SCRIPT],
    Env: [
      `PROBE_READ_PATH=${WORKSPACE_PATH}/${opts.readRelPath}`,
      `PROBE_JOB=${opts.jobId}`,
      'HOME=/tmp',
    ],
    Labels: ownershipLabels('runner', opts.jobId),
    NetworkDisabled: true,
    HostConfig: hardenedHostConfig({
      // No host binds — the runner never receives host filesystem authority.
      Binds: [],
      Mounts: [{ Type: 'volume', Source: opts.volumeName, Target: WORKSPACE_PATH, ReadOnly: false }],
      NetworkMode: opts.networkMode,
      Memory: l.memoryBytes,
      MemorySwap: l.memorySwapBytes,
      NanoCpus: l.nanoCpus,
      PidsLimit: l.pidsLimit,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
    }),
  };
}
