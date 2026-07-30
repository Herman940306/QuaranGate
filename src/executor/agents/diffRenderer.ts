/**
 * A6-B4: Deterministic canonical diff renderer + bounded pagination.
 *
 * PURE module: it knows nothing about Docker, gateway principals, SQLite, the
 * host filesystem, or apply state. Its only input is a fully {@link
 * VerifiedArtifact} (verified by artifactReader) plus a bounded page request.
 *
 * Determinism contract: for a fixed (artifact, selection, DIFF_RENDER_VERSION)
 * the rendered UTF-8 byte sequence is identical every time. Any future change
 * to rendered bytes MUST increment {@link DIFF_RENDER_VERSION} so pagination
 * cursors remain stable.
 *
 * Memory contract: the complete rendered review is NEVER buffered in
 * production, and no blob content is cached anywhere. Rendering is a lazy
 * async line generator; measurement (pass 1) and bounded emission (pass 2)
 * each stream it independently, and each re-invokes {@link
 * VerifiedArtifact.readVerifiedBlob} for any selected regular-file content it
 * touches — pass 2 never reuses a buffer read during pass 1. For a
 * CONTENT_MODIFY of two regular files, up to two selected-file `Buffer`s
 * (BEFORE + POST), their decoded text, and the bounded Myers/edit-op state
 * derived from them may be live at once; every other operation holds at most
 * one selected-file buffer at a time. What is never held, for any operation,
 * is an additional complete *rendered* representation of the diff — hunk
 * text and the replace-all fallback are both produced by generators that
 * yield lines progressively rather than accumulating them into an array.
 */
import { createHash } from 'node:crypto';
import { BridgeError } from '../../shared/errors.js';
import type {
  SnapshotEntry,
  SnapshotFileEntry,
  SnapshotSymlinkEntry,
  SnapshotGitlinkEntry,
  SnapshotUnsupportedEntry,
} from './canonicalJson.js';
import type { VerifiedArtifact } from './artifactReader.js';

/** Renderer/pagination version — NOT artifact/approval/change identity. */
export const DIFF_RENDER_VERSION = 1;

/** Matches the existing 256 KiB output cap (agentSchemas MAX_AGENT_DIFF_CHUNK_BYTES). */
export const MAX_DIFF_CHUNK_BYTES = 256 * 1024;
export const MIN_DIFF_CHUNK_BYTES = 1024;

/** Line-count ceiling above which the text diff falls back to replace-all (bounded memory). */
const MAX_DIFF_LINES = 200_000;
const CONTEXT = 3;

// ---------------------------------------------------------------------------
// Result shape (executor → gateway wire; mirrors shared AgentDiff)
// ---------------------------------------------------------------------------

export interface DiffPageResult {
  jobId: string;
  diffHash: string;
  path?: string;
  chunk: string;
  chunkBytes: number;
  totalBytes: number;
  truncated: boolean;
  cursor?: string;
  // First-chunk verified canonical metadata (offset 0 only).
  artifactHash?: string;
  changeSetHash?: string;
  baseCommit?: string;
  contentComplete?: boolean;
  applicable?: boolean;
  reason?: string | null;
  opCount?: number;
  artifactBytes?: number;
}

export interface DiffPageRequest {
  jobId: string;
  path?: string;
  cursor?: string;
  maxBytes?: number;
}

function malformed(message: string): never {
  throw new BridgeError('MALFORMED_REQUEST', message, 400);
}

// ---------------------------------------------------------------------------
// Review-safe display encoding (§27)
// ---------------------------------------------------------------------------

/**
 * Deterministic reversible JSON-style display encoder for paths and symlink
 * targets. Escapes structural/spoofing characters so a hostile identity can
 * never inject a fake `diff`/`---`/`+++`/`operation`/`@@` header. Canonical
 * identity/hash values are NEVER passed through this — only human display text.
 */
