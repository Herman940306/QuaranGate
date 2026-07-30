/**
 * A6-B3: Strict canonical JSON serializer/validator.
 *
 * Produces deterministic, compact UTF-8 JSON bytes suitable for hashing.
 * All artifact manifests, snapshot manifests, and change-set documents are
 * serialized through this module so their SHA-256 identity is reproducible.
 *
 * Rules:
 *   - Deterministic key order at every object level (sorted lexicographically)
 *   - Compact: no whitespace between tokens
 *   - No trailing newline
 *   - UTF-8, no BOM
 *   - Fails closed on: undefined, NaN, Infinity, negative zero (where integer
 *     semantics matter), unknown keys, missing required keys, unsorted entries,
 *     duplicate paths, invalid hashes, invalid paths
 *   - Never silently drops unknown fields from hashed data
 *
 * This module uses ONLY existing dependencies (Node built-ins).
 */
import { BridgeError } from '../../shared/errors.js';

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Recursively serialize a value to canonical JSON bytes. Validates that the
 * value contains no undefined, NaN, Infinity, or unsupported types. Object
 * keys are sorted lexicographically at every level.
 *
 * Returns a UTF-8 Buffer (no BOM, no trailing newline).
 */
export function canonicalSerialize(value: unknown): Buffer {
  const json = canonicalStringify(value);
  return Buffer.from(json, 'utf8');
}

/**
 * Produce a canonical JSON string from a value. Deterministic key order,
 * compact, fails closed on unsafe values.
 */
export function canonicalStringify(value: unknown): string {
  return serializeValue(value, []);
}

function serializeValue(value: unknown, path: string[]): string {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new BridgeError(
      'CANONICAL_VALIDATION_FAILED',
      `undefined value at path ${pathStr(path)}`,
      500,
    );
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (Number.isNaN(value)) {
        throw new BridgeError('CANONICAL_VALIDATION_FAILED', `NaN at path ${pathStr(path)}`, 500);
      }
      if (!Number.isFinite(value)) {
        throw new BridgeError('CANONICAL_VALIDATION_FAILED', `Infinity at path ${pathStr(path)}`, 500);
      }
      // JSON.stringify handles -0 → "0", which is correct for canonical form
      return JSON.stringify(value);

    case 'string':
      return JSON.stringify(value);

    case 'object':
      if (Array.isArray(value)) {
        const items = value.map((item, i) => serializeValue(item, [...path, `[${i}]`]));
        return `[${items.join(',')}]`;
      }
      // Plain object
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const entries: string[] = [];
      for (const key of keys) {
        const v = obj[key];
        if (v === undefined) {
          throw new BridgeError(
            'CANONICAL_VALIDATION_FAILED',
            `undefined value at path ${pathStr([...path, key])}`,
            500,
          );
        }
        entries.push(`${JSON.stringify(key)}:${serializeValue(v, [...path, key])}`);
      }
      return `{${entries.join(',')}}`;

    default:
      throw new BridgeError(
        'CANONICAL_VALIDATION_FAILED',
        `unsupported type '${typeof value}' at path ${pathStr(path)}`,
        500,
      );
  }
}

function pathStr(path: string[]): string {
  return path.length === 0 ? '$' : `$.${path.join('.')}`;
}

// ---------------------------------------------------------------------------
// Schema validation helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex string pattern (64 lowercase hex chars). */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isValidSha256(s: string): boolean {
  return SHA256_PATTERN.test(s);
}

/**
 * Validate that a path is a safe workspace-relative path:
 * - No empty string
 * - No leading/trailing slash
 * - No backslash
 * - No '..' segments
 * - No NUL bytes
 * - No leading './'
 */
export function isValidCanonicalPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.includes('\0')) return false;
  if (p.includes('\\')) return false;
  if (p.startsWith('/') || p.endsWith('/')) return false;
  if (p.startsWith('./')) return false;
  const parts = p.split('/');
  for (const part of parts) {
    if (part === '..') return false;
    if (part === '') return false; // double slash
  }
  return true;
}

// ---------------------------------------------------------------------------
// Snapshot manifest schema validation
// ---------------------------------------------------------------------------

