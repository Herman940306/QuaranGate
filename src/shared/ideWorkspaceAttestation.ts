/**
 * Backend-neutral IDE workspace/worktree attestation contract (P7 B5).
 *
 * This module carries evidence, never authority. Project/worktree identifiers
 * are deliberately absent from adapter evidence and enter only through the
 * trusted enrollment when QuaranGate derives/verifies the workspace fingerprint.
 */
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertIdeConnectionGeneration,
  assertIdeEnrollmentId,
  assertIdeInstanceId,
  assertIdeLogicalId,
  assertIdeProduct,
  assertIdeSessionId,
  type IdeProductId,
} from './ideSessions.js';

export const IDE_WORKSPACE_ATTESTATION_VERSION = 1 as const;
export const IDE_WORKSPACE_ATTESTATION_MAX_BYTES = 16 * 1024;
export const IDE_WORKSPACE_MAX_URI_BYTES = 4096;
export const IDE_WORKSPACE_MAX_PATH_BYTES = 4096;
export const IDE_WORKSPACE_RUNTIME_ID_PATTERN = /^iderun_[0-9a-f]{32}$/;
export const IDE_WORKSPACE_ADAPTER_ID_PATTERN = /^quarangate-[a-z0-9-]{1,48}-companion$/;
export const IDE_WORKSPACE_REMOTE_KINDS = ['local', 'wsl', 'ssh', 'dev-container', 'codespaces'] as const;
export type IdeWorkspaceRemoteKind = (typeof IDE_WORKSPACE_REMOTE_KINDS)[number];
export const IDE_WORKSPACE_PATH_FLAVORS = ['posix', 'win32'] as const;
export type IdeWorkspacePathFlavor = (typeof IDE_WORKSPACE_PATH_FLAVORS)[number];
export const IDE_WORKSPACE_CASE_MODES = ['case-sensitive', 'case-insensitive'] as const;
export type IdeWorkspaceCaseMode = (typeof IDE_WORKSPACE_CASE_MODES)[number];

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const DECIMAL_ID = /^(?:0|[1-9][0-9]{0,39})$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FINGERPRINT_DOMAIN = 'quarangate.ide.workspace-fingerprint.v1';
const FILESYSTEM_DOMAIN = 'quarangate.ide.filesystem-identity.v1';
const ENVIRONMENT_DOMAIN = 'quarangate.ide.environment-identity.v1';

export type IdeWorkspaceAttestationErrorCode =
  | 'IDE_WORKSPACE_FRAME_SIZE'
  | 'IDE_WORKSPACE_INVALID_JSON'
  | 'IDE_WORKSPACE_INVALID_SCHEMA'
  | 'IDE_WORKSPACE_UNSUPPORTED_VERSION'
  | 'IDE_WORKSPACE_IDENTITY_INVALID';

export class IdeWorkspaceAttestationError extends Error {
  constructor(public readonly code: IdeWorkspaceAttestationErrorCode, message: string) {
    super(message);
    this.name = 'IdeWorkspaceAttestationError';
  }
}

export interface IdeWorkspaceGitNoneIdentity { kind: 'none'; }
export interface IdeWorkspaceGitWorktreeIdentity {
  kind: 'worktree';
  worktreeRoot: string;
  commonDir: string;
  commonDirIdentity: string;
  headRevision: string;
}
export type IdeWorkspaceGitIdentity = IdeWorkspaceGitNoneIdentity | IdeWorkspaceGitWorktreeIdentity;

export interface IdeWorkspacePhysicalIdentity {
  workspaceFolderCount: 1;
  remoteKind: IdeWorkspaceRemoteKind;
  environmentIdentity: string;
  pathFlavor: IdeWorkspacePathFlavor;
  caseMode: IdeWorkspaceCaseMode;
  canonicalization: 'realpath-exact';
  workspaceUri: string;
  canonicalPath: string;
  filesystemIdentity: string;
  git: IdeWorkspaceGitIdentity;
}

