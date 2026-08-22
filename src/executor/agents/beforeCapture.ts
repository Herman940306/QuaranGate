/**
 * A6-B2: STAGED_BEFORE evidence capture.
 *
 * Captures a pristine, immutable copy of the staged /workspace AFTER the trusted
 * stager has materialised the committed-HEAD snapshot and BEFORE any
 * mutation-capable runner or model starts. This is the only point in the job
 * lifecycle where the workspace is guaranteed clean and the model has not yet
 * had any opportunity to mutate it.
 *
 * REQUIRED ORDER (enforced by kiroBackend.prepare()):
 *   stageWorkspace() → captureBeforeEvidence() → [model/runner starts]
 *
 * A failed capture is a hard fail-closed: if captureBeforeEvidence() throws, the
 * caller MUST NOT proceed to run the model.
 *
 * ## Evidence storage
 *
 * Evidence is stored on a dedicated per-job Docker-managed volume:
 *   - Created by trusted Executor code (never the runner)
 *   - Job-scoped: one volume per job
 *   - Never mounted into the Kiro runner container
 *   - Labeled with LABEL_RESOURCE='evidence' to distinguish from ephemeral A3 resources
 *   - Not deleted by A3 orphan reconciliation (reconciler skips 'evidence' resources)
 *   - Retained after normal runner cleanup on success
 *   - Removed on capture failure (incomplete evidence never persists)
 *
 * The capture helper mounts:
 *   - Workspace volume READ-ONLY (source)
 *   - Evidence volume WRITABLE (destination)
 *
 * ## Evidence layout (inside the evidence volume)
 *
 * /evidence/files/<relPath>   — exact byte-copies of regular files
 * /evidence/manifest.json     — deterministic metadata index
 *
 * For each supported entry (regular file) the following is preserved:
 *   - normalized workspace-relative path
 *   - entry kind ('file' | 'dir' | 'symlink')
 *   - relevant mode (lower 12 bits of tar header mode)
 *   - exact byte size
 *   - SHA-256 of exact bytes (hex)
 *
 * Directories and symlinks are recorded in the index but do NOT produce a stored
 * file — symlinks are never followed. Unknown/unsupported tar entry types fail
 * the entire capture (fail closed).
 *
 * ## Limits (fail closed — never truncate)
 *
 *   MAX_BEFORE_FILES       10 000 regular-file entries (structural safety)
 *   maxEvidenceBytes       from trusted job resource policy (aggregate byte limit)
 *
 * Exceeding any limit causes a BridgeError('BEFORE_CAPTURE_LIMIT') and the
 * evidence volume is removed.
 *
 * ## Path safety
 *
 * Every tar entry path is validated:
 *   - stripped of any leading slash or './' prefix
 *   - checked for '..' segments (path escape → fail closed)
 *   - checked for NUL bytes
 *   - checked for backslash (non-POSIX normalised → fail closed)
 *   - defense-in-depth: resolved path must not escape evidence root
 */
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { extract as tarExtract } from 'tar-stream';
import { BridgeError } from '../../shared/errors.js';
import {
  createVolume, removeVolume,
  createContainer, startContainer, waitContainer,
  removeContainer, getArchive,
} from '../docker.js';
import {
  SANDBOX_LABEL_NS, LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB,
  RUNNER_USER, WORKSPACE_PATH, evidenceVolumeName,
} from './sandboxSpec.js';

/**
 * The evidence volume name is owned by sandboxSpec so the creator (here) and
 * the lifecycle owner (evidenceCollector) can never diverge. Re-exported to
 * preserve this module's existing public surface.
 */
export { evidenceVolumeName } from './sandboxSpec.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Structural safety bound: max regular-file entries in the capture. */
export const MAX_BEFORE_FILES = 10_000;

/** SANDBOX_LABEL_NS with dots replaced — used for container/volume names. */
function ns(): string { return SANDBOX_LABEL_NS.replace(/\./g, '-'); }

