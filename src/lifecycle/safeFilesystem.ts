import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const CONTROL = /[\u0000-\u001f\u007f]/u;

export class LifecycleFilesystemError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LifecycleFilesystemError';
  }
}

function canonicalAbsolute(input: string, label: string): string {
  if (typeof input !== 'string' || CONTROL.test(input) || !path.isAbsolute(input)) {
    throw new LifecycleFilesystemError('PATH_INVALID', `${label} must be an absolute path`);
  }
  const normalized = path.resolve(input);
  if (normalized !== input || normalized === path.parse(normalized).root) {
    throw new LifecycleFilesystemError('PATH_INVALID', `${label} must be canonical and cannot be a filesystem root`);
  }
  return normalized;
}

function safeRelative(input: string): string {
  if (typeof input !== 'string' || !input || CONTROL.test(input) || path.isAbsolute(input) || input.includes('\\')) {
    throw new LifecycleFilesystemError('PATH_INVALID', 'Lifecycle relative path is invalid');
  }
  const normalized = path.posix.normalize(input);
  if (normalized !== input || normalized === '.' || normalized.split('/').includes('..')) {
    throw new LifecycleFilesystemError('PATH_INVALID', 'Lifecycle relative path is not canonical or escapes its root');
  }
  return normalized;
}

function assertNoSymlinkComponents(absolute: string): void {
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new LifecycleFilesystemError('SYMLINK_REFUSED', `Lifecycle path crosses a symbolic link: ${current}`);
    }
  }
}

function mkdirPrivateWithoutFollowingSymlinks(absolute: string): void {
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      chmodSync(current, 0o700);
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new LifecycleFilesystemError('SYMLINK_REFUSED', `Lifecycle path crosses a symbolic link: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new LifecycleFilesystemError('PATH_WRONG_TYPE', `Lifecycle directory path is not a directory: ${current}`);
    }
  }
}

export function ensurePrivateDirectory(input: string): string {
  const absolute = canonicalAbsolute(input, 'Lifecycle directory');
  assertNoSymlinkComponents(absolute);
  mkdirPrivateWithoutFollowingSymlinks(absolute);
  const stat = lstatSync(absolute);
  if ((stat.mode & 0o077) !== 0) {
    throw new LifecycleFilesystemError('UNSAFE_PERMISSIONS', `Lifecycle directory has unsafe permissions: ${absolute}`);
  }
  return absolute;
}

function assertSafeExistingDestination(target: string): void {
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new LifecycleFilesystemError('SYMLINK_REFUSED', 'Lifecycle destination is a symbolic link');
  }
  if (!stat.isFile()) {
    throw new LifecycleFilesystemError('PATH_WRONG_TYPE', 'Lifecycle destination is not a regular file');
  }
  if (stat.nlink !== 1) {
    throw new LifecycleFilesystemError('HARDLINK_REFUSED', 'Lifecycle destination has multiple hard links');
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWritePrivateFile(rootInput: string, relativeInput: string, bytes: Buffer): string {
  const root = ensurePrivateDirectory(rootInput);
  const relative = safeRelative(relativeInput);
  const target = path.join(root, ...relative.split('/'));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new LifecycleFilesystemError('PATH_ESCAPE', 'Lifecycle destination escapes its trusted root');
  }
  const parent = ensurePrivateDirectory(path.dirname(target));
  assertNoSymlinkComponents(target);
  assertSafeExistingDestination(target);

  const temp = path.join(parent, `.${path.basename(target)}.tmp-${randomBytes(12).toString('hex')}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, 0o600);
    renameSync(temp, target);
    chmodSync(target, 0o600);
    fsyncDirectory(parent);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
  return target;
}

export function readPrivateFile(
  rootInput: string,
  relativeInput: string,
  maxBytes = 4 * 1024 * 1024,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new LifecycleFilesystemError('READ_LIMIT_INVALID', 'Lifecycle read limit is invalid');
  }
  const root = ensurePrivateDirectory(rootInput);
  const relative = safeRelative(relativeInput);
  const target = path.join(root, ...relative.split('/'));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new LifecycleFilesystemError('PATH_ESCAPE', 'Lifecycle read escapes its trusted root');
  }
  assertNoSymlinkComponents(target);
  if (!existsSync(target)) {
    throw new LifecycleFilesystemError('FILE_NOT_FOUND', 'Lifecycle file was not found');
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new LifecycleFilesystemError('SYMLINK_REFUSED', 'Lifecycle read target is a symbolic link');
  }
  if (!stat.isFile()) {
    throw new LifecycleFilesystemError('PATH_WRONG_TYPE', 'Lifecycle read target is not a regular file');
  }
  if (stat.nlink !== 1) {
    throw new LifecycleFilesystemError('HARDLINK_REFUSED', 'Lifecycle read target has multiple hard links');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new LifecycleFilesystemError('UNSAFE_PERMISSIONS', 'Lifecycle read target has unsafe permissions');
  }
  if (stat.size > maxBytes) {
    throw new LifecycleFilesystemError('READ_LIMIT_EXCEEDED', 'Lifecycle file exceeds its bounded read limit');
  }
  return readFileSync(target);
}

function preflightOwnedTree(target: string): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new LifecycleFilesystemError('SYMLINK_REFUSED', `Owned tree contains a symbolic link: ${target}`);
  }
  if (stat.isFile()) {
    if (stat.nlink !== 1) {
      throw new LifecycleFilesystemError('HARDLINK_REFUSED', `Owned tree contains a hard linked file: ${target}`);
    }
    return;
  }
  if (!stat.isDirectory()) {
    throw new LifecycleFilesystemError('PATH_WRONG_TYPE', `Owned tree contains an unsupported entry: ${target}`);
  }
  for (const entry of readdirSync(target).sort()) preflightOwnedTree(path.join(target, entry));
}

export function safeRemoveOwnedTree(
  rootInput: string,
  relativeInput: string,
  allowlistedTopLevel: readonly string[],
): void {
  const root = ensurePrivateDirectory(rootInput);
  const relative = safeRelative(relativeInput);
  if (relative.includes('/') || !allowlistedTopLevel.includes(relative)) {
    throw new LifecycleFilesystemError('DELETE_NOT_ALLOWLISTED', 'Lifecycle removal target is not an allowlisted owned top-level tree');
  }
  const target = path.join(root, relative);
  assertNoSymlinkComponents(target);
  if (!existsSync(target)) return;
  preflightOwnedTree(target);
  rmSync(target, { recursive: true, force: false });
  fsyncDirectory(root);
}
