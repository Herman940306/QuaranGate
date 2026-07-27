/**
 * In-target execution with workspace confinement, timeouts, output caps
 * and concurrency limits. argv execs never pass through a shell; the single
 * shell entrypoint is runShell() used by terminal_exec.
 */
import { BridgeError } from '../shared/errors.js';
import { isInside, joinWorkspace, validateRelativePath } from '../shared/pathcheck.js';
import { EXECUTOR_DEFAULTS, type ExecResult } from '../shared/types.js';
import { execCreate, execInspect, execStartStream } from './docker.js';
import { resolveTarget } from './targets.js';

const global = { running: 0 };
const perPrincipal = new Map<string, number>();

function acquire(principal: string): () => void {
  const mine = perPrincipal.get(principal) ?? 0;
  if (global.running >= EXECUTOR_DEFAULTS.globalConcurrency) {
    throw new BridgeError('CONCURRENCY_LIMIT', 'global concurrency limit reached', 429);
  }
  if (mine >= EXECUTOR_DEFAULTS.perPrincipalConcurrency) {
    throw new BridgeError('CONCURRENCY_LIMIT', `client concurrency limit (${EXECUTOR_DEFAULTS.perPrincipalConcurrency}) reached`, 429);
  }
  global.running++;
  perPrincipal.set(principal, mine + 1);
  return () => {
    global.running--;
    const n = (perPrincipal.get(principal) ?? 1) - 1;
    if (n <= 0) perPrincipal.delete(principal);
    else perPrincipal.set(principal, n);
  };
}

async function collect(
  containerId: string,
  cmd: string[],
  opts: { workingDir?: string; timeoutMs: number; maxOutputBytes: number },
): Promise<ExecResult> {
  const start = Date.now();
  const execOpts: Parameters<typeof execCreate>[1] = { cmd };
  if (opts.workingDir) execOpts.workingDir = opts.workingDir;
  const execId = await execCreate(containerId, execOpts);
  const { stdout, stderr, done } = await execStartStream(execId);

  let out = Buffer.alloc(0);
  let err = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;

  const cap = opts.maxOutputBytes;
  stdout.on('data', (c: Buffer) => {
    if (out.length + err.length < cap) out = Buffer.concat([out, c]);
    else truncated = true;
  });
  stderr.on('data', (c: Buffer) => {
    if (out.length + err.length < cap) err = Buffer.concat([err, c]);
    else truncated = true;
  });

  const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), opts.timeoutMs));
  const result = await Promise.race([done.then(() => 'done' as const), timer]);

  if (result === 'timeout') {
    timedOut = true;
    // Best-effort cleanup: docker has no exec-kill API; kill the exec's process group.
    try {
      const info = await execInspect(execId);
      if (info.Running && info.Pid > 0) {
        const killId = await execCreate(containerId, { cmd: ['/bin/sh', '-c', `kill -9 -${info.Pid} 2>/dev/null; kill -9 ${info.Pid} 2>/dev/null; true`] });
        const k = await execStartStream(killId);
        await Promise.race([k.done, new Promise((r) => setTimeout(r, 2000))]);
      }
    } catch {
      /* cleanup is best effort */
    }
  }

  let exitCode: number | null = null;
  try {
    const info = await execInspect(execId);
    exitCode = info.Running ? null : info.ExitCode;
  } catch {
    /* ignore */
  }

  const clip = (b: Buffer) => b.subarray(0, cap).toString('utf8');
  return {
    exitCode: timedOut ? null : exitCode,
    stdout: clip(out),
    stderr: clip(err),
    truncated: truncated || out.length + err.length > cap,
    timedOut,
    durationMs: Date.now() - start,
  };
}

/**
 * Canonicalize an in-container path via the target's own readlink/realpath.
 * The path is passed as a positional argument ($1) — never interpolated into
 * the shell string.
 */
