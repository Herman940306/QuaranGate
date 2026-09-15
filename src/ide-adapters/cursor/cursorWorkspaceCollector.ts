/**
 * I2.1 mechanical Cursor/Remote-WSL workspace evidence collection.
 *
 * This collector uses no shell command and accepts no project/worktree ID.
 * It turns extension-host facts plus OS/Git metadata into B5 physical evidence;
 * QuaranGate remains the only authority that maps that evidence to enrollment.
 */
import { lstat, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  deriveIdeEnvironmentIdentity,
  deriveIdeFilesystemIdentity,
  type IdeWorkspaceGitIdentity,
  type IdeWorkspacePhysicalIdentity,
} from '../../shared/ideWorkspaceAttestation.js';

export const CURSOR_WORKSPACE_MACHINE_ID_PATH = '/etc/machine-id';
export const CURSOR_WORKSPACE_MAX_GIT_FILE_BYTES = 256 * 1024;
const SHA1 = /^[0-9a-f]{40}$/;
const MACHINE_ID = /^[0-9a-f]{32}$/;
const REF = /^refs\/[A-Za-z0-9._\/-]+$/;
const CASE_SENSITIVE_FS_MAGIC = new Set<bigint>([
  0x0000ef53n, // ext2/3/4
  0x58465342n, // xfs
  0x9123683en, // btrfs
  0x794c7630n, // overlayfs
]);

export type CursorWorkspaceCollectorErrorCode =
  | 'CURSOR_WORKSPACE_HOST_DENIED'
  | 'CURSOR_WORKSPACE_AMBIGUOUS'
  | 'CURSOR_WORKSPACE_PATH_DENIED'
  | 'CURSOR_WORKSPACE_FILESYSTEM_DENIED'
  | 'CURSOR_WORKSPACE_ENVIRONMENT_DENIED'
  | 'CURSOR_WORKSPACE_GIT_DENIED';

export class CursorWorkspaceCollectorError extends Error {
  constructor(public readonly code: CursorWorkspaceCollectorErrorCode, message: string) {
    super(message);
    this.name = 'CursorWorkspaceCollectorError';
  }
}

export interface CursorWorkspaceSnapshot {
  remoteName: string | undefined;
  extensionHostKind: 'workspace' | 'ui' | 'unknown';
  workspaceFolders: readonly Readonly<{ uri: string; fsPath: string; scheme: string }>[];
}

export interface CursorWorkspaceCollectorOptions {
  machineIdPath?: string;
}

function fail(code: CursorWorkspaceCollectorErrorCode, message: string): never {
  throw new CursorWorkspaceCollectorError(code, message);
}

async function readBoundedRegularFile(path: string, maxBytes: number, code: CursorWorkspaceCollectorErrorCode): Promise<string> {
  let info;
  try { info = await lstat(path); } catch (error) {
    const fsCode = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (fsCode === 'ENOENT') fail(code, 'required workspace metadata file is absent');
    fail(code, 'required workspace metadata file cannot be inspected');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) {
    fail(code, 'workspace metadata file type/size is invalid');
  }
  const value = await readFile(path, 'utf8');
  if (Buffer.byteLength(value, 'utf8') > maxBytes) fail(code, 'workspace metadata file exceeded bound while reading');
  return value;
}

async function optionalBoundedRegularFile(path: string, maxBytes: number, code: CursorWorkspaceCollectorErrorCode): Promise<string | undefined> {
  try { return await readBoundedRegularFile(path, maxBytes, code); }
  catch (error) {
    if (error instanceof CursorWorkspaceCollectorError && error.message === 'required workspace metadata file is absent') return undefined;
    throw error;
  }
}

async function exactDirectoryIdentity(path: string, code: CursorWorkspaceCollectorErrorCode): Promise<{ canonical: string; deviceId: string; fileId: string }> {
  if (!isAbsolute(path) || path !== posix.normalize(path) || path.includes('\\') || path === '/') fail(code, 'workspace directory path is not canonical POSIX');
  let canonical: string;
  try { canonical = await realpath(path); } catch { fail(code, 'workspace directory cannot be canonicalized'); }
  if (canonical !== path) fail(code, 'workspace directory contains a symbolic-link/alias component');
  const info = await stat(path, { bigint: true });
  if (!info.isDirectory() || info.ino <= 0n || info.dev < 0n) fail(code, 'workspace directory identity is unavailable');
  return { canonical, deviceId: info.dev.toString(10), fileId: info.ino.toString(10) };
}

