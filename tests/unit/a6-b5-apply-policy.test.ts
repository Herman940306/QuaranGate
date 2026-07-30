/**
 * A6-B5-P1: Pure apply-policy primitives — comprehensive unit tests.
 *
 * All offline, all pure (no filesystem, no Git, no SQLite, no Docker, no
 * network). Exercises the production exports of applyPolicy.ts directly.
 */
import { describe, it, expect } from 'vitest';
import { BridgeError } from '../../src/shared/errors.js';
import {
  validateApplyPath,
  validateGuardPattern,
  matchesGuardPattern,
  pathIsGuarded,
  assertChangesetNotGuarded,
  escapeGuardLiteralPath,
  isSupportedRegularFileMode,
  assertSupportedRegularFileMode,
  SUPPORTED_REGULAR_FILE_MODES,
} from '../../src/executor/agents/applyPolicy.js';

function errCode(fn: () => unknown): string {
  try { fn(); throw new Error('expected throw'); }
  catch (e) { if (e instanceof BridgeError) return e.code; throw e; }
}

// ---------------------------------------------------------------------------
// A. Literal rules
// ---------------------------------------------------------------------------

describe('A6-B5-P1 A. literal guard rules', () => {
  it('A1 literal pattern matches the identical root path', () => {
    expect(matchesGuardPattern('.env', '.env')).toBe(true);
  });

  it('A2 literal pattern does not match the same basename nested under a directory', () => {
    expect(matchesGuardPattern('subdir/.env', '.env')).toBe(false);
    expect(matchesGuardPattern('foo/.env', '.env')).toBe(false);
  });

  it('A3 literal pattern does not match a path where the literal is itself a parent segment', () => {
    expect(matchesGuardPattern('.env/example', '.env')).toBe(false);
  });

  it('A4 literal pattern does not match a different basename that merely contains it as a suffix', () => {
    expect(matchesGuardPattern('foo.env', '.env')).toBe(false);
  });

  it('A5 literal path matches the exact path only', () => {
    expect(matchesGuardPattern('config/clients.yaml', 'config/clients.yaml')).toBe(true);
    expect(matchesGuardPattern('config/other.yaml', 'config/clients.yaml')).toBe(false);
    expect(matchesGuardPattern('other/config/clients.yaml', 'config/clients.yaml')).toBe(false);
  });

  it('A6 a literal directory name is NOT an implicit recursive prefix', () => {
    expect(matchesGuardPattern('config', 'config')).toBe(true);
    expect(matchesGuardPattern('config/a.json', 'config')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. Single-segment wildcards
// ---------------------------------------------------------------------------

describe('A6-B5-P1 B. single-segment wildcards (* and ?)', () => {
  it('B1 * matches zero or more characters within one segment', () => {
    expect(matchesGuardPattern('cert.pem', '*.pem')).toBe(true);
    expect(matchesGuardPattern('.pem', '*.pem')).toBe(true); // zero chars before .pem
  });

  it('B2 * does not cross a path separator', () => {
    expect(matchesGuardPattern('keys/cert.pem', '*.pem')).toBe(false);
  });

  it('B3 ? matches exactly one character, never zero, never two', () => {
    expect(matchesGuardPattern('config1.json', 'config?.json')).toBe(true);
    expect(matchesGuardPattern('config.json', 'config?.json')).toBe(false); // zero chars
    expect(matchesGuardPattern('config12.json', 'config?.json')).toBe(false); // two chars
  });

  it('B4 dotfile behavior is deterministic: * matches a leading dot like any other character', () => {
    expect(matchesGuardPattern('.env', '*')).toBe(true);
    expect(matchesGuardPattern('.env', '.*')).toBe(true);
    expect(matchesGuardPattern('.env', '?env')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. Double star
// ---------------------------------------------------------------------------

describe('A6-B5-P1 C. ** cross-segment matching', () => {
  it('C1 **/*.pem matches a nested file recursively', () => {
    expect(matchesGuardPattern('keys/cert.pem', '**/*.pem')).toBe(true);
  });

  it('C2 **/*.pem also matches at repository root depth (zero directories)', () => {
    expect(matchesGuardPattern('cert.pem', '**/*.pem')).toBe(true);
  });

  it('C3 secrets/** matches every descendant of secrets/', () => {
    expect(matchesGuardPattern('secrets/key.txt', 'secrets/**')).toBe(true);
  });

  it('C4 **/*.pem matches an arbitrarily deeply nested file', () => {
    expect(matchesGuardPattern('a/b/c/d/cert.pem', '**/*.pem')).toBe(true);
  });

  it('C5 src/*/config?.json matches exactly one wildcard directory plus one wildcard char', () => {
    expect(matchesGuardPattern('src/a/config1.json', 'src/*/config?.json')).toBe(true);
  });

  it('C6 src/*/config?.json does NOT match an extra nested directory (no ** present)', () => {
    expect(matchesGuardPattern('src/a/b/config1.json', 'src/*/config?.json')).toBe(false);
  });

  it('C7 secrets/** does not match a sibling directory', () => {
    expect(matchesGuardPattern('other/key.txt', 'secrets/**')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. Full-path matching (never substring)
// ---------------------------------------------------------------------------

describe('A6-B5-P1 D. full-path matching, never substring', () => {
  it('D1 a literal pattern is never a substring match', () => {
    expect(matchesGuardPattern('.env', 'env')).toBe(false);
    expect(matchesGuardPattern('barenv', 'env')).toBe(false);
  });

  it('D2 a directory-name prefix alone does not match its descendants without a wildcard', () => {
    expect(matchesGuardPattern('secrets/key.txt', 'secrets')).toBe(false);
  });

  it('D3 a suffix alone does not match unless the pattern expresses it with a wildcard', () => {
    expect(matchesGuardPattern('cert.pem', '.pem')).toBe(false);
    expect(matchesGuardPattern('cert.pem', '*.pem')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E. Malformed patterns — all fail closed
// ---------------------------------------------------------------------------

describe('A6-B5-P1 E. malformed guard patterns fail closed', () => {
  it('E1 empty pattern is rejected', () => {
    expect(errCode(() => validateGuardPattern(''))).toBe('MALFORMED_REQUEST');
  });

  it('E2 absolute pattern is rejected', () => {
    expect(errCode(() => validateGuardPattern('/etc/passwd'))).toBe('MALFORMED_REQUEST');
  });

  it('E3 traversal pattern is rejected', () => {
    expect(errCode(() => validateGuardPattern('../secret'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('a/../b'))).toBe('MALFORMED_REQUEST');
  });

  it('E4 backslash pattern is rejected', () => {
    expect(errCode(() => validateGuardPattern('a\\b'))).toBe('MALFORMED_REQUEST');
  });

  it('E5 negation (!) pattern is rejected', () => {
    expect(errCode(() => validateGuardPattern('!*.pem'))).toBe('MALFORMED_REQUEST');
  });

  it('E6 unsupported glob syntax (bracket/brace/extglob) is rejected', () => {
    expect(errCode(() => validateGuardPattern('[abc].txt'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('{a,b}.txt'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('!(x).txt'))).toBe('MALFORMED_REQUEST');
  });

  it('E7 empty path segment (double slash) is rejected', () => {
    expect(errCode(() => validateGuardPattern('a//b'))).toBe('MALFORMED_REQUEST');
  });

  it('E8 a lone "." segment is rejected (no cwd semantics)', () => {
    expect(errCode(() => validateGuardPattern('./a'))).toBe('MALFORMED_REQUEST');
  });

  it('E9 NUL byte is rejected', () => {
    expect(errCode(() => validateGuardPattern('a\0b'))).toBe('MALFORMED_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// F. Changed-path validity
// ---------------------------------------------------------------------------

describe('A6-B5-P1 F. changed-path validity', () => {
  it('F1 a valid repo-relative path is accepted unchanged', () => {
    expect(validateApplyPath('src/index.ts')).toBe('src/index.ts');
  });

  it('F2 an absolute path is rejected', () => {
    expect(errCode(() => validateApplyPath('/etc/passwd'))).toBe('PATH_VIOLATION');
  });

  it('F3 a traversal path is rejected', () => {
    expect(errCode(() => validateApplyPath('../../etc/passwd'))).toBe('PATH_VIOLATION');
    expect(errCode(() => validateApplyPath('a/../b'))).toBe('PATH_VIOLATION');
  });

  it('F4 a .git path is rejected, including nested and case-varied', () => {
    expect(errCode(() => validateApplyPath('.git/config'))).toBe('PATH_VIOLATION');
    expect(errCode(() => validateApplyPath('foo/.git/hooks/pre-commit'))).toBe('PATH_VIOLATION');
    expect(errCode(() => validateApplyPath('foo/.GIT/config'))).toBe('PATH_VIOLATION');
  });

  it('F5 existing accepted canonical-path behavior is preserved (empty, backslash, NUL, trailing slash)', () => {
    expect(errCode(() => validateApplyPath(''))).toBe('PATH_VIOLATION');
    expect(errCode(() => validateApplyPath('a\\b'))).toBe('PATH_VIOLATION');
    expect(errCode(() => validateApplyPath('a\0b'))).toBe('PATH_VIOLATION');
    expect(errCode(() => validateApplyPath('a/'))).toBe('PATH_VIOLATION');
  });

  it('F6 a bare "." segment anywhere in the path is rejected (security-review finding: prevents a literal guard pattern from being defeated by segment-count misalignment, e.g. a/./secret.pem vs guard a/secret.pem)', () => {
    expect(errCode(() => validateApplyPath('a/./b'))).toBe('PATH_VIOLATION');
    expect(errCode(() => validateApplyPath('./a'))).toBe('PATH_VIOLATION');
    expect(errCode(() => validateApplyPath('a/.'))).toBe('PATH_VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// G. Whole-changeset denial
// ---------------------------------------------------------------------------

describe('A6-B5-P1 G. whole-changeset guarded-path denial', () => {
  const guardedPaths = ['.env', '**/*.pem', 'secrets/**'];

  it('G1 no guarded path in the changeset passes with no throw', () => {
    expect(() => assertChangesetNotGuarded(['src/index.ts', 'README.md'], guardedPaths)).not.toThrow();
  });

  it('G2 one guarded path denies the whole changeset', () => {
    expect(errCode(() => assertChangesetNotGuarded(['src/index.ts', '.env'], guardedPaths)))
      .toBe('GUARDED_PATH_DENIED');
  });

  it('G3 the guarded path first, middle, or last in the array all deny identically', () => {
    expect(errCode(() => assertChangesetNotGuarded(['.env', 'a.ts', 'b.ts'], guardedPaths)))
      .toBe('GUARDED_PATH_DENIED');
    expect(errCode(() => assertChangesetNotGuarded(['a.ts', '.env', 'b.ts'], guardedPaths)))
      .toBe('GUARDED_PATH_DENIED');
    expect(errCode(() => assertChangesetNotGuarded(['a.ts', 'b.ts', '.env'], guardedPaths)))
      .toBe('GUARDED_PATH_DENIED');
  });

  it('G4 multiple guarded paths in one changeset still deny (not a partial result)', () => {
    expect(errCode(() => assertChangesetNotGuarded(['.env', 'keys/x.pem', 'secrets/y.txt'], guardedPaths)))
      .toBe('GUARDED_PATH_DENIED');
  });

  it('G5 a malformed changed path is rejected as PATH_VIOLATION, never mislabeled as guarded', () => {
    expect(errCode(() => assertChangesetNotGuarded(['../escape'], guardedPaths))).toBe('PATH_VIOLATION');
  });

  it('G6 a malformed guard pattern in trusted config fails the whole evaluation closed', () => {
    expect(errCode(() => assertChangesetNotGuarded(['src/index.ts'], ['!bad']))).toBe('MALFORMED_REQUEST');
  });

  it('G7 an interior "." segment cannot be used to defeat a literal guard pattern (security-review finding)', () => {
    expect(errCode(() => assertChangesetNotGuarded(['a/./secret.pem'], ['a/secret.pem']))).toBe('PATH_VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// H. Supported regular-file modes
// ---------------------------------------------------------------------------

describe('A6-B5-P1 H. supported regular-file modes', () => {
  it('H1 0644 and 0755 are supported', () => {
    expect(isSupportedRegularFileMode(0o644)).toBe(true);
    expect(isSupportedRegularFileMode(0o755)).toBe(true);
    expect(() => assertSupportedRegularFileMode(0o644)).not.toThrow();
    expect(() => assertSupportedRegularFileMode(0o755)).not.toThrow();
  });

  it('H2 an unsupported mode is rejected closed', () => {
    expect(isSupportedRegularFileMode(0o600)).toBe(false);
    expect(isSupportedRegularFileMode(0o777)).toBe(false);
    expect(errCode(() => assertSupportedRegularFileMode(0o600))).toBe('PRECONDITION_FAILED');
    expect(errCode(() => assertSupportedRegularFileMode(0o777))).toBe('PRECONDITION_FAILED');
  });

  it('H3 the exported constant is exactly the two frozen modes', () => {
    expect([...SUPPORTED_REGULAR_FILE_MODES].sort()).toEqual([0o644, 0o755].sort());
  });
});

// ---------------------------------------------------------------------------
// I. Bounds / adversarial
// ---------------------------------------------------------------------------

describe('A6-B5-P1 I. bounds and adversarial inputs', () => {
  it('I1 a large but ordinary changed-path set with no guarded matches completes cleanly', () => {
    const paths = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`);
    expect(() => assertChangesetNotGuarded(paths, ['.env', '**/*.pem'])).not.toThrow();
  });

  it('I2 repeated identical guard rules behave the same as a single rule', () => {
    expect(errCode(() => assertChangesetNotGuarded(['.env'], ['.env', '.env', '.env']))).toBe('GUARDED_PATH_DENIED');
    expect(() => assertChangesetNotGuarded(['a.ts'], ['.env', '.env'])).not.toThrow();
  });

  it('I3 wildcard-heavy but valid patterns still match correctly and deterministically', () => {
    expect(matchesGuardPattern('a/b/c/cert.pem', '**/**/*.pem')).toBe(true);
    expect(matchesGuardPattern('src/a/b/c/config1.json', '**/config?.json')).toBe(true);
    expect(pathIsGuarded('deep/nested/path/secret.pem', ['**/*.pem'])).toBe(true);
  });

  it('I4 ordinary punctuation with meaning in OTHER glob/regex dialects (parens, pipe, dollar) is accepted here as literal data and never gains regex/shell meaning (§R1: these are legal filename characters, not operators in our frozen grammar)', () => {
    expect(validateGuardPattern('(secret|password)')).toBe('(secret|password)');
    expect(matchesGuardPattern('(secret|password)', '(secret|password)')).toBe(true);
    expect(matchesGuardPattern('secret', '(secret|password)')).toBe(false); // no regex alternation
    expect(matchesGuardPattern('password', '(secret|password)')).toBe(false);
    expect(validateGuardPattern('a$b')).toBe('a$b');
    expect(matchesGuardPattern('a$b', 'a$b')).toBe(true);
    expect(matchesGuardPattern('ab', 'a$b')).toBe(false); // '$' is not an end-anchor/zero-width match
  });

  it('I5 a literal "." in a pattern is an ordinary character, never a regex any-character wildcard', () => {
    // If '.' were treated as regex any-char, 'axpem' would wrongly match 'a.pem'.
    expect(matchesGuardPattern('axpem', 'a.pem')).toBe(false);
    expect(matchesGuardPattern('a.pem', 'a.pem')).toBe(true);
  });

  it('I6 matching is deterministic across repeated evaluations', () => {
    const a = matchesGuardPattern('keys/cert.pem', '**/*.pem');
    const b = matchesGuardPattern('keys/cert.pem', '**/*.pem');
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// J. §R1 remediation — literal ordinary-character compatibility
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R1 J. literal ordinary-character compatibility (guard patterns must be able to express any path validateApplyPath accepts)', () => {
  const cases: Array<[label: string, path: string, differentPath: string]> = [
    ['space', 'Client Files/private.pem', 'Client Files/other.pem'],
    ['@', 'team@example/key.pem', 'team@other/key.pem'],
    ['#', 'certs/prod#1.pem', 'certs/prod#2.pem'],
    ['parentheses', 'config/(legacy)/secret.txt', 'config/(current)/secret.txt'],
    ['comma', 'data/a,b.csv', 'data/a,c.csv'],
    ['plus', 'certs/prod+backup.pem', 'certs/prod+primary.pem'],
    ['equals', 'build/x=y.txt', 'build/x=z.txt'],
    ['unicode', 'følsom/private.pem', 'følsom/other.pem'],
  ];

  for (const [label, path, differentPath] of cases) {
    it(`J.${label}: "${path}" is accepted by both validators and matches itself exactly, not a different path`, () => {
      expect(validateApplyPath(path)).toBe(path);
      expect(validateGuardPattern(path)).toBe(path);
      expect(matchesGuardPattern(path, path)).toBe(true);
      expect(matchesGuardPattern(differentPath, path)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// K. §R1 remediation — wildcards combined with ordinary characters
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R1 K. wildcards combined with ordinary characters', () => {
  it('K1 "Client Files/*.pem" matches any pem under the space-named directory', () => {
    expect(matchesGuardPattern('Client Files/a.pem', 'Client Files/*.pem')).toBe(true);
    expect(matchesGuardPattern('Client Files/sub/a.pem', 'Client Files/*.pem')).toBe(false); // * stays within one segment
  });

  it('K2 "team@corp/**" matches every descendant of the @-named directory', () => {
    expect(matchesGuardPattern('team@corp/key.pem', 'team@corp/**')).toBe(true);
    expect(matchesGuardPattern('team@corp/nested/deep/key.pem', 'team@corp/**')).toBe(true);
    expect(matchesGuardPattern('team@other/key.pem', 'team@corp/**')).toBe(false);
  });

  it('K3 "certs/prod+*.pem" matches only names literally starting with "prod+"', () => {
    expect(matchesGuardPattern('certs/prod+backup.pem', 'certs/prod+*.pem')).toBe(true);
    expect(matchesGuardPattern('certs/prodbackup.pem', 'certs/prod+*.pem')).toBe(false); // '+' is literal, not "one-or-more"
  });

  it('K4 "config/(legacy)/*.json" matches json files under the paren-named directory only', () => {
    expect(matchesGuardPattern('config/(legacy)/a.json', 'config/(legacy)/*.json')).toBe(true);
    expect(matchesGuardPattern('config/(current)/a.json', 'config/(legacy)/*.json')).toBe(false);
  });

  it('K5 "data/*.csv" matches csv files at that depth only', () => {
    expect(matchesGuardPattern('data/a,b.csv', 'data/*.csv')).toBe(true);
    expect(matchesGuardPattern('data/nested/a,b.csv', 'data/*.csv')).toBe(false);
  });

  it('K6 "følsom/**/*.pem" matches pem files recursively under the unicode-named directory', () => {
    expect(matchesGuardPattern('følsom/private.pem', 'følsom/**/*.pem')).toBe(true);
    expect(matchesGuardPattern('følsom/sub/private.pem', 'følsom/**/*.pem')).toBe(true);
    expect(matchesGuardPattern('følsom/a/b/c/private.pem', 'følsom/**/*.pem')).toBe(true);
    expect(matchesGuardPattern('other/private.pem', 'følsom/**/*.pem')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L. §R1 remediation — special characters remain literal, never regex/extglob
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R1 L. special characters remain literal, never regex/extglob', () => {
  it('L1 "a+b.txt" does not match "ab.txt" (+ is literal, not "one-or-more")', () => {
    expect(matchesGuardPattern('ab.txt', 'a+b.txt')).toBe(false);
    expect(matchesGuardPattern('a+b.txt', 'a+b.txt')).toBe(true);
  });

  it('L2 "a.b.txt" does not match "aXb.txt" (. is literal, not regex any-char) — see also I5', () => {
    expect(matchesGuardPattern('aXb.txt', 'a.b.txt')).toBe(false);
    expect(matchesGuardPattern('a.b.txt', 'a.b.txt')).toBe(true);
  });

  it('L3 "a(b)c.txt" does not group/capture — matches only the identical literal string', () => {
    expect(matchesGuardPattern('a(b)c.txt', 'a(b)c.txt')).toBe(true);
    expect(matchesGuardPattern('abc.txt', 'a(b)c.txt')).toBe(false); // no extglob "optional group"
  });

  it('L4 "user@host#1.txt" (@ and #) are literal, no substring/lookup semantics', () => {
    expect(matchesGuardPattern('user@host#1.txt', 'user@host#1.txt')).toBe(true);
    expect(matchesGuardPattern('user@host#2.txt', 'user@host#1.txt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M. §R1 remediation — table-driven security property: every accepted
// changed path must be guardable, unless it contains explicitly unsupported
// pattern syntax. This is the regression test for the asymmetry itself.
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R1 M. security property: accepted changed paths are always guardable by literal text', () => {
  const representativePaths = [
    '.env',
    'src/index.ts',
    'Client Files/private.pem',
    'team@example/key.pem',
    'certs/prod#1.pem',
    'config/(legacy)/secret.txt',
    'data/a,b.csv',
    'certs/prod+backup.pem',
    'build/x=y.txt',
    'følsom/private.pem',
    '配置/secret.yaml',
    'a b/c d.txt',
    'name-with-dashes_and_underscores.txt',
  ];

  it('M1 every representative accepted changed path can be guarded by its own literal text, with an exact match', () => {
    for (const path of representativePaths) {
      // 1. the path itself is a legally accepted changed path
      expect(validateApplyPath(path)).toBe(path);
      // 2. the SAME literal text is accepted as a guard pattern
      expect(validateGuardPattern(path)).toBe(path);
      // 3. it matches itself exactly
      expect(matchesGuardPattern(path, path)).toBe(true);
      // 4. whole-changeset denial actually fires when configured to guard it
      expect(errCode(() => assertChangesetNotGuarded([path], [path]))).toBe('GUARDED_PATH_DENIED');
    }
  });

  it('M2 the asymmetry does not return: no representative path throws MALFORMED_REQUEST from validateGuardPattern', () => {
    for (const path of representativePaths) {
      expect(() => validateGuardPattern(path)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// N. §R2 remediation — exact literal `*` via escape
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R2 N. exact literal * via backslash escape', () => {
  it('N1 an escaped star guard matches ONLY the identical literal path, not files a real * would match', () => {
    const guard = 'reports/q1\\*.csv';
    expect(validateGuardPattern(guard)).toBe(guard);
    expect(matchesGuardPattern('reports/q1*.csv', guard)).toBe(true);
    expect(matchesGuardPattern('reports/q1X.csv', guard)).toBe(false);
    expect(matchesGuardPattern('reports/q123.csv', guard)).toBe(false);
  });

  it('N2 the SAME pattern without the escape retains real wildcard behavior', () => {
    const wildcard = 'reports/q1*.csv';
    expect(matchesGuardPattern('reports/q1.csv', wildcard)).toBe(true);
    expect(matchesGuardPattern('reports/q1X.csv', wildcard)).toBe(true);
    expect(matchesGuardPattern('reports/q123.csv', wildcard)).toBe(true);
    expect(matchesGuardPattern('reports/q1*.csv', wildcard)).toBe(true); // '*' also matches a literal '*' char
  });
});

// ---------------------------------------------------------------------------
// O. §R2 remediation — exact literal `?` via escape
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R2 O. exact literal ? via backslash escape', () => {
  it('O1 an escaped question-mark guard matches only the identical literal "?" character', () => {
    const guard = 'reports/q\\?.csv';
    expect(validateGuardPattern(guard)).toBe(guard);
    expect(matchesGuardPattern('reports/q?.csv', guard)).toBe(true);
    expect(matchesGuardPattern('reports/qX.csv', guard)).toBe(false);
    expect(matchesGuardPattern('reports/q.csv', guard)).toBe(false);
  });

  it('O2 the SAME pattern without the escape remains the exactly-one-character wildcard', () => {
    const wildcard = 'reports/q?.csv';
    expect(matchesGuardPattern('reports/qX.csv', wildcard)).toBe(true);
    expect(matchesGuardPattern('reports/q?.csv', wildcard)).toBe(true); // ? also matches a literal '?' char
    expect(matchesGuardPattern('reports/q.csv', wildcard)).toBe(false); // zero chars: no match
    expect(matchesGuardPattern('reports/qXY.csv', wildcard)).toBe(false); // two chars: no match
  });
});

// ---------------------------------------------------------------------------
// P. §R2 remediation — brackets/braces guardable via escape, unescaped still rejected
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R2 P. brackets and braces', () => {
  it('P1 a canonical path containing brackets is guardable exactly via escaping', () => {
    const path = '[legacy]/secret.txt';
    const guard = '\\[legacy\\]/secret.txt';
    expect(validateApplyPath(path)).toBe(path);
    expect(validateGuardPattern(guard)).toBe(guard);
    expect(matchesGuardPattern(path, guard)).toBe(true);
    expect(matchesGuardPattern('(current)/secret.txt', guard)).toBe(false);
  });

  it('P2 a canonical path containing braces is guardable exactly via escaping', () => {
    const path = '{x}/secret.txt';
    const guard = '\\{x\\}/secret.txt';
    expect(validateApplyPath(path)).toBe(path);
    expect(validateGuardPattern(guard)).toBe(guard);
    expect(matchesGuardPattern(path, guard)).toBe(true);
    expect(matchesGuardPattern('{y}/secret.txt', guard)).toBe(false);
  });

  it('P3 unescaped brackets/braces remain MALFORMED_REQUEST (no new glob feature introduced)', () => {
    expect(errCode(() => validateGuardPattern('[legacy]/secret.txt'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('{x}/secret.txt'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('a]b.txt'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('a}b.txt'))).toBe('MALFORMED_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// Q. §R2 remediation — leading exclamation escape + nested (non-leading) !
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R2 Q. leading exclamation via escape; nested ! remains literal', () => {
  it('Q1 a canonical path with a leading ! is guardable exactly via escaping', () => {
    const path = '!important.env';
    const guard = '\\!important.env';
    expect(validateApplyPath(path)).toBe(path);
    expect(validateGuardPattern(guard)).toBe(guard);
    expect(matchesGuardPattern(path, guard)).toBe(true);
    expect(matchesGuardPattern('important.env', guard)).toBe(false);
  });

  it('Q2 an unescaped leading ! remains rejected as unsupported negation syntax', () => {
    expect(errCode(() => validateGuardPattern('!important.env'))).toBe('MALFORMED_REQUEST');
  });

  it('Q3 a NESTED (non-leading) ! needs no escape at all — it is ordinary literal text, unchanged from R1', () => {
    expect(validateGuardPattern('a!b.txt')).toBe('a!b.txt');
    expect(matchesGuardPattern('a!b.txt', 'a!b.txt')).toBe(true);
    expect(matchesGuardPattern('team!corp/key.pem', 'team!corp/key.pem')).toBe(true);
    // escaping a nested ! is also accepted (harmless/idempotent) per the frozen "escape ! everywhere" allowance
    expect(matchesGuardPattern('a!b.txt', 'a\\!b.txt')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R. §R2 remediation — ** disambiguation (escaped stars never become DOUBLE_STAR)
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R2 R. ** disambiguation', () => {
  it('R1 unescaped ** is the cross-directory wildcard (unchanged from R1/P1)', () => {
    expect(matchesGuardPattern('cert.pem', '**/x')).toBe(false); // sanity: wrong suffix
    expect(matchesGuardPattern('a/b/cert.pem', '**/cert.pem')).toBe(true);
    expect(matchesGuardPattern('cert.pem', '**/cert.pem')).toBe(true); // root depth too
  });

  it('R2 two ESCAPED stars ("\\*\\*") mean the literal two-character text "**", never cross-directory', () => {
    const guard = '\\*\\*';
    expect(validateGuardPattern(guard)).toBe(guard);
    expect(matchesGuardPattern('**', guard)).toBe(true); // literal segment "**"
    expect(matchesGuardPattern('anything', guard)).toBe(false); // NOT a cross-directory wildcard
    expect(matchesGuardPattern('a/b/c', guard)).toBe(false);
  });

  it('R3 wildcard + literal star ("*\\*") is an ordinary single-segment matcher, not DOUBLE_STAR', () => {
    const guard = '*\\*';
    expect(matchesGuardPattern('X*', guard)).toBe(true); // anything, then a literal trailing '*'
    expect(matchesGuardPattern('X', guard)).toBe(false); // no trailing literal '*'
    expect(matchesGuardPattern('a/b', guard)).toBe(false); // single segment only, does not cross '/'
  });

  it('R4 literal star + wildcard ("\\**") is an ordinary single-segment matcher, not DOUBLE_STAR', () => {
    const guard = '\\**';
    expect(matchesGuardPattern('*X', guard)).toBe(true); // leading literal '*', then anything
    expect(matchesGuardPattern('X', guard)).toBe(false); // missing the leading literal '*'
    expect(matchesGuardPattern('*/b', guard)).toBe(false); // single segment only
  });
});

// ---------------------------------------------------------------------------
// S. §R2 remediation — malformed escapes fail closed
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R2 S. malformed escapes fail closed', () => {
  it('S1 a dangling trailing backslash is rejected', () => {
    expect(errCode(() => validateGuardPattern('a\\'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('\\'))).toBe('MALFORMED_REQUEST');
  });

  it('S2 an escape of an unsupported character is rejected, not silently dropped or taken literally', () => {
    expect(errCode(() => validateGuardPattern('\\a'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('\\/'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => validateGuardPattern('a\\.txt'))).toBe('MALFORMED_REQUEST');
  });

  it('S3 a bare lone backslash pattern is rejected', () => {
    expect(errCode(() => validateGuardPattern('\\'))).toBe('MALFORMED_REQUEST');
  });

  it('S4 matchesGuardPattern also fails closed (throws) on a malformed pattern rather than silently returning a boolean', () => {
    expect(() => matchesGuardPattern('a.txt', 'a\\.txt')).toThrow();
    expect(errCode(() => matchesGuardPattern('a.txt', 'a\\'))).toBe('MALFORMED_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// T. §R2 remediation — exact-literal helper (the security property itself)
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R2 T. escapeGuardLiteralPath: every accepted path is exactly guardable', () => {
  const metacharacterPaths = [
    'reports/q1*.csv',
    'reports/q?.csv',
    '[legacy]/secret.txt',
    '{x}/secret.txt',
    '!important.env',
    'a!b?c*d[e]f{g}.txt',
    'følsom/[hemmelig]*.pem',
    '**',
  ];

  it('T1 escapeGuardLiteralPath produces a guard that validates and matches exactly, for every representative metacharacter-bearing path', () => {
    for (const path of metacharacterPaths) {
      const guard = escapeGuardLiteralPath(path);
      expect(() => validateGuardPattern(guard)).not.toThrow();
      expect(matchesGuardPattern(path, guard)).toBe(true);
    }
  });

  it('T2 the escaped guard does not accidentally match a different, similarly-shaped path', () => {
    expect(matchesGuardPattern('reports/qXX.csv', escapeGuardLiteralPath('reports/q1*.csv'))).toBe(false);
    expect(matchesGuardPattern('[current]/secret.txt', escapeGuardLiteralPath('[legacy]/secret.txt'))).toBe(false);
    expect(matchesGuardPattern('important.env', escapeGuardLiteralPath('!important.env'))).toBe(false);
    expect(matchesGuardPattern('anything/at/all', escapeGuardLiteralPath('**'))).toBe(false);
  });

  it('T3 escapeGuardLiteralPath validates its input via validateApplyPath (rejects an unsafe path, e.g. traversal)', () => {
    expect(errCode(() => escapeGuardLiteralPath('../escape'))).toBe('PATH_VIOLATION');
  });

  it('T4 table-driven: escapeGuardLiteralPath closes the asymmetry for every path validateApplyPath accepts', () => {
    const table = [
      'reports/q1*.csv', 'reports/q?.csv', '[legacy]/secret.txt', '{x}/secret.txt',
      '!important.env', 'a,b+c=d.txt', 'følsom/private.pem', '配置/secret.yaml',
      'my report (final).txt', 'user@host#1.txt', 'a$b|c.txt',
    ];
    for (const path of table) {
      expect(validateApplyPath(path)).toBe(path);
      const guard = escapeGuardLiteralPath(path);
      expect(() => validateGuardPattern(guard)).not.toThrow();
      expect(matchesGuardPattern(path, guard)).toBe(true);
      expect(errCode(() => assertChangesetNotGuarded([path], [guard]))).toBe('GUARDED_PATH_DENIED');
    }
  });
});

// ---------------------------------------------------------------------------
// U. §R2 remediation — Unicode code-point semantics for `?`
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R2 U. ? matches exactly one Unicode CODE POINT, never a UTF-16 code unit or grapheme cluster', () => {
  it('U1 ? matches one ASCII character', () => {
    expect(matchesGuardPattern('a', '?')).toBe(true);
  });

  it('U2 ? matches one BMP accented character', () => {
    expect(matchesGuardPattern('é', '?')).toBe(true);
  });

  it('U3 ? matches one supplementary-plane character (emoji, a UTF-16 surrogate PAIR but ONE code point)', () => {
    expect(matchesGuardPattern('😀', '?')).toBe(true);
  });

  it('U4 ?? does NOT match a single emoji (it is one code point, not two)', () => {
    expect(matchesGuardPattern('😀', '??')).toBe(false);
  });

  it('U5 ?? matches two ordinary ASCII characters', () => {
    expect(matchesGuardPattern('ab', '??')).toBe(true);
  });

  it('U6 a decomposed combining sequence ("e" + combining acute = TWO code points) is never normalized to one', () => {
    const decomposed = 'e' + '́'; // NFD: 'e' U+0065 + COMBINING ACUTE ACCENT U+0301 (2 code points)
    expect(Array.from(decomposed).length).toBe(2); // sanity: confirms this really is 2 code points, not 1
    expect(matchesGuardPattern(decomposed, '?')).toBe(false); // NOT one character
    expect(matchesGuardPattern(decomposed, '??')).toBe(true); // exactly two code points
  });
});

// ---------------------------------------------------------------------------
// V. §R3 remediation — matchesGuardPattern() independently enforces the
// SAME fail-closed rules as validateGuardPattern()/validateApplyPath(),
// called directly (not merely reachable via pathIsGuarded/assertChangesetNotGuarded).
// ---------------------------------------------------------------------------

describe('A6-B5-P1 §R3 V. matchesGuardPattern() enforces validateGuardPattern()\'s pattern rules directly', () => {
  const VALID_PATH = 'src/index.ts';

  const patternFailures: Array<[label: string, pattern: string]> = [
    ['empty', ''],
    ['NUL', 'a\0b'],
    ['absolute', '/etc/passwd'],
    ['unescaped leading !', '!important.env'],
    ['empty segment', 'a//b'],
    ['bare .', './a'],
    ['..', '../secret'],
    ['unescaped [', '[abc].txt'],
    ['unescaped ]', 'abc].txt'],
    ['unescaped {', '{a,b}.txt'],
    ['unescaped }', 'abc}.txt'],
    ['dangling escape', 'a\\'],
    ['unsupported escape', '\\a'],
  ];

  for (const [label, pattern] of patternFailures) {
    it(`V.${label}: matchesGuardPattern throws MALFORMED_REQUEST exactly where validateGuardPattern does, for pattern ${JSON.stringify(pattern)}`, () => {
      expect(errCode(() => validateGuardPattern(pattern))).toBe('MALFORMED_REQUEST');
      expect(errCode(() => matchesGuardPattern(VALID_PATH, pattern))).toBe('MALFORMED_REQUEST');
    });
  }

  it('V.concrete-example: the exact defect example from the audit is fixed', () => {
    expect(errCode(() => validateGuardPattern('!important.env'))).toBe('MALFORMED_REQUEST');
    expect(errCode(() => matchesGuardPattern('important.env', '!important.env'))).toBe('MALFORMED_REQUEST');
  });
});

describe('A6-B5-P1 §R3 W. matchesGuardPattern() enforces validateApplyPath()\'s path rules directly', () => {
  const VALID_PATTERN = '*.txt';

  const pathFailures: Array<[label: string, path: string]> = [
    ['absolute', '/etc/passwd'],
    ['traversal', 'a/../b'],
    ['interior .', 'a/./b'],
    ['.git', '.git'],
    ['.git descendant', 'foo/.git/config'],
    ['backslash', 'a\\b'],
    ['NUL', 'a\0b'],
    ['empty', ''],
    ['double segment', 'a//b'],
  ];

  for (const [label, path] of pathFailures) {
    it(`W.${label}: matchesGuardPattern throws PATH_VIOLATION exactly where validateApplyPath does, for path ${JSON.stringify(path)}`, () => {
      expect(errCode(() => validateApplyPath(path))).toBe('PATH_VIOLATION');
      expect(errCode(() => matchesGuardPattern(path, VALID_PATTERN))).toBe('PATH_VIOLATION');
    });
  }
});

describe('A6-B5-P1 §R3 X. high-level helpers remain fail-closed after the matcher fix', () => {
  it('X1 pathIsGuarded rejects an invalid changed path with PATH_VIOLATION (not a silent boolean)', () => {
    expect(errCode(() => pathIsGuarded('../escape', ['*.txt']))).toBe('PATH_VIOLATION');
  });

  it('X2 pathIsGuarded rejects a malformed guard pattern with MALFORMED_REQUEST', () => {
    expect(errCode(() => pathIsGuarded('src/index.ts', ['!bad']))).toBe('MALFORMED_REQUEST');
  });

  it('X3 pathIsGuarded still finds a real match once both sides are valid', () => {
    expect(pathIsGuarded('deep/nested/path/secret.pem', ['**/*.pem'])).toBe(true);
    expect(pathIsGuarded('deep/nested/path/other.txt', ['**/*.pem'])).toBe(false);
  });

  it('X4 assertChangesetNotGuarded validation ordering is unchanged: ALL patterns validated before ANY path, ALL paths validated before ANY match', () => {
    // A malformed pattern is caught even when a changed path is ALSO invalid —
    // proving patterns are validated first, exactly as documented.
    expect(errCode(() => assertChangesetNotGuarded(['../escape'], ['!bad']))).toBe('MALFORMED_REQUEST');
    // A malformed changed path is caught before any match is attempted, once
    // patterns are all valid.
    expect(errCode(() => assertChangesetNotGuarded(['../escape'], ['*.txt']))).toBe('PATH_VIOLATION');
    // A real guarded match still fires once both sides are valid.
    expect(errCode(() => assertChangesetNotGuarded(['secret.pem'], ['*.pem']))).toBe('GUARDED_PATH_DENIED');
  });
});
