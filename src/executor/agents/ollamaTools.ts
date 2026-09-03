/**
 * Ollama O1 read-only tool primitives (Phase O1).
 *
 * Bounded, deterministic read-only tools for Ollama backend. Every tool
 * enforces canonical path confinement, sensitive-file policy, and strict
 * byte limits. NO mutation authority, NO shell access, NO arbitrary network.
 */
import { BridgeError } from '../../shared/errors.js';
import type { ConfinedTarget } from '../execops.js';
import { confinePath, runArgv } from '../execops.js';
import { readFile as fsReadFile, listDir, statPath } from '../fsops.js';
import { validateGuardPattern, pathIsGuarded } from './applyPolicy.js';

// ---------------------------------------------------------------------------
// O1 Qualification Limits (§8) — frozen, model cannot raise them
// ---------------------------------------------------------------------------

export const OLLAMA_O1_LIMITS = {
  MAX_FILE_READ_BYTES: 256 * 1024,      // 256 KiB per file
  MAX_TOOL_RESULT_BYTES: 256 * 1024,    // 256 KiB per tool result
  MAX_AGGREGATE_READ_BYTES: 512 * 1024, // 512 KiB total across all reads
  MAX_SEARCH_FILES: 100,                 // Max files to enumerate for search
  MAX_SEARCH_RESULTS: 200,               // Max search result lines total
} as const;

// ---------------------------------------------------------------------------
// Built-in sensitive filenames (§14) — non-removable exact-basename deny
// ---------------------------------------------------------------------------

const BUILTIN_SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'credentials',
]);

function isBuiltinSensitiveBasename(path: string): boolean {
  const basename = path.split('/').pop() ?? '';
  return BUILTIN_SENSITIVE_BASENAMES.has(basename);
}

// ---------------------------------------------------------------------------
// Sensitive path check (§13) — canonical path + built-in + project globs
// ---------------------------------------------------------------------------

interface SensitiveCheckSuccess {
  allowed: true;
  canonicalRel: string;
}

interface SensitiveCheckFailure {
  allowed: false;
  canonicalRel: string;
  reason: string;
}

type SensitiveCheckResult = SensitiveCheckSuccess | SensitiveCheckFailure;

