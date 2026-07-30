/**
 * A6-B3 R3: Git object base certification.
 *
 * Statically certifies that the canonical BEFORE snapshot corresponds to the
 * Git object state at job.baseCommit. Uses Git object/tree primitives ONLY —
 * never the live working tree.
 *
 * TRUSTED DOCKER HELPER:
 *   Git commands run inside a short-lived Docker helper (see gitHelper.ts).
 *   The Executor NEVER executes Git directly against hostPath.
 *
 * BINARY SAFETY:
 *   ls-tree -z output is raw NUL-delimited bytes retrieved via Docker archive.
 *   cat-file blob output is raw binary bytes retrieved via Docker archive.
 *   No UTF-8 normalization of blob content.
 *
 * INFRASTRUCTURE vs CERTIFICATION:
 *   Infrastructure failures (helper creation, timeout, archive retrieval,
 *   malformed Git output) THROW BridgeError('BASE_CERTIFICATION_FAILED').
 *   They must NOT become baseCertified=false — they fail artifact construction.
 *
 *   Deterministic certification outcomes (content mismatch, mode mismatch,
 *   missing path, gitlink presence) produce baseCertified=false with a stable
 *   reason string (no container IDs, timestamps, or stderr).
 *
 * GIT MODE MAPPING (exact):
 *   100644 blob   → canonical mode 0644
 *   100755 blob   → canonical mode 0755
 *   120000 blob   → symlink (blob content = target bytes)
 *   160000 commit → gitlink/submodule
 *   040000 tree   → structural tree record
 *
 * GITLINK POLICY:
 *   160000 detected in the authoritative Git tree → contentComplete=false,
 *   applicable=false. No submodule fetch/init occurs. This applies even if
 *   the BEFORE snapshot does not contain a gitlink entry for that path.
 */
import { createHash } from 'node:crypto';
import { BridgeError } from '../../shared/errors.js';
import type { SnapshotManifest, SnapshotFileEntry, SnapshotSymlinkEntry } from './canonicalJson.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitTreeEntry {
  mode: string;  // '100644', '100755', '120000', '160000', '040000'
  type: string;  // 'blob', 'commit', 'tree'
  oid: string;   // 40-char hex SHA-1
  path: string;  // full path relative to repo root
}

export interface CertificationResult {
  baseCertified: boolean;
  /** Non-null deterministic reason when baseCertified is false. */
  reason: string | null;
  /** True if the Git tree contains any gitlink (160000) entries. */
  hasGitlinks: boolean;
  /** Paths of gitlink entries found in the Git tree. */
  gitlinkPaths: string[];
}

/**
 * Interface for Git object operations. Abstracted for testability — the real
 * implementation uses Docker helpers (gitHelper.ts), while tests inject
 * deterministic stubs.
 */
export interface GitObjectReader {
  /**
   * List all entries in a commit tree recursively.
   * Equivalent to: git ls-tree -r -t -z --full-tree <commit>
   * MUST throw BridgeError on infrastructure failure (never silently skip).
   */
  listTree(commit: string): Promise<GitTreeEntry[]>;

