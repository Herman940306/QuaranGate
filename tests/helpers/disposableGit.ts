import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const DISPOSABLE_GIT_ROOT = /^qg-(?:prov|source-binding)-[A-Za-z0-9_-]+$/u;
const ownedDisposableRoots = new Set<string>();

export function createDisposableGitRoot(prefix: 'qg-prov-' | 'qg-source-binding-' | 'qg-source-binding-victim-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const resolvedRoot = realpathSync(root);
  ownedDisposableRoots.add(resolvedRoot);
  return resolvedRoot;
}

export function createDisposableGitChildRoot(parent: string, name: 'repo'): string {
  const resolvedParent = assertDisposableGitRoot(parent);
  const root = join(resolvedParent, name);
  mkdirSync(root, { mode: 0o700 });
  const resolvedRoot = realpathSync(root);
  if (dirname(resolvedRoot) !== resolvedParent) {
    throw new Error('disposable Git fixture child escaped its owned parent');
  }
  ownedDisposableRoots.add(resolvedRoot);
  return resolvedRoot;
}

export function assertDisposableGitRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error('disposable Git fixture root must be absolute');
  const resolvedRoot = realpathSync(root);
  const resolvedTemp = realpathSync(tmpdir());
  const fromTemp = relative(resolvedTemp, resolvedRoot);
  if (!fromTemp || fromTemp.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromTemp)) {
    throw new Error('disposable Git fixture root must be inside the active test temp directory');
  }
  const directOwnedRoot = DISPOSABLE_GIT_ROOT.test(basename(resolvedRoot));
  const ownedProvenanceChild = basename(resolvedRoot) === 'repo'
    && /^qg-prov-[A-Za-z0-9_-]+$/u.test(basename(dirname(resolvedRoot)));
  if (!directOwnedRoot && !ownedProvenanceChild) {
    throw new Error('disposable Git fixture root has an unowned name');
  }
  if (!ownedDisposableRoots.has(resolvedRoot)) {
    throw new Error('disposable Git fixture root was not created by the fixture helper');
  }
  const stat = lstatSync(resolvedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('disposable Git fixture root must be a real directory');
  return resolvedRoot;
}

export function disposableGitEnv(
  root: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolvedRoot = assertDisposableGitRoot(root);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (!name.toUpperCase().startsWith('GIT_') && value !== undefined) env[name] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(resolvedRoot, '.fixture-global-gitconfig');
  return env;
}

function run(root: string, args: string[], inherited: NodeJS.ProcessEnv) {
  const resolvedRoot = assertDisposableGitRoot(root);
  const result = spawnSync('git', ['-C', resolvedRoot, ...args], {
    encoding: 'utf8',
    env: disposableGitEnv(resolvedRoot, inherited),
    shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0] ?? ''} failed`);
  return result.stdout.trim();
}

export function initializeDisposableGitRepository(
  root: string,
  inherited: NodeJS.ProcessEnv = process.env,
): void {
  const resolvedRoot = assertDisposableGitRoot(root);
  run(resolvedRoot, ['init', '-q'], inherited);
  const topLevel = realpathSync(run(resolvedRoot, ['rev-parse', '--show-toplevel'], inherited));
  const gitDir = realpathSync(run(resolvedRoot, ['rev-parse', '--absolute-git-dir'], inherited));
  if (topLevel !== resolvedRoot || gitDir !== realpathSync(join(resolvedRoot, '.git'))) {
    throw new Error('disposable Git fixture resolved outside its owned repository');
  }
}

export function runDisposableGit(
  root: string,
  args: string[],
  inherited: NodeJS.ProcessEnv = process.env,
): string {
  const resolvedRoot = assertDisposableGitRoot(root);
  const topLevel = realpathSync(run(resolvedRoot, ['rev-parse', '--show-toplevel'], inherited));
  const gitDir = realpathSync(run(resolvedRoot, ['rev-parse', '--absolute-git-dir'], inherited));
  if (topLevel !== resolvedRoot || gitDir !== realpathSync(join(resolvedRoot, '.git'))) {
    throw new Error('disposable Git fixture resolved outside its owned repository');
  }
  return run(resolvedRoot, args, inherited);
}
