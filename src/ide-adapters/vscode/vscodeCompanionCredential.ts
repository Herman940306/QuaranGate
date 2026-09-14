/**
 * I2.1 VS Code companion bootstrap credential reader.
 *
 * The credential path is installation/enrollment bootstrap input only. It is
 * not operation authority. The B6 server re-authenticates runtime, enrollment,
 * IDE instance and workspace before any Plane-B session becomes AVAILABLE.
 */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { IDE_ENROLLMENT_ID_PATTERN, IDE_INSTANCE_ID_PATTERN } from '../../shared/ideSessions.js';
import { IDE_WORKSPACE_RUNTIME_ID_PATTERN } from '../../shared/ideWorkspaceAttestation.js';

export const VSCODE_COMPANION_CREDENTIAL_VERSION = 1 as const;
export const VSCODE_COMPANION_ADAPTER_ID = 'quarangate-vscode-companion' as const;
export const VSCODE_COMPANION_CREDENTIAL_BASENAME = 'credential.json';
export const VSCODE_COMPANION_SOCKET_BASENAME = 'companion.sock';
export const VSCODE_COMPANION_MAX_CREDENTIAL_BYTES = 4096;
export const VSCODE_COMPANION_MAX_SOCKET_PATH_BYTES = 100;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const ACTIVE_KEYS = [
  'adapterId', 'adapterVersion', 'enrollmentId', 'ideInstanceId', 'ideProduct',
  'runtimeInstanceId', 'secret', 'secretGeneration', 'socketPath', 'state', 'version',
] as const;

export type VsCodeCompanionCredentialErrorCode =
  | 'VSCODE_CREDENTIAL_PATH_INVALID'
  | 'VSCODE_CREDENTIAL_FILE_INVALID'
  | 'VSCODE_CREDENTIAL_SCHEMA_INVALID'
  | 'VSCODE_CREDENTIAL_REVOKED'
  | 'VSCODE_CREDENTIAL_VERSION_MISMATCH';

export class VsCodeCompanionCredentialError extends Error {
  constructor(public readonly code: VsCodeCompanionCredentialErrorCode, message: string) {
    super(message);
    this.name = 'VsCodeCompanionCredentialError';
  }
}

export interface VsCodeCompanionCredential {
  version: typeof VSCODE_COMPANION_CREDENTIAL_VERSION;
  state: 'ACTIVE';
  runtimeInstanceId: string;
  enrollmentId: string;
  ideInstanceId: string;
  ideProduct: 'vscode';
  adapterId: typeof VSCODE_COMPANION_ADAPTER_ID;
  adapterVersion: string;
  secretGeneration: number;
  socketPath: string;
  secret: Buffer;
  credentialPath: string;
}

function fail(code: VsCodeCompanionCredentialErrorCode, message: string): never {
  throw new VsCodeCompanionCredentialError(code, message);
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) fail('VSCODE_CREDENTIAL_PATH_INVALID', 'VS Code companion requires Unix user identity');
  return uid;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const got = Object.keys(value).sort();
  const want = [...expected].sort();
  if (got.length !== want.length || got.some((key, index) => key !== want[index])) {
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential fields are invalid');
  }
}