async function checkSensitivePath(
  t: ConfinedTarget,
  rel: string,
  sensitiveGlobs: readonly string[],
): Promise<SensitiveCheckResult> {
  try {
    // Canonicalize through confinePath (throws PATH_VIOLATION on escape)
    const canonical = await confinePath(t, rel, { mustExist: true });

    // Derive canonical workspace-relative path
    const workspaceNorm = t.workspace.replace(/\/+$/, '');
    const canonicalRel = canonical === workspaceNorm
      ? '.'
      : canonical.slice(workspaceNorm.length + 1);

    // Built-in sensitive basename check
    if (isBuiltinSensitiveBasename(canonicalRel)) {
      return { allowed: false, canonicalRel, reason: 'built-in sensitive filename' };
    }

    // Project-level sensitive glob check
    if (pathIsGuarded(canonicalRel, sensitiveGlobs)) {
      return { allowed: false, canonicalRel, reason: 'matches project sensitive pattern' };
    }

    return { allowed: true, canonicalRel };
  } catch (e) {
    // confinePath threw PATH_VIOLATION or validation error
    if (e instanceof BridgeError && e.code === 'PATH_VIOLATION') {
      throw new BridgeError('FORBIDDEN_POLICY', `path violates workspace boundary: ${rel}`, 403);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Tool result types (§14, §16) — structured errors, not global BridgeError codes
// ---------------------------------------------------------------------------

export type OllamaToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string; details?: Record<string, unknown> };

function sensitivePathDenied(canonicalRel: string, reason: string): OllamaToolResult {
  return {
    success: false,
    error: 'SENSITIVE_PATH',
    details: { path: canonicalRel, reason, contentWithheld: true },
  };
}

function fileTooLarge(canonicalRel: string, limitBytes: number): OllamaToolResult {
  return {
    success: false,
    error: 'FILE_TOO_LARGE',
    details: { path: canonicalRel, limitBytes, contentWithheld: true },
  };
}

// ---------------------------------------------------------------------------
// read_file (§16) — bounded read with sensitive-path enforcement
// ---------------------------------------------------------------------------

export async function ollamaReadFile(
  t: ConfinedTarget,
  rel: string,
  sensitiveGlobs: readonly string[],
  aggregateTracker: { bytesRead: number },
): Promise<OllamaToolResult> {
  try {
    // Sensitive path check (canonical + built-in + project globs)
    const check = await checkSensitivePath(t, rel, sensitiveGlobs);
    if (!check.allowed) {
      return sensitivePathDenied(check.canonicalRel, check.reason);
    }

    // Aggregate budget precheck — refuse immediately if no budget remains
    const remainingBudget = OLLAMA_O1_LIMITS.MAX_AGGREGATE_READ_BYTES - aggregateTracker.bytesRead;
    if (remainingBudget <= 0) {
      return {
        success: false,
        error: 'AGGREGATE_LIMIT_EXCEEDED',
        details: {
          totalBytesRead: aggregateTracker.bytesRead,
          limit: OLLAMA_O1_LIMITS.MAX_AGGREGATE_READ_BYTES,
        },
      };
    }

    // Get file metadata to distinguish per-file vs aggregate limit before reading
    const stat = await statPath(t, rel);
    if (stat.type !== 'file') {
      return { success: false, error: 'FILE_NOT_FOUND', details: { message: `Not a file: ${rel}` } };
    }

    // Classification: file size vs limits
    if (stat.size > OLLAMA_O1_LIMITS.MAX_FILE_READ_BYTES) {
      // File exceeds per-file limit
      return fileTooLarge(check.canonicalRel, OLLAMA_O1_LIMITS.MAX_FILE_READ_BYTES);
    }

    if (stat.size > remainingBudget) {
      // File is within per-file limit but exceeds remaining aggregate budget
      return {
        success: false,
        error: 'AGGREGATE_LIMIT_EXCEEDED',
        details: {
          path: check.canonicalRel,
          fileSize: stat.size,
          remainingBudget,
          totalBytesRead: aggregateTracker.bytesRead,
          limit: OLLAMA_O1_LIMITS.MAX_AGGREGATE_READ_BYTES,
        },
      };
    }

    // Constrain read to remaining aggregate budget and per-file limit
    const effectiveLimit = Math.min(remainingBudget, OLLAMA_O1_LIMITS.MAX_FILE_READ_BYTES);

    // Bounded read with constrained limit
    let content: Buffer;
    try {
      content = await fsReadFile(t, rel, effectiveLimit);
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'OUTPUT_TRUNCATED') {
        // Truncation indicates file exceeded effective limit
        // Re-check which limit was violated
        if (stat.size > OLLAMA_O1_LIMITS.MAX_FILE_READ_BYTES) {
          return fileTooLarge(check.canonicalRel, OLLAMA_O1_LIMITS.MAX_FILE_READ_BYTES);
        } else {
          return {
            success: false,
            error: 'AGGREGATE_LIMIT_EXCEEDED',
            details: {
              path: check.canonicalRel,
              remainingBudget,
              totalBytesRead: aggregateTracker.bytesRead,
              limit: OLLAMA_O1_LIMITS.MAX_AGGREGATE_READ_BYTES,
            },
          };
        }
      }
      throw e;
    }

    // Update aggregate tracker
    aggregateTracker.bytesRead += content.length;

    return {
      success: true,
      data: {
        path: check.canonicalRel,
        content: content.toString('utf8'),
        size: content.length,
      },
    };
  } catch (e) {
    if (e instanceof BridgeError) {
      if (e.code === 'FORBIDDEN_POLICY') {
        throw e; // Path escape → FAILED_POLICY upstream
      }
      return { success: false, error: e.code, details: { message: e.message } };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// list_files (§17) — metadata-only, bounded enumeration
// ---------------------------------------------------------------------------

export async function ollamaListFiles(
  t: ConfinedTarget,
  rel: string,
  maxDepth = 1,
): Promise<OllamaToolResult> {
  try {
    // Canonicalize and confine
    await confinePath(t, rel, { mustExist: true });

    // Use bounded enumeration primitive - stops at MAX_SEARCH_FILES
    const files = await listDir(t, rel, Math.min(maxDepth, 3), OLLAMA_O1_LIMITS.MAX_SEARCH_FILES);

    // files.length is already <= MAX_SEARCH_FILES due to bounded enumeration
    const truncated = files.length === OLLAMA_O1_LIMITS.MAX_SEARCH_FILES;

    return {
      success: true,
      data: {
        path: rel,
        files,
        truncated,
        count: files.length,
      },
    };
  } catch (e) {
    if (e instanceof BridgeError) {
      if (e.code === 'PATH_VIOLATION') {
        throw new BridgeError('FORBIDDEN_POLICY', `path violates workspace boundary: ${rel}`, 403);
      }
      return { success: false, error: e.code, details: { message: e.message } };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// literal_search (§18) — bounded enumeration + per-file fixed-string search
// ---------------------------------------------------------------------------

interface SearchMatch {
  line: number;
  content: string;
}

interface SearchFileResult {
  file: string;
  matches: SearchMatch[];
}

async function searchSingleFile(
  t: ConfinedTarget,
  relFile: string,
  query: string,
  maxMatches: number,
): Promise<SearchMatch[]> {
  // Verify target is a file
  const stat = await statPath(t, relFile);
  if (stat.type !== 'file') {
    return [];
  }

  // Use grep with fixed-string semantics (no regex)
  const canonical = await confinePath(t, relFile, { mustExist: true });
  const result = await runArgv(
    t,
    ['grep', '-nI', '-F', '--', query, canonical],
    { principal: 'executor', timeoutMs: 10_000, maxOutputBytes: OLLAMA_O1_LIMITS.MAX_TOOL_RESULT_BYTES },
  );

  if (result.exitCode !== 0 && !result.stdout) {
    return []; // No matches or error
  }

  const matches: SearchMatch[] = [];
  const lines = result.stdout.split('\n').filter(Boolean);

  for (const line of lines) {
    if (matches.length >= maxMatches) break;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const lineNum = parseInt(line.slice(0, colonIdx), 10);
    const content = line.slice(colonIdx + 1).slice(0, 200); // Per-line content cap

    if (!isNaN(lineNum)) {
      matches.push({ line: lineNum, content });
    }
  }

  return matches;
}

export async function ollamaLiteralSearch(
  t: ConfinedTarget,
  relDir: string,
  query: string,
  sensitiveGlobs: readonly string[],
): Promise<OllamaToolResult> {
  try {
    // Validate query length (characters, not bytes)
    if (typeof query !== 'string' || query.length === 0 || query.length > 1024) {
      return {
        success: false,
        error: 'INVALID_QUERY',
        details: { message: 'query must be 1-1024 characters' },
      };
    }

    // Canonicalize directory
    await confinePath(t, relDir, { mustExist: true });

    // Use bounded enumeration primitive - stops at MAX_SEARCH_FILES + 1 to detect truncation
    const allFiles = await listDir(t, relDir, 2, OLLAMA_O1_LIMITS.MAX_SEARCH_FILES + 1);
    const regularFiles = allFiles.filter(f => !f.endsWith('/'));

    // Determine if enumeration was truncated
    const enumerationTruncated = regularFiles.length > OLLAMA_O1_LIMITS.MAX_SEARCH_FILES;

    // Take only MAX_SEARCH_FILES for processing
    const candidateFiles = regularFiles.slice(0, OLLAMA_O1_LIMITS.MAX_SEARCH_FILES);

    // Filter sensitive files before searching
    const allowedFiles: string[] = [];
    for (const file of candidateFiles) {
      try {
        const check = await checkSensitivePath(t, file, sensitiveGlobs);
        if (check.allowed) {
          allowedFiles.push(file);
        }
        // Sensitive files are silently skipped (never reach grep)
      } catch {
        // Skip files that fail canonicalization/sensitive check
        continue;
      }
    }

    // Search each allowed file
    const results: SearchFileResult[] = [];
    let totalMatches = 0;

    for (const file of allowedFiles) {
      if (totalMatches >= OLLAMA_O1_LIMITS.MAX_SEARCH_RESULTS) break;

      try {
        const remainingMatches = OLLAMA_O1_LIMITS.MAX_SEARCH_RESULTS - totalMatches;
        const matches = await searchSingleFile(t, file, query, Math.min(remainingMatches, 10));

        if (matches.length > 0) {
          results.push({ file, matches });
          totalMatches += matches.length;
        }
      } catch {
        // Skip unreadable files (binary, permissions, etc.)
        continue;
      }
    }

    return {
      success: true,
      data: {
        query,
        directory: relDir,
        results,
        filesSearched: allowedFiles.length,
        totalMatches,
        truncated: totalMatches >= OLLAMA_O1_LIMITS.MAX_SEARCH_RESULTS || enumerationTruncated,
      },
    };
  } catch (e) {
    if (e instanceof BridgeError) {
      if (e.code === 'PATH_VIOLATION') {
        throw new BridgeError('FORBIDDEN_POLICY', `path violates workspace boundary: ${relDir}`, 403);
      }
      return { success: false, error: e.code, details: { message: e.message } };
    }
    throw e;
  }
}
