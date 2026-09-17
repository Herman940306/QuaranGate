/**
 * N1D host secret-path resolution (§47.8, §47.13 DECISION-4 Option B).
 *
 * Precedence: explicit env → new QuaranGate path → legacy path → new path.
 * The resolver deals only in PATHS; it never opens or reads the credential.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveKiroKeyFile,
  QUARANGATE_KIRO_KEY_FILE,
  LEGACY_KIRO_KEY_FILE,
  KIRO_EXECUTOR_UID,
  verifyKiroKeyFileMetadata,
} from '../../scripts/resolve-kiro-key-file.mjs';

const present = (...paths: string[]) => (p: string) => paths.includes(p);

describe('resolveKiroKeyFile', () => {
  it('uses the frozen path pair', () => {
    expect(QUARANGATE_KIRO_KEY_FILE).toBe('/home/herman/.config/quarangate/kiro-api-key');
    expect(LEGACY_KIRO_KEY_FILE).toBe('/home/herman/.config/mcp-ide-bridge/kiro-api-key');
  });

  it('lets an explicit AGENT_KIRO_KEY_FILE win over both defaults', () => {
    const r = resolveKiroKeyFile({
      env: { AGENT_KIRO_KEY_FILE: '/custom/key' },
      exists: present(QUARANGATE_KIRO_KEY_FILE, LEGACY_KIRO_KEY_FILE),
    });
    expect(r).toEqual({ path: '/custom/key', source: 'explicit' });
  });

  it('ignores an empty/whitespace AGENT_KIRO_KEY_FILE', () => {
    const r = resolveKiroKeyFile({
      env: { AGENT_KIRO_KEY_FILE: '   ' },
      exists: present(LEGACY_KIRO_KEY_FILE),
    });
    expect(r).toEqual({ path: LEGACY_KIRO_KEY_FILE, source: 'legacy' });
  });

  it('prefers the NEW path when both exist (never a stale copy)', () => {
    const r = resolveKiroKeyFile({
      env: {},
      exists: present(QUARANGATE_KIRO_KEY_FILE, LEGACY_KIRO_KEY_FILE),
    });
    expect(r).toEqual({ path: QUARANGATE_KIRO_KEY_FILE, source: 'quarangate' });
  });

  it('falls back to the legacy path when only it exists (pre-migration)', () => {
    const r = resolveKiroKeyFile({ env: {}, exists: present(LEGACY_KIRO_KEY_FILE) });
    expect(r).toEqual({ path: LEGACY_KIRO_KEY_FILE, source: 'legacy' });
  });

  it('uses the new path when only it exists (post-migration)', () => {
    const r = resolveKiroKeyFile({ env: {}, exists: present(QUARANGATE_KIRO_KEY_FILE) });
    expect(r).toEqual({ path: QUARANGATE_KIRO_KEY_FILE, source: 'quarangate' });
  });

  it('names the NEW path when neither exists, so failures point forward', () => {
    const r = resolveKiroKeyFile({ env: {}, exists: present() });
    expect(r).toEqual({ path: QUARANGATE_KIRO_KEY_FILE, source: 'default' });
  });
});


describe('Kiro file-backed secret metadata preflight', () => {
  const regular = (overrides: Partial<{ uid: number; mode: number; size: number; file: boolean; symlink: boolean }> = {}) => ({
    uid: 1000, mode: 0o100600, size: 64,
    isFile: () => true, isSymbolicLink: () => false,
    ...('uid' in overrides ? { uid: overrides.uid } : {}),
    ...('mode' in overrides ? { mode: overrides.mode } : {}),
    ...('size' in overrides ? { size: overrides.size } : {}),
    ...('file' in overrides ? { isFile: () => overrides.file! } : {}),
    ...('symlink' in overrides ? { isSymbolicLink: () => overrides.symlink! } : {}),
  });

  it('binds the host source contract to the executor uid, exact 0600, and bounded metadata without reading bytes', () => {
    expect(KIRO_EXECUTOR_UID).toBe(1000);
    const meta = verifyKiroKeyFileMetadata('/host/key', { lstat: () => regular() as any });
    expect(meta).toEqual({ path: '/host/key', uid: 1000, mode: '600', size: 64 });
  });

  it.each([
    ['wrong owner', regular({ uid: 1001 })],
    ['group-readable', regular({ mode: 0o100640 })],
    ['world-readable', regular({ mode: 0o100604 })],
    ['symlink', regular({ symlink: true })],
    ['not regular', regular({ file: false })],
    ['too small', regular({ size: 9 })],
    ['too large', regular({ size: 1025 })],
  ])('fails closed for %s', (_name, stat) => {
    expect(() => verifyKiroKeyFileMetadata('/host/key', { lstat: () => stat as any })).toThrow();
  });
});
