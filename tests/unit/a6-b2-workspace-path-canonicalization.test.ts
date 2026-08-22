/**
 * A6-B2/B3 — workspace archive-root canonicalization.
 *
 * REGRESSION TARGET
 * -----------------
 * `getArchive(containerId, WORKSPACE_PATH)` returns tar entries named after the
 * BASENAME of the requested path, so reading `/workspace` yields
 * `workspace/README.md`, not `README.md`. Neither capture parser stripped that
 * component, so the prefix travelled all the way into the recorded evidence,
 * the canonical diff and the artifact manifest — and apply then resolved
 * `changes[].path` under PROJECT_PATH as `/project/workspace/src/index.ts`
 * instead of `/project/src/index.ts`.
 *
 * MODIFY/DELETE failed closed (HOST_PRECERTIFICATION_FAILED), but ADD did NOT:
 * `/project/workspace/<path>` legitimately does not exist, so precertification
 * passed and the forward mutation would have written a spurious top-level
 * `workspace/` directory into the real project bind.
 *
 * The fix canonicalizes at the two CAPTURE boundaries — the only place where
 * BEFORE and POST can be guaranteed to agree — never at the apply boundary.
 *
 * These tests are offline. Docker is stubbed; the REAL daemon behaviour they
 * model (that the prefix exists at all) is proven separately against a live
 * daemon in tests/integration/a6-b2-workspace-archive-prefix.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pack as tarPack } from 'tar-stream';
import {
  canonicalizeWorkspaceEntryPath, stripWorkspaceArchiveRoot,
  WORKSPACE_ARCHIVE_ROOT, captureBeforeEvidence,
  type BeforeEntry, type BeforeCaptureResult,
} from '../../src/executor/agents/beforeCapture.js';
import { parsePostTarStream } from '../../src/executor/agents/postCapture.js';
import { computeCanonicalDiff, computeChangeSetHash } from '../../src/executor/agents/canonicalDiff.js';
import { WORKSPACE_PATH, PROJECT_PATH } from '../../src/executor/agents/sandboxSpec.js';
import { createDockerApplierIO } from '../../src/executor/agents/applyEngine.js';
import type { SnapshotEntry, SnapshotManifest } from '../../src/executor/agents/canonicalJson.js';
import { BridgeError } from '../../src/shared/errors.js';

// ---------------------------------------------------------------------------
// Docker stubs (no daemon)
// ---------------------------------------------------------------------------

vi.mock('../../src/executor/docker.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/executor/docker.js')>('../../src/executor/docker.js');
  return {
    ...actual,
    createVolume: vi.fn().mockResolvedValue(undefined),
    removeVolume: vi.fn().mockResolvedValue(undefined),
    createContainer: vi.fn().mockResolvedValue('stub-container-id'),
    startContainer: vi.fn().mockResolvedValue(undefined),
    waitContainer: vi.fn().mockResolvedValue({ statusCode: 0, timedOut: false }),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    getArchive: vi.fn(),
    putArchive: vi.fn().mockResolvedValue(undefined),
  };
});

import * as dockerStub from '../../src/executor/docker.js';

const MAX_EVIDENCE_BYTES = 512 * 1024 * 1024;

interface TarEntrySpec {
  name: string;
  type?: 'file' | 'directory' | 'symlink' | 'link';
  mode?: number;
  content?: Buffer;
  linkname?: string;
}

function buildTar(entries: TarEntrySpec[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = tarPack();
    const chunks: Buffer[] = [];
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('end', () => resolve(Buffer.concat(chunks)));
    p.on('error', reject);
    for (const e of entries) {
      const type = e.type ?? 'file';
      const header: Record<string, unknown> = { name: e.name, type, mode: e.mode ?? (type === 'directory' ? 0o755 : 0o644) };
      if (e.linkname) header.linkname = e.linkname;
      if (type === 'file') {
        const buf = e.content ?? Buffer.alloc(0);
        p.entry({ ...header, size: buf.length } as never, buf);
      } else {
        p.entry(header as never, '');
      }
    }
    p.finalize();
  });
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function setTarResponse(tar: Buffer): void {
  (dockerStub.getArchive as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    body: Readable.from(tar),
    statHeader: undefined,
  });
}

let jobCounter = 0;
function newJobId(): string {
  jobCounter += 1;
  return 'job_' + String(jobCounter).padStart(32, '0');
}

/** Run the BEFORE capture parser over an archive shaped exactly like Docker's. */
async function captureBefore(entries: TarEntrySpec[]): Promise<BeforeCaptureResult> {
  setTarResponse(await buildTar(entries));
  return captureBeforeEvidence({
    jobId: newJobId(), volumeName: 'ws-vol', helperImage: 'img', maxEvidenceBytes: MAX_EVIDENCE_BYTES,
  });
}

