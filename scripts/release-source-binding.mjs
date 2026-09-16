#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { externalOutputPath } from './release-path-safety.mjs';

const args = process.argv.slice(2);
const valueAfter = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const repository = resolve(valueAfter('--repository') ?? '.');
const output = valueAfter('--output');
if (!output) throw new Error('--output is required');
externalOutputPath(repository, output, '--output');

function git(argv, options = {}) {
  const result = spawnSync('git', ['-C', repository, ...argv], { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`git ${argv.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${argv.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

const commit = git(['rev-parse', 'HEAD']).trim();
const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
const indexTree = git(['write-tree']).trim();
if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{40}$/u.test(tree)) throw new Error('Git returned a non-SHA1 source identity');
if (indexTree !== tree) throw new Error(`staged/index tree differs from HEAD tree: ${indexTree} != ${tree}`);

const tracked = spawnSync('git', ['-C', repository, 'diff', '--quiet', '--no-ext-diff'], { encoding: 'utf8' });
if (tracked.error) throw tracked.error;
if (tracked.status !== 0) throw new Error('tracked working-tree bytes differ from HEAD');
const staged = spawnSync('git', ['-C', repository, 'diff', '--cached', '--quiet', '--no-ext-diff'], { encoding: 'utf8' });
if (staged.error) throw staged.error;
if (staged.status !== 0) throw new Error('staged bytes differ from HEAD');
const diffCheck = spawnSync('git', ['-C', repository, 'diff', '--check', 'HEAD'], { encoding: 'utf8' });
if (diffCheck.error) throw diffCheck.error;
if (diffCheck.status !== 0) throw new Error(`git diff --check failed: ${(diffCheck.stderr || diffCheck.stdout).trim()}`);

const untrackedRaw = git(['ls-files', '--others', '--exclude-standard', '-z']);
const untracked = untrackedRaw.split('\0').filter(Boolean).sort();
if (untracked.length) throw new Error(`non-ignored untracked source bytes present: ${untracked.join(', ')}`);

let origin = '';
const originResult = spawnSync('git', ['-C', repository, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
if (originResult.status === 0) origin = originResult.stdout.trim();
const branchResult = spawnSync('git', ['-C', repository, 'branch', '--show-current'], { encoding: 'utf8' });
const branch = branchResult.status === 0 ? branchResult.stdout.trim() : '';

const receipt = {
  schemaVersion: 1,
  gate: 'source-binding',
  status: 'PASS',
  source: {
    repository: origin || null,
    branch: branch || null,
    commit,
    tree,
    clean: true,
  },
};
writeFileSync(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`);
