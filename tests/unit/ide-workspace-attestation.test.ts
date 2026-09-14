import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  IDE_WORKSPACE_ATTESTATION_MAX_BYTES,
  IdeWorkspaceAttestationError,
  deriveIdeEnvironmentIdentity,
  deriveIdeFilesystemIdentity,
  deriveIdeWorkspaceFingerprint,
  parseIdeWorkspaceAttestation,
  serializeIdeWorkspaceAttestation,
  validateIdeWorkspaceAttestation,
  type IdeWorkspaceAttestation,
  type IdeWorkspacePhysicalIdentity,
} from '../../src/shared/ideWorkspaceAttestation.js';

const envId = deriveIdeEnvironmentIdentity('wsl', 'distro:ubuntu-24.04');
const fsId = deriveIdeFilesystemIdentity('posix', '2049', '123456');
const commonId = deriveIdeFilesystemIdentity('posix', '2049', '654321');

function workspace(over: Partial<IdeWorkspacePhysicalIdentity> = {}): IdeWorkspacePhysicalIdentity {
  const canonicalPath = '/home/herman/projects/QuaranGate-u1-full';
  return {
    workspaceFolderCount: 1,
    remoteKind: 'wsl',
    environmentIdentity: envId,
    pathFlavor: 'posix',
    caseMode: 'case-sensitive',
    canonicalization: 'realpath-exact',
    workspaceUri: pathToFileURL(canonicalPath).href,
    canonicalPath,
    filesystemIdentity: fsId,
    git: {
      kind: 'worktree',
      worktreeRoot: canonicalPath,
      commonDir: '/home/herman/projects/QuaranGate/.git',
      commonDirIdentity: commonId,
      headRevision: 'a'.repeat(40),
    },
    ...over,
  };
}

function attestation(over: Partial<IdeWorkspaceAttestation> = {}): IdeWorkspaceAttestation {
  return {
    version: 1,
    enrollmentId: `iden_${'1'.repeat(32)}`,
    ideInstanceId: `ide_${'2'.repeat(32)}`,
    runtimeInstanceId: `iderun_${'3'.repeat(32)}`,
    ideProduct: 'vscode',
    adapterId: 'quarangate-vscode-companion',
    adapterVersion: '1.2.3',
    sessionId: `ides_${'4'.repeat(32)}`,
    connectionGeneration: 7,
    workspace: workspace(),
    ...over,
  };
}

function code(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; } catch (error) {
    return error instanceof IdeWorkspaceAttestationError ? error.code : 'OTHER_ERROR';
  }
}