/** Run the POST capture parser over an archive shaped exactly like Docker's. */
async function capturePost(entries: TarEntrySpec[], knownBeforeHashes?: Set<string>) {
  const tar = await buildTar(entries);
  return parsePostTarStream(Readable.from(tar), MAX_EVIDENCE_BYTES, knownBeforeHashes, MAX_EVIDENCE_BYTES);
}

/**
 * Map BEFORE entries to snapshot entries using the SAME rules as
 * artifactConstructor.constructArtifact step 2 (src/executor/agents/
 * artifactConstructor.ts): file → file, dir → dir, symlink → unsupported.
 * Only the mapping is duplicated here; the paths come from the real parser.
 */
function beforeManifest(entries: readonly BeforeEntry[]): SnapshotManifest {
  const out: SnapshotEntry[] = [];
  for (const e of entries) {
    if (e.kind === 'file') {
      out.push({ path: e.relPath, kind: 'file', mode: e.mode, sizeBytes: e.sizeBytes, contentHash: e.sha256 });
    } else if (e.kind === 'dir') {
      out.push({ path: e.relPath, kind: 'dir', mode: e.mode });
    } else {
      out.push({
        path: e.relPath, kind: 'unsupported', mode: e.mode,
        reason: 'B2 evidence does not preserve symlink target identity',
      });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: 1, entries: out };
}

function postManifest(entries: ReadonlyArray<{ snapshot: SnapshotEntry }>): SnapshotManifest {
  const out = entries.map((e) => e.snapshot);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: 1, entries: out };
}

