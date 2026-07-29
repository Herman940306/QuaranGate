/**
 * A6-B2: STAGED_BEFORE evidence capture — unit tests.
 *
 * All tests are offline (no Docker, no live stack). Docker interactions are
 * replaced by in-process stubs that inject raw tar streams. The evidence volume
 * architecture is verified through the Docker API stubs (createVolume,
 * removeVolume, putArchive) without requiring a daemon.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pack as tarPack } from 'tar-stream';
import {
  validateTarEntryPath, assertNoEscape, classifyTarEntry,
  captureBeforeEvidence, evidenceVolumeName,
  MAX_BEFORE_FILES,
  type BeforeEntry,
} from '../../src/executor/agents/beforeCapture.js';
import { BridgeError } from '../../src/shared/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a tar buffer from an array of in-memory entries (for testing). */
function buildTestTar(entries: Array<{
  name: string;
  type?: string;
  mode?: number;
  content?: Buffer;
  linkname?: string;
}>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = tarPack();
    const chunks: Buffer[] = [];
    p.on('data', (c: Buffer) => chunks.push(c));
    p.on('end', () => resolve(Buffer.concat(chunks)));
    p.on('error', reject);
    for (const e of entries) {
      const type = (e.type ?? 'file') as 'file' | 'directory' | 'symlink';
      const headerOpts: Record<string, unknown> = { name: e.name, type, mode: e.mode ?? 0o644 };
      if (e.linkname) headerOpts.linkname = e.linkname;
      if (type === 'file' || type === undefined) {
        p.entry(headerOpts, e.content ?? Buffer.alloc(0));
      } else {
        p.entry(headerOpts);
      }
    }
    p.finalize();
  });
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function errCode(fn: () => unknown): string {
  try { fn(); throw new Error('expected throw'); }
  catch (e) { if (e instanceof BridgeError) return e.code; throw e; }
}

async function asyncErrCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); throw new Error('expected throw'); }
  catch (e) { if (e instanceof BridgeError) return e.code; throw e; }
}

// ---------------------------------------------------------------------------
// 1. Path validation
// ---------------------------------------------------------------------------

describe('validateTarEntryPath', () => {
  it('accepts a normal relative path', () => {
    expect(validateTarEntryPath('src/main.ts')).toBe('src/main.ts');
  });

  it('strips leading /', () => {
    expect(validateTarEntryPath('/src/main.ts')).toBe('src/main.ts');
  });

  it('strips leading ./', () => {
    expect(validateTarEntryPath('./src/main.ts')).toBe('src/main.ts');
  });

  it('returns empty string for bare / (workspace root)', () => {
    expect(validateTarEntryPath('/')).toBe('');
  });

  it('returns empty string for bare .', () => {
    expect(validateTarEntryPath('.')).toBe('');
  });

  it('rejects a path containing ..', () => {
    expect(() => validateTarEntryPath('src/../../etc/passwd')).toThrow(BridgeError);
    expect(errCode(() => validateTarEntryPath('src/../../etc/passwd'))).toBe('BEFORE_CAPTURE_PATH_ESCAPE');
  });

  it('rejects a path starting with ../', () => {
    expect(() => validateTarEntryPath('../escape')).toThrow(BridgeError);
  });

  it('rejects NUL bytes', () => {
    expect(() => validateTarEntryPath('src/foo\0bar')).toThrow(BridgeError);
    expect(errCode(() => validateTarEntryPath('src/foo\0bar'))).toBe('BEFORE_CAPTURE_UNSAFE_PATH');
  });

  it('rejects backslash', () => {
    expect(() => validateTarEntryPath('src\\main.ts')).toThrow(BridgeError);
    expect(errCode(() => validateTarEntryPath('src\\main.ts'))).toBe('BEFORE_CAPTURE_UNSAFE_PATH');
  });

  it('accepts deeply nested path', () => {
    expect(validateTarEntryPath('a/b/c/d/e.txt')).toBe('a/b/c/d/e.txt');
  });
});

// ---------------------------------------------------------------------------
// 2. Path escape: assertNoEscape
// ---------------------------------------------------------------------------

describe('assertNoEscape', () => {
  it('accepts a normal relative path', () => {
    expect(() => assertNoEscape('/evidence/files', 'src/main.ts')).not.toThrow();
  });

  it('rejects a path that resolves outside the root', () => {
    expect(() => assertNoEscape('/evidence/files', '../../../etc/passwd')).toThrow(BridgeError);
    expect(errCode(() => assertNoEscape('/evidence/files', '../../../etc/passwd'))).toBe('BEFORE_CAPTURE_PATH_ESCAPE');
  });
});

