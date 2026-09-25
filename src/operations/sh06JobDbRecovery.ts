import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Stats } from 'node:fs';

const MANIFEST_FORMAT = 1;
const MAX_MANIFEST_BYTES = 16 * 1024;

export interface DatabaseProof {
  sha256: string;
  sizeBytes: number;
  userVersion: number;
  integrityCheck: 'ok';
  foreignKeyViolations: 0;
  mode: number;
  uid: number;
  gid: number;
}

export interface SnapshotManifest {
  format: 1;
  databaseFile: string;
  proof: DatabaseProof;
}

function requireAbsolute(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
}

function requireRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

function hashFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function inspectOpenDatabase(db: DatabaseSync): Pick<DatabaseProof, 'userVersion' | 'integrityCheck' | 'foreignKeyViolations'> {
  db.exec('PRAGMA query_only=ON');
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const userVersion = Number(versionRow?.user_version);
  if (!Number.isSafeInteger(userVersion) || userVersion < 0) throw new Error('database user_version is invalid');
  const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
    throw new Error('database integrity_check failed');
  }
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  if (foreignKeyViolations !== 0) throw new Error('database foreign_key_check failed');
  return { userVersion, integrityCheck: 'ok', foreignKeyViolations: 0 };
}

export function inspectDatabase(path: string): DatabaseProof {
  requireAbsolute(path, 'database path');
  requireRegularFile(path, 'database');
  const db = new DatabaseSync(path, { readOnly: true });
  let sqliteProof: ReturnType<typeof inspectOpenDatabase>;
  try { sqliteProof = inspectOpenDatabase(db); } finally { db.close(); }
  const stat = statSync(path);
  return {
    sha256: hashFile(path),
    sizeBytes: stat.size,
    ...sqliteProof,
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function validateRestrictedDirectory(path: string): void {
  requireAbsolute(path, 'snapshot directory');
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('snapshot directory must be a non-symlink directory');
  if ((stat.mode & 0o077) !== 0) throw new Error('snapshot directory must not be accessible by group or other');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('snapshot directory owner mismatch');
}

function validatePrivateRuntimeIdentity(stat: Stats, label: string): void {
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions are not private`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
  if (typeof process.getgid === 'function' && stat.gid !== process.getgid()) throw new Error(`${label} group mismatch`);
}

function parseManifest(path: string): SnapshotManifest {
  requireAbsolute(path, 'manifest path');
  requireRegularFile(path, 'manifest');
  const stat = statSync(path);
  if (stat.size > MAX_MANIFEST_BYTES || (stat.mode & 0o777) !== 0o600) throw new Error('snapshot manifest metadata is unsafe');
  validatePrivateRuntimeIdentity(stat, 'snapshot manifest');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SnapshotManifest>;
  if (parsed.format !== MANIFEST_FORMAT || typeof parsed.databaseFile !== 'string' || parsed.databaseFile !== basename(parsed.databaseFile)) {
    throw new Error('snapshot manifest identity is invalid');
  }
  const proof = parsed.proof;
  if (!proof || !/^[0-9a-f]{64}$/u.test(proof.sha256 ?? '') || !Number.isSafeInteger(proof.sizeBytes)
      || !Number.isSafeInteger(proof.userVersion) || proof.integrityCheck !== 'ok' || proof.foreignKeyViolations !== 0
      || !Number.isSafeInteger(proof.mode) || proof.mode < 0 || proof.mode > 0o777 || (proof.mode & 0o077) !== 0
      || !Number.isSafeInteger(proof.uid) || proof.uid < 0 || !Number.isSafeInteger(proof.gid) || proof.gid < 0) {
    throw new Error('snapshot manifest proof is invalid');
  }
  return parsed as SnapshotManifest;
}

export function verifySnapshot(snapshotPath: string, manifestPath: string): SnapshotManifest {
  const manifest = parseManifest(manifestPath);
  if (basename(snapshotPath) !== manifest.databaseFile) throw new Error('snapshot filename does not match manifest');
  const actual = inspectDatabase(snapshotPath);
  for (const key of ['sha256', 'sizeBytes', 'userVersion', 'integrityCheck', 'foreignKeyViolations'] as const) {
    if (actual[key] !== manifest.proof[key]) throw new Error(`snapshot ${key} verification failed`);
  }
  const snapshotStat = statSync(snapshotPath);
  if ((snapshotStat.mode & 0o777) !== 0o600) throw new Error('snapshot file permissions are unsafe');
  validatePrivateRuntimeIdentity(snapshotStat, 'snapshot file');
  return manifest;
}

export async function createSnapshot(sourcePath: string, snapshotPath: string, manifestPath: string): Promise<SnapshotManifest> {
  requireAbsolute(sourcePath, 'source database path');
  requireAbsolute(snapshotPath, 'snapshot path');
  requireAbsolute(manifestPath, 'manifest path');
  requireRegularFile(sourcePath, 'source database');
  if (dirname(snapshotPath) !== dirname(manifestPath)) throw new Error('snapshot and manifest must share one operation directory');
  validateRestrictedDirectory(dirname(snapshotPath));
  if (existsSync(snapshotPath) || existsSync(manifestPath)) throw new Error('snapshot destination must be new');
  const sourceStat = statSync(sourcePath);
  validatePrivateRuntimeIdentity(sourceStat, 'source database');
  const previousUmask = process.umask(0o077);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec('PRAGMA query_only=ON');
    await backup(source, snapshotPath);
  } catch (error) {
    if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
    throw error;
  } finally {
    source.close();
    process.umask(previousUmask);
  }
  chmodSync(snapshotPath, 0o600);
  syncPath(snapshotPath);
  const proof = inspectDatabase(snapshotPath);
  const manifest: SnapshotManifest = {
    format: MANIFEST_FORMAT,
    databaseFile: basename(snapshotPath),
    proof: { ...proof, mode: sourceStat.mode & 0o777, uid: sourceStat.uid, gid: sourceStat.gid },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  syncPath(manifestPath);
  syncPath(dirname(snapshotPath));
  return verifySnapshot(snapshotPath, manifestPath);
}

export function restoreSnapshot(snapshotPath: string, manifestPath: string, destinationPath: string): DatabaseProof {
  requireAbsolute(destinationPath, 'restore destination path');
  const manifest = verifySnapshot(snapshotPath, manifestPath);
  const destinationDir = dirname(destinationPath);
  const dirStat = lstatSync(destinationDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('restore destination directory is unsafe');
  validatePrivateRuntimeIdentity(dirStat, 'restore destination directory');
  if (existsSync(destinationPath)) requireRegularFile(destinationPath, 'restore destination database');
  const tempPath = `${destinationPath}.sh06-restore-${process.pid}`;
  if (existsSync(tempPath)) throw new Error('restore temporary destination already exists');
  try {
    copyFileSync(snapshotPath, tempPath, constants.COPYFILE_EXCL);
    chmodSync(tempPath, manifest.proof.mode);
    const tempStat = statSync(tempPath);
    if (tempStat.uid !== manifest.proof.uid || tempStat.gid !== manifest.proof.gid) {
      chownSync(tempPath, manifest.proof.uid, manifest.proof.gid);
    }
    syncPath(tempPath);
    const tempProof = inspectDatabase(tempPath);
    if (tempProof.sha256 !== manifest.proof.sha256 || tempProof.userVersion !== manifest.proof.userVersion) {
      throw new Error('restore temporary database does not match verified snapshot');
    }
    // Candidate executor is stopped before this helper is invoked. Remove only
    // the two exact SQLite sidecars so no candidate WAL can be replayed over the
    // restored predeploy main database.
    for (const sidecar of [`${destinationPath}-wal`, `${destinationPath}-shm`]) {
      if (existsSync(sidecar)) {
        requireRegularFile(sidecar, 'SQLite sidecar');
        unlinkSync(sidecar);
      }
    }
    renameSync(tempPath, destinationPath);
    syncPath(destinationPath);
    syncPath(destinationDir);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  const restored = inspectDatabase(destinationPath);
  if (restored.sha256 !== manifest.proof.sha256 || restored.userVersion !== manifest.proof.userVersion
      || restored.mode !== manifest.proof.mode || restored.uid !== manifest.proof.uid || restored.gid !== manifest.proof.gid) {
    throw new Error('restored database proof does not match predeploy snapshot');
  }
  return restored;
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, first, second, third] = argv;
  if (command === 'snapshot' && first && second && third) {
    const manifest = await createSnapshot(first, second, third);
    process.stdout.write(`${JSON.stringify({ status: 'SNAPSHOT_VERIFIED', ...manifest.proof })}\n`);
    return;
  }
  if (command === 'verify' && first && second && !third) {
    const manifest = verifySnapshot(first, second);
    process.stdout.write(`${JSON.stringify({ status: 'SNAPSHOT_VERIFIED', ...manifest.proof })}\n`);
    return;
  }
  if (command === 'restore' && first && second && third) {
    const proof = restoreSnapshot(first, second, third);
    process.stdout.write(`${JSON.stringify({ status: 'PERSISTENT_STATE_RESTORED', ...proof })}\n`);
    return;
  }
  throw new Error('usage: sh06JobDbRecovery snapshot|verify <database> <snapshot-or-manifest> [manifest-or-destination]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 300) : 'unknown error';
    process.stderr.write(`SH06_DB_RECOVERY=FAIL reason=${reason}\n`);
    process.exitCode = 1;
  });
}