export function encodeDisplay(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (
      cp < 0x20 ||                       // C0 controls
      cp === 0x2028 || cp === 0x2029 ||  // line / paragraph separators
      cp === 0x061c ||                   // arabic letter mark
      cp === 0x200e || cp === 0x200f ||  // LRM / RLM
      (cp >= 0x202a && cp <= 0x202e) ||  // LRE RLE PDF LRO RLO
      (cp >= 0x2066 && cp <= 0x2069)     // LRI RLI FSI PDI
    ) {
      out += '\\u' + cp.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text / binary classification (§23)
// ---------------------------------------------------------------------------

const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export function classifyContent(buf: Buffer): 'text' | 'binary' {
  if (buf.length === 0) return 'text';           // zero-byte file is TEXT
  if (buf.includes(0x00)) return 'binary';        // any NUL → BINARY
  try {
    strictDecoder.decode(buf);                    // fatal decode: invalid UTF-8 throws
    return 'text';
  } catch {
    return 'binary';
  }
}

function decodeText(buf: Buffer): string {
  return buf.toString('utf8');
}

/** Canonical mode is the lower-12-bit permission; render as 4-digit octal. */
function fmtMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Deterministic line diff (Myers O(ND)) + unified hunks (§25)
// ---------------------------------------------------------------------------

type DiffOp = { type: 'eq' | 'del' | 'ins'; text: string };

function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === '') return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), finalNewline };
}

/**
 * Hard, deterministic trace-memory budget for Myers (§R4 remediation).
 *
 * Each retained trace entry (`trace.push(v.slice())`) is exactly
 * `2*(n+m)+1` numeric cells — the complete `v` array for that edit-distance
 * `d`. This directly bounds the dominant retained-memory cost of this
 * implementation (`trace: number[][]`) in units of retained numeric cells,
 * not an indirect proxy like total line count: a line-count ceiling alone
 * cannot prevent O(D×(N+M)) retained cells for adversarial inputs where the
 * edit distance D approaches N+M while N+M itself stays well under any
 * reasonable per-file line ceiling.
 *
 * This is a memory-cell bound, not a byte/RSS bound — actual process memory
 * per cell depends on V8's internal number representation and is not
 * pinned by this constant.
 *
 * Because bounding retained cells caps the number of outer iterations `D`
 * for a fixed `n+m`, and each outer iteration performs only O(d) + O(n+m)
 * work before the next budget check, bounding retained cells transitively
 * bounds total algorithmic work too — an attacker cannot keep the trace
 * under budget while forcing unbounded extra computation.
 */
const MAX_MYERS_TRACE_CELLS = 4_000_000;

/** Numeric cells retained by one Myers `v` snapshot for arrays of length n, m. */
function myersSnapshotCells(n: number, m: number): number {
  return 2 * (n + m) + 1;
}

/**
 * Whether retaining one more trace snapshot (on top of `snapshotsSoFar`
 * already retained) would exceed {@link MAX_MYERS_TRACE_CELLS}. Pure and
 * deterministic — exported so the budget decision itself is directly unit
 * testable independent of running the full algorithm (§R4-M10).
 */
export function wouldExceedMyersTraceBudget(n: number, m: number, snapshotsSoFar: number): boolean {
  return (snapshotsSoFar + 1) * myersSnapshotCells(n, m) > MAX_MYERS_TRACE_CELLS;
}

/**
 * Deterministic Myers shortest-edit-script over line arrays. Returns `null`
 * to SIGNAL that the safe algorithmic budget was exceeded and the caller must
 * use the progressive replace-all fallback ({@link fallbackDiffLines}) —
 * this function never itself materializes a complete replace-all `DiffOp[]`
 * for that case. When it returns a real array, that array is the
 * already-approved bounded edit structure (§R4): at most `n+m` entries,
 * itself bounded by {@link MAX_DIFF_LINES} and by how few outer iterations
 * fit under {@link MAX_MYERS_TRACE_CELLS}.
 */
