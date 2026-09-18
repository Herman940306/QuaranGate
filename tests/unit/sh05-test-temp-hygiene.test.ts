import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOwnedTestTempRoot,
  isolatedTestEnvironment,
  ownedTestTempRootPath,
  runVitestClean,
  signalExitCode,
  testTempBase,
  vitestInvocationArgs,
} from '../../scripts/run-vitest-clean.mjs';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fakeChild(onSpawn: (options: any) => void, code = 0, signal: NodeJS.Signals | null = null) {
  return (_binary: string, _args: string[], options: any) => {
    onSpawn(options);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = (received: NodeJS.Signals) => { child.signalCode = received; queueMicrotask(() => child.emit('close', null, received)); return true; };
    queueMicrotask(() => { if (child.signalCode === null) { child.exitCode = code; child.emit('close', code, signal); } });
    return child;
  };
}

describe('SH-05 self-cleaning Vitest temp-root wrapper', () => {
  it('uses the fixed short exclusive /tmp/q root on Unix so IDE socket paths stay bounded', () => {
    expect(testTempBase('linux')).toBe('/tmp');
    expect(ownedTestTempRootPath('/tmp', 'linux')).toBe('/tmp/q');
    expect('/tmp/q'.length).toBeLessThanOrEqual(10);
    const parent = mkdtempSync(join(tmpdir(), 'qgt-root-test-')); owned.push(parent);
    const root = createOwnedTestTempRoot(parent, 'linux'); owned.push(root);
    expect(root).toBe(join(parent, 'q'));
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('fails closed when the exclusive Unix temp root is already occupied and never reclaims it', () => {
    const parent = mkdtempSync(join(tmpdir(), 'qgt-busy-test-')); owned.push(parent);
    const root = createOwnedTestTempRoot(parent, 'linux'); owned.push(root);
    writeFileSync(join(root, 'sentinel'), 'preserve');
    expect(() => createOwnedTestTempRoot(parent, 'linux')).toThrow(/already occupied/u);
    expect(readFileSync(join(root, 'sentinel'), 'utf8')).toBe('preserve');
  });

  it('always invokes the source-controlled Vitest entry point without a shell', () => {
    const args = vitestInvocationArgs(['tests/unit', '--no-file-parallelism']);
    expect(args[0]).toMatch(/node_modules\/vitest\/vitest\.mjs$/u);
    expect(args.slice(1)).toEqual(['run', '--configLoader', 'native', 'tests/unit', '--no-file-parallelism']);
  });

  it('removes inherited Git repository controls before any test process starts', () => {
    const env = isolatedTestEnvironment('/tmp/q', {
      PATH: '/usr/bin',
      GIT_DIR: '/valuable/repository/.git',
      GIT_WORK_TREE: '/valuable/repository',
      GIT_COMMON_DIR: '/valuable/repository/.git',
      GIT_INDEX_FILE: '/valuable/repository/.git/index',
      GIT_AUTHOR_NAME: 'Fixture Identity',
      git_config_global: '/valuable/global-config',
      Git_Object_Directory: '/valuable/repository/.git/objects',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.git_config_global).toBeUndefined();
    expect(env.Git_Object_Directory).toBeUndefined();
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/tmp/q/.test-global-gitconfig');
  });

  it('contains fixture files under the owned root and removes only that root after success', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'qgt-wrapper-test-')); owned.push(parent);
    const sentinel = join(parent, 'outside-sentinel'); writeFileSync(sentinel, 'keep');
    let observedRoot = '';
    const result = await runVitestClean(['tests/unit/ratelimit.test.ts'], {
      tempBase: parent,
      spawnImpl: fakeChild((options) => {
        observedRoot = options.env.TMPDIR;
        expect(options.env.TMP).toBe(observedRoot); expect(options.env.TEMP).toBe(observedRoot);
        expect(options.shell).toBe(false);
        writeFileSync(join(observedRoot, 'fixture-byte'), 'owned');
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(observedRoot)).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
  });

  it('propagates child failure while still cleaning the owned root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'qgt-wrapper-fail-')); owned.push(parent);
    let observedRoot = '';
    const result = await runVitestClean(['tests/unit/ratelimit.test.ts'], {
      tempBase: parent,
      spawnImpl: fakeChild((options) => { observedRoot = options.env.TMPDIR; writeFileSync(join(observedRoot, 'failure-byte'), 'owned'); }, 7),
    });
    expect(result.exitCode).toBe(7);
    expect(existsSync(observedRoot)).toBe(false);
  });

  it('uses conventional bounded exit codes for forwarded termination signals', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(signalExitCode('SIGHUP')).toBe(129);
    expect(signalExitCode('SIGUSR1')).toBe(1);
  });
});