function assertSafeAncestorChain(path: string): void {
  let current = dirname(path);
  for (;;) {
    let info;
    try { info = lstatSync(current); } catch { fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime ancestor is unavailable'); }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime ancestor must be a real directory');
    const writableByOthers = (info.mode & 0o022) !== 0;
    const sticky = (info.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime ancestor is writable by another Unix identity without sticky protection');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function validateCanonicalDirectory(path: string): void {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes('\0')) {
    fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime directory must be an absolute normalized path');
  }
  let info;
  try { info = lstatSync(path); } catch { fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime directory is unavailable'); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o777) !== 0o700) {
    fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime directory ownership/type/mode is unsafe');
  }
  let canonical: string;
  try { canonical = realpathSync(path); } catch { fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime directory cannot be canonicalized'); }
  if (canonical !== path) fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime directory contains a symbolic-link component');
  assertSafeAncestorChain(path);
}

function readCredentialFile(path: string): string {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes('\0') || basename(path) !== VSCODE_COMPANION_CREDENTIAL_BASENAME) {
    fail('VSCODE_CREDENTIAL_PATH_INVALID', 'credential path must be the exact absolute credential.json path');
  }
  const directory = dirname(path);
  const runtimeRoot = dirname(directory);
  validateCanonicalDirectory(runtimeRoot);
  validateCanonicalDirectory(directory);
  if (!IDE_WORKSPACE_RUNTIME_ID_PATTERN.test(basename(directory))) {
    fail('VSCODE_CREDENTIAL_PATH_INVALID', 'credential parent is not a QuaranGate runtime instance');
  }
  let outer;
  try { outer = lstatSync(path); } catch { fail('VSCODE_CREDENTIAL_FILE_INVALID', 'runtime credential is unavailable'); }
  if (!outer.isFile() || outer.isSymbolicLink() || outer.uid !== currentUid() || (outer.mode & 0o777) !== 0o600
    || outer.size <= 1 || outer.size > VSCODE_COMPANION_MAX_CREDENTIAL_BYTES) {
    fail('VSCODE_CREDENTIAL_FILE_INVALID', 'runtime credential ownership/type/mode/size is unsafe');
  }
  let canonical: string;
  try { canonical = realpathSync(path); } catch { fail('VSCODE_CREDENTIAL_FILE_INVALID', 'runtime credential cannot be canonicalized'); }
  if (canonical !== path) fail('VSCODE_CREDENTIAL_FILE_INVALID', 'runtime credential contains a symbolic-link component');

  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const inner = fstatSync(fd);
    if (!inner.isFile() || inner.uid !== currentUid() || (inner.mode & 0o777) !== 0o600
      || inner.size <= 1 || inner.size > VSCODE_COMPANION_MAX_CREDENTIAL_BYTES) {
      fail('VSCODE_CREDENTIAL_FILE_INVALID', 'runtime credential changed while opening');
    }
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function canonicalBody(value: {
  adapterId: string; adapterVersion: string; enrollmentId: string; ideInstanceId: string; ideProduct: string;
  runtimeInstanceId: string; secret: string; secretGeneration: number; socketPath: string; state: string; version: number;
}): string {
  return JSON.stringify({
    adapterId: value.adapterId,
    adapterVersion: value.adapterVersion,
    enrollmentId: value.enrollmentId,
    ideInstanceId: value.ideInstanceId,
    ideProduct: value.ideProduct,
    runtimeInstanceId: value.runtimeInstanceId,
    secret: value.secret,
    secretGeneration: value.secretGeneration,
    socketPath: value.socketPath,
    state: value.state,
    version: value.version,
  });
}

export function readVsCodeCompanionCredential(path: string, expectedAdapterVersion: string): VsCodeCompanionCredential {
  if (!SEMVER.test(expectedAdapterVersion) || expectedAdapterVersion.length > 64) {
    fail('VSCODE_CREDENTIAL_VERSION_MISMATCH', 'expected adapter version is invalid');
  }
  const raw = readCredentialFile(path);
  if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n')) {
    fail('VSCODE_CREDENTIAL_FILE_INVALID', 'runtime credential framing is invalid');
  }
  const body = raw.slice(0, -1);
  let value: unknown;
  try { value = JSON.parse(body) as unknown; } catch { fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential is invalid JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential must be an object');
  }
  const row = value as Record<string, unknown>;
  if (row.state === 'REVOKED') fail('VSCODE_CREDENTIAL_REVOKED', 'runtime credential is revoked');
  if (row.state !== 'ACTIVE') fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential state is invalid');
  exactKeys(row, ACTIVE_KEYS);

  if (row.version !== VSCODE_COMPANION_CREDENTIAL_VERSION) fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential version is unsupported');
  if (row.ideProduct !== 'vscode' || row.adapterId !== VSCODE_COMPANION_ADAPTER_ID) {
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential is not bound to the VS Code companion');
  }
  if (typeof row.runtimeInstanceId !== 'string' || !IDE_WORKSPACE_RUNTIME_ID_PATTERN.test(row.runtimeInstanceId)
    || typeof row.enrollmentId !== 'string' || !IDE_ENROLLMENT_ID_PATTERN.test(row.enrollmentId)
    || typeof row.ideInstanceId !== 'string' || !IDE_INSTANCE_ID_PATTERN.test(row.ideInstanceId)) {
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential identity is invalid');
  }
  if (typeof row.adapterVersion !== 'string' || row.adapterVersion.length > 64 || !SEMVER.test(row.adapterVersion) || row.adapterVersion !== expectedAdapterVersion) {
    fail('VSCODE_CREDENTIAL_VERSION_MISMATCH', 'runtime credential adapter version does not match this extension build');
  }
  if (!Number.isSafeInteger(row.secretGeneration) || (row.secretGeneration as number) < 1) {
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential secret generation is invalid');
  }
  if (typeof row.secret !== 'string' || !SECRET.test(row.secret)) {
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential secret encoding is invalid');
  }
  const secret = Buffer.from(row.secret, 'base64url');
  if (secret.byteLength !== 32 || secret.toString('base64url') !== row.secret) {
    secret.fill(0);
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential secret is not canonical 256-bit base64url');
  }

  const directory = dirname(path);
  if (basename(directory) !== row.runtimeInstanceId) {
    secret.fill(0);
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime instance does not match credential directory');
  }
  const expectedSocket = join(directory, VSCODE_COMPANION_SOCKET_BASENAME);
  if (Buffer.byteLength(expectedSocket, 'utf8') > VSCODE_COMPANION_MAX_SOCKET_PATH_BYTES) {
    secret.fill(0);
    fail('VSCODE_CREDENTIAL_PATH_INVALID', 'runtime socket path exceeds the qualified Unix-domain bound');
  }
  if (row.socketPath !== expectedSocket) {
    secret.fill(0);
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential socket path is not QuaranGate-derived');
  }
  if (canonicalBody(row as Parameters<typeof canonicalBody>[0]) !== body) {
    secret.fill(0);
    fail('VSCODE_CREDENTIAL_SCHEMA_INVALID', 'runtime credential is not canonical JSON');
  }

  return {
    version: 1,
    state: 'ACTIVE',
    runtimeInstanceId: row.runtimeInstanceId,
    enrollmentId: row.enrollmentId,
    ideInstanceId: row.ideInstanceId,
    ideProduct: 'vscode',
    adapterId: VSCODE_COMPANION_ADAPTER_ID,
    adapterVersion: row.adapterVersion,
    secretGeneration: row.secretGeneration as number,
    socketPath: row.socketPath as string,
    secret,
    credentialPath: path,
  };
}