function myers(a: string[], b: string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n + m > MAX_DIFF_LINES) return null;
  const max = n + m;
  const offset = max;
  const v = new Array<number>(2 * max + 1).fill(0);
  const trace: number[][] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    // Hard budget check BEFORE allocating this d's trace snapshot — and
    // before this d's O(n+m) k-loop work runs at all — so Myers can neither
    // over-allocate nor over-compute past the configured safety budget.
    if (wouldExceedMyersTraceBudget(n, m, trace.length)) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x]! === b[y]!) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break outer; }
    }
  }
  // Backtrack the canonical Myers path.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[offset + k - 1]! < vv[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ type: 'eq', text: a[x - 1]! }); x--; y--; }
    if (x === prevX) { ops.push({ type: 'ins', text: b[y - 1]! }); y--; }
    else { ops.push({ type: 'del', text: a[x - 1]! }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ type: 'eq', text: a[x - 1]! }); x--; y--; }
  while (x > 0) { ops.push({ type: 'del', text: a[x - 1]! }); x--; }
  while (y > 0) { ops.push({ type: 'ins', text: b[y - 1]! }); y--; }
  ops.reverse();
  return ops;
}

function fmtRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/**
 * Group edit ops into deterministic unified-diff hunks with CONTEXT lines,
 * YIELDING each header/line progressively instead of accumulating the
 * rendered hunk text into an array (§R2 remediation Blocker 1). The
 * annotated-ops working structure (`ann`/`clusters`) is the same bounded size
 * class as the already-approved `ops` array (§R4) — it is line-numbering
 * metadata over the edit script, not a rendered text representation, so
 * retaining it briefly here does not reintroduce a "complete rendered diff"
 * buffer.
 */
function* unifiedHunks(ops: DiffOp[]): Generator<string> {
  if (ops.length === 0 || ops.every((o) => o.type === 'eq')) return;
  interface Ann { op: DiffOp; oldNo: number; newNo: number }
  const ann: Ann[] = [];
  let oa = 0;
  let ob = 0;
  for (const op of ops) {
    if (op.type === 'eq') { oa++; ob++; ann.push({ op, oldNo: oa, newNo: ob }); }
    else if (op.type === 'del') { oa++; ann.push({ op, oldNo: oa, newNo: ob }); }
    else { ob++; ann.push({ op, oldNo: oa, newNo: ob }); }
  }
  const changeIdx: number[] = [];
  ann.forEach((a, i) => { if (a.op.type !== 'eq') changeIdx.push(i); });
  const clusters: Array<[number, number]> = [];
  let cs = changeIdx[0]!;
  let ce = changeIdx[0]!;
  for (let t = 1; t < changeIdx.length; t++) {
    const idx = changeIdx[t]!;
    if (idx - ce - 1 <= 2 * CONTEXT) ce = idx;
    else { clusters.push([cs, ce]); cs = ce = idx; }
  }
  clusters.push([cs, ce]);

  for (const [firstC, lastC] of clusters) {
    const start = Math.max(0, firstC - CONTEXT);
    const stop = Math.min(ann.length, lastC + CONTEXT + 1);
    const slice = ann.slice(start, stop);
    const oldLines = slice.filter((a) => a.op.type === 'eq' || a.op.type === 'del');
    const newLines = slice.filter((a) => a.op.type === 'eq' || a.op.type === 'ins');
    const oldStart = oldLines.length ? oldLines[0]!.oldNo : 0;
    const newStart = newLines.length ? newLines[0]!.newNo : 0;
    yield `@@ -${fmtRange(oldStart, oldLines.length)} +${fmtRange(newStart, newLines.length)} @@`;
    for (const a of slice) {
      const prefix = a.op.type === 'eq' ? ' ' : a.op.type === 'del' ? '-' : '+';
      yield prefix + a.op.text;
    }
  }
}

