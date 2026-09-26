import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PREFIX = /^qg-(?:sh05-cosign|sh06-forward)-[A-Za-z0-9_-]+$/u;

/**
 * Create a narrowly-scoped temp root for test executables.
 *
 * The normal serialized Vitest temp root intentionally remains under /tmp/q.
 * Some hardened Linux environments mount /tmp noexec, so executable fixture
 * shims cannot live there. On Unix we place only those executable shims under
 * ignored node_modules/.cache on the checkout filesystem and prove execution
 * works before returning the root. General test temp state continues to use
 * the normal tmpdir()/run-vitest-clean.mjs contract.
 */
export function createExecutableFixtureRoot(
  prefix: 'qg-sh05-cosign-' | 'qg-sh06-forward-',
): string {
  const base = process.platform === 'win32'
    ? tmpdir()
    : resolve('node_modules', '.cache', 'quarangate-executable-fixtures');

  mkdirSync(base, { recursive: true, mode: 0o700 });
  const resolvedBase = realpathSync(base);
  const root = mkdtempSync(join(resolvedBase, prefix));
  chmodSync(root, 0o700);
  const resolvedRoot = realpathSync(root);

  const rel = relative(resolvedBase, resolvedRoot);
  if (!rel || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    rmSync(resolvedRoot, { recursive: true, force: true });
    throw new Error('executable fixture root escaped its owned cache base');
  }
  if (!PREFIX.test(rel)) {
    rmSync(resolvedRoot, { recursive: true, force: true });
    throw new Error('executable fixture root has an unexpected name');
  }

  if (process.platform !== 'win32') {
    const probe = join(resolvedRoot, '.exec-probe');
    writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(probe, 0o700);
    const result = spawnSync(probe, [], { stdio: 'ignore', shell: false });
    rmSync(probe, { force: true });
    if (result.status !== 0) {
      rmSync(resolvedRoot, { recursive: true, force: true });
      throw new Error(
        `executable fixture root is not executable: ${String(result.error ?? `exit ${result.status}`)}`,
      );
    }
  }

  return resolvedRoot;
}
