import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IDE_COMPANION_ADAPTER_IDS,
  IDE_COMPANION_RUNTIME_DIRECTORY_MODE,
  IDE_COMPANION_RUNTIME_FILE_MODE,
  IDE_COMPANION_RUNTIME_INSTANCE_PATTERN,
  IDE_COMPANION_RUNTIME_SECRET_BYTES,
  IdeCompanionRuntimeError,
  assertTrustedIdeCompanionRuntimeRoot,
  createIdeCompanionRuntime,
  hardenAndVerifyIdeCompanionSocket,
  readIdeCompanionSecret,
  recoverIdeCompanionRuntime,
  revokeIdeCompanionSecret,
  rotateIdeCompanionSecret,
  type IdeCompanionRuntimeRef,
} from '../../src/executor/ide/ideCompanionRuntime.js';
import { IDE_COMPANION_MIN_SECRET_BYTES, IDE_COMPANION_MAX_SECRET_BYTES } from '../../src/shared/ideCompanionAuth.js';

let base: string;
let root: string;

const enrollmentId = `iden_${'1'.repeat(32)}`;
const ideInstanceId = `ide_${'2'.repeat(32)}`;

function runtime(over: Partial<Parameters<typeof createIdeCompanionRuntime>[0]> = {}): IdeCompanionRuntimeRef {
  return createIdeCompanionRuntime({
    runtimeRoot: root,
    enrollmentId,
    ideInstanceId,
    ideProduct: 'vscode',
    adapterVersion: '1.2.3',
    ...over,
  });
}

function code(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; } catch (error) {
    return error instanceof IdeCompanionRuntimeError ? error.code : 'OTHER_ERROR';
  }
}

