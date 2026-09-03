/**
 * Filesystem operations via the Docker archive (tar) API for content IO and
 * confined argv execs for listing/searching/stat. No shell quoting of paths.
 */
import { extract, pack } from 'tar-stream';
import { Readable } from 'node:stream';
import path from 'node:path';
import { BridgeError } from '../shared/errors.js';
import { EXECUTOR_DEFAULTS, type FileStat } from '../shared/types.js';
import { getArchive, putArchive } from './docker.js';
import { confinePath, runArgv, type ConfinedTarget } from './execops.js';

async function readTarSingleFile(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ex = extract();
    let found: Buffer | null = null;
    let total = 0;
    ex.on('entry', (header, entryStream, next) => {
      if (header.type !== 'file') {
        entryStream.resume();
        entryStream.on('end', next);
        return;
      }
      const chunks: Buffer[] = [];
      entryStream.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          reject(new BridgeError('OUTPUT_TRUNCATED', `file exceeds ${maxBytes} bytes`, 413));
          entryStream.destroy();
          return;
        }
        chunks.push(c);
      });
      entryStream.on('end', () => {
        found = Buffer.concat(chunks);
        next();
      });
    });
    ex.on('finish', () => resolve(found ?? Buffer.alloc(0)));
    ex.on('error', reject);
    stream.pipe(ex);
  });
}

export async function readFile(t: ConfinedTarget, rel: string, maxBytes = EXECUTOR_DEFAULTS.maxFileBytes): Promise<Buffer> {
  const abs = await confinePath(t, rel, { mustExist: true });
  const { body } = await getArchive(t.containerId, abs);
  // Clamp trusted maxBytes to never exceed global maximum
  const clampedMax = Math.min(maxBytes, EXECUTOR_DEFAULTS.maxFileBytes);
  return readTarSingleFile(body, clampedMax);
}

/** The uid/gid a tar entry must carry so extraction lands correct ownership. */
export interface TarOwnership {
  uid: number;
  gid: number;
}

/** Tagged `id`/`st` lines emitted by the ownership probe below. */
const OWNERSHIP_LINE = /^(id|st) (\d{1,10}) (\d{1,10})$/;

function parseOwnershipLine(tag: 'id' | 'st', lines: string[]): TarOwnership | null {
  let found: TarOwnership | null = null;
  // Last match wins: a line prepended to the probe's stdout can never displace
  // the genuine trailing one.
  for (const line of lines) {
    const m = OWNERSHIP_LINE.exec(line);
    if (!m || m[1] !== tag) continue;
    const uid = Number(m[2]);
    const gid = Number(m[3]);
    // uid/gid are 32-bit unsigned on Linux; anything else is not trustworthy.
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) continue;
    if (uid > 0xffff_ffff || gid > 0xffff_ffff) continue;
    found = { uid, gid };
  }
  return found;
}

/**
 * Resolve the ownership a write must carry.
 *
 * Docker extracts an uploaded archive as the daemon (root) and applies the tar
 * header's uid/gid verbatim, so an entry that omits them lands root-owned — for
 * a brand-new file AND for an overwrite of a file the target user owns. That
 * makes files written through fs_write/fs_patch uneditable by the target's own
 * user, which terminal_exec-created files never are.
 *
 * - existing path -> its current uid/gid, so an overwrite never re-owns a file;
 * - new path      -> the target's exec identity, i.e. exactly the ownership the
 *   same file would get from terminal_exec.
 *
 * Both come from ONE confined argv exec. The exec runs as the container's own
 * default user (execCreate never sets `User`), so a numeric `1000`, a
 * `1000:1000` pair, a named user and the default root all resolve identically —
 * no parsing of Docker's `User` string and no host identity anywhere.
 *
 * Caveat: this is the container's configured `User`, which is what `docker exec`
 * inherits — NOT the uid of a process that dropped privileges after start (a
 * gosu/su-exec entrypoint). Such a target reports root here, so a *new* file
 * lands root-owned. It still matches terminal_exec, and existing files are
 * unaffected because the `st` branch wins.
 *
 * Fails closed: unresolvable identity is never silently downgraded to 0:0.
 */
