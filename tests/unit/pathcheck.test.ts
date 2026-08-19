import { describe, it, expect } from 'vitest';
import { validateRelativePath, joinWorkspace, isInside } from '../../src/shared/pathcheck.js';
import { BridgeError } from '../../src/shared/errors.js';

describe('validateRelativePath', () => {
  it('accepts normal relative paths', () => {
    expect(validateRelativePath('src/app.ts')).toBe('src/app.ts');
    expect(validateRelativePath('./src/./app.ts')).toBe('src/app.ts');
    expect(validateRelativePath('')).toBe('');
    expect(validateRelativePath('.')).toBe('');
  });

  it('rejects parent traversal', () => {
    for (const p of ['../etc', 'a/../../b', '../../etc/passwd', 'src/../../..']) {
      expect(() => validateRelativePath(p)).toThrow(BridgeError);
    }
  });

  it('rejects absolute paths and drive letters', () => {
    for (const p of ['/etc/passwd', '/root', 'C:/Windows', 'c:\\x']) {
      expect(() => validateRelativePath(p)).toThrow(BridgeError);
    }
  });

  it('rejects null bytes and backslashes', () => {
    expect(() => validateRelativePath('a\0b')).toThrow(BridgeError);
    expect(() => validateRelativePath('a\\b')).toThrow(BridgeError);
  });

  it('rejects encoded/normalized traversal that resolves up', () => {
    expect(() => validateRelativePath('foo/../../bar')).toThrow(BridgeError);
  });
});

// ---------------------------------------------------------------------------
// ASCII control characters
//
// A control character that survives validation is not merely cosmetic: the
// executor's canonicalizePath() does `stdout.trim().split('\n')[0]`, so
// `victim\nDECOY` collapses to `victim` and a trailing `\r`/`\t`/space is
// trimmed away. The requested path and the executed path would then differ
// while both the confinement check and the audit record show the original.
// The rule is total (U+0000..U+001F and U+007F) and it must reject, never
// sanitize — stripping would cause the same divergence on purpose.
// ---------------------------------------------------------------------------

/** All rejected code points: the C0 block plus DEL. */
const CONTROL_CODEPOINTS = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f];

const NAMED_CONTROLS: ReadonlyArray<readonly [string, number]> = [
  ['NUL', 0x00],
  ['BEL', 0x07],
  ['backspace', 0x08],
  ['tab', 0x09],
  ['newline', 0x0a],
  ['vertical tab', 0x0b],
  ['form feed', 0x0c],
  ['carriage return', 0x0d],
  ['ESC', 0x1b],
  ['unit separator', 0x1f],
  ['DEL', 0x7f],
];

const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

describe('validateRelativePath — control characters', () => {
  for (const [name, cp] of NAMED_CONTROLS) {
    it(`rejects ${name} (${hex(cp)})`, () => {
      expect(() => validateRelativePath(`a${String.fromCharCode(cp)}b`)).toThrow(BridgeError);
    });
  }

  it('rejects every C0 control character and DEL, in every position', () => {
    for (const cp of CONTROL_CODEPOINTS) {
      const c = String.fromCharCode(cp);
      // Embedded, leading, trailing, inside a segment, and as a whole path.
      for (const candidate of [`victim${c}DECOY`, `${c}file.txt`, `file.txt${c}`, `dir/${c}/file`, c, `dir${c}/file`]) {
        expect(
          () => validateRelativePath(candidate),
          `expected rejection of ${hex(cp)} in ${JSON.stringify(candidate)}`,
        ).toThrow(BridgeError);
      }
    }
  });

  it('rejects with a deterministic PATH_VIOLATION naming the offending code point', () => {
    for (const cp of CONTROL_CODEPOINTS) {
      let thrown: unknown;
      try {
        validateRelativePath(`a${String.fromCharCode(cp)}b`);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BridgeError);
      expect((thrown as BridgeError).code).toBe('PATH_VIOLATION');
      // NUL keeps its own long-standing message; the rest name the code point.
      if (cp !== 0) expect((thrown as BridgeError).message).toContain(hex(cp));
    }
  });

  it('rejects rather than sanitizes — no stripped/truncated path is ever returned', () => {
    // The exact live-validated defect: the prefix must not be reachable.
    const victim = '.mcp-control-path-test-victim';
    expect(() => validateRelativePath(`${victim}\nDECOY`)).toThrow(BridgeError);
    expect(() => validateRelativePath(`${victim}\r\nDECOY`)).toThrow(BridgeError);
    expect(() => validateRelativePath(`${victim}\t`)).toThrow(BridgeError);
    expect(() => validateRelativePath(`${victim}\r`)).toThrow(BridgeError);
    // And a bare newline must not be able to masquerade as the workspace root.
    expect(() => validateRelativePath('\n')).toThrow(BridgeError);
    expect(() => validateRelativePath('\n/')).toThrow(BridgeError);
  });

  it('control characters are rejected even when the path would otherwise be legal', () => {
    expect(validateRelativePath('src/app.ts')).toBe('src/app.ts');
    expect(() => validateRelativePath('src/app.ts\nsrc/other.ts')).toThrow(BridgeError);
  });
});

