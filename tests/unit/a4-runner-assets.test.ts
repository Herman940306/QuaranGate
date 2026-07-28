/**
 * A4 runner-asset tests — the tar used to deliver the credential + per-job agent
 * into volumes (never via Docker Env). Round-trips through tar-stream to prove
 * names, contents, modes and uid/gid are exactly what the runner needs.
 */
import { describe, it, expect } from 'vitest';
import { extract as tarExtract } from 'tar-stream';
import { Readable } from 'node:stream';
import { buildTar } from '../../src/executor/agents/runnerAssets.js';

interface Extracted { name: string; type: string; mode: number; uid: number; gid: number; content: string }

function readTar(buf: Buffer): Promise<Extracted[]> {
  return new Promise((resolve, reject) => {
    const out: Extracted[] = [];
    const ex = tarExtract();
    ex.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        out.push({
          name: header.name, type: String(header.type),
          mode: header.mode ?? 0, uid: header.uid ?? -1, gid: header.gid ?? -1,
          content: Buffer.concat(chunks).toString('utf8'),
        });
        next();
      });
      stream.resume();
    });
    ex.on('finish', () => resolve(out));
    ex.on('error', reject);
    Readable.from(buf).pipe(ex);
  });
}

describe('buildTar', () => {
  it('encodes a secret file with 0400 owned by 1000:1000 and exact bytes', async () => {
    const key = 'SYNTHETIC-KEY-abcdef0123456789';
    const tar = await buildTar({ files: [{ name: 'kiro-api-key', content: Buffer.from(key), mode: 0o400, uid: 1000, gid: 1000 }] });
    const entries = await readTar(tar);
    expect(entries).toHaveLength(1);
    const f = entries[0]!;
    expect(f.name).toBe('kiro-api-key');
    expect(f.content).toBe(key);
    expect(f.mode & 0o777).toBe(0o400);
    expect(f.uid).toBe(1000);
    expect(f.gid).toBe(1000);
  });

  it('encodes the runner-home skeleton with dirs (0700) + agent + settings files', async () => {
    const tar = await buildTar({
      dirs: [{ name: '.kiro/', mode: 0o700 }, { name: '.kiro/agents/', mode: 0o700 }],
      files: [
        { name: '.kiro/agents/mcp_ro_deadbeef.json', content: Buffer.from('{"name":"mcp_ro_deadbeef"}'), mode: 0o600 },
        { name: '.kiro/settings/cli.json', content: Buffer.from('{}'), mode: 0o600 },
      ],
    });
    const entries = await readTar(tar);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['.kiro/']!.type).toBe('directory');
    expect(byName['.kiro/']!.mode & 0o777).toBe(0o700);
    expect(byName['.kiro/']!.uid).toBe(1000);
    expect(byName['.kiro/agents/mcp_ro_deadbeef.json']!.content).toContain('mcp_ro_deadbeef');
    expect(byName['.kiro/agents/mcp_ro_deadbeef.json']!.mode & 0o777).toBe(0o600);
  });

  it('rejects a directory entry that does not end with "/"', async () => {
    await expect(buildTar({ dirs: [{ name: 'bad' }] })).rejects.toThrow(/must end with/);
  });
});
