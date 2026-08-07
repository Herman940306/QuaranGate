/**
 * A6-B5: agent_apply orchestration.
 *
 * Implements the flow frozen in docs/audits/PHASE_A6_B5_AGENT_APPLY.md §3,
 * with the following security remediations applied:
 *
 * F1 — Per-op exec + journal before next op:
 *   Each mutation op is a separate Docker exec with its own single-op control
 *   file. The journal row is committed durably BEFORE the next op is started.
 *   A container kill/OOM between the filesystem syscall and the completion emit
 *   leaves the attempt in APPLYING — restart recovery unconditionally marks it
 *   UNCERTAIN (per B1 frozen policy), which is the correct fail-closed outcome.
 *   Journal length === 0 is no longer treated as "provably nothing happened";
 *   only the VERIFYING→APPLYING precondition window retains that guarantee.
 *
 * F2 — Post-APPLYING exception funnel:
 *   All awaited operations after VERIFYING→APPLYING are wrapped in a single
 *   try/catch. Any unexpected throw (Docker infra error, journal failure, etc.)
 *   is funneled through rollbackAndFail/markApplyUncertain so the attempt never
 *   stays stuck at APPLYING through the live call path.
 *
 * F4 — Hardlink confinement:
 *   Live filesystem nlink (LiveStatResult, from liveStatProjectPath /
 *   LIVE_STAT_SCRIPT's real lstatSync()) is the sole authority for hardlink
 *   detection — archive/tar reads (HostReadResult) never carry an nlink field
 *   at all, since tar metadata cannot represent live link-count authority.
 *   The BEFORE recertification check refuses any existing target with
 *   nlink > 1 (HOST_PRECERTIFICATION_FAILED, zero mutation), and rejects any
 *   non-integer/non-positive live nlink by throwing rather than defaulting.
 *   APPLY_MUTATION_SCRIPT independently enforces nlink===1 via
 *   requireSingleLinkRegularFile.
 *
 * F3/F5 — ADD rollback interference + ADD no-clobber:
 *   Both implemented in APPLY_MUTATION_SCRIPT (sandboxSpec.ts). No additional
 *   applyEngine.ts changes are required for these — the script emits a failure
 *   line, which applyEngine treats as a failed op and routes through rollback.
 *
 * This module owns NO Docker I/O of its own beyond what {@link ApplierIO}
 * exposes (a narrow, injectable seam — production uses
 * {@link createDockerApplierIO}, tests inject an in-memory fake). It reuses,
 * rather than duplicates:
 *   - the frozen B1 atomic admission/success primitives (jobStore.ts)
 *   - the frozen B4 hardened artifact reader (artifactReader.ts)
 *   - the frozen P1 guarded-path/path-safety policy (applyPolicy.ts)
 *   - the trusted container spec + literal scripts (sandboxSpec.ts)
 *
 * Zero source bytes are held in SQLite: the journal records path/op/hash/mode
 * metadata only; actual content always comes from the already-verified
 * artifact's blobs, read fresh from the evidence volume for each mutation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { extract as tarExtract, pack as tarPack } from 'tar-stream';
import { BridgeError } from '../../shared/errors.js';
import type { AgentProjectConfig } from '../agentConfig.js';
import type { AgentResourcePolicy } from '../../shared/agents.js';
import {
  createContainer as dockerCreateContainer,
  startContainer as dockerStartContainer,
  removeContainer as dockerRemoveContainer,
  execCreate as dockerExecCreate,
  execStartStream as dockerExecStartStream,
  execInspect as dockerExecInspect,
  putArchive as dockerPutArchive,
  getArchive as dockerGetArchive,
  createVolume as dockerCreateVolume,
  removeVolume as dockerRemoveVolume,
} from '../docker.js';
import { AgentJobStore, type AgentJobRow, type AgentApplyJournalRow } from './jobStore.js';
import { verifyCanonicalArtifact, readBounded, type VerifiedArtifact } from './artifactReader.js';
import type { EvidenceReaderFactory } from './jobEngine.js';
import { assertChangesetNotGuarded, validateApplyPath, assertSupportedRegularFileMode } from './applyPolicy.js';
import {
  buildApplierCreateBody, applierContainerName, controlVolumeName, applierOwnershipLabels, toRunnerLimits,
  MOUNTINFO_CHECK_SCRIPT, GIT_HOST_CHECK_SCRIPT, APPLY_MUTATION_SCRIPT, LIVE_STAT_SCRIPT,
  PROJECT_PATH, CONTROL_PATH, APPLY_CONTROL_FILE,
} from './sandboxSpec.js';
import type { SnapshotEntry, CanonicalChangeEntry } from './canonicalJson.js';

function log(msg: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', msg, ...fields }));
}

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Injectable Docker seam (production: createDockerApplierIO; tests: fakes)
// ---------------------------------------------------------------------------

/**
 * Result of a Docker archive (tar) read against a live project path. Archive
 * metadata cannot represent live hardlink-count authority (tar headers are
 * not a reliable source for `nlink`), so this type deliberately carries NO
 * `nlink` field at all — it must never be used, or be usable, for any
 * hardlink security decision. See {@link LiveStatResult} for that.
 */
