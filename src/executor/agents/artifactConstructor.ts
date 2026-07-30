/**
 * A6-B3: Canonical artifact construction (R2 remediated).
 *
 * Orchestrates the full B3 artifact lifecycle with strict storage safety:
 *   1. Verify B2 BEFORE evidence integrity (hash + size)
 *   2. Canonicalize BEFORE into snapshot + blobs (budget-tracked)
 *   3. Capture POST workspace state into snapshot + blobs (budget-enforced)
 *   4. Compute canonical BEFORE → POST diff
 *   5. Certify BEFORE against Git objects at baseCommit
 *   6. Construct canonical artifact manifest (invariant-checked)
 *   7. Stage all new blobs to /evidence/.b3-temp/blobs/ (never final directly)
 *   8. Promote verified temp blobs to final /evidence/blobs/ paths
 *   9. Write-once final manifests (reject if already exist)
 *  10. Strict final storage verification (reread + rehash everything)
 *
 * STORAGE MODEL:
 *   Temporary: /evidence/.b3-temp/blobs/<prefix>/<sha256>
 *   Final:     /evidence/blobs/<prefix>/<sha256>
 *   Final:     /evidence/before-snapshot-manifest.json
 *   Final:     /evidence/post-snapshot-manifest.json
 *   Final:     /evidence/artifact-manifest.json
 *
 * B2 immutability: /evidence/files/** and /evidence/manifest.json are NEVER
 * modified. They remain the immutable source input.
 *
 * PUBLICATION OWNERSHIP: This module constructs and validates the artifact,
 * returning an ArtifactResult. It does NOT publish to JobStore — that is
 * JobEngine's responsibility.
 */
import { createHash } from 'node:crypto';
import { BridgeError } from '../../shared/errors.js';
import type { BeforeEntry, BeforeCaptureResult } from './beforeCapture.js';
import type { PostCaptureResult, PostCaptureEntry } from './postCapture.js';
import type { CertificationResult, GitObjectReader } from './baseCertifier.js';
import { certifyBeforeAgainstBase } from './baseCertifier.js';
import { computeCanonicalDiff, computeChangeSetHash } from './canonicalDiff.js';
import {
  canonicalSerialize,
  validateSnapshotManifest,
  validateArtifactManifest,
  isValidSha256,
  type SnapshotManifest,
  type SnapshotEntry,
  type SnapshotFileEntry,
  type ArtifactManifest,
  type CanonicalChangeSet,
} from './canonicalJson.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result returned to the caller (KiroBackend → JobEngine). Contains all
 * metadata needed for atomic publication. Does NOT contain blob bytes.
 */
export interface ArtifactResult {
  artifactHash: string;
  changeSetHash: string;
  contentComplete: boolean;
  applicable: boolean;
  reason: string | null;
  artifactVolume: string;
  artifactBytes: number;
  opCount: number;
  finalized: boolean;
}

/**
 * Interface for evidence volume I/O. Abstracted for testability — production
 * uses Docker volume helpers; tests use in-memory maps.
 *
 * fileExists CONTRACT (R2 G):
 *   FILE_NOT_FOUND → false
 *   Any other failure (Docker/storage/transport/archive) → THROW
 *   On successful archive retrieval, the response body MUST be consumed/drained.
 */
export interface EvidenceVolumeIO {
  /** Read a file from the evidence volume. Path is volume-relative. */
  readFile(path: string): Promise<Buffer>;
  /**
   * Check if a file exists on the evidence volume.
   * Returns false ONLY for genuine not-found. Throws on any other error.
   */
  fileExists(path: string): Promise<boolean>;
  /** Write a file to the evidence volume. Creates parent directories. */
  writeFile(path: string, content: Buffer): Promise<void>;
  /**
   * Remove a directory tree on the evidence volume (best-effort cleanup).
   * RESTRICTED: only paths under .b3-temp are permitted.
   */
  remove(path: string): Promise<void>;
}