beforeEach(() => {
  vi.clearAllMocks();
  (dockerStub.createVolume as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (dockerStub.removeVolume as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (dockerStub.createContainer as ReturnType<typeof vi.fn>).mockResolvedValue('stub-container-id');
  (dockerStub.startContainer as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (dockerStub.waitContainer as ReturnType<typeof vi.fn>).mockResolvedValue({ statusCode: 0, timedOut: false });
  (dockerStub.removeContainer as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (dockerStub.putArchive as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. The pure helpers
// ---------------------------------------------------------------------------

describe('WORKSPACE_ARCHIVE_ROOT', () => {
  it('is the basename of WORKSPACE_PATH, so the mount and the archive root cannot diverge', () => {
    expect(WORKSPACE_PATH).toBe('/workspace');
    expect(WORKSPACE_ARCHIVE_ROOT).toBe('workspace');
    expect(WORKSPACE_ARCHIVE_ROOT).toBe(WORKSPACE_PATH.split('/').filter(Boolean).pop());
  });
});

describe('stripWorkspaceArchiveRoot', () => {
  it('removes the archive root component', () => {
    expect(stripWorkspaceArchiveRoot('workspace/README.md')).toBe('README.md');
    expect(stripWorkspaceArchiveRoot('workspace/src/index.ts')).toBe('src/index.ts');
  });

  it('removes EXACTLY ONE component — a real project dir named "workspace" survives', () => {
    expect(stripWorkspaceArchiveRoot('workspace/workspace/index.ts')).toBe('workspace/index.ts');
    expect(stripWorkspaceArchiveRoot('workspace/workspace')).toBe('workspace');
  });

  it('reports the archive root entry itself as empty', () => {
    expect(stripWorkspaceArchiveRoot('workspace')).toBe('');
    expect(stripWorkspaceArchiveRoot('workspace/')).toBe('');
  });

  it('is NOT a generic first-component strip', () => {
    expect(stripWorkspaceArchiveRoot('other/foo')).toBe('other/foo');
    expect(stripWorkspaceArchiveRoot('workspaces/foo')).toBe('workspaces/foo');
    expect(stripWorkspaceArchiveRoot('Workspace/foo')).toBe('Workspace/foo');
    expect(stripWorkspaceArchiveRoot('src/index.ts')).toBe('src/index.ts');
    expect(stripWorkspaceArchiveRoot('README.md')).toBe('README.md');
  });
});

describe('canonicalizeWorkspaceEntryPath', () => {
  it('canonicalizes the shapes the daemon actually emits', () => {
    expect(canonicalizeWorkspaceEntryPath('workspace/README.md')).toBe('README.md');
    expect(canonicalizeWorkspaceEntryPath('workspace/src/index.ts')).toBe('src/index.ts');
    expect(canonicalizeWorkspaceEntryPath('workspace/src/')).toBe('src/');
    expect(canonicalizeWorkspaceEntryPath('/workspace/src/index.ts')).toBe('src/index.ts');
    expect(canonicalizeWorkspaceEntryPath('./workspace/src/index.ts')).toBe('src/index.ts');
  });

  it('treats the archive root entry as "not a project file"', () => {
    expect(canonicalizeWorkspaceEntryPath('workspace')).toBe('');
    expect(canonicalizeWorkspaceEntryPath('workspace/')).toBe('');
    expect(canonicalizeWorkspaceEntryPath('/workspace/')).toBe('');
    expect(canonicalizeWorkspaceEntryPath('./workspace')).toBe('');
  });

  it('leaves already-canonical and non-root-prefixed paths untouched', () => {
    expect(canonicalizeWorkspaceEntryPath('README.md')).toBe('README.md');
    expect(canonicalizeWorkspaceEntryPath('src/index.ts')).toBe('src/index.ts');
    expect(canonicalizeWorkspaceEntryPath('other/foo')).toBe('other/foo');
  });

  it('still rejects traversal, NUL and backslash — before AND after the strip', () => {
    const cases: Array<[string, string]> = [
      ['workspace/../etc/passwd', 'BEFORE_CAPTURE_PATH_ESCAPE'],
      ['workspace/..', 'BEFORE_CAPTURE_PATH_ESCAPE'],
      ['workspace/src/../../etc/passwd', 'BEFORE_CAPTURE_PATH_ESCAPE'],
      ['../workspace/README.md', 'BEFORE_CAPTURE_PATH_ESCAPE'],
      ['/workspace/../../etc/shadow', 'BEFORE_CAPTURE_PATH_ESCAPE'],
      ['workspace/a\0b', 'BEFORE_CAPTURE_UNSAFE_PATH'],
      ['workspace/a\\b', 'BEFORE_CAPTURE_UNSAFE_PATH'],
    ];
    for (const [raw, code] of cases) {
      let seen: string | undefined;
      try { canonicalizeWorkspaceEntryPath(raw); } catch (e) {
        seen = e instanceof BridgeError ? e.code : 'UNEXPECTED';
      }
      expect(seen, `expected ${raw} to be rejected`).toBe(code);
    }
  });

  it('never yields an absolute path or a bare traversal segment', () => {
    for (const raw of ['workspace//README.md', 'workspace/./README.md', 'workspace/src/index.ts']) {
      const out = canonicalizeWorkspaceEntryPath(raw);
      expect(out.startsWith('/'), raw).toBe(false);
      expect(out.split('/').includes('..'), raw).toBe(false);
    }
  });

  it('fails closed on a doubled-slash entry name that would survive as an absolute path', () => {
    // validateTarEntryPath removes only ONE leading '/', so '//x' would emerge
    // as the absolute path '/x'. Regular files were already caught later by
    // assertNoEscape; dir and symlink entries were not.
    for (const raw of ['//workspace/README.md', '//etc/passwd', '//workspace/src/']) {
      let code: string | undefined;
      try { canonicalizeWorkspaceEntryPath(raw); } catch (e) {
        code = e instanceof BridgeError ? e.code : 'UNEXPECTED';
      }
      expect(code, raw).toBe('BEFORE_CAPTURE_UNSAFE_PATH');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. BEFORE parser
// ---------------------------------------------------------------------------

/** Exactly what a live daemon returns for getArchive(cid, '/workspace'). */
const README = Buffer.from('# fixture\n');
const INDEX_V1 = Buffer.from('export const x = 1;\n');
const DOCKER_BEFORE: TarEntrySpec[] = [
  { name: 'workspace/', type: 'directory', mode: 0o755 },
  { name: 'workspace/src/', type: 'directory', mode: 0o755 },
  { name: 'workspace/README.md', content: README, mode: 0o644 },
  { name: 'workspace/src/index.ts', content: INDEX_V1, mode: 0o644 },
];

describe('BEFORE capture canonicalizes Docker workspace-prefixed entries', () => {
  it('records project-relative relPaths, not workspace-prefixed ones', async () => {
    const result = await captureBefore(DOCKER_BEFORE);
    const files = result.entries.filter((e) => e.kind === 'file').map((e) => e.relPath);
    expect(files).toEqual(['README.md', 'src/index.ts']);
    for (const e of result.entries) {
      expect(e.relPath.startsWith('workspace/')).toBe(false);
    }
  });

  it('skips the archive root entry instead of recording a fake project path', async () => {
    const result = await captureBefore(DOCKER_BEFORE);
    const paths = result.entries.map((e) => e.relPath);
    expect(paths).not.toContain('workspace');
    expect(paths).not.toContain('workspace/');
    expect(paths).not.toContain('');
    // The root dir entry is dropped; the real subdirectory is kept.
    expect(result.entries.filter((e) => e.kind === 'dir').map((e) => e.relPath)).toEqual(['src/']);
  });

  it('stores evidence under the canonical path', async () => {
    const result = await captureBefore(DOCKER_BEFORE);
    const readme = result.entries.find((e) => e.relPath === 'README.md')!;
    expect(readme.storedAt).toBe('/evidence/files/README.md');
    expect(readme.sha256).toBe(sha256(README));
  });

  it('does NOT strip a component that is not the archive root', async () => {
    const result = await captureBefore([
      { name: 'other/foo.ts', content: Buffer.from('a'), mode: 0o644 },
      { name: 'src/index.ts', content: INDEX_V1, mode: 0o644 },
    ]);
    expect(result.entries.filter((e) => e.kind === 'file').map((e) => e.relPath))
      .toEqual(['other/foo.ts', 'src/index.ts']);
  });

  it('keeps a genuine top-level "workspace" project directory', async () => {
    const result = await captureBefore([
      { name: 'workspace/', type: 'directory', mode: 0o755 },
      { name: 'workspace/workspace/', type: 'directory', mode: 0o755 },
      { name: 'workspace/workspace/keep.ts', content: Buffer.from('k'), mode: 0o644 },
    ]);
    expect(result.entries.map((e) => e.relPath)).toEqual(['workspace/', 'workspace/keep.ts']);
  });

  it('aborts the capture on a traversal entry', async () => {
    let code: string | undefined;
    try {
      await captureBefore([{ name: 'workspace/../../etc/passwd', content: Buffer.from('x') }]);
    } catch (e) {
      code = e instanceof BridgeError ? e.code : 'UNEXPECTED';
    }
    expect(code).toBe('BEFORE_CAPTURE_PATH_ESCAPE');
  });
});

// ---------------------------------------------------------------------------
// 3. POST parser — identical canonicalization
// ---------------------------------------------------------------------------

describe('POST capture canonicalizes identically to BEFORE', () => {
  it('produces project-relative snapshot paths', async () => {
    const post = await capturePost(DOCKER_BEFORE);
    const paths = post.entries.map((e) => e.snapshot.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('src/index.ts');
    for (const p of paths) expect(p.startsWith('workspace/')).toBe(false);
  });

  it('skips the archive root entry', async () => {
    const post = await capturePost(DOCKER_BEFORE);
    const paths = post.entries.map((e) => e.snapshot.path);
    expect(paths).not.toContain('workspace');
    expect(paths).not.toContain('workspace/');
    expect(paths.filter((p) => p.endsWith('/'))).toEqual(['src/']);
  });

  it('agrees with BEFORE path-for-path on the SAME archive', async () => {
    const before = await captureBefore(DOCKER_BEFORE);
    const post = await capturePost(DOCKER_BEFORE);
    const beforePaths = [...before.entries.map((e) => e.relPath)].sort();
    const postPaths = [...post.entries.map((e) => e.snapshot.path)].sort();
    expect(postPaths).toEqual(beforePaths);
  });

  it('does NOT strip a component that is not the archive root', async () => {
    const post = await capturePost([{ name: 'other/foo.ts', content: Buffer.from('a'), mode: 0o644 }]);
    expect(post.entries.map((e) => e.snapshot.path)).toEqual(['other/foo.ts']);
  });

  it('aborts the capture on a traversal entry', async () => {
    let code: string | undefined;
    try {
      await capturePost([{ name: 'workspace/../escape.ts', content: Buffer.from('x') }]);
    } catch (e) {
      code = e instanceof BridgeError ? e.code : 'UNEXPECTED';
    }
    expect(code).toBe('BEFORE_CAPTURE_PATH_ESCAPE');
  });

  it('resolves a hardlink whose target carries the same archive-root prefix', async () => {
    const post = await capturePost([
      { name: 'workspace/', type: 'directory', mode: 0o755 },
      { name: 'workspace/original.txt', content: README, mode: 0o644 },
      { name: 'workspace/linked.txt', type: 'link', linkname: 'workspace/original.txt', mode: 0o644 },
    ]);
    const linked = post.entries.find((e) => e.snapshot.path === 'linked.txt')!;
    expect(linked.snapshot.kind).toBe('file');
    expect(linked.snapshot.contentHash).toBe(sha256(README));
  });
});

// ---------------------------------------------------------------------------
// 4. Detection stays correct end to end
// ---------------------------------------------------------------------------

describe('change detection over canonicalized captures', () => {
  const INDEX_V2 = Buffer.from('export const x = 2;\n');
  const ADDED = Buffer.from('added\n');

  const DOCKER_POST: TarEntrySpec[] = [
    { name: 'workspace/', type: 'directory', mode: 0o755 },
    { name: 'workspace/src/', type: 'directory', mode: 0o755 },
    { name: 'workspace/README.md', content: README, mode: 0o644 },   // unchanged
    { name: 'workspace/src/index.ts', content: INDEX_V2, mode: 0o644 }, // modified
    { name: 'workspace/src/added.ts', content: ADDED, mode: 0o644 },   // added
    // workspace/removed.ts (present in BEFORE) is gone → DELETE
  ];

  const BEFORE_WITH_DELETE: TarEntrySpec[] = [
    ...DOCKER_BEFORE,
    { name: 'workspace/removed.ts', content: Buffer.from('bye\n'), mode: 0o644 },
  ];

  it('classifies unchanged / MODIFY / ADD / DELETE on canonical paths', async () => {
    const before = await captureBefore(BEFORE_WITH_DELETE);
    const post = await capturePost(DOCKER_POST);

    const diff = computeCanonicalDiff(beforeManifest(before.entries), postManifest(post.entries));
    const byPath = new Map(diff.entries.map((e) => [e.path, e.op]));

    expect(byPath.get('src/index.ts')).toBe('CONTENT_MODIFY');
    expect(byPath.get('src/added.ts')).toBe('ADD');
    expect(byPath.get('removed.ts')).toBe('DELETE');
    expect(byPath.has('README.md')).toBe(false); // unchanged → not in the change set
  });

  it('emits ONLY canonical project-relative paths in the change set', async () => {
    const before = await captureBefore(BEFORE_WITH_DELETE);
    const post = await capturePost(DOCKER_POST);
    const diff = computeCanonicalDiff(beforeManifest(before.entries), postManifest(post.entries));

    expect(diff.entries.length).toBeGreaterThan(0);
    for (const e of diff.entries) {
      expect(e.path.startsWith('workspace/'), e.path).toBe(false);
      expect(e.path.startsWith('/'), e.path).toBe(false);
      expect(e.path.split('/').includes('..'), e.path).toBe(false);
    }
    expect(diff.entries.map((e) => e.path).sort())
      .toEqual(['removed.ts', 'src/added.ts', 'src/index.ts']);
  });
});

// ---------------------------------------------------------------------------
// 5. Apply resolves the canonical path under PROJECT_PATH
// ---------------------------------------------------------------------------

describe('apply path resolution', () => {
  it('resolves a canonical change path to /project/src/index.ts, not /project/workspace/src/index.ts', async () => {
    const before = await captureBefore(DOCKER_BEFORE);
    const changePath = before.entries.find((e) => e.relPath.endsWith('index.ts'))!.relPath;
    expect(changePath).toBe('src/index.ts');

    // Drive the REAL production applier IO so the composition under test is the
    // one apply actually uses (applyEngine.createDockerApplierIO.readProjectPath).
    (dockerStub.getArchive as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new BridgeError('FILE_NOT_FOUND', 'not found', 404),
    );
    const io = createDockerApplierIO();
    await io.readProjectPath('cid', changePath);

    const requested = (dockerStub.getArchive as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(requested).toBe(`${PROJECT_PATH}/src/index.ts`);
    expect(requested).toBe('/project/src/index.ts');
    expect(requested).not.toBe('/project/workspace/src/index.ts');
  });
});

// ---------------------------------------------------------------------------
// 6. Persisted-artifact compatibility
// ---------------------------------------------------------------------------

describe('already-persisted artifacts are NOT reinterpreted', () => {
  /**
   * The fix lives ONLY in the capture parsers. Readers and the diff/hash layer
   * are untouched, so a changeset persisted BEFORE this fix keeps its recorded
   * semantics: its paths are still whatever was written, and its change-set
   * hash is unchanged. Nothing silently re-canonicalizes stored artifacts.
   */
  const legacyBefore: SnapshotManifest = {
    version: 1,
    entries: [
      { path: 'workspace/README.md', kind: 'file', mode: 0o644, sizeBytes: 3, contentHash: 'a'.repeat(64) },
      { path: 'workspace/src/index.ts', kind: 'file', mode: 0o644, sizeBytes: 4, contentHash: 'b'.repeat(64) },
    ],
  };
  const legacyPost: SnapshotManifest = {
    version: 1,
    entries: [
      { path: 'workspace/README.md', kind: 'file', mode: 0o644, sizeBytes: 3, contentHash: 'a'.repeat(64) },
      { path: 'workspace/src/index.ts', kind: 'file', mode: 0o644, sizeBytes: 5, contentHash: 'c'.repeat(64) },
    ],
  };

  it('keeps legacy prefixed paths verbatim through diff and hashing', () => {
    const diff = computeCanonicalDiff(legacyBefore, legacyPost);
    expect(diff.entries).toEqual([{ path: 'workspace/src/index.ts', op: 'CONTENT_MODIFY' }]);
    // Pinned: the recorded semantics of an already-constructed changeset.
    expect(computeChangeSetHash(diff)).toBe(computeChangeSetHash({
      version: 1,
      entries: [{ path: 'workspace/src/index.ts', op: 'CONTENT_MODIFY' }],
    }));
  });

  it('produces a DIFFERENT change set for newly captured archives, by construction', async () => {
    const before = await captureBefore(DOCKER_BEFORE);
    const post = await capturePost([
      { name: 'workspace/', type: 'directory', mode: 0o755 },
      { name: 'workspace/src/', type: 'directory', mode: 0o755 },
      { name: 'workspace/README.md', content: README, mode: 0o644 },
      { name: 'workspace/src/index.ts', content: Buffer.from('export const x = 2;\n'), mode: 0o644 },
    ]);
    const fresh = computeCanonicalDiff(beforeManifest(before.entries), postManifest(post.entries));
    expect(fresh.entries).toEqual([{ path: 'src/index.ts', op: 'CONTENT_MODIFY' }]);
    expect(computeChangeSetHash(fresh)).not.toBe(computeChangeSetHash(computeCanonicalDiff(legacyBefore, legacyPost)));
  });
});
