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

export async function readFile(t: ConfinedTarget, rel: string): Promise<Buffer> {
  const abs = await confinePath(t, rel, { mustExist: true });
  const { body } = await getArchive(t.containerId, abs);
  return readTarSingleFile(body, EXECUTOR_DEFAULTS.maxFileBytes);
}

export async function writeFile(t: ConfinedTarget, rel: string, content: Buffer, mode = 0o644): Promise<void> {
  if (content.length > EXECUTOR_DEFAULTS.maxFileBytes) {
    throw new BridgeError('MALFORMED_REQUEST', `file exceeds ${EXECUTOR_DEFAULTS.maxFileBytes} bytes`, 413);
  }
  const abs = await confinePath(t, rel, { mustExist: false });
  const dir = path.posix.dirname(abs);
  const base = path.posix.basename(abs);

  // Ensure parent dir exists (confined argv, no shell).
  await runArgv(t, ['mkdir', '-p', dir], { principal: 'executor', timeoutMs: 10_000 });

  const tar = pack();
  tar.entry({ name: base, mode, size: content.length, mtime: new Date() }, content);
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

export async function listDir(t: ConfinedTarget, rel: string, maxDepth = 1): Promise<string[]> {
  const abs = await confinePath(t, rel, { mustExist: true });
  const depth = Math.min(Math.max(1, maxDepth), 5);
  const r = await runArgv(
    t,
    ['find', abs, '-maxdepth', String(depth), '-mindepth', '1', '-printf', '%y %p\n'],
    { principal: 'executor', timeoutMs: 15_000, maxOutputBytes: 128 * 1024 },
  );
  if (r.exitCode !== 0 && !r.stdout) {
    // Fallback for find without -printf (busybox): plain listing
    const r2 = await runArgv(t, ['ls', '-1ap', abs], { principal: 'executor', timeoutMs: 10_000 });
    return r2.stdout.split('\n').filter(Boolean).map((n) => path.posix.join(rel || '.', n));
  }
  const root = t.workspace.replace(/\/+$/, '');
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.slice(2); // strip "y " type prefix
      const relOut = p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p;
      return (l[0] === 'd' ? relOut + '/' : relOut);
    });
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

export async function deletePath(t: ConfinedTarget, rel: string, recursive: boolean): Promise<void> {
  const clean = rel.replace(/\/+$/, '');
  if (clean === '' || clean === '.') {
    throw new BridgeError('PATH_VIOLATION', 'refusing to delete the workspace root', 403);
  }
  const abs = await confinePath(t, rel, { mustExist: true });
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