/**
 * Progressive replace-all fallback (§R4 + §R2 remediation Blocker 1): yields
 * every BEFORE line as a removal and every POST line as an addition —
 * exactly the single-hunk shape {@link unifiedHunks} would have produced for
 * an all-delete-then-all-insert `DiffOp[]` (verified equivalent: with no `eq`
 * ops, the whole sequence is one cluster spanning the complete array, so
 * `oldLines`/`newLines` there are simply all of `a`/`b`) — but WITHOUT ever
 * constructing that `DiffOp[]` or an annotated/rendered array first. Streams
 * directly from the already-live `a`/`b` line arrays.
 */
function* fallbackDiffLines(a: string[], b: string[]): Generator<string> {
  const oldStart = a.length > 0 ? 1 : 0;
  const newStart = b.length > 0 ? 1 : 0;
  yield `@@ -${fmtRange(oldStart, a.length)} +${fmtRange(newStart, b.length)} @@`;
  for (const line of a) yield '-' + line;
  for (const line of b) yield '+' + line;
}

/**
 * Render a text diff between an optional BEFORE side and optional AFTER
 * side, YIELDING rendered lines progressively — never building or returning
 * a complete `string[]` of the rendered result (§R2 remediation Blocker 1).
 * A null side means "absent" (ADD has null before, DELETE has null after).
 * Exported (in addition to internal use) purely so this architectural
 * property — a lazy `Generator`, never an array — is directly unit
 * testable; it remains a pure, side-effect-free function.
 */
export function* renderTextDiff(beforeText: string | null, afterText: string | null): Generator<string> {
  const a = beforeText === null ? { lines: [] as string[], finalNewline: true } : splitLines(beforeText);
  const b = afterText === null ? { lines: [] as string[], finalNewline: true } : splitLines(afterText);
  const ops = myers(a.lines, b.lines);
  if (ops === null) {
    yield* fallbackDiffLines(a.lines, b.lines);
  } else {
    yield* unifiedHunks(ops);
  }
  if (beforeText !== null && beforeText.length > 0 && !a.finalNewline) {
    yield '\\ No newline at end of file (before)';
  }
  if (afterText !== null && afterText.length > 0 && !b.finalNewline) {
    yield '\\ No newline at end of file (after)';
  }
}

// ---------------------------------------------------------------------------
// Per-operation canonical rendering (§22, §24, §26)
// ---------------------------------------------------------------------------

async function sideIdentity(v: VerifiedArtifact, e: SnapshotEntry): Promise<string> {
  switch (e.kind) {
    case 'file': {
      const fe = e as SnapshotFileEntry;
      const buf = await v.readVerifiedBlob(fe.contentHash, fe.sizeBytes);
      return `file mode ${fmtMode(fe.mode)} ${classifyContent(buf)} ${fe.sizeBytes} bytes, sha256:${fe.contentHash}`;
    }
    case 'symlink': {
      const se = e as SnapshotSymlinkEntry;
      return `symlink mode ${fmtMode(se.mode)} target "${encodeDisplay(se.target)}"`;
    }
    case 'dir':
      return `directory mode ${fmtMode(e.mode)}`;
    case 'gitlink':
      return `gitlink commit ${(e as SnapshotGitlinkEntry).commitOid}`;
    case 'unsupported':
      return `unsupported reason "${encodeDisplay((e as SnapshotUnsupportedEntry).reason)}"`;
  }
}

