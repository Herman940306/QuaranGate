/**
 * A6-B3: POST workspace capture + write-quiescence gate.
 *
 * Captures the complete post-model workspace state AFTER the runner has been
 * removed and write-quiescence is confirmed. Produces canonical snapshot
 * entries and stores file content as content-addressed blobs on the existing
 * B2 evidence volume.
 *
 * WRITE-QUIESCENCE INVARIANT:
 *   POST capture must NEVER race a mutation-capable runner. The caller MUST
 *   have removed the runner container (via the trusted Docker removal
 *   primitive) and confirmed removal BEFORE calling capturePostEvidence().
 *   If runner removal fails, POST must NOT begin.
 *
 * STORAGE MODEL:
 *   POST file bytes are stored as content-addressed blobs at:
 *     /evidence/blobs/<first-2-hex>/<64-char-sha256>
 *   on the EXISTING B2 evidence volume. B2 BEFORE evidence (/evidence/files/
 *   and /evidence/manifest.json) is NEVER mutated.
 *
 * POST does NOT truncate, skip, or produce LARGE:<size> entries. Any
 * unsupported/special entry fails capture or produces explicit
 * incomplete/non-applicable evidence.
 *
 * BUDGET ENFORCEMENT:
 *   The remaining evidence allowance (maxEvidenceBytes minus BEFORE unique
 *   blob bytes) is enforced PER-ENTRY during capture. If a single file
 *   exceeds the remaining budget ceiling, capture aborts immediately without
 *   buffering the entire workspace. Deduplication is SHA-256-based: unchanged
 *   BEFORE→POST content is not double-counted; duplicate POST blobs are
 *   counted once.
 *
 * MEMORY INVARIANT (R4):
 *   After each regular file has been fully hashed, persistent retained content
 *   is deduplicated by SHA-256. Only ONE canonical Buffer instance exists per
 *   unique POST content hash. Duplicate paths reference the same Buffer object.
 *   Persistent retained-content memory is bounded by the sum of unique accepted
 *   POST content, not by path count.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { extract as tarExtract } from 'tar-stream';
import { BridgeError } from '../../shared/errors.js';
import {
  canonicalizeWorkspaceEntryPath, stripWorkspaceArchiveRoot, assertNoEscape,
} from './beforeCapture.js';
import type { SnapshotEntry } from './canonicalJson.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostCaptureEntry {
  /** Canonical snapshot entry for this path. */
  snapshot: SnapshotEntry;
  /** For regular files: exact content bytes. Undefined for non-file kinds. */
  content?: Buffer;
}

export interface PostCaptureResult {
  entries: PostCaptureEntry[];
  /** Total unique regular-file content bytes captured. */
  totalFileBytes: number;
}

/** Structural safety bound: max entries in post capture. */
export const MAX_POST_ENTRIES = 10_000;

// ---------------------------------------------------------------------------
// Write-quiescence assertion
// ---------------------------------------------------------------------------

/**
 * Assert write-quiescence: the runner container must have been removed.
 * This is called with the runner container reference that MUST be null
 * after successful removal. Fails closed if the runner is still referenced.
 */
