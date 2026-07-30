/**
 * A6-B5-P1: Pure apply-policy primitives.
 *
 * PURE module: no filesystem I/O, no Git execution, no SQLite, no Docker, no
 * network, no provider calls, no project mutation. Every export here is a
 * deterministic function of its arguments only — no singleton state, no
 * environment/cwd dependence, no unbounded cache. This module makes policy
 * DECISIONS; it never observes or touches the real host. Later A6-B5 batches
 * (P2+) inject trusted host observations (live lstat/hash/mode results) into
 * these same decision functions — they do not duplicate the decision logic.
 *
 * Any BridgeError thrown by this module means the answer was computed with
 * ZERO side effects: no attempt-state transition, no persistence write, no
 * audit write, no host mutation. Those effects belong exclusively to later
 * batches.
 *
 * Reuse, not reinvention:
 * - canonical apply-path syntax reuses {@link isValidCanonicalPath}
 *   (canonicalJson.ts), the same grammar already accepted for B3 snapshot
 *   entries — this module does not define a second, contradictory path
 *   grammar. It adds only the `.git`-segment rejection the existing function
 *   does not need (B3's `git archive` capture can structurally never produce
 *   a `.git` path, but this apply-policy layer re-validates independently
 *   rather than trusting that upstream invariant, per this system's existing
 *   "never trust a previous stage" posture).
 * - supported regular-file modes mirror baseCertifier.ts's frozen Git-mode
 *   mapping (`100644` → 0o644, `100755` → 0o755) — the only two regular-file
 *   modes B3 ever certifies as applicable; no new mode is invented here.
 *
 * Guarded-path policy (frozen for B5, user-decided 2026-07-30; escape
 * grammar + Unicode code-point semantics added §R2 2026-07-30):
 * - matching is glob-style (gitignore-like): `*` and `?` within one path
 *   segment (each Unicode CODE POINT, never a UTF-16 code unit or a
 *   grapheme cluster — see {@link matchSegmentTokens}), `**` for
 *   zero-or-more whole path segments;
 * - a match on ANY changed path REJECTS THE ENTIRE CHANGESET — no partial
 *   apply, no per-file continuation, no override;
 * - patterns are deny-only: no regex, no extglob/brace/bracket EXPANSION, no
 *   OS-dependent separator handling, no cwd semantics, no Unicode
 *   normalization/case-folding (NFC and NFD remain distinct strings, exactly
 *   like {@link isValidCanonicalPath} elsewhere in this codebase);
 * - §R2: because {@link canonicalJson.isValidCanonicalPath} does not
 *   prohibit `* ? ! [ ] { }` in a real repository path, this module supports
 *   a BACKSLASH ESCAPE syntax so every canonical path can still be guarded
 *   EXACTLY — see {@link escapeGuardLiteralPath} and the tokenizer section
 *   below. Backslash is safe as an escape marker precisely because
 *   {@link validateApplyPath} already rejects it on the changed-path side —
 *   it is guard-pattern SYNTAX ONLY and can never be literal repository
 *   filename data.
 *
 * The matcher below is a from-scratch bounded dynamic-programming
 * implementation (classic wildcard-matching + a segment-level analogue for
 * `**`) — deliberately NOT regex-based, so there is no catastrophic-
 * backtracking risk from an adversarial artifact path or a wildcard-heavy
 * guard pattern, and no new dependency is introduced.
 */
import { BridgeError } from '../../shared/errors.js';
import { isValidCanonicalPath } from './canonicalJson.js';

// ---------------------------------------------------------------------------
// Canonical apply-path validation (reuses the existing B3 path grammar)
// ---------------------------------------------------------------------------

/** Path segment that must never appear in an apply-time changed path. */
const GIT_SEGMENT_LOWER = '.git';

