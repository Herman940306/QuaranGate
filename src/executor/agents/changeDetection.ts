/**
 * Deterministic sandbox change detection — Phase A5.
 *
 * A5 must know EXACTLY what an implementation job changed inside its disposable
 * workspace, without trusting the model's own description. Detection is a pure
 * comparison of two content manifests: a BASELINE captured right after staging
 * (the pristine committed-HEAD snapshot, before the runner writes) and a POST
 * manifest captured after the runner exits. Both manifests are produced by the
 * trusted, bounded {@link MANIFEST_SCRIPT} (see sandboxSpec.ts) running in a
 * hardened helper against the workspace volume — never by the agent.
 *
 * This module is pure (no Docker, no I/O): the manifest parsing and the diff
 * are unit-testable in isolation, and no caller-controlled data reaches Docker.
 *
 * A5 produces this evidence; it does NOT apply it. Public retrieval and the
 * apply/discard lifecycle (agent_diff/agent_apply/agent_discard) are A6's.
 */
import { createHash } from 'node:crypto';

/** One manifest entry: workspace-relative path, byte size, content sha256 hex. */
export interface ManifestEntry {
  path: string;
  size: number;
  /** sha256 hex, or `LARGE:<size>` for files above the per-file hash bound. */
  sha: string;
}

export interface WorkspaceManifest {
  ok: boolean;
  /** Number of regular files walked. */
  count: number;
  /** True if the walk hit a file-count bound (manifest is partial). */
  truncated: boolean;
  entries: ManifestEntry[];
  error?: string;
}

/** Bound on the number of changed paths enumerated in the change set. */
export const MAX_CHANGED_PATHS = 5000;

export interface ChangeSet {
  /** Paths present after the run but not in the baseline. */
  added: string[];
  /** Paths present in both with a differing content hash. */
  modified: string[];
  /** Paths present in the baseline but gone after the run. */
  deleted: string[];
  /** Sorted union of added ∪ modified ∪ deleted. */
  changedFiles: string[];
  /** Count of changed paths BEFORE any output bound is applied. */
  changedCount: number;
  /** Sum of post-run sizes of added + modified files (bounded evidence size). */
  changedBytes: number;
  /** Number of regular files in the post-run workspace. */
  postFileCount: number;
  /** True if either input manifest was truncated or the change list was bounded. */
  truncated: boolean;
  /**
   * sha256 over the canonical, sorted change description
   * (`A <path>` / `M <path>` / `D <path>` lines). Stable identity of the change
   * set for A6 to key on; NOT a unified-diff hash.
   */
  diffHash: string;
}

/**
 * Parse the single JSON manifest line emitted by MANIFEST_SCRIPT from container
 * stdout. Tolerates surrounding log noise; returns null when no valid manifest
 * line is present.
 */
export function parseManifest(stdout: string): WorkspaceManifest | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.__manifest !== true) continue;
      const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
      const entries: ManifestEntry[] = [];
      for (const e of rawEntries as unknown[]) {
        if (!Array.isArray(e) || e.length < 3) continue;
        const p = e[0];
        const size = e[1];
        const sha = e[2];
        if (typeof p === 'string' && typeof size === 'number' && typeof sha === 'string') {
          entries.push({ path: p, size, sha });
        }
      }
      return {
        ok: obj.ok === true,
        count: typeof obj.count === 'number' ? obj.count : entries.length,
        truncated: obj.truncated === true,
        entries,
        error: typeof obj.error === 'string' ? obj.error : undefined,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function toMap(m: WorkspaceManifest): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  for (const e of m.entries) map.set(e.path, e);
  return map;
}

/**
 * Deterministically diff a baseline manifest against a post-run manifest.
 * Unchanged files are ignored. The result is bounded (MAX_CHANGED_PATHS) and
 * carries a stable diffHash for downstream (A6) keying.
 */
export function diffManifests(baseline: WorkspaceManifest, post: WorkspaceManifest): ChangeSet {
  const base = toMap(baseline);
  const now = toMap(post);

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let changedBytes = 0;

  for (const [path, entry] of now) {
    const prev = base.get(path);
    if (!prev) {
      added.push(path);
      changedBytes += entry.size;
    } else if (prev.sha !== entry.sha) {
      modified.push(path);
      changedBytes += entry.size;
    }
  }
  for (const path of base.keys()) {
    if (!now.has(path)) deleted.push(path);
  }

  added.sort();
  modified.sort();
  deleted.sort();

  const changedCount = added.length + modified.length + deleted.length;

  // Canonical change description (sorted, prefixed) → stable identity hash.
  const canonicalLines = [
    ...added.map((p) => `A ${p}`),
    ...modified.map((p) => `M ${p}`),
    ...deleted.map((p) => `D ${p}`),
  ].sort();
  const diffHash = createHash('sha256').update(canonicalLines.join('\n'), 'utf8').digest('hex');

  const changedFilesFull = [...added, ...modified, ...deleted].sort();
  const bounded = changedFilesFull.slice(0, MAX_CHANGED_PATHS);
  const truncated = baseline.truncated || post.truncated
    || changedFilesFull.length > MAX_CHANGED_PATHS;

  return {
    added: added.slice(0, MAX_CHANGED_PATHS),
    modified: modified.slice(0, MAX_CHANGED_PATHS),
    deleted: deleted.slice(0, MAX_CHANGED_PATHS),
    changedFiles: bounded,
    changedCount,
    changedBytes,
    postFileCount: post.count,
    truncated,
    diffHash,
  };
}
