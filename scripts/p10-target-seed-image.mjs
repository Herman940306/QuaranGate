#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { assertNoRegistryActivity, cleanupLocalOciLayout, materializeLocalOciLayout, ociLayoutBuildContext } from './offline-local-base.mjs';

const HEX40 = /^[0-9a-f]{40}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const SAFE_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u;
const SOURCE_URL = 'https://github.com/Herman940306/QuaranGate';
const PROBE_SCRIPT = String.raw`set -eu
for tool in git grep find ps yes head; do command -v "$tool" >/dev/null; done
test "$(cat /workspace/README.md)" = "hello from workspace"
test "$(cat /workspace/src/app.ts)" = "export const x = 1;"
test "$(cat /secretzone/secret.txt)" = "TOP SECRET - must never be reachable via the bridge"
test "$(readlink /workspace/escape-passwd)" = "/etc/passwd"
test "$(readlink /workspace/escape-dir)" = "/secretzone"
test "$(git -C /workspace rev-parse --is-inside-work-tree)" = "true"
test "$(git -C /workspace log -1 --pretty=%s)" = "initial"
printf 'TARGET_SEED_CONTRACT=PASS\n'`;

function argMap(argv) {
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

export function targetSeedPlan(argv, pid = process.pid) {
  const args = argMap(argv);
  const seedImage = required(args, '--seed-image');
  const outputImage = required(args, '--output-image');
  const sourceCommit = required(args, '--source-commit');
  if (!SAFE_IMAGE_REF.test(seedImage)) throw new Error('--seed-image has an invalid image reference');
  if (!SAFE_IMAGE_REF.test(outputImage)) throw new Error('--output-image has an invalid image reference');
  if (seedImage === outputImage) throw new Error('seed and output image references must differ');
  if (!HEX40.test(sourceCommit)) throw new Error('--source-commit must be 40 lowercase hex');
  return { seedImage, outputImage, sourceCommit, suffix: `${sourceCommit.slice(0, 12)}-${pid}`, sourceUrl: SOURCE_URL, probeScript: PROBE_SCRIPT };
}

function runCapture(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${command} ${argv.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function imageExists(ref) {
  const r = spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore', shell: false });
  return r.status === 0;
}

function inspect(ref, format) {
  return runCapture('docker', ['image', 'inspect', ref, '--format', format]);
}

export function qualifyTargetSeed(argv = process.argv.slice(2)) {
  const plan = targetSeedPlan(argv);
  let outputCreated = false;
  let localSeed = null;
  let tempRoot = null;
  try {
    if (imageExists(plan.outputImage)) throw new Error(`output image already exists: ${plan.outputImage}`);

    const seedId = inspect(plan.seedImage, '{{.Id}}');
    if (!IMAGE_ID.test(seedId)) throw new Error('seed image did not resolve to an immutable image ID');
    const seedWorkingDir = inspect(plan.seedImage, '{{.Config.WorkingDir}}');
    if (seedWorkingDir !== '/workspace') throw new Error(`seed image WorkingDir mismatch: ${seedWorkingDir}`);
    const seedCmd = JSON.parse(inspect(plan.seedImage, '{{json .Config.Cmd}}'));
    if (JSON.stringify(seedCmd) !== JSON.stringify(['sh', '-c', 'while true; do sleep 3600; done'])) {
      throw new Error(`seed image Cmd mismatch: ${JSON.stringify(seedCmd)}`);
    }
    const seedLayers = JSON.parse(inspect(plan.seedImage, '{{json .RootFS.Layers}}'));
    if (!Array.isArray(seedLayers) || seedLayers.length === 0) throw new Error('seed image has no rootfs layers');

    const probe = runCapture('docker', [
      'run', '--rm', '--network', 'none', '--entrypoint', 'sh', seedId, '-ec', plan.probeScript,
    ]);
    if (!probe.split(/\r?\n/u).includes('TARGET_SEED_CONTRACT=PASS')) throw new Error('seed target contract probe did not pass');

    localSeed = materializeLocalOciLayout(seedId, `quarangate-p10-target-base-${plan.suffix}-`);
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'quarangate-p10-target-wrapper-'));
    writeFileSync(path.join(tempRoot, 'Dockerfile'), [
      'FROM p10_seed',
      'ARG SOURCE_REVISION',
      `LABEL org.opencontainers.image.source="${plan.sourceUrl}"`,
      'LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"',
      'LABEL io.quarangate.p10.role="integration-target"',
      '',
    ].join('\n'), { mode: 0o600 });

    const built = spawnSync('docker', [
      'buildx', 'build', '--load', '--progress=plain', '--network=none', '--pull=false',
      '--build-context', ociLayoutBuildContext('p10_seed', localSeed),
      '--build-arg', `SOURCE_REVISION=${plan.sourceCommit}`,
      '-t', plan.outputImage, tempRoot,
    ], { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
    if (built.error) throw built.error;
    const combined = `${built.stdout ?? ''}\n${built.stderr ?? ''}`;
    assertNoRegistryActivity(combined);
    if (built.status !== 0) {
      const detail = built.stderr?.trim() || built.stdout?.trim() || '';
      throw new Error(`docker buildx build failed${detail ? `: ${detail}` : ''}`);
    }
    outputCreated = true;

    const outputId = inspect(plan.outputImage, '{{.Id}}');
    if (!IMAGE_ID.test(outputId)) throw new Error('output image did not resolve to an immutable image ID');
    if (inspect(plan.outputImage, '{{index .Config.Labels "org.opencontainers.image.revision"}}') !== plan.sourceCommit) throw new Error('output revision label mismatch');
    if (inspect(plan.outputImage, '{{index .Config.Labels "org.opencontainers.image.source"}}') !== plan.sourceUrl) throw new Error('output source label mismatch');
    if (inspect(plan.outputImage, '{{index .Config.Labels "io.quarangate.p10.role"}}') !== 'integration-target') throw new Error('output P10 role label mismatch');
    if (inspect(plan.outputImage, '{{.Config.WorkingDir}}') !== seedWorkingDir) throw new Error('output WorkingDir drifted from seed');
    const outputCmd = JSON.parse(inspect(plan.outputImage, '{{json .Config.Cmd}}'));
    if (JSON.stringify(outputCmd) !== JSON.stringify(seedCmd)) throw new Error('output Cmd drifted from seed');
    const outputLayers = JSON.parse(inspect(plan.outputImage, '{{json .RootFS.Layers}}'));
    if (JSON.stringify(outputLayers) !== JSON.stringify(seedLayers)) throw new Error('output rootfs layers drifted from qualified seed');
    if (inspect(plan.seedImage, '{{.Id}}') !== seedId) throw new Error('seed image identity changed during wrapper build');

    return { seedImage: plan.seedImage, seedImageId: seedId, outputImage: plan.outputImage, outputImageId: outputId, sourceCommit: plan.sourceCommit, sourceUrl: plan.sourceUrl, rootfsLayers: outputLayers.length };
  } catch (error) {
    if (imageExists(plan.outputImage)) spawnSync('docker', ['image', 'rm', '-f', plan.outputImage], { stdio: 'ignore', shell: false });
    throw error;
  } finally {
    cleanupLocalOciLayout(localSeed);
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const result = qualifyTargetSeed();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`P10 target seed qualification refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