export function assertWriteQuiescence(runnerContainerId: string | null): void {
  if (runnerContainerId !== null) {
    throw new BridgeError(
      'POST_CAPTURE_QUIESCENCE_FAILED',
      'POST capture cannot begin: runner container has not been removed (write-quiescence violated)',
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Tar stream parsing for POST capture
// ---------------------------------------------------------------------------

/**
 * Classify a tar entry type for POST capture. Unlike B2 which treats hardlinks
 * as symlinks, POST attempts to resolve hardlinks to canonical file content
 * when the target is available in the same archive.
 *
 * Returns the entry kind or 'hardlink' for deferred resolution.
 */
type PostEntryKind = 'file' | 'dir' | 'symlink' | 'hardlink' | 'unsupported';

function classifyPostTarEntry(type: string | null | undefined): PostEntryKind {
  switch (type) {
    case 'file': return 'file';
    case 'directory': return 'dir';
    case 'symlink': return 'symlink';
    case 'link': return 'hardlink';
    case null:
    case undefined:
      return 'unsupported';
    default:
      return 'unsupported';
  }
}

/**
 * Parse the workspace tar archive for POST capture. Produces PostCaptureEntry
 * items with full content for regular files, and metadata for dirs/symlinks.
 *
 * Hardlinks are resolved to canonical file content if the target is available
 * in the captured entries. If resolution fails, the entry is marked as
 * unsupported (contentComplete=false).
 *
 * MEMORY INVARIANT (R4):
 *   Persistent content storage uses a canonical content map:
 *     Map<sha256, Buffer>
 *   After each file is fully hashed, if the hash is already retained, the
 *   newly captured Buffer is discarded and the canonical Buffer is reused.
 *   All PostCaptureEntry.content values for equal hashes reference the SAME
 *   Buffer object. Persistent retained-content memory is bounded by the sum
 *   of unique accepted POST content.
 *
 * BUDGET ENFORCEMENT (production resource boundary):
 *   - `remainingBudget` is the maximum NEW unique bytes this POST capture may
 *     introduce (total maxEvidenceBytes minus BEFORE unique blob bytes).
 *   - `knownBeforeHashes` (optional) is the set of content hashes already
 *     accounted in the BEFORE budget. POST content matching a known BEFORE
 *     hash consumes NO additional logical budget.
 *   - Per-file: if bytes streamed for a single file already exceed the
 *     remaining possible budget, capture aborts immediately (fail-closed).
 *   - Unique POST content hashes are tracked; duplicates are not double-counted.
 *   - If accepted unique content would exceed remainingBudget:
 *     fail with ARTIFACT_BUDGET_EXCEEDED and stop archive processing.
 *
 * @param tarStream - Readable tar stream of the post-model workspace
 * @param remainingBudget - Remaining bytes available under maxEvidenceBytes
 *   (total budget minus BEFORE unique blob bytes)
 * @param knownBeforeHashes - Optional set of SHA-256 hashes already counted
 *   in the BEFORE budget (unchanged content does not consume POST budget)
 * @param maxFileBytes - Absolute per-file streaming ceiling (total
 *   maxEvidenceBytes). No single file can exceed the entire job evidence
 *   policy regardless of deduplication. Defaults to remainingBudget if not
 *   supplied (backward compatible).
 */
export async function parsePostTarStream(
  tarStream: Readable,
  remainingBudget: number,
  knownBeforeHashes?: ReadonlySet<string>,
  maxFileBytes?: number,
): Promise<PostCaptureResult> {
  const beforeHashes = knownBeforeHashes ?? new Set<string>();
  const absoluteCeiling = maxFileBytes ?? remainingBudget;

  // Budget tracking: unique NEW hashes (not in BEFORE) and their sizes
  const newUniqueHashes = new Map<string, number>(); // hash → sizeBytes
  let budgetConsumed = 0;

  // R4: Canonical content store — ONE Buffer per unique POST hash.
  const canonicalContent = new Map<string, Buffer>();

  // Per-entry metadata (no per-path Buffer storage)
  const rawEntries: Array<{
    relPath: string;
    kind: PostEntryKind;
    mode: number;
    contentHash: string | null;
    linkTarget: string | null;
  }> = [];
  let entryCount = 0;

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
        // Identical canonicalization to BEFORE (beforeCapture.parseTarStream):
        // the same real project file MUST produce the same relPath on both
        // sides, or change detection and apply resolve different paths.
        relPath = canonicalizeWorkspaceEntryPath(rawPath);
      } catch (e) {
        stream.resume();
        fail(e);
        return;
      }

      // Empty/self entries, and the '/workspace' archive root itself — skip
      if (relPath === '') {
        stream.resume();
        next();
        return;
      }

      entryCount++;
      if (entryCount > MAX_POST_ENTRIES) {
        stream.resume();
        fail(new BridgeError(
          'POST_CAPTURE_LIMIT',
          `POST workspace exceeds ${MAX_POST_ENTRIES} entries — capture aborted`,
          500,
        ));
        return;
      }

      const kind = classifyPostTarEntry(header.type as string | null | undefined);
      const mode = (header.mode ?? 0) & 0o7777;

      if (kind === 'dir') {
        stream.resume();
        rawEntries.push({ relPath, kind, mode, contentHash: null, linkTarget: null });
        next();
        return;
      }

      if (kind === 'symlink') {
        stream.resume();
        const target = (header.linkname ?? '') as string;
        rawEntries.push({ relPath, kind, mode, contentHash: null, linkTarget: target });
        next();
        return;
      }

      if (kind === 'hardlink') {
        stream.resume();
        const target = (header.linkname ?? '') as string;
        rawEntries.push({ relPath, kind, mode, contentHash: null, linkTarget: target });
        next();
        return;
      }

      if (kind === 'unsupported') {
        stream.resume();
        rawEntries.push({ relPath, kind, mode, contentHash: null, linkTarget: null });
        next();
        return;
      }

      // Regular file — stream with per-entry budget enforcement
      try {
        assertNoEscape('/evidence/blobs', relPath);
      } catch (e) {
        stream.resume();
        fail(e);
        return;
      }

      // Per-entry budget ceiling: the ABSOLUTE maximum this file could be
      // without being able to ever fit under the job evidence policy. A file
      // exceeding `absoluteCeiling` (total maxEvidenceBytes) cannot exist in
      // the evidence system at all. Files smaller might still be duplicates
      // of BEFORE or already-seen POST content (consuming 0 budget).
      // We cannot know until the hash is complete, so the streaming ceiling
      // uses the absolute policy limit. The post-hash dedup check enforces
      // the real incremental budget.
      const perFileCeiling = absoluteCeiling;

      const chunks: Buffer[] = [];
      const hasher = createHash('sha256');
      let fileBytes = 0;

      stream.on('data', (chunk: Buffer) => {
        if (rejected) return;
        fileBytes += chunk.length;

        // BUDGET ENFORCEMENT: abort if this single file already exceeds
        // the maximum possible remaining logical budget.
        if (fileBytes > perFileCeiling && perFileCeiling >= 0) {
          fail(new BridgeError(
            'ARTIFACT_BUDGET_EXCEEDED',
            `POST file '${relPath}' exceeds remaining evidence budget `
            + `(${fileBytes} bytes read, ceiling=${perFileCeiling}) — capture aborted`,
            500,
          ));
          stream.destroy();
          return;
        }

        chunks.push(chunk);
        hasher.update(chunk);
      });

      stream.on('end', () => {
        if (rejected) { next(); return; }
        const buf = Buffer.concat(chunks);
        const hash = hasher.digest('hex');

        // R4: Deduplication — check if this hash is already retained
        if (canonicalContent.has(hash)) {
          // Duplicate POST content: discard newly captured Buffer, reuse canonical.
          // No additional budget consumed.
          rawEntries.push({ relPath, kind: 'file', mode, contentHash: hash, linkTarget: null });
          next();
          return;
        }

        // Check if hash is known from BEFORE (0 additional budget)
        if (beforeHashes.has(hash)) {
          // Content unchanged from BEFORE: retain canonical Buffer but no budget.
          canonicalContent.set(hash, buf);
          rawEntries.push({ relPath, kind: 'file', mode, contentHash: hash, linkTarget: null });
          next();
          return;
        }

        // New unique POST content — account budget
        const newBudget = budgetConsumed + buf.length;
        if (newBudget > remainingBudget) {
          fail(new BridgeError(
            'ARTIFACT_BUDGET_EXCEEDED',
            `POST unique content (${newBudget} bytes) exceeds remaining evidence budget `
            + `(${remainingBudget}) at file '${relPath}' — capture aborted`,
            500,
          ));
          return;
        }
        budgetConsumed = newBudget;
        newUniqueHashes.set(hash, buf.length);

        // Retain as canonical content
        canonicalContent.set(hash, buf);
        rawEntries.push({ relPath, kind: 'file', mode, contentHash: hash, linkTarget: null });
        next();
      });

      stream.on('error', (e) => {
        fail(new BridgeError('POST_CAPTURE_IO', `stream error for ${relPath}: ${(e as Error).message}`, 500));
      });
    });

    ex.on('finish', () => { if (!rejected) resolveP(); });
    ex.on('error', (e) => fail(
      e instanceof BridgeError ? e
        : new BridgeError('POST_CAPTURE_IO', `tar extract error: ${(e as Error).message}`, 500),
    ));

    tarStream.on('error', (e) => fail(
      new BridgeError('POST_CAPTURE_IO', `archive stream error: ${(e as Error).message}`, 500),
    ));
    tarStream.pipe(ex);
  });

  // Build a map of relPath -> contentHash for hardlink resolution
  const hashByPath = new Map<string, string>();
  for (const e of rawEntries) {
    if (e.kind === 'file' && e.contentHash) {
      hashByPath.set(e.relPath, e.contentHash);
    }
  }

  // Convert raw entries to PostCaptureEntry with canonical snapshot entries
  const entries: PostCaptureEntry[] = [];

  // R4: totalFileBytes = sum of unique POST regular-file content sizes.
  // Each unique hash contributes its size once, regardless of path count.
  const countedHashes = new Set<string>();
  let totalFileBytes = 0;

  for (const raw of rawEntries) {
    switch (raw.kind) {
      case 'file': {
        const hash = raw.contentHash!;
        const canonical = canonicalContent.get(hash)!;

        // Count unique POST content once for totalFileBytes
        if (!countedHashes.has(hash)) {
          countedHashes.add(hash);
          totalFileBytes += canonical.length;
        }

        entries.push({
          snapshot: { path: raw.relPath, kind: 'file', mode: raw.mode, sizeBytes: canonical.length, contentHash: hash },
          content: canonical,
        });
        break;
      }
      case 'dir': {
        entries.push({
          snapshot: { path: raw.relPath, kind: 'dir', mode: raw.mode },
        });
        break;
      }
      case 'symlink': {
        const target = raw.linkTarget ?? '';
        const targetHash = createHash('sha256').update(target, 'utf8').digest('hex');
        entries.push({
          snapshot: { path: raw.relPath, kind: 'symlink', mode: raw.mode, contentHash: targetHash, target },
        });
        break;
      }
      case 'hardlink': {
        // Attempt to resolve hardlink to canonical file content
        const target = raw.linkTarget ?? '';
        // Normalize the target path the same way tar entry paths are normalized,
        // INCLUDING the archive-root strip: hashByPath is keyed by canonical
        // relPath, and Docker names hardlink targets with the same
        // 'workspace/' prefix it puts on entry names. Kept lenient (no throw)
        // so a malformed link degrades to 'unsupported' exactly as before; the
        // '..' guard below is unchanged.
        let normalizedTarget = target;
        if (normalizedTarget.startsWith('/')) normalizedTarget = normalizedTarget.slice(1);
        else if (normalizedTarget.startsWith('./')) normalizedTarget = normalizedTarget.slice(2);
        normalizedTarget = stripWorkspaceArchiveRoot(normalizedTarget);

        const resolvedHash = hashByPath.get(normalizedTarget);
        if (resolvedHash !== undefined &&
            !normalizedTarget.includes('..') &&
            normalizedTarget.length > 0) {
          // Successfully resolved: treat as canonical file, reuse canonical Buffer
          const canonical = canonicalContent.get(resolvedHash)!;

          // Count unique POST content once for totalFileBytes
          if (!countedHashes.has(resolvedHash)) {
            countedHashes.add(resolvedHash);
            totalFileBytes += canonical.length;
          }

          entries.push({
            snapshot: { path: raw.relPath, kind: 'file', mode: raw.mode, sizeBytes: canonical.length, contentHash: resolvedHash },
            content: canonical,
          });
        } else {
          // Cannot resolve: mark as unsupported
          entries.push({
            snapshot: {
              path: raw.relPath,
              kind: 'unsupported',
              mode: raw.mode,
              reason: `unresolvable hardlink target: ${target}`,
            },
          });
        }
        break;
      }
      case 'unsupported': {
        entries.push({
          snapshot: {
            path: raw.relPath,
            kind: 'unsupported',
            mode: raw.mode,
            reason: 'unsupported tar entry type',
          },
        });
        break;
      }
    }
  }

  // Sort by path for deterministic ordering
  entries.sort((a, b) => a.snapshot.path < b.snapshot.path ? -1 : a.snapshot.path > b.snapshot.path ? 1 : 0);

  return { entries, totalFileBytes };
}
