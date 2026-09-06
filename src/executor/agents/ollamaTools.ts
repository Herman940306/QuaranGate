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
import { readFile as fsReadFile, statPath } from '../fsops.js';
import { validateGuardPattern, pathIsGuarded } from './applyPolicy.js';

// ---------------------------------------------------------------------------
// O1 Qualification Limits (§8) — frozen, model cannot raise them
// ---------------------------------------------------------------------------

export const MAX_READ_CHUNK_BYTES = 8 * 1024;
export const DEFAULT_READ_START_LINE = 1;
export const DEFAULT_READ_MAX_LINES = 200;
export const MAX_READ_LINES = 400;

export const OLLAMA_O1_LIMITS = {
  MAX_FILE_READ_BYTES: 256 * 1024,      // 256 KiB per file
  MAX_READ_CHUNK_BYTES,                  // 8 KiB exposed content per read window
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

/** Select and account for one complete-line read window from an eligible file. */
export function buildOllamaReadWindow(
  canonicalRel: string,
  content: Buffer,
  fileSize: number,
  aggregateTracker: { bytesRead: number },
  startLine = DEFAULT_READ_START_LINE,
  maxLines = DEFAULT_READ_MAX_LINES,
): OllamaToolResult {
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

  const lineEnds: number[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === 0x0a) lineEnds.push(index + 1);
  }
  if (content.length > 0 && content[content.length - 1] !== 0x0a) {
    lineEnds.push(content.length);
  }

  const totalLines = lineEnds.length;
  const firstIndex = Math.min(startLine - 1, totalLines);
  const byteStart = firstIndex === 0 ? 0 : lineEnds[firstIndex - 1]!;
  let byteEnd = byteStart;
  let selectedLines = 0;

  while (firstIndex + selectedLines < totalLines && selectedLines < maxLines) {
    const candidateEnd = lineEnds[firstIndex + selectedLines]!;
    const lineBytes = candidateEnd - byteEnd;
    if (selectedLines === 0 && lineBytes > OLLAMA_O1_LIMITS.MAX_READ_CHUNK_BYTES) {
      return {
        success: false,
        error: 'LINE_TOO_LARGE',
        details: {
          path: canonicalRel,
          lineNumber: startLine,
          limitBytes: OLLAMA_O1_LIMITS.MAX_READ_CHUNK_BYTES,
          contentWithheld: true,
        },
      };
    }
    if (candidateEnd - byteStart > OLLAMA_O1_LIMITS.MAX_READ_CHUNK_BYTES) break;
    byteEnd = candidateEnd;
    selectedLines++;
  }

  const exposed = content.subarray(byteStart, byteEnd);
  if (exposed.length > remainingBudget) {
    return {
      success: false,
      error: 'AGGREGATE_LIMIT_EXCEEDED',
      details: {
        path: canonicalRel,
        requestedContentBytes: exposed.length,
        remainingBudget,
        totalBytesRead: aggregateTracker.bytesRead,
        limit: OLLAMA_O1_LIMITS.MAX_AGGREGATE_READ_BYTES,
        contentWithheld: true,
      },
    };
  }

  aggregateTracker.bytesRead += exposed.length;
  // When startLine > totalLines (beyond EOF) selectedLines is 0 and startLine - 1
  // would exceed totalLines, producing misleading metadata.  Clamp to totalLines.
  const endLine = selectedLines === 0
    ? Math.min(startLine - 1, totalLines)
    : startLine + selectedLines - 1;
  const nextStartLine = firstIndex + selectedLines < totalLines ? endLine + 1 : null;

  return {
    success: true,
    data: {
      path: canonicalRel,
      content: exposed.toString('utf8'),
      fileSize,
      contentBytes: exposed.length,
      startLine,
      endLine,
      totalLines,
      nextStartLine,
      eof: nextStartLine === null,
    },
  };
}

export async function ollamaReadFile(
  t: ConfinedTarget,
  rel: string,
  sensitiveGlobs: readonly string[],
  aggregateTracker: { bytesRead: number },
  startLine = DEFAULT_READ_START_LINE,
  maxLines = DEFAULT_READ_MAX_LINES,
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

    // Read only files proven eligible by the whole-file limit. The full bounded
    // source is needed to derive stable line numbers and totalLines, but only a
    // complete-line window is ever exposed to the model or charged to aggregate.
    let content: Buffer;
    try {
      content = await fsReadFile(t, rel, OLLAMA_O1_LIMITS.MAX_FILE_READ_BYTES);
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'OUTPUT_TRUNCATED') {
        // The file grew after stat or otherwise exceeded the eligibility bound.
        return fileTooLarge(check.canonicalRel, OLLAMA_O1_LIMITS.MAX_FILE_READ_BYTES);
      }
      throw e;
    }

    return buildOllamaReadWindow(
      check.canonicalRel,
      content,
      stat.size,
      aggregateTracker,
      startLine,
      maxLines,
    );
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
// O1 portable bounded enumeration
// ---------------------------------------------------------------------------

