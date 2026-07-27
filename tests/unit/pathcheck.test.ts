import { describe, it, expect } from 'vitest';
import { validateRelativePath, joinWorkspace, isInside } from '../../src/shared/pathcheck.js';
import { BridgeError } from '../../src/shared/errors.js';

describe('validateRelativePath', () => {
  it('accepts normal relative paths', () => {
    expect(validateRelativePath('src/app.ts')).toBe('src/app.ts');
    expect(validateRelativePath('./src/./app.ts')).toBe('src/app.ts');
    expect(validateRelativePath('')).toBe('');
    expect(validateRelativePath('.')).toBe('');
  });

  it('rejects parent traversal', () => {
    for (const p of ['../etc', 'a/../../b', '../../etc/passwd', 'src/../../..']) {
      expect(() => validateRelativePath(p)).toThrow(BridgeError);
    }
  });

  it('rejects absolute paths and drive letters', () => {
    for (const p of ['/etc/passwd', '/root', 'C:/Windows', 'c:\\x']) {
      expect(() => validateRelativePath(p)).toThrow(BridgeError);
    }
  });

  it('rejects null bytes and backslashes', () => {
    expect(() => validateRelativePath('a\0b')).toThrow(BridgeError);
    expect(() => validateRelativePath('a\\b')).toThrow(BridgeError);
  });

  it('rejects encoded/normalized traversal that resolves up', () => {
    expect(() => validateRelativePath('foo/../../bar')).toThrow(BridgeError);
  });
});

describe('joinWorkspace', () => {
  it('joins inside root', () => {
    expect(joinWorkspace('/workspace', 'src/app.ts')).toBe('/workspace/src/app.ts');
    expect(joinWorkspace('/workspace', '')).toBe('/workspace');
  });
});

describe('isInside', () => {
  it('detects containment correctly', () => {
    expect(isInside('/workspace', '/workspace')).toBe(true);
    expect(isInside('/workspace', '/workspace/src/a')).toBe(true);
    expect(isInside('/workspace', '/workspace-evil')).toBe(false);
    expect(isInside('/workspace', '/etc/passwd')).toBe(false);
    expect(isInside('/workspace', '/secretzone')).toBe(false);
  });
});
