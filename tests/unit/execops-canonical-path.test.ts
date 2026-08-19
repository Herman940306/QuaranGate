/**
 * Canonical-path output parsing.
 *
 * `readlink -f` / `realpath` emit exactly ONE record terminated by a single LF.
 * The former parser read that with `stdout.trim().split('\n')[0]`, which is not
 * a framing rule — it is a whitespace rule. `trim()` removes every character in
 * the ECMAScript WhiteSpace + LineTerminator set, and most of those are ordinary
 * printable filename characters on a POSIX filesystem. Consequences observed:
 *
 *   fs_write("victim ")  -> canonicalized to "/workspace/victim"  (wrong file)
 *   fs_stat(" ")         -> canonicalized to "/workspace"         (the root)
 *
 * The second one mattered most: `fs_delete(" ", recursive)` cleared the
 * pre-canonicalization root guard (" " is neither "" nor ".") and then
 * canonicalized onto the workspace root.
 *
 * These tests pin the framing semantics: strip exactly one trailing LF, preserve
 * every remaining character verbatim, and fail closed on anything ambiguous.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile as readSourceFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';

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

const execCreate = docker.execCreate as ReturnType<typeof vi.fn>;
const execStartStream = docker.execStartStream as ReturnType<typeof vi.fn>;
const execInspect = docker.execInspect as ReturnType<typeof vi.fn>;
const putArchive = docker.putArchive as ReturnType<typeof vi.fn>;

const TARGET: ConfinedTarget = { containerId: 'container-abc', workspace: '/workspace' };
const VICTIM = '.mcp-canonical-path-test-victim';

const ch = (cp: number) => String.fromCharCode(cp);
const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

/** A clean exec result carrying `stdout`; the shape the parser consumes. */
const okResult = (stdout: string) => ({ stdout, truncated: false, timedOut: false });

// ---------------------------------------------------------------------------
// The ECMAScript trim-sensitive character set
// ---------------------------------------------------------------------------

/**
 * Every code point `String.prototype.trim()` strips: WhiteSpace (TAB, VT, FF,
 * SP, NBSP, ZWNBSP, and Unicode Space_Separator) plus LineTerminator (LF, CR,
 * LS, PS). Derived from the engine, not hand-listed, so the set cannot drift.
 */
const TRIM_SENSITIVE: number[] = (() => {
  const found: number[] = [];
  for (let cp = 0; cp <= 0xffff; cp++) if (ch(cp).trim() === '') found.push(cp);
  return found;
})();

const isControl = (cp: number) => cp <= 0x1f || cp === 0x7f;
/** Trim-sensitive characters that are legitimate, printable path characters. */
const PRINTABLE_TRIMMED = TRIM_SENSITIVE.filter((cp) => !isControl(cp));