export async function resolveWriteOwnership(t: ConfinedTarget, abs: string): Promise<TarOwnership> {
  const r = await runArgv(
    t,
    [
      '/bin/sh',
      '-c',
      "printf 'id %s %s\\n' \"$(id -u)\" \"$(id -g)\"; " +
        "stat -c 'st %u %g' -- \"$1\" 2>/dev/null || stat -f 'st %u %g' -- \"$1\" 2>/dev/null || true",
      'sh',
      abs,
    ],
    { principal: 'executor', timeoutMs: 10_000, maxOutputBytes: 4096 },
  );
  // A clipped line is a prefix of a real one and would still parse (`st 1000 10`
  // out of `st 1000 1000`), so truncated output is never parsed at all.
  if (r.truncated) {
    throw new BridgeError('TARGET_UNSUPPORTED', 'ownership probe output was truncated; refusing to write', 422);
  }
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  // An existing path keeps its own ownership.
  const existing = parseOwnershipLine('st', lines);
  if (existing) return existing;

  const identity = parseOwnershipLine('id', lines);
  if (!identity) {
    throw new BridgeError(
      'TARGET_UNSUPPORTED',
      'cannot resolve the effective runtime user of the target (id -u/-g); refusing to write with unknown ownership',
      422,
    );
  }
  return identity;
}

export async function writeFile(t: ConfinedTarget, rel: string, content: Buffer, mode = 0o644): Promise<void> {
  if (content.length > EXECUTOR_DEFAULTS.maxFileBytes) {
    throw new BridgeError('MALFORMED_REQUEST', `file exceeds ${EXECUTOR_DEFAULTS.maxFileBytes} bytes`, 413);
  }
  const abs = await confinePath(t, rel, { mustExist: false });
  const dir = path.posix.dirname(abs);
  const base = path.posix.basename(abs);

  // Ensure parent dir exists (confined argv, no shell). Created by the target's
  // own user, so a new directory is already correctly owned.
  await runArgv(t, ['mkdir', '-p', dir], { principal: 'executor', timeoutMs: 10_000 });

  // Resolved AFTER mkdir so the probe sees the final path, and after confinePath
  // so `abs` is already canonical and inside the workspace.
  const { uid, gid } = await resolveWriteOwnership(t, abs);

  const tar = pack();
  // uid/gid only — no uname/gname, so extraction can never resolve ownership
  // through a name lookup in the daemon's namespace.
  tar.entry({ name: base, mode, uid, gid, size: content.length, mtime: new Date() }, content);
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const c of tar) chunks.push(c as Buffer);
  await putArchive(t.containerId, dir, Buffer.concat(chunks));
}

export async function statPath(t: ConfinedTarget, rel: string): Promise<FileStat> {
  const abs = await confinePath(t, rel, { mustExist: true });
  // stat with a stable, parseable format via positional arg.
  const r = await runArgv(
    t,
    ['/bin/sh', '-c', 'stat -c "%s|%f|%A|%Y|%F" -- "$1" 2>/dev/null || stat -f "%z|%p|%Sp|%m|%HT" -- "$1"', 'sh', abs],
    { principal: 'executor', timeoutMs: 10_000, maxOutputBytes: 4096 },
  );
  const line = r.stdout.trim();
  if (!line) throw new BridgeError('FILE_NOT_FOUND', `not found: ${rel}`, 404);
  const [size, , modeStr, mtime, kind] = line.split('|');
  const typeStr = (kind ?? '').toLowerCase();
  const type: FileStat['type'] = typeStr.includes('directory')
    ? 'dir'
    : typeStr.includes('symbolic')
      ? 'symlink'
      : typeStr.includes('regular') || typeStr === 'file'
        ? 'file'
        : 'other';
  return {
    path: rel,
    type,
    size: Number(size ?? 0),
    mode: modeStr ?? '',
    mtime: new Date(Number(mtime ?? 0) * 1000).toISOString(),
  };
}

