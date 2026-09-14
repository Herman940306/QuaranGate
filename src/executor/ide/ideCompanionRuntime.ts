/**
 * Trusted local runtime-material foundation for IDE companion IPC (P7 B4).
 *
 * Source-only. This module allocates no listener and performs no provider,
 * workspace, project or writer operation. It owns only QuaranGate-generated
 * runtime identity, owner-only credential material and fixed local endpoint
 * paths beneath a trusted runtime root.
 */
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  assertIdeEnrollmentId,
  assertIdeInstanceId,
  assertIdeProduct,
  type IdeProductId,
} from '../../shared/ideSessions.js';
import {
  IDE_COMPANION_MIN_SECRET_BYTES,
  IDE_COMPANION_MAX_SECRET_BYTES,
} from '../../shared/ideCompanionAuth.js';

export const IDE_COMPANION_RUNTIME_CREDENTIAL_VERSION = 1 as const;
export const IDE_COMPANION_RUNTIME_INSTANCE_PATTERN = /^iderun_[0-9a-f]{32}$/;
export const IDE_COMPANION_RUNTIME_DIRECTORY_MODE = 0o700;
export const IDE_COMPANION_RUNTIME_FILE_MODE = 0o600;
export const IDE_COMPANION_RUNTIME_SECRET_BYTES = 32;
export const IDE_COMPANION_RUNTIME_MAX_CREDENTIAL_BYTES = 4096;
export const IDE_COMPANION_RUNTIME_MAX_SOCKET_PATH_BYTES = 100;
export const IDE_COMPANION_RUNTIME_CREDENTIAL_BASENAME = 'credential.json';
export const IDE_COMPANION_RUNTIME_SOCKET_BASENAME = 'companion.sock';

export const IDE_COMPANION_ADAPTER_IDS = {
  vscode: 'quarangate-vscode-companion',
  kiro: 'quarangate-kiro-companion',
  cursor: 'quarangate-cursor-companion',
  'visual-studio': 'quarangate-visual-studio-companion',
  antigravity: 'quarangate-antigravity-companion',
} as const satisfies Record<IdeProductId, string>;

export type IdeCompanionAdapterId = (typeof IDE_COMPANION_ADAPTER_IDS)[IdeProductId];
export type IdeCompanionRuntimeState = 'ACTIVE' | 'REVOKED';

export type IdeCompanionRuntimeErrorCode =
  | 'IDE_RUNTIME_UNSUPPORTED_OS'
  | 'IDE_RUNTIME_ROOT_INVALID'
  | 'IDE_RUNTIME_PATH_UNSAFE'
  | 'IDE_RUNTIME_CREDENTIAL_INVALID'
  | 'IDE_RUNTIME_CREDENTIAL_REVOKED'
  | 'IDE_RUNTIME_BINDING_MISMATCH'
  | 'IDE_RUNTIME_SECRET_GENERATION_EXHAUSTED'
  | 'IDE_RUNTIME_SOCKET_INVALID';

export class IdeCompanionRuntimeError extends Error {
  constructor(public readonly code: IdeCompanionRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'IdeCompanionRuntimeError';
  }
}

export interface NewIdeCompanionRuntime {
  /** Trusted executor/config path. Never accept this from an IDE/MCP request. */
  runtimeRoot: string;
  enrollmentId: string;
  ideInstanceId: string;
  ideProduct: IdeProductId;
  /** Trusted exact adapter build version. Compatibility admission is later. */
  adapterVersion: string;
  /** Trusted durable provisioning identity. Omit only for ephemeral/test allocation. */
  runtimeInstanceId?: string;
}

export interface IdeCompanionRuntimeRef {
  runtimeRoot: string;
  runtimeInstanceId: string;
  directory: string;
  credentialPath: string;
  socketPath: string;
  enrollmentId: string;
  ideInstanceId: string;
  ideProduct: IdeProductId;
  adapterId: IdeCompanionAdapterId;
  adapterVersion: string;
}

export interface IdeCompanionSecretMaterial {
  secret: Buffer;
  secretGeneration: number;
}