export const SNAPSHOT_ENTRY_KINDS = ['file', 'dir', 'symlink', 'gitlink', 'unsupported'] as const;
export type SnapshotEntryKind = (typeof SNAPSHOT_ENTRY_KINDS)[number];

export interface SnapshotFileEntry {
  path: string;
  kind: 'file';
  mode: number;
  sizeBytes: number;
  contentHash: string;
}

export interface SnapshotDirEntry {
  path: string;
  kind: 'dir';
  mode: number;
}

export interface SnapshotSymlinkEntry {
  path: string;
  kind: 'symlink';
  mode: number;
  contentHash: string;
  target: string;
}

export interface SnapshotGitlinkEntry {
  path: string;
  kind: 'gitlink';
  mode: number;
  commitOid: string;
}

export interface SnapshotUnsupportedEntry {
  path: string;
  kind: 'unsupported';
  mode: number;
  reason: string;
}

export type SnapshotEntry =
  | SnapshotFileEntry
  | SnapshotDirEntry
  | SnapshotSymlinkEntry
  | SnapshotGitlinkEntry
  | SnapshotUnsupportedEntry;

export interface SnapshotManifest {
  version: 1;
  entries: SnapshotEntry[];
}

const SNAPSHOT_FILE_KEYS = ['contentHash', 'kind', 'mode', 'path', 'sizeBytes'];
const SNAPSHOT_DIR_KEYS = ['kind', 'mode', 'path'];
const SNAPSHOT_SYMLINK_KEYS = ['contentHash', 'kind', 'mode', 'path', 'target'];
const SNAPSHOT_GITLINK_KEYS = ['commitOid', 'kind', 'mode', 'path'];
const SNAPSHOT_UNSUPPORTED_KEYS = ['kind', 'mode', 'path', 'reason'];

function expectedKeysForKind(kind: SnapshotEntryKind): string[] {
  switch (kind) {
    case 'file': return SNAPSHOT_FILE_KEYS;
    case 'dir': return SNAPSHOT_DIR_KEYS;
    case 'symlink': return SNAPSHOT_SYMLINK_KEYS;
    case 'gitlink': return SNAPSHOT_GITLINK_KEYS;
    case 'unsupported': return SNAPSHOT_UNSUPPORTED_KEYS;
  }
}

/**
 * Validate a snapshot manifest structure. Fails closed on any schema violation.
 */