export async function listDir(t: ConfinedTarget, rel: string, maxDepth = 1, maxEntries?: number): Promise<string[]> {
  const abs = await confinePath(t, rel, { mustExist: true });
  const depth = Math.min(Math.max(1, maxDepth), 5);

  // Build argv with optional bounded enumeration via head
  let argv: string[];
  let useHeadBound = false;

  if (maxEntries !== undefined && maxEntries > 0) {
    // Bounded enumeration: pipe find through head to stop at maxEntries lines
    // Use sh -c to compose the pipeline with argv-only (no variable interpolation)
    useHeadBound = true;
    argv = [
      '/bin/sh', '-c',
      `find "$1" -maxdepth "$2" -mindepth 1 -printf '%y %p\\n' 2>/dev/null | head -n "$3"`,
      'sh', abs, String(depth), String(maxEntries)
    ];
  } else {
    // Unbounded (existing behavior)
    argv = ['find', abs, '-maxdepth', String(depth), '-mindepth', '1', '-printf', '%y %p\n'];
  }

  const r = await runArgv(t, argv, { principal: 'executor', timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });

  if (r.exitCode !== 0 && !r.stdout) {
    // Bounded enumeration failure must fail closed (no unbounded ls fallback)
    if (useHeadBound) {
      throw new BridgeError(
        'COMMAND_FAILED',
        `bounded listDir failed: find -printf not supported and bounded enumeration is required`,
        422,
      );
    }
    // Fallback for find without -printf (busybox): plain listing (unbounded legacy path only)
    const r2 = await runArgv(t, ['ls', '-1ap', abs], { principal: 'executor', timeoutMs: 10_000 });
    const entries = r2.stdout.split('\n').filter(Boolean).map((n) => path.posix.join(rel || '.', n));
    return entries;
  }

  const root = t.workspace.replace(/\/+$/, '');
  const entries = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.slice(2); // strip "y " type prefix
      const relOut = p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p;
      return (l[0] === 'd' ? relOut + '/' : relOut);
    });

  return entries;
}

export async function search(t: ConfinedTarget, rel: string, query: string, maxResults = 200): Promise<string[]> {
  if (typeof query !== 'string' || query.length === 0 || query.length > 1024) {
    throw new BridgeError('MALFORMED_REQUEST', 'query must be 1..1024 chars', 400);
  }
  const abs = await confinePath(t, rel, { mustExist: true });
  // -F fixed strings (no regex injection), -n line numbers, -r recursive.
  const r = await runArgv(
    t,
    ['grep', '-rnI', '-F', '--', query, abs],
    { principal: 'executor', timeoutMs: 20_000, maxOutputBytes: 256 * 1024 },
  );
  const root = t.workspace.replace(/\/+$/, '');
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, maxResults)
    .map((l) => (l.startsWith(root) ? l.slice(root.length).replace(/^\//, '') : l));
}

/** Trailing-slash-insensitive form used to compare absolute paths for identity. */
const asRoot = (p: string) => p.replace(/\/+$/, '') || '/';

export async function deletePath(t: ConfinedTarget, rel: string, recursive: boolean): Promise<void> {
  const clean = rel.replace(/\/+$/, '');
  if (clean === '' || clean === '.') {
    throw new BridgeError('PATH_VIOLATION', 'refusing to delete the workspace root', 403);
  }
  const abs = await confinePath(t, rel, { mustExist: true });
  // The guard above only sees the string the caller sent. The authoritative
  // target is the canonical one: a symlink pointing at the workspace root — or
  // any resolution quirk that collapses a non-empty request onto it — must not
  // reach `rm -rf`. Re-check identity against what will actually be deleted.
  if (asRoot(abs) === asRoot(t.workspace)) {
    throw new BridgeError('PATH_VIOLATION', 'refusing to delete the workspace root', 403);
  }
  const argv = recursive ? ['rm', '-rf', '--', abs] : ['rm', '-f', '--', abs];
  const r = await runArgv(t, argv, { principal: 'executor', timeoutMs: 15_000 });
  if (r.exitCode !== 0) throw new BridgeError('COMMAND_FAILED', `delete failed: ${r.stderr.slice(0, 200)}`, 400);
}

export async function patchFile(t: ConfinedTarget, rel: string, oldText: string, newText: string): Promise<void> {
  const current = (await readFile(t, rel)).toString('utf8');
  const idx = current.indexOf(oldText);
  if (idx === -1) throw new BridgeError('PATCH_FAILED', 'oldText not found in file', 409);
  if (current.indexOf(oldText, idx + 1) !== -1) {
    throw new BridgeError('PATCH_FAILED', 'oldText is not unique in file; provide more context', 409);
  }
  const updated = current.slice(0, idx) + newText + current.slice(idx + oldText.length);
  await writeFile(t, rel, Buffer.from(updated, 'utf8'));
}