interface ActiveRuntimeCredential {
  version: typeof IDE_COMPANION_RUNTIME_CREDENTIAL_VERSION;
  state: 'ACTIVE';
  runtimeInstanceId: string;
  enrollmentId: string;
  ideInstanceId: string;
  ideProduct: IdeProductId;
  adapterId: IdeCompanionAdapterId;
  adapterVersion: string;
  secretGeneration: number;
  socketPath: string;
  secret: string;
}

interface RevokedRuntimeCredential {
  version: typeof IDE_COMPANION_RUNTIME_CREDENTIAL_VERSION;
  state: 'REVOKED';
  runtimeInstanceId: string;
  enrollmentId: string;
  ideInstanceId: string;
  ideProduct: IdeProductId;
  adapterId: IdeCompanionAdapterId;
  adapterVersion: string;
  secretGeneration: number;
  socketPath: string;
}

type RuntimeCredential = ActiveRuntimeCredential | RevokedRuntimeCredential;

export const IDE_COMPANION_ADAPTER_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACTIVE_KEYS = [
  'adapterId', 'adapterVersion', 'enrollmentId', 'ideInstanceId', 'ideProduct',
  'runtimeInstanceId', 'secret', 'secretGeneration', 'socketPath', 'state', 'version',
] as const;
const REVOKED_KEYS = [
  'adapterId', 'adapterVersion', 'enrollmentId', 'ideInstanceId', 'ideProduct',
  'runtimeInstanceId', 'secretGeneration', 'socketPath', 'state', 'version',
] as const;

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_UNSUPPORTED_OS', 'IDE companion runtime requires Unix user identity');
  }
  return uid;
}

function validateAdapterVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 64 || !IDE_COMPANION_ADAPTER_VERSION_PATTERN.test(value)) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'adapterVersion is invalid');
  }
}

function validateRuntimeInstanceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IDE_COMPANION_RUNTIME_INSTANCE_PATTERN.test(value)) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtimeInstanceId is invalid');
  }
}

function validateSecretGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'secretGeneration is invalid');
  }
}

function expectedAdapterId(product: IdeProductId): IdeCompanionAdapterId {
  return IDE_COMPANION_ADAPTER_IDS[product];
}

