import path from 'node:path';
import { BridgeError } from './errors.js';

/**
 * Validate a workspace-relative path from an MCP client.
 * Fail closed: absolute paths, drive letters, null bytes, and any `..`
 * traversal (before or after normalization) are rejected.
 * Returns the normalized relative path ('' means the workspace root).
 */
export function validateRelativePath(input: string, allowRoot = true): string {
  if (typeof input !== 'string') throw new BridgeError('PATH_VIOLATION', 'path must be a string');
  if (input.includes('\0')) throw new BridgeError('PATH_VIOLATION', 'null byte in path');
  if (input.includes('\\')) throw new BridgeError('PATH_VIOLATION', 'backslash in path');
  if (path.posix.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
    throw new BridgeError('PATH_VIOLATION', 'absolute paths are not allowed; use workspace-relative paths');
  }
  const norm = path.posix.normalize(input);
  if (norm === '.' || norm === './' || norm === '') {
    if (!allowRoot) throw new BridgeError('PATH_VIOLATION', 'workspace root not allowed here');
    return '';
  }
  for (const seg of norm.split('/')) {
    if (seg === '..') throw new BridgeError('PATH_VIOLATION', 'path traversal is not allowed');
  }
  return norm.replace(/\/+$/, '');
}

/** Join a validated relative path onto an absolute in-container workspace root. */
export function joinWorkspace(workspaceRoot: string, rel: string): string {
  const joined = rel === '' ? workspaceRoot : path.posix.join(workspaceRoot, rel);
  if (joined !== workspaceRoot && !joined.startsWith(workspaceRoot.replace(/\/+$/, '') + '/')) {
    throw new BridgeError('PATH_VIOLATION', 'resolved path escapes workspace');
  }
  return joined;
}

/** True when `candidate` (canonical, absolute) is the root or inside it. */
export function isInside(rootCanonical: string, candidate: string): boolean {
  const root = rootCanonical.replace(/\/+$/, '') || '/';
  return candidate === root || candidate.startsWith(root === '/' ? '/' : root + '/');
}