async function* renderAdd(v: VerifiedArtifact, path: string, after: SnapshotEntry): AsyncGenerator<string> {
  switch (after.kind) {
    case 'file': {
      const fe = after as SnapshotFileEntry;
      yield `new file mode ${fmtMode(fe.mode)}`;
      const buf = await v.readVerifiedBlob(fe.contentHash, fe.sizeBytes);
      if (classifyContent(buf) === 'binary') {
        yield 'Binary file added';
        yield `after: ${fe.sizeBytes} bytes, sha256:${fe.contentHash}`;
      } else {
        yield '--- /dev/null';
        yield `+++ b/"${encodeDisplay(path)}"`;
        yield* renderTextDiff(null, decodeText(buf));
      }
      break;
    }
    case 'symlink':
      yield `new symlink mode ${fmtMode(after.mode)}`;
      yield `symlink target added: "${encodeDisplay((after as SnapshotSymlinkEntry).target)}"`;
      break;
    case 'dir':
      yield `new directory mode ${fmtMode(after.mode)}`;
      break;
    case 'gitlink':
      yield 'new gitlink';
      yield `after: commit ${(after as SnapshotGitlinkEntry).commitOid}`;
      break;
    case 'unsupported':
      yield 'new unsupported entry';
      yield `reason: "${encodeDisplay((after as SnapshotUnsupportedEntry).reason)}"`;
      break;
  }
}

async function* renderDelete(v: VerifiedArtifact, path: string, before: SnapshotEntry): AsyncGenerator<string> {
  switch (before.kind) {
    case 'file': {
      const fe = before as SnapshotFileEntry;
      yield `deleted file mode ${fmtMode(fe.mode)}`;
      const buf = await v.readVerifiedBlob(fe.contentHash, fe.sizeBytes);
      if (classifyContent(buf) === 'binary') {
        yield 'Binary file deleted';
        yield `before: ${fe.sizeBytes} bytes, sha256:${fe.contentHash}`;
      } else {
        yield `--- a/"${encodeDisplay(path)}"`;
        yield '+++ /dev/null';
        yield* renderTextDiff(decodeText(buf), null);
      }
      break;
    }
    case 'symlink':
      yield `deleted symlink mode ${fmtMode(before.mode)}`;
      yield `symlink target deleted: "${encodeDisplay((before as SnapshotSymlinkEntry).target)}"`;
      break;
    case 'dir':
      yield `deleted directory mode ${fmtMode(before.mode)}`;
      break;
    case 'gitlink':
      yield 'deleted gitlink';
      yield `before: commit ${(before as SnapshotGitlinkEntry).commitOid}`;
      break;
    case 'unsupported':
      yield 'deleted unsupported entry';
      yield `reason: "${encodeDisplay((before as SnapshotUnsupportedEntry).reason)}"`;
      break;
  }
}

async function* renderContentModify(v: VerifiedArtifact, path: string, before: SnapshotEntry, after: SnapshotEntry): AsyncGenerator<string> {
  if (before.kind === 'file' && after.kind === 'file') {
    const bFe = before as SnapshotFileEntry;
    const aFe = after as SnapshotFileEntry;
    const bBuf = await v.readVerifiedBlob(bFe.contentHash, bFe.sizeBytes);
    const aBuf = await v.readVerifiedBlob(aFe.contentHash, aFe.sizeBytes);
    if (classifyContent(bBuf) === 'binary' || classifyContent(aBuf) === 'binary') {
      yield 'Binary file changed';
      yield `before: ${bFe.sizeBytes} bytes, sha256:${bFe.contentHash}`;
      yield `after: ${aFe.sizeBytes} bytes, sha256:${aFe.contentHash}`;
    } else {
      yield `--- a/"${encodeDisplay(path)}"`;
      yield `+++ b/"${encodeDisplay(path)}"`;
      yield* renderTextDiff(decodeText(bBuf), decodeText(aBuf));
    }
  } else if (before.kind === 'gitlink' && after.kind === 'gitlink') {
    yield 'gitlink changed';
    yield `before: commit ${(before as SnapshotGitlinkEntry).commitOid}`;
    yield `after: commit ${(after as SnapshotGitlinkEntry).commitOid}`;
  }
}

function* renderModeChange(before: SnapshotEntry, after: SnapshotEntry): Generator<string> {
  yield `old mode ${fmtMode(before.mode)}`;
  yield `new mode ${fmtMode(after.mode)}`;
}