export interface ArtifactConstructorInput {
  jobId: string;
  projectId: string;
  principalId: string;
  backend: string;
  profile: string;
  baseCommit: string;
  evidenceVolume: string;
  maxEvidenceBytes: number;
  /** B2 BEFORE capture result (immutable source). */
  beforeCapture: BeforeCaptureResult;
  /** POST capture result (already parsed tar). */
  postCapture: PostCaptureResult;
  /** Git object reader for base certification. */
  git: GitObjectReader;
  /** Evidence volume I/O adapter. */
  volumeIO: EvidenceVolumeIO;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMP_DIR = '.b3-temp';
const TEMP_BLOBS_DIR = `${TEMP_DIR}/blobs`;
const BLOBS_DIR = 'blobs';
const BEFORE_SNAPSHOT_FILE = 'before-snapshot-manifest.json';
const POST_SNAPSHOT_FILE = 'post-snapshot-manifest.json';
const ARTIFACT_MANIFEST_FILE = 'artifact-manifest.json';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Construct and validate a canonical artifact from B2 BEFORE evidence and
 * POST capture. Returns an ArtifactResult on success. Throws BridgeError on
 * any integrity failure.
 *
 * R2 STORAGE SAFETY:
 *   - New blobs written to .b3-temp/blobs/ first (never directly to final)
 *   - Budget enforced incrementally during capture (fail-fast)
 *   - Final manifests are write-once (reject if already exist)
 *   - Strict final verification rereads and rehashes everything before finalized=true
 *   - Cleanup of .b3-temp is real (restricted to that path only)
 */
export async function constructArtifact(input: ArtifactConstructorInput): Promise<ArtifactResult> {
  const { volumeIO } = input;
  let tempCreated = false;

  try {
    // --- R2-E: Write-once guard — reject if already finalized ---
    const alreadyFinalized = await volumeIO.fileExists(ARTIFACT_MANIFEST_FILE);
    if (alreadyFinalized) {
      throw new BridgeError(
        'ARTIFACT_ALREADY_FINALIZED',
        'artifact manifest already exists — second finalization rejected',
        500,
      );
    }

    // --- Step 1: Verify B2 BEFORE evidence integrity (R2-H: hash + size) ---
    const beforeEntries = input.beforeCapture.entries;
    const beforeFileEntries = beforeEntries.filter((e) => e.kind === 'file');

    for (const entry of beforeFileEntries) {
      const storedPath = `files/${entry.relPath}`;
      let storedContent: Buffer;
      try {
        storedContent = await volumeIO.readFile(storedPath);
      } catch (e) {
        throw new BridgeError(
          'ARTIFACT_B2_INTEGRITY_FAILED',
          `cannot read B2 BEFORE file '${entry.relPath}': ${(e as Error).message}`,
          500,
        );
      }
      // R2-H: Verify exact size
      if (storedContent.length !== entry.sizeBytes) {
        throw new BridgeError(
          'ARTIFACT_B2_INTEGRITY_FAILED',
          `B2 BEFORE file '${entry.relPath}' size mismatch: actual=${storedContent.length}, recorded=${entry.sizeBytes}`,
          500,
        );
      }
      // R2-H: Verify SHA-256
      const computedHash = createHash('sha256').update(storedContent).digest('hex');
      if (computedHash !== entry.sha256) {
        throw new BridgeError(
          'ARTIFACT_B2_INTEGRITY_FAILED',
          `B2 BEFORE file '${entry.relPath}' hash mismatch: computed=${computedHash}, recorded=${entry.sha256}`,
          500,
        );
      }
    }

    // --- Step 2: Canonicalize BEFORE into snapshot entries + temp blobs ---
    // R2-A: Budget tracking starts here. Known BEFORE hashes consume initial budget.
    tempCreated = true;
    const beforeSnapshotEntries: SnapshotEntry[] = [];
    /** Unique blob registry: hash → sizeBytes. Each hash counted once for budget. */
    const blobRegistry = new Map<string, number>();
    let budgetConsumed = 0;
    const maxBudget = input.maxEvidenceBytes;

    for (const entry of beforeEntries) {
      if (entry.kind === 'file') {
        const snapshotEntry: SnapshotEntry = {
          path: entry.relPath,
          kind: 'file',
          mode: entry.mode,
          sizeBytes: entry.sizeBytes,
          contentHash: entry.sha256,
        };
        beforeSnapshotEntries.push(snapshotEntry);

        // R2-A: known BEFORE hashes consume initial budget (each unique hash once)
        if (!blobRegistry.has(entry.sha256)) {
          const newBudget = budgetConsumed + entry.sizeBytes;
          if (newBudget > maxBudget) {
            throw new BridgeError(
              'ARTIFACT_BUDGET_EXCEEDED',
              `BEFORE evidence alone (${newBudget} bytes) exceeds maxEvidenceBytes (${maxBudget})`,
              500,
            );
          }
          budgetConsumed = newBudget;
          blobRegistry.set(entry.sha256, entry.sizeBytes);

          // R2-C: Store blob to TEMP (never directly to final)
          const content = await volumeIO.readFile(`files/${entry.relPath}`);
          await storeTempBlob(volumeIO, entry.sha256, content);
        }
      } else if (entry.kind === 'dir') {
        beforeSnapshotEntries.push({ path: entry.relPath, kind: 'dir', mode: entry.mode });
      } else if (entry.kind === 'symlink') {
        beforeSnapshotEntries.push({
          path: entry.relPath,
          kind: 'unsupported',
          mode: entry.mode,
          reason: 'B2 evidence does not preserve symlink target identity',
        });
      }
    }

    // Sort BEFORE entries by path
    beforeSnapshotEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

    const beforeManifest: SnapshotManifest = { version: 1, entries: beforeSnapshotEntries };

    // --- Step 3: Canonicalize POST into snapshot entries + temp blobs ---
    // R2-A/B: Incremental budget enforcement during POST. Each NEW unique blob
    // consumes budget immediately. Fail as soon as budget would be exceeded.
    // R2-B: No unbounded buffer accumulation — content is hashed and stored
    // immediately per-entry; the PostCaptureResult already holds them but we
    // process one-at-a-time and fail fast.
    const postSnapshotEntries: SnapshotEntry[] = [];

    for (const pce of input.postCapture.entries) {
      postSnapshotEntries.push(pce.snapshot);

      if (pce.snapshot.kind === 'file' && pce.content) {
        const fe = pce.snapshot as SnapshotFileEntry;
        // R2-A: unchanged BEFORE/POST content does not count twice;
        //        duplicate POST blobs do not count twice
        if (!blobRegistry.has(fe.contentHash)) {
          // R2-A: fail as soon as budget would be exceeded
          const newBudget = budgetConsumed + fe.sizeBytes;
          if (newBudget > maxBudget) {
            throw new BridgeError(
              'ARTIFACT_BUDGET_EXCEEDED',
              `artifact bytes (${newBudget}) would exceed maxEvidenceBytes (${maxBudget}) at POST file '${fe.path}'`,
              500,
            );
          }
          budgetConsumed = newBudget;
          blobRegistry.set(fe.contentHash, fe.sizeBytes);

          // R2-C: Store to TEMP (never directly to final)
          await storeTempBlob(volumeIO, fe.contentHash, pce.content);
        }
      }
    }

    // POST entries are already sorted by postCapture
    const postManifest: SnapshotManifest = { version: 1, entries: postSnapshotEntries };

    // --- Step 4: Validate snapshot manifests BEFORE hashing (R2-I) ---
    validateSnapshotManifest(beforeManifest);
    validateSnapshotManifest(postManifest);

    // --- Step 5: Compute canonical diff ---
    const canonicalChangeSet: CanonicalChangeSet = computeCanonicalDiff(beforeManifest, postManifest);
    const changeSetHash = computeChangeSetHash(canonicalChangeSet);

    // --- Step 6: Final budget defense-in-depth ---
    // artifactBytes = sum of unique blob sizes (each hash counted once)
    let artifactBytes = 0;
    for (const size of blobRegistry.values()) {
      artifactBytes += size;
    }
    if (artifactBytes > maxBudget) {
      throw new BridgeError(
        'ARTIFACT_BUDGET_EXCEEDED',
        `artifact bytes (${artifactBytes}) exceed maxEvidenceBytes (${maxBudget})`,
        500,
      );
    }

    // --- Step 7: Base certification ---
    const certResult: CertificationResult = await certifyBeforeAgainstBase(
      beforeManifest,
      input.git,
      input.baseCommit,
    );

    // --- Step 8: Determine completeness / applicability ---
    let contentComplete = true;
    let applicable = true;
    let reason: string | null = null;

    const hasUnsupportedBefore = beforeManifest.entries.some((e) => e.kind === 'unsupported');
    const hasUnsupportedPost = postManifest.entries.some((e) => e.kind === 'unsupported');

    if (hasUnsupportedBefore || hasUnsupportedPost) {
      contentComplete = false;
      applicable = false;
      const reasons: string[] = [];
      if (hasUnsupportedBefore) {
        const unsup = beforeManifest.entries.find((e) => e.kind === 'unsupported')!;
        reasons.push(`BEFORE has unsupported entry '${unsup.path}': ${(unsup as { reason: string }).reason}`);
      }
      if (hasUnsupportedPost) {
        const unsup = postManifest.entries.find((e) => e.kind === 'unsupported')!;
        reasons.push(`POST has unsupported entry '${unsup.path}': ${(unsup as { reason: string }).reason}`);
      }
      reason = reasons.join('; ');
    }

    // R3: gitlinks from EITHER the BEFORE snapshot OR the authoritative Git tree
    // force contentComplete=false, applicable=false.
    const hasGitlinksInBefore = beforeManifest.entries.some((e) => e.kind === 'gitlink');
    const hasGitlinksInGitTree = certResult.hasGitlinks;
    if ((hasGitlinksInBefore || hasGitlinksInGitTree) && contentComplete) {
      contentComplete = false;
      applicable = false;
      if (hasGitlinksInGitTree && certResult.gitlinkPaths.length > 0) {
        reason = `Git tree contains gitlink(s) at: ${certResult.gitlinkPaths.join(', ')}; cannot certify complete workspace content`;
      } else {
        reason = 'BEFORE contains gitlink entries that cannot be fully certified';
      }
    }

    if (!certResult.baseCertified) {
      applicable = false;
      if (reason === null) {
        reason = `base certification failed: ${certResult.reason}`;
      } else {
        reason += `; base certification failed: ${certResult.reason}`;
      }
    }

    // --- Step 9: Serialize snapshot manifests and compute identities ---
    const beforeManifestBytes = canonicalSerialize(beforeManifest);
    const postManifestBytes = canonicalSerialize(postManifest);
    const beforeIdentity = createHash('sha256').update(beforeManifestBytes).digest('hex');
    const postIdentity = createHash('sha256').update(postManifestBytes).digest('hex');

    // --- Step 10: Construct artifact manifest (R2-J invariants enforced) ---
    const artifactManifestObj: ArtifactManifest = {
      version: 1,
      jobId: input.jobId,
      projectId: input.projectId,
      principalId: input.principalId,
      backend: input.backend,
      profile: input.profile,
      baseCommit: input.baseCommit,
      baseCertified: certResult.baseCertified,
      beforeIdentity,
      postIdentity,
      changeSetHash,
      contentComplete,
      applicable,
      reason,
      opCount: canonicalChangeSet.entries.length,
      artifactBytes,
      changes: canonicalChangeSet.entries,
    };

    // Validate the manifest structure including invariants (fail closed)
    validateArtifactManifest(artifactManifestObj);

    const artifactManifestBytes = canonicalSerialize(artifactManifestObj);
    const artifactHash = createHash('sha256').update(artifactManifestBytes).digest('hex');

    // --- Step 11: Promote temp blobs to final (R2-C) ---
    // Existing final blobs are reused only after exact byte re-read + SHA-256 verification.
    // Never overwrite conflicting final content.
    for (const [hash, size] of blobRegistry) {
      const prefix = hash.slice(0, 2);
      const finalBlobPath = `${BLOBS_DIR}/${prefix}/${hash}`;
      const tempBlobPath = `${TEMP_BLOBS_DIR}/${prefix}/${hash}`;

      const finalExists = await volumeIO.fileExists(finalBlobPath);
      if (finalExists) {
        // Verify existing final blob integrity before reusing
        const existingContent = await volumeIO.readFile(finalBlobPath);
        if (existingContent.length !== size) {
          throw new BridgeError(
            'ARTIFACT_BLOB_INVALID',
            `existing final blob '${finalBlobPath}' size mismatch: actual=${existingContent.length}, expected=${size}`,
            500,
          );
        }
        const existingHash = createHash('sha256').update(existingContent).digest('hex');
        if (existingHash !== hash) {
          throw new BridgeError(
            'ARTIFACT_BLOB_INVALID',
            `existing final blob '${finalBlobPath}' hash mismatch: computed=${existingHash}, expected=${hash}`,
            500,
          );
        }
        // Existing final blob is verified — no promotion needed
      } else {
        // Promote from temp to final
        const tempContent = await volumeIO.readFile(tempBlobPath);
        // Verify temp blob before promotion
        const verifyHash = createHash('sha256').update(tempContent).digest('hex');
        if (verifyHash !== hash) {
          throw new BridgeError(
            'ARTIFACT_STORAGE_INTEGRITY_FAILED',
            `temp blob '${tempBlobPath}' hash mismatch on promotion: computed=${verifyHash}, expected=${hash}`,
            500,
          );
        }
        await volumeIO.writeFile(finalBlobPath, tempContent);
      }
    }

    // --- Step 12: Write-once final manifests (R2-E) ---
    // Check all three final paths BEFORE writing any of them
    const beforeExists = await volumeIO.fileExists(BEFORE_SNAPSHOT_FILE);
    if (beforeExists) {
      throw new BridgeError(
        'ARTIFACT_ALREADY_FINALIZED',
        `${BEFORE_SNAPSHOT_FILE} already exists — write-once violated`,
        500,
      );
    }
    const postExists = await volumeIO.fileExists(POST_SNAPSHOT_FILE);
    if (postExists) {
      throw new BridgeError(
        'ARTIFACT_ALREADY_FINALIZED',
        `${POST_SNAPSHOT_FILE} already exists — write-once violated`,
        500,
      );
    }
    // artifact-manifest checked at the top; double-check defense-in-depth
    const artifactExists = await volumeIO.fileExists(ARTIFACT_MANIFEST_FILE);
    if (artifactExists) {
      throw new BridgeError(
        'ARTIFACT_ALREADY_FINALIZED',
        `${ARTIFACT_MANIFEST_FILE} already exists — write-once violated`,
        500,
      );
    }

    // Write final manifests
    await volumeIO.writeFile(BEFORE_SNAPSHOT_FILE, beforeManifestBytes);
    await volumeIO.writeFile(POST_SNAPSHOT_FILE, postManifestBytes);
    await volumeIO.writeFile(ARTIFACT_MANIFEST_FILE, artifactManifestBytes);

    // --- Step 13: Strict final storage verification (R2-F) ---
    // Before finalized=true: reread and rehash EVERYTHING from final storage.

    // F.1-3: Reread final BEFORE snapshot manifest, validate, verify identity
    const finalBeforeBytes = await volumeIO.readFile(BEFORE_SNAPSHOT_FILE);
    const finalBeforeManifest = validateSnapshotManifest(JSON.parse(finalBeforeBytes.toString('utf8')));
    const finalBeforeHash = createHash('sha256').update(finalBeforeBytes).digest('hex');
    if (finalBeforeHash !== beforeIdentity) {
      throw new BridgeError(
        'ARTIFACT_STORAGE_INTEGRITY_FAILED',
        `final BEFORE manifest hash mismatch: read-back=${finalBeforeHash}, expected=${beforeIdentity}`,
        500,
      );
    }

    // F.4-6: Reread final POST snapshot manifest, validate, verify identity
    const finalPostBytes = await volumeIO.readFile(POST_SNAPSHOT_FILE);
    const finalPostManifest = validateSnapshotManifest(JSON.parse(finalPostBytes.toString('utf8')));
    const finalPostHash = createHash('sha256').update(finalPostBytes).digest('hex');
    if (finalPostHash !== postIdentity) {
      throw new BridgeError(
        'ARTIFACT_STORAGE_INTEGRITY_FAILED',
        `final POST manifest hash mismatch: read-back=${finalPostHash}, expected=${postIdentity}`,
        500,
      );
    }

    // F.7-11: Collect all unique regular-file hashes and verify every blob
    const allBlobHashes = new Map<string, number>(); // hash → expected sizeBytes
    for (const entry of finalBeforeManifest.entries) {
      if (entry.kind === 'file') {
        const fe = entry as SnapshotFileEntry;
        allBlobHashes.set(fe.contentHash, fe.sizeBytes);
      }
    }
    for (const entry of finalPostManifest.entries) {
      if (entry.kind === 'file') {
        const fe = entry as SnapshotFileEntry;
        allBlobHashes.set(fe.contentHash, fe.sizeBytes);
      }
    }

    for (const [expectedHash, expectedSize] of allBlobHashes) {
      const prefix = expectedHash.slice(0, 2);
      const blobPath = `${BLOBS_DIR}/${prefix}/${expectedHash}`;
      // F.8: Reread every final blob
      let blobContent: Buffer;
      try {
        blobContent = await volumeIO.readFile(blobPath);
      } catch (e) {
        throw new BridgeError(
          'ARTIFACT_STORAGE_INTEGRITY_FAILED',
          `final blob missing or unreadable: '${blobPath}': ${(e as Error).message}`,
          500,
        );
      }
      // F.9: SHA-256 exact bytes == referenced hash
      const recomputedHash = createHash('sha256').update(blobContent).digest('hex');
      if (recomputedHash !== expectedHash) {
        throw new BridgeError(
          'ARTIFACT_STORAGE_INTEGRITY_FAILED',
          `final blob '${blobPath}' hash mismatch: read-back=${recomputedHash}, expected=${expectedHash}`,
          500,
        );
      }
      // F.10: blob filename/hash must match (implicitly true if above passes)
      // F.11: exact byte length == canonical sizeBytes
      if (blobContent.length !== expectedSize) {
        throw new BridgeError(
          'ARTIFACT_STORAGE_INTEGRITY_FAILED',
          `final blob '${blobPath}' size mismatch: actual=${blobContent.length}, expected=${expectedSize}`,
          500,
        );
      }
    }

    // F.12-13: Recompute deduplicated artifactBytes from verified storage
    let verifiedArtifactBytes = 0;
    for (const size of allBlobHashes.values()) {
      verifiedArtifactBytes += size;
    }
    if (verifiedArtifactBytes !== artifactBytes) {
      throw new BridgeError(
        'ARTIFACT_STORAGE_INTEGRITY_FAILED',
        `recomputed artifactBytes (${verifiedArtifactBytes}) !== manifest artifactBytes (${artifactBytes})`,
        500,
      );
    }
    // F.14: must be <= maxEvidenceBytes
    if (verifiedArtifactBytes > maxBudget) {
      throw new BridgeError(
        'ARTIFACT_BUDGET_EXCEEDED',
        `verified artifact bytes (${verifiedArtifactBytes}) exceed maxEvidenceBytes (${maxBudget})`,
        500,
      );
    }

    // F.15-17: Reread final artifact manifest, validate, verify hash
    const finalArtifactBytes = await volumeIO.readFile(ARTIFACT_MANIFEST_FILE);
    validateArtifactManifest(JSON.parse(finalArtifactBytes.toString('utf8')));
    const finalArtifactHash = createHash('sha256').update(finalArtifactBytes).digest('hex');
    if (finalArtifactHash !== artifactHash) {
      throw new BridgeError(
        'ARTIFACT_STORAGE_INTEGRITY_FAILED',
        `final artifact manifest hash mismatch: read-back=${finalArtifactHash}, expected=${artifactHash}`,
        500,
      );
    }

    // --- Step 14: Real .b3-temp cleanup (R2-D) ---
    // On success path: cleanup MUST succeed and be verified.
    // Restricted to .b3-temp only. Fail closed if cleanup fails or temp remains.
    await cleanupTempStrict(volumeIO);

    // Only now: finalized=true
    return {
      artifactHash,
      changeSetHash,
      contentComplete,
      applicable,
      reason,
      artifactVolume: input.evidenceVolume,
      artifactBytes,
      opCount: canonicalChangeSet.entries.length,
      finalized: true,
    };
  } catch (e) {
    // Best-effort cleanup of temp data on failure (R2-D: never remove B2 evidence)
    if (tempCreated) {
      await cleanupTempBestEffort(volumeIO);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Temp blob storage helpers (R2-C)
// ---------------------------------------------------------------------------

/**
 * Store a content-addressed blob at /evidence/.b3-temp/blobs/<prefix>/<hash>.
 * Verifies content matches the expected hash. This is the ONLY write path
 * for new blobs — they are never written directly to final storage.
 */
async function storeTempBlob(
  volumeIO: EvidenceVolumeIO,
  expectedHash: string,
  content: Buffer,
): Promise<void> {
  if (!isValidSha256(expectedHash)) {
    throw new BridgeError('ARTIFACT_BLOB_INVALID', `invalid blob hash format: ${expectedHash}`, 500);
  }

  // Verify content hashes to the expected identity
  const computedHash = createHash('sha256').update(content).digest('hex');
  if (computedHash !== expectedHash) {
    throw new BridgeError(
      'ARTIFACT_BLOB_INVALID',
      `blob content does not hash to expected identity: computed=${computedHash}, expected=${expectedHash}`,
      500,
    );
  }

  const prefix = expectedHash.slice(0, 2);
  const tempBlobPath = `${TEMP_BLOBS_DIR}/${prefix}/${expectedHash}`;

  await volumeIO.writeFile(tempBlobPath, content);
}

// ---------------------------------------------------------------------------
// Temp cleanup (R2-D)
// ---------------------------------------------------------------------------

/**
 * STRICT temp cleanup for the SUCCESS finalization path.
 * Removes /evidence/.b3-temp and VERIFIES its absence. If cleanup fails or
 * .b3-temp is still present after deletion, throws — finalized=true will NOT
 * be returned. Does NOT remove B2 evidence, canonical blobs, or manifests.
 */
async function cleanupTempStrict(volumeIO: EvidenceVolumeIO): Promise<void> {
  // Step 1: Perform deletion
  await volumeIO.remove(TEMP_DIR);

  // Step 2: Verify .b3-temp no longer exists
  const stillExists = await volumeIO.fileExists(TEMP_DIR);
  if (stillExists) {
    throw new BridgeError(
      'ARTIFACT_STORAGE_INTEGRITY_FAILED',
      `.b3-temp still exists after cleanup — cannot finalize artifact`,
      500,
    );
  }
}

/**
 * BEST-EFFORT temp cleanup for FAILURE paths.
 * Attempts deletion but never throws — preserves B2/final evidence for
 * diagnosis. Does not verify absence.
 */
async function cleanupTempBestEffort(volumeIO: EvidenceVolumeIO): Promise<void> {
  try {
    await volumeIO.remove(TEMP_DIR);
  } catch {
    // Best-effort: failure is not fatal on error paths
  }
}

// ---------------------------------------------------------------------------
// Public verification utility
// ---------------------------------------------------------------------------

/**
 * Verify that every file-entry hash in a snapshot has a corresponding blob.
 * Used as an external integrity check utility.
 */
export async function verifyAllBlobsExist(
  manifest: SnapshotManifest,
  volumeIO: EvidenceVolumeIO,
): Promise<{ allPresent: boolean; missingHash?: string }> {
  for (const entry of manifest.entries) {
    if (entry.kind === 'file') {
      const fe = entry as SnapshotFileEntry;
      const prefix = fe.contentHash.slice(0, 2);
      const blobPath = `${BLOBS_DIR}/${prefix}/${fe.contentHash}`;
      const exists = await volumeIO.fileExists(blobPath);
      if (!exists) {
        return { allPresent: false, missingHash: fe.contentHash };
      }
    }
  }
  return { allPresent: true };
}