export type HostReadResult =
  | { exists: false }
  | { exists: true; kind: 'file'; sha256: string; sizeBytes: number; mode: number }
  | { exists: true; kind: 'other' };

/**
 * Result of a real in-container `lstatSync()` (via `liveStatProjectPath` /
 * `LIVE_STAT_SCRIPT`). This is the SOLE authority for hardlink detection
 * (F4) — `nlink` here is always a validated positive integer; malformed,
 * fractional, or missing values are rejected by throwing before this type is
 * ever constructed (see `createDockerApplierIO().liveStatProjectPath`).
 */
export type LiveStatResult =
  | { exists: false }
  | { exists: true; kind: 'file'; mode: number; sizeBytes: number; nlink: number }
  | { exists: true; kind: 'other' };

export interface ApplierExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ApplierIO {
  createContainer(name: string, body: Record<string, unknown>): Promise<string>;
  startContainer(id: string): Promise<void>;
  removeContainer(id: string, force?: boolean): Promise<void>;
  /** Runs one exec to completion (argv, never a shell string) and collects bounded output. */
  exec(containerId: string, cmd: string[]): Promise<ApplierExecResult>;
  /** Runs one exec with environment variables. */
  execWithEnv(containerId: string, cmd: string[], env: Record<string, string>): Promise<ApplierExecResult>;
  putArchive(containerId: string, absDir: string, tarBuffer: Buffer): Promise<void>;
  /** Single-path read against the applier's PROJECT_PATH mount via the Docker archive API. Never carries nlink. */
  readProjectPath(containerId: string, relPath: string): Promise<HostReadResult>;
  /** Live filesystem stat via LIVE_STAT_SCRIPT — the sole nlink authority (F4 hardlink remediation). */
  liveStatProjectPath(containerId: string, relPath: string): Promise<LiveStatResult>;
  /** Small executor-owned scratch volume for the control file — see sandboxSpec.ts's CONTROL_PATH comment. */
  createControlVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeControlVolume(name: string, force?: boolean): Promise<void>;
}

/** Generous per-file read ceiling for live host reads — same order of magnitude as B3/B4 evidence bounds. */
const MAX_HOST_READ_BYTES = 64 * 1024 * 1024;

/** Parse a single-entry tar stream into a HostReadResult (bounded, never following symlinks as content). */
async function extractSingleEntryWithMode(tarStream: Readable): Promise<HostReadResult> {
  return new Promise<HostReadResult>((resolve, reject) => {
    let settled = false;
    const ex = tarExtract();
    const teardown = (): void => {
      if (!ex.destroyed) ex.destroy();
      if (!tarStream.destroyed) tarStream.destroy();
    };
    const settle = (v: HostReadResult): void => { if (settled) return; settled = true; teardown(); resolve(v); };
    const fail = (e: unknown): void => { if (settled) return; settled = true; teardown(); reject(e instanceof Error ? e : new Error(String(e))); };

    let found = false;
    ex.on('entry', (header, stream, next) => {
      if (found) { stream.resume(); next(); return; }
      found = true;
      const mode = (header.mode ?? 0) & 0o7777;
      if (header.type !== 'file') {
        // symlink / directory / hardlink / special — never treated as a matchable regular file.
        stream.resume();
        settle({ exists: true, kind: 'other' });
        return;
      }
      readBounded(stream, MAX_HOST_READ_BYTES).then((buf) => {
        // Archive metadata carries no nlink field, fabricated or otherwise —
        // hardlink authority lives exclusively in liveStatProjectPath's real
        // lstat().nlink (LiveStatResult), never here.
        settle({ exists: true, kind: 'file', sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.length, mode });
      }, fail);
    });
    ex.on('finish', () => { if (!found) settle({ exists: false }); });
    ex.on('error', fail);
    tarStream.on('error', fail);
    tarStream.pipe(ex);
  });
}

