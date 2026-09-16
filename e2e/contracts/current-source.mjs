import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function git(args, encoding = 'utf8') {
  return execFileSync('git', ['-C', SOURCE_ROOT, ...args], { encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function verifyCurrentSourceIdentity() {
  const head = String(git(['rev-parse', 'HEAD'])).trim();
  const tree = String(git(['rev-parse', 'HEAD^{tree}'])).trim();
  const indexTree = String(git(['write-tree'])).trim();
  const branch = String(git(['branch', '--show-current'])).trim();
  const tracked = String(git(['status', '--porcelain=v1', '--untracked-files=all'])).trim();
  if (!/^[0-9a-f]{40}$/u.test(head) || !/^[0-9a-f]{40}$/u.test(tree)) throw new Error('E2E source identity is invalid');
  if (indexTree !== tree) throw new Error('E2E source index differs from HEAD');
  if (tracked) throw new Error(`E2E source worktree is not clean: ${tracked}`);
  return Object.freeze({ branch: branch || null, head, tree, clean: true });
}

export const CURRENT_SOURCE_IDENTITY = verifyCurrentSourceIdentity();
