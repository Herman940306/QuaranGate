/**
 * H1-2: Executor authority readiness tests.
 *
 * Covers the exact production failure class:
 *   HOST: /var/run/docker.sock = Unix socket
 *   EXECUTOR: /var/run/docker.sock = regular file (stale bind)
 *   Result: health reports OK but authority readiness fails.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReadiness, READYZ_TIMEOUT_MS } from '../../src/executor/readiness.js';

let tmpDir: string | null = null;

function makeTmp(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'h1-readiness-'));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    tmpDir = null;
  }
});

describe('checkReadiness — socket missing', () => {
  it('returns SOCKET_MISSING when path does not exist', async () => {
    const result = await checkReadiness('/nonexistent/path/docker.sock');
    expect(result.ready).toBe(false);
    expect(result.code).toBe('SOCKET_MISSING');
    expect(result.detail).toMatch(/does not exist/i);
  });
});

describe('checkReadiness — wrong file type (THE PRODUCTION FAILURE CLASS)', () => {
  it('returns SOCKET_WRONG_TYPE when socket path is a regular file (stale bind)', async () => {
    const dir = makeTmp();
    const fakeSock = join(dir, 'docker.sock');
    // Simulate the exact stale bind failure: bind creates a regular empty file
    // instead of mounting the Unix socket.
    writeFileSync(fakeSock, '');

    const result = await checkReadiness(fakeSock);
    expect(result.ready).toBe(false);
    expect(result.code).toBe('SOCKET_WRONG_TYPE');
    expect(result.detail).toMatch(/regular file/i);
    // Must not leak the path
    expect(result.detail).not.toContain(dir);
  });

  it('returns SOCKET_WRONG_TYPE when socket path is a directory', async () => {
    const dir = makeTmp();
    const dirPath = join(dir, 'docker.sock');
    mkdirSync(dirPath);

    const result = await checkReadiness(dirPath);
    expect(result.ready).toBe(false);
    expect(result.code).toBe('SOCKET_WRONG_TYPE');
    expect(result.detail).toMatch(/directory/i);
    expect(result.detail).not.toContain(dir);
  });
});

describe('checkReadiness — no path leak in responses', () => {
  it('does not include the socket path in any error response', async () => {
    const dir = makeTmp();
    const fakeSock = join(dir, 'docker.sock');
    writeFileSync(fakeSock, 'not a socket');

    const result = await checkReadiness(fakeSock);
    expect(result.detail).not.toContain(fakeSock);
    expect(result.detail).not.toContain(dir);
    expect(result.detail).not.toContain(tmpdir());
  });
});

describe('checkReadiness — READYZ_TIMEOUT_MS is bounded', () => {
  it('READYZ_TIMEOUT_MS is a positive number less than 10 seconds', () => {
    expect(typeof READYZ_TIMEOUT_MS).toBe('number');
    expect(READYZ_TIMEOUT_MS).toBeGreaterThan(0);
    expect(READYZ_TIMEOUT_MS).toBeLessThan(10_000);
  });
});

describe('checkReadiness — semantics', () => {
  it('result.ready is false when code is not READY', async () => {
    // Missing path → not ready
    const result = await checkReadiness('/absolutely/does/not/exist.sock');
    expect(result.ready).toBe(false);
    expect(result.code).not.toBe('READY');
  });

  it('result has required fields: ready (boolean), code (string), detail (string)', async () => {
    const result = await checkReadiness('/no/sock');
    expect(typeof result.ready).toBe('boolean');
    expect(typeof result.code).toBe('string');
    expect(typeof result.detail).toBe('string');
    expect(result.detail.length).toBeGreaterThan(0);
  });
});