/** Production ApplierIO: the real Docker Engine primitives, no caller-controlled inputs. */
export function createDockerApplierIO(): ApplierIO {
  return {
    createContainer: (name, body) => dockerCreateContainer(name, body),
    startContainer: (id) => dockerStartContainer(id),
    removeContainer: (id, force = true) => dockerRemoveContainer(id, force),
    async exec(containerId, cmd) {
      const execId = await dockerExecCreate(containerId, { cmd, user: '0:0' });
      const { stdout, stderr, done } = await dockerExecStartStream(execId);
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      stdout.on('data', (c: Buffer) => outChunks.push(c));
      stderr.on('data', (c: Buffer) => errChunks.push(c));
      await done;
      const inspection = await dockerExecInspect(execId);
      return {
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        exitCode: inspection.ExitCode,
      };
    },
    async execWithEnv(containerId, cmd, env) {
      const envArray = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      const execId = await dockerExecCreate(containerId, { cmd, user: '0:0', env: envArray });
      const { stdout, stderr, done } = await dockerExecStartStream(execId);
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      stdout.on('data', (c: Buffer) => outChunks.push(c));
      stderr.on('data', (c: Buffer) => errChunks.push(c));
      await done;
      const inspection = await dockerExecInspect(execId);
      return {
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        exitCode: inspection.ExitCode,
      };
    },
    putArchive: (containerId, absDir, tarBuffer) => dockerPutArchive(containerId, absDir, tarBuffer),
    async readProjectPath(containerId, relPath) {
      let body: Readable;
      try {
        const res = await dockerGetArchive(containerId, `${PROJECT_PATH}/${relPath}`);
        body = res.body;
      } catch (e) {
        if (e instanceof BridgeError && e.code === 'FILE_NOT_FOUND') return { exists: false };
        throw e;
      }
      return extractSingleEntryWithMode(body);
    },
    async liveStatProjectPath(containerId, relPath) {
      const res = await this.execWithEnv(containerId, ['node', '-e', LIVE_STAT_SCRIPT], { STAT_TARGET_PATH: relPath });
      if (res.exitCode !== 0) {
        throw new BridgeError('INTERNAL', `live stat failed for ${relPath}: ${res.stderr}`, 500);
      }
      const line = res.stdout.trim().split('\n').pop();
      if (!line) throw new BridgeError('INTERNAL', `live stat produced no output for ${relPath}`, 500);
      const parsed = JSON.parse(line) as { ok: boolean; exists?: boolean; kind?: string; mode?: number; nlink?: unknown; size?: number; error?: string };
      if (!parsed.ok) {
        throw new BridgeError('INTERNAL', `live stat error for ${relPath}: ${parsed.error ?? 'unknown'}`, 500);
      }
      if (!parsed.exists) return { exists: false };
      if (parsed.kind !== 'file') return { exists: true, kind: 'other' };
      // F4-R3: nlink must be a positive INTEGER for live stat results — a
      // fractional, non-numeric, or non-positive value fails closed. No
      // defaulting, no rounding, no coercion, no fallback to 1.
      if (typeof parsed.nlink !== 'number' || !Number.isInteger(parsed.nlink) || parsed.nlink < 1) {
        throw new BridgeError('INTERNAL', `live stat for ${relPath} returned invalid nlink: ${JSON.stringify(parsed.nlink)}`, 500);
      }
      // Live stat carries no content hash — readProjectPath (against
      // HostReadResult) separately verifies content. This result exists
      // purely to carry the validated live nlink plus mode/size.
      return {
        exists: true,
        kind: 'file',
        mode: parsed.mode ?? 0,
        sizeBytes: parsed.size ?? 0,
        nlink: parsed.nlink,
      };
    },
    createControlVolume: (name, labels) => dockerCreateVolume(name, labels),
    removeControlVolume: (name, force = true) => dockerRemoveVolume(name, force),
  };
}

// ---------------------------------------------------------------------------
// Control-file (ops manifest) construction — trusted, executor-authored,
// path/hash/mode only, never raw byte content.
// ---------------------------------------------------------------------------

interface ForwardOp {
  path: string;
  op: string;
  beforeHash?: string;
  beforeMode?: number;
  postHash?: string;
  postSize?: number;
  postMode?: number;
}

interface RollbackOp {
  path: string;
  op: string;
  beforeHash?: string;
  beforeSize?: number;
  beforeMode?: number;
  postHash?: string;
  postSize?: number;
  postMode?: number;
  createdDirs?: string[];
}

function fileEntry(e: SnapshotEntry | undefined): (SnapshotEntry & { kind: 'file' }) | undefined {
  return e && e.kind === 'file' ? e : undefined;
}

function buildForwardOp(change: CanonicalChangeEntry, verified: VerifiedArtifact): ForwardOp {
  const before = fileEntry(verified.beforeMap.get(change.path));
  const post = fileEntry(verified.postMap.get(change.path));
  const op: ForwardOp = { path: change.path, op: change.op };
  if (change.op !== 'ADD' && before) { op.beforeHash = before.contentHash; op.beforeMode = before.mode; }
  if (change.op !== 'DELETE' && post) { op.postHash = post.contentHash; op.postSize = post.sizeBytes; op.postMode = post.mode; }
  return op;
}

function buildRollbackOp(row: AgentApplyJournalRow, verified: VerifiedArtifact): RollbackOp {
  const before = fileEntry(verified.beforeMap.get(row.path));
  const post = fileEntry(verified.postMap.get(row.path));
  const op: RollbackOp = { path: row.path, op: row.op };
  if (row.beforeContentHash !== null) {
    op.beforeHash = row.beforeContentHash;
    op.beforeMode = row.beforeMode ?? undefined;
    if (before) op.beforeSize = before.sizeBytes;
  }
  if (post) { op.postHash = post.contentHash; op.postSize = post.sizeBytes; op.postMode = post.mode; }
  if (row.createdDirs) op.createdDirs = row.createdDirs;
  return op;
}