/**
 * Validate/canonicalize one apply-changeset path using the already-accepted
 * canonical path grammar, plus two explicit supplements
 * {@link isValidCanonicalPath} does not cover:
 *   - a bare `.` path segment ANYWHERE in the path (not only a leading
 *     `./`, which `isValidCanonicalPath` already rejects) — `a/./b` and
 *     `a/b` name the identical file on any POSIX filesystem, so an
 *     unrejected interior `.` segment would let a literal (non-`**`) guard
 *     pattern be silently defeated by segment-count misalignment (found by
 *     the P1 adversarial security review; confirmed no current production
 *     path can emit one, but this module never assumes that of a future
 *     caller);
 *   - a `.git` segment (case-insensitive, defense-in-depth against a case-
 *     alias bypass on case-insensitive host filesystems).
 * Returns the path unchanged on success. Throws `PATH_VIOLATION` — the same
 * code already used for this exact class of problem elsewhere in the
 * codebase (`pathcheck.ts`) — on any violation. Unchanged by §R2 — this
 * remediation only extends the GUARD-PATTERN side (which cannot represent
 * every character `isValidCanonicalPath` already accepts); no test showed
 * `validateApplyPath` itself contradicts the accepted architecture.
 */
export function validateApplyPath(candidate: string): string {
  if (!isValidCanonicalPath(candidate)) {
    throw new BridgeError(
      'PATH_VIOLATION',
      `apply path is not a valid canonical repository-relative path: ${JSON.stringify(candidate)}`,
    );
  }
  for (const seg of candidate.split('/')) {
    if (seg === '.') {
      throw new BridgeError(
        'PATH_VIOLATION',
        `apply path must not contain a '.' segment: ${JSON.stringify(candidate)}`,
      );
    }
    if (seg.toLowerCase() === GIT_SEGMENT_LOWER) {
      throw new BridgeError(
        'PATH_VIOLATION',
        `apply path must not reference '.git': ${JSON.stringify(candidate)}`,
      );
    }
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// §R2: Guard-pattern tokenizer — backslash escape grammar over Unicode code
// points. Both validateGuardPattern and the matcher use this SAME tokenizer,
// so "what parses" and "what matches" can never drift apart.
// ---------------------------------------------------------------------------

type GuardToken =
  | { kind: 'literal'; value: string }
  | { kind: 'star' }
  | { kind: 'question' };

/**
 * The complete set of characters `\` may escape. Shared verbatim between the
 * tokenizer (what a `\x` sequence is ALLOWED to mean) and
 * {@link escapeGuardLiteralPath} (which characters get escaped when
 * generating an exact guard) so the two can never disagree about what
 * "escapable" means.
 */
const GUARD_ESCAPABLE = new Set(['*', '?', '!', '[', ']', '{', '}']);

/**
 * Characters that are UNSUPPORTED GLOB LANGUAGE whenever they appear
 * unescaped, regardless of position — POSIX character classes (`[...]`) and
 * brace expansion (`{...}`) are not implemented by this matcher. `!` is
 * deliberately NOT in this set: an unescaped `!` is ordinary literal text
 * everywhere EXCEPT as the very first character of the whole pattern (gitignore-
 * style negation), which {@link validateGuardPattern} checks separately at
 * the pattern level (§R2 test D: "nested ! behavior").
 */
const GUARD_ALWAYS_REJECT_UNESCAPED = new Set(['[', ']', '{', '}']);

/**
 * Parse ONE raw pattern segment (never containing `/`) into a token
 * sequence, over Unicode CODE POINTS (via the string iterator — the JS
 * engine already pairs UTF-16 surrogates into one element; this is distinct
 * from `.length`/direct indexing, which count UTF-16 code units, and from
 * grapheme-cluster segmentation, which this module deliberately does not
 * perform). `\x` is valid ONLY when `x` is one of {@link GUARD_ESCAPABLE};
 * a dangling trailing backslash or an escape of any other character throws
 * `MALFORMED_REQUEST` rather than being silently dropped or interpreted
 * literally. An unescaped `[`/`]`/`{`/`}` always throws (never a new grammar
 * feature); an unescaped `*`/`?` becomes the corresponding wildcard token;
 * every other code point — INCLUDING an unescaped `!` (see
 * {@link GUARD_ALWAYS_REJECT_UNESCAPED}'s comment) and every ordinary R1
 * character (space, `@`, `#`, `(`, `)`, `,`, `+`, `=`, `$`, `|`, Unicode) —
 * becomes a literal token of exactly that one code point.
 */
function tokenizeGuardSegment(segment: string): GuardToken[] {
  const cps = Array.from(segment);
  const tokens: GuardToken[] = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    if (ch === '\\') {
      const next = cps[i + 1];
      if (next === undefined) {
        throw new BridgeError(
          'MALFORMED_REQUEST',
          `guarded path pattern has a dangling backslash escape: ${JSON.stringify(segment)}`,
        );
      }
      if (!GUARD_ESCAPABLE.has(next)) {
        throw new BridgeError(
          'MALFORMED_REQUEST',
          `guarded path pattern has an unsupported escape sequence '\\${next}': ${JSON.stringify(segment)}`,
        );
      }
      tokens.push({ kind: 'literal', value: next });
      i++; // consume the escaped character too
      continue;
    }
    if (ch === '*') { tokens.push({ kind: 'star' }); continue; }
    if (ch === '?') { tokens.push({ kind: 'question' }); continue; }
    if (GUARD_ALWAYS_REJECT_UNESCAPED.has(ch)) {
      throw new BridgeError(
        'MALFORMED_REQUEST',
        `guarded path pattern contains unescaped '${ch}' (unsupported glob syntax; escape as '\\${ch}' for a literal character): ${JSON.stringify(segment)}`,
      );
    }
    tokens.push({ kind: 'literal', value: ch });
  }
  return tokens;
}

/**
 * `**` (the cross-directory wildcard) is recognized ONLY when an entire raw
 * pattern segment tokenizes to EXACTLY two unescaped `*` tokens and nothing
 * else. `\*\*` (two escaped stars) tokenizes to two LITERAL tokens, not two
 * STAR tokens, so it is correctly excluded here — it means the literal
 * two-character text `**`, never the cross-directory wildcard. Likewise
 * `*\*` / `\**` (one escaped, one not) tokenize to a STAR and a LITERAL
 * token — length 2 but NOT both `star` — correctly excluded too.
 */
function isDoubleStarSegment(tokens: readonly GuardToken[]): boolean {
  return tokens.length === 2 && tokens[0]!.kind === 'star' && tokens[1]!.kind === 'star';
}

/**
 * Validate one raw `guardedPaths` entry from trusted executor config. Fails
 * closed on DANGEROUS PATH STRUCTURE and UNSUPPORTED GLOB LANGUAGE — empty,
 * absolute, NUL-containing, an unescaped leading `!` (negation), an
 * unescaped `[`/`]`/`{`/`}` anywhere, a dangling/unsupported backslash
 * escape, or a bare `.`/`..` path segment — never on ordinary literal
 * filename text merely for being absent from some ASCII allowlist (§R1) and
 * never on a character that merely LACKS an escape mechanism (§R2 — every
 * character `validateApplyPath` accepts can be escaped into an exact guard;
 * see {@link escapeGuardLiteralPath}). No Unicode normalization/case-
 * folding/transliteration is performed anywhere: pattern text is compared
 * using the exact same string/code-point semantics already used elsewhere
 * in this repository. `MALFORMED_REQUEST` mirrors the exact convention
 * `agentConfig.ts` already uses for trusted-configuration validation
 * problems (distinct from `PATH_VIOLATION`, reserved for an unsafe CHANGED
 * path, and from `GUARDED_PATH_DENIED`, which means both sides were valid
 * and legitimately matched — these three are never collapsed into one
 * reason).
 */
export function validateGuardPattern(pattern: string): string {
  if (pattern.length === 0) {
    throw new BridgeError('MALFORMED_REQUEST', 'guarded path pattern must not be empty');
  }
  if (pattern.includes('\0')) {
    throw new BridgeError('MALFORMED_REQUEST', 'guarded path pattern must not contain a NUL byte');
  }
  if (pattern.startsWith('/')) {
    throw new BridgeError('MALFORMED_REQUEST', `guarded path pattern must not be absolute: ${JSON.stringify(pattern)}`);
  }
  if (pattern[0] === '!') {
    throw new BridgeError(
      'MALFORMED_REQUEST',
      `guarded path pattern negation ('!') is not supported; escape as '\\!' for a literal leading '!': ${JSON.stringify(pattern)}`,
    );
  }
  for (const seg of pattern.split('/')) {
    if (seg === '') {
      throw new BridgeError('MALFORMED_REQUEST', `guarded path pattern has an empty path segment: ${JSON.stringify(pattern)}`);
    }
    if (seg === '.' || seg === '..') {
      throw new BridgeError('MALFORMED_REQUEST', `guarded path pattern must not contain '.' or '..' segments: ${JSON.stringify(pattern)}`);
    }
    tokenizeGuardSegment(seg); // throws MALFORMED_REQUEST on any escape/bracket/brace violation
  }
  return pattern;
}

// ---------------------------------------------------------------------------
// Bounded glob matcher — from scratch, no regex, no dependency, Unicode
// code-point aware (§R2).
// ---------------------------------------------------------------------------

/**
 * Classic bounded wildcard match WITHIN one path segment (never sees `/`),
 * over Unicode CODE POINTS: `*` matches zero or more code points, `?`
 * matches EXACTLY ONE code point (never a UTF-16 code unit — so `?` matches
 * a supplementary-plane character like an emoji, and never a grapheme
 * cluster — so a decomposed accented letter, e.g. `e` + combining acute,
 * counts as its TWO underlying code points, not one visual character), every
 * literal token matches itself exactly (no normalization). O(text code
 * points × token count) dynamic program — bounded and deterministic, never
 * backtracking-based.
 */
function matchSegmentTokens(textCps: readonly string[], tokens: readonly GuardToken[]): boolean {
  const n = textCps.length;
  const m = tokens.length;
  const dp: boolean[][] = Array.from({ length: n + 1 }, () => new Array<boolean>(m + 1).fill(false));
  dp[0]![0] = true;
  for (let j = 1; j <= m; j++) {
    if (tokens[j - 1]!.kind === 'star') dp[0]![j] = dp[0]![j - 1]!;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const t = tokens[j - 1]!;
      if (t.kind === 'star') {
        dp[i]![j] = dp[i - 1]![j]! || dp[i]![j - 1]!;
      } else if (t.kind === 'question' || (t.kind === 'literal' && t.value === textCps[i - 1])) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = false;
      }
    }
  }
  return dp[n]![m]!;
}