/**
 * The O1 helper image is a QuaranGate runtime image and therefore has Node.js.
 * Use Node filesystem APIs instead of GNU-only `find -printf` so the exact
 * qualified Alpine/BusyBox helper environment is supported. Traversal is
 * deterministic, does not follow symlink directories, and stops as soon as the
 * trusted entry limit is reached.
 */
export const OLLAMA_BOUNDED_ENUMERATION_SCRIPT = [
  'const fs=require("fs"),path=require("path");',
  'const root=process.argv[1],workspace=process.argv[2];',
  'const maxDepth=Number(process.argv[3]),limit=Number(process.argv[4]);',
  'function fail(){process.exit(2);}',
  'if(!root||!workspace||!Number.isInteger(maxDepth)||maxDepth<1||maxDepth>3||!Number.isInteger(limit)||limit<1||limit>101)fail();',
  'const entries=[];let truncated=false;',
  'function rel(abs){const r=path.relative(workspace,abs).split(path.sep).join("/");if(!r||r===".."||r.startsWith("../")||path.isAbsolute(r))fail();return r;}',
  'function walk(dir,depth){',
  '  let items;try{items=fs.readdirSync(dir,{withFileTypes:true});}catch(_){fail();}',
  '  items.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);',
  '  for(const ent of items){',
  '    if(entries.length>=limit){truncated=true;return;}',
  '    const abs=path.join(dir,ent.name);const r=rel(abs);',
  '    entries.push(ent.isDirectory()?r+"/":r);',
  '    if(ent.isDirectory()&&depth<maxDepth){walk(abs,depth+1);if(truncated)return;}',
  '  }',
  '}',
  'walk(root,1);',
  'process.stdout.write(JSON.stringify({entries,truncated})+"\\n");',
].join('');

export interface OllamaBoundedEnumerationResult {
  entries: string[];
  truncated: boolean;
}

interface OllamaEnumerationExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function enumerationFailure(): BridgeError {
  return new BridgeError('COMMAND_FAILED', 'bounded O1 enumeration failed', 422);
}

/** Parse only a complete successful enumerator response; malformed/partial output fails closed. */
export function parseOllamaBoundedEnumerationResult(
  result: OllamaEnumerationExecResult,
  maxEntries: number,
): OllamaBoundedEnumerationResult {
  if (result.exitCode !== 0 || result.truncated) throw enumerationFailure();

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw enumerationFailure();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw enumerationFailure();
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.entries) || typeof obj.truncated !== 'boolean') throw enumerationFailure();
  if (obj.entries.length > maxEntries) throw enumerationFailure();

  const entries: string[] = [];
  for (const value of obj.entries) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw enumerationFailure();
    const bare = value.endsWith('/') ? value.slice(0, -1) : value;
    if (!bare || bare.startsWith('/') || bare.split('/').includes('..')) throw enumerationFailure();
    entries.push(value);
  }

  return { entries, truncated: obj.truncated };
}

async function boundedOllamaListDir(
  t: ConfinedTarget,
  rel: string,
  maxDepth: number,
  maxEntries: number,
): Promise<OllamaBoundedEnumerationResult> {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 3) throw enumerationFailure();
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > OLLAMA_O1_LIMITS.MAX_SEARCH_FILES + 1) {
    throw enumerationFailure();
  }

  const abs = await confinePath(t, rel, { mustExist: true });
  const result = await runArgv(
    t,
    ['node', '-e', OLLAMA_BOUNDED_ENUMERATION_SCRIPT, abs, t.workspace, String(maxDepth), String(maxEntries)],
    { principal: 'executor', timeoutMs: 15_000, maxOutputBytes: 128 * 1024 },
  );
  return parseOllamaBoundedEnumerationResult(result, maxEntries);
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

    // O1 uses its own qualified helper-local enumerator. It is bounded before
    // output materialization and does not depend on GNU find extensions.
    const enumeration = await boundedOllamaListDir(
      t,
      rel,
      Math.min(maxDepth, 3),
      OLLAMA_O1_LIMITS.MAX_SEARCH_FILES,
    );
    const files = enumeration.entries;
    const truncated = enumeration.truncated;

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
// literal_search (§18) — bounded recursive eligible-file search
// ---------------------------------------------------------------------------

