/**
 * Unit tests for the A4 credential manager — file validation, secret naming,
 * and security policy enforcement. These tests use synthetic credentials only
 * and never touch the real API key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager, RUNNER_SECRET_PATH, secretVolumeName } from '../../src/executor/agents/credentialManager.js';

describe('credential manager — file validation', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cred-test-'));
    keyPath = join(dir, 'test-key');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a properly restricted key file (0600)', () => {
    writeFileSync(keyPath, 'test-credential-value-1234567890', { mode: 0o600 });
    const mgr = new CredentialManager({ credentialPath: keyPath, helperImage: 'alpine' });
    const info = mgr.verifyCredentialFile();
    expect(info.mode).toBe('600');
    expect(info.size).toBe(32);
  });

  it('rejects a key file with group-readable permissions (0640)', () => {
    writeFileSync(keyPath, 'secret-value-1234567890123456', { mode: 0o640 });
    const mgr = new CredentialManager({ credentialPath: keyPath, helperImage: 'alpine' });
    expect(() => mgr.verifyCredentialFile()).toThrow(/unsafe permissions/);
  });

  it('rejects a key file with world-readable permissions (0644)', () => {
    writeFileSync(keyPath, 'secret-value-1234567890123456', { mode: 0o644 });
    const mgr = new CredentialManager({ credentialPath: keyPath, helperImage: 'alpine' });
    expect(() => mgr.verifyCredentialFile()).toThrow(/unsafe permissions/);
  });

  it('rejects a missing key file', () => {
    const mgr = new CredentialManager({ credentialPath: '/nonexistent/path', helperImage: 'alpine' });
    expect(() => mgr.verifyCredentialFile()).toThrow(/not found/);
  });

  it('rejects keys that are too short', () => {
    writeFileSync(keyPath, 'short', { mode: 0o600 });
    const mgr = new CredentialManager({ credentialPath: keyPath, helperImage: 'alpine' });
    // verifyCredentialFile checks metadata only; getKeyForDirectUse checks length
    expect(() => mgr.getKeyForDirectUse()).toThrow(/unexpected length/);
  });

  it('rejects keys that are too long', () => {
    writeFileSync(keyPath, 'x'.repeat(300), { mode: 0o600 });
    const mgr = new CredentialManager({ credentialPath: keyPath, helperImage: 'alpine' });
    expect(() => mgr.getKeyForDirectUse()).toThrow(/unexpected length/);
  });

  it('trims whitespace from the key', () => {
    writeFileSync(keyPath, '  valid-key-value-1234567890  \n', { mode: 0o600 });
    const mgr = new CredentialManager({ credentialPath: keyPath, helperImage: 'alpine' });
    const key = mgr.getKeyForDirectUse();
    expect(key).toBe('valid-key-value-1234567890');
    expect(key).not.toContain('\n');
    expect(key).not.toMatch(/^\s/);
  });
});

describe('credential manager — secret volume naming', () => {
  it('produces valid Docker volume names from job IDs', () => {
    const jobId = 'job_' + '0'.repeat(32);
    const name = secretVolumeName(jobId);
    expect(name).toMatch(/^io-mcp-ide-bridge-secret-job_/);
    expect(name).not.toContain('.');
    expect(name.length).toBeLessThan(128);
  });

  it('includes the job ID for reconciliation', () => {
    const jobId = 'job_abcdef1234567890abcdef1234567890';
    const name = secretVolumeName(jobId);
    expect(name).toContain(jobId);
  });
});

describe('credential manager — runner secret path', () => {
  it('mounts at /run/secrets/kiro-api-key', () => {
    expect(RUNNER_SECRET_PATH).toBe('/run/secrets/kiro-api-key');
  });

  it('secret path is not in /workspace', () => {
    expect(RUNNER_SECRET_PATH).not.toContain('/workspace');
  });

  it('secret path is not in home directory', () => {
    expect(RUNNER_SECRET_PATH).not.toContain('/home');
  });
});

describe('credential manager — non-exposure policy', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cred-expose-'));
    keyPath = join(dir, 'test-key');
    writeFileSync(keyPath, 'synthetic-key-for-testing-only!', { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('getKeyForDirectUse returns the key (for isolated process use)', () => {
    const mgr = new CredentialManager({ credentialPath: keyPath, helperImage: 'alpine' });
    const key = mgr.getKeyForDirectUse();
    expect(key.length).toBeGreaterThan(10);
  });

  it('caches the key after first read', () => {
    const mgr = new CredentialManager({ credentialPath: keyPath, helperImage: 'alpine' });
    const k1 = mgr.getKeyForDirectUse();
    // Remove the file — cached should still work
    rmSync(keyPath);
    const k2 = mgr.getKeyForDirectUse();
    expect(k2).toBe(k1);
  });
});
