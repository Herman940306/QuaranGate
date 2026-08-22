/**
 * A6-B3 R3: Trusted Docker-based Git object reader.
 *
 * Provides binary-safe Git object access via short-lived trusted Docker helper
 * containers. The Executor NEVER executes Git directly against hostPath from
 * its own process. Instead, a hardened helper container mounts the source RO
 * and Git is executed via Docker exec with a pure argv array (no shell).
 *
 * SECURITY BOUNDARY:
 *   - Source project mounted READ-ONLY at /src
 *   - No Docker socket
 *   - No network access
 *   - Non-privileged, cap-drop ALL, no-new-privileges
 *   - Bounded memory, PIDs, execution timeout
 *   - No unrelated host filesystem mounts
 *   - Helper lifecycle: create → start → exec → stop → remove
 *
 * BINARY SAFETY:
 *   - ls-tree -z output: raw NUL-delimited bytes via Docker exec stream demux
 *   - cat-file blob: raw binary bytes via Docker exec stream demux
 *   - No UTF-8 decoding of blob content
 *   - No line-ending normalization
 *   - No stdout/stderr merging (Docker multiplexed stream protocol separates them)
 *
 * COMMAND SAFETY:
 *   - Git is invoked ONLY via Docker exec Cmd argv array (shell=false)
 *   - NO shell (sh, bash, sh -c) is used anywhere in the helper lifecycle
 *   - baseCommit and OID values are NEVER interpolated into command strings
 *   - baseCommit and OID are passed as distinct argv elements
 *   - Input validation remains as defense-in-depth
 */
import { BridgeError } from '../../shared/errors.js';
import type { GitTreeEntry, GitObjectReader } from './baseCertifier.js';
import {
  createContainer, startContainer, stopContainer,
  removeContainer, execCreate, execStartStream, execInspect,
} from '../docker.js';
/**
 * N1D (§47.4): this module previously declared a SECOND, inconsistent ownership
 * namespace (`io.mcp-bridge.*`) for the same conceptual cleanup authority as
 * sandboxSpec.ts. It is now unified onto the single QuaranGate namespace, so a
 * leftover git-helper container is recognised by the same reconciliation sweep
 * as every other bridge-owned resource. `io.mcp-bridge.*` stays READ-accepted
 * for pre-cutover resources; nothing writes it any more.
 */
import { LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB } from './sandboxSpec.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Helper-container name prefix. Deliberately left on its legacy value: §47.3
 * defines no canonical QuaranGate replacement for this particular ephemeral
 * name, and the migration contract says to retain a compatibility-bound
 * physical identifier rather than invent one. Ownership is proven by labels,
 * never by name, so this does not affect cleanup authority.
 */
const NS = 'mcp-bridge';

/** Git object ID pattern: 40 hex chars (SHA-1). */
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;

/** Git commit/ref pattern: hex SHA-1 (40 chars). */
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** Maximum output size for ls-tree (50 MB). */
const MAX_LS_TREE_BYTES = 50 * 1024 * 1024;

/** Maximum blob size (50 MB). */
const MAX_BLOB_BYTES = 50 * 1024 * 1024;

/** Helper execution timeout (30 seconds). */
const HELPER_TIMEOUT_MS = 30_000;

/**
 * The idle command for the helper container. This is a fixed trusted command
 * that keeps the container alive while we exec Git into it. `sleep` is a
 * standalone POSIX binary — NO shell is involved.
 */