  /**
   * Read the raw bytes of a blob object.
   * Equivalent to: git cat-file blob <oid>
   * MUST return exact binary bytes (no UTF-8 normalization).
   * MUST throw BridgeError on infrastructure failure.
   */
  catBlob(oid: string): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

/** Valid Git OID: exactly 40 lowercase hex chars. */
const OID_PATTERN = /^[0-9a-f]{40}$/;

/** Recognized Git modes in ls-tree output. */
const VALID_GIT_MODES = new Set(['100644', '100755', '120000', '160000', '040000']);

/** Recognized Git object types per mode. */
const MODE_TYPE_MAP: Record<string, string> = {
  '100644': 'blob',
  '100755': 'blob',
  '120000': 'blob',
  '160000': 'commit',
  '040000': 'tree',
};

// ---------------------------------------------------------------------------
// Strict ls-tree parser
// ---------------------------------------------------------------------------

/**
 * Parse the NUL-delimited output of `git ls-tree -r -t -z --full-tree`.
 *
 * Format per record: "<mode> <type> <oid>\t<path>\0"
 *
 * FAIL-CLOSED behavior:
 *   - Malformed record → throws BridgeError
 *   - Invalid OID → throws BridgeError
 *   - Unrecognized mode → throws BridgeError
 *   - Mode/type mismatch → throws BridgeError
 *   - Duplicate paths → throws BridgeError
 *   - Truncated trailing record (no final NUL) → throws BridgeError
 *   - Empty path → throws BridgeError
 */
export function parseGitLsTree(output: Buffer): GitTreeEntry[] {
  // Empty output = empty tree (valid for an empty commit)
  if (output.length === 0) return [];

  const entries: GitTreeEntry[] = [];
  const seenPaths = new Set<string>();
  let offset = 0;

  while (offset < output.length) {
    // Find the NUL delimiter for this record
    const nulIdx = output.indexOf(0, offset);
    if (nulIdx === -1) {
      // Trailing data without a final NUL → truncated/malformed
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        'malformed ls-tree output: trailing record without NUL terminator',
        500,
      );
    }

    // Extract the raw record bytes (between offset and nulIdx)
    const recordBytes = output.subarray(offset, nulIdx);
    offset = nulIdx + 1;

    // Find the TAB that separates metadata from path
    const tabIdx = recordBytes.indexOf(0x09); // ASCII TAB
    if (tabIdx === -1) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        'malformed ls-tree record: no TAB separator between metadata and path',
        500,
      );
    }

    // Metadata: "<mode> <type> <oid>" — always ASCII-safe
    const meta = recordBytes.subarray(0, tabIdx).toString('ascii');
    // Path: raw bytes after the TAB — may contain any bytes except NUL
    // We decode as utf8 which preserves the exact byte semantics for valid paths
    const path = recordBytes.subarray(tabIdx + 1).toString('utf8');

    if (path.length === 0) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        'malformed ls-tree record: empty path',
        500,
      );
    }

    // Parse metadata: exactly "mode type oid"
    const spaceIdx1 = meta.indexOf(' ');
    if (spaceIdx1 === -1) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `malformed ls-tree record metadata: no space found in '${meta.slice(0, 100)}'`,
        500,
      );
    }
    const mode = meta.slice(0, spaceIdx1);
    const rest = meta.slice(spaceIdx1 + 1);
    const spaceIdx2 = rest.indexOf(' ');
    if (spaceIdx2 === -1) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `malformed ls-tree record metadata: missing second space in '${meta.slice(0, 100)}'`,
        500,
      );
    }
    const type = rest.slice(0, spaceIdx2);
    const oid = rest.slice(spaceIdx2 + 1);

    // Validate mode
    if (!VALID_GIT_MODES.has(mode)) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `unrecognized Git mode '${mode}' for path '${path.slice(0, 200)}'`,
        500,
      );
    }

    // Validate mode/type consistency
    const expectedType = MODE_TYPE_MAP[mode];
    if (type !== expectedType) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `mode/type mismatch for '${path.slice(0, 200)}': mode=${mode} expects type=${expectedType}, got type=${type}`,
        500,
      );
    }

    // Validate OID format
    if (!OID_PATTERN.test(oid)) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `invalid OID '${oid.slice(0, 50)}' for path '${path.slice(0, 200)}'`,
        500,
      );
    }

    // Duplicate path detection
    if (seenPaths.has(path)) {
      throw new BridgeError(
        'BASE_CERTIFICATION_FAILED',
        `duplicate path in ls-tree output: '${path.slice(0, 200)}'`,
        500,
      );
    }
    seenPaths.add(path);

    entries.push({ mode, type, oid, path });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Mode mapping
// ---------------------------------------------------------------------------

/**
 * Map Git mode to exact canonical normalized mode.
 * Returns the canonical mode integer, or null for non-file modes.
 *
 * EXACT semantics (R3 §14):
 *   100644 → 0644 (exact, not "any non-executable")
 *   100755 → 0755 (exact, not "any executable")
 *   120000 → symlink (handled separately)
 *   160000 → gitlink (handled separately)
 *   040000 → tree (structural, no canonical file mode)
 */
