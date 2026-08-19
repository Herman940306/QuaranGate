/**
 * fs_write / fs_patch archive ownership.
 *
 * Docker extracts an uploaded archive as the daemon (root) and applies the tar
 * header's uid/gid verbatim. A header without them lands root-owned, which made
 * files written through the bridge uneditable by the target's own user. These
 * tests pin the header the executor produces, and pin that unresolvable
 * identity fails closed rather than silently writing 0:0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { extract, pack } from 'tar-stream';
import { BridgeError } from '../../src/shared/errors.js';

// Docker calls are stubbed: no daemon, fully deterministic.
vi.mock('../../src/executor/docker.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/executor/docker.js')>('../../src/executor/docker.js');
  return {
    ...actual,
    putArchive: vi.fn().mockResolvedValue(undefined),
    getArchive: vi.fn(),
  };
});

// Confinement/exec are stubbed: path security has its own suite (pathcheck),
// here we control exactly what the in-target ownership probe reports.
vi.mock('../../src/executor/execops.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/executor/execops.js')>('../../src/executor/execops.js');
  return {
    ...actual,
    confinePath: vi.fn(),
    runArgv: vi.fn(),
  };
});

import * as dockerStub from '../../src/executor/docker.js';
import * as execStub from '../../src/executor/execops.js';
import { writeFile, patchFile, resolveWriteOwnership } from '../../src/executor/fsops.js';
import type { ConfinedTarget } from '../../src/executor/execops.js';

const TARGET: ConfinedTarget = { containerId: 'container-abc', workspace: '/workspace' };

const putArchive = dockerStub.putArchive as ReturnType<typeof vi.fn>;
const getArchive = dockerStub.getArchive as ReturnType<typeof vi.fn>;
const confinePath = execStub.confinePath as ReturnType<typeof vi.fn>;
const runArgv = execStub.runArgv as ReturnType<typeof vi.fn>;

function execResult(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: '', truncated: false, timedOut: false, durationMs: 1 };
}

/**
 * Drive the ownership probe: `mkdir -p` returns nothing, the tagged probe
 * returns `probeStdout`. Any further exec returns empty.
 */
function withProbe(probeStdout: string): void {
  runArgv.mockImplementation(async (_t: unknown, argv: string[]) => {
    if (argv[0] === 'mkdir') return execResult('');
    if (argv[0] === '/bin/sh') return execResult(probeStdout);
    return execResult('');
  });
}

/** Parse the single file entry out of the tar handed to putArchive. */
async function capturedEntry(): Promise<{ name: string; uid: number; gid: number; uname: string; gname: string; mode: number; content: string }> {
  expect(putArchive).toHaveBeenCalledTimes(1);
  const buf = putArchive.mock.calls[0][2] as Buffer;
  return new Promise((resolve, reject) => {
    const ex = extract();
    let done = false;
    ex.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        if (!done) {
          done = true;
          resolve({
            name: header.name,
            uid: header.uid as number,
            gid: header.gid as number,
            uname: (header.uname ?? '') as string,
            gname: (header.gname ?? '') as string,
            mode: header.mode as number,
            content: Buffer.concat(chunks).toString('utf8'),
          });
        }
        next();
      });
    });
    ex.on('error', reject);
    ex.on('finish', () => { if (!done) reject(new Error('no tar entry')); });
    Readable.from(buf).pipe(ex);
  });
}