/**
 * Segment-level analogue of {@link matchSegmentTokens} for `**`: a pattern
 * segment recognized by {@link isDoubleStarSegment} matches zero or more
 * COMPLETE path segments (gitignore convention — including zero, so
 * `**\/*.pem` also matches a root-level `cert.pem`). Every non-`**` pattern
 * segment requires an exact 1:1 aligned path segment — this is what makes a
 * literal pattern segment (e.g. `config`) NOT an implicit recursive-descent
 * prefix. Each pattern segment is tokenized exactly ONCE (not per DP cell),
 * and each path segment is split into code points exactly once — the DP
 * itself is O(pathSegs.length × patternSegs.length), each cell's match cost
 * bounded by that segment pair's own code-point/token counts — polynomial
 * and bounded regardless of the specific characters involved.
 */
function matchSegments(pathSegs: readonly string[], patternSegs: readonly string[]): boolean {
  const n = pathSegs.length;
  const m = patternSegs.length;
  const patternTokens = patternSegs.map(tokenizeGuardSegment);
  const isDoubleStar = patternTokens.map(isDoubleStarSegment);
  const pathCps = pathSegs.map((s) => Array.from(s));
  const dp: boolean[][] = Array.from({ length: n + 1 }, () => new Array<boolean>(m + 1).fill(false));
  dp[0]![0] = true;
  for (let j = 1; j <= m; j++) {
    if (isDoubleStar[j - 1]) dp[0]![j] = dp[0]![j - 1]!;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (isDoubleStar[j - 1]) {
        dp[i]![j] = dp[i - 1]![j]! || dp[i]![j - 1]!;
      } else {
        dp[i]![j] = dp[i - 1]![j - 1]! && matchSegmentTokens(pathCps[i - 1]!, patternTokens[j - 1]!);
      }
    }
  }
  return dp[n]![m]!;
}

