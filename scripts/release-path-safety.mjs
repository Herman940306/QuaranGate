import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

export function pathIsWithinRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/') && !rel.startsWith('\\'));
}

export function externalOutputPath(sourceRoot, candidate, label = 'output') {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${label} requires a path`);
  const source = realpathSync(resolve(sourceRoot));
  const absolute = resolve(candidate);
  const parent = dirname(absolute);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`${label} parent directory must already exist`);
  const parentReal = realpathSync(parent);
  const effective = resolve(parentReal, basename(absolute));
  if (pathIsWithinRoot(source, effective)) throw new Error(`${label} must be outside the Git worktree`);
  if (existsSync(absolute)) {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    const existingReal = realpathSync(absolute);
    if (pathIsWithinRoot(source, existingReal)) throw new Error(`${label} resolves inside the Git worktree`);
  }
  return absolute;
}

export function externalPrivateEvidenceDirectory(sourceRoot, candidate, label = '--evidence-dir') {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${label} requires a path`);
  const source = realpathSync(resolve(sourceRoot));
  const absolute = resolve(candidate);
  const parent = dirname(absolute);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`${label} parent directory must already exist`);
  if (existsSync(absolute)) {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory, not a link or file`);
  } else {
    mkdirSync(absolute, { mode: 0o700 });
  }
  const real = realpathSync(absolute);
  if (pathIsWithinRoot(source, real)) throw new Error(`${label} must be outside the source tree`);
  const info = statSync(real);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only (0700)`);
  if (readdirSync(real).length !== 0) throw new Error(`${label} must be empty before release assurance starts`);
  return real;
}