/** A tar stream as getArchive would return it (used by readFile/patchFile). */
async function tarOf(name: string, content: string): Promise<Buffer> {
  const p = pack();
  p.entry({ name, size: Buffer.byteLength(content), mode: 0o644 }, content);
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const c of p) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeEach(() => {
  vi.clearAllMocks();
  confinePath.mockImplementation(async (_t: unknown, rel: string) => `/workspace/${rel}`);
  putArchive.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. New file carries the resolved target identity
// ---------------------------------------------------------------------------

describe('new-file ownership', () => {
  it('carries the resolved uid/gid in the archive header', async () => {
    withProbe('id 1000 1000\n'); // no `st` line => path does not exist yet
    await writeFile(TARGET, 'new.txt', Buffer.from('hello'));
    const e = await capturedEntry();
    expect(e.name).toBe('new.txt');
    expect(e.content).toBe('hello');
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(1000);
  });

  it('never emits uname/gname, so extraction cannot resolve ownership by name', async () => {
    withProbe('id 1000 1000\n');
    await writeFile(TARGET, 'new.txt', Buffer.from('hello'));
    const e = await capturedEntry();
    expect(e.uname).toBe('');
    expect(e.gname).toBe('');
  });

  it('does not hard-code the host/developer identity — it follows the target', async () => {
    withProbe('id 501 20\n');
    await writeFile(TARGET, 'new.txt', Buffer.from('x'));
    expect((await capturedEntry()).uid).toBe(501);
    expect((await capturedEntry()).gid).toBe(20);
  });

  it('supports a root/default target identity', async () => {
    withProbe('id 0 0\n');
    await writeFile(TARGET, 'new.txt', Buffer.from('x'));
    const e = await capturedEntry();
    expect(e.uid).toBe(0);
    expect(e.gid).toBe(0);
  });

  it('supports the numeric UID-only Docker user form (gid defaults to 0)', async () => {
    withProbe('id 1000 0\n');
    await writeFile(TARGET, 'new.txt', Buffer.from('x'));
    const e = await capturedEntry();
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(0);
  });

  it('supports the numeric UID:GID Docker user form', async () => {
    withProbe('id 1000 2000\n');
    await writeFile(TARGET, 'new.txt', Buffer.from('x'));
    const e = await capturedEntry();
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(2000);
  });

  it('supports a NAMED container user by resolving it in-target to numeric ids', async () => {
    // `user: "work"` — the probe runs as that user and reports numbers, so the
    // executor never parses or trusts a name.
    withProbe('id 1000 1000\n');
    await writeFile(TARGET, 'new.txt', Buffer.from('x'));
    const e = await capturedEntry();
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(1000);
    // The probe is the only identity source; no Docker inspect of Config.User.
    const probeCall = runArgv.mock.calls.find((c) => (c[1] as string[])[0] === '/bin/sh');
    expect(probeCall).toBeDefined();
    expect((probeCall![1] as string[]).join(' ')).toContain('id -u');
  });
});

// ---------------------------------------------------------------------------
// 2. Existing files keep their ownership
// ---------------------------------------------------------------------------

describe('existing-file ownership preservation', () => {
  it('overwrite keeps the existing owner and does NOT become root-owned', async () => {
    // Probe identity is root, but the file on disk belongs to 1000:1000.
    withProbe('id 0 0\nst 1000 1000\n');
    await writeFile(TARGET, 'existing.txt', Buffer.from('overwritten'));
    const e = await capturedEntry();
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(1000);
  });

  it('overwrite keeps a third-party owner rather than re-owning to the runtime user', async () => {
    withProbe('id 1000 1000\nst 4242 4243\n');
    await writeFile(TARGET, 'existing.txt', Buffer.from('overwritten'));
    const e = await capturedEntry();
    expect(e.uid).toBe(4242);
    expect(e.gid).toBe(4243);
  });

  it('fs_patch preserves the existing ownership', async () => {
    getArchive.mockResolvedValue({ body: Readable.from(await tarOf('doc.txt', 'alpha BETA gamma')), statHeader: undefined });
    withProbe('id 0 0\nst 1000 1000\n');
    await patchFile(TARGET, 'doc.txt', 'BETA', 'DELTA');
    const e = await capturedEntry();
    expect(e.content).toBe('alpha DELTA gamma');
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// 3. Fail-closed identity resolution
// ---------------------------------------------------------------------------

describe('fail-closed ownership resolution', () => {
  const bad = [
    ['empty probe output', ''],
    ['id unavailable (empty substitution)', 'id  \n'],
    ['non-numeric ids', 'id root root\n'],
    ['negative uid', 'id -1 -1\n'],
    ['uid with too many digits', 'id 99999999999 0\n'],
    ['uid numerically beyond 32-bit', 'id 9999999999 0\n'],
    ['gid numerically beyond 32-bit', 'id 0 9999999999\n'],
    ['untagged output', '1000 1000\n'],
    ['unrelated noise', 'sh: id: not found\n'],
  ] as const;

  for (const [label, stdout] of bad) {
    it(`refuses to write when identity is unresolvable: ${label}`, async () => {
      withProbe(stdout);
      await expect(writeFile(TARGET, 'new.txt', Buffer.from('x'))).rejects.toMatchObject({
        code: 'TARGET_UNSUPPORTED',
      });
      // The critical property: nothing is uploaded, so nothing lands as 0:0.
      expect(putArchive).not.toHaveBeenCalled();
    });
  }

  it('a malformed `st` line falls back to the runtime identity, never to 0:0', async () => {
    withProbe('id 1000 1000\nst ? ?\n');
    await writeFile(TARGET, 'existing.txt', Buffer.from('x'));
    const e = await capturedEntry();
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(1000);
  });

  it('resolveWriteOwnership throws a typed BridgeError', async () => {
    withProbe('');
    await expect(resolveWriteOwnership(TARGET, '/workspace/x')).rejects.toBeInstanceOf(BridgeError);
  });

  it('refuses truncated probe output — a clipped line is a parseable prefix', async () => {
    // `st 1000 10` is what a cut `st 1000 1000` looks like, and it parses.
    runArgv.mockImplementation(async (_t: unknown, argv: string[]) => {
      if (argv[0] === 'mkdir') return execResult('');
      return { ...execResult('id 1000 1000\nst 1000 10'), truncated: true };
    });
    await expect(writeFile(TARGET, 'new.txt', Buffer.from('x'))).rejects.toMatchObject({
      code: 'TARGET_UNSUPPORTED',
    });
    expect(putArchive).not.toHaveBeenCalled();
  });

  it('the LAST tagged line wins, so prepended output cannot displace the real one', async () => {
    // A hostile/noisy target emitting a decoy before the genuine probe output.
    withProbe('id 0 0\nst 0 0\nid 1000 1000\nst 1000 1000\n');
    await writeFile(TARGET, 'existing.txt', Buffer.from('x'));
    const e = await capturedEntry();
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(1000);
  });

  it('an out-of-range id does not shadow a valid later one', async () => {
    withProbe('id 9999999999 0\nid 1000 1000\n');
    await writeFile(TARGET, 'new.txt', Buffer.from('x'));
    const e = await capturedEntry();
    expect(e.uid).toBe(1000);
    expect(e.gid).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// 4. Probe safety + read-only regressions
// ---------------------------------------------------------------------------

describe('probe safety', () => {
  it('passes the path as a positional argument, never interpolated into the script', async () => {
    withProbe('id 1000 1000\n');
    const nasty = "/workspace/a'; id -u 0 #";
    confinePath.mockResolvedValue(nasty);
    await writeFile(TARGET, 'weird.txt', Buffer.from('x'));
    const probe = runArgv.mock.calls.find((c) => (c[1] as string[])[0] === '/bin/sh')![1] as string[];
    expect(probe[2]).not.toContain(nasty); // the script body is a constant
    expect(probe[probe.length - 1]).toBe(nasty); // the path is argv $1
  });

  it('resolves ownership only after the path has been confined', async () => {
    withProbe('id 1000 1000\n');
    await writeFile(TARGET, 'sub/new.txt', Buffer.from('x'));
    expect(confinePath).toHaveBeenCalledWith(TARGET, 'sub/new.txt', { mustExist: false });
    const probe = runArgv.mock.calls.find((c) => (c[1] as string[])[0] === '/bin/sh')![1] as string[];
    expect(probe[probe.length - 1]).toBe('/workspace/sub/new.txt');
  });
});

describe('read-only regressions', () => {
  it('propagates a read-only-target archive rejection instead of masking it', async () => {
    withProbe('id 1000 1000\n');
    putArchive.mockRejectedValue(new BridgeError('DOCKER_UNAVAILABLE', 'archive put failed: 403 read-only file system', 502));
    await expect(writeFile(TARGET, 'blocked.txt', Buffer.from('x'))).rejects.toMatchObject({
      code: 'DOCKER_UNAVAILABLE',
    });
  });

  it('a nested read-only .git path is still uploaded under .git and rejected there', async () => {
    withProbe('id 1000 1000\n');
    putArchive.mockRejectedValue(new BridgeError('DOCKER_UNAVAILABLE', 'archive put failed: 403 read-only file system', 502));
    await expect(writeFile(TARGET, '.git/probe', Buffer.from('x'))).rejects.toMatchObject({
      code: 'DOCKER_UNAVAILABLE',
    });
    // Ownership resolution must not have been used to route the write elsewhere.
    expect(putArchive.mock.calls[0][1]).toBe('/workspace/.git');
  });
});
