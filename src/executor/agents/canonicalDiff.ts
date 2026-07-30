/**
 * A6-B3: Canonical BEFORE → POST change set.
 *
 * Computes a deterministic canonical change set from two validated snapshot
 * manifests (BEFORE and POST). This is the AUTHORITATIVE diff — A5
 * changeDetection.ts remains corroborating evidence only.
 *
 * Operations:
 *   ADD            — path in POST but not BEFORE
 *   DELETE         — path in BEFORE but not POST
 *   CONTENT_MODIFY — same path, same kind=file, different contentHash
 *   MODE_CHANGE    — same path, same kind, same content, different mode
 *   TYPE_CHANGE    — same path, different kind
 *   SYMLINK_CHANGE — same path, kind=symlink in both, different contentHash (target changed)
 *
 * Each path appears at most once. Canonical ordering: lexicographic by path.
 * Serialization: strict versioned canonical JSON (not TAB/LF delimited).
 *
 * change_set_hash uses explicit domain separation:
 *   SHA-256("changeset-v1:" || canonicalChangeSetBytes)
 */
import { createHash } from 'node:crypto';
import {
  canonicalSerialize,
  type SnapshotEntry,
  type SnapshotManifest,
  type CanonicalChangeEntry,
  type CanonicalChangeSet,
  type ChangeOp,
} from './canonicalJson.js';

// ---------------------------------------------------------------------------
// Domain separation prefix for change_set_hash
// ---------------------------------------------------------------------------

export const CHANGESET_HASH_PREFIX = 'changeset-v1:';

// ---------------------------------------------------------------------------
// Canonical diff computation
// ---------------------------------------------------------------------------

/**
 * Compute the canonical change set between BEFORE and POST snapshots.
 * Both inputs must be validated SnapshotManifest instances (sorted, no dupes).
 */
export function computeCanonicalDiff(
  before: SnapshotManifest,
  post: SnapshotManifest,
): CanonicalChangeSet {
  const beforeMap = new Map<string, SnapshotEntry>();
  for (const e of before.entries) {
    beforeMap.set(e.path, e);
  }

  const postMap = new Map<string, SnapshotEntry>();
  for (const e of post.entries) {
    postMap.set(e.path, e);
  }

  const entries: CanonicalChangeEntry[] = [];

  // Detect ADD, CONTENT_MODIFY, MODE_CHANGE, TYPE_CHANGE, SYMLINK_CHANGE
  for (const postEntry of post.entries) {
    const beforeEntry = beforeMap.get(postEntry.path);
    if (!beforeEntry) {
      // Path only in POST → ADD
      entries.push({ path: postEntry.path, op: 'ADD' });
      continue;
    }
    const op = classifyChange(beforeEntry, postEntry);
    if (op !== null) {
      entries.push({ path: postEntry.path, op });
    }
  }

  // Detect DELETE: in BEFORE but not POST
  for (const beforeEntry of before.entries) {
    if (!postMap.has(beforeEntry.path)) {
      entries.push({ path: beforeEntry.path, op: 'DELETE' });
    }
  }

  // Sort lexicographically by path (canonical ordering)
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  return { version: 1, entries };
}

/**
 * Classify the change operation between two entries at the same path.
 * Returns null if unchanged.
 */
function classifyChange(before: SnapshotEntry, post: SnapshotEntry): ChangeOp | null {
  // Type change: different kind
  if (before.kind !== post.kind) {
    return 'TYPE_CHANGE';
  }

  // Same kind — compare within kind
  switch (before.kind) {
    case 'file': {
      const postFile = post as typeof before;
      if (before.contentHash !== postFile.contentHash) return 'CONTENT_MODIFY';
      if (before.mode !== postFile.mode) return 'MODE_CHANGE';
      return null;
    }
    case 'symlink': {
      const postSym = post as typeof before;
      if (before.contentHash !== postSym.contentHash) return 'SYMLINK_CHANGE';
      if (before.mode !== postSym.mode) return 'MODE_CHANGE';
      return null;
    }
    case 'dir': {
      if (before.mode !== post.mode) return 'MODE_CHANGE';
      return null;
    }
    case 'gitlink': {
      const postGl = post as typeof before;
      if (before.commitOid !== postGl.commitOid) return 'CONTENT_MODIFY';
      if (before.mode !== post.mode) return 'MODE_CHANGE';
      return null;
    }
    case 'unsupported': {
      // Unsupported entries: if anything changed, it's a type change
      if (before.mode !== post.mode) return 'MODE_CHANGE';
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// change_set_hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the change_set_hash from a canonical change set.
 * Uses domain separation: SHA-256("changeset-v1:" || canonicalBytes)
 */
export function computeChangeSetHash(changeSet: CanonicalChangeSet): string {
  const canonicalBytes = canonicalSerialize(changeSet);
  const hasher = createHash('sha256');
  hasher.update(CHANGESET_HASH_PREFIX, 'ascii');
  hasher.update(canonicalBytes);
  return hasher.digest('hex');
}