function assertSafeAncestorChain(path: string, code: IdeCompanionRuntimeErrorCode): void {
  let current = dirname(path);
  for (;;) {
    let info;
    try { info = lstatSync(current); } catch {
      throw new IdeCompanionRuntimeError(code, 'runtime directory ancestor is unavailable');
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new IdeCompanionRuntimeError(code, 'runtime directory ancestor must be a real directory');
    }
    const writableByOthers = (info.mode & 0o022) !== 0;
    const sticky = (info.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new IdeCompanionRuntimeError(code, 'runtime directory ancestor is writable by another Unix identity without sticky protection');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertCanonicalOwnerOnlyDirectory(path: string, code: IdeCompanionRuntimeErrorCode): void {
  if (!isAbsolute(path) || path.includes('\0') || path !== resolve(path)) {
    throw new IdeCompanionRuntimeError(code, 'runtime directory path must be an absolute canonical trusted path');
  }
  let info;
  try { info = lstatSync(path); } catch {
    throw new IdeCompanionRuntimeError(code, 'runtime directory is unavailable');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new IdeCompanionRuntimeError(code, 'runtime directory must be a real directory');
  }
  if (info.uid !== currentUid()) {
    throw new IdeCompanionRuntimeError(code, 'runtime directory owner is not the current Unix user');
  }
  if ((info.mode & 0o777) !== IDE_COMPANION_RUNTIME_DIRECTORY_MODE) {
    throw new IdeCompanionRuntimeError(code, 'runtime directory permissions must be exactly 0700');
  }
  let canonical: string;
  try { canonical = realpathSync(path); } catch {
    throw new IdeCompanionRuntimeError(code, 'runtime directory cannot be canonicalized');
  }
  if (canonical !== path) {
    throw new IdeCompanionRuntimeError(code, 'runtime directory path contains a symbolic-link component');
  }
  assertSafeAncestorChain(path, code);
}

export function assertTrustedIdeCompanionRuntimeRoot(runtimeRoot: string): void {
  assertCanonicalOwnerOnlyDirectory(runtimeRoot, 'IDE_RUNTIME_ROOT_INVALID');
}

/** Validate one trusted runtime reference without reading or exposing its secret. */
export function assertIdeCompanionRuntimeRef(ref: IdeCompanionRuntimeRef): void {
  assertRuntimeRef(ref);
}

function assertRuntimeRef(ref: IdeCompanionRuntimeRef): void {
  assertTrustedIdeCompanionRuntimeRoot(ref.runtimeRoot);
  validateRuntimeInstanceId(ref.runtimeInstanceId);
  try {
    assertIdeEnrollmentId(ref.enrollmentId);
    assertIdeInstanceId(ref.ideInstanceId);
    assertIdeProduct(ref.ideProduct);
  } catch {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime logical identity is invalid');
  }
  validateAdapterVersion(ref.adapterVersion);
  if (ref.adapterId !== expectedAdapterId(ref.ideProduct)) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime adapter identity does not match IDE product');
  }
  const expectedDirectory = join(ref.runtimeRoot, ref.runtimeInstanceId);
  const expectedCredential = join(expectedDirectory, IDE_COMPANION_RUNTIME_CREDENTIAL_BASENAME);
  const expectedSocket = join(expectedDirectory, IDE_COMPANION_RUNTIME_SOCKET_BASENAME);
  if (ref.directory !== expectedDirectory || ref.credentialPath !== expectedCredential || ref.socketPath !== expectedSocket) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_PATH_UNSAFE', 'runtime paths do not match QuaranGate-derived locations');
  }
  if (Buffer.byteLength(ref.socketPath, 'utf8') > IDE_COMPANION_RUNTIME_MAX_SOCKET_PATH_BYTES) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_PATH_UNSAFE', 'runtime socket path exceeds the conservative Unix-domain limit');
  }
  assertCanonicalOwnerOnlyDirectory(ref.directory, 'IDE_RUNTIME_PATH_UNSAFE');
}

function validateCredentialStat(info: Stats): void {
  if (!info.isFile()) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential must be a regular non-symlink file');
  }
  if (info.uid !== currentUid()) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential owner is invalid');
  }
  if ((info.mode & 0o777) !== IDE_COMPANION_RUNTIME_FILE_MODE) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential permissions must be exactly 0600');
  }
  if (info.size <= 1 || info.size > IDE_COMPANION_RUNTIME_MAX_CREDENTIAL_BYTES) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential size is invalid');
  }
}

function assertCredentialFile(path: string): void {
  let info;
  try { info = lstatSync(path); } catch {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential file is unavailable');
  }
  if (info.isSymbolicLink()) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential must be a regular non-symlink file');
  }
  validateCredentialStat(info);
}

function readCredentialFile(path: string): string {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try { fd = openSync(path, flags); } catch {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential file cannot be opened safely');
  }
  try {
    validateCredentialStat(fstatSync(fd));
    const raw = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > IDE_COMPANION_RUNTIME_MAX_CREDENTIAL_BYTES) {
      throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential size changed while reading');
    }
    return raw;
  } finally { closeSync(fd); }
}

function encodeCredential(record: RuntimeCredential): string {
  if (record.state === 'ACTIVE') {
    return JSON.stringify({
      adapterId: record.adapterId,
      adapterVersion: record.adapterVersion,
      enrollmentId: record.enrollmentId,
      ideInstanceId: record.ideInstanceId,
      ideProduct: record.ideProduct,
      runtimeInstanceId: record.runtimeInstanceId,
      secret: record.secret,
      secretGeneration: record.secretGeneration,
      socketPath: record.socketPath,
      state: record.state,
      version: record.version,
    });
  }
  return JSON.stringify({
    adapterId: record.adapterId,
    adapterVersion: record.adapterVersion,
    enrollmentId: record.enrollmentId,
    ideInstanceId: record.ideInstanceId,
    ideProduct: record.ideProduct,
    runtimeInstanceId: record.runtimeInstanceId,
    secretGeneration: record.secretGeneration,
    socketPath: record.socketPath,
    state: record.state,
    version: record.version,
  });
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const got = Object.keys(value).sort();
  const want = [...expected].sort();
  if (got.length !== want.length || got.some((key, index) => key !== want[index])) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential fields are invalid');
  }
}