describe('the trim-sensitive set the old parser destroyed', () => {
  it('contains every reported character', () => {
    for (const cp of [0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) {
      expect(TRIM_SENSITIVE, `${hex(cp)} must be trim-sensitive`).toContain(cp);
    }
    for (let cp = 0x2000; cp <= 0x200a; cp++) expect(TRIM_SENSITIVE, hex(cp)).toContain(cp);
  });

  it('is mostly printable characters, not control characters', () => {
    expect(PRINTABLE_TRIMMED.length).toBeGreaterThan(15);
    // The control members are exactly TAB, LF, VT, FF, CR.
    expect(TRIM_SENSITIVE.filter(isControl)).toEqual([0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
  });

  it('trim() really does rewrite a suffixed path onto a different file', () => {
    // The defect, reproduced. `readlink -f -- "/workspace/victim "` echoes the
    // path it was given; the old parser then returned the unsuffixed sibling.
    const out = '/workspace/' + VICTIM + ' \n';
    expect(out.trim().split('\n')[0]).toBe('/workspace/' + VICTIM);
    expect(parseCanonicalPathOutput(okResult(out))).toEqual({ ok: true, path: '/workspace/' + VICTIM + ' ' });
  });

  it('trim() really does collapse a lone space onto the workspace root', () => {
    // fs_stat(" ") / fs_delete(" ") join to "/workspace/ ", which readlink -f
    // echoes back. trim() eats the space and leaves "/workspace/" — the root
    // itself, which `stat` and `rm -rf` both treat as /workspace.
    const out = '/workspace/ \n';
    expect(out.trim().split('\n')[0]).toBe('/workspace/');
    expect(out.trim().split('\n')[0].replace(/\/+$/, '')).toBe('/workspace');
    expect(parseCanonicalPathOutput(okResult(out))).toEqual({ ok: true, path: '/workspace/ ' });
  });
});

// ---------------------------------------------------------------------------
// Preservation
// ---------------------------------------------------------------------------

describe('parseCanonicalPathOutput preserves the record verbatim', () => {
  it('parses an ordinary path', () => {
    expect(parseCanonicalPathOutput(okResult('/workspace/src/index.ts\n'))).toEqual({
      ok: true,
      path: '/workspace/src/index.ts',
    });
  });

  it('preserves a single trailing ASCII space', () => {
    expect(parseCanonicalPathOutput(okResult('/workspace/victim \n'))).toEqual({
      ok: true,
      path: '/workspace/victim ',
    });
  });

  it('preserves multiple trailing ASCII spaces', () => {
    expect(parseCanonicalPathOutput(okResult('/workspace/victim   \n'))).toEqual({
      ok: true,
      path: '/workspace/victim   ',
    });
  });

  it('preserves leading, interior and trailing spaces together', () => {
    expect(parseCanonicalPathOutput(okResult('/workspace/ leading/mid dle/trailing \n'))).toEqual({
      ok: true,
      path: '/workspace/ leading/mid dle/trailing ',
    });
  });

  it('preserves a path whose basename is a single space', () => {
    // The fs_delete(" ") route. This MUST stay distinct from "/workspace".
    const parsed = parseCanonicalPathOutput(okResult('/workspace/ \n'));
    expect(parsed).toEqual({ ok: true, path: '/workspace/ ' });
    expect((parsed as { path: string }).path).not.toBe('/workspace');
  });

  for (const [name, cp] of [
    ['U+0020 SPACE', 0x20],
    ['U+00A0 NO-BREAK SPACE', 0xa0],
    ['U+1680 OGHAM SPACE MARK', 0x1680],
    ['U+2028 LINE SEPARATOR', 0x2028],
    ['U+2029 PARAGRAPH SEPARATOR', 0x2029],
    ['U+202F NARROW NO-BREAK SPACE', 0x202f],
    ['U+205F MEDIUM MATHEMATICAL SPACE', 0x205f],
    ['U+3000 IDEOGRAPHIC SPACE', 0x3000],
    ['U+FEFF ZERO WIDTH NO-BREAK SPACE', 0xfeff],
  ] as ReadonlyArray<readonly [string, number]>) {
    it(`preserves a trailing ${name}`, () => {
      const p = '/workspace/' + VICTIM + ch(cp);
      expect(parseCanonicalPathOutput(okResult(p + '\n'))).toEqual({ ok: true, path: p });
    });
  }

  it('preserves every trailing U+2000..U+200A', () => {
    for (let cp = 0x2000; cp <= 0x200a; cp++) {
      const p = '/workspace/' + VICTIM + ch(cp);
      expect(parseCanonicalPathOutput(okResult(p + '\n')), hex(cp)).toEqual({ ok: true, path: p });
    }
  });

  it('preserves EVERY printable trim-sensitive character, in every position', () => {
    for (const cp of PRINTABLE_TRIMMED) {
      const c = ch(cp);
      for (const p of [
        '/workspace/' + VICTIM + c, // trailing
        '/workspace/' + c + VICTIM, // leading in the basename
        '/workspace/' + VICTIM + c + VICTIM, // interior
        '/workspace/' + c, // the whole basename
        '/workspace/' + c + c + c, // repeated
        '/workspace/' + c + '/' + VICTIM, // an intermediate directory
      ]) {
        expect(parseCanonicalPathOutput(okResult(p + '\n')), `${hex(cp)} in ${JSON.stringify(p)}`).toEqual({
          ok: true,
          path: p,
        });
      }
    }
  });

  it('preserves other printable Unicode untouched', () => {
    for (const p of ['/workspace/文档/说明.md', '/workspace/emoji-\u{1f642}', '/workspace/naïve', '/workspace/a$(x) b']) {
      expect(parseCanonicalPathOutput(okResult(p + '\n'))).toEqual({ ok: true, path: p });
    }
  });

  it('applies no Unicode normalization', () => {
    // NFD "e + combining acute" must not become NFC "é": on Linux those are two
    // different filenames, and silently swapping them is the same class of bug.
    const nfd = '/workspace/é.txt';
    const nfc = '/workspace/é.txt';
    const parsed = parseCanonicalPathOutput(okResult(nfd + '\n'));
    expect(parsed).toEqual({ ok: true, path: nfd });
    expect((parsed as { path: string }).path).not.toBe(nfc);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed framing
// ---------------------------------------------------------------------------

describe('parseCanonicalPathOutput fails closed on ambiguous output', () => {
  const rejects: ReadonlyArray<readonly [string, Parameters<typeof parseCanonicalPathOutput>[0]]> = [
    ['missing final LF', okResult('/workspace/a')],
    ['missing final LF with a trailing space', okResult('/workspace/a ')],
    ['bare LF (empty record)', okResult('\n')],
    ['double LF', okResult('/workspace/a\n\n')],
    ['truncated output', { stdout: '/workspace/a\n', truncated: true, timedOut: false }],
    ['truncated output without terminator', { stdout: '/workspace/a', truncated: true, timedOut: false }],
    ['truncated empty output', { stdout: '', truncated: true, timedOut: false }],
    ['timed out', { stdout: '/workspace/a\n', truncated: false, timedOut: true }],
    ['embedded LF (two records)', okResult('/workspace/a\n/workspace/b\n')],
    ['embedded LF mid-record', okResult('/workspace/a\nDECOY\n')],
    ['three records', okResult('/a\n/b\n/c\n')],
    ['embedded CR', okResult('/workspace/a\rDECOY\n')],
    ['CRLF framing', okResult('/workspace/a\r\n')],
    ['leading CR', okResult('\r/workspace/a\n')],
    ['embedded TAB', okResult('/workspace/a' + ch(0x09) + 'b\n')],
    ['embedded VT', okResult('/workspace/a' + ch(0x0b) + 'b\n')],
    ['embedded FF', okResult('/workspace/a' + ch(0x0c) + 'b\n')],
    ['embedded NUL', okResult('/workspace/a' + ch(0x00) + 'b\n')],
    ['embedded ESC', okResult('/workspace/a' + ch(0x1b) + '[2Jb\n')],
    ['embedded DEL', okResult('/workspace/a' + ch(0x7f) + 'b\n')],
    ['relative result', okResult('workspace/a\n')],
    ['error text instead of a path', okResult('readlink: missing operand\n')],
    ['whitespace-only relative result', okResult(' \n')],
    ['NBSP-only relative result', okResult(ch(0xa0) + '\n')],
  ];

  for (const [label, input] of rejects) {
    it(`rejects ${label}`, () => {
      const parsed = parseCanonicalPathOutput(input);
      expect(parsed.ok).toBe(false);
      // Ambiguous output is fatal, never the soft "does not resolve" answer.
      expect(parsed).toMatchObject({ unresolved: false });
    });
  }

  it('reports empty output as unresolved rather than as a path', () => {
    // Both readlink and realpath failed: the path does not resolve. No path is
    // returned, so this is still fail-closed — just recoverable by the caller.
    expect(parseCanonicalPathOutput(okResult(''))).toEqual({ ok: false, unresolved: true });
  });

  it('never returns a path for any rejected input', () => {
    for (const [label, input] of rejects) {
      expect(parseCanonicalPathOutput(input), label).not.toHaveProperty('path');
    }
  });

  it('rejects every C0 control character and DEL inside the record', () => {
    for (const cp of [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f]) {
      expect(parseCanonicalPathOutput(okResult('/workspace/a' + ch(cp) + 'b\n')).ok, hex(cp)).toBe(false);
    }
  });
});

describe('the canonicalization source uses no trim', () => {
  it('contains no trim/trimStart/trimEnd call', async () => {
    const src = await readSourceFile(new URL('../../src/executor/execops.ts', import.meta.url), 'utf8');
    const start = src.indexOf('export function parseCanonicalPathOutput');
    const end = src.indexOf('export interface ConfinedTarget');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Comments legitimately name the old `stdout.trim()` behaviour; strip them
    // so this asserts on code only.
    const code = src
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\.trim(Start|End)?\s*\(/);
    expect(code).not.toMatch(/split\(['"]\\n['"]\)/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through confinePath / fsops, with Docker stubbed
// ---------------------------------------------------------------------------

function execStream(stdoutText: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const done = new Promise<void>((resolve) => {
    let open = 2;
    const fin = () => {
      if (--open === 0) resolve();
    };
    stdout.on('end', fin);
    stderr.on('end', fin);
  });
  setImmediate(() => {
    stdout.end(stdoutText);
    stderr.end();
  });
  return { stdout, stderr, done };
}

/** Commands the stubbed target was asked to run, in order. */
let ranCmds: string[][];

/**
 * Install a target whose `readlink -f` answers with `readlink(requestedPath)`.
 * The ownership probe cooperates (1000:1000) so writes can run to completion —
 * a test asserting "rm never ran" then proves a guard fired, not a broken stub.
 */
function installTarget(readlink: (requested: string) => string): void {
  const execCmds = new Map<string, string[]>();
  let seq = 0;
  execCreate.mockImplementation(async (_id: string, opts: { cmd: string[] }) => {
    const id = `exec-${++seq}`;
    execCmds.set(id, opts.cmd);
    ranCmds.push(opts.cmd);
    return id;
  });
  execStartStream.mockImplementation(async (execId: string) => {
    const cmd = execCmds.get(execId) ?? [];
    const script = cmd[2] ?? '';
    if (script.includes('readlink -f')) return execStream(readlink(cmd[cmd.length - 1] ?? ''));
    if (script.includes("printf 'id %s %s")) return execStream('id 1000 1000\n');
    return execStream('');
  });
  execInspect.mockResolvedValue({ Running: false, ExitCode: 0, Pid: 0 });
}

/** The honest target: echoes the path back, LF-terminated, exactly as given. */
const echoBack = (p: string) => p + '\n';

beforeEach(() => {
  vi.clearAllMocks();
  ranCmds = [];
  putArchive.mockResolvedValue(undefined);
  installTarget(echoBack);
});

describe('confinePath preserves whitespace-suffixed paths', () => {
  for (const [name, cp] of [
    ['SPACE', 0x20],
    ['NBSP', 0xa0],
    ['U+3000', 0x3000],
    ['U+2028', 0x2028],
    ['U+FEFF', 0xfeff],
  ] as ReadonlyArray<readonly [string, number]>) {
    it(`resolves a ${name}-suffixed path to itself, not its unsuffixed sibling`, async () => {
      const abs = await confinePath(TARGET, VICTIM + ch(cp), { mustExist: true });
      expect(abs).toBe('/workspace/' + VICTIM + ch(cp));
      expect(abs).not.toBe('/workspace/' + VICTIM);
    });
  }

  it('resolves a lone space to /workspace/<space>, never the root', async () => {
    const abs = await confinePath(TARGET, ' ', { mustExist: true });
    expect(abs).toBe('/workspace/ ');
    expect(abs).not.toBe('/workspace');
  });

  it('preserves the suffix through the new-file ancestor walk too', async () => {
    // Nothing resolves except the workspace root: the ancestor branch runs and
    // must re-attach the remaining segments byte-for-byte.
    installTarget((p) => (p === '/workspace' ? '/workspace\n' : ''));
    const abs = await confinePath(TARGET, 'dir /new file ', { mustExist: false });
    expect(abs).toBe('/workspace/dir /new file ');
  });

  it('fs_write uploads the suffixed name, leaving the unsuffixed victim untouched', async () => {
    await fsops.writeFile(TARGET, VICTIM + ' ', Buffer.from('payload'));
    expect(putArchive).toHaveBeenCalledTimes(1);
    expect(putArchive.mock.calls[0][1]).toBe('/workspace');
    // The tar entry name is the identity that lands on disk (NUL-padded field).
    const header = (putArchive.mock.calls[0][2] as Buffer).subarray(0, 100).toString('utf8');
    expect(header.startsWith(VICTIM + ' \0')).toBe(true);
  });

  it('fs_patch reads and rewrites the suffixed name', async () => {
    const getArchive = docker.getArchive as ReturnType<typeof vi.fn>;
    const tarOf = async (name: string, body: string) => {
      const { pack } = await import('tar-stream');
      const p = pack();
      p.entry({ name, size: body.length }, body);
      p.finalize();
      const chunks: Buffer[] = [];
      for await (const c of p) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    };
    const buf = await tarOf(VICTIM + ' ', 'alpha');
    getArchive.mockImplementation(async () => ({ body: Readable.from([buf]), statHeader: undefined }));
    await fsops.patchFile(TARGET, VICTIM + ' ', 'alpha', 'beta');
    expect(getArchive.mock.calls[0][1]).toBe('/workspace/' + VICTIM + ' ');
    const header = (putArchive.mock.calls[0][2] as Buffer).subarray(0, 100).toString('utf8');
    expect(header.startsWith(VICTIM + ' \0')).toBe(true);
  });
});

describe('confinePath fails closed on an ambiguous canonical answer', () => {
  const badOutputs: ReadonlyArray<readonly [string, string]> = [
    ['no terminator', '/workspace/' + VICTIM],
    ['two records', '/workspace/' + VICTIM + '\n/workspace/DECOY\n'],
    ['CRLF', '/workspace/' + VICTIM + '\r\n'],
    ['relative answer', VICTIM + '\n'],
    ['control character in the answer', '/workspace/' + VICTIM + ch(0x07) + '\n'],
  ];

  for (const [label, out] of badOutputs) {
    it(`rejects ${label}`, async () => {
      installTarget(() => out);
      await expect(confinePath(TARGET, VICTIM, { mustExist: true })).rejects.toMatchObject({
        code: 'PATH_VIOLATION',
      });
    });
  }

  it('does not fall back to an ancestor when the answer is malformed', async () => {
    installTarget(() => '/workspace/a\n/workspace/b\n');
    await expect(confinePath(TARGET, 'dir/new-file', { mustExist: false })).rejects.toMatchObject({
      code: 'PATH_VIOLATION',
    });
    // Exactly one canonicalization attempt: the ancestor walk never started.
    expect(ranCmds.filter((c) => (c[2] ?? '').includes('readlink -f'))).toHaveLength(1);
  });

  it('still escalates a genuine workspace escape', async () => {
    installTarget(() => '/etc/passwd\n');
    await expect(confinePath(TARGET, 'link', { mustExist: true })).rejects.toMatchObject({
      code: 'PATH_VIOLATION',
    });
  });

  it('a suffixed path must not satisfy isInside by prefix alone', async () => {
    // "/workspace-evil/..." shares a string prefix with "/workspace" but is
    // outside it. Confinement is unchanged by this fix; assert it stays so.
    installTarget(() => '/workspace-evil/x\n');
    await expect(confinePath(TARGET, 'link', { mustExist: true })).rejects.toMatchObject({
      code: 'PATH_VIOLATION',
    });
  });
});

// ---------------------------------------------------------------------------
// Destructive-operation targeting
// ---------------------------------------------------------------------------

/** Every `rm` argv the stubbed target was asked to run (never a real rm). */
const rmCalls = () => ranCmds.filter((c) => c[0] === 'rm');

describe('fs_delete can never target the workspace root', () => {
  it('a lone space deletes the space-named entry, never /workspace', async () => {
    // The pre-canonicalization guard compares against '' and '.', so " " passes
    // it. Under the old parser this canonicalized to /workspace and would have
    // run `rm -rf -- /workspace`. Proven non-destructively: rm is intercepted.
    await fsops.deletePath(TARGET, ' ', true);
    expect(rmCalls()).toEqual([['rm', '-rf', '--', '/workspace/ ']]);
  });

  it('rejects a symlink that resolves exactly to the workspace root', async () => {
    installTarget(() => '/workspace\n');
    await expect(fsops.deletePath(TARGET, 'root-link', true)).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
    expect(rmCalls()).toHaveLength(0);
  });

  it('rejects a root-resolving symlink reported with a trailing slash', async () => {
    installTarget(() => '/workspace/\n');
    await expect(fsops.deletePath(TARGET, 'root-link', true)).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
    expect(rmCalls()).toHaveLength(0);
  });

  it('rejects a root-resolving symlink for non-recursive delete too', async () => {
    installTarget(() => '/workspace\n');
    await expect(fsops.deletePath(TARGET, 'root-link', false)).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
    expect(rmCalls()).toHaveLength(0);
  });

  it('rejects a root-resolving path when the configured workspace has a trailing slash', async () => {
    installTarget(() => '/workspace\n');
    await expect(
      fsops.deletePath({ containerId: 'c', workspace: '/workspace/' }, 'root-link', true),
    ).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
    expect(rmCalls()).toHaveLength(0);
  });

  it('rejects a deep path whose canonical answer collapses to the root', async () => {
    installTarget(() => '/workspace\n');
    await expect(fsops.deletePath(TARGET, 'a/b/c/d', true)).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
    expect(rmCalls()).toHaveLength(0);
  });

  it('still deletes an ordinary path', async () => {
    await fsops.deletePath(TARGET, VICTIM, true);
    expect(rmCalls()).toEqual([['rm', '-rf', '--', '/workspace/' + VICTIM]]);
  });

  it('deletes a nested path under the root normally', async () => {
    await fsops.deletePath(TARGET, 'dir/' + VICTIM, false);
    expect(rmCalls()).toEqual([['rm', '-f', '--', '/workspace/dir/' + VICTIM]]);
  });
});

describe('fs_stat never resolves a space to the workspace root', () => {
  it('stats /workspace/<space>, not /workspace', async () => {
    await fsops.statPath(TARGET, ' ').catch(() => undefined);
    const statCall = ranCmds.find((c) => (c[2] ?? '').includes('stat -c'));
    expect(statCall).toBeDefined();
    expect(statCall![statCall!.length - 1]).toBe('/workspace/ ');
    expect(statCall![statCall!.length - 1]).not.toBe('/workspace');
  });
});
