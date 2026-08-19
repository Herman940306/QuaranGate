/**
 * Control-character path integrity at the filesystem-operation boundary.
 *
 * The shared validator is the enforcement point, but the property that matters
 * operationally is *when* it fires: before anything reaches the target. The
 * executor canonicalizes with `readlink -f`, whose answer is one LF-framed
 * record; a path containing a newline makes that record ambiguous. The parser
 * now fails closed on it (see execops-canonical-path.test.ts), but the older
 * `stdout.trim().split('\n')[0]` silently truncated it to the first line —
 * `victim\nDECOY` operated on `victim`, the confinement check passed (the
 * truncated path is still inside the workspace) and the audit record still
 * showed the path the caller asked for.
 *
 * These tests drive the real confinePath through every fs operation with the
 * Docker layer stubbed, and assert that NO exec, NO archive get and NO archive
 * put ever happens for a control-character path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';

// Every Docker touchpoint is stubbed and counted. Reaching any of these with a
// control-character path is the defect.
vi.mock('../../src/executor/docker.js', () => ({
  execCreate: vi.fn(),
  execStartStream: vi.fn(),
  execInspect: vi.fn(),
  getArchive: vi.fn(),
  putArchive: vi.fn(),
}));

import * as docker from '../../src/executor/docker.js';
import { confinePath, parseCanonicalPathOutput, type ConfinedTarget } from '../../src/executor/execops.js';
import * as fsops from '../../src/executor/fsops.js';
import { BridgeError } from '../../src/shared/errors.js';

const execCreate = docker.execCreate as ReturnType<typeof vi.fn>;
const execStartStream = docker.execStartStream as ReturnType<typeof vi.fn>;
const execInspect = docker.execInspect as ReturnType<typeof vi.fn>;
const getArchive = docker.getArchive as ReturnType<typeof vi.fn>;
const putArchive = docker.putArchive as ReturnType<typeof vi.fn>;

const TARGET: ConfinedTarget = { containerId: 'container-abc', workspace: '/workspace' };

const VICTIM = '.mcp-control-path-test-victim';
const NL = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const TAB = String.fromCharCode(0x09);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0x00);

/**
 * The canonicalization the executor used to perform, reproduced exactly. Proves
 * the truncation was real rather than assumed — this is what would have
 * happened if the validator let the path through.
 */
function canonicalizeAsExecutorOnceDid(readlinkStdout: string): string | null {
  const line = readlinkStdout.trim().split('\n')[0];
  if (!line || !line.startsWith('/')) return null;
  return line;
}

/** A finished exec stream carrying `stdout`; `done` settles after both end. */
function execStream(stdoutText: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const done = new Promise<void>((resolve) => {
    let open = 2;
    const fin = () => { if (--open === 0) resolve(); };
    stdout.on('end', fin);
    stderr.on('end', fin);
  });
  setImmediate(() => {
    stdout.end(stdoutText);
    stderr.end();
  });
  return { stdout, stderr, done };
}

/**
 * A cooperating target: `readlink -f` echoes back the path it was given (what a
 * real one does for an existing path) and the ownership probe reports 1000:1000.
 * These stubs deliberately let an operation run to completion, so any test that
 * asserts "the target was never touched" is proving validation stopped it —
 * not that the stub happened to fail.
 */
function respondTo(cmd: string[]): string {
  const script = cmd[2] ?? '';
  if (script.includes('readlink -f')) return (cmd[cmd.length - 1] ?? '') + '\n';
  if (script.includes("printf 'id %s %s")) return 'id 1000 1000\n';
  return '';
}