async function buildSingleOpControlTar(content: { mode: 'apply' | 'rollback'; opIndex: number; op: unknown }): Promise<Buffer> {
  const fileName = APPLY_CONTROL_FILE.slice(APPLY_CONTROL_FILE.lastIndexOf('/') + 1);
  const buf = Buffer.from(JSON.stringify(content), 'utf8');
  const p = tarPack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('end', () => resolve(Buffer.concat(chunks)));
    p.on('error', reject);
  });
  p.entry({ name: fileName, type: 'file', mode: 0o600, size: buf.length }, buf);
  p.finalize();
  return done;
}


// (buildMultiOpControlTar removed — rollback now also uses per-op execs via buildSingleOpControlTar)


/** Parse newline-delimited JSON emitted by APPLY_MUTATION_SCRIPT. Stops at the first unparseable line (fail closed). */
function parseJsonLines(stdout: string): Array<{ opIndex: number; ok: boolean; [k: string]: unknown }> {
  const out: Array<{ opIndex: number; ok: boolean; [k: string]: unknown }> = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      break;
    }
  }
  return out;
}

function lastJsonLine(stdout: string): { ok?: boolean; error?: string; createdDirs?: unknown[]; [k: string]: unknown } | undefined {
  const lines = parseJsonLines(stdout);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// BEFORE / POST state comparison — one function, two expected-state shapes
// (rollback verification reuses checkBeforeState against journaled BEFORE).
// ---------------------------------------------------------------------------

type StateCheck = { ok: true } | { ok: false; reason: string };

function checkBeforeState(op: string, result: HostReadResult, expected: SnapshotEntry | undefined): StateCheck {
  if (op === 'ADD') {
    if (result.exists) return { ok: false, reason: 'ADD target unexpectedly exists on host' };
    return { ok: true };
  }
  const exp = fileEntry(expected);
  if (!exp) return { ok: false, reason: `no valid BEFORE file entry for op ${op}` };
  if (!result.exists) return { ok: false, reason: `target missing on host for op ${op}` };
  if (result.kind !== 'file') return { ok: false, reason: 'target is not a supported regular file on host (possible symlink/special file)' };
  // F4: nlink check moved to caller (live stat before this function)
  if (result.sha256 !== exp.contentHash) return { ok: false, reason: 'BEFORE content hash mismatch' };
  if (result.mode !== exp.mode) return { ok: false, reason: 'BEFORE mode mismatch' };
  return { ok: true };
}

function checkPostState(op: string, result: HostReadResult, expected: SnapshotEntry | undefined): StateCheck {
  if (op === 'DELETE') {
    if (result.exists) return { ok: false, reason: 'DELETE target still exists on host' };
    return { ok: true };
  }
  const exp = fileEntry(expected);
  if (!exp) return { ok: false, reason: `no valid POST file entry for op ${op}` };
  if (!result.exists) return { ok: false, reason: `target missing on host after ${op}` };
  if (result.kind !== 'file') return { ok: false, reason: 'target is not a supported regular file on host (possible symlink/special file)' };
  if (result.sha256 !== exp.contentHash) return { ok: false, reason: 'POST content hash mismatch' };
  if (result.mode !== exp.mode) return { ok: false, reason: 'POST mode mismatch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ApplyEngineDeps {
  store: AgentJobStore;
  evidenceReaderFactory: EvidenceReaderFactory;
  applierImage: string;
  applierIO: ApplierIO;
}

export interface ApplyAttemptSuccess {
  status: 'APPLIED';
  appliedAt: string;
}

/**
 * Run one complete apply attempt for an already-admitted job (ownership,
 * scope and project-grant checks happened above this call, in the gateway +
 * jobEngine.getOwnedJob). Reuses {@link AgentJobStore.startApplyAttempt} for
 * atomic admission (COMPLETED-only, not-quarantined, exclusive per-job/
 * per-project). On any non-success outcome this throws a typed BridgeError;
 * on success it returns the APPLIED job's appliedAt. Zero mutation ever
 * occurs before the attempt reaches APPLYING (§3 step 13) — every failure
 * before that point leaves the host project untouched.
 */
export async function runApplyAttempt(
  deps: ApplyEngineDeps,
  job: AgentJobRow,
  project: AgentProjectConfig,
  resourcePolicy: AgentResourcePolicy,
): Promise<ApplyAttemptSuccess> {
  const attemptId = `att_${randomBytes(16).toString('hex')}`;
  deps.store.startApplyAttempt({ attemptId, jobId: job.jobId });

  let applierContainerId: string | undefined;
  let controlVolume: string | undefined;
  try {
    // --- Artifact re-verification (reuses the frozen B4 hardened reader) ---
    if (job.artifactState !== 'AVAILABLE' || !job.artifactHash || !job.artifactVolume) {
      deps.store.transitionApplyAttempt(attemptId, 'STARTED', 'ARTIFACT_INVALID', { reason: 'no AVAILABLE artifact for this job' });
      throw new BridgeError('ARTIFACT_NOT_AVAILABLE', `job ${job.jobId} has no reviewable/applicable canonical artifact`, 404);
    }
    const source = deps.evidenceReaderFactory(job.artifactVolume, job.jobId);
    let verified: VerifiedArtifact;
    try {
      verified = await verifyCanonicalArtifact(source, {
        jobId: job.jobId,
        principalId: job.principalId,
        projectId: job.project,
        backend: job.backend,
        profile: job.profile,
        expectedArtifactHash: job.artifactHash,
        baseCommit: job.baseCommit,
        changeSetHash: job.changeSetHash,
        contentComplete: job.artifactContentComplete,
        applicable: job.artifactApplicable,
        reason: job.artifactReason,
        opCount: job.artifactOpCount,
        artifactBytes: job.artifactBytes,
      });
    } catch (e) {
      deps.store.transitionApplyAttempt(attemptId, 'STARTED', 'ARTIFACT_INVALID', { reason: errMsg(e) });
      throw e;
    } finally {
      if (source.close) await source.close().catch(() => {});
    }

    if (!verified.manifest.applicable) {
      deps.store.transitionApplyAttempt(attemptId, 'STARTED', 'ARTIFACT_INVALID', { reason: `not applicable: ${verified.manifest.reason ?? 'unknown'}` });
      throw new BridgeError('ARTIFACT_NOT_APPLICABLE', `job ${job.jobId} artifact is not applicable: ${verified.manifest.reason ?? 'unknown'}`, 409);
    }
    const unsupported = verified.manifest.changes.find((c) => c.op === 'SYMLINK_CHANGE' || c.op === 'TYPE_CHANGE');
    if (unsupported) {
      deps.store.transitionApplyAttempt(attemptId, 'STARTED', 'ARTIFACT_INVALID', { reason: `unsupported op ${unsupported.op} at ${unsupported.path}` });
      throw new BridgeError('APPLY_UNSUPPORTED_OPERATION', `changeset contains unsupported op ${unsupported.op} at ${unsupported.path}`, 409);
    }
    if (!job.baseCommit) {
      deps.store.transitionApplyAttempt(attemptId, 'STARTED', 'ARTIFACT_INVALID', { reason: 'job has no recorded base commit' });
      throw new BridgeError('PRECONDITION_FAILED', `job ${job.jobId} has no recorded base commit`, 409);
    }

    if (!deps.store.transitionApplyAttempt(attemptId, 'STARTED', 'VERIFYING')) {
      throw new BridgeError('INVALID_ATTEMPT_TRANSITION', `apply attempt ${attemptId} changed state concurrently`, 409);
    }

    // --- Trusted applier container for the rest of this attempt's lifecycle ---
    const limits = toRunnerLimits(resourcePolicy);
    controlVolume = controlVolumeName(attemptId);
    await deps.applierIO.createControlVolume(controlVolume, applierOwnershipLabels(job.jobId, attemptId));
    const body = buildApplierCreateBody({
      image: deps.applierImage,
      jobId: job.jobId,
      attemptId,
      hostPath: project.hostPath,
      artifactVolume: job.artifactVolume,
      controlVolume,
      limits,
    });
    applierContainerId = await deps.applierIO.createContainer(applierContainerName(attemptId), body as unknown as Record<string, unknown>);
    await deps.applierIO.startContainer(applierContainerId);

    // --- Nested-mount preflight ---
    const mountRes = await deps.applierIO.exec(applierContainerId, ['node', '-e', MOUNTINFO_CHECK_SCRIPT]);
    const mountLine = lastJsonLine(mountRes.stdout);
    if (mountRes.exitCode !== 0 || !mountLine || mountLine.ok !== true) {
      const reason = mountLine?.error ?? `mountinfo check failed (exit ${mountRes.exitCode})`;
      deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason });
      throw new BridgeError('NESTED_MOUNT_DETECTED', reason, 409);
    }

    // --- Repository identity / stale HEAD / dirty host / sequencer state ---
    const gitRes = await deps.applierIO.exec(applierContainerId, ['sh', '-c', GIT_HOST_CHECK_SCRIPT]);
    if (gitRes.exitCode !== 0) {
      const reason = gitRes.stderr.trim() || `git host check exited ${gitRes.exitCode}`;
      deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason });
      if (gitRes.exitCode === 3 || gitRes.exitCode === 7) throw new BridgeError('HOST_DIRTY', reason, 409);
      throw new BridgeError('PRECONDITION_FAILED', reason, 409);
    }
    const headMatch = /HEAD=([0-9a-f]{40})/.exec(gitRes.stdout);
    if (!headMatch) {
      deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason: 'git host check produced no HEAD' });
      throw new BridgeError('PRECONDITION_FAILED', 'git host check produced no HEAD', 500);
    }
    const liveHead = headMatch[1]!;
    if (liveHead !== job.baseCommit) {
      const reason = `live HEAD ${liveHead} does not match job base commit ${job.baseCommit}`;
      deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason });
      throw new BridgeError('STALE_BASE_COMMIT', reason, 409);
    }

    // --- Guarded paths (P1, reused exactly — no second matcher) ---
    const changedPaths = verified.manifest.changes.map((c) => c.path);
    try {
      assertChangesetNotGuarded(changedPaths, project.guardedPaths);
    } catch (e) {
      deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason: errMsg(e) });
      throw e;
    }

    // --- Path / mode safety (P1, reused exactly) ---
    try {
      for (const c of verified.manifest.changes) {
        validateApplyPath(c.path);
        const post = fileEntry(verified.postMap.get(c.path));
        if (post) assertSupportedRegularFileMode(post.mode);
        const before = fileEntry(verified.beforeMap.get(c.path));
        if (before) assertSupportedRegularFileMode(before.mode);
      }
    } catch (e) {
      deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason: errMsg(e) });
      throw e;
    }

    // --- Live host BEFORE recertification (one read per changed path) ---
    // F4: For existing targets, first check live nlink via LIVE_STAT_SCRIPT
    // (trusted helper running lstat inside the container), then read content
    // via the archive API. The nlink from the archive tar header is NOT
    // trustworthy for hardlink detection — only a real live lstat is.
    for (const c of verified.manifest.changes) {
      if (c.op !== 'ADD') {
        // Existing target: get live nlink first
        const liveStat = await deps.applierIO.liveStatProjectPath(applierContainerId, c.path);
        if (!liveStat.exists) {
          deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason: `${c.path}: target missing on host` });
          throw new BridgeError('HOST_PRECERTIFICATION_FAILED', `${c.path}: target missing on host`, 409);
        }
        if (liveStat.kind !== 'file') {
          deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason: `${c.path}: not a regular file (possible symlink/special)` });
          throw new BridgeError('HOST_PRECERTIFICATION_FAILED', `${c.path}: not a regular file (possible symlink/special)`, 409);
        }
        if (liveStat.nlink > 1) {
          deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason: `${c.path}: has ${liveStat.nlink} hard links (nlink must be 1)` });
          throw new BridgeError('HOST_PRECERTIFICATION_FAILED', `${c.path}: has ${liveStat.nlink} hard links (nlink must be 1)`, 409);
        }
      }
      // Now read the full content (for all ops including ADD — ADD checks absence)
      const result = await deps.applierIO.readProjectPath(applierContainerId, c.path);
      const check = checkBeforeState(c.op, result, verified.beforeMap.get(c.path));
      if (!check.ok) {
        deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'PRECONDITION_FAILED', { reason: `${c.path}: ${check.reason}` });
        throw new BridgeError('HOST_PRECERTIFICATION_FAILED', `${c.path}: ${check.reason}`, 409);
      }
    }

    // --- LAST SAFE POINT: from here on, host mutation MAY occur ---
    if (!deps.store.transitionApplyAttempt(attemptId, 'VERIFYING', 'APPLYING')) {
      throw new BridgeError('INVALID_ATTEMPT_TRANSITION', `apply attempt ${attemptId} changed state concurrently`, 409);
    }

    const sortedChanges = [...verified.manifest.changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const forwardOps = sortedChanges.map((c) => buildForwardOp(c, verified));

    // F1 + F2: wrap the entire APPLYING body so any unexpected throw after the
    // APPLYING transition is funneled through rollbackAndFail/markApplyUncertain.
    // An attempt must NEVER be left stuck at APPLYING by a live process exception.
    //
    // F1-R2: ambiguousCurrentOpIndex tracks whether the current operation's
    // mutation exec has been invoked but its journal row has not yet been durably
    // persisted. If set, any failure path must force UNCERTAIN + QUARANTINED
    // because we cannot prove whether that operation's filesystem syscall landed.
    let ambiguousCurrentOpIndex: number | null = null;
    try {
      // F1: one exec per op, journal committed before the next op starts.
      // Each exec processes exactly ops[0] from a single-op control file.
      for (let i = 0; i < sortedChanges.length; i++) {
        const forwardOp = forwardOps[i]!;
        const change = sortedChanges[i]!;
        const opTar = await buildSingleOpControlTar({ mode: 'apply', opIndex: i, op: forwardOp });
        await deps.applierIO.putArchive(applierContainerId, CONTROL_PATH, opTar);

        // F1-R2: Mark this op as ambiguous IMMEDIATELY before invoking the mutation exec.
        ambiguousCurrentOpIndex = i;

        const execRes = await deps.applierIO.exec(applierContainerId, ['node', '-e', APPLY_MUTATION_SCRIPT]);
        const line = lastJsonLine(execRes.stdout);

        if (execRes.exitCode !== 0 || !line || line.ok !== true) {
          // F1: this op failed. The failure class:
          // - If the line is present and ok===false: the script ran to completion
          //   on this op and reported a clean op-level failure BEFORE or DURING
          //   its mutation. We cannot know if the syscall landed — treat as ambiguous.
          // - If no line / exitCode null: container died mid-exec — definitely ambiguous.
          // In both cases: route to rollback. Rollback verifies live state;
          // if rollback cannot be proven, UNCERTAIN + quarantine.
          // F1-R2: ambiguousCurrentOpIndex is still set, so rollback MUST force UNCERTAIN.
          const reason = line?.ok === false
            ? `mutation op ${i} (${change.path}/${change.op}) failed: ${String(line.error ?? 'script error')}`
            : `mutation op ${i} (${change.path}/${change.op}) exec incomplete (exit ${execRes.exitCode})`;
          log('agent apply mutation op failed', { jobId: job.jobId, attemptId, opIndex: i, reason });
          return await rollbackAndFail(deps, applierContainerId, attemptId, job, verified, reason, ambiguousCurrentOpIndex);
        }

        // F1: op succeeded — journal it durably before proceeding to op i+1.
        const before = fileEntry(verified.beforeMap.get(change.path));
        deps.store.insertApplyJournalRow({
          attemptId,
          opIndex: i,
          path: change.path,
          op: change.op,
          beforeExisted: change.op !== 'ADD',
          beforeContentHash: before?.contentHash ?? null,
          beforeMode: before?.mode ?? null,
          createdDirs: Array.isArray(line.createdDirs) ? (line.createdDirs as string[]) : null,
        });

        // F1-R2: Journal row durably persisted — clear ambiguity for this op.
        ambiguousCurrentOpIndex = null;
      }

      // --- POST verification: independently reread every changed live path ---
      // F1-R2: At this point ambiguousCurrentOpIndex is null (all ops journaled).
      // A POST verification failure here is not an unjournaled-current-op case;
      // normal verified rollback may still produce FAILED_ROLLED_BACK.
      for (const c of sortedChanges) {
        const result = await deps.applierIO.readProjectPath(applierContainerId, c.path);
        const check = checkPostState(c.op, result, verified.postMap.get(c.path));
        if (!check.ok) {
          const reason = `POST verification failed at ${c.path}: ${check.reason}`;
          log('agent apply post-verification mismatch', { jobId: job.jobId, attemptId, path: c.path });
          return await rollbackAndFail(deps, applierContainerId, attemptId, job, verified, reason, ambiguousCurrentOpIndex);
        }
      }

      // --- Success: atomic attempt+job dual commit (frozen B1 primitive) ---
      const committed = deps.store.markApplySuccess(attemptId, job.jobId, {
        successEvidence: JSON.stringify({ artifactHash: verified.artifactHash, opCount: sortedChanges.length }).slice(0, 4000),
        mutatedPathCount: sortedChanges.length,
      });
      if (!committed) {
        // Mutation succeeded and verified, but the durable commit lost a race
        // (unreachable given exclusive per-job/per-project admission) — fail
        // closed rather than report success that was never durably recorded.
        throw new BridgeError('INTERNAL', `apply attempt ${attemptId} verified successfully but could not be durably committed`, 500);
      }
      const updated = deps.store.get(job.jobId)!;
      log('agent apply succeeded', { jobId: job.jobId, attemptId, mutatedPaths: sortedChanges.length });
      return { status: 'APPLIED', appliedAt: updated.appliedAt! };

    } catch (e) {
      // F2: any unexpected exception after APPLYING transition must not leave
      // the attempt stuck at APPLYING. If it's already a BridgeError from
      // rollbackAndFail, re-throw directly (rollback already recorded the
      // terminal state). Otherwise funnel through markApplyUncertain so the
      // attempt reaches a terminal state before this call resolves.
      if (e instanceof BridgeError && (
        e.code === 'APPLY_MUTATION_FAILED' ||
        e.code === 'APPLY_ROLLBACK_FAILED'
      )) {
        throw e; // already terminal via rollbackAndFail
      }
      // Unexpected infra failure (Docker error, journal INSERT threw, etc.).
      // F1-R2: ambiguousCurrentOpIndex may be set if journal INSERT threw after
      // exec succeeded. Route through rollbackAndFail with the ambiguous index.
      const reason = `unexpected error in APPLYING phase: ${errMsg(e)}`;
      log('agent apply APPLYING-phase unexpected error', { jobId: job.jobId, attemptId, error: reason });
      return await rollbackAndFail(deps, applierContainerId, attemptId, job, verified, reason, ambiguousCurrentOpIndex);
    }
  } finally {
    if (applierContainerId) await deps.applierIO.removeContainer(applierContainerId, true).catch(() => {});
    if (controlVolume) await deps.applierIO.removeControlVolume(controlVolume, true).catch(() => {});
  }
}

