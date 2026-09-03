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

/**
 * N1D: the QuaranGate ownership namespace. This is the ONLY namespace written
 * by this runtime. See MCP_IDE_BRIDGE_MASTER_PRD.md §47.4 for the migration
 * contract.
 */
export const SANDBOX_LABEL_NS = 'io.quarangate';

/**
 * N1D dual-read compatibility: pre-cutover resources carry one of these legacy
 * ownership namespaces. They are READ (recognised as bridge-managed, swept by
 * reconciliation, classified by the evidence lifecycle) but NEVER written.
 *
 *   io.mcp-ide-bridge — legacy sandbox/job ownership (SANDBOX_LABEL_NS pre-N1D)
 *   io.mcp-bridge     — legacy control/home + git-helper ownership (gitHelper.ts),
 *                       unified onto SANDBOX_LABEL_NS by N1D
 *
 * Deliberately NOT included: `mcp.bridge.*` (target opt-in discovery). That is a
 * functionally distinct, operator-authored namespace read by src/executor/targets.ts
 * and is out of the ownership/cleanup authority modelled here (§47.4).
 */
export const LEGACY_SANDBOX_LABEL_NAMESPACES: readonly string[] = Object.freeze([
  'io.mcp-ide-bridge',
  'io.mcp-bridge',
]);

/** Every namespace accepted on READ. New namespace first (preferred on tie). */
export const ACCEPTED_SANDBOX_LABEL_NAMESPACES: readonly string[] = Object.freeze([
  SANDBOX_LABEL_NS,
  ...LEGACY_SANDBOX_LABEL_NAMESPACES,
]);

/** Label suffixes that make up an ownership record. */
export type OwnershipLabelSuffix = 'managed' | 'resource' | 'job' | 'attempt';

export const LABEL_MANAGED = `${SANDBOX_LABEL_NS}.managed`;
export const LABEL_RESOURCE = `${SANDBOX_LABEL_NS}.resource`;
export const LABEL_JOB = `${SANDBOX_LABEL_NS}.job`;
/** A6-B5: additive label — the apply attempt owning an 'applier' container. */
export const LABEL_ATTEMPT = `${SANDBOX_LABEL_NS}.attempt`;

export type SandboxResourceKind = 'runner' | 'stager' | 'workspace' | 'evidence' | 'applier' | 'ollama-read-helper';

/**
 * The Docker `filters` selector matching bridge-owned A3 resources in the
 * CURRENT namespace only.
 *
 * Docker ANDs every entry of a `label` filter array, so a single filter can
 * never express "any of N namespaces". Callers that must see legacy resources
 * MUST iterate {@link managedLabelFilters} instead of using this constant.
 */
export const MANAGED_FILTER: Record<string, string[]> = { label: [`${LABEL_MANAGED}=true`] };

/**
 * One Docker filter per accepted namespace — the dual-read replacement for
 * {@link MANAGED_FILTER}. Each returned filter selects `<ns>.managed=true` plus
 * any additional suffix/value constraints, expressed in that same namespace.
 *
 * Results from these filters MUST be de-duplicated by the caller (a resource
 * carrying two namespaces appears in two responses).
 */
export function managedLabelFilters(
  extra: ReadonlyArray<readonly [OwnershipLabelSuffix, string]> = [],
): Array<Record<string, string[]>> {
  return ACCEPTED_SANDBOX_LABEL_NAMESPACES.map((ns) => ({
    label: [`${ns}.managed=true`, ...extra.map(([suffix, value]) => `${ns}.${suffix}=${value}`)],
  }));
}

export function ownershipLabels(kind: SandboxResourceKind, jobId: string): Record<string, string> {
  assertJobId(jobId);
  return { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: kind, [LABEL_JOB]: jobId };
}

/**
 * Read one ownership label across every accepted namespace.
 *
 * Fail-safe on ambiguity: if two accepted namespaces are present on the same
 * resource and disagree on the value, `null` is returned rather than an
 * arbitrary winner. Every caller treats `null` as "identity not proven", which
 * denies destructive action instead of guessing.
 */
export function ownershipLabelValue(
  labels: Record<string, string> | null | undefined,
  suffix: OwnershipLabelSuffix,
): string | null {
  if (!labels) return null;
  const seen = new Set<string>();
  for (const ns of ACCEPTED_SANDBOX_LABEL_NAMESPACES) {
    const v = labels[`${ns}.${suffix}`];
    if (typeof v === 'string') seen.add(v);
  }
  if (seen.size !== 1) return null; // absent (0) or contradictory (>1)
  return [...seen][0]!;
}

/**
 * Authority for destructive cleanup: the managed label must be present and
 * `"true"` in at least one accepted namespace, and no accepted namespace may
 * contradict it. A resource labelled managed=true in one namespace and
 * managed=false in another is NOT managed (fail-safe: never deleted).
 */