/**
 * Search enumeration is intentionally separate from list_files. It recursively
 * walks the requested directory, does not follow symlink directories, skips
 * built-in/project-sensitive paths before counting the search budget, and
 * stops when it encounters the 101st eligible regular file. That makes the
 * public 100-file limit truthful: directories and denied files do not consume
 * the file-search budget.
 *
 * The helper imports the exact compiled guarded-path matcher from the same
 * immutable QuaranGate image rather than reimplementing glob semantics.
 */
export const OLLAMA_BOUNDED_SEARCH_ENUMERATION_SCRIPT = [
  'import fs from "node:fs";import path from "node:path";',
  'const root=process.argv[1],workspace=process.argv[2],limit=Number(process.argv[3]),policyUrl=process.argv[4];',
  'function fail(){process.exit(2);}',
  'let builtins,sensitive;try{builtins=new Set(JSON.parse(process.argv[5]));sensitive=JSON.parse(process.argv[6]);}catch(_){fail();}',
  'if(!root||!workspace||!policyUrl||!Number.isInteger(limit)||limit<1||limit>100||!Array.isArray(sensitive)||sensitive.some(x=>typeof x!=="string"))fail();',
  'const mod=await import(policyUrl);if(typeof mod.pathIsGuarded!=="function")fail();const pathIsGuarded=mod.pathIsGuarded;',
  'const files=[];let incomplete=false;',
  'function rel(abs){const r=path.relative(workspace,abs).split(path.sep).join("/");if(!r||r===".."||r.startsWith("../")||path.isAbsolute(r))fail();return r;}',
  'function allowed(r){const base=r.split("/").pop()||"";if(builtins.has(base))return false;try{return !pathIsGuarded(r,sensitive);}catch(_){fail();}}',
  'function walk(dir){',
  '  let items;try{items=fs.readdirSync(dir,{withFileTypes:true});}catch(_){fail();}',
  '  items.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);',
  '  for(const ent of items){',
  '    const abs=path.join(dir,ent.name);',
  '    if(ent.isDirectory()){walk(abs);if(incomplete)return;continue;}',
  '    if(!ent.isFile())continue;',
  '    const r=rel(abs);if(!allowed(r))continue;',
  '    if(files.length>=limit){incomplete=true;return;}',
  '    files.push(r);',
  '  }',
  '}',
  'walk(root);',
  'process.stdout.write(JSON.stringify({files,incomplete})+"\\n");',
].join('');

export interface OllamaSearchEnumerationResult {
  files: string[];
  incomplete: boolean;
}

function searchFailure(): BridgeError {
  return new BridgeError('COMMAND_FAILED', 'bounded O1 literal search failed', 422);
}

export function parseOllamaSearchEnumerationResult(
  result: OllamaEnumerationExecResult & { timedOut?: boolean },
  maxFiles: number,
): OllamaSearchEnumerationResult {
  if (result.exitCode !== 0 || result.truncated || result.timedOut === true) throw searchFailure();

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw searchFailure();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw searchFailure();
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.files) || typeof obj.incomplete !== 'boolean' || obj.files.length > maxFiles) throw searchFailure();

  const files: string[] = [];
  for (const value of obj.files) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw searchFailure();
    if (value.startsWith('/') || value.endsWith('/') || value.split('/').includes('..')) throw searchFailure();
    files.push(value);
  }
  return { files, incomplete: obj.incomplete };
}

async function boundedOllamaSearchFiles(
  t: ConfinedTarget,
  relDir: string,
  sensitiveGlobs: readonly string[],
): Promise<OllamaSearchEnumerationResult> {
  const abs = await confinePath(t, relDir, { mustExist: true });
  const applyPolicyModuleUrl = new URL('./applyPolicy.js', import.meta.url).href;
  const result = await runArgv(
    t,
    [
      'node', '--input-type=module', '-e', OLLAMA_BOUNDED_SEARCH_ENUMERATION_SCRIPT,
      abs,
      t.workspace,
      String(OLLAMA_O1_LIMITS.MAX_SEARCH_FILES),
      applyPolicyModuleUrl,
      JSON.stringify([...BUILTIN_SENSITIVE_BASENAMES]),
      JSON.stringify([...sensitiveGlobs]),
    ],
    { principal: 'executor', timeoutMs: 15_000, maxOutputBytes: 128 * 1024 },
  );
  return parseOllamaSearchEnumerationResult(result, OLLAMA_O1_LIMITS.MAX_SEARCH_FILES);
}

