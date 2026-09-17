#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function parsePairs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || out.has(key)) {
      throw new Error('arguments must be unique --name value pairs');
    }
    out.set(key, value);
  }
  return out;
}

function required(args, name) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? (result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`)
      : `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return options.capture ? result.stdout.trim() : '';
}

export function fixtureBootstrapPlan(argv = process.argv.slice(2)) {
  const args = parsePairs(argv);
  const outputDirRaw = required(args, '--output-dir');
  const sourceRootRaw = required(args, '--source-root');
  const sourceCommit = required(args, '--source-commit');
  const bundleRaw = required(args, '--bundle');
  const coreProject = required(args, '--core-project');
  const targetProject = required(args, '--target-project');
  const bridgePort = required(args, '--bridge-port');

  if (!path.isAbsolute(outputDirRaw)) throw new Error('--output-dir must be absolute');
  if (!path.isAbsolute(sourceRootRaw)) throw new Error('--source-root must be absolute');
  if (!path.isAbsolute(bundleRaw)) throw new Error('--bundle must be absolute');
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error('--source-commit must be 40 lowercase hex');

  return {
    outputDir: path.resolve(outputDirRaw),
    sourceRoot: path.resolve(sourceRootRaw),
    sourceCommit,
    bundle: path.resolve(bundleRaw),
    generatorArgs: [
      '--output-dir', path.resolve(outputDirRaw),
      '--source-root', path.resolve(sourceRootRaw),
      '--source-commit', sourceCommit,
      '--core-project', coreProject,
      '--target-project', targetProject,
      '--bridge-port', bridgePort,
      '--bundle', path.resolve(bundleRaw),
    ],
  };
}

export function main(argv = process.argv.slice(2)) {
  const plan = fixtureBootstrapPlan(argv);
  if (!existsSync(plan.sourceRoot) || !statSync(plan.sourceRoot).isDirectory()) throw new Error('source root is missing');
  if (!existsSync(plan.bundle) || !statSync(plan.bundle).isDirectory()) throw new Error('verified npm bundle directory is missing');
  if (existsSync(plan.outputDir)) throw new Error('output directory already exists; refusing overwrite');

  const head = run('git', ['-C', plan.sourceRoot, 'rev-parse', 'HEAD'], { capture: true });
  if (head !== plan.sourceCommit) throw new Error('source HEAD does not match --source-commit');
  const status = run('git', ['-C', plan.sourceRoot, 'status', '--porcelain'], { capture: true });
  if (status !== '') throw new Error('source worktree is not clean');

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'quarangate-p10-fixture-bootstrap-'));
  const validationWorktree = path.join(tempRoot, 'source');
  const verifiedTarballs = path.join(tempRoot, 'verified-tarballs');
  const npmCache = path.join(tempRoot, 'npm-cache');
  let worktreeAdded = false;
  let preserveTempRoot = false;
  let primaryError = null;

  try {
    run('git', ['-C', plan.sourceRoot, 'worktree', 'add', '--detach', validationWorktree, plan.sourceCommit]);
    worktreeAdded = true;

    run(process.execPath, [
      path.join(validationWorktree, 'scripts/npm-offline-bundle.mjs'), 'materialize',
      '--bundle', plan.bundle,
      '--lockfile', path.join(validationWorktree, 'package-lock.json'),
      '--descriptor', path.join(validationWorktree, 'build/npm-dependencies.json'),
      '--destination', verifiedTarballs,
    ]);

    mkdirSync(npmCache, { recursive: true, mode: 0o700 });
    const artifacts = readdirSync(verifiedTarballs).filter((name) => name.endsWith('.tgz')).sort();
    if (artifacts.length === 0) throw new Error('verified bundle materialized no npm artifacts');
    for (const artifact of artifacts) {
      run('npm', [
        'cache', 'add', path.join(verifiedTarballs, artifact),
        `--cache=${npmCache}`, '--offline', '--ignore-scripts',
      ], { cwd: validationWorktree });
    }

    run('npm', [
      'ci', `--cache=${npmCache}`, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    ], { cwd: validationWorktree });

    run(process.execPath, [
      path.join(validationWorktree, 'scripts/p10-integration-fixture.mjs'),
      ...plan.generatorArgs,
    ], { cwd: validationWorktree });
  } catch (error) {
    primaryError = error;
    if (existsSync(plan.outputDir)) rmSync(plan.outputDir, { recursive: true, force: true });
  } finally {
    if (worktreeAdded) {
      try {
        run('git', ['-C', plan.sourceRoot, 'worktree', 'remove', '--force', validationWorktree]);
      } catch (cleanupError) {
        preserveTempRoot = true;
        const wrapped = new Error(`temporary worktree cleanup failed; preserved at ${tempRoot}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        if (!primaryError) primaryError = wrapped;
      }
    }
    if (!preserveTempRoot) {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        if (!primaryError) primaryError = cleanupError;
      }
    }
  }

  if (primaryError) throw primaryError;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`P10 integration fixture bootstrap refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