export function validateSnapshotManifest(manifest: unknown): SnapshotManifest {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'snapshot manifest must be an object', 500);
  }
  const obj = manifest as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expected = ['entries', 'version'];
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot manifest has unexpected keys: ${JSON.stringify(keys)}`, 500);
  }
  if (obj.version !== 1) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot manifest version must be 1, got ${JSON.stringify(obj.version)}`, 500);
  }
  if (!Array.isArray(obj.entries)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'snapshot manifest entries must be an array', 500);
  }

  const entries: SnapshotEntry[] = [];
  const seenPaths = new Set<string>();
  let prevPath = '';

  for (let i = 0; i < obj.entries.length; i++) {
    const entry = validateSnapshotEntry(obj.entries[i], i);
    if (entry.path <= prevPath && i > 0) {
      throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entries not sorted: '${entry.path}' <= '${prevPath}' at index ${i}`, 500);
    }
    if (seenPaths.has(entry.path)) {
      throw new BridgeError('CANONICAL_VALIDATION_FAILED', `duplicate path in snapshot: '${entry.path}' at index ${i}`, 500);
    }
    seenPaths.add(entry.path);
    prevPath = entry.path;
    entries.push(entry);
  }

  return { version: 1, entries };
}

function validateSnapshotEntry(raw: unknown, index: number): SnapshotEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] must be an object`, 500);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || !(SNAPSHOT_ENTRY_KINDS as readonly string[]).includes(obj.kind)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid kind: ${JSON.stringify(obj.kind)}`, 500);
  }
  const kind = obj.kind as SnapshotEntryKind;

  // Strict key validation
  const actualKeys = Object.keys(obj).sort();
  const expectedKeys = expectedKeysForKind(kind);
  if (actualKeys.length !== expectedKeys.length || !actualKeys.every((k, i) => k === expectedKeys[i])) {
    throw new BridgeError(
      'CANONICAL_VALIDATION_FAILED',
      `snapshot entry[${index}] (kind=${kind}) has unexpected keys: ${JSON.stringify(actualKeys)}, expected ${JSON.stringify(expectedKeys)}`,
      500,
    );
  }

  // Common validations
  if (typeof obj.path !== 'string' || !isValidCanonicalPath(obj.path)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid path: ${JSON.stringify(obj.path)}`, 500);
  }
  if (typeof obj.mode !== 'number' || !Number.isInteger(obj.mode) || obj.mode < 0 || Object.is(obj.mode, -0)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid mode: ${JSON.stringify(obj.mode)}`, 500);
  }

  switch (kind) {
    case 'file': {
      if (typeof obj.sizeBytes !== 'number' || !Number.isInteger(obj.sizeBytes) || obj.sizeBytes < 0 || Object.is(obj.sizeBytes, -0)) {
        throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid sizeBytes`, 500);
      }
      if (typeof obj.contentHash !== 'string' || !isValidSha256(obj.contentHash)) {
        throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid contentHash`, 500);
      }
      return { path: obj.path as string, kind: 'file', mode: obj.mode as number, sizeBytes: obj.sizeBytes as number, contentHash: obj.contentHash as string };
    }
    case 'dir':
      return { path: obj.path as string, kind: 'dir', mode: obj.mode as number };
    case 'symlink': {
      if (typeof obj.contentHash !== 'string' || !isValidSha256(obj.contentHash)) {
        throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid contentHash for symlink`, 500);
      }
      if (typeof obj.target !== 'string') {
        throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid target for symlink`, 500);
      }
      return { path: obj.path as string, kind: 'symlink', mode: obj.mode as number, contentHash: obj.contentHash as string, target: obj.target as string };
    }
    case 'gitlink': {
      if (typeof obj.commitOid !== 'string' || !/^[0-9a-f]{40}$/.test(obj.commitOid)) {
        throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid commitOid for gitlink`, 500);
      }
      return { path: obj.path as string, kind: 'gitlink', mode: obj.mode as number, commitOid: obj.commitOid as string };
    }
    case 'unsupported': {
      if (typeof obj.reason !== 'string' || obj.reason.length === 0) {
        throw new BridgeError('CANONICAL_VALIDATION_FAILED', `snapshot entry[${index}] has invalid reason for unsupported`, 500);
      }
      return { path: obj.path as string, kind: 'unsupported', mode: obj.mode as number, reason: obj.reason as string };
    }
  }
}

// ---------------------------------------------------------------------------
// Change set schema
// ---------------------------------------------------------------------------

export const CHANGE_OPS = ['ADD', 'CONTENT_MODIFY', 'DELETE', 'MODE_CHANGE', 'SYMLINK_CHANGE', 'TYPE_CHANGE'] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

export interface CanonicalChangeEntry {
  path: string;
  op: ChangeOp;
}

export interface CanonicalChangeSet {
  version: 1;
  entries: CanonicalChangeEntry[];
}

const CHANGE_ENTRY_KEYS = ['op', 'path'];

/**
 * Validate a canonical change set structure. Fails closed on any violation.
 */
