import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function git(repo: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  expect(r.status, r.stderr || r.stdout).toBe(0);
  return r.stdout.trim();
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'qg-source-binding-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'sh05@example.invalid');
  git(root, 'config', 'user.name', 'SH05 Test');
  git(root, 'remote', 'add', 'origin', 'https://github.com/Herman940306/QuaranGate.git');
  writeFileSync(join(root, '.gitignore'), 'node_modules\ndist/\n');
  writeFileSync(join(root, 'source.txt'), 'accepted\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  mkdirSync(join(root, 'dist'));
  const evidence = mkdtempSync(join(tmpdir(), 'qg-source-binding-evidence-'));
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