function* renderSymlinkChange(before: SnapshotEntry, after: SnapshotEntry): Generator<string> {
  yield `old target "${encodeDisplay((before as SnapshotSymlinkEntry).target)}"`;
  yield `new target "${encodeDisplay((after as SnapshotSymlinkEntry).target)}"`;
}

/**
 * Render one TYPE_CHANGE side (§R5 remediation). Always yields the existing
 * structural identity line first (unchanged for non-file kinds — reuses
 * {@link sideIdentity}). When the side is a regular file, reads the blob
 * exactly once here (never via {@link sideIdentity}, to avoid a redundant
 * second verified read of the same evidence) and, for TEXT content, follows
 * with the complete content as removal (`before`) or addition (`after`)
 * evidence using the same unified-hunk text-diff primitive as ADD/DELETE.
 * Binary file content is never dumped — metadata only, per existing policy.
 */
async function* renderTypeChangeSide(
  v: VerifiedArtifact,
  path: string,
  side: 'before' | 'after',
  e: SnapshotEntry,
): AsyncGenerator<string> {
  if (e.kind !== 'file') {
    yield `${side}: ${await sideIdentity(v, e)}`;
    return;
  }
  const fe = e as SnapshotFileEntry;
  const buf = await v.readVerifiedBlob(fe.contentHash, fe.sizeBytes);
  const cls = classifyContent(buf);
  yield `${side}: file mode ${fmtMode(fe.mode)} ${cls} ${fe.sizeBytes} bytes, sha256:${fe.contentHash}`;
  if (cls !== 'text') return; // binary: metadata-only, never dumped
  if (side === 'before') {
    yield `--- a/"${encodeDisplay(path)}"`;
    yield '+++ /dev/null';
    yield* renderTextDiff(decodeText(buf), null);
  } else {
    yield '--- /dev/null';
    yield `+++ b/"${encodeDisplay(path)}"`;
    yield* renderTextDiff(null, decodeText(buf));
  }
}

async function* renderTypeChange(v: VerifiedArtifact, path: string, before: SnapshotEntry, after: SnapshotEntry): AsyncGenerator<string> {
  yield `old type ${before.kind}`;
  yield `new type ${after.kind}`;
  yield* renderTypeChangeSide(v, path, 'before', before);
  yield* renderTypeChangeSide(v, path, 'after', after);
}

/**
 * Lazy logical-line generator for the selected review. Canonical operations
 * (already sorted lexicographically by path in the verified manifest) are the
 * authoritative input; the optional selection filters to one exact canonical
 * changed path.
 */
export async function* renderLines(v: VerifiedArtifact, selectionPath?: string): AsyncGenerator<string> {
  for (const change of v.manifest.changes) {
    if (selectionPath !== undefined && change.path !== selectionPath) continue;
    yield `diff --mcp "${encodeDisplay(change.path)}"`;
    yield `operation: ${change.op}`;
    const before = v.beforeMap.get(change.path);
    const after = v.postMap.get(change.path);
    switch (change.op) {
      case 'ADD': yield* renderAdd(v, change.path, after!); break;
      case 'DELETE': yield* renderDelete(v, change.path, before!); break;
      case 'CONTENT_MODIFY': yield* renderContentModify(v, change.path, before!, after!); break;
      case 'MODE_CHANGE': yield* renderModeChange(before!, after!); break;
      case 'SYMLINK_CHANGE': yield* renderSymlinkChange(before!, after!); break;
      case 'TYPE_CHANGE': yield* renderTypeChange(v, change.path, before!, after!); break;
    }
  }
}

/** Byte stream = each logical line followed by a single '\n' (all valid UTF-8). */
async function* renderBytes(v: VerifiedArtifact, selectionPath?: string): AsyncGenerator<Buffer> {
  for await (const line of renderLines(v, selectionPath)) {
    yield Buffer.from(line + '\n', 'utf8');
  }
}