export function validateChangeSet(cs: unknown): CanonicalChangeSet {
  if (typeof cs !== 'object' || cs === null || Array.isArray(cs)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'change set must be an object', 500);
  }
  const obj = cs as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length !== 2 || keys[0] !== 'entries' || keys[1] !== 'version') {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `change set has unexpected keys: ${JSON.stringify(keys)}`, 500);
  }
  if (obj.version !== 1) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `change set version must be 1, got ${JSON.stringify(obj.version)}`, 500);
  }
  if (!Array.isArray(obj.entries)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'change set entries must be an array', 500);
  }

  const entries: CanonicalChangeEntry[] = [];
  const seenPaths = new Set<string>();
  let prevPath = '';

  for (let i = 0; i < obj.entries.length; i++) {
    const raw = obj.entries[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new BridgeError('CANONICAL_VALIDATION_FAILED', `change entry[${i}] must be an object`, 500);
    }
    const eObj = raw as Record<string, unknown>;
    const eKeys = Object.keys(eObj).sort();
    if (eKeys.length !== CHANGE_ENTRY_KEYS.length || !eKeys.every((k, j) => k === CHANGE_ENTRY_KEYS[j])) {
      throw new BridgeError('CANONICAL_VALIDATION_FAILED', `change entry[${i}] has unexpected keys: ${JSON.stringify(eKeys)}`, 500);
    }
    if (typeof eObj.path !== 'string' || !isValidCanonicalPath(eObj.path)) {
      throw new BridgeError('CANONICAL_VALIDATION_FAILED', `change entry[${i}] has invalid path`, 500);
    }
    if (typeof eObj.op !== 'string' || !(CHANGE_OPS as readonly string[]).includes(eObj.op)) {
      throw new BridgeError('CANONICAL_VALIDATION_FAILED', `change entry[${i}] has invalid op: ${JSON.stringify(eObj.op)}`, 500);
    }
    const path = eObj.path as string;
    if (path <= prevPath && i > 0) {
      throw new BridgeError('CANONICAL_VALIDATION_FAILED', `change entries not sorted: '${path}' <= '${prevPath}' at index ${i}`, 500);
    }
    if (seenPaths.has(path)) {
      throw new BridgeError('CANONICAL_VALIDATION_FAILED', `duplicate path in change set: '${path}' at index ${i}`, 500);
    }
    seenPaths.add(path);
    prevPath = path;
    entries.push({ path, op: eObj.op as ChangeOp });
  }

  return { version: 1, entries };
}

// ---------------------------------------------------------------------------
// Artifact manifest schema
// ---------------------------------------------------------------------------

export interface ArtifactManifest {
  version: 1;
  jobId: string;
  projectId: string;
  principalId: string;
  backend: string;
  profile: string;
  baseCommit: string;
  baseCertified: boolean;
  beforeIdentity: string;
  postIdentity: string;
  changeSetHash: string;
  contentComplete: boolean;
  applicable: boolean;
  reason: string | null;
  opCount: number;
  artifactBytes: number;
  changes: CanonicalChangeEntry[];
}

const ARTIFACT_MANIFEST_KEYS = [
  'applicable', 'artifactBytes', 'backend', 'baseCertified', 'baseCommit',
  'beforeIdentity', 'changeSetHash', 'changes', 'contentComplete', 'jobId',
  'opCount', 'postIdentity', 'principalId', 'profile', 'projectId', 'reason', 'version',
];

/**
 * Validate an artifact manifest structure. Fails closed on unknown/missing keys
 * or invalid field values.
 */
