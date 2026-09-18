import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDisposableGitRoot,
  createDisposableGitRoot,
  initializeDisposableGitRepository,
  runDisposableGit,
} from '../helpers/disposableGit.js';

const createdRoots: string[] = [];
afterEach(() => { while (createdRoots.length) rmSync(createdRoots.pop()!, { recursive: true, force: true }); });

function git(repo: string, ...args: string[]) {
  return runDisposableGit(repo, args);
}

function repo(inherited = process.env) {
  const root = createDisposableGitRoot('qg-source-binding-');
  createdRoots.push(root);
  initializeDisposableGitRepository(root, inherited);
  runDisposableGit(root, ['config', 'user.email', 'sh05@example.invalid'], inherited);
  runDisposableGit(root, ['config', 'user.name', 'SH05 Test'], inherited);
  runDisposableGit(root, ['remote', 'add', 'origin', 'https://github.com/Herman940306/QuaranGate.git'], inherited);
  writeFileSync(join(root, '.gitignore'), 'node_modules\ndist/\n');
  writeFileSync(join(root, 'source.txt'), 'accepted\n');
  runDisposableGit(root, ['add', '.'], inherited); runDisposableGit(root, ['commit', '-m', 'fixture'], inherited);
  mkdirSync(join(root, 'dist'));
  const evidence = mkdtempSync(join(tmpdir(), 'qg-source-binding-evidence-'));
  createdRoots.push(evidence);
  const output = join(evidence, 'source-binding.json');
  return { root, output, evidence };
}

function run(f: ReturnType<typeof repo>) {
  return spawnSync(process.execPath, ['scripts/release-source-binding.mjs', '--repository', f.root, '--output', f.output], { encoding: 'utf8' });
}

describe('SH-05 Git-derived release source binding', () => {
  it('binds clean HEAD and tree identity without trusting caller-supplied clean state', () => {
    const f = repo(); const r = run(f); expect(r.status, r.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(f.output, 'utf8'));
    expect(receipt).toMatchObject({ schemaVersion: 1, gate: 'source-binding', status: 'PASS', source: { repository: 'https://github.com/Herman940306/QuaranGate.git', clean: true } });
    expect(receipt.source.commit).toBe(git(f.root, 'rev-parse', 'HEAD'));
    expect(receipt.source.tree).toBe(git(f.root, 'rev-parse', 'HEAD^{tree}'));
  });

  it('refuses a non-disposable source root and ignores hostile inherited Git selectors', () => {
    expect(() => assertDisposableGitRoot(process.cwd())).toThrow(/active test temp directory|unowned name/u);
    const unownedMatchingPath = mkdtempSync(join(tmpdir(), 'qg-source-binding-')); createdRoots.push(unownedMatchingPath);
    expect(() => initializeDisposableGitRepository(unownedMatchingPath)).toThrow(/not created by the fixture helper/u);
    const victim = createDisposableGitRoot('qg-source-binding-victim-'); createdRoots.push(victim);
    initializeDisposableGitRepository(victim);
    git(victim, 'config', 'user.email', 'owner@example.invalid'); git(victim, 'config', 'user.name', 'Disposable Owner');
    writeFileSync(join(victim, 'sentinel.txt'), 'preserve\n'); git(victim, 'add', '.'); git(victim, 'commit', '-m', 'baseline');
    const before = git(victim, 'rev-parse', 'HEAD');
    const fixture = repo({
      ...process.env,
      GIT_DIR: join(victim, '.git'),
      GIT_WORK_TREE: victim,
      git_common_dir: join(victim, '.git'),
      Git_Config_Global: join(victim, 'hostile-global-config'),
    });
    expect(git(victim, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(victim, 'config', 'user.name')).toBe('Disposable Owner');
    expect(git(fixture.root, 'show', '-s', '--format=%an <%ae>')).toBe('SH05 Test <sh05@example.invalid>');
  });

  it('fails closed for tracked working-tree drift', () => {
    const f = repo(); writeFileSync(join(f.root, 'source.txt'), 'drift\n');
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('tracked working-tree bytes differ from HEAD');
  });

  it('fails closed for staged drift', () => {
    const f = repo(); writeFileSync(join(f.root, 'new.txt'), 'staged\n'); git(f.root, 'add', 'new.txt');
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('staged/index tree differs from HEAD tree');
  });

  it('fails closed for non-ignored untracked bytes', () => {
    const f = repo(); writeFileSync(join(f.root, 'unexpected.ts'), 'untracked\n');
    const r = run(f); expect(r.status).not.toBe(0); expect(r.stderr).toContain('non-ignored untracked source bytes present: unexpected.ts');
  });


  it('refuses to write the source-binding receipt inside the Git source even when the path is ignored', () => {
    const f = repo(); const inside = join(f.root, 'dist', 'source-binding.json');
    const r = spawnSync(process.execPath, ['scripts/release-source-binding.mjs', '--repository', f.root, '--output', inside], { encoding: 'utf8' });
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('must be outside the Git worktree');
  });

  it('permits ignored dependency/build artifacts and a node_modules symlink without weakening source identity', () => {
    const f = repo();
    const deps = mkdtempSync(join(tmpdir(), 'qg-deps-')); symlinkSync(deps, join(f.root, 'node_modules'));
    writeFileSync(join(f.root, 'dist', 'ignored.txt'), 'generated\n');
    const r = run(f); expect(r.status, r.stderr).toBe(0);
  });
});