beforeEach(() => {
  vi.clearAllMocks();
  const execCmds = new Map<string, string[]>();
  let seq = 0;
  execCreate.mockImplementation(async (_containerId: string, opts: { cmd: string[] }) => {
    const id = `exec-${++seq}`;
    execCmds.set(id, opts.cmd);
    return id;
  });
  execStartStream.mockImplementation(async (execId: string) => execStream(respondTo(execCmds.get(execId) ?? [])));
  execInspect.mockResolvedValue({ Running: false, ExitCode: 0, Pid: 0 });
  getArchive.mockResolvedValue({ body: new PassThrough(), statHeader: undefined });
  putArchive.mockResolvedValue(undefined);
});

/** No part of the target was touched. */
function expectTargetUntouched(): void {
  expect(execCreate).not.toHaveBeenCalled();
  expect(execStartStream).not.toHaveBeenCalled();
  expect(getArchive).not.toHaveBeenCalled();
  expect(putArchive).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// The defect this fix closes
// ---------------------------------------------------------------------------

describe('the truncation the validator now prevents', () => {
  it('canonicalization once collapsed a newline path to its prefix', () => {
    // `readlink -f -- "/workspace/victim\nDECOY"` prints the path it was given,
    // which spans two lines. The old executor kept the first.
    const readlinkOutput = '/workspace/' + VICTIM + NL + 'DECOY' + NL;
    expect(canonicalizeAsExecutorOnceDid(readlinkOutput)).toBe('/workspace/' + VICTIM);
    // Requested !== executed. This is the integrity failure. Two independent
    // layers now stop it: validation rejects the path first, and the canonical
    // parser refuses the ambiguous two-record answer.
    expect(parseCanonicalPathOutput({ stdout: readlinkOutput, truncated: false, timedOut: false }).ok).toBe(false);
  });

  it('the truncated prefix would still pass the confinement check', () => {
    // Which is why confinement alone never caught this: no workspace escape.
    const truncated = '/workspace/' + VICTIM;
    expect(truncated.startsWith('/workspace/')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Every fs operation rejects before touching the target
// ---------------------------------------------------------------------------

const CONTROL_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['newline', VICTIM + NL + 'DECOY'],
  ['CRLF', VICTIM + CR + NL + 'DECOY'],
  ['carriage return', VICTIM + CR],
  ['trailing tab', VICTIM + TAB],
  ['leading tab', TAB + VICTIM],
  ['ESC', VICTIM + ESC + '[2J'],
  ['DEL', VICTIM + DEL],
  ['NUL', VICTIM + NUL + 'DECOY'],
  ['bare newline', NL],
];

describe('fs operations reject control-character paths before execution', () => {
  const ops: ReadonlyArray<readonly [string, (p: string) => Promise<unknown>]> = [
    ['fs_read', (p) => fsops.readFile(TARGET, p)],
    ['fs_stat', (p) => fsops.statPath(TARGET, p)],
    ['fs_list', (p) => fsops.listDir(TARGET, p, 1)],
    ['fs_search', (p) => fsops.search(TARGET, p, 'needle', 10)],
    ['fs_write', (p) => fsops.writeFile(TARGET, p, Buffer.from('x'))],
    ['fs_patch', (p) => fsops.patchFile(TARGET, p, 'a', 'b')],
    ['fs_delete', (p) => fsops.deletePath(TARGET, p, false)],
    ['fs_delete (recursive)', (p) => fsops.deletePath(TARGET, p, true)],
    ['terminal_exec cwd', (p) => confinePath(TARGET, p, { mustExist: true })],
    ['exec argv cwd', (p) => confinePath(TARGET, p, { mustExist: false })],
  ];

  for (const [opName, run] of ops) {
    for (const [label, badPath] of CONTROL_PATHS) {
      it(`${opName} rejects ${label} without touching the target`, async () => {
        await expect(run(badPath)).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
        expectTargetUntouched();
      });
    }
  }

  it('rejects every C0 code point and DEL across the write path', async () => {
    for (const cp of [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f]) {
      vi.clearAllMocks();
      const p = VICTIM + String.fromCharCode(cp) + 'DECOY';
      await expect(
        fsops.writeFile(TARGET, p, Buffer.from('x')),
        `code point ${cp} must be rejected`,
      ).rejects.toBeInstanceOf(BridgeError);
      expectTargetUntouched();
    }
  });

  it('rejects every C0 code point and DEL across the delete path', async () => {
    for (const cp of [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f]) {
      vi.clearAllMocks();
      const p = VICTIM + String.fromCharCode(cp) + 'DECOY';
      await expect(
        fsops.deletePath(TARGET, p, true),
        `code point ${cp} must be rejected`,
      ).rejects.toBeInstanceOf(BridgeError);
      expectTargetUntouched();
    }
  });
});

// ---------------------------------------------------------------------------
// Targeted regressions for the reported surfaces
// ---------------------------------------------------------------------------

describe('fs_write cannot mutate a prefix target', () => {
  it('never uploads an archive for a newline path', async () => {
    await expect(fsops.writeFile(TARGET, VICTIM + NL + 'DECOY', Buffer.from('OWNED'))).rejects.toMatchObject({
      code: 'PATH_VIOLATION',
    });
    expect(putArchive).not.toHaveBeenCalled();
    // Nothing was written under the victim's directory either.
    expect(putArchive.mock.calls).toHaveLength(0);
  });

  it('the identically-named legitimate path still works', async () => {
    // Same victim name, no control characters: the fix is not over-broad.
    await fsops.writeFile(TARGET, VICTIM, Buffer.from('legit'));
    expect(putArchive).toHaveBeenCalledTimes(1);
    expect(putArchive.mock.calls[0][1]).toBe('/workspace');
  });
});

describe('fs_delete cannot delete a prefix target', () => {
  it('never issues rm for a newline path', async () => {
    await expect(fsops.deletePath(TARGET, VICTIM + NL + 'DECOY', true)).rejects.toMatchObject({
      code: 'PATH_VIOLATION',
    });
    expectTargetUntouched();
  });

  it('a bare newline cannot canonicalize to the workspace root', async () => {
    // The pre-existing root guard compares against '' and '.', so a lone
    // newline slipped past it; canonicalization would then land on /workspace
    // and `rm -rf -- /workspace` would run. Validation now rejects first.
    await expect(fsops.deletePath(TARGET, NL, true)).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
    expectTargetUntouched();
  });
});

describe('fs_patch cannot target a different file', () => {
  it('rejects before reading the file it would rewrite', async () => {
    await expect(fsops.patchFile(TARGET, VICTIM + NL + 'DECOY', 'old', 'new')).rejects.toMatchObject({
      code: 'PATH_VIOLATION',
    });
    expect(getArchive).not.toHaveBeenCalled();
    expect(putArchive).not.toHaveBeenCalled();
  });
});

describe('read/stat fail before accessing a transformed path', () => {
  it('fs_read never opens an archive stream', async () => {
    await expect(fsops.readFile(TARGET, VICTIM + NL + 'DECOY')).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
    expect(getArchive).not.toHaveBeenCalled();
  });

  it('fs_stat never execs', async () => {
    await expect(fsops.statPath(TARGET, VICTIM + CR)).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
    expect(execCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No collateral damage
// ---------------------------------------------------------------------------

describe('legitimate paths are unaffected', () => {
  it('an ordinary path still canonicalizes through the target', async () => {
    const abs = await confinePath(TARGET, VICTIM, { mustExist: true });
    expect(abs).toBe('/workspace/' + VICTIM);
    expect(execCreate).toHaveBeenCalled();
  });

  it('a printable Unicode path still canonicalizes through the target', async () => {
    const abs = await confinePath(TARGET, '文档/说明.md', { mustExist: true });
    expect(abs).toBe('/workspace/文档/说明.md');
  });

  it('paths with spaces and shell metacharacters still work', async () => {
    const abs = await confinePath(TARGET, 'my file $(x).txt', { mustExist: true });
    expect(abs).toBe('/workspace/my file $(x).txt');
  });
});