interface SearchMatch {
  line: number;
  content: string;
}

interface SearchFileResult {
  file: string;
  matches: SearchMatch[];
}

export interface OllamaLiteralFileSearchResult {
  matches: SearchMatch[];
  incomplete: boolean;
}

export function parseOllamaLiteralGrepResult(
  result: { exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timedOut?: boolean },
  maxMatches: number,
): OllamaLiteralFileSearchResult {
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > OLLAMA_O1_LIMITS.MAX_SEARCH_RESULTS) throw searchFailure();
  if (result.timedOut === true || result.truncated || result.exitCode === null) throw searchFailure();
  if (result.exitCode === 1) return { matches: [], incomplete: false }; // grep: ordinary no-match
  if (result.exitCode !== 0 || result.stdout.length === 0) throw searchFailure();

  const lines = result.stdout.split('\n').filter(Boolean);
  const incomplete = lines.length > maxMatches;
  const matches: SearchMatch[] = [];
  for (const line of lines.slice(0, maxMatches)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) throw searchFailure();
    const lineNum = Number.parseInt(line.slice(0, colonIdx), 10);
    if (!Number.isInteger(lineNum) || lineNum < 1) throw searchFailure();
    matches.push({ line: lineNum, content: line.slice(colonIdx + 1).slice(0, 200) });
  }
  return { matches, incomplete };
}

async function searchSingleFile(
  t: ConfinedTarget,
  relFile: string,
  query: string,
  maxMatches: number,
): Promise<OllamaLiteralFileSearchResult> {
  const stat = await statPath(t, relFile);
  if (stat.type !== 'file') throw searchFailure();

  const canonical = await confinePath(t, relFile, { mustExist: true });
  const result = await runArgv(
    t,
    ['grep', '-nI', '-F', '--', query, canonical],
    { principal: 'executor', timeoutMs: 10_000, maxOutputBytes: OLLAMA_O1_LIMITS.MAX_TOOL_RESULT_BYTES },
  );
  return parseOllamaLiteralGrepResult(result, maxMatches);
}

export async function ollamaLiteralSearch(
  t: ConfinedTarget,
  relDir: string,
  query: string,
  sensitiveGlobs: readonly string[],
): Promise<OllamaToolResult> {
  try {
    if (typeof query !== 'string' || query.length === 0 || query.length > 1024) {
      return {
        success: false,
        error: 'INVALID_QUERY',
        details: { message: 'query must be 1-1024 characters' },
      };
    }

    await confinePath(t, relDir, { mustExist: true });
    const enumeration = await boundedOllamaSearchFiles(t, relDir, sensitiveGlobs);

    const results: SearchFileResult[] = [];
    let totalMatches = 0;
    let filesSearched = 0;
    let resultLimitIncomplete = false;

    for (let index = 0; index < enumeration.files.length; index++) {
      const file = enumeration.files[index]!;

      // Defense in depth: the helper uses the same matcher, but the executor
      // rechecks every returned path before exposing grep output to the model.
      const check = await checkSensitivePath(t, file, sensitiveGlobs);
      if (!check.allowed) throw searchFailure();

      const remainingMatches = OLLAMA_O1_LIMITS.MAX_SEARCH_RESULTS - totalMatches;
      if (remainingMatches <= 0) {
        resultLimitIncomplete = true;
        break;
      }

      const searched = await searchSingleFile(t, file, query, remainingMatches);
      filesSearched++;
      if (searched.matches.length > 0) {
        results.push({ file, matches: searched.matches });
        totalMatches += searched.matches.length;
      }
      if (searched.incomplete) {
        resultLimitIncomplete = true;
        break;
      }
      if (totalMatches >= OLLAMA_O1_LIMITS.MAX_SEARCH_RESULTS && index < enumeration.files.length - 1) {
        resultLimitIncomplete = true;
        break;
      }
    }

    const searchComplete = !enumeration.incomplete
      && !resultLimitIncomplete
      && filesSearched === enumeration.files.length;

    return {
      success: true,
      data: {
        query,
        directory: relDir,
        results,
        filesSearched,
        totalMatches,
        searchComplete,
        truncated: !searchComplete,
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