export function isBridgeManaged(labels: Record<string, string> | null | undefined): boolean {
  return ownershipLabelValue(labels, 'managed') === 'true';
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
// Evidence volume naming — N1D dual-recognition (§47.5).
// ---------------------------------------------------------------------------

/**
 * Prefix for evidence volumes CREATED by this runtime. Single source of truth
 * for both the creator (beforeCapture.ts) and the lifecycle owner
 * (evidenceCollector.ts) — they must never diverge, or retained evidence
 * becomes undeletable.
 */
export const EVIDENCE_VOLUME_PREFIX = `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-evidence-`;

/**
 * Evidence prefixes written by pre-N1D runtimes. Recognised on READ so that
 * historical evidence remains discoverable, classifiable, and — once its
 * retention has genuinely elapsed — still deletable. Historical evidence is
 * never renamed or destructively migrated (§47.5).
 */
export const LEGACY_EVIDENCE_VOLUME_PREFIXES: readonly string[] = Object.freeze([
  'io-mcp-ide-bridge-evidence-',
]);

/** Every evidence prefix accepted on READ. New prefix first. */
export const ACCEPTED_EVIDENCE_VOLUME_PREFIXES: readonly string[] = Object.freeze([
  EVIDENCE_VOLUME_PREFIX,
  ...LEGACY_EVIDENCE_VOLUME_PREFIXES,
]);

/** Deterministic evidence volume name for a NEW job. Never caller-influenced. */
export function evidenceVolumeName(jobId: string): string {
  return `${EVIDENCE_VOLUME_PREFIX}${jobId}`;
}

/**
 * Every deterministic evidence volume name a job may legitimately carry: the
 * current one plus each legacy equivalent. Used by identity proofs so a
 * pre-cutover job's recorded `artifact_volume` still correlates.
 */
export function acceptedEvidenceVolumeNames(jobId: string): string[] {
  return ACCEPTED_EVIDENCE_VOLUME_PREFIXES.map((p) => `${p}${jobId}`);
}

/**
 * Deterministic-name agreement check for an evidence volume recorded in the
 * job store. Exact match against a fixed, job-derived candidate set — the
 * caller's value is never used to build the name, only compared to it.
 */
export function isAcceptedEvidenceVolumeName(name: string, jobId: string): boolean {
  return acceptedEvidenceVolumeNames(jobId).includes(name);
}

/** True when a Docker volume name carries any accepted evidence prefix. */
export function hasAcceptedEvidenceVolumePrefix(name: string): boolean {
  return ACCEPTED_EVIDENCE_VOLUME_PREFIXES.some((p) => name.startsWith(p));
}

// ---------------------------------------------------------------------------
// A6-B5: trusted applier (project mutation) resource naming/labels.
// ---------------------------------------------------------------------------

/** `att_` + 32 lowercase hex chars — mirrors AGENT_JOB_ID_PATTERN's shape. */
export const AGENT_APPLY_ATTEMPT_ID_PATTERN = /^att_[0-9a-f]{32}$/;

function assertAttemptId(attemptId: string): void {
  if (!AGENT_APPLY_ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new BridgeError('MALFORMED_REQUEST', 'applier resource requires a valid attempt id', 400);
  }
}

export function applierContainerName(attemptId: string): string {
  assertAttemptId(attemptId);
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-applier-${attemptId}`;
}

/**
 * Applier ownership labels carry BOTH job and attempt identity (unlike every
 * other A3 resource kind, which is job-scoped only) — an 'applier' container
 * is scoped to exactly one apply attempt, and reconciliation/audit need both
 * dimensions.
 */
export function applierOwnershipLabels(jobId: string, attemptId: string): Record<string, string> {
  assertJobId(jobId);
  assertAttemptId(attemptId);
  return { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'applier', [LABEL_JOB]: jobId, [LABEL_ATTEMPT]: attemptId };
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
 *   exit 3 = dirty working tree, 4 = not a git repo, 5 = no resolvable HEAD,
 *   exit 6 = tracked symlink present while REJECT_SYMLINKS is set (A5 implement).
 *
 * A5 tracked-symlink policy (fail closed): when the env var REJECT_SYMLINKS is
 * non-empty (set ONLY for write/implement jobs — see buildStagerCreateBody),
 * the committed HEAD tree is scanned with `git ls-files -s` for ANY Git mode
 * 120000 (symlink) entry. If one exists, staging aborts with exit 6 BEFORE the
 * workspace is archived — so no symlink is ever materialized and the provider is
 * never reached. This applies to ALL tracked symlinks regardless of where their
 * target points (inside or outside the workspace). Read-only profiles leave
 * REJECT_SYMLINKS unset and are unaffected (A4 parity).
 */
export const GIT_STAGING_SCRIPT = [
  'set -e',
  `SD=${SOURCE_PATH}`,
  'GIT="git -c safe.directory=$SD -C $SD"',
  'if ! $GIT rev-parse --git-dir >/dev/null 2>&1; then echo NOT_A_GIT_REPO >&2; exit 4; fi',
  'if ! HEAD=$($GIT rev-parse HEAD 2>/dev/null); then echo NO_RESOLVABLE_HEAD >&2; exit 5; fi',
  'STATUS=$($GIT status --porcelain --untracked-files=all)',
  'if [ -n "$STATUS" ]; then echo DIRTY_WORKING_TREE >&2; exit 3; fi',
  'if [ -n "$REJECT_SYMLINKS" ]; then',
  '  SYMS=$($GIT ls-files -s | awk \'$1=="120000"{print $4}\');',
  '  if [ -n "$SYMS" ]; then echo "TRACKED_SYMLINK $SYMS" >&2; exit 6; fi',
  'fi',
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
  /**
   * A5: when true (write/implement jobs), the stager fails closed (exit 6) if
   * the committed HEAD tree contains ANY tracked symlink (Git mode 120000).
   * Read-only profiles omit this (default false) — A4 parity.
   */
  rejectTrackedSymlinks?: boolean;
}): DockerCreateBody {
  assertJobId(opts.jobId);
  if (!opts.hostPath.startsWith('/') || opts.hostPath.includes('\0')) {
    throw new BridgeError('MALFORMED_REQUEST', 'stager hostPath must be a trusted absolute path', 400);
  }
  const env = ['HOME=/tmp', 'GIT_OPTIONAL_LOCKS=0'];
  if (opts.rejectTrackedSymlinks) env.push('REJECT_SYMLINKS=1');
  return {
    Image: opts.image,
    User: RUNNER_USER,
    WorkingDir: '/tmp',
    Cmd: ['sh', '-c', GIT_STAGING_SCRIPT],
    Env: env,
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

// ---------------------------------------------------------------------------
// A5 — deterministic workspace content manifest (change detection input).
//
// Walks /workspace and emits ONE JSON line describing every regular file as
// [relPath, size, sha256hex]. Run by a trusted, hardened helper against the
// workspace volume mounted READ-ONLY (see buildManifestCreateBody) — the agent
// never produces this. Captured once on the pristine staged snapshot (baseline)
// and once after the runner exits (post); the pure diff lives in
// changeDetection.ts. NOT caller-configurable. Bounded: at most MANIFEST_MAX
// files, and files larger than the per-file hash bound are recorded as
// `LARGE:<size>` (still detected as changed on size delta) rather than hashed.
// ---------------------------------------------------------------------------

const MANIFEST_MAX_FILES = 20000;
const MANIFEST_MAX_HASH_BYTES = 8 * 1024 * 1024;

export const MANIFEST_SCRIPT = [
  'const fs=require("fs"),cp=require("crypto"),path=require("path");',
  'const ROOT="' + WORKSPACE_PATH + '";',
  'const MAXF=' + MANIFEST_MAX_FILES + ',MAXB=' + MANIFEST_MAX_HASH_BYTES + ';',
  'const out=[];let truncated=false;',
  'function walk(dir){',
  '  let ents;try{ents=fs.readdirSync(dir,{withFileTypes:true});}catch(e){return;}',
  '  ents.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);',
  '  for(const e of ents){',
  '    if(out.length>=MAXF){truncated=true;return;}',
  '    const abs=path.join(dir,e.name);',
  '    if(e.isSymbolicLink())continue;',
  '    if(e.isDirectory()){walk(abs);continue;}',
  '    if(!e.isFile())continue;',
  '    let st;try{st=fs.statSync(abs);}catch(_){continue;}',
  '    const rel=abs.slice(ROOT.length+1);',
  '    let sha;',
  '    if(st.size>MAXB){sha="LARGE:"+st.size;}',
  '    else{try{sha=cp.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");}catch(_){sha="ERR";}}',
  '    out.push([rel,st.size,sha]);',
  '  }',
  '}',
  'try{walk(ROOT);}catch(e){process.stdout.write(JSON.stringify({__manifest:true,ok:false,count:0,truncated:false,entries:[],error:String(e&&e.code||e)})+"\\n");process.exit(0);}',
  'out.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);',
  'process.stdout.write(JSON.stringify({__manifest:true,ok:true,count:out.length,truncated:truncated,entries:out})+"\\n");',
].join('');

/**
 * Hardened helper that reads the workspace volume READ-ONLY and emits the
 * content manifest. Same isolation as the A3 runner (non-root, RO rootfs,
 * cap-drop ALL, no host bind, no docker.sock, network denied) — but the
 * workspace is mounted READ-ONLY here because manifesting must never mutate the
 * snapshot it measures.
 */
export function buildManifestCreateBody(opts: {
  image: string;
  jobId: string;
  volumeName: string;
  limits: RunnerLimits;
}): DockerCreateBody {
  assertJobId(opts.jobId);
  const l = opts.limits;
  return {
    Image: opts.image,
    User: RUNNER_USER,
    WorkingDir: '/tmp',
    Cmd: ['node', '-e', MANIFEST_SCRIPT],
    Env: ['HOME=/tmp'],
    Labels: ownershipLabels('runner', opts.jobId),
    NetworkDisabled: true,
    HostConfig: hardenedHostConfig({
      Binds: [],
      Mounts: [{ Type: 'volume', Source: opts.volumeName, Target: WORKSPACE_PATH, ReadOnly: true }],
      NetworkMode: 'none',
      Memory: l.memoryBytes,
      MemorySwap: l.memorySwapBytes,
      NanoCpus: l.nanoCpus,
      PidsLimit: l.pidsLimit,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
    }),
  };
}

// ---------------------------------------------------------------------------
// A6-B5 — trusted deterministic applier.
//
// Reuses the SAME trusted helper image family as the stager/probe/git-helper
// (see PHASE_A6_B5_AGENT_APPLY.md §9 — no new image). The applier is a
// distinct CONTAINER ROLE: it receives the real registered project mounted
// RW at a fixed target, and the job's own B3/B4 evidence volume mounted RO
// at a fixed target. It runs as root-in-container (User '0:0') for the SAME
// reason gitHelper.ts already does against a host bind (reliable access
// regardless of host file ownership) — confinement comes from CapDrop ALL
// (minus the one capability that intent actually requires, see below) +
// Privileged false + no-new-privileges + no docker.sock + network none, not
// from UID alone. The container Cmd is always the fixed idle `sleep 300`;
// all real work happens via `docker exec` with fixed argv, matching
// gitHelper.ts's HELPER_IDLE_CMD pattern.
//
// TWO fixes below were found by REAL Docker testing (not merely designed on
// paper) and are documented here rather than silently folded in, since they
// each deviate slightly from the as-written PHASE_A6_B5_AGENT_APPLY.md text:
//
// 1. CapAdd: ['DAC_OVERRIDE', 'FOWNER']. A typical real project directory
//    tree is NOT world/group-accessible (e.g. a fresh `mkdtemp`-style
//    directory is 0700, and most real home-directory projects are similarly
//    owner-restricted). `CapDrop: ['ALL']` strips CAP_DAC_OVERRIDE, so
//    container-root loses the one capability that actually grants "root can
//    read/write/traverse any file regardless of on-disk permissions" —
//    without it, root-in-container behaves like an ordinary unprivileged UID
//    for DAC purposes and cannot even `git rev-parse` a 0700-owned checkout
//    it doesn't literally own by UID. DAC_OVERRIDE alone is NOT sufficient,
//    though: `chmod`/`fchmod` (needed by MODE_CHANGE, and by every atomic
//    write's own mode-setting step) is gated by a SEPARATE capability,
//    CAP_FOWNER ("bypass owner-based permission checks"), not DAC_OVERRIDE —
//    verified live: without FOWNER, `chmod` on a file owned by a different
//    UID fails with EPERM even with DAC_OVERRIDE present. Both capabilities
//    are the DIRECT mechanical requirement of the "reliable access
//    regardless of host file ownership" rationale already stated above (and
//    already used to justify running as root at all) — adding them back is
//    fulfilling that already-stated intent, not a new one. Every other
//    dropped capability remains dropped; this is the single narrowest fix.
// 2. A dedicated small RW control volume (not tmpfs). Docker's archive PUT
//    endpoint refuses writes into a tmpfs mount when `ReadonlyRootfs: true`
//    is set (`"container rootfs is marked read-only"`, verified against the
//    live Docker daemon) — evidently only bind/volume mounts are recognized
//    as writable destinations for that check, not tmpfs. `beforeCapture.ts`'s
//    `writeEvidenceToVolume` already proves `putArchive` against a genuine
//    RW named volume works fine under the identical `ReadonlyRootfs: true`
//    hardening — so the control file (ops manifest: hashes/modes/paths only,
//    never raw byte content, never real project data) now travels over a
//    third, executor-owned, attempt-scoped RW volume instead of `/tmp`.
// ---------------------------------------------------------------------------

export const PROJECT_PATH = '/project';
export const ARTIFACT_PATH = '/artifact';
export const CONTROL_PATH = '/control';
/** Control file the executor writes (via putArchive) before each exec phase. */
export const APPLY_CONTROL_FILE = `${CONTROL_PATH}/mcp-apply-ops.json`;

export function controlVolumeName(attemptId: string): string {
  assertAttemptId(attemptId);
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-control-${attemptId}`;
}

export function buildApplierCreateBody(opts: {
  image: string;
  jobId: string;
  attemptId: string;
  hostPath: string;
  artifactVolume: string;
  controlVolume: string;
  limits: RunnerLimits;
}): DockerCreateBody {
  assertJobId(opts.jobId);
  assertAttemptId(opts.attemptId);
  if (!opts.hostPath.startsWith('/') || opts.hostPath.includes('\0')) {
    throw new BridgeError('MALFORMED_REQUEST', 'applier hostPath must be a trusted absolute path', 400);
  }
  if (!opts.artifactVolume) {
    throw new BridgeError('MALFORMED_REQUEST', 'applier requires a trusted artifact volume', 400);
  }
  if (!opts.controlVolume) {
    throw new BridgeError('MALFORMED_REQUEST', 'applier requires a trusted control volume', 400);
  }
  const l = opts.limits;
  return {
    Image: opts.image,
    User: '0:0',
    WorkingDir: '/tmp',
    Cmd: ['sleep', '300'],
    Env: ['HOME=/tmp'],
    Labels: applierOwnershipLabels(opts.jobId, opts.attemptId),
    NetworkDisabled: true,
    HostConfig: hardenedHostConfig({
      // Exactly three mounts: the real project (RW, the only host-authority
      // bind an applier ever receives), the job's OWN evidence volume (RO —
      // never any other job's artifact, never caller-influenced), and a
      // small executor-owned scratch volume (RW) for the trusted control
      // file only — never real project content.
      Binds: [`${opts.hostPath}:${PROJECT_PATH}:rw`],
      Mounts: [
        { Type: 'volume', Source: opts.artifactVolume, Target: ARTIFACT_PATH, ReadOnly: true },
        { Type: 'volume', Source: opts.controlVolume, Target: CONTROL_PATH, ReadOnly: false },
      ],
      NetworkMode: 'none',
      // Narrowest possible restoration of root's normal DAC-bypass behavior —
      // see the module-level comment above. Every other capability stays dropped.
      CapAdd: ['DAC_OVERRIDE', 'FOWNER'],
      Memory: l.memoryBytes,
      MemorySwap: l.memorySwapBytes,
      NanoCpus: l.nanoCpus,
      PidsLimit: l.pidsLimit,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=32m' },
    }),
  };
}

/**
 * Nested-mount preflight (§7b). Reads /proc/self/mountinfo from inside the
 * applier and asserts no mount point is a strict descendant of PROJECT_PATH
 * other than the project bind itself. Malformed/unparseable mountinfo fails
 * closed. Emits one JSON line: {ok:true} or {ok:false, error}.
 */
export const MOUNTINFO_CHECK_SCRIPT = [
  'const fs=require("fs");',
  'const PROJECT="' + PROJECT_PATH + '";',
  'function out(o){process.stdout.write(JSON.stringify(o)+"\\n");}',
  'try{',
  '  const text=fs.readFileSync("/proc/self/mountinfo","utf8");',
  '  const lines=text.split("\\n").filter(function(l){return l.length>0;});',
  '  for(const line of lines){',
  '    const parts=line.split(" ");',
  '    if(parts.length<5){out({ok:false,error:"malformed mountinfo line"});process.exit(1);}',
  '    const mp=parts[4];',
  '    if(mp===PROJECT)continue;',
  '    if(mp.indexOf(PROJECT+"/")===0){out({ok:false,error:"nested mount detected at "+mp});process.exit(1);}',
  '  }',
  '  out({ok:true});',
  '  process.exit(0);',
  '}catch(e){',
  '  out({ok:false,error:String(e&&e.message||e)});',
  '  process.exit(1);',
  '}',
].join('');

/**
 * Live filesystem stat helper (F4 hardlink remediation).
 *
 * Reads a single project-relative path via lstatSync and emits one JSON line:
 *   {ok:true, exists:boolean, kind:string, mode:number, nlink:number, size:number}
 * or {ok:false, error:string}
 *
 * The path is supplied via env var STAT_TARGET_PATH (project-relative).
 * Never follows symlinks. Used by applyEngine for live nlink checks during
 * BEFORE recertification (replacing the unreliable tar-header nlink).
 */
export const LIVE_STAT_SCRIPT = [
  'const fs=require("fs"),path=require("path");',
  'const PROJECT="' + PROJECT_PATH + '";',
  'const rel=process.env.STAT_TARGET_PATH;',
  'function out(o){process.stdout.write(JSON.stringify(o)+"\\n");}',
  'if(!rel){out({ok:false,error:"missing STAT_TARGET_PATH"});process.exit(1);}',
  'const full=path.join(PROJECT,rel);',
  'if(!(full===PROJECT||full.indexOf(PROJECT+path.sep)===0)){out({ok:false,error:"path escapes project"});process.exit(1);}',
  'try{',
  '  const st=fs.lstatSync(full);',
  '  let kind="other";',
  '  if(st.isFile())kind="file";',
  '  else if(st.isDirectory())kind="dir";',
  '  else if(st.isSymbolicLink())kind="symlink";',
  '  out({ok:true,exists:true,kind:kind,mode:st.mode&0o7777,nlink:st.nlink,size:st.size});',
  '  process.exit(0);',
  '}catch(e){',
  '  if(e&&e.code==="ENOENT"){out({ok:true,exists:false});process.exit(0);}',
  '  out({ok:false,error:String(e&&e.message||e)});',
  '  process.exit(1);',
  '}',
].join('');

/**
 * Live host repository-identity / stale-HEAD / dirty-host / sequencer-state
 * check (§7a) against the REAL project bind — reuses the exact dirty-check
 * discipline already proven in GIT_STAGING_SCRIPT (porcelain,
 * --untracked-files=all), minus the `git archive` materialization step
 * (nothing is staged; this only inspects). Exit codes mirror
 * GIT_STAGING_SCRIPT's convention: 3=dirty, 4=not a repo, 5=no HEAD,
 * 7=sequencer operation in progress (new — GIT_STAGING_SCRIPT has no
 * sequencer check because A3 staging always starts from a fresh checkout).
 * On success prints `HEAD=<40-hex>` on stdout.
 */
export const GIT_HOST_CHECK_SCRIPT = [
  'set -e',
  `PD=${PROJECT_PATH}`,
  'GIT="git -c safe.directory=$PD -C $PD"',
  'if ! $GIT rev-parse --git-dir >/dev/null 2>&1; then echo NOT_A_GIT_REPO >&2; exit 4; fi',
  'if ! HEAD=$($GIT rev-parse HEAD 2>/dev/null); then echo NO_RESOLVABLE_HEAD >&2; exit 5; fi',
  'if [ -f "$PD/.git/MERGE_HEAD" ] || [ -d "$PD/.git/rebase-merge" ] || [ -d "$PD/.git/rebase-apply" ] || [ -f "$PD/.git/CHERRY_PICK_HEAD" ] || [ -f "$PD/.git/REVERT_HEAD" ]; then',
  '  echo SEQUENCER_STATE >&2',
  '  exit 7',
  'fi',
  'STATUS=$($GIT status --porcelain --untracked-files=all)',
  'if [ -n "$STATUS" ]; then echo DIRTY_WORKING_TREE >&2; exit 3; fi',
  'echo "HEAD=$HEAD"',
].join('\n');

/**
 * Deterministic mutation/rollback executor — ONE OP PER EXEC (§11/§13).
 *
 * PROTOCOL CHANGE (F1 remediation): each exec invocation processes exactly
 * ONE op (ops[0] from the control file). The executor writes a single-op
 * control file, execs, durably persists the journal row, then proceeds to the
 * next op. This closes the window where a container kill/OOM/exec failure
 * between the filesystem syscall and the completion emit could leave a real
 * mutation with no journal row.
 *
 * control = { mode: 'apply' | 'rollback', opIndex: number, op: {...} }
 *
 * apply op:     { path, op, beforeHash?, beforeMode?, postHash, postSize, postMode }
 * rollback op:  { path, op, beforeHash?, beforeSize?, beforeMode?,
 *                 postHash?, postSize?, postMode?, createdDirs? }
 *
 * Emits exactly ONE JSON line on stdout:
 *   success: { opIndex, ok: true, path, op, createdDirs? }
 *   failure: { opIndex, ok: false, error }
 *
 * HARDLINK DEFENSE (F4): requireSingleLinkRegularFile() used for all
 * existing targets — asserts lstat.nlink===1. A hardlink (nlink>1) is refused
 * before any read/write/chmod to prevent inode-sharing from extending chmod
 * effects outside the /project bind. The ADD case (file must be absent before
 * write) is unaffected by requireSingleLinkRegularFile; single-link is
 * instead checked POST-publication, in-script, by atomicWriteNew itself
 * (an lstatSync(dest).nlink!==1 check immediately after linkSync succeeds) —
 * a defense against the destination unexpectedly landing on a pre-existing
 * hardlinked inode.
 *
 * ADD NO-CLOBBER (F5): atomicWriteNew() publishes via an exclusive sibling
 * temp file (O_CREAT|O_EXCL) holding the exact POST bytes/mode, then
 * fs.linkSync(tmp, finalPath) — linkSync atomically fails with EEXIST if
 * finalPath already exists, so a concurrent create after the earlier absence
 * check causes the op to fail cleanly with no TOCTOU window (there is no
 * separate lstat-then-rename step for ADD; finalPath is never clobbered).
 * The temp is unlinked after successful publication, and the live nlink
 * sanity check above then confirms the publication landed cleanly.
 *
 * ADD ROLLBACK INTERFERENCE (F3): before unlinking a journaled ADD target,
 * the live file must exactly match this attempt's POST state (hash + size +
 * mode + nlink===1). Any mismatch means external interference; the script
 * fails closed (→ UNCERTAIN upstream).
 *
 * SYMLINK DEFENSE (unchanged): every existence/type check uses lstatSync.
 * Intermediate path components that are symlinks are refused by
 * ensureParentDirs. Final targets that are symlinks return isFile()=false
 * from lstatSync and are refused by requireSingleLinkRegularFile.
 */
export const APPLY_MUTATION_SCRIPT = [
  'const fs=require("fs"),crypto=require("crypto"),path=require("path");',
  'const CONTROL="' + APPLY_CONTROL_FILE + '";',
  'const PROJECT="' + PROJECT_PATH + '";',
  'const BLOBS="' + ARTIFACT_PATH + '/blobs";',
  'function sha256(b){return crypto.createHash("sha256").update(b).digest("hex");}',
  'function blobPath(h){return BLOBS+"/"+h.slice(0,2)+"/"+h;}',
  'function emit(o){process.stdout.write(JSON.stringify(o)+"\\n");}',
  'function safeLstat(p){try{return fs.lstatSync(p);}catch(e){if(e&&e.code==="ENOENT")return null;throw e;}}',
  // F4: requireSingleLinkRegularFile — used for all EXISTING target reads
  // (CONTENT_MODIFY, DELETE, MODE_CHANGE forward; all rollback ops that read
  // the live target). Refuses symlinks (isFile()=false), special files
  // (isFile()=false), and hardlinks (nlink>1).
  'function requireSingleLinkRegularFile(fullPath){',
  '  const st=safeLstat(fullPath);',
  '  if(st===null)throw new Error("target does not exist: "+fullPath);',
  '  if(!st.isFile())throw new Error("target is not a regular file (possible symlink/special file): "+fullPath);',
  '  if(st.nlink!==1)throw new Error("target has "+st.nlink+" hard links (nlink must be 1): "+fullPath);',
  '  return st;}',
  'function readBlob(hash,size){const p=blobPath(hash);const buf=fs.readFileSync(p);',
  '  if(buf.length!==size)throw new Error("blob size mismatch for "+hash);',
  '  if(sha256(buf)!==hash)throw new Error("blob hash mismatch for "+hash);',
  '  return buf;}',
  // F5: atomicWriteNew — exclusive create for ADD. Uses linkSync (hard link)
  // publication which atomically fails with EEXIST if dest already exists,
  // providing no-clobber semantics without a TOCTOU window (linkSync never
  // overwrites an existing file). After successful link, verify single-link.
  'function atomicWriteNew(dest,buf,mode){',
  '  const dir=path.dirname(dest);',
  '  const tmp=path.join(dir,".mcp-apply-"+crypto.randomBytes(8).toString("hex")+".tmp");',
  '  try{',
  '    fs.writeFileSync(tmp,buf,{mode:mode,flag:"wx"});',
  '    fs.chmodSync(tmp,mode);',
  '    fs.linkSync(tmp,dest);',
  '    fs.unlinkSync(tmp);',
  '    const st=fs.lstatSync(dest);',
  '    if(st.nlink!==1)throw new Error("ADD target has unexpected nlink after publication: "+st.nlink);',
  '  }catch(e){try{fs.unlinkSync(tmp);}catch(_){}throw e;}}',
  // atomicWriteExisting — for CONTENT_MODIFY / rollback of DELETE/MODE_CHANGE
  // (target known to exist; rename replaces it atomically on Linux).
  'function atomicWriteExisting(dest,buf,mode){',
  '  const dir=path.dirname(dest);',
  '  const tmp=path.join(dir,".mcp-apply-"+crypto.randomBytes(8).toString("hex")+".tmp");',
  '  try{',
  '    fs.writeFileSync(tmp,buf,{mode:mode,flag:"wx"});',
  '    fs.chmodSync(tmp,mode);',
  '    fs.renameSync(tmp,dest);',
  '  }catch(e){try{fs.unlinkSync(tmp);}catch(_){}throw e;}}',
  'function ensureParentDirs(fullPath,createdOut){const rel=path.relative(PROJECT,fullPath);',
  '  const segs=rel.split(path.sep).slice(0,-1);let cur=PROJECT;',
  '  for(const seg of segs){cur=path.join(cur,seg);',
  '    const st=safeLstat(cur);',
  '    if(st===null){fs.mkdirSync(cur,{recursive:false,mode:0o755});fs.chmodSync(cur,0o755);createdOut.push(cur);}',
  '    else if(!st.isDirectory())throw new Error("path component exists and is not a real directory (possible symlink): "+cur);}}',
  'let control;',
  'try{control=JSON.parse(fs.readFileSync(CONTROL,"utf8"));}',
  'catch(e){emit({opIndex:-1,ok:false,error:"cannot read control file: "+(e&&e.message||e)});process.exit(1);}',
  // Single-op protocol: control has { mode, opIndex, op } not { mode, ops[] }
  'const mode=control.mode;',
  'const opIndex=control.opIndex;',
  'const op=control.op;',
  'if(typeof opIndex!=="number"||!op){emit({opIndex:-1,ok:false,error:"malformed control: missing opIndex or op"});process.exit(1);}',
  'const finalPath=path.join(PROJECT,op.path);',  // note: referenced in atomicWriteNew closure above
  'if(!(finalPath===PROJECT||finalPath.indexOf(PROJECT+path.sep)===0)){',
  '  emit({opIndex:opIndex,ok:false,error:"path escapes project root: "+op.path});process.exit(1);}',
  'try{',
  '  if(mode==="apply"){',
  '    if(op.op==="ADD"){',
  // F5: check absence first
  '      if(safeLstat(finalPath)!==null)throw new Error("ADD target unexpectedly exists before write");',
  '      const created=[];ensureParentDirs(finalPath,created);',
  '      const buf=readBlob(op.postHash,op.postSize);',
  // F5: atomicWriteNew checks finalPath again before rename
  '      atomicWriteNew(finalPath,buf,op.postMode);',
  '      emit({opIndex:opIndex,ok:true,path:op.path,op:op.op,createdDirs:created});',
  '    }else if(op.op==="CONTENT_MODIFY"){',
  // F4: single-link check
  '      const lst=requireSingleLinkRegularFile(finalPath);',
  '      const cur=fs.readFileSync(finalPath);if(sha256(cur)!==op.beforeHash)throw new Error("preimage content mismatch");',
  '      if((lst.mode&0o7777)!==op.beforeMode)throw new Error("preimage mode mismatch");',
  '      const buf=readBlob(op.postHash,op.postSize);atomicWriteExisting(finalPath,buf,op.postMode);',
  '      emit({opIndex:opIndex,ok:true,path:op.path,op:op.op});',
  '    }else if(op.op==="DELETE"){',
  // F4: single-link check
  '      const lst=requireSingleLinkRegularFile(finalPath);',
  '      const cur=fs.readFileSync(finalPath);if(sha256(cur)!==op.beforeHash)throw new Error("preimage content mismatch");',
  '      if((lst.mode&0o7777)!==op.beforeMode)throw new Error("preimage mode mismatch");',
  '      fs.unlinkSync(finalPath);emit({opIndex:opIndex,ok:true,path:op.path,op:op.op});',
  '    }else if(op.op==="MODE_CHANGE"){',
  // F4: single-link check
  '      const lst=requireSingleLinkRegularFile(finalPath);',
  '      const cur=fs.readFileSync(finalPath);if(sha256(cur)!==op.beforeHash)throw new Error("content changed, refusing mode change");',
  '      if((lst.mode&0o7777)!==op.beforeMode)throw new Error("preimage mode mismatch");',
  '      fs.chmodSync(finalPath,op.postMode);emit({opIndex:opIndex,ok:true,path:op.path,op:op.op});',
  '    }else{throw new Error("unsupported op: "+op.op);}',
  '  }else if(mode==="rollback"){',
  '    if(op.op==="ADD"){',
  // F3: verify live target still exactly matches this attempt's POST before deleting
  '      const lst=requireSingleLinkRegularFile(finalPath);',
  '      const cur=fs.readFileSync(finalPath);',
  '      if(sha256(cur)!==op.postHash)throw new Error("ADD rollback: live file hash no longer matches attempt POST; refusing to delete (external interference?)");',
  '      if(cur.length!==op.postSize)throw new Error("ADD rollback: live file size no longer matches attempt POST; refusing to delete");',
  '      if((lst.mode&0o7777)!==op.postMode)throw new Error("ADD rollback: live file mode no longer matches attempt POST; refusing to delete");',
  '      fs.unlinkSync(finalPath);',
  '      const dirs=(op.createdDirs||[]).slice().reverse();',
  '      for(const d of dirs){const dst=safeLstat(d);if(dst===null)continue;',
  '        if(!dst.isDirectory())throw new Error("journaled created dir is not a real directory: "+d);',
  '        const entries=fs.readdirSync(d);',
  '        if(entries.length===0)fs.rmdirSync(d);else throw new Error("cannot remove non-empty created directory: "+d);}',
  '      emit({opIndex:opIndex,ok:true,path:op.path,op:op.op});',
  '    }else if(op.op==="CONTENT_MODIFY"){',
  // F4: single-link check on rollback read
  '      const lst=requireSingleLinkRegularFile(finalPath);',
  '      const cur=fs.readFileSync(finalPath);',
  '      if(sha256(cur)!==op.postHash)throw new Error("live file no longer matches what this attempt wrote; refusing to roll back");',
  '      if((lst.mode&0o7777)!==op.postMode)throw new Error("live mode no longer matches what this attempt wrote; refusing to roll back");',
  '      const buf=readBlob(op.beforeHash,op.beforeSize);atomicWriteExisting(finalPath,buf,op.beforeMode);',
  '      emit({opIndex:opIndex,ok:true,path:op.path,op:op.op});',
  '    }else if(op.op==="DELETE"){',
  '      if(safeLstat(finalPath)!==null)throw new Error("live path unexpectedly exists; refusing to recreate over it");',
  '      const created=[];ensureParentDirs(finalPath,created);',
  '      const buf=readBlob(op.beforeHash,op.beforeSize);atomicWriteNew(finalPath,buf,op.beforeMode);',
  '      emit({opIndex:opIndex,ok:true,path:op.path,op:op.op});',
  '    }else if(op.op==="MODE_CHANGE"){',
  // F4: single-link check on rollback read
  '      const lst=requireSingleLinkRegularFile(finalPath);',
  '      const cur=fs.readFileSync(finalPath);',
  '      if(sha256(cur)!==op.postHash)throw new Error("live content no longer matches what this attempt wrote; refusing to roll back");',
  '      if((lst.mode&0o7777)!==op.postMode)throw new Error("live mode no longer matches what this attempt wrote; refusing to roll back");',
  '      fs.chmodSync(finalPath,op.beforeMode);emit({opIndex:opIndex,ok:true,path:op.path,op:op.op});',
  '    }else{throw new Error("unsupported rollback op: "+op.op);}',
  '  }else{throw new Error("unknown mode: "+mode);}',
  '}catch(e){emit({opIndex:opIndex,ok:false,error:e&&e.message?e.message:String(e)});process.exit(1);}',
  'process.exit(0);',
].join('');

// ---------------------------------------------------------------------------
// O1 — Ollama read-helper (per-job, read-only workspace access).
//
// A trusted, hardened helper container that exposes the staged committed-HEAD
// workspace snapshot READ-ONLY to Ollama tool calls. The model never reads
// directly from the mutable host worktree.
//
// Security posture (mirrors buildManifestCreateBody — same trust level):
//   - workspace volume mounted READ-ONLY (model cannot mutate staged snapshot)
//   - NetworkMode: none / NetworkDisabled: true (no network access)
//   - ReadonlyRootfs: true (from hardenedHostConfig)
//   - CapDrop: ALL (from hardenedHostConfig)
//   - no-new-privileges (from hardenedHostConfig)
//   - Non-root user (RUNNER_USER = 1000:1000)
//   - No host binds, no docker.sock, no devices
//   - Bounded memory/PIDs/tmpfs from trusted RunnerLimits
//   - Managed resource label: kind = 'ollama-read-helper'
//
// Lifetime: idle `sleep` keepalive, duration derived from maxRuntimeMs plus
// a fixed bounded cleanup grace (60 s). The model/caller cannot control the
// keepalive command or duration.
// ---------------------------------------------------------------------------

/** O1 fixed cleanup grace added to maxRuntimeMs for helper keepalive (ms). */
const OLLAMA_HELPER_GRACE_MS = 60_000;

/**
 * Deterministic name for the Ollama read-helper container scoped to one job.
 * Never caller-influenced.
 */
export function ollamaReadHelperContainerName(jobId: string): string {
  assertJobId(jobId);
  return `${SANDBOX_LABEL_NS.replace(/\./g, '-')}-ollama-helper-${jobId}`;
}

/**
 * Build a hardened Ollama read-helper container create body.
 *
 * The helper mounts the staged workspace volume READ-ONLY and runs an idle
 * keepalive. All real workspace reads happen via `docker exec` from the
 * executor. The container has no network, no capabilities, no host binds,
 * and a read-only root filesystem.
 */
export function buildOllamaReadHelperCreateBody(opts: {
  image: string;
  jobId: string;
  workspaceVolumeName: string;
  limits: RunnerLimits;
}): DockerCreateBody {
  assertJobId(opts.jobId);
  const l = opts.limits;
  // Derive keepalive duration from trusted maxRuntimeMs (bounded, not caller-set)
  const keepaliveSeconds = Math.ceil((l.maxRuntimeMs + OLLAMA_HELPER_GRACE_MS) / 1000);
  return {
    Image: opts.image,
    User: RUNNER_USER,
    WorkingDir: WORKSPACE_PATH,
    // Idle keepalive — real work happens via docker exec (no model control)
    Cmd: ['sleep', String(keepaliveSeconds)],
    Env: ['HOME=/tmp'],
    Labels: ownershipLabels('ollama-read-helper', opts.jobId),
    NetworkDisabled: true,
    HostConfig: hardenedHostConfig({
      // Read-only workspace volume — model can never mutate the staged snapshot
      Binds: [],
      Mounts: [
        {
          Type: 'volume',
          Source: opts.workspaceVolumeName,
          Target: WORKSPACE_PATH,
          ReadOnly: true,
        },
      ],
      NetworkMode: 'none',
      Memory: l.memoryBytes,
      MemorySwap: l.memorySwapBytes,
      NanoCpus: l.nanoCpus,
      PidsLimit: l.pidsLimit,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m' },
      // No devices, no docker.sock, no host binds
      Devices: [],
      GroupAdd: [],
    }),
  };
}