/**
 * Match a canonical path against a guard pattern that BOTH callers already
 * know are individually valid (§R3: private — never exported). Every
 * exported entry point in this module funnels through here only AFTER
 * calling {@link validateApplyPath}/{@link validateGuardPattern} itself (or,
 * for a batch of many paths/patterns, after validating the whole batch up
 * front — see {@link pathIsGuarded}, {@link assertChangesetNotGuarded}) —
 * this function never re-validates, so a caller cannot accidentally pay for
 * (or accidentally skip) validation twice.
 */
function matchValidated(canonicalPath: string, pattern: string): boolean {
  return matchSegments(canonicalPath.split('/'), pattern.split('/'));
}

/**
 * Whether one canonical repository-relative path matches one guard pattern.
 * §R3 fail-closed API-contract fix: this now independently enforces BOTH
 * {@link validateApplyPath} (throws `PATH_VIOLATION` for an unsafe path) and
 * {@link validateGuardPattern} (throws `MALFORMED_REQUEST` for a malformed
 * pattern) before matching — previously it delegated straight to
 * {@link matchSegments}, which only applies the tokenizer's PER-SEGMENT
 * escape/bracket/brace rules and does not replicate `validateGuardPattern`'s
 * PATTERN-level rules (empty, NUL, absolute, unescaped leading `!`, empty
 * segment, bare `.`/`..`) or `validateApplyPath`'s path-level rules at all —
 * so a caller of this exported function directly, without a separate
 * validation step, could get a boolean answer for an input the module's own
 * authoritative validators declare invalid (concretely:
 * `matchesGuardPattern('important.env', '!important.env')` used to return a
 * plain boolean instead of throwing, even though
 * `validateGuardPattern('!important.env')` already throws
 * `MALFORMED_REQUEST` — an exported policy primitive must never accept an
 * input its own validator rejects). Both validators are still the single
 * source of truth for what is safe/well-formed; this function does not
 * duplicate their rules, it simply always calls them first.
 */