async function canonicalizePath(containerId: string, absPath: string): Promise<string | null> {
  const r = await collect(
    containerId,
    ['/bin/sh', '-c', 'readlink -f -- "$1" 2>/dev/null || realpath -- "$1" 2>/dev/null', 'sh', absPath],
    { timeoutMs: 10_000, maxOutputBytes: 8192 },
  );
  const line = r.stdout.trim().split('\n')[0];
  if (!line || !line.startsWith('/')) return null;
  return line;
}

export interface ConfinedTarget {
  containerId: string;
  workspace: string; // canonical workspace root inside the container
}

/** Resolve target + canonicalize its workspace root; verify /bin/sh exists. */
export async function confinedTarget(targetId: string): Promise<ConfinedTarget> {
  const t = await resolveTarget(targetId);
  const canon = await canonicalizePath(t.containerId, t.workspace).catch(() => null);
  if (!canon) {
    throw new BridgeError(
      'TARGET_UNSUPPORTED',
      `target ${targetId}: cannot canonicalize workspace ${t.workspace} — target needs /bin/sh and readlink/realpath, and the workspace must exist`,
      422,
    );
  }
  return { containerId: t.containerId, workspace: canon };
}

/**
 * Turn a workspace-relative path into a confined absolute path.
 * The deepest existing ancestor is canonicalized in-target and must stay
 * inside the canonical workspace (defeats symlink escapes).
 */
export async function confinePath(t: ConfinedTarget, rel: string, opts: { mustExist?: boolean } = {}): Promise<string> {
  const cleanRel = validateRelativePath(rel);
  const abs = joinWorkspace(t.workspace, cleanRel);

  const canonSelf = await canonicalizePath(t.containerId, abs);
  if (canonSelf) {
    if (!isInside(t.workspace, canonSelf)) {
      throw new BridgeError('PATH_VIOLATION', `path resolves outside the workspace`, 403);
    }
    return canonSelf;
  }
  if (opts.mustExist) throw new BridgeError('FILE_NOT_FOUND', `not found: ${cleanRel}`, 404);

  // Path does not exist yet (e.g. new file). Canonicalize nearest existing ancestor.
  const parts = abs.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const ancestor = '/' + parts.slice(0, i).join('/');
    const canon = await canonicalizePath(t.containerId, ancestor);
    if (canon) {
      if (!isInside(t.workspace, canon)) {
        throw new BridgeError('PATH_VIOLATION', 'path ancestor resolves outside the workspace', 403);
      }
      return canon + '/' + parts.slice(i).join('/');
    }
  }
  throw new BridgeError('PATH_VIOLATION', 'cannot resolve path inside workspace', 403);
}

/** argv exec confined to the workspace (internal fs/git ops). */
export async function runArgv(
  t: ConfinedTarget,
  argv: string[],
  opts: { cwdAbs?: string; timeoutMs?: number; maxOutputBytes?: number; principal: string },
): Promise<ExecResult> {
  const release = acquire(opts.principal);
  try {
    const collectOpts: { workingDir?: string; timeoutMs: number; maxOutputBytes: number } = {
      timeoutMs: Math.min(opts.timeoutMs ?? EXECUTOR_DEFAULTS.timeoutMs, EXECUTOR_DEFAULTS.maxTimeoutMs),
      maxOutputBytes: opts.maxOutputBytes ?? EXECUTOR_DEFAULTS.maxOutputBytes,
    };
    collectOpts.workingDir = opts.cwdAbs ?? t.workspace;
    return await collect(t.containerId, argv, collectOpts);
  } finally {
    release();
  }
}

/** The one deliberate shell entrypoint (terminal_exec). cwd already confined. */
export async function runShell(
  t: ConfinedTarget,
  command: string,
  opts: { cwdAbs?: string; timeoutMs?: number; maxOutputBytes?: number; principal: string },
): Promise<ExecResult> {
  if (typeof command !== 'string' || command.length === 0 || command.length > 32_768) {
    throw new BridgeError('MALFORMED_REQUEST', 'command must be a non-empty string (max 32KiB)', 400);
  }
  return runArgv(t, ['/bin/sh', '-c', command], opts);
}