describe('P7 B5 workspace attestation contract', () => {
  it('serializes and parses one exact canonical bounded attestation', () => {
    const value = attestation();
    const text = serializeIdeWorkspaceAttestation(value);
    expect(parseIdeWorkspaceAttestation(text)).toEqual(value);
    expect(Buffer.byteLength(text)).toBeLessThan(IDE_WORKSPACE_ATTESTATION_MAX_BYTES);
    expect(text).not.toContain('projectId');
    expect(text).not.toContain('worktreeId');
    expect(text).not.toContain('workspaceFingerprint');
  });

  it('rejects whitespace, key-order drift, duplicate/unknown fields and future versions by canonical re-encoding', () => {
    const text = serializeIdeWorkspaceAttestation(attestation());
    expect(code(() => parseIdeWorkspaceAttestation(` ${text}`))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const reordered = JSON.stringify({ version: parsed.version, ...parsed });
    expect(code(() => parseIdeWorkspaceAttestation(reordered))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    expect(code(() => parseIdeWorkspaceAttestation(text.replace('{', '{"version":1,')))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    expect(code(() => parseIdeWorkspaceAttestation(text.replace('"version":1', '"extra":true,"version":1')))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    expect(code(() => validateIdeWorkspaceAttestation({ ...attestation(), version: 2 as 1 }))).toBe('IDE_WORKSPACE_UNSUPPORTED_VERSION');
  });

  it('rejects malformed/oversized/invalid-UTF8 payloads', () => {
    expect(code(() => parseIdeWorkspaceAttestation('{'))).toBe('IDE_WORKSPACE_INVALID_JSON');
    expect(code(() => parseIdeWorkspaceAttestation(Buffer.alloc(IDE_WORKSPACE_ATTESTATION_MAX_BYTES + 1, 0x61)))).toBe('IDE_WORKSPACE_FRAME_SIZE');
    expect(code(() => parseIdeWorkspaceAttestation(Buffer.from([0xff, 0xfe])))).toBe('IDE_WORKSPACE_INVALID_JSON');
  });

  it('requires exactly one workspace folder and a supported remote/path combination', () => {
    expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: workspace({ workspaceFolderCount: 2 as 1 }) })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: workspace({ remoteKind: 'other' as 'wsl' }) })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    const winPath = 'C:\\src\\project';
    expect(code(() => validateIdeWorkspaceAttestation(attestation({
      workspace: workspace({ remoteKind: 'wsl', pathFlavor: 'win32', canonicalPath: winPath, workspaceUri: pathToFileURL(winPath, { windows: true }).href }),
    })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
  });

  it('rejects relative, root, non-normalized, backslash POSIX and URI/path alias evidence', () => {
    const cases: Array<Partial<IdeWorkspacePhysicalIdentity>> = [
      { canonicalPath: 'relative/project', workspaceUri: 'file:///relative/project' },
      { canonicalPath: '/', workspaceUri: 'file:///' },
      { canonicalPath: '/home/x/../project', workspaceUri: 'file:///home/project' },
      { canonicalPath: '/home/x\\project', workspaceUri: 'file:///home/x%5Cproject' },
      { canonicalPath: '/home/real', workspaceUri: 'file:///home/symlink' },
    ];
    for (const changed of cases) {
      expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: workspace(changed) })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    }
  });

  it('accepts one canonical local Win32 drive identity but rejects lower-drive, UNC and drive root forms', () => {
    const p = 'C:\\src\\project';
    const gitCommon = 'C:\\src\\main\\.git';
    const win = workspace({
      remoteKind: 'local',
      pathFlavor: 'win32',
      caseMode: 'case-insensitive',
      environmentIdentity: deriveIdeEnvironmentIdentity('local', 'windows-host-identity'),
      canonicalPath: p,
      workspaceUri: pathToFileURL(p, { windows: true }).href,
      filesystemIdentity: deriveIdeFilesystemIdentity('win32', '77', '88'),
      git: {
        kind: 'worktree', worktreeRoot: p, commonDir: gitCommon,
        commonDirIdentity: deriveIdeFilesystemIdentity('win32', '77', '99'), headRevision: 'b'.repeat(40),
      },
    });
    expect(() => validateIdeWorkspaceAttestation(attestation({ workspace: win }))).not.toThrow();
    expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: { ...win, canonicalPath: 'c:\\src\\project', workspaceUri: 'file:///c:/src/project', git: { ...win.git, worktreeRoot: 'c:\\src\\project' } } })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: { ...win, canonicalPath: '\\\\server\\share', workspaceUri: 'file://server/share' } })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: { ...win, canonicalPath: 'C:\\', workspaceUri: 'file:///C:/' } })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
  });

  it('requires exact Git worktree root, canonical common-dir identity and valid HEAD', () => {
    const base = workspace();
    if (base.git.kind !== 'worktree') throw new Error('fixture');
    expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: { ...base, git: { ...base.git, worktreeRoot: '/home/herman/projects/other' } } })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: { ...base, git: { ...base.git, commonDirIdentity: 'x'.repeat(64) } } })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
    expect(code(() => validateIdeWorkspaceAttestation(attestation({ workspace: { ...base, git: { ...base.git, headRevision: 'z'.repeat(40) } } })))).toBe('IDE_WORKSPACE_INVALID_SCHEMA');
  });

  it('derives deterministic filesystem/environment identities and rejects malformed source IDs', () => {
    expect(deriveIdeFilesystemIdentity('posix', '2049', '123456')).toBe(fsId);
    expect(deriveIdeEnvironmentIdentity('wsl', 'distro:ubuntu-24.04')).toBe(envId);
    expect(code(() => deriveIdeFilesystemIdentity('posix', '-1', '1'))).toBe('IDE_WORKSPACE_IDENTITY_INVALID');
    expect(code(() => deriveIdeEnvironmentIdentity('other' as 'wsl', 'x'))).toBe('IDE_WORKSPACE_IDENTITY_INVALID');
  });

  it('binds fingerprint to trusted project/worktree and physical identity but not transient session/runtime/head', () => {
    const w = workspace();
    const base = deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: w });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: w })).toBe(base);
    expect(deriveIdeWorkspaceFingerprint({ projectId: 'other', worktreeId: 'forward', workspace: w })).not.toBe(base);
    expect(deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'review', workspace: w })).not.toBe(base);
    expect(deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: { ...w, filesystemIdentity: 'f'.repeat(64) } })).not.toBe(base);
    expect(deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: { ...w, environmentIdentity: 'e'.repeat(64) } })).not.toBe(base);
    if (w.git.kind !== 'worktree') throw new Error('fixture');
    expect(deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: { ...w, git: { ...w.git, commonDirIdentity: 'd'.repeat(64) } } })).not.toBe(base);
    expect(deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: { ...w, git: { ...w.git, headRevision: 'c'.repeat(40) } } })).toBe(base);
  });
});