function captureContainerName(jobId: string): string {
  return `${ns()}-before-${jobId}`;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BeforeEntryKind = 'file' | 'dir' | 'symlink';

export interface BeforeEntry {
  /** Workspace-relative path, no leading slash, forward slashes. */
  relPath: string;
  kind: BeforeEntryKind;
  /** Lower 12 bits of tar header mode (permissions + setuid/setgid/sticky). */
  mode: number;
  /** Exact byte size (from tar stream). Zero for non-file kinds. */
  sizeBytes: number;
  /** SHA-256 hex of exact bytes. Empty string for non-file kinds. */
  sha256: string;
  /** Evidence-volume-relative storage path for file kinds. Undefined for non-file kinds. */
  storedAt?: string;
}

export interface BeforeCaptureResult {
  jobId: string;
  /** Docker volume name holding the evidence. */
  evidenceVolume: string;
  capturedAt: string;
  entryCount: number;
  totalBytes: number;
  entries: BeforeEntry[];
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a raw tar entry path to a safe workspace-relative
 * path. Returns the normalized path string or throws BridgeError on any
 * path-safety violation.
 */
export function validateTarEntryPath(raw: string): string {
  if (raw.includes('\0')) {
    throw new BridgeError('BEFORE_CAPTURE_UNSAFE_PATH', `tar entry path contains NUL: ${JSON.stringify(raw)}`, 500);
  }
  if (raw.includes('\\')) {
    throw new BridgeError('BEFORE_CAPTURE_UNSAFE_PATH', `tar entry path contains backslash: ${JSON.stringify(raw)}`, 500);
  }
  let p = raw;
  if (p.startsWith('/')) p = p.slice(1);
  else if (p.startsWith('./')) p = p.slice(2);

  const parts = p.split('/');
  for (const part of parts) {
    if (part === '..') {
      throw new BridgeError('BEFORE_CAPTURE_PATH_ESCAPE', `tar entry path escapes workspace: ${JSON.stringify(raw)}`, 500);
    }
  }

  if (p === '' || p === '.') {
    return '';
  }

  return p;
}

/**
 * Verify that resolving `relPath` under `filesRoot` does not escape `filesRoot`.
 * Defense-in-depth on top of validateTarEntryPath.
 */
export function assertNoEscape(filesRoot: string, relPath: string): void {
  const abs = resolve(filesRoot, relPath);
  const root = resolve(filesRoot);
  if (!abs.startsWith(root + sep) && abs !== root) {
    throw new BridgeError('BEFORE_CAPTURE_PATH_ESCAPE', `resolved path escapes capture root: ${relPath}`, 500);
  }
}

// ---------------------------------------------------------------------------
// Tar entry classification
// ---------------------------------------------------------------------------

/** Map a tar header type string to a BeforeEntryKind. Fails closed on unsupported types. */
export function classifyTarEntry(type: string | null | undefined): BeforeEntryKind {
  switch (type) {
    case 'file':       return 'file';
    case 'directory':  return 'dir';
    case 'symlink':    return 'symlink';
    case 'link':       return 'symlink'; // hard link: treat as symlink (no byte follow)
    case null:
    case undefined:
      throw new BridgeError(
        'BEFORE_CAPTURE_UNSUPPORTED_ENTRY',
        `tar entry has null/undefined type; capture aborted (fail closed)`,
        500,
      );
    case 'block-device':
    case 'char-device':
    case 'fifo':
      throw new BridgeError(
        'BEFORE_CAPTURE_UNSUPPORTED_ENTRY',
        `tar entry has unsupported type '${type}'; capture aborted (fail closed)`,
        500,
      );
    default:
      throw new BridgeError(
        'BEFORE_CAPTURE_UNSUPPORTED_ENTRY',
        `tar entry has unrecognised type '${type}'; capture aborted (fail closed)`,
        500,
      );
  }
}

// ---------------------------------------------------------------------------
// Streaming tar parse → in-memory entries with hashes
// ---------------------------------------------------------------------------

/**
 * Parse a tar stream from the given Readable. For each entry:
 *   - validate and normalize the path
 *   - classify the entry kind
 *   - for regular files: accumulate bytes, hash them, enforce limits
 *   - for dirs/symlinks: record metadata only
 *
 * Returns the parsed entries with file content buffers (for subsequent storage
 * on the evidence volume). All limits are enforced fail-closed.
 */
async function parseTarStream(
  tarStream: Readable,
  maxEvidenceBytes: number,
): Promise<{ entries: BeforeEntry[]; fileBuffers: Map<string, Buffer> }> {
  const entries: BeforeEntry[] = [];
  const fileBuffers = new Map<string, Buffer>();
  let totalBytes = 0;
  let fileCount = 0;

  await new Promise<void>((resolveP, reject) => {
    const ex = tarExtract();
    let rejected = false;

    function fail(e: unknown): void {
      if (rejected) return;
      rejected = true;
      reject(e);
      ex.destroy();
    }

    ex.on('entry', (header, stream, next) => {
      if (rejected) { stream.resume(); return; }

      const rawPath: string = header.name ?? '';
      let relPath: string;
      try {
        relPath = validateTarEntryPath(rawPath);
      } catch (e) {
        stream.resume();
        fail(e);
        return;
      }

      // Root/self entries — skip
      if (relPath === '') {
        stream.resume();
        next();
        return;
      }

      let kind: BeforeEntryKind;
      try {
        kind = classifyTarEntry(header.type as string | null | undefined);
      } catch (e) {
        stream.resume();
        fail(e);
        return;
      }

      const mode = (header.mode ?? 0) & 0o7777;

      if (kind !== 'file') {
        stream.resume();
        entries.push({ relPath, kind, mode, sizeBytes: 0, sha256: '' });
        next();
        return;
      }

      // --- Regular file ---

      // Defense-in-depth path escape check
      try {
        assertNoEscape('/evidence/files', relPath);
      } catch (e) {
        stream.resume();
        fail(e);
        return;
      }

      // File count limit (structural safety)
      fileCount += 1;
      if (fileCount > MAX_BEFORE_FILES) {
        stream.resume();
        fail(new BridgeError(
          'BEFORE_CAPTURE_LIMIT',
          `workspace contains more than ${MAX_BEFORE_FILES} files — capture aborted (fail closed)`,
          500,
        ));
        return;
      }

      const chunks: Buffer[] = [];
      let fileBytes = 0;

      stream.on('data', (chunk: Buffer) => {
        if (rejected) return;
        fileBytes += chunk.length;
        totalBytes += chunk.length;

        // Aggregate limit (trusted maxEvidenceBytes)
        if (totalBytes > maxEvidenceBytes) {
          fail(new BridgeError(
            'BEFORE_CAPTURE_LIMIT',
            `total captured bytes (${totalBytes}) exceed maxEvidenceBytes (${maxEvidenceBytes}) — capture aborted (fail closed)`,
            500,
          ));
          return;
        }

        chunks.push(chunk);
      });

      stream.on('end', () => {
        if (rejected) { next(); return; }
        const buf = Buffer.concat(chunks);
        const sha256 = createHash('sha256').update(buf).digest('hex');
        const storedAt = `/evidence/files/${relPath}`;
        entries.push({ relPath, kind: 'file', mode, sizeBytes: fileBytes, sha256, storedAt });
        fileBuffers.set(relPath, buf);
        next();
      });

      stream.on('error', (e) => {
        fail(new BridgeError('BEFORE_CAPTURE_IO', `stream error for ${relPath}: ${(e as Error).message}`, 500));
      });
    });

    ex.on('finish', () => { if (!rejected) resolveP(); });
    ex.on('error', (e) => fail(
      e instanceof BridgeError ? e
        : new BridgeError('BEFORE_CAPTURE_IO', `tar extract error: ${(e as Error).message}`, 500),
    ));

    tarStream.on('error', (e) => fail(
      new BridgeError('BEFORE_CAPTURE_IO', `archive stream error: ${(e as Error).message}`, 500),
    ));
    tarStream.pipe(ex);
  });

  return { entries, fileBuffers };
}

// ---------------------------------------------------------------------------
// Docker helper: mount workspace volume RO, stream archive out
// ---------------------------------------------------------------------------

/**
 * Spawn a minimal short-lived helper container with the workspace volume
 * mounted READ-ONLY. Stream the full /workspace archive via Docker archive API
 * and return the tar Readable. The container is removed in cleanup.
 *
 * The helper:
 *   - has no network
 *   - has a read-only rootfs
 *   - drops all capabilities
 *   - runs as non-root (RUNNER_USER)
 *   - is removed (force=true) in cleanup regardless of success/failure
 *   - uses `true` as its command so it exits immediately
 */
async function mountAndStream(opts: {
  jobId: string;
  volumeName: string;
  helperImage: string;
}): Promise<{ tarStream: Readable; cleanup: () => Promise<void> }> {
  const name = captureContainerName(opts.jobId);
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: 'true',
    [LABEL_RESOURCE]: 'before-capture',
    [LABEL_JOB]: opts.jobId,
  };

  let containerId: string | undefined;

  const cleanup = async (): Promise<void> => {
    if (containerId) {
      await removeContainer(containerId, true).catch(() => {});
      containerId = undefined;
    }
    await removeContainer(name, true).catch(() => {});
  };

  try {
    containerId = await createContainer(name, {
      Image: opts.helperImage,
      User: RUNNER_USER,
      Cmd: ['true'],
      Labels: labels,
      NetworkDisabled: true,
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        Mounts: [{
          Type: 'volume',
          Source: opts.volumeName,
          Target: WORKSPACE_PATH,
          ReadOnly: true,
        }],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
        Memory: 64 * 1024 * 1024,
        PidsLimit: 8,
      },
    });
    await startContainer(containerId);
    await waitContainer(containerId, { timeoutMs: 10_000 });

    const { body } = await getArchive(containerId, WORKSPACE_PATH);

    return { tarStream: body, cleanup };
  } catch (e) {
    await cleanup();
    throw e instanceof BridgeError ? e
      : new BridgeError('BEFORE_CAPTURE_IO', `failed to mount workspace for capture: ${(e as Error).message}`, 500);
  }
}