export function validateArtifactManifest(manifest: unknown): ArtifactManifest {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest must be an object', 500);
  }
  const obj = manifest as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length !== ARTIFACT_MANIFEST_KEYS.length || !keys.every((k, i) => k === ARTIFACT_MANIFEST_KEYS[i])) {
    throw new BridgeError(
      'CANONICAL_VALIDATION_FAILED',
      `artifact manifest has unexpected keys: ${JSON.stringify(keys)}, expected ${JSON.stringify(ARTIFACT_MANIFEST_KEYS)}`,
      500,
    );
  }

  if (obj.version !== 1) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `artifact manifest version must be 1`, 500);
  }
  if (typeof obj.jobId !== 'string' || obj.jobId.length === 0) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest jobId invalid', 500);
  }
  if (typeof obj.projectId !== 'string' || obj.projectId.length === 0) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest projectId invalid', 500);
  }
  if (typeof obj.principalId !== 'string' || obj.principalId.length === 0) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest principalId invalid', 500);
  }
  if (typeof obj.backend !== 'string' || obj.backend.length === 0) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest backend invalid', 500);
  }
  if (typeof obj.profile !== 'string' || obj.profile.length === 0) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest profile invalid', 500);
  }
  if (typeof obj.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(obj.baseCommit)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest baseCommit invalid', 500);
  }
  if (typeof obj.baseCertified !== 'boolean') {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest baseCertified must be boolean', 500);
  }
  if (typeof obj.beforeIdentity !== 'string' || !isValidSha256(obj.beforeIdentity)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest beforeIdentity invalid', 500);
  }
  if (typeof obj.postIdentity !== 'string' || !isValidSha256(obj.postIdentity)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest postIdentity invalid', 500);
  }
  if (typeof obj.changeSetHash !== 'string' || !isValidSha256(obj.changeSetHash)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest changeSetHash invalid', 500);
  }
  if (typeof obj.contentComplete !== 'boolean') {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest contentComplete must be boolean', 500);
  }
  if (typeof obj.applicable !== 'boolean') {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest applicable must be boolean', 500);
  }
  if (obj.reason !== null && typeof obj.reason !== 'string') {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest reason must be string or null', 500);
  }
  if (typeof obj.opCount !== 'number' || !Number.isInteger(obj.opCount) || obj.opCount < 0 || Object.is(obj.opCount, -0)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest opCount invalid', 500);
  }
  if (typeof obj.artifactBytes !== 'number' || !Number.isInteger(obj.artifactBytes) || obj.artifactBytes < 0 || Object.is(obj.artifactBytes, -0)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest artifactBytes invalid', 500);
  }
  if (!Array.isArray(obj.changes)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', 'artifact manifest changes must be an array', 500);
  }

  // Validate changes inline (same shape as CanonicalChangeSet.entries)
  const csObj = { version: 1, entries: obj.changes };
  const validated = validateChangeSet(csObj);

  // Invariant: opCount === changes.length
  if (obj.opCount !== validated.entries.length) {
    throw new BridgeError(
      'CANONICAL_VALIDATION_FAILED',
      `artifact manifest opCount (${obj.opCount}) !== changes.length (${validated.entries.length})`,
      500,
    );
  }

  // Invariant: contentComplete=false → applicable=false
  if ((obj.contentComplete as boolean) === false && (obj.applicable as boolean) === true) {
    throw new BridgeError(
      'CANONICAL_VALIDATION_FAILED',
      'artifact manifest contentComplete=false requires applicable=false',
      500,
    );
  }

  // Invariant: baseCertified=false → applicable=false
  if ((obj.baseCertified as boolean) === false && (obj.applicable as boolean) === true) {
    throw new BridgeError(
      'CANONICAL_VALIDATION_FAILED',
      'artifact manifest baseCertified=false requires applicable=false',
      500,
    );
  }

  // Invariant: applicable=false → reason is deterministic non-empty string
  if ((obj.applicable as boolean) === false) {
    if (typeof obj.reason !== 'string' || obj.reason.length === 0) {
      throw new BridgeError(
        'CANONICAL_VALIDATION_FAILED',
        'artifact manifest applicable=false requires a non-empty reason string',
        500,
      );
    }
  }

  // Invariant: applicable=true → reason === null
  if ((obj.applicable as boolean) === true) {
    if (obj.reason !== null) {
      throw new BridgeError(
        'CANONICAL_VALIDATION_FAILED',
        'artifact manifest applicable=true requires reason === null',
        500,
      );
    }
  }

  return {
    version: 1,
    jobId: obj.jobId as string,
    projectId: obj.projectId as string,
    principalId: obj.principalId as string,
    backend: obj.backend as string,
    profile: obj.profile as string,
    baseCommit: obj.baseCommit as string,
    baseCertified: obj.baseCertified as boolean,
    beforeIdentity: obj.beforeIdentity as string,
    postIdentity: obj.postIdentity as string,
    changeSetHash: obj.changeSetHash as string,
    contentComplete: obj.contentComplete as boolean,
    applicable: obj.applicable as boolean,
    reason: obj.reason as string | null,
    opCount: obj.opCount as number,
    artifactBytes: obj.artifactBytes as number,
    changes: validated.entries,
  };
}

/**
 * Assert that an integer field has no negative-zero issue. In canonical JSON
 * -0 serializes as "0" (JSON spec), which is correct, but callers working
 * with numeric accounting must not pass -0 to begin with.
 */
export function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `${name} must be a non-negative integer, got ${value}`, 500);
  }
  if (Object.is(value, -0)) {
    throw new BridgeError('CANONICAL_VALIDATION_FAILED', `${name} must not be negative zero`, 500);
  }
}
