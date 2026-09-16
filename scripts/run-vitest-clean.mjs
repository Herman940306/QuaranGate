#!/usr/bin/env node
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const UNIX_TEST_TMP_BASE = '/tmp';
const UNIX_TEST_TMP_BASENAME = 'q';
const TEST_TMP_PREFIX = 'qgt-';
const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });

export function testTempBase(platform = process.platform) {
  return platform === 'win32' ? tmpdir() : UNIX_TEST_TMP_BASE;
}

export function ownedTestTempRootPath(base = testTempBase(), platform = process.platform) {
  return platform === 'win32' ? null : join(base, UNIX_TEST_TMP_BASENAME);
}

export function createOwnedTestTempRoot(base = testTempBase(), platform = process.platform) {
  if (platform === 'win32') {
    const root = mkdtempSync(join(base, TEST_TMP_PREFIX));
    chmodSync(root, 0o700);
    return root;
  }

  const root = ownedTestTempRootPath(base, platform);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Error(`exclusive Vitest temp root is already occupied: ${root}`);
    }
    throw error;
  }
  chmodSync(root, 0o700);
  return root;
}

export function vitestInvocationArgs(args) {
  return [resolve('node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'native', ...args];
}

export function signalExitCode(signal) {
  return SIGNAL_EXIT[signal] ?? 1;
}

export async function runVitestClean(args, deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const root = createOwnedTestTempRoot(deps.tempBase ?? testTempBase());
  let child = null;
  const handlers = new Map();
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  try {
    const env = { ...process.env, ...(deps.env ?? {}), TMPDIR: root, TMP: root, TEMP: root };
    child = spawnImpl(process.execPath, vitestInvocationArgs(args), {
      cwd: deps.cwd ?? process.cwd(),
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
    });
    child.stdout?.pipe?.(process.stdout);
    child.stderr?.pipe?.(process.stderr);

    for (const signal of Object.keys(SIGNAL_EXIT)) {
      const handler = () => {
        if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }

    return await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolveResult({ exitCode: Number.isInteger(code) ? code : signalExitCode(signal), signal: signal ?? null, tempRoot: root });
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    cleanup();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runVitestClean(argv);
  return result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`QuaranGate Vitest wrapper failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 125;
  }
}