export interface IdeWorkspaceAttestation {
  version: typeof IDE_WORKSPACE_ATTESTATION_VERSION;
  enrollmentId: string;
  ideInstanceId: string;
  runtimeInstanceId: string;
  ideProduct: IdeProductId;
  adapterId: string;
  adapterVersion: string;
  sessionId: string;
  connectionGeneration: number;
  workspace: IdeWorkspacePhysicalIdentity;
}

const TOP_KEYS = [
  'adapterId', 'adapterVersion', 'connectionGeneration', 'enrollmentId', 'ideInstanceId',
  'ideProduct', 'runtimeInstanceId', 'sessionId', 'version', 'workspace',
] as const;
const WORKSPACE_KEYS = [
  'canonicalPath', 'canonicalization', 'caseMode', 'environmentIdentity', 'filesystemIdentity',
  'git', 'pathFlavor', 'remoteKind', 'workspaceFolderCount', 'workspaceUri',
] as const;
const GIT_NONE_KEYS = ['kind'] as const;
const GIT_WORKTREE_KEYS = ['commonDir', 'commonDirIdentity', 'headRevision', 'kind', 'worktreeRoot'] as const;

function fail(code: IdeWorkspaceAttestationErrorCode, message: string): never {
  throw new IdeWorkspaceAttestationError(code, message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function oneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}
function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const got = Object.keys(record).sort();
  const want = [...expected].sort();
  if (got.length !== want.length || got.some((key, i) => key !== want[i])) {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspace attestation fields are invalid');
  }
}
function boundedUtf8(value: unknown, max: number, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max || value.includes('\0')) {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', `${field} is invalid`);
  }
}
function hashParts(domain: string, parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify([domain, ...parts]), 'utf8').digest('hex');
}

export function deriveIdeFilesystemIdentity(
  pathFlavor: IdeWorkspacePathFlavor,
  deviceId: string,
  fileId: string,
): string {
  if (!oneOf(pathFlavor, IDE_WORKSPACE_PATH_FLAVORS) || !DECIMAL_ID.test(deviceId) || !DECIMAL_ID.test(fileId)) {
    fail('IDE_WORKSPACE_IDENTITY_INVALID', 'filesystem identity inputs are invalid');
  }
  return hashParts(FILESYSTEM_DOMAIN, [pathFlavor, deviceId, fileId]);
}

export function deriveIdeEnvironmentIdentity(remoteKind: IdeWorkspaceRemoteKind, stableIdentity: string): string {
  if (!oneOf(remoteKind, IDE_WORKSPACE_REMOTE_KINDS)) {
    fail('IDE_WORKSPACE_IDENTITY_INVALID', 'remote kind is unsupported');
  }
  boundedUtf8(stableIdentity, 1024, 'stableIdentity');
  return hashParts(ENVIRONMENT_DOMAIN, [remoteKind, stableIdentity]);
}

function validateCanonicalPath(path: string, flavor: IdeWorkspacePathFlavor, field: string): void {
  boundedUtf8(path, IDE_WORKSPACE_MAX_PATH_BYTES, field);
  if (flavor === 'posix') {
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.includes('\\') || path === '/') {
      fail('IDE_WORKSPACE_INVALID_SCHEMA', `${field} is not a canonical non-root POSIX path`);
    }
    return;
  }
  if (!win32.isAbsolute(path) || win32.normalize(path) !== path || path.includes('/') || !/^[A-Z]:\\/.test(path) || /^[\\]{2}/.test(path)) {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', `${field} is not a canonical local Win32 drive path`);
  }
  if (/^[A-Z]:\\$/.test(path)) fail('IDE_WORKSPACE_INVALID_SCHEMA', `${field} must not be a drive root`);
}