// ---------------------------------------------------------------------------
// 3. Entry classification
// ---------------------------------------------------------------------------

describe('classifyTarEntry', () => {
  it('classifies file entries', () => {
    expect(classifyTarEntry('file')).toBe('file');
  });

  it('classifies directory entries', () => {
    expect(classifyTarEntry('directory')).toBe('dir');
  });

  it('classifies symlink entries', () => {
    expect(classifyTarEntry('symlink')).toBe('symlink');
  });

  it('classifies hard-link entries as symlink (no byte follow)', () => {
    expect(classifyTarEntry('link')).toBe('symlink');
  });

  it('fails closed on block-device', () => {
    expect(() => classifyTarEntry('block-device')).toThrow(BridgeError);
    expect(errCode(() => classifyTarEntry('block-device'))).toBe('BEFORE_CAPTURE_UNSUPPORTED_ENTRY');
  });

  it('fails closed on char-device', () => {
    expect(() => classifyTarEntry('char-device')).toThrow(BridgeError);
  });

  it('fails closed on fifo', () => {
    expect(() => classifyTarEntry('fifo')).toThrow(BridgeError);
  });

  it('fails closed on unknown type', () => {
    expect(() => classifyTarEntry('unknown-future-type')).toThrow(BridgeError);
    expect(errCode(() => classifyTarEntry('unknown-future-type'))).toBe('BEFORE_CAPTURE_UNSUPPORTED_ENTRY');
  });

  it('fails closed on null type', () => {
    expect(() => classifyTarEntry(null)).toThrow(BridgeError);
    expect(errCode(() => classifyTarEntry(null))).toBe('BEFORE_CAPTURE_UNSUPPORTED_ENTRY');
  });

  it('fails closed on undefined type', () => {
    expect(() => classifyTarEntry(undefined)).toThrow(BridgeError);
    expect(errCode(() => classifyTarEntry(undefined))).toBe('BEFORE_CAPTURE_UNSUPPORTED_ENTRY');
  });
});

// ---------------------------------------------------------------------------
// 4. Evidence volume naming
// ---------------------------------------------------------------------------

describe('evidenceVolumeName', () => {
  it('produces a distinguishable name containing the job ID', () => {
    const name = evidenceVolumeName('job_' + 'a'.repeat(32));
    expect(name).toContain('evidence');
    expect(name).toContain('job_' + 'a'.repeat(32));
  });

  it('uses dashes not dots (Docker volume name safety)', () => {
    const name = evidenceVolumeName('job_' + 'b'.repeat(32));
    expect(name).not.toContain('.');
  });
});

// ---------------------------------------------------------------------------
// 5. captureBeforeEvidence integration (Docker stubbed)
// ---------------------------------------------------------------------------

// Stub out Docker calls so no daemon is needed.
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
    getArchive: vi.fn(), // set per test
    putArchive: vi.fn().mockResolvedValue(undefined),
    listContainersByFilter: vi.fn().mockResolvedValue([]),
    listVolumesByFilter: vi.fn().mockResolvedValue([]),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    killContainer: vi.fn().mockResolvedValue(undefined),
  };
});

import * as dockerStub from '../../src/executor/docker.js';

function setTarResponse(tarBuf: Buffer): void {
  const tarStream = Readable.from(tarBuf);
  (dockerStub.getArchive as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    body: tarStream,
    statHeader: undefined,
  });
}

const DEFAULT_MAX_EVIDENCE_BYTES = 512 * 1024 * 1024; // 512 MiB