function mode(path: string): number { return statSync(path).mode & 0o777; }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'qg-ide-runtime-test-'));
  chmodSync(base, 0o700);
  root = join(base, 'runtime');
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('P7 B4 trusted runtime root and identity', () => {
  it('accepts an exact owner-only canonical runtime root', () => {
    expect(() => assertTrustedIdeCompanionRuntimeRoot(root)).not.toThrow();
    expect(mode(root)).toBe(IDE_COMPANION_RUNTIME_DIRECTORY_MODE);
  });

  it('rejects relative, group/world-accessible, final-symlink and parent-symlink roots', () => {
    expect(code(() => assertTrustedIdeCompanionRuntimeRoot('relative/runtime'))).toBe('IDE_RUNTIME_ROOT_INVALID');

    chmodSync(root, 0o750);
    expect(code(() => assertTrustedIdeCompanionRuntimeRoot(root))).toBe('IDE_RUNTIME_ROOT_INVALID');
    chmodSync(root, 0o700);

    const alias = join(base, 'runtime-link');
    symlinkSync(root, alias);
    expect(code(() => assertTrustedIdeCompanionRuntimeRoot(alias))).toBe('IDE_RUNTIME_ROOT_INVALID');

    const realParent = join(base, 'real-parent');
    mkdirSync(realParent, { mode: 0o700 }); chmodSync(realParent, 0o700);
    const nested = join(realParent, 'nested');
    mkdirSync(nested, { mode: 0o700 }); chmodSync(nested, 0o700);
    const parentAlias = join(base, 'parent-link');
    symlinkSync(realParent, parentAlias);
    expect(code(() => assertTrustedIdeCompanionRuntimeRoot(join(parentAlias, 'nested')))).toBe('IDE_RUNTIME_ROOT_INVALID');

    const unsafeParent = join(base, 'unsafe-parent');
    mkdirSync(unsafeParent, { mode: 0o777 }); chmodSync(unsafeParent, 0o777);
    const protectedChild = join(unsafeParent, 'protected-child');
    mkdirSync(protectedChild, { mode: 0o700 }); chmodSync(protectedChild, 0o700);
    expect(code(() => assertTrustedIdeCompanionRuntimeRoot(protectedChild))).toBe('IDE_RUNTIME_ROOT_INVALID');

    expect(code(() => assertTrustedIdeCompanionRuntimeRoot(`${root}/../runtime`))).toBe('IDE_RUNTIME_ROOT_INVALID');
  });

  it('derives opaque runtime paths and closed adapter identity without exposing a secret in the reference', () => {
    const ref = runtime();
    expect(ref.runtimeInstanceId).toMatch(IDE_COMPANION_RUNTIME_INSTANCE_PATTERN);
    expect(ref.directory).toBe(join(root, ref.runtimeInstanceId));
    expect(ref.credentialPath).toBe(join(ref.directory, 'credential.json'));
    expect(ref.socketPath).toBe(join(ref.directory, 'companion.sock'));
    expect(ref.adapterId).toBe('quarangate-vscode-companion');
    expect(mode(ref.directory)).toBe(0o700);
    expect(mode(ref.credentialPath)).toBe(0o600);
    expect(JSON.stringify(ref)).not.toContain('secret');
    expect(() => statSync(ref.socketPath)).toThrow();
  });

  it('maps every supported IDE product to one closed QuaranGate adapter id', () => {
    expect(IDE_COMPANION_ADAPTER_IDS).toEqual({
      vscode: 'quarangate-vscode-companion',
      kiro: 'quarangate-kiro-companion',
      cursor: 'quarangate-cursor-companion',
      'visual-studio': 'quarangate-visual-studio-companion',
      antigravity: 'quarangate-antigravity-companion',
    });
  });

  it('rejects malformed adapter versions and invalid logical identities before runtime creation', () => {
    expect(code(() => runtime({ adapterVersion: 'latest' }))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
    expect(code(() => runtime({ adapterVersion: '01.2.3' }))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
    expect(code(() => runtime({ enrollmentId: 'bad' }))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects a runtime root that would exceed the conservative Unix socket-path bound without creating an instance', () => {
    const longRoot = join(base, 'x'.repeat(62));
    mkdirSync(longRoot, { mode: 0o700 }); chmodSync(longRoot, 0o700);
    expect(code(() => createIdeCompanionRuntime({
      runtimeRoot: longRoot,
      enrollmentId,
      ideInstanceId,
      ideProduct: 'vscode',
      adapterVersion: '1.2.3',
    }))).toBe('IDE_RUNTIME_PATH_UNSAFE');
    expect(readdirSync(longRoot)).toEqual([]);
  });

  it('can provision and recover one exact trusted durable runtime identity without scanning', () => {
    const runtimeInstanceId = `iderun_${'7'.repeat(32)}`;
    const created = runtime({ runtimeInstanceId });
    expect(created.runtimeInstanceId).toBe(runtimeInstanceId);
    const recovered = recoverIdeCompanionRuntime({
      runtimeRoot: root,
      runtimeInstanceId,
      enrollmentId,
      ideInstanceId,
      ideProduct: 'vscode',
      adapterVersion: '1.2.3',
    });
    expect(recovered).toEqual(created);
    expect(code(() => recoverIdeCompanionRuntime({
      runtimeRoot: root,
      runtimeInstanceId,
      enrollmentId,
      ideInstanceId: `ide_${'8'.repeat(32)}`,
      ideProduct: 'vscode',
      adapterVersion: '1.2.3',
    }))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
  });

  it('produces independent opaque runtime ids and independent 256-bit secrets', () => {
    const a = runtime(); const b = runtime();
    const sa = readIdeCompanionSecret(a).secret;
    const sb = readIdeCompanionSecret(b).secret;
    expect(a.runtimeInstanceId).not.toBe(b.runtimeInstanceId);
    expect(sa.equals(sb)).toBe(false);
    expect(sa.byteLength).toBe(IDE_COMPANION_RUNTIME_SECRET_BYTES);
    expect(IDE_COMPANION_RUNTIME_SECRET_BYTES).toBeGreaterThanOrEqual(IDE_COMPANION_MIN_SECRET_BYTES);
    expect(IDE_COMPANION_RUNTIME_SECRET_BYTES).toBeLessThanOrEqual(IDE_COMPANION_MAX_SECRET_BYTES);
  });
});

describe('P7 B4 strict credential material', () => {
  it('creates canonical active credential material and revalidates it on every secret read', () => {
    const ref = runtime();
    const first = readIdeCompanionSecret(ref);
    expect(first.secretGeneration).toBe(1);
    expect(first.secret.byteLength).toBe(32);

    const raw = readFileSync(ref.credentialPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.slice(0, -1).includes('\n')).toBe(false);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      version: 1,
      state: 'ACTIVE',
      runtimeInstanceId: ref.runtimeInstanceId,
      enrollmentId,
      ideInstanceId,
      ideProduct: 'vscode',
      adapterId: 'quarangate-vscode-companion',
      adapterVersion: '1.2.3',
      secretGeneration: 1,
      socketPath: ref.socketPath,
    });
    expect(typeof parsed.secret).toBe('string');
  });

  it('fails closed after credential permissions are broadened', () => {
    const ref = runtime();
    expect(readIdeCompanionSecret(ref).secretGeneration).toBe(1);
    chmodSync(ref.credentialPath, 0o640);
    expect(code(() => readIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
    expect(code(() => rotateIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
  });

  it('rejects a symlink substituted for the credential path', () => {
    const ref = runtime();
    const target = join(ref.directory, 'other-secret');
    writeFileSync(target, '{}\n', { mode: 0o600 });
    rmSync(ref.credentialPath);
    symlinkSync(target, ref.credentialPath);
    expect(code(() => readIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
  });

  it('rejects noncanonical JSON, duplicate fields and unknown fields even when file mode stays safe', () => {
    const ref = runtime();
    const body = readFileSync(ref.credentialPath, 'utf8').slice(0, -1);

    writeFileSync(ref.credentialPath, ` ${body}\n`, { mode: 0o600 });
    expect(code(() => readIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');

    writeFileSync(ref.credentialPath, body.replace('{', '{"version":1,') + '\n', { mode: 0o600 });
    expect(code(() => readIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');

    const obj = JSON.parse(body) as Record<string, unknown>;
    obj.extra = true;
    writeFileSync(ref.credentialPath, JSON.stringify(obj) + '\n', { mode: 0o600 });
    expect(code(() => readIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
  });

  it('rejects credential identity substitution and malformed secret bytes', () => {
    const ref = runtime();
    const obj = JSON.parse(readFileSync(ref.credentialPath, 'utf8')) as Record<string, unknown>;
    obj.ideInstanceId = `ide_${'9'.repeat(32)}`;
    writeFileSync(ref.credentialPath, JSON.stringify(obj) + '\n', { mode: 0o600 });
    expect(code(() => readIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');

    const fresh = runtime();
    const obj2 = JSON.parse(readFileSync(fresh.credentialPath, 'utf8')) as Record<string, unknown>;
    obj2.secret = 'A'.repeat(42) + '!';
    writeFileSync(fresh.credentialPath, JSON.stringify(obj2) + '\n', { mode: 0o600 });
    expect(code(() => readIdeCompanionSecret(fresh))).toBe('IDE_RUNTIME_CREDENTIAL_INVALID');
  });

  it('rejects forged runtime-reference paths instead of following caller-shaped locations', () => {
    const ref = runtime();
    const forged = { ...ref, credentialPath: join(root, 'elsewhere.json') };
    expect(code(() => readIdeCompanionSecret(forged))).toBe('IDE_RUNTIME_PATH_UNSAFE');
    const forgedSocket = { ...ref, socketPath: join(ref.directory, 'other.sock') };
    expect(code(() => readIdeCompanionSecret(forgedSocket))).toBe('IDE_RUNTIME_PATH_UNSAFE');
  });
});

describe('P7 B4 rotation and revocation', () => {
  it('atomically rotates to a fresh secret and increments generation without leftover temp files', () => {
    const ref = runtime();
    const before = readIdeCompanionSecret(ref);
    expect(rotateIdeCompanionSecret(ref)).toBe(2);
    const after = readIdeCompanionSecret(ref);
    expect(after.secretGeneration).toBe(2);
    expect(after.secret.equals(before.secret)).toBe(false);
    expect(mode(ref.credentialPath)).toBe(IDE_COMPANION_RUNTIME_FILE_MODE);
    expect(readdirSync(ref.directory).sort()).toEqual(['credential.json']);
  });

  it('persists revocation without retaining raw secret material and refuses later secret reads/rotation', () => {
    const ref = runtime();
    const before = readIdeCompanionSecret(ref).secret.toString('base64url');
    expect(revokeIdeCompanionSecret(ref)).toBe(2);
    expect(code(() => readIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_REVOKED');
    expect(code(() => rotateIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_REVOKED');
    expect(revokeIdeCompanionSecret(ref)).toBe(2);
    const raw = readFileSync(ref.credentialPath, 'utf8');
    expect(raw).toContain('"state":"REVOKED"');
    expect(raw).not.toContain('"secret":');
    expect(raw).not.toContain(before);
    expect(mode(ref.credentialPath)).toBe(0o600);
  });

  it('re-reads the credential on every use so external revocation/tamper is not hidden by an in-memory cache', () => {
    const ref = runtime();
    expect(readIdeCompanionSecret(ref).secretGeneration).toBe(1);
    revokeIdeCompanionSecret(ref);
    expect(code(() => readIdeCompanionSecret(ref))).toBe('IDE_RUNTIME_CREDENTIAL_REVOKED');
  });
});

describe('P7 B4 socket-path confinement without a product listener', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('refuses missing, regular-file and symlink endpoints', () => {
    const missing = runtime();
    expect(code(() => hardenAndVerifyIdeCompanionSocket(missing))).toBe('IDE_RUNTIME_SOCKET_INVALID');

    const regular = runtime();
    writeFileSync(regular.socketPath, 'not-a-socket', { mode: 0o600 });
    expect(code(() => hardenAndVerifyIdeCompanionSocket(regular))).toBe('IDE_RUNTIME_SOCKET_INVALID');

    const linked = runtime();
    const target = join(linked.directory, 'socket-target');
    writeFileSync(target, 'x', { mode: 0o600 });
    symlinkSync(target, linked.socketPath);
    expect(code(() => hardenAndVerifyIdeCompanionSocket(linked))).toBe('IDE_RUNTIME_SOCKET_INVALID');
  });

  it('hardens a test-only owner Unix socket to exact 0600 without creating a product listener', async () => {
    const ref = runtime();
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(ref.socketPath, () => { server!.off('error', reject); resolve(); });
    });
    chmodSync(ref.socketPath, 0o666);
    hardenAndVerifyIdeCompanionSocket(ref);
    expect(mode(ref.socketPath)).toBe(0o600);
  });
});