const HELPER_IDLE_CMD: string[] = ['sleep', '60'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHelperOptions {
  /** Docker image to use for the helper container. Must include git. */
  helperImage: string;
  /** Trusted absolute host path to the project source. */
  hostPath: string;
  /** Job ID for labeling and naming. */
  jobId: string;
}

/**
 * The full specification of a Git helper container, exposed for testing
 * the security boundary without running Docker.
 */
export interface GitHelperContainerSpec {
  Image: string;
  User: string;
  Cmd: string[];
  Labels: Record<string, string>;
  NetworkDisabled: boolean;
  HostConfig: {
    AutoRemove: boolean;
    Privileged: boolean;
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    SecurityOpt: string[];
    NetworkMode: string;
    Binds: string[];
    Tmpfs: Record<string, string>;
    Memory: number;
    PidsLimit: number;
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateCommit(commit: string): void {
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new BridgeError(
      'BASE_CERTIFICATION_FAILED',
      `invalid baseCommit format: must be 40 hex chars, got '${commit.slice(0, 50)}'`,
      500,
    );
  }
}

function validateOid(oid: string): void {
  if (!GIT_OID_PATTERN.test(oid)) {
    throw new BridgeError(
      'BASE_CERTIFICATION_FAILED',
      `invalid Git OID format: must be 40 hex chars, got '${oid.slice(0, 50)}'`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Helper container spec
// ---------------------------------------------------------------------------

/**
 * Build the trusted container spec for a Git helper. Exposed for unit testing
 * the security boundary without running Docker.
 *
 * The container Cmd is ALWAYS the fixed HELPER_IDLE_CMD (sleep). Git is
 * executed separately via Docker exec with a pure argv array — never via shell.
 */
export function buildGitHelperSpec(opts: GitHelperOptions): GitHelperContainerSpec {
  return {
    Image: opts.helperImage,
    User: '0:0', // root to read host-owned .git objects
    Cmd: HELPER_IDLE_CMD,
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_RESOURCE]: 'git-helper',
      [LABEL_JOB]: opts.jobId,
    },
    NetworkDisabled: true,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      Binds: [`${opts.hostPath}:/src:ro`],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=64m' },
      Memory: 256 * 1024 * 1024,
      PidsLimit: 16,
    },
  };
}

/**
 * Build the Git exec command (argv array) for a helper invocation.
 * Exposed for unit testing to prove no shell is involved.
 *
 * The returned array is passed DIRECTLY to Docker exec Cmd — each element
 * becomes a distinct argv entry. Variable values (commit, OID) are NEVER
 * interpolated into a string that is then parsed as a command.
 */
export function buildGitExecCmd(gitArgs: string[]): string[] {
  // Pure argv: ['git', '-C', '/src', ...subcommand, ...args]
  // Every element is a distinct argv entry. No shell. No interpolation.
  return ['git', ...gitArgs];
}

// ---------------------------------------------------------------------------
// Docker Git helper execution (shell-free)
// ---------------------------------------------------------------------------

let helperCounter = 0;

/**
 * Run a Git command in a trusted Docker helper container and retrieve
 * binary-safe output via Docker exec stream demultiplexing.
 *
 * Execution model (NO SHELL):
 *   1. Create helper container with Cmd=['sleep','60'] (idle process)
 *   2. Start helper container
 *   3. Docker exec with Cmd=['git', ...args] — pure argv, no shell
 *   4. Collect raw stdout bytes from demultiplexed exec stream
 *   5. Collect stderr separately (for diagnostics only)
 *   6. Check exec exit code
 *   7. Stop and remove helper container
 *
 * Binary safety: Docker's multiplexed stream protocol (8-byte frame headers)
 * delivers stdout and stderr as separate binary streams. No encoding
 * conversion, no line-ending normalization, no truncation.
 */
async function runGitHelper(opts: GitHelperOptions, gitArgs: string[], maxBytes: number): Promise<Buffer> {
  const n = helperCounter++;
  const name = `${NS}-git-${opts.jobId}-${n}`;

  const spec = buildGitHelperSpec(opts);
  let containerId: string | undefined;

  try {
    containerId = await createContainer(name, spec as unknown as Record<string, unknown>);
    await startContainer(containerId);

    // Execute Git via Docker exec — pure argv, NO shell
    const execCmd = buildGitExecCmd(gitArgs);
    const execId = await execCreate(containerId, { cmd: execCmd, user: '0:0' });
    const { stdout, stderr, done } = await execStartStream(execId);

    // Collect stdout as raw binary Buffer (binary-safe, no encoding)
    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    stdout.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen <= maxBytes) {
        stdoutChunks.push(chunk);
      }
    });

    // Collect stderr separately (diagnostics only, bounded)
    const stderrChunks: Buffer[] = [];
    let stderrLen = 0;
    stderr.on('data', (chunk: Buffer) => {
      if (stderrLen < 4096) { // bounded diagnostic capture
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    // Wait for exec stream to complete with timeout
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), HELPER_TIMEOUT_MS),
    );
    const result = await Promise.race([done.then(() => 'done' as const), timeoutPromise]);

    if (result === 'timeout') {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `git helper timed out after ${HELPER_TIMEOUT_MS}ms`,
        500,
      );
    }

    // Check exec exit code
    const inspection = await execInspect(execId);
    if (inspection.ExitCode !== 0) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `git helper exited with code ${inspection.ExitCode}`,
        500,
      );
    }

    // Validate output size
    if (stdoutLen > maxBytes) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `git helper output (${stdoutLen} bytes) exceeds maximum (${maxBytes} bytes)`,
        500,
      );
    }

    return Buffer.concat(stdoutChunks);
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError(
      'BASE_CERTIFICATION_FAILED',
      `git helper infrastructure failure: ${(e as Error).message}`,
      500,
    );
  } finally {
    if (containerId) {
      await stopContainer(containerId, 1).catch(() => {});
      await removeContainer(containerId, true).catch(() => {});
    }
    await removeContainer(name, true).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public: Create a Docker-based GitObjectReader
// ---------------------------------------------------------------------------

/**
 * Create a GitObjectReader that executes Git commands inside trusted Docker
 * helper containers. The host project is mounted read-only at /src.
 *
 * Git is invoked EXCLUSIVELY via Docker exec with pure argv arrays.
 * NO shell (sh, bash, sh -c) is used at any point. Variable values
 * (baseCommit, OID) are passed as distinct argv elements — never interpolated
 * into command strings.
 */
export function createDockerGitObjectReader(opts: GitHelperOptions): GitObjectReader {
  return {
    async listTree(commit: string): Promise<GitTreeEntry[]> {
      validateCommit(commit);
      // Each argument is a distinct argv entry — commit is NEVER part of a
      // constructed string. -C /src sets the Git working directory.
      const gitArgs = ['-C', '/src', 'ls-tree', '-r', '-t', '-z', '--full-tree', commit];
      const output = await runGitHelper(opts, gitArgs, MAX_LS_TREE_BYTES);
      const { parseGitLsTree } = await import('./baseCertifier.js');
      return parseGitLsTree(output);
    },

    async catBlob(oid: string): Promise<Buffer> {
      validateOid(oid);
      // OID is a distinct argv entry — never interpolated into a command string
      const gitArgs = ['-C', '/src', 'cat-file', 'blob', oid];
      return runGitHelper(opts, gitArgs, MAX_BLOB_BYTES);
    },
  };
}