function validateFileUri(uri: string, canonicalPath: string, flavor: IdeWorkspacePathFlavor): void {
  boundedUtf8(uri, IDE_WORKSPACE_MAX_URI_BYTES, 'workspaceUri');
  let parsed: URL;
  try { parsed = new URL(uri); } catch { fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspaceUri is not an absolute URI'); }
  if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.hostname || parsed.search || parsed.hash) {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspaceUri must be a local canonical file URI without authority/query/fragment');
  }
  let decoded: string;
  try { decoded = fileURLToPath(parsed, { windows: flavor === 'win32' }); }
  catch { fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspaceUri cannot be decoded for the declared path flavor'); }
  if (decoded !== canonicalPath || pathToFileURL(canonicalPath, { windows: flavor === 'win32' }).href !== uri) {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspaceUri and canonicalPath are not one exact canonical identity');
  }
}

export function validateIdeWorkspacePhysicalIdentity(workspace: IdeWorkspacePhysicalIdentity): void {
  if (!isRecord(workspace)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspace evidence must be an object');
  exactKeys(workspace as unknown as Record<string, unknown>, WORKSPACE_KEYS);
  if (workspace.workspaceFolderCount !== 1) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'exactly one workspace folder is required');
  if (!oneOf(workspace.remoteKind, IDE_WORKSPACE_REMOTE_KINDS)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'remoteKind is unsupported');
  if (!SHA256.test(workspace.environmentIdentity)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'environmentIdentity is invalid');
  if (!oneOf(workspace.pathFlavor, IDE_WORKSPACE_PATH_FLAVORS)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'pathFlavor is unsupported');
  if (!oneOf(workspace.caseMode, IDE_WORKSPACE_CASE_MODES)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'caseMode is unsupported');
  if (workspace.canonicalization !== 'realpath-exact') fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspace path is not proven exact after realpath canonicalization');
  if (workspace.remoteKind !== 'local' && workspace.pathFlavor !== 'posix') {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', 'current remote workspace kinds require POSIX path evidence');
  }
  validateCanonicalPath(workspace.canonicalPath, workspace.pathFlavor, 'canonicalPath');
  validateFileUri(workspace.workspaceUri, workspace.canonicalPath, workspace.pathFlavor);
  if (!SHA256.test(workspace.filesystemIdentity)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'filesystemIdentity is invalid');

  if (!isRecord(workspace.git)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'git evidence must be an object');
  if (workspace.git.kind === 'none') {
    exactKeys(workspace.git as unknown as Record<string, unknown>, GIT_NONE_KEYS);
    return;
  }
  if (workspace.git.kind !== 'worktree') fail('IDE_WORKSPACE_INVALID_SCHEMA', 'git kind is unsupported');
  exactKeys(workspace.git as unknown as Record<string, unknown>, GIT_WORKTREE_KEYS);
  validateCanonicalPath(workspace.git.worktreeRoot, workspace.pathFlavor, 'git.worktreeRoot');
  validateCanonicalPath(workspace.git.commonDir, workspace.pathFlavor, 'git.commonDir');
  if (workspace.git.worktreeRoot !== workspace.canonicalPath) {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspace must be the exact Git worktree root');
  }
  if (!SHA256.test(workspace.git.commonDirIdentity)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'git.commonDirIdentity is invalid');
  if (!GIT_REVISION.test(workspace.git.headRevision)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'git.headRevision is invalid');
}

export function validateIdeWorkspaceAttestation(attestation: IdeWorkspaceAttestation): void {
  if (!isRecord(attestation)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspace attestation must be an object');
  exactKeys(attestation as unknown as Record<string, unknown>, TOP_KEYS);
  if (attestation.version !== IDE_WORKSPACE_ATTESTATION_VERSION) {
    fail('IDE_WORKSPACE_UNSUPPORTED_VERSION', 'workspace attestation version is unsupported');
  }
  try {
    assertIdeEnrollmentId(attestation.enrollmentId);
    assertIdeInstanceId(attestation.ideInstanceId);
    assertIdeProduct(attestation.ideProduct);
    assertIdeSessionId(attestation.sessionId);
    assertIdeConnectionGeneration(attestation.connectionGeneration);
  } catch { fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspace attestation logical identity is invalid'); }
  if (!IDE_WORKSPACE_RUNTIME_ID_PATTERN.test(attestation.runtimeInstanceId)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'runtimeInstanceId is invalid');
  if (!IDE_WORKSPACE_ADAPTER_ID_PATTERN.test(attestation.adapterId)) fail('IDE_WORKSPACE_INVALID_SCHEMA', 'adapterId is invalid');
  if (typeof attestation.adapterVersion !== 'string' || attestation.adapterVersion.length > 64 || !SEMVER.test(attestation.adapterVersion)) {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', 'adapterVersion is invalid');
  }
  validateIdeWorkspacePhysicalIdentity(attestation.workspace);
}

function canonicalGit(git: IdeWorkspaceGitIdentity): Record<string, unknown> {
  if (git.kind === 'none') return { kind: 'none' };
  return {
    commonDir: git.commonDir,
    commonDirIdentity: git.commonDirIdentity,
    headRevision: git.headRevision,
    kind: 'worktree',
    worktreeRoot: git.worktreeRoot,
  };
}

export function serializeIdeWorkspaceAttestation(attestation: IdeWorkspaceAttestation): string {
  validateIdeWorkspaceAttestation(attestation);
  return JSON.stringify({
    adapterId: attestation.adapterId,
    adapterVersion: attestation.adapterVersion,
    connectionGeneration: attestation.connectionGeneration,
    enrollmentId: attestation.enrollmentId,
    ideInstanceId: attestation.ideInstanceId,
    ideProduct: attestation.ideProduct,
    runtimeInstanceId: attestation.runtimeInstanceId,
    sessionId: attestation.sessionId,
    version: attestation.version,
    workspace: {
      canonicalPath: attestation.workspace.canonicalPath,
      canonicalization: attestation.workspace.canonicalization,
      caseMode: attestation.workspace.caseMode,
      environmentIdentity: attestation.workspace.environmentIdentity,
      filesystemIdentity: attestation.workspace.filesystemIdentity,
      git: canonicalGit(attestation.workspace.git),
      pathFlavor: attestation.workspace.pathFlavor,
      remoteKind: attestation.workspace.remoteKind,
      workspaceFolderCount: attestation.workspace.workspaceFolderCount,
      workspaceUri: attestation.workspace.workspaceUri,
    },
  });
}

export function parseIdeWorkspaceAttestation(payload: Uint8Array | string): IdeWorkspaceAttestation {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (bytes.byteLength === 0 || bytes.byteLength > IDE_WORKSPACE_ATTESTATION_MAX_BYTES) {
    fail('IDE_WORKSPACE_FRAME_SIZE', 'workspace attestation payload size is invalid');
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('IDE_WORKSPACE_INVALID_JSON', 'workspace attestation is not valid UTF-8'); }
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { fail('IDE_WORKSPACE_INVALID_JSON', 'workspace attestation is not valid JSON'); }
  const attestation = raw as IdeWorkspaceAttestation;
  validateIdeWorkspaceAttestation(attestation);
  if (serializeIdeWorkspaceAttestation(attestation) !== text) {
    fail('IDE_WORKSPACE_INVALID_SCHEMA', 'workspace attestation must use exact canonical JSON encoding');
  }
  return attestation;
}

export function deriveIdeWorkspaceFingerprint(input: {
  projectId: string;
  worktreeId: string;
  workspace: IdeWorkspacePhysicalIdentity;
}): string {
  try { assertIdeLogicalId(input.projectId, 'projectId'); assertIdeLogicalId(input.worktreeId, 'worktreeId'); }
  catch { fail('IDE_WORKSPACE_IDENTITY_INVALID', 'trusted project/worktree identity is invalid'); }
  validateIdeWorkspacePhysicalIdentity(input.workspace);
  const git = input.workspace.git;
  return hashParts(FINGERPRINT_DOMAIN, [
    input.projectId,
    input.worktreeId,
    input.workspace.remoteKind,
    input.workspace.environmentIdentity,
    input.workspace.pathFlavor,
    input.workspace.caseMode,
    input.workspace.canonicalization,
    input.workspace.workspaceUri,
    input.workspace.canonicalPath,
    input.workspace.filesystemIdentity,
    git.kind,
    git.kind === 'worktree' ? git.worktreeRoot : null,
    git.kind === 'worktree' ? git.commonDir : null,
    git.kind === 'worktree' ? git.commonDirIdentity : null,
  ]);
}