// ---------------------------------------------------------------------------
// Docker helper: write captured evidence to the evidence volume
// ---------------------------------------------------------------------------

/**
 * Write the captured file buffers + manifest to the evidence volume via a
 * short-lived helper that mounts the evidence volume RW. Uses the Docker
 * putArchive API to stream a tar containing all evidence files + manifest.
 */
async function writeEvidenceToVolume(opts: {
  jobId: string;
  evidenceVol: string;
  helperImage: string;
  entries: BeforeEntry[];
  fileBuffers: Map<string, Buffer>;
  capturedAt: string;
  totalBytes: number;
}): Promise<void> {
  const name = `${ns()}-evwrite-${opts.jobId}`;
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: 'true',
    [LABEL_RESOURCE]: 'before-capture',
    [LABEL_JOB]: opts.jobId,
  };

  // Build a tar archive containing: files/<relPath> for each file entry, plus manifest.json
  const { pack } = await import('tar-stream');
  const p = pack();
  const archiveChunks: Buffer[] = [];

  const archivePromise = new Promise<Buffer>((resolveP, reject) => {
    p.on('data', (chunk: Buffer) => archiveChunks.push(chunk));
    p.on('end', () => resolveP(Buffer.concat(archiveChunks)));
    p.on('error', reject);
  });

  // Add directory entries
  p.entry({ name: 'evidence/', type: 'directory', mode: 0o755 }, '');
  p.entry({ name: 'evidence/files/', type: 'directory', mode: 0o755 }, '');

  // Add file entries with their exact bytes
  for (const entry of opts.entries) {
    if (entry.kind !== 'file') continue;
    const buf = opts.fileBuffers.get(entry.relPath);
    if (!buf) continue;

    // Ensure parent directories exist in the tar
    const parts = entry.relPath.split('/');
    if (parts.length > 1) {
      let dirPath = 'evidence/files';
      for (let i = 0; i < parts.length - 1; i++) {
        dirPath += '/' + parts[i];
        p.entry({ name: dirPath + '/', type: 'directory', mode: 0o755 }, '');
      }
    }

    p.entry({ name: `evidence/files/${entry.relPath}`, type: 'file', mode: entry.mode & 0o666, size: buf.length }, buf);
  }

  // Add manifest
  const manifest = {
    jobId: opts.jobId,
    capturedAt: opts.capturedAt,
    entryCount: opts.entries.filter((e) => e.kind === 'file').length,
    totalBytes: opts.totalBytes,
    entries: opts.entries.map((e) => ({
      relPath: e.relPath,
      kind: e.kind,
      mode: e.mode,
      sizeBytes: e.sizeBytes,
      sha256: e.sha256,
    })),
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  p.entry({ name: 'evidence/manifest.json', type: 'file', mode: 0o444, size: manifestBuf.length }, manifestBuf);

  p.finalize();
  const tarBuf = await archivePromise;

  // Write the tar archive to the evidence volume via a helper container
  let containerId: string | undefined;
  try {
    containerId = await createContainer(name, {
      Image: opts.helperImage,
      User: '0:0', // root to write to volume
      Cmd: ['true'],
      Labels: labels,
      NetworkDisabled: true,
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'none',
        Mounts: [{
          Type: 'volume',
          Source: opts.evidenceVol,
          Target: '/evidence',
          ReadOnly: false,
        }],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
        Memory: 64 * 1024 * 1024,
        PidsLimit: 8,
      },
    });
    await startContainer(containerId);
    await waitContainer(containerId, { timeoutMs: 10_000 });

    // Use putArchive to write the tar to the evidence volume root
    const { putArchive } = await import('../docker.js');
    await putArchive(containerId, '/', tarBuf);
  } finally {
    if (containerId) await removeContainer(containerId, true).catch(() => {});
    await removeContainer(name, true).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Capture pristine STAGED_BEFORE evidence from the already-staged workspace
 * volume into a dedicated per-job Docker evidence volume.
 *
 * Must be called AFTER stageWorkspace() succeeds and BEFORE any
 * mutation-capable runner/model is started.
 *
 * On success returns a BeforeCaptureResult. The evidence volume is retained
 * and must NOT be cleaned up by normal runner cleanup. On any failure the
 * incomplete evidence volume is removed and a BridgeError is thrown.
 *
 * @param opts.jobId             Job identifier
 * @param opts.volumeName        Name of the already-staged workspace Docker volume
 * @param opts.helperImage       Trusted helper image
 * @param opts.maxEvidenceBytes  Aggregate byte limit from trusted job resource policy
 */
export async function captureBeforeEvidence(opts: {
  jobId: string;
  volumeName: string;
  helperImage: string;
  maxEvidenceBytes: number;
}): Promise<BeforeCaptureResult> {
  const evidenceVol = evidenceVolumeName(opts.jobId);

  // Create the dedicated evidence volume (job-scoped, labeled as 'evidence')
  try {
    await createVolume(evidenceVol, {
      [LABEL_MANAGED]: 'true',
      [LABEL_RESOURCE]: 'evidence',
      [LABEL_JOB]: opts.jobId,
    });
  } catch (e) {
    throw e instanceof BridgeError ? e
      : new BridgeError('BEFORE_CAPTURE_IO', `cannot create evidence volume: ${(e as Error).message}`, 500);
  }

  const capturedAt = new Date().toISOString();

  // Mount workspace RO and stream tar archive
  const { tarStream, cleanup } = await mountAndStream({
    jobId: opts.jobId,
    volumeName: opts.volumeName,
    helperImage: opts.helperImage,
  }).catch(async (e) => {
    // Capture failed before we could even stream — remove evidence volume
    await removeVolume(evidenceVol, true).catch(() => {});
    throw e;
  });

  let entries: BeforeEntry[];
  let fileBuffers: Map<string, Buffer>;

  try {
    const result = await parseTarStream(tarStream, opts.maxEvidenceBytes);
    entries = result.entries;
    fileBuffers = result.fileBuffers;
  } catch (e) {
    await cleanup();
    await removeVolume(evidenceVol, true).catch(() => {});
    throw e instanceof BridgeError ? e
      : new BridgeError('BEFORE_CAPTURE_IO', `capture stream error: ${(e as Error).message}`, 500);
  }

  await cleanup();

  // Sort entries deterministically by relPath for stable ordering
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const fileEntries = entries.filter((e) => e.kind === 'file');
  const totalBytes = fileEntries.reduce((s, e) => s + e.sizeBytes, 0);

  // Write evidence to the Docker volume
  try {
    await writeEvidenceToVolume({
      jobId: opts.jobId,
      evidenceVol,
      helperImage: opts.helperImage,
      entries,
      fileBuffers,
      capturedAt,
      totalBytes,
    });
  } catch (e) {
    // Write failed — remove incomplete evidence volume
    await removeVolume(evidenceVol, true).catch(() => {});
    throw e instanceof BridgeError ? e
      : new BridgeError('BEFORE_CAPTURE_IO', `failed to write evidence to volume: ${(e as Error).message}`, 500);
  }

  return {
    jobId: opts.jobId,
    evidenceVolume: evidenceVol,
    capturedAt,
    entryCount: fileEntries.length,
    totalBytes,
    entries,
  };
}