export function matchesGuardPattern(canonicalPath: string, pattern: string): boolean {
  validateApplyPath(canonicalPath);
  validateGuardPattern(pattern);
  return matchValidated(canonicalPath, pattern);
}

/**
 * Whether one canonical path matches ANY entry in a project's guardedPaths
 * list. Fail closed: `canonicalPath` and every pattern are validated before
 * any matching occurs — `canonicalPath` once up front (it is the same path
 * for every pattern in the loop, so validating it once is correct, not a
 * weakening), each pattern individually as the loop reaches it. Uses the
 * private {@link matchValidated} directly (not the exported
 * {@link matchesGuardPattern}) purely to avoid re-validating the same
 * already-validated path on every loop iteration — the validation itself is
 * NOT skipped, only not repeated.
 */
export function pathIsGuarded(canonicalPath: string, guardedPaths: readonly string[]): boolean {
  validateApplyPath(canonicalPath);
  for (const pattern of guardedPaths) {
    validateGuardPattern(pattern);
    if (matchValidated(canonicalPath, pattern)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// §R2: Exact-literal guard generation — closes the expressiveness gap the
// independent audit found (a canonical path containing `* ? ! [ ] { }` could
// not previously be guarded exactly).
// ---------------------------------------------------------------------------

/**
 * Produce a guard pattern that matches EXACTLY the given canonical apply
 * path — no wildcard behavior can leak in from characters that happen to
 * appear in the path itself. Validates the input with
 * {@link validateApplyPath} first (throws `PATH_VIOLATION` on an unsafe
 * path), then escapes every {@link GUARD_ESCAPABLE} character it contains
 * (`* ? ! [ ] { }`) with a leading backslash; every other code point,
 * including `/` (the segment separator, always left literal) and every
 * ordinary R1 character, passes through unchanged. `!` is escaped
 * UNCONDITIONALLY (not only when leading) purely for implementation
 * simplicity — escaping a non-leading `!` is semantically inert (an
 * unescaped non-leading `!` is already an ordinary literal token; see
 * {@link GUARD_ALWAYS_REJECT_UNESCAPED}'s comment) and this keeps the
 * function free of positional special-casing. Pure: no filesystem I/O, no
 * locale behavior, no normalization, no state — iterates `path` by Unicode
 * code point (the string iterator), never by UTF-16 code unit.
 *
 * Security property: for every path P accepted by {@link validateApplyPath},
 * `matchesGuardPattern(P, escapeGuardLiteralPath(P))` is `true`, and
 * `validateGuardPattern(escapeGuardLiteralPath(P))` never throws.
 */
export function escapeGuardLiteralPath(path: string): string {
  validateApplyPath(path);
  let out = '';
  for (const cp of path) {
    out += GUARD_ESCAPABLE.has(cp) ? '\\' + cp : cp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-changeset guarded-path refusal
// ---------------------------------------------------------------------------

/**
 * Assert that NONE of a proposed apply changeset's paths match ANY of a
 * project's guardedPaths patterns. Fails closed, in this fixed order
 * (unchanged by §R3 — only the internal matching call changed, from the
 * exported {@link matchesGuardPattern} to the private {@link matchValidated},
 * purely to avoid re-validating every path against every pattern on every
 * iteration; the validation itself still happens, exactly once per pattern
 * and once per path, in the same two steps below, before ANY matching):
 *   1. every guard PATTERN is validated first (a malformed trusted-config
 *      entry aborts before a single path is ever evaluated against it);
 *   2. every CHANGED path is then validated as a safe canonical path (an
 *      invalid changed path aborts before any guard match is attempted —
 *      "invalid" and "guarded" are never the same reason);
 *   3. only once every input is known-well-formed does matching run — a
 *      match on ANY path throws immediately and rejects the WHOLE changeset;
 *      there is no partial-success return value and no per-file
 *      continuation.
 * Zero side effects: this function only throws or returns; it never persists
 * or transitions anything.
 */
export function assertChangesetNotGuarded(
  changedPaths: readonly string[],
  guardedPaths: readonly string[],
): void {
  for (const pattern of guardedPaths) validateGuardPattern(pattern);
  const canonicalPaths = changedPaths.map(validateApplyPath);
  for (const p of canonicalPaths) {
    for (const pattern of guardedPaths) {
      if (matchValidated(p, pattern)) {
        throw new BridgeError(
          'GUARDED_PATH_DENIED',
          `apply changeset denied: path matches guarded pattern ${JSON.stringify(pattern)}: ${JSON.stringify(p)}`,
          403,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Supported regular-file modes (mirrors baseCertifier.ts's frozen Git-mode
// mapping: 100644 -> 0o644, 100755 -> 0o755 — the only two regular-file
// modes B3 ever certifies as applicable).
// ---------------------------------------------------------------------------

export const SUPPORTED_REGULAR_FILE_MODES: ReadonlySet<number> = new Set([0o644, 0o755]);

export function isSupportedRegularFileMode(mode: number): boolean {
  return SUPPORTED_REGULAR_FILE_MODES.has(mode);
}

/**
 * Assert a regular-file mode is one this system ever applies. Reusable
 * as-is by later batches for precondition validation, POST-mutation success
 * verification, and rollback verification alike — the same pure predicate,
 * not three re-implementations. `PRECONDITION_FAILED` mirrors the existing
 * convention `jobStore.ts` already uses for "this operation does not meet a
 * required apply precondition" (e.g. `startApplyAttempt`'s COMPLETED-only
 * check) — no new error code is introduced for this in P1.
 */
export function assertSupportedRegularFileMode(mode: number): void {
  if (!isSupportedRegularFileMode(mode)) {
    throw new BridgeError(
      'PRECONDITION_FAILED',
      `unsupported regular-file mode for apply: ${mode.toString(8).padStart(4, '0')}`,
      409,
    );
  }
}