describe('captureBeforeEvidence — integration (Docker stubbed)', () => {
  const jobId = `job_${'b'.repeat(32)}`;

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

  it('creates an evidence volume with correct labels', async () => {
    const tar = await buildTestTar([{ name: 'a.ts', content: Buffer.from('x') }]);
    setTarResponse(tar);

    await captureBeforeEvidence({
      jobId, volumeName: 'ws-vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    expect(dockerStub.createVolume).toHaveBeenCalledWith(
      evidenceVolumeName(jobId),
      expect.objectContaining({
        'io.mcp-ide-bridge.resource': 'evidence',
        'io.mcp-ide-bridge.managed': 'true',
        'io.mcp-ide-bridge.job': jobId,
      }),
    );
  });

  it('returns evidenceVolume name in result', async () => {
    const tar = await buildTestTar([{ name: 'a.ts', content: Buffer.from('x') }]);
    setTarResponse(tar);

    const result = await captureBeforeEvidence({
      jobId, volumeName: 'ws-vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    expect(result.evidenceVolume).toBe(evidenceVolumeName(jobId));
  });

  it('captures text file with correct sha256, mode, sizeBytes', async () => {
    const content = Buffer.from('hello world\n');
    const tar = await buildTestTar([{ name: 'workspace/README.md', content, mode: 0o644 }]);
    setTarResponse(tar);

    const result = await captureBeforeEvidence({
      jobId, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    expect(result.entryCount).toBe(1);
    expect(result.totalBytes).toBe(content.length);
    const e = result.entries.find((x) => x.kind === 'file')!;
    expect(e.sha256).toBe(sha256(content));
    expect(e.mode & 0o777).toBe(0o644);
    expect(e.sizeBytes).toBe(content.length);
    expect(e.storedAt).toBeDefined();
    expect(e.storedAt).toContain('/evidence/files/');
  });

  it('preserves zero-byte files', async () => {
    const tar = await buildTestTar([{ name: 'empty.txt', content: Buffer.alloc(0), mode: 0o644 }]);
    setTarResponse(tar);

    const result = await captureBeforeEvidence({
      jobId: `job_${'c'.repeat(32)}`, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    const e = result.entries.find((x) => x.kind === 'file')!;
    expect(e.sizeBytes).toBe(0);
    expect(e.sha256).toBe(sha256(Buffer.alloc(0)));
  });

  it('preserves binary (non-UTF8) file content exactly (sha256 match)', async () => {
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xab, 0xcd, 0xef]);
    const tar = await buildTestTar([{ name: 'data.bin', content: binary, mode: 0o600 }]);
    setTarResponse(tar);

    const result = await captureBeforeEvidence({
      jobId: `job_${'d'.repeat(32)}`, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    const e = result.entries.find((x) => x.kind === 'file')!;
    expect(e.sha256).toBe(sha256(binary));
  });

  it('preserves mode bits', async () => {
    const tar = await buildTestTar([
      { name: 'script.sh', content: Buffer.from('#!/bin/sh'), mode: 0o755 },
      { name: 'secret.key', content: Buffer.from('key'), mode: 0o400 },
    ]);
    setTarResponse(tar);

    const result = await captureBeforeEvidence({
      jobId: `job_${'e'.repeat(32)}`, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    const byPath = Object.fromEntries(result.entries.map((e) => [e.relPath, e]));
    expect(byPath['script.sh']!.mode & 0o777).toBe(0o755);
    expect(byPath['secret.key']!.mode & 0o777).toBe(0o400);
  });

  it('entries are in deterministic (sorted) order', async () => {
    const tar = await buildTestTar([
      { name: 'z.ts', content: Buffer.from('z') },
      { name: 'a.ts', content: Buffer.from('a') },
      { name: 'm.ts', content: Buffer.from('m') },
    ]);
    setTarResponse(tar);

    const result = await captureBeforeEvidence({
      jobId: `job_${'f'.repeat(32)}`, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    const paths = result.entries.filter((e) => e.kind === 'file').map((e) => e.relPath);
    expect(paths).toEqual([...paths].sort());
  });

  it('records symlink entries with kind=symlink but no bytes and no storedAt', async () => {
    const tar = await buildTestTar([
      { name: 'file.ts', content: Buffer.from('code'), mode: 0o644 },
      { name: 'link.ts', type: 'symlink', mode: 0o777, linkname: 'file.ts' },
    ]);
    setTarResponse(tar);

    const result = await captureBeforeEvidence({
      jobId: `job_${'7'.repeat(32)}`, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    const sym = result.entries.find((e) => e.relPath === 'link.ts')!;
    expect(sym.kind).toBe('symlink');
    expect(sym.sha256).toBe('');
    expect(sym.storedAt).toBeUndefined();
    expect(sym.sizeBytes).toBe(0);
  });

  it('records directory entries without storedAt', async () => {
    const tar = await buildTestTar([
      { name: 'src/', type: 'directory', mode: 0o755 },
      { name: 'src/index.ts', content: Buffer.from('export {};'), mode: 0o644 },
    ]);
    setTarResponse(tar);

    const result = await captureBeforeEvidence({
      jobId: `job_${'8'.repeat(32)}`, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    const dir = result.entries.find((e) => e.relPath === 'src/')!;
    expect(dir.kind).toBe('dir');
    expect(dir.sha256).toBe('');
    expect(dir.storedAt).toBeUndefined();
  });

  it('writes evidence to volume via putArchive', async () => {
    const tar = await buildTestTar([{ name: 'hello.txt', content: Buffer.from('hello'), mode: 0o644 }]);
    setTarResponse(tar);

    await captureBeforeEvidence({
      jobId, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    // putArchive is called to write evidence to the evidence volume
    expect(dockerStub.putArchive).toHaveBeenCalled();
  });

  it('mounts workspace volume READ-ONLY in the capture helper', async () => {
    const tar = await buildTestTar([{ name: 'a.ts', content: Buffer.from('x') }]);
    setTarResponse(tar);

    await captureBeforeEvidence({
      jobId, volumeName: 'my-ws-vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    // The first createContainer call is the capture helper (mountAndStream)
    const createCalls = (dockerStub.createContainer as ReturnType<typeof vi.fn>).mock.calls;
    const captureCall = createCalls[0]!;
    const body = captureCall[1] as Record<string, unknown>;
    const hostConfig = body.HostConfig as Record<string, unknown>;
    const mounts = hostConfig.Mounts as Array<{ Source: string; ReadOnly: boolean }>;
    const wsMnt = mounts.find((m) => m.Source === 'my-ws-vol')!;
    expect(wsMnt.ReadOnly).toBe(true);
  });

  it('never mounts evidence volume into the capture read helper', async () => {
    const tar = await buildTestTar([{ name: 'a.ts', content: Buffer.from('x') }]);
    setTarResponse(tar);

    await captureBeforeEvidence({
      jobId, volumeName: 'ws-vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    });

    // First createContainer is the capture read helper — it should NOT mount the evidence vol
    const createCalls = (dockerStub.createContainer as ReturnType<typeof vi.fn>).mock.calls;
    const captureCall = createCalls[0]!;
    const body = captureCall[1] as Record<string, unknown>;
    const hostConfig = body.HostConfig as Record<string, unknown>;
    const mounts = hostConfig.Mounts as Array<{ Source: string }>;
    const evMnt = mounts.find((m) => m.Source === evidenceVolumeName(jobId));
    expect(evMnt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Failure handling — evidence volume removed on capture failure
// ---------------------------------------------------------------------------

describe('captureBeforeEvidence — failure handling', () => {
  const jobId = `job_${'9'.repeat(32)}`;

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

  it('removes evidence volume when aggregate byte limit is exceeded', async () => {
    // 100 bytes is tiny — the file content will exceed it
    const content = Buffer.alloc(200, 0x42);
    const tar = await buildTestTar([{ name: 'big.bin', content }]);
    setTarResponse(tar);

    const code = await asyncErrCode(() => captureBeforeEvidence({
      jobId, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: 100,
    }));

    expect(code).toBe('BEFORE_CAPTURE_LIMIT');
    // Evidence volume must have been removed
    expect(dockerStub.removeVolume).toHaveBeenCalledWith(evidenceVolumeName(jobId), true);
  });

  it('removes evidence volume when an unsupported entry type is encountered', async () => {
    const tar = await buildTestTar([{ name: 'dev', type: 'block-device', mode: 0o660 }]);
    setTarResponse(tar);

    const code = await asyncErrCode(() => captureBeforeEvidence({
      jobId, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    }));

    expect(code).toBe('BEFORE_CAPTURE_UNSUPPORTED_ENTRY');
    expect(dockerStub.removeVolume).toHaveBeenCalledWith(evidenceVolumeName(jobId), true);
  });

  it('removes evidence volume when a path escape is detected', async () => {
    const tar = await buildTestTar([{ name: '../../etc/passwd', content: Buffer.from('root:x:0:0') }]);
    setTarResponse(tar);

    const code = await asyncErrCode(() => captureBeforeEvidence({
      jobId, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    }));

    expect(code).toBe('BEFORE_CAPTURE_PATH_ESCAPE');
    expect(dockerStub.removeVolume).toHaveBeenCalledWith(evidenceVolumeName(jobId), true);
  });

  it('removes evidence volume when putArchive fails (write failure)', async () => {
    const tar = await buildTestTar([{ name: 'a.ts', content: Buffer.from('x') }]);
    setTarResponse(tar);
    (dockerStub.putArchive as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));

    const code = await asyncErrCode(() => captureBeforeEvidence({
      jobId, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    }));

    expect(code).toBe('BEFORE_CAPTURE_IO');
    expect(dockerStub.removeVolume).toHaveBeenCalledWith(evidenceVolumeName(jobId), true);
  });

  it('removes evidence volume when getArchive fails (stream failure)', async () => {
    (dockerStub.getArchive as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('container not found'),
    );

    const code = await asyncErrCode(() => captureBeforeEvidence({
      jobId, volumeName: 'vol', helperImage: 'img', maxEvidenceBytes: DEFAULT_MAX_EVIDENCE_BYTES,
    }));

    expect(code).toBe('BEFORE_CAPTURE_IO');
    expect(dockerStub.removeVolume).toHaveBeenCalledWith(evidenceVolumeName(jobId), true);
  });
});

// ---------------------------------------------------------------------------
// 7. Lifecycle: evidence volume survives normal runner cleanup
// ---------------------------------------------------------------------------

describe('B2 lifecycle invariants', () => {
  it('evidence volume is NOT included in KiroBackend.cleanup() resource list', async () => {
    // This is a structural assertion: the KiroBackend cleanup method removes
    // specific tracked resources (runner, proxy, networks, control, secret,
    // home, workspace). The evidence volume is deliberately NOT tracked in
    // cleanup. We verify by importing and checking the cleanup does not call
    // removeVolume with the evidence volume name pattern.
    //
    // Since KiroBackend.cleanup() is tested in a4-kiro-backend.test.ts with
    // full Docker stubs, here we just verify the contract: evidenceVolumeName
    // produces a name that is NEVER the same as the workspace, home, control,
    // or secret volume names.
    const jobId = `job_${'a'.repeat(32)}`;
    const evName = evidenceVolumeName(jobId);
    expect(evName).toContain('evidence');
    expect(evName).not.toContain('-ws-');
    expect(evName).not.toContain('-home-');
    expect(evName).not.toContain('-control-');
    expect(evName).not.toContain('-secret-');
  });

  it('maxEvidenceBytes is the sole aggregate size authority', async () => {
    // Structural assertion: the module exports MAX_BEFORE_FILES (structural
    // safety for entry count) but does NOT export a MAX_BEFORE_TOTAL_BYTES
    // or MAX_BEFORE_FILE_BYTES constant — the aggregate byte limit comes
    // exclusively from the trusted maxEvidenceBytes parameter.
    expect(MAX_BEFORE_FILES).toBe(10_000);
    // Ensure no second aggregate byte constant is exported
    const mod = await import('../../src/executor/agents/beforeCapture.js');
    expect((mod as Record<string, unknown>)['MAX_BEFORE_TOTAL_BYTES']).toBeUndefined();
    expect((mod as Record<string, unknown>)['MAX_BEFORE_FILE_BYTES']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. A3 reconciler preserves evidence volumes
// ---------------------------------------------------------------------------

describe('A3 reconciler skips evidence volumes', () => {
  it('reconcileOrphans does not remove volumes with resource=evidence label', async () => {
    // Import the RunnerSandbox class
    const { RunnerSandbox } = await import('../../src/executor/agents/sandboxRunner.js');
    const { LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB } = await import('../../src/executor/agents/sandboxSpec.js');

    // Setup: listContainersByFilter returns empty, listVolumesByFilter returns
    // one evidence volume and one workspace volume.
    vi.clearAllMocks();
    (dockerStub.listContainersByFilter as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (dockerStub.listVolumesByFilter as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { Name: 'bridge-evidence-job_aaa', Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'evidence', [LABEL_JOB]: 'job_aaa' } },
      { Name: 'bridge-ws-job_bbb', Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'workspace', [LABEL_JOB]: 'job_bbb' } },
    ]);

    const sandbox = new RunnerSandbox({ image: 'test:latest' });
    const result = await sandbox.reconcileOrphans();

    // Only the workspace volume should be removed, NOT the evidence volume
    expect(result.removedVolumes).toContain('bridge-ws-job_bbb');
    expect(result.removedVolumes).not.toContain('bridge-evidence-job_aaa');
  });
});
