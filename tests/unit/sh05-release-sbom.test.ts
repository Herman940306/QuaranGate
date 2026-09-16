import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const releaseLocks = [
  'package-lock.json',
  'extensions/quarangate-vscode/package-lock.json',
  'extensions/quarangate-cursor/package-lock.json',
];

function generate() {
  const dir = mkdtempSync(join(tmpdir(), 'qg-sbom-'));
  const out = join(dir, 'sbom.json');
  const r = spawnSync(process.execPath, ['scripts/release-sbom.mjs', '--output', out], { encoding: 'utf8' });
  expect(r.status, r.stderr || r.stdout).toBe(0);
  return { bytes: readFileSync(out), doc: JSON.parse(readFileSync(out, 'utf8')) as any };
}

function packageByComment(doc: any, lockfile: string, path: string) {
  return doc.packages.find((p: any) => p.comment === `lockfile=${lockfile}; path=${path}`);
}

describe('SH-05 deterministic npm release SBOM', () => {
  it('emits deterministic SPDX bound to all production npm lockfiles', () => {
    const a = generate(); const b = generate();
    expect(a.bytes.equals(b.bytes)).toBe(true);
    expect(a.doc.spdxVersion).toBe('SPDX-2.3');
    expect(a.doc.documentDescribes).toHaveLength(3);
    expect(a.doc.packages.length).toBeGreaterThan(220);
    for (const lock of releaseLocks) {
      const lockSha = createHash('sha256').update(readFileSync(lock)).digest('hex');
      expect(a.doc.annotations[0].comment).toContain(`${lock}=sha256:${lockSha}`);
    }
    expect(a.doc.annotations[0].comment).not.toContain('quarangate-ide-chat-spike/package-lock.json');
  });

  it('uses the real nested npm package identity instead of embedding node_modules paths', () => {
    const { doc } = generate();
    const nested = packageByComment(doc, 'package-lock.json', 'node_modules/body-parser/node_modules/content-type');
    expect(nested).toMatchObject({ name: 'content-type', versionInfo: '2.0.0' });
    expect(nested.externalRefs[0].referenceLocator).toBe('pkg:npm/content-type@2.0.0');
    expect(doc.packages.some((p: any) => p.name.includes('node_modules'))).toBe(false);
  });

  it('serializes scoped npm purls using namespace/name segments', () => {
    const { doc } = generate();
    const mcp = packageByComment(doc, 'package-lock.json', 'node_modules/@modelcontextprotocol/sdk');
    expect(mcp.name).toBe('@modelcontextprotocol/sdk');
    expect(mcp.externalRefs[0].referenceLocator).toBe('pkg:npm/%40modelcontextprotocol/sdk@1.30.0');
  });

  it('models exact locked dependency edges instead of flattening every transitive package onto the release root', () => {
    const { doc } = generate();
    const root = packageByComment(doc, 'package-lock.json', '<root>');
    const direct = doc.relationships.filter((r: any) => r.spdxElementId === root.SPDXID);
    const targets = direct.map((r: any) => doc.packages.find((p: any) => p.SPDXID === r.relatedSpdxElement)?.name).sort();
    expect(targets).toEqual([
      '@modelcontextprotocol/sdk', '@types/express', '@types/node', '@types/tar-stream', 'express', 'ollama',
      'tar-stream', 'tsx', 'typescript', 'undici', 'vitest', 'yaml', 'zod',
    ].sort());
    expect(targets).not.toContain('@esbuild/aix-ppc64');

    const bodyParser = packageByComment(doc, 'package-lock.json', 'node_modules/body-parser');
    const nestedContentType = packageByComment(doc, 'package-lock.json', 'node_modules/body-parser/node_modules/content-type');
    expect(doc.relationships).toContainEqual({
      spdxElementId: bodyParser.SPDXID,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: nestedContentType.SPDXID,
    });
  });

  it('keeps the production extension dependency trees in the release document but excludes the preserved feasibility spike', () => {
    const { doc } = generate();
    expect(packageByComment(doc, 'extensions/quarangate-vscode/package-lock.json', '<root>')?.name).toBe('quarangate-vscode');
    expect(packageByComment(doc, 'extensions/quarangate-cursor/package-lock.json', '<root>')?.name).toBe('quarangate-cursor');
    expect(doc.packages.some((p: any) => String(p.comment).includes('quarangate-ide-chat-spike'))).toBe(false);
  });
});
