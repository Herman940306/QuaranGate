import path from 'node:path';
import { BridgeError } from './errors.js';

/** Every ASCII control character: C0 (U+0000..U+001F) plus DEL (U+007F). */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Validate a workspace-relative path from an MCP client.
 * Fail closed: absolute paths, drive letters, ASCII control characters, and any
 * `..` traversal (before or after normalization) are rejected.
 * Returns the normalized relative path ('' means the workspace root).
 */
export function validateRelativePath(input: string, allowRoot = true): string {
  if (typeof input !== 'string') throw new BridgeError('PATH_VIOLATION', 'path must be a string');
  if (input.includes('\0')) throw new BridgeError('PATH_VIOLATION', 'null byte in path');
  // Control characters must never reach the filesystem: the requested path would
  // not be the path operated on. `readlink -f` frames its answer with a single
  // LF, so a path containing LF/CR makes that record ambiguous — the canonical
  // parser can only fail closed on it, and the caller's audited path and the
  // executed path would otherwise diverge. Reject here so the ambiguity never
  // reaches the target at all, and never sanitize: stripping the characters
  // would produce that same divergence deliberately.
  const control = CONTROL_CHARS.exec(input);
  if (control) {
    const cp = control[0].codePointAt(0) ?? 0;
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    throw new BridgeError('PATH_VIOLATION', `control character U+${hex} is not allowed in paths`);
  }
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