function parseCredential(ref: IdeCompanionRuntimeRef): RuntimeCredential {
  assertRuntimeRef(ref);
  assertCredentialFile(ref.credentialPath);
  const raw = readCredentialFile(ref.credentialPath);
  if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n')) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential framing is invalid');
  }
  const body = raw.slice(0, -1);
  let value: unknown;
  try { value = JSON.parse(body) as unknown; } catch {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential is invalid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential must be an object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.state !== 'ACTIVE' && obj.state !== 'REVOKED') {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential state is invalid');
  }
  assertExactKeys(obj, obj.state === 'ACTIVE' ? ACTIVE_KEYS : REVOKED_KEYS);
  if (obj.version !== IDE_COMPANION_RUNTIME_CREDENTIAL_VERSION) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential version is unsupported');
  }
  validateRuntimeInstanceId(obj.runtimeInstanceId);
  validateAdapterVersion(obj.adapterVersion);
  validateSecretGeneration(obj.secretGeneration);
  try {
    assertIdeEnrollmentId(obj.enrollmentId);
    assertIdeInstanceId(obj.ideInstanceId);
    assertIdeProduct(obj.ideProduct);
  } catch {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential identity is invalid');
  }
  const product = obj.ideProduct as IdeProductId;
  if (obj.adapterId !== expectedAdapterId(product)) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential adapter identity is invalid');
  }
  const exact: Array<[unknown, unknown]> = [
    [obj.runtimeInstanceId, ref.runtimeInstanceId],
    [obj.enrollmentId, ref.enrollmentId],
    [obj.ideInstanceId, ref.ideInstanceId],
    [obj.ideProduct, ref.ideProduct],
    [obj.adapterId, ref.adapterId],
    [obj.adapterVersion, ref.adapterVersion],
    [obj.socketPath, ref.socketPath],
  ];
  if (exact.some(([got, expected]) => got !== expected)) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential does not match its trusted runtime reference');
  }
  if (obj.state === 'ACTIVE') {
    if (typeof obj.secret !== 'string' || !SECRET_PATTERN.test(obj.secret)) {
      throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential secret encoding is invalid');
    }
    const secret = Buffer.from(obj.secret, 'base64url');
    if (secret.byteLength !== IDE_COMPANION_RUNTIME_SECRET_BYTES
      || secret.byteLength < IDE_COMPANION_MIN_SECRET_BYTES
      || secret.byteLength > IDE_COMPANION_MAX_SECRET_BYTES) {
      throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential secret length is invalid');
    }
  }
  const record = obj as unknown as RuntimeCredential;
  if (encodeCredential(record) !== body) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential encoding is not canonical');
  }
  return record;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeExclusive(path: string, body: string): void {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, IDE_COMPANION_RUNTIME_FILE_MODE);
  try {
    fchmodSync(fd, IDE_COMPANION_RUNTIME_FILE_MODE);
    const bytes = Buffer.from(`${body}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime credential write made no progress');
      }
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function replaceCredentialAtomically(ref: IdeCompanionRuntimeRef, record: RuntimeCredential): void {
  assertRuntimeRef(ref);
  assertCredentialFile(ref.credentialPath);
  const temp = join(ref.directory, `.credential-${randomBytes(12).toString('hex')}.tmp`);
  try {
    writeExclusive(temp, encodeCredential(record));
    assertCredentialFile(temp);
    renameSync(temp, ref.credentialPath);
    chmodSync(ref.credentialPath, IDE_COMPANION_RUNTIME_FILE_MODE);
    assertCredentialFile(ref.credentialPath);
    fsyncDirectory(ref.directory);
  } catch (error) {
    if (existsSync(temp)) {
      try {
        const info = lstatSync(temp);
        if (info.isFile() && !info.isSymbolicLink() && info.uid === currentUid()) rmSync(temp);
      } catch { /* retain unknown path fail-safe */ }
    }
    throw error;
  }
}

function newSecret(): string {
  return randomBytes(IDE_COMPANION_RUNTIME_SECRET_BYTES).toString('base64url');
}

function nextSecretGeneration(current: number): number {
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_SECRET_GENERATION_EXHAUSTED', 'runtime secret generation exhausted');
  }
  return next;
}

export function createIdeCompanionRuntime(input: NewIdeCompanionRuntime): IdeCompanionRuntimeRef {
  assertTrustedIdeCompanionRuntimeRoot(input.runtimeRoot);
  try {
    assertIdeEnrollmentId(input.enrollmentId);
    assertIdeInstanceId(input.ideInstanceId);
    assertIdeProduct(input.ideProduct);
  } catch {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime enrollment/IDE identity is invalid');
  }
  validateAdapterVersion(input.adapterVersion);

  const runtimeInstanceId = input.runtimeInstanceId ?? `iderun_${randomBytes(16).toString('hex')}`;
  validateRuntimeInstanceId(runtimeInstanceId);
  const directory = join(input.runtimeRoot, runtimeInstanceId);
  const credentialPath = join(directory, IDE_COMPANION_RUNTIME_CREDENTIAL_BASENAME);
  const socketPath = join(directory, IDE_COMPANION_RUNTIME_SOCKET_BASENAME);
  if (Buffer.byteLength(socketPath, 'utf8') > IDE_COMPANION_RUNTIME_MAX_SOCKET_PATH_BYTES) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_PATH_UNSAFE', 'runtime socket path exceeds the conservative Unix-domain limit');
  }

  mkdirSync(directory, { mode: IDE_COMPANION_RUNTIME_DIRECTORY_MODE });
  try {
    chmodSync(directory, IDE_COMPANION_RUNTIME_DIRECTORY_MODE);
    const ref: IdeCompanionRuntimeRef = {
      runtimeRoot: input.runtimeRoot,
      runtimeInstanceId,
      directory,
      credentialPath,
      socketPath,
      enrollmentId: input.enrollmentId,
      ideInstanceId: input.ideInstanceId,
      ideProduct: input.ideProduct,
      adapterId: expectedAdapterId(input.ideProduct),
      adapterVersion: input.adapterVersion,
    };
    assertRuntimeRef(ref);
    const record: ActiveRuntimeCredential = {
      version: IDE_COMPANION_RUNTIME_CREDENTIAL_VERSION,
      state: 'ACTIVE',
      runtimeInstanceId,
      enrollmentId: input.enrollmentId,
      ideInstanceId: input.ideInstanceId,
      ideProduct: input.ideProduct,
      adapterId: ref.adapterId,
      adapterVersion: input.adapterVersion,
      secretGeneration: 1,
      socketPath,
      secret: newSecret(),
    };
    writeExclusive(credentialPath, encodeCredential(record));
    assertCredentialFile(credentialPath);
    fsyncDirectory(directory);
    return ref;
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort only for freshly allocated dir */ }
    throw error;
  }
}

/**
 * Recover one exact durable runtime selected by trusted provisioning state.
 * This performs no directory scan or "newest" selection: the caller must
 * provide the exact runtimeInstanceId that was durably provisioned.
 */
export function recoverIdeCompanionRuntime(input: NewIdeCompanionRuntime & { runtimeInstanceId: string }): IdeCompanionRuntimeRef {
  assertTrustedIdeCompanionRuntimeRoot(input.runtimeRoot);
  try {
    assertIdeEnrollmentId(input.enrollmentId);
    assertIdeInstanceId(input.ideInstanceId);
    assertIdeProduct(input.ideProduct);
  } catch {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_INVALID', 'runtime enrollment/IDE identity is invalid');
  }
  validateAdapterVersion(input.adapterVersion);
  validateRuntimeInstanceId(input.runtimeInstanceId);
  const directory = join(input.runtimeRoot, input.runtimeInstanceId);
  const ref: IdeCompanionRuntimeRef = {
    runtimeRoot: input.runtimeRoot,
    runtimeInstanceId: input.runtimeInstanceId,
    directory,
    credentialPath: join(directory, IDE_COMPANION_RUNTIME_CREDENTIAL_BASENAME),
    socketPath: join(directory, IDE_COMPANION_RUNTIME_SOCKET_BASENAME),
    enrollmentId: input.enrollmentId,
    ideInstanceId: input.ideInstanceId,
    ideProduct: input.ideProduct,
    adapterId: expectedAdapterId(input.ideProduct),
    adapterVersion: input.adapterVersion,
  };
  assertRuntimeRef(ref);
  const record = parseCredential(ref);
  if (record.state !== 'ACTIVE') {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_REVOKED', 'runtime credential is revoked');
  }
  return ref;
}

/** Re-read and revalidate on every use so rotation/revocation takes effect immediately. */
export function readIdeCompanionSecret(ref: IdeCompanionRuntimeRef): IdeCompanionSecretMaterial {
  const record = parseCredential(ref);
  if (record.state !== 'ACTIVE') {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_REVOKED', 'runtime credential is revoked');
  }
  return { secret: Buffer.from(record.secret, 'base64url'), secretGeneration: record.secretGeneration };
}

/** Rotate atomically; copied old secret bytes cease to be current on the next trusted read. */
export function rotateIdeCompanionSecret(ref: IdeCompanionRuntimeRef): number {
  const current = parseCredential(ref);
  if (current.state !== 'ACTIVE') {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_CREDENTIAL_REVOKED', 'runtime credential is revoked');
  }
  const secretGeneration = nextSecretGeneration(current.secretGeneration);
  replaceCredentialAtomically(ref, { ...current, secretGeneration, secret: newSecret() });
  return secretGeneration;
}

/** Persistently revoke the runtime credential; re-enrollment requires a fresh runtime instance. */
export function revokeIdeCompanionSecret(ref: IdeCompanionRuntimeRef): number {
  const current = parseCredential(ref);
  if (current.state === 'REVOKED') return current.secretGeneration;
  const secretGeneration = nextSecretGeneration(current.secretGeneration);
  const revoked: RevokedRuntimeCredential = {
    version: current.version,
    state: 'REVOKED',
    runtimeInstanceId: current.runtimeInstanceId,
    enrollmentId: current.enrollmentId,
    ideInstanceId: current.ideInstanceId,
    ideProduct: current.ideProduct,
    adapterId: current.adapterId,
    adapterVersion: current.adapterVersion,
    secretGeneration,
    socketPath: current.socketPath,
  };
  replaceCredentialAtomically(ref, revoked);
  return secretGeneration;
}

/**
 * Verify an endpoint created by a later transport gate. This never binds or
 * listens. It may tighten a proven owner-controlled Unix socket to 0600.
 */
export function hardenAndVerifyIdeCompanionSocket(ref: IdeCompanionRuntimeRef): void {
  assertRuntimeRef(ref);
  let info;
  try { info = lstatSync(ref.socketPath); } catch {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_SOCKET_INVALID', 'runtime socket is unavailable');
  }
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== currentUid()) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_SOCKET_INVALID', 'runtime endpoint is not an owner-controlled Unix-domain socket');
  }
  chmodSync(ref.socketPath, IDE_COMPANION_RUNTIME_FILE_MODE);
  info = lstatSync(ref.socketPath);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o777) !== IDE_COMPANION_RUNTIME_FILE_MODE) {
    throw new IdeCompanionRuntimeError('IDE_RUNTIME_SOCKET_INVALID', 'runtime socket ownership or permissions are unsafe');
  }
}