describe('validateRelativePath — printable characters still accepted', () => {
  it('accepts every printable ASCII character that is otherwise legal in a path', () => {
    for (let cp = 0x20; cp < 0x7f; cp++) {
      const c = String.fromCharCode(cp);
      // Excluded for reasons that predate this rule and are unchanged:
      // '/' is the separator, '\\' is rejected outright, and '.' composes '..'.
      if (c === '/' || c === '\\' || c === '.') continue;
      expect(() => validateRelativePath(`dir/f${c}x.txt`), `printable ${hex(cp)} must stay legal`).not.toThrow();
    }
    // Space and the shell metacharacters keep working: paths are never shelled.
    expect(validateRelativePath('my file (v2) [final] #1.txt')).toBe('my file (v2) [final] #1.txt');
    expect(validateRelativePath("weird'name\"$(x).txt")).toBe("weird'name\"$(x).txt");
  });

  it('accepts printable Unicode', () => {
    const names = [
      'документы/файл.txt',
      '文档/说明.md',
      'café/naïve.txt',
      'emoji/🚀-launch.md',
      'ελληνικά/αρχείο.txt',
      'עברית/קובץ.txt',
      'combining/e\u0301clair.txt', // NFD: e + combining acute
      'math/𝕏.txt', // outside the BMP (surrogate pair)
    ];
    for (const n of names) expect(validateRelativePath(n)).toBe(n);
  });

  it('does not reject non-ASCII whitespace or Unicode control-adjacent code points', () => {
    // Policy is deliberately ASCII-only: U+0085/U+00A0/U+200B/U+2028 are not
    // touched by canonicalizePath's trim/split and are out of scope here.
    for (const c of ['\u00a0', '\u200b', '\u2028', '\u3000']) {
      expect(() => validateRelativePath(`dir/f${c}x.txt`)).not.toThrow();
    }
  });

  it('leaves normalization semantics unchanged', () => {
    expect(validateRelativePath('a//b///c')).toBe('a/b/c');
    expect(validateRelativePath('a/b/')).toBe('a/b');
    expect(validateRelativePath('a/./b')).toBe('a/b');
    expect(validateRelativePath('a/b/../c')).toBe('a/c');
  });

  it('still honours allowRoot=false', () => {
    expect(() => validateRelativePath('', false)).toThrow(BridgeError);
    expect(() => validateRelativePath('.', false)).toThrow(BridgeError);
  });
});

describe('joinWorkspace', () => {
  it('joins inside root', () => {
    expect(joinWorkspace('/workspace', 'src/app.ts')).toBe('/workspace/src/app.ts');
    expect(joinWorkspace('/workspace', '')).toBe('/workspace');
  });
});

describe('isInside', () => {
  it('detects containment correctly', () => {
    expect(isInside('/workspace', '/workspace')).toBe(true);
    expect(isInside('/workspace', '/workspace/src/a')).toBe(true);
    expect(isInside('/workspace', '/workspace-evil')).toBe(false);
    expect(isInside('/workspace', '/etc/passwd')).toBe(false);
    expect(isInside('/workspace', '/secretzone')).toBe(false);
  });
});