async function proveCaseSensitiveFilesystem(path: string): Promise<void> {
  let type: bigint;
  try {
    const info = await statfs(path, { bigint: true });
    type = info.type & 0xffffffffn;
  } catch { fail('CURSOR_WORKSPACE_FILESYSTEM_DENIED', 'workspace filesystem type cannot be determined'); }
  if (!CASE_SENSITIVE_FS_MAGIC.has(type)) {
    fail('CURSOR_WORKSPACE_FILESYSTEM_DENIED', 'workspace filesystem type is outside the qualified case-sensitive set');
  }
}

async function readEnvironmentIdentity(machineIdPath: string): Promise<string> {
  const raw = await readBoundedRegularFile(machineIdPath, 128, 'CURSOR_WORKSPACE_ENVIRONMENT_DENIED');
  const stable = raw.trim();
  if (!MACHINE_ID.test(stable)) fail('CURSOR_WORKSPACE_ENVIRONMENT_DENIED', 'WSL machine identity is malformed');
  return deriveIdeEnvironmentIdentity('wsl', stable);
}

function exactGitPath(base: string, candidate: string): string {
  const resolved = resolve(base, candidate);
  if (!isAbsolute(resolved) || resolved.includes('\\') || resolved === '/') fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git metadata path is invalid');
  return resolved;
}