function gitModeToCanonicalFileMode(gitMode: string): number | null {
  switch (gitMode) {
    case '100644': return 0o644;
    case '100755': return 0o755;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Certification logic
// ---------------------------------------------------------------------------

/**
 * Certify a BEFORE snapshot against Git objects at baseCommit.
 *
 * INFRASTRUCTURE FAILURES (Docker helper, timeout, malformed output) THROW.
 * They must fail artifact construction — never produce baseCertified=false.
 *
 * DETERMINISTIC OUTCOMES (content/mode mismatch, missing path, gitlink):
 * Produce baseCertified=false with a stable reason string.
 *
 * For each BEFORE entry:
 * - Regular file (100644/100755): exact mode match + exact content hash match
 * - Symlink (120000): exact target identity match
 * - Gitlink: cannot certify → baseCertified=false
 * - Directory: structural, not individually certified
 * - Unsupported: fails certification closed
 *
 * Additionally: gitlinks in the Git tree (even if not in BEFORE) are reported
 * via hasGitlinks/gitlinkPaths so artifact construction can force
 * contentComplete=false, applicable=false.
 */
export async function certifyBeforeAgainstBase(
  beforeManifest: SnapshotManifest,
  git: GitObjectReader,
  baseCommit: string,
): Promise<CertificationResult> {
  // Infrastructure: listTree throws on failure (fail construction)
  const gitEntries = await git.listTree(baseCommit);

  // Build map of Git entries by path (excluding tree records for content lookup)
  const gitMap = new Map<string, GitTreeEntry>();
  const gitlinkPaths: string[] = [];

  for (const ge of gitEntries) {
    if (ge.type === 'tree') continue; // structural — skip for map
    gitMap.set(ge.path, ge);
    if (ge.mode === '160000') {
      gitlinkPaths.push(ge.path);
    }
  }

  const hasGitlinks = gitlinkPaths.length > 0;

  // If gitlinks exist in the Git tree, certification cannot fully certify
  // complete workspace content. Report immediately.
  if (hasGitlinks) {
    return {
      baseCertified: false,
      reason: `Git tree contains gitlink(s) at: ${gitlinkPaths.join(', ')}; cannot certify complete workspace content without submodule fetch`,
      hasGitlinks: true,
      gitlinkPaths,
    };
  }

  // Check each non-directory BEFORE entry against Git
  for (const entry of beforeManifest.entries) {
    if (entry.kind === 'dir') continue; // directories are structural

    const gitEntry = gitMap.get(entry.path);

    if (entry.kind === 'file') {
      if (!gitEntry) {
        return {
          baseCertified: false,
          reason: `BEFORE file '${entry.path}' not found in Git tree at ${baseCommit}`,
          hasGitlinks: false,
          gitlinkPaths: [],
        };
      }
      if (gitEntry.type !== 'blob') {
        return {
          baseCertified: false,
          reason: `BEFORE file '${entry.path}' is type '${gitEntry.type}' in Git (expected blob)`,
          hasGitlinks: false,
          gitlinkPaths: [],
        };
      }

      // EXACT mode match (R3 §14): 100644↔0644, 100755↔0755
      const expectedCanonicalMode = gitModeToCanonicalFileMode(gitEntry.mode);
      if (expectedCanonicalMode === null) {
        return {
          baseCertified: false,
          reason: `BEFORE file '${entry.path}' has non-regular Git mode '${gitEntry.mode}'`,
          hasGitlinks: false,
          gitlinkPaths: [],
        };
      }
      const fileEntry = entry as SnapshotFileEntry;
      if (fileEntry.mode !== expectedCanonicalMode) {
        return {
          baseCertified: false,
          reason: `BEFORE file '${entry.path}' mode mismatch: git=${gitEntry.mode} (canonical ${expectedCanonicalMode.toString(8)}), snapshot=${fileEntry.mode.toString(8)}`,
          hasGitlinks: false,
          gitlinkPaths: [],
        };
      }

      // Verify content hash by reading the blob (infrastructure: throws on failure)
      const blobContent = await git.catBlob(gitEntry.oid);
      const computedHash = createHash('sha256').update(blobContent).digest('hex');
      if (computedHash !== fileEntry.contentHash) {
        return {
          baseCertified: false,
          reason: `BEFORE file '${entry.path}' content mismatch: git blob SHA-256=${computedHash}, snapshot=${fileEntry.contentHash}`,
          hasGitlinks: false,
          gitlinkPaths: [],
        };
      }
    } else if (entry.kind === 'symlink') {
      if (!gitEntry) {
        return {
          baseCertified: false,
          reason: `BEFORE symlink '${entry.path}' not found in Git tree at ${baseCommit}`,
          hasGitlinks: false,
          gitlinkPaths: [],
        };
      }
      if (gitEntry.mode !== '120000') {
        return {
          baseCertified: false,
          reason: `BEFORE symlink '${entry.path}' is mode '${gitEntry.mode}' in Git (expected 120000)`,
          hasGitlinks: false,
          gitlinkPaths: [],
        };
      }
      // Git blob content for a symlink IS the target bytes — exact binary content
      const blobContent = await git.catBlob(gitEntry.oid);
      const symlinkEntry = entry as SnapshotSymlinkEntry;
      // Compare target identity via hash of raw blob bytes
      const gitTargetHash = createHash('sha256').update(blobContent).digest('hex');
      if (gitTargetHash !== symlinkEntry.contentHash) {
        return {
          baseCertified: false,
          reason: `BEFORE symlink '${entry.path}' target mismatch: git target hash=${gitTargetHash}, snapshot=${symlinkEntry.contentHash}`,
          hasGitlinks: false,
          gitlinkPaths: [],
        };
      }
    } else if (entry.kind === 'gitlink') {
      // Gitlinks cannot be fully certified without network access
      return {
        baseCertified: false,
        reason: `BEFORE gitlink '${entry.path}' cannot be fully certified without submodule fetch`,
        hasGitlinks: true,
        gitlinkPaths: [entry.path],
      };
    } else if (entry.kind === 'unsupported') {
      return {
        baseCertified: false,
        reason: `BEFORE has unsupported entry '${entry.path}': cannot certify`,
        hasGitlinks: false,
        gitlinkPaths: [],
      };
    }
  }

  // Check for files in Git that are NOT in BEFORE (missing evidence)
  // Exclude gitlinks (already handled above) and tree records
  for (const [path, gitEntry] of gitMap) {
    if (gitEntry.mode === '160000') continue; // already reported
    if (gitEntry.type === 'tree') continue; // structural
    const hasEntry = beforeManifest.entries.some((e) => e.path === path);
    if (!hasEntry) {
      return {
        baseCertified: false,
        reason: `Git tree has '${path}' (mode=${gitEntry.mode}) but BEFORE snapshot does not contain it`,
        hasGitlinks: false,
        gitlinkPaths: [],
      };
    }
  }

  return { baseCertified: true, reason: null, hasGitlinks: false, gitlinkPaths: [] };
}