/** TEST-ONLY reference: full rendered bytes (production never buffers the whole diff). */
export async function renderFullBytes(v: VerifiedArtifact, selectionPath?: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of renderBytes(v, selectionPath)) parts.push(b);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Selection identity (§30)
// ---------------------------------------------------------------------------

export function selectionIdentity(path?: string): string {
  if (path === undefined) return '*';
  return createHash('sha256').update(Buffer.from(path, 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// Cursor (§29)
// ---------------------------------------------------------------------------

interface CursorPayload { v: number; r: number; a: string; s: string; o: number }

export function encodeCursor(p: CursorPayload): string {
  const json = JSON.stringify({ v: p.v, r: p.r, a: p.a, s: p.s, o: p.o });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Strictly validate a cursor's structure/identity fields and return its
 * (unbounded) numeric offset. Does NOT check the offset against totalBytes or
 * UTF-8 boundary validity — those require the pass-1 measurement stream and
 * are enforced by {@link measureAndValidateOffset} once totalBytes is known,
 * so this function alone never needs the full rendered output.
 */
function decodeCursorFields(token: string, artifactHash: string, selId: string): number {
  if (token.length === 0 || !/^[A-Za-z0-9_-]+$/.test(token)) malformed('cursor is not base64url');
  const json = Buffer.from(token, 'base64url').toString('utf8');
  let obj: unknown;
  try { obj = JSON.parse(json); } catch { malformed('cursor is not valid JSON'); }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) malformed('cursor shape invalid');
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const expected = ['a', 'o', 'r', 's', 'v'];
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) malformed('cursor has unexpected fields');
  if (o.v !== 1) malformed('cursor version mismatch');
  if (o.r !== DIFF_RENDER_VERSION) malformed('cursor render version mismatch');
  if (o.a !== artifactHash) malformed('cursor artifact mismatch');
  if (o.s !== selId) malformed('cursor selection mismatch');
  if (typeof o.o !== 'number' || !Number.isInteger(o.o) || !Number.isSafeInteger(o.o) || o.o < 0 || Object.is(o.o, -0)) {
    malformed('cursor offset invalid');
  }
  return o.o;
}

/** A byte is a UTF-8 continuation byte (10xxxxxx) — never a legal code-point start. */
function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Stream the deterministic rendered output exactly once to (a) measure its
 * exact total UTF-8 byte length and (b) determine, without ever buffering
 * the full output, whether `rawOffset` begins on a legal UTF-8 code-point
 * boundary of that stream. Each yielded buffer is one complete logical line
 * (`Buffer.from(line + '\n', 'utf8')`), so it always starts and ends on a
 * whole code point; only the single byte at the candidate offset — wherever
 * it falls within whichever line buffer currently covers it — needs to be
 * inspected. Throws MALFORMED_REQUEST for an out-of-range or interior
 * (continuation-byte) offset; 0 and totalBytes are always legal.
 */
async function measureAndValidateOffset(
  v: VerifiedArtifact,
  selectionPath: string | undefined,
  rawOffset: number,
): Promise<number> {
  let totalBytes = 0;
  let boundaryValid = false;
  for await (const buf of renderBytes(v, selectionPath)) {
    const start = totalBytes;
    totalBytes += buf.length;
    if (rawOffset >= start && rawOffset < totalBytes) {
      boundaryValid = !isUtf8ContinuationByte(buf[rawOffset - start]!);
    }
  }
  if (rawOffset > totalBytes) malformed('cursor offset out of range');
  if (rawOffset !== 0 && rawOffset !== totalBytes && !boundaryValid) {
    malformed('cursor offset does not begin on a UTF-8 code-point boundary');
  }
  return totalBytes;
}

// ---------------------------------------------------------------------------
// UTF-8-bounded chunking (§31, §32)
// ---------------------------------------------------------------------------

/**
 * Largest index <= buf.length ending on a complete UTF-8 code point. Because
 * the full stream is valid UTF-8, an incomplete trailing code point in `buf`
 * means the code point continues beyond this window — so we cut before it.
 */
function safeUtf8Cut(buf: Buffer): number {
  let i = buf.length;
  let cont = 0;
  while (i > 0 && (buf[i - 1]! & 0xc0) === 0x80) { i--; cont++; }
  if (i === 0) return buf.length;
  const lead = buf[i - 1]!;
  let expected: number;
  if ((lead & 0x80) === 0) expected = 1;
  else if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else expected = 1;
  const have = 1 + cont;
  if (have >= expected) return buf.length; // trailing code point complete
  return i - 1;                             // trailing code point incomplete → cut before lead byte
}

/** Collect at most `want` bytes of the stream starting at absolute `offset`. */
async function collectWindow(v: VerifiedArtifact, selectionPath: string | undefined, offset: number, want: number): Promise<Buffer> {
  if (want <= 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let collected = 0;
  let pos = 0;
  for await (const buf of renderBytes(v, selectionPath)) {
    const start = pos;
    pos += buf.length;
    if (pos <= offset) continue;
    const from = Math.max(0, offset - start);
    let slice = buf.subarray(from);
    if (collected + slice.length > want) slice = slice.subarray(0, want - collected);
    parts.push(slice);
    collected += slice.length;
    if (collected >= want) break;
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Two-pass bounded page rendering (§28)
// ---------------------------------------------------------------------------

export async function renderDiffPage(v: VerifiedArtifact, req: DiffPageRequest): Promise<DiffPageResult> {
  const selId = selectionIdentity(req.path);
  const maxBytes = Math.max(MIN_DIFF_CHUNK_BYTES, Math.min(req.maxBytes ?? MAX_DIFF_CHUNK_BYTES, MAX_DIFF_CHUNK_BYTES));

  const offset = req.cursor !== undefined ? decodeCursorFields(req.cursor, v.artifactHash, selId) : 0;

  // PASS 1 — measure exact UTF-8 total AND validate the cursor's UTF-8
  // code-point boundary in the same bounded stream (retains nothing beyond
  // the current line; fresh evidence reads).
  const totalBytes = await measureAndValidateOffset(v, req.path, offset);

  // PASS 2 — bounded emission from `offset` (independent fresh evidence reads).
  const want = Math.min(maxBytes, totalBytes - offset);
  const windowBuf = await collectWindow(v, req.path, offset, want);
  const hasMore = offset + windowBuf.length < totalBytes;

  let emit: Buffer;
  let truncated: boolean;
  if (!hasMore) {
    emit = windowBuf;
    truncated = false;
  } else {
    const nl = windowBuf.lastIndexOf(0x0a);
    const cut = nl >= 0 ? nl + 1 : safeUtf8Cut(windowBuf);
    emit = windowBuf.subarray(0, cut);
    truncated = true;
  }

  const chunk = emit.toString('utf8');
  const result: DiffPageResult = {
    jobId: req.jobId,
    diffHash: v.artifactHash,
    chunk,
    chunkBytes: emit.length,
    totalBytes,
    truncated,
  };
  if (req.path !== undefined) result.path = req.path;
  if (truncated) {
    result.cursor = encodeCursor({ v: 1, r: DIFF_RENDER_VERSION, a: v.artifactHash, s: selId, o: offset + emit.length });
  }
  // First-chunk verified canonical metadata (absent cursor / validated offset 0).
  if (offset === 0) {
    const m = v.manifest;
    result.artifactHash = v.artifactHash;
    result.changeSetHash = m.changeSetHash;
    result.baseCommit = m.baseCommit;
    result.contentComplete = m.contentComplete;
    result.applicable = m.applicable;
    result.reason = m.reason;
    result.opCount = m.opCount;
    result.artifactBytes = m.artifactBytes;
  }
  return result;
}