async function resolveGitDirectory(workspace: string): Promise<string | undefined> {
  const dotGit = join(workspace, '.git');
  let info;
  try { info = await lstat(dotGit); } catch (error) {
    const fsCode = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (fsCode === 'ENOENT') return undefined;
    fail('CURSOR_WORKSPACE_GIT_DENIED', '.git cannot be inspected');
  }
  if (info.isSymbolicLink()) fail('CURSOR_WORKSPACE_GIT_DENIED', '.git must not be a symbolic link');
  let candidate: string;
  if (info.isDirectory()) candidate = dotGit;
  else if (info.isFile()) {
    const body = await readBoundedRegularFile(dotGit, 4096, 'CURSOR_WORKSPACE_GIT_DENIED');
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(body);
    if (!match?.[1]) fail('CURSOR_WORKSPACE_GIT_DENIED', '.git file framing is invalid');
    candidate = exactGitPath(workspace, match[1]);
  } else fail('CURSOR_WORKSPACE_GIT_DENIED', '.git has an unsupported type');
  const canonical = await realpath(candidate).catch(() => fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git directory cannot be canonicalized'));
  if (canonical !== candidate) fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git directory contains a symbolic-link/alias component');
  const dir = await stat(candidate);
  if (!dir.isDirectory()) fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git directory is not a directory');
  return candidate;
}

async function resolveCommonDirectory(gitDir: string): Promise<string> {
  const body = await optionalBoundedRegularFile(join(gitDir, 'commondir'), 4096, 'CURSOR_WORKSPACE_GIT_DENIED');
  if (body === undefined) return gitDir;
  const relative = body.trim();
  if (!relative || relative.includes('\0')) fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git commondir is malformed');
  const candidate = exactGitPath(gitDir, relative);
  const canonical = await realpath(candidate).catch(() => fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git common directory cannot be canonicalized'));
  if (canonical !== candidate) fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git common directory contains a symbolic-link/alias component');
  const info = await stat(candidate);
  if (!info.isDirectory()) fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git common directory is not a directory');
  return candidate;
}

async function resolveLooseRef(gitDir: string, commonDir: string, ref: string): Promise<string | undefined> {
  if (!REF.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/')) fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git HEAD ref is unsafe');
  for (const base of gitDir === commonDir ? [commonDir] : [gitDir, commonDir]) {
    const body = await optionalBoundedRegularFile(join(base, ...ref.split('/')), 256, 'CURSOR_WORKSPACE_GIT_DENIED');
    if (body === undefined) continue;
    const hash = body.trim();
    if (!SHA1.test(hash)) fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git loose ref is not a SHA-1 revision');
    return hash;
  }
  return undefined;
}

async function resolvePackedRef(commonDir: string, ref: string): Promise<string | undefined> {
  const packed = await optionalBoundedRegularFile(join(commonDir, 'packed-refs'), CURSOR_WORKSPACE_MAX_GIT_FILE_BYTES, 'CURSOR_WORKSPACE_GIT_DENIED');
  if (packed === undefined) return undefined;
  let match: string | undefined;
  for (const raw of packed.split(/\r?\n/u)) {
    if (!raw || raw.startsWith('#') || raw.startsWith('^')) continue;
    const parts = raw.split(' ');
    if (parts.length !== 2) fail('CURSOR_WORKSPACE_GIT_DENIED', 'packed-refs contains a malformed record');
    const [hash, name] = parts;
    if (!hash || !name || !SHA1.test(hash) || !REF.test(name)) fail('CURSOR_WORKSPACE_GIT_DENIED', 'packed-refs contains invalid identity data');
    if (name === ref) {
      if (match !== undefined) fail('CURSOR_WORKSPACE_GIT_DENIED', 'packed-refs contains duplicate target ref');
      match = hash;
    }
  }
  return match;
}

async function resolveHead(gitDir: string, commonDir: string): Promise<string> {
  const raw = (await readBoundedRegularFile(join(gitDir, 'HEAD'), 4096, 'CURSOR_WORKSPACE_GIT_DENIED')).trim();
  if (SHA1.test(raw)) return raw;
  const match = /^ref: (refs\/[A-Za-z0-9._\/-]+)$/u.exec(raw);
  if (!match?.[1]) fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git HEAD is neither a SHA-1 nor a supported ref');
  const ref = match[1];
  const loose = await resolveLooseRef(gitDir, commonDir, ref);
  if (loose !== undefined) return loose;
  const packed = await resolvePackedRef(commonDir, ref);
  if (packed !== undefined) return packed;
  fail('CURSOR_WORKSPACE_GIT_DENIED', 'Git HEAD ref cannot be resolved');
}

async function collectGitIdentity(workspace: string): Promise<IdeWorkspaceGitIdentity> {
  const gitDir = await resolveGitDirectory(workspace);
  if (gitDir === undefined) return { kind: 'none' };
  const commonDir = await resolveCommonDirectory(gitDir);
  const common = await exactDirectoryIdentity(commonDir, 'CURSOR_WORKSPACE_GIT_DENIED');
  const headRevision = await resolveHead(gitDir, commonDir);
  return {
    kind: 'worktree',
    worktreeRoot: workspace,
    commonDir,
    commonDirIdentity: deriveIdeFilesystemIdentity('posix', common.deviceId, common.fileId),
    headRevision,
  };
}

export async function collectCursorWorkspacePhysicalIdentity(
  snapshot: CursorWorkspaceSnapshot,
  options: CursorWorkspaceCollectorOptions = {},
): Promise<IdeWorkspacePhysicalIdentity> {
  if (snapshot.remoteName !== 'wsl' || snapshot.extensionHostKind !== 'workspace') {
    fail('CURSOR_WORKSPACE_HOST_DENIED', 'Cursor companion must run in the Remote-WSL workspace extension host');
  }
  if (snapshot.workspaceFolders.length !== 1 || snapshot.workspaceFolders[0] === undefined) {
    fail('CURSOR_WORKSPACE_AMBIGUOUS', 'exactly one Cursor workspace folder is required');
  }
  const folder = snapshot.workspaceFolders[0];
  if (folder.scheme !== 'file' || !isAbsolute(folder.fsPath) || folder.fsPath.includes('\\') || posix.normalize(folder.fsPath) !== folder.fsPath) {
    fail('CURSOR_WORKSPACE_PATH_DENIED', 'workspace folder must be one absolute normalized WSL file path');
  }
  let decoded: string;
  try { decoded = fileURLToPath(new URL(folder.uri)); } catch { fail('CURSOR_WORKSPACE_PATH_DENIED', 'workspace folder URI is invalid'); }
  if (decoded !== folder.fsPath || pathToFileURL(folder.fsPath).href !== folder.uri) {
    fail('CURSOR_WORKSPACE_PATH_DENIED', 'workspace URI and filesystem path are not one canonical file identity');
  }
  const identity = await exactDirectoryIdentity(folder.fsPath, 'CURSOR_WORKSPACE_PATH_DENIED');
  await proveCaseSensitiveFilesystem(identity.canonical);
  const environmentIdentity = await readEnvironmentIdentity(options.machineIdPath ?? CURSOR_WORKSPACE_MACHINE_ID_PATH);
  const git = await collectGitIdentity(identity.canonical);
  return {
    workspaceFolderCount: 1,
    remoteKind: 'wsl',
    environmentIdentity,
    pathFlavor: 'posix',
    caseMode: 'case-sensitive',
    canonicalization: 'realpath-exact',
    workspaceUri: pathToFileURL(identity.canonical).href,
    canonicalPath: identity.canonical,
    filesystemIdentity: deriveIdeFilesystemIdentity('posix', identity.deviceId, identity.fileId),
    git,
  };
}
