/**
 * Executor authority readiness (H1-2).
 *
 * /readyz proves the executor holds actual execution authority, not just that
 * the Node process is alive. It is semantically distinct from /healthz:
 *
 *   /healthz — process liveness: "am I running?" (always fast, no I/O)
 *   /readyz  — execution authority: "can I actually execute containers?"
 *
 * A ready executor must prove, in bounded time:
 *   1. The configured Docker socket path exists on the filesystem.
 *   2. It IS a Unix socket (not an empty file, symlink to wrong type, etc.).
 *   3. The Docker API responds to /_ping with HTTP 200.
 *
 * Production failure class caught here:
 *   HOST:     /var/run/docker.sock = Unix socket  (correct)
 *   EXECUTOR: /var/run/docker.sock = regular file (stale bind — WRONG)
 *   Result:   the undici Pool connects to a file, not a socket → silent fail
 *
 * Design constraints:
 *   - Timeout is bounded at READYZ_TIMEOUT_MS (default 4 s) — never hangs.
 *   - Failure produces a deterministic 503 with a diagnostic code field.
 *   - No secret, host path, or sensitive data leaks in the response.
 *   - No restart loop: a 503 readyz does NOT kill the process. Compose
 *     healthcheck semantics (unhealthy but no restart policy on readiness)
 *     must be respected at the compose.yaml level.
 */
import fs from 'node:fs';
import { ping } from './docker.js';

/** Timeout for the Docker API ping in milliseconds. */
export const READYZ_TIMEOUT_MS = 4_000;

export type ReadinessCode =
  | 'SOCKET_MISSING'
  | 'SOCKET_WRONG_TYPE'
  | 'DOCKER_API_UNREACHABLE'
  | 'DOCKER_API_TIMEOUT'
  | 'READY';

export interface ReadinessResult {
  ready: boolean;
  code: ReadinessCode;
  /** Human-readable diagnostic — safe to surface, no host paths or secrets. */
  detail: string;
}

/**
 * Check executor authority readiness.
 *
 * The sockPath parameter comes from DOCKER_SOCK env (executor-internal trusted
 * configuration). It is validated here but NEVER reflected verbatim in the
 * response (only its type and reachability are reported).
 */
export async function checkReadiness(sockPath: string): Promise<ReadinessResult> {
  // Step 1: socket file existence and type check.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sockPath);
  } catch {
    return {
      ready: false,
      code: 'SOCKET_MISSING',
      detail: 'Docker socket path does not exist or is not accessible',
    };
  }

  if (!stat.isSocket()) {
    // This is the exact production failure: the bind produced a regular file
    // instead of a Unix socket. We report the file type without the path.
    const typeLabel = stat.isFile() ? 'regular file'
      : stat.isDirectory() ? 'directory'
      : stat.isSymbolicLink() ? 'symbolic link'
      : 'unknown type';
    return {
      ready: false,
      code: 'SOCKET_WRONG_TYPE',
      detail: `Docker socket path exists but is a ${typeLabel}, not a Unix socket`,
    };
  }

  // Step 2: Docker API ping with timeout bound.
  let pingOk: boolean;
  try {
    pingOk = await Promise.race([
      ping(),
      new Promise<false>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), READYZ_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    const isTimeout = e instanceof Error && e.message === 'timeout';
    return {
      ready: false,
      code: isTimeout ? 'DOCKER_API_TIMEOUT' : 'DOCKER_API_UNREACHABLE',
      detail: isTimeout
        ? `Docker API ping did not respond within ${READYZ_TIMEOUT_MS}ms`
        : 'Docker API ping failed',
    };
  }

  if (!pingOk) {
    return {
      ready: false,
      code: 'DOCKER_API_UNREACHABLE',
      detail: 'Docker API ping returned a non-OK response',
    };
  }

  return { ready: true, code: 'READY', detail: 'Docker API reachable and socket is a Unix socket' };
}
