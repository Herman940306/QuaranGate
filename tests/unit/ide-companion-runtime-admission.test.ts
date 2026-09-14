import { chmodSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { admitIdeCompanionRuntimeRequest } from '../../src/executor/ide/ideCompanionRuntimeAdmission.js';
import {
  IdeCompanionRuntimeError,
  createIdeCompanionRuntime,
  readIdeCompanionSecret,
  revokeIdeCompanionSecret,
  rotateIdeCompanionSecret,
  type IdeCompanionRuntimeRef,
} from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeRegistryStoreError, IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';
import {
  IdeCompanionAuthError,
  hashIdeCompanionPayload,
  signIdeCompanionEnvelope,
  type IdeCompanionAuthEnvelope,
} from '../../src/shared/ideCompanionAuth.js';
import { IdeSessionContractError } from '../../src/shared/ideSessions.js';

const payload = Buffer.from('bounded runtime review payload', 'utf8');
const nowMs = 1_800_000_000_000;
let store: IdeSessionStore;
let runtimeRoot: string;

function errorCode(fn: () => unknown): string {
  try { fn(); return 'NO_ERROR'; } catch (error) {
    if (error instanceof IdeCompanionRuntimeError
      || error instanceof IdeCompanionAuthError
      || error instanceof IdeRegistryStoreError
      || error instanceof IdeSessionContractError) return error.code;
    return 'OTHER_ERROR';
  }
}

function setup(instanceHex = '1') {
  const e = store.createEnrollment({
    principalId: 'chatgpt-browser', projectId: 'quarangate', worktreeId: 'forward', ideProduct: 'vscode',
    ideInstanceId: `ide_${instanceHex.repeat(32)}`, workspaceFingerprint: 'a'.repeat(64), baseRevision: 'b'.repeat(40),
    capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'],
  });
  const s = store.openSession({
    enrollmentId: e.enrollmentId, principalId: e.principalId, projectId: e.projectId, worktreeId: e.worktreeId,
    ideProduct: e.ideProduct, ideInstanceId: e.ideInstanceId, workspaceFingerprint: e.workspaceFingerprint,
    baseRevision: e.baseRevision, sessionId: `ides_${instanceHex === '1' ? '2'.repeat(32) : '8'.repeat(32)}`,
  });
  const key = {
    principalId: e.principalId, projectId: e.projectId, worktreeId: e.worktreeId, ideProduct: e.ideProduct,
    ideInstanceId: e.ideInstanceId, workspaceFingerprint: e.workspaceFingerprint, baseRevision: e.baseRevision,
    sessionId: s.sessionId, connectionGeneration: s.connectionGeneration,
  } as const;
  store.markAvailable(key);
  const lease = store.acquireController(key);
  const runtime = createIdeCompanionRuntime({
    runtimeRoot,
    enrollmentId: e.enrollmentId,
    ideInstanceId: e.ideInstanceId,
    ideProduct: e.ideProduct,
    adapterVersion: '1.2.3',
  });
  return { e, s, key, lease, runtime };
}

function signed(
  ctx: ReturnType<typeof setup>,
  secret: Buffer,
  nonce = 'R'.repeat(43),
  operationId = `ideo_${'3'.repeat(32)}`,
): IdeCompanionAuthEnvelope {
  return signIdeCompanionEnvelope(secret, {
    version: 1,
    enrollmentId: ctx.e.enrollmentId,
    ideInstanceId: ctx.e.ideInstanceId,
    sessionId: ctx.s.sessionId,
    connectionGeneration: ctx.s.connectionGeneration,
    controllerLeaseId: ctx.lease,
    operationId,
    capability: 'request_review',
    nonce,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 20_000,
    payloadSha256: hashIdeCompanionPayload(payload),
  });
}

beforeEach(() => {
  store = new IdeSessionStore(join(mkdtempSync(join(tmpdir(), 'qg-ide-runtime-admit-db-')), 'ide.db'));
  const base = mkdtempSync(join(tmpdir(), 'qg-ide-runtime-admit-'));
  chmodSync(base, 0o700);
  runtimeRoot = join(base, 'runtime');
  mkdirSync(runtimeRoot, { mode: 0o700 }); chmodSync(runtimeRoot, 0o700);
});

describe('P7 B4 trusted runtime admission', () => {
  it('admits through a freshly read runtime secret and returns no secret/runtime path metadata', () => {
    const ctx = setup();
    const secret = readIdeCompanionSecret(ctx.runtime).secret;
    const admitted = admitIdeCompanionRuntimeRequest({
      store, runtime: ctx.runtime, envelope: signed(ctx, secret), payload, nowMs,
    });
    expect(admitted.enrollmentId).toBe(ctx.e.enrollmentId);
    expect(Object.keys(admitted)).not.toContain('secret');
    expect(Object.keys(admitted)).not.toContain('runtimeRoot');
    expect(Object.keys(admitted)).not.toContain('socketPath');
  });

  it('rejects an old signed frame immediately after rotation without consuming its replay nonce', () => {
    const ctx = setup();
    const oldSecret = readIdeCompanionSecret(ctx.runtime).secret;
    const oldEnvelope = signed(ctx, oldSecret);
    expect(rotateIdeCompanionSecret(ctx.runtime)).toBe(2);
    expect(errorCode(() => admitIdeCompanionRuntimeRequest({
      store, runtime: ctx.runtime, envelope: oldEnvelope, payload, nowMs,
    }))).toBe('IDE_COMPANION_AUTH_DENIED');

    const freshSecret = readIdeCompanionSecret(ctx.runtime).secret;
    const freshEnvelope = signed(ctx, freshSecret); // same nonce: failed old MAC did not consume it
    expect(() => admitIdeCompanionRuntimeRequest({
      store, runtime: ctx.runtime, envelope: freshEnvelope, payload, nowMs,
    })).not.toThrow();
  });

  it('rejects admission after persistent revocation before B3 replay/authority can run', () => {
    const ctx = setup();
    const secret = readIdeCompanionSecret(ctx.runtime).secret;
    const envelope = signed(ctx, secret);
    revokeIdeCompanionSecret(ctx.runtime);
    expect(errorCode(() => admitIdeCompanionRuntimeRequest({
      store, runtime: ctx.runtime, envelope, payload, nowMs,
    }))).toBe('IDE_RUNTIME_CREDENTIAL_REVOKED');
  });

  it('prevents one runtime secret from authenticating a different enrollment/IDE instance', () => {
    const a = setup('1');
    const b = setup('9');
    const aSecret = readIdeCompanionSecret(a.runtime).secret;
    const forgedForB = signed(b, aSecret, 'S'.repeat(43), `ideo_${'4'.repeat(32)}`);
    expect(errorCode(() => admitIdeCompanionRuntimeRequest({
      store, runtime: a.runtime, envelope: forgedForB, payload, nowMs,
    }))).toBe('IDE_RUNTIME_BINDING_MISMATCH');
  });

  it('fails closed if a runtime reference is forged even when the frame MAC is otherwise valid', () => {
    const ctx = setup();
    const secret = readIdeCompanionSecret(ctx.runtime).secret;
    const envelope = signed(ctx, secret);
    const forged = { ...ctx.runtime, credentialPath: join(runtimeRoot, 'forged.json') } as IdeCompanionRuntimeRef;
    expect(errorCode(() => admitIdeCompanionRuntimeRequest({
      store, runtime: forged, envelope, payload, nowMs,
    }))).toBe('IDE_RUNTIME_PATH_UNSAFE');
  });
});