/**
 * Roll back exactly the journaled effects of this attempt using per-op execs,
 * verify the rollback, and commit the resulting terminal attempt state —
 * FAILED_ROLLED_BACK if fully proven, UNCERTAIN (+ project quarantine, atomically)
 * otherwise. Always throws (this is a failure path); never returns normally.
 *
 * @param ambiguousCurrentOpIndex - If non-null, indicates that the operation at
 *   this index had its mutation exec invoked but no durable journal row exists.
 *   This forces UNCERTAIN + QUARANTINED regardless of whether journaled ops can
 *   be verified — we cannot prove the unjournaled mutation's filesystem syscall
 *   did not land.
 */
async function rollbackAndFail(
  deps: ApplyEngineDeps,
  containerId: string,
  attemptId: string,
  job: AgentJobRow,
  verified: VerifiedArtifact,
  reason: string,
  ambiguousCurrentOpIndex: number | null,
): Promise<never> {
  const journal = deps.store.listApplyJournalForAttempt(attemptId);

  // F1-R2: If an unjournaled current op exists (mutation exec attempted but
  // journal INSERT did not succeed), we MUST force UNCERTAIN + QUARANTINED.
  // We cannot prove the unjournaled op's syscall did not land, even if all
  // journaled ops can be cleanly rolled back and verified.
  const hasAmbiguousUnjournaledOp = ambiguousCurrentOpIndex !== null;

  let rollbackOk = false;
  try {
    if (journal.length > 0) {
      const reverseRows = [...journal].sort((a, b) => b.opIndex - a.opIndex);
      let allRollbackOps = true;
      // F1: rollback also uses per-op execs so each reversal is independent.
      for (const row of reverseRows) {
        const rbOp = buildRollbackOp(row, verified);
        const rbTar = await buildSingleOpControlTar({ mode: 'rollback', opIndex: row.opIndex, op: rbOp });
        await deps.applierIO.putArchive(containerId, CONTROL_PATH, rbTar);
        const rbRes = await deps.applierIO.exec(containerId, ['node', '-e', APPLY_MUTATION_SCRIPT]);
        const rbLine = lastJsonLine(rbRes.stdout);
        if (rbRes.exitCode !== 0 || !rbLine || rbLine.ok !== true) {
          allRollbackOps = false;
          log('agent apply rollback op failed', { jobId: job.jobId, attemptId, opIndex: row.opIndex, error: rbLine?.error ?? `exit ${rbRes.exitCode}` });
          break;
        }
      }
      if (allRollbackOps) {
        // Verify BEFORE state restored for every journaled path.
        let allVerified = true;
        for (const row of journal) {
          const result = await deps.applierIO.readProjectPath(containerId, row.path);
          const check = checkBeforeState(row.op, result, verified.beforeMap.get(row.path));
          if (!check.ok) { allVerified = false; break; }
        }
        rollbackOk = allVerified;
      }
    } else {
      // No journal rows exist. This means either:
      // (a) Failure occurred before the first op's filesystem syscall could land
      //     (e.g. putArchive failed, exec returned immediately with no output),
      // OR
      // (b) The first op's syscall may have landed but the exec died before
      //     emitting its completion line (F1 window we cannot resolve without
      //     live re-read). We check the ADD target absence / BEFORE state for
      //     all changed paths to determine which case we are in.
      let allMatchesBefore = true;
      const sortedChanges = [...verified.manifest.changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const c of sortedChanges) {
        const result = await deps.applierIO.readProjectPath(containerId, c.path);
        const check = checkBeforeState(c.op, result, verified.beforeMap.get(c.path));
        if (!check.ok) { allMatchesBefore = false; break; }
      }
      rollbackOk = allMatchesBefore;
    }
  } catch (e) {
    log('agent apply rollback threw', { jobId: job.jobId, attemptId, error: errMsg(e) });
    rollbackOk = false;
  }

  // F1-R2: If we have an ambiguous unjournaled current op, we CANNOT report
  // FAILED_ROLLED_BACK even if journaled ops verified cleanly. The unjournaled
  // op's mutation may have landed (we have no journal row to verify against).
  if (hasAmbiguousUnjournaledOp) {
    const uncertainReason = ambiguousCurrentOpIndex !== null
      ? `unjournaled mutation at op ${ambiguousCurrentOpIndex} (exec attempted, journal not persisted); ${reason}`
      : reason;
    deps.store.markApplyUncertain(attemptId, job.jobId, job.project, uncertainReason);
    log('agent apply UNCERTAIN — unjournaled current op exists, project quarantined', {
      jobId: job.jobId,
      attemptId,
      project: job.project,
      ambiguousOpIndex: ambiguousCurrentOpIndex,
    });
    throw new BridgeError('APPLY_ROLLBACK_FAILED', `apply failed with unjournaled mutation; project quarantined: ${uncertainReason}`, 500);
  }

  if (rollbackOk) {
    deps.store.transitionApplyAttempt(attemptId, 'APPLYING', 'FAILED_ROLLED_BACK', {
      reason: reason.slice(0, 2000),
      rollbackEvidence: JSON.stringify({ rolledBackOps: journal.length }).slice(0, 4000),
      mutatedPathCount: 0,
    });
    log('agent apply rolled back', { jobId: job.jobId, attemptId, rolledBackOps: journal.length });
    throw new BridgeError('APPLY_MUTATION_FAILED', `apply failed and was rolled back: ${reason}`, 500);
  }

  deps.store.markApplyUncertain(attemptId, job.jobId, job.project, reason);
  log('agent apply UNCERTAIN — project quarantined', { jobId: job.jobId, attemptId, project: job.project });
  throw new BridgeError('APPLY_ROLLBACK_FAILED', `apply failed and rollback could not be verified; project quarantined: ${reason}`, 500);
}
