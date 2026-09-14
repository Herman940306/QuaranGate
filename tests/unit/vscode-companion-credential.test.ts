import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIdeCompanionRuntime,
  revokeIdeCompanionSecret,
  type IdeCompanionRuntimeRef,
} from '../../src/executor/ide/ideCompanionRuntime.js';
import {
  readVsCodeCompanionCredential,
  VsCodeCompanionCredentialError,
} from '../../src/ide-adapters/vscode/vscodeCompanionCredential.js';

const roots: string[] = [];
let seq = 0;

function fixture(product: 'vscode'|'cursor' = 'vscode', version = '1.2.3'): IdeCompanionRuntimeRef {
  seq += 1;
  const base = mkdtempSync(join(tmpdir(), 'qg-vsc-cred-'));
  roots.push(base);
  chmodSync(base, 0o700);
  const runtimeRoot = join(base, 'runtime');
  mkdirSync(runtimeRoot, { mode: 0o700 }); chmodSync(runtimeRoot, 0o700);
  const digit = (seq % 15 + 1).toString(16);
  return createIdeCompanionRuntime({
    runtimeRoot,
    enrollmentId: `iden_${digit.repeat(32)}`,
    ideInstanceId: `ide_${digit.repeat(32)}`,
    ideProduct: product,
    adapterVersion: version,
  });
}

function errorCode(fn: () => unknown): string {
  try { fn(); throw new Error('expected credential error'); }
  catch (error) { if (error instanceof VsCodeCompanionCredentialError) return error.code; throw error; }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('P7 I2.1 VS Code B4 credential consumer', () => {
  it('accepts the exact executor-generated active VS Code credential and returns mutable 256-bit secret material', () => {
    const runtime = fixture();
    const credential = readVsCodeCompanionCredential(runtime.credentialPath, runtime.adapterVersion);
    expect(credential).toMatchObject({
      runtimeInstanceId: runtime.runtimeInstanceId,
      enrollmentId: runtime.enrollmentId,
      ideInstanceId: runtime.ideInstanceId,
      ideProduct: 'vscode',
      adapterId: 'quarangate-vscode-companion',
      adapterVersion: runtime.adapterVersion,
      socketPath: runtime.socketPath,
      credentialPath: runtime.credentialPath,
      state: 'ACTIVE',
    });
    expect(credential.secret).toHaveLength(32);
    credential.secret.fill(0);
    expect(credential.secret.equals(Buffer.alloc(32))).toBe(true);
  });

  it('rejects extension/runtime adapter version drift before any socket connection', () => {
    const runtime = fixture('vscode', '1.2.3');
    expect(errorCode(() => readVsCodeCompanionCredential(runtime.credentialPath, '1.2.4'))).toBe('VSCODE_CREDENTIAL_VERSION_MISMATCH');
  });

  it('rejects a revoked credential rather than trying an old secret', () => {
    const runtime = fixture(); revokeIdeCompanionSecret(runtime);
    expect(errorCode(() => readVsCodeCompanionCredential(runtime.credentialPath, runtime.adapterVersion))).toBe('VSCODE_CREDENTIAL_REVOKED');
  });

  it('rejects a credential for another IDE product/adapter', () => {
    const runtime = fixture('cursor');
    expect(errorCode(() => readVsCodeCompanionCredential(runtime.credentialPath, runtime.adapterVersion))).toBe('VSCODE_CREDENTIAL_SCHEMA_INVALID');
  });

  it('rejects unsafe credential permissions', () => {
    const runtime = fixture(); chmodSync(runtime.credentialPath, 0o640);
    expect(errorCode(() => readVsCodeCompanionCredential(runtime.credentialPath, runtime.adapterVersion))).toBe('VSCODE_CREDENTIAL_FILE_INVALID');
  });

  it('rejects a non-sticky group/world-writable runtime ancestor even when runtime files remain 0700/0600', () => {
    const runtime = fixture();
    const base = runtime.runtimeRoot.split('/').slice(0, -1).join('/') || '/';
    chmodSync(base, 0o777);
    expect(errorCode(() => readVsCodeCompanionCredential(runtime.credentialPath, runtime.adapterVersion))).toBe('VSCODE_CREDENTIAL_PATH_INVALID');
  });

  it('rejects runtime-root mode drift even when the instance directory and credential remain owner-only', () => {
    const runtime = fixture(); chmodSync(runtime.runtimeRoot, 0o755);
    expect(errorCode(() => readVsCodeCompanionCredential(runtime.credentialPath, runtime.adapterVersion))).toBe('VSCODE_CREDENTIAL_PATH_INVALID');
  });

  it('rejects noncanonical credential JSON even when its values are otherwise valid', () => {
    const runtime = fixture();
    const raw = readFileSync(runtime.credentialPath, 'utf8');
    writeFileSync(runtime.credentialPath, ` ${raw}`, { mode: 0o600 }); chmodSync(runtime.credentialPath, 0o600);
    expect(errorCode(() => readVsCodeCompanionCredential(runtime.credentialPath, runtime.adapterVersion))).toBe('VSCODE_CREDENTIAL_SCHEMA_INVALID');
  });

  it('rejects caller-substituted socket path despite a canonical credential re-encoding', () => {
    const runtime = fixture();
    const value = JSON.parse(readFileSync(runtime.credentialPath, 'utf8')) as Record<string, unknown>;
    value.socketPath = join(runtime.directory, 'other.sock');
    writeFileSync(runtime.credentialPath, `${JSON.stringify(value)}\n`, { mode: 0o600 }); chmodSync(runtime.credentialPath, 0o600);
    expect(errorCode(() => readVsCodeCompanionCredential(runtime.credentialPath, runtime.adapterVersion))).toBe('VSCODE_CREDENTIAL_SCHEMA_INVALID');
  });
});
