#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { BASE_IMAGE, assertNoRegistryActivity, cleanupLocalOciLayout, imageExists, materializeLocalOciLayout, ociLayoutBuildContext, renderOfflineDockerfile } from './offline-local-base.mjs';

const HEX40 = /^[0-9a-f]{40}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const SAFE_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u;
const SOURCE_URL = 'https://github.com/Herman940306/QuaranGate';

function argMap(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || out.has(key)) throw new Error('arguments must be unique --name value pairs');
    out.set(key, value);
  }
  return out;
}

function required(args, name) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result;
}

function capture(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout.trim();
}

export function coreBuildPlan(argv, pid = process.pid) {
  const args = argMap(argv);
  const sourceRoot = path.resolve(required(args, '--source-root'));
  const sourceCommit = required(args, '--source-commit');
  const bundle = path.resolve(required(args, '--bundle'));
  const outputImage = required(args, '--output-image');
  if (!path.isAbsolute(required(args, '--source-root'))) throw new Error('--source-root must be absolute');
  if (!path.isAbsolute(required(args, '--bundle'))) throw new Error('--bundle must be absolute');
  if (!HEX40.test(sourceCommit)) throw new Error('--source-commit must be 40 lowercase hex');
  if (!SAFE_IMAGE_REF.test(outputImage)) throw new Error('--output-image has an invalid image reference');
  return { sourceRoot, sourceCommit, bundle, outputImage, suffix: `${sourceCommit.slice(0, 12)}-${pid}` };
}

export function buildCoreOffline(argv = process.argv.slice(2)) {
  const plan = coreBuildPlan(argv);
  let outputCreated = false;
  let localBase = null;
  try {
    if (imageExists(plan.outputImage)) throw new Error(`output image already exists: ${plan.outputImage}`);
    if (capture('git', ['-C', plan.sourceRoot, 'rev-parse', 'HEAD']) !== plan.sourceCommit) throw new Error('source HEAD does not match --source-commit');
    if (capture('git', ['-C', plan.sourceRoot, 'status', '--porcelain']) !== '') throw new Error('source worktree is not clean');

    const verify = run(process.execPath, [path.join(plan.sourceRoot, 'scripts/npm-offline-bundle.mjs'), 'verify', '--bundle', plan.bundle, '--lockfile', path.join(plan.sourceRoot, 'package-lock.json'), '--descriptor', path.join(plan.sourceRoot, 'build/npm-dependencies.json'), '--json']);
    if (verify.status !== 0) throw new Error('offline npm bundle verification failed');

    const baseId = capture('docker', ['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}']);
    if (!IMAGE_ID.test(baseId)) throw new Error('pinned base image did not resolve to an immutable local image ID');
    localBase = materializeLocalOciLayout(baseId, `quarangate-p10-core-base-${plan.suffix}-`);
    const offlineDockerfile = path.join(localBase.root, 'Dockerfile.p10-offline');
    writeFileSync(offlineDockerfile, renderOfflineDockerfile(readFileSync(path.join(plan.sourceRoot, 'Dockerfile'), 'utf8')), { mode: 0o600 });

    const buildArgs = [
      'buildx', 'build', '--load', '--progress=plain', '--network=none', '--pull=false', '--no-cache',
      '--file', offlineDockerfile,
      '--build-context', ociLayoutBuildContext('p10_node_base', localBase),
      '--build-context', `npm_deps=${plan.bundle}`,
      '--build-arg', `GIT_REVISION=${plan.sourceCommit}`,
      '-t', plan.outputImage, plan.sourceRoot,
    ];
    const built = run('docker', buildArgs);
    const combined = `${built.stdout ?? ''}\n${built.stderr ?? ''}`;
    assertNoRegistryActivity(combined);
    if (built.status !== 0) throw new Error(`docker buildx build failed with exit ${built.status}`);
    outputCreated = true;

    const outputId = capture('docker', ['image', 'inspect', plan.outputImage, '--format', '{{.Id}}']);
    if (!IMAGE_ID.test(outputId)) throw new Error('built image did not resolve to an immutable image ID');
    const revision = capture('docker', ['image', 'inspect', plan.outputImage, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}']);
    const source = capture('docker', ['image', 'inspect', plan.outputImage, '--format', '{{index .Config.Labels "org.opencontainers.image.source"}}']);
    if (revision !== plan.sourceCommit) throw new Error('built image revision label mismatch');
    if (source !== SOURCE_URL) throw new Error('built image source label mismatch');
    if (capture('docker', ['image', 'inspect', BASE_IMAGE, '--format', '{{.Id}}']) !== baseId) throw new Error('local base identity changed during build');

    return { outputImage: plan.outputImage, outputImageId: outputId, sourceCommit: plan.sourceCommit, sourceUrl: source, baseImage: BASE_IMAGE, baseImageId: baseId, registryActivity: false };
  } catch (error) {
    if (imageExists(plan.outputImage)) {
      spawnSync('docker', ['image', 'rm', '-f', plan.outputImage], { stdio: 'ignore', shell: false });
    }
    throw error;
  } finally {
    cleanupLocalOciLayout(localBase);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const result = buildCoreOffline();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`P10 offline core build refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
