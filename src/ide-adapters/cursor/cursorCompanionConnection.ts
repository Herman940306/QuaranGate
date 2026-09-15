/**
 * I3 Cursor companion B6 client handshake.
 *
 * This module can make an enrolled Cursor workspace AVAILABLE. It deliberately
 * sends no controller/operation frame and exposes no review/implementation
 * start method. Later I2 slices may add QuaranGate-originated command delivery
 * without giving the extension ambient operation authority.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import {
  hashIdeCompanionWorkspaceAttestation,
  serializeIdeCompanionAttest,
  serializeIdeCompanionHello,
  signIdeCompanionAttestFrame,
  type IdeCompanionHelloFrame,
  IDE_COMPANION_HANDSHAKE_MAX_LIFETIME_MS,
} from '../../shared/ideCompanionHandshake.js';
import { serializeIdeWorkspaceAttestation, type IdeWorkspacePhysicalIdentity } from '../../shared/ideWorkspaceAttestation.js';
import { type CursorCompanionCredential } from './cursorCompanionCredential.js';

export const CURSOR_COMPANION_CONNECT_TIMEOUT_MS = 20_000;
export const CURSOR_COMPANION_SERVER_FRAME_MAX_BYTES = 32 * 1024;

export type CursorCompanionConnectionErrorCode =
  | 'CURSOR_CONNECTION_FAILED'
  | 'CURSOR_CONNECTION_TIMEOUT'
  | 'CURSOR_CONNECTION_FRAME_INVALID'
  | 'CURSOR_CONNECTION_BINDING_MISMATCH';

export class CursorCompanionConnectionError extends Error {
  constructor(public readonly code: CursorCompanionConnectionErrorCode, message: string) {
    super(message);
    this.name = 'CursorCompanionConnectionError';
  }
}

export interface CursorCompanionConnection {
  sessionId: string;
  connectionGeneration: number;
  socket: Socket;
  close(): void;
}

export interface ConnectCursorCompanionInput {
  credential: CursorCompanionCredential;
  workspace: IdeWorkspacePhysicalIdentity;
  nowMs?: () => number;
  randomBytes?: (size: number) => Buffer;
  timeoutMs?: number;
}

function fail(code: CursorCompanionConnectionErrorCode, message: string): never {
  throw new CursorCompanionConnectionError(code, message);
}

function opaqueSessionId(bytes: Buffer): string {
  if (bytes.byteLength !== 16) fail('CURSOR_CONNECTION_FAILED', 'session identity source returned an invalid length');
  return `ides_${bytes.toString('hex')}`;
}

function canonicalNonce(bytes: Buffer): string {
  if (bytes.byteLength !== 32) fail('CURSOR_CONNECTION_FAILED', 'nonce source returned an invalid length');
  return bytes.toString('base64url');
}

function assertTrustedSocketEndpoint(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) fail('CURSOR_CONNECTION_FAILED', 'companion connection requires Unix user identity');
  let info;
  try { info = lstatSync(path); } catch { fail('CURSOR_CONNECTION_FAILED', 'companion socket endpoint is unavailable'); }
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o600) {
    fail('CURSOR_CONNECTION_FAILED', 'companion socket endpoint ownership/type/mode is unsafe');
  }
}

async function openSocket(path: string, timeoutMs: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_TIMEOUT', 'companion socket connect timed out'));
    }, timeoutMs);
    const cleanup = (): void => { clearTimeout(timer); socket.off('error', onError); socket.off('connect', onConnect); };
    const onError = (): void => { cleanup(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_FAILED', 'companion socket connection failed')); };
    const onConnect = (): void => { cleanup(); resolve(socket); };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

async function readFrame(socket: Socket, timeoutMs: number): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_TIMEOUT', 'companion server frame timed out')); }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (): void => { cleanup(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_FAILED', 'companion socket failed while reading')); };
    const onClose = (): void => { cleanup(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_FAILED', 'companion socket closed before handshake completed')); };
    const onData = (chunk: Buffer): void => {
      if (buffer.byteLength + chunk.byteLength > CURSOR_COMPANION_SERVER_FRAME_MAX_BYTES + 1) {
        cleanup(); socket.destroy(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_FRAME_INVALID', 'companion server frame exceeded bound')); return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (buffer.subarray(newline + 1).length !== 0) {
        cleanup(); socket.destroy(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_FRAME_INVALID', 'companion server pipelined handshake frames')); return;
      }
      let body: string;
      try { body = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline)); }
      catch { cleanup(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_FRAME_INVALID', 'companion server frame is not valid UTF-8')); return; }
      let value: unknown;
      try { value = JSON.parse(body) as unknown; } catch { cleanup(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_FRAME_INVALID', 'companion server frame is invalid JSON')); return; }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        cleanup(); reject(new CursorCompanionConnectionError('CURSOR_CONNECTION_FRAME_INVALID', 'companion server frame is not an object')); return;
      }
      cleanup(); resolve(value as Record<string, unknown>);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const got = Object.keys(value).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((key, index) => key !== want[index])) {
    fail('CURSOR_CONNECTION_FRAME_INVALID', 'companion server frame fields are invalid');
  }
}

function parseChallenge(value: Record<string, unknown>, sessionId: string): { connectionGeneration: number; serverChallenge: string; expiresAtMs: number } {
  exactKeys(value, ['version', 'type', 'sessionId', 'connectionGeneration', 'serverChallenge', 'expiresAtMs']);
  if (value.version !== 1 || value.type !== 'challenge' || value.sessionId !== sessionId
    || !Number.isSafeInteger(value.connectionGeneration) || (value.connectionGeneration as number) < 1
    || typeof value.serverChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.serverChallenge)
    || !Number.isSafeInteger(value.expiresAtMs) || (value.expiresAtMs as number) < 1) {
    fail('CURSOR_CONNECTION_FRAME_INVALID', 'companion challenge frame is invalid');
  }
  const challengeBytes = Buffer.from(value.serverChallenge as string, 'base64url');
  if (challengeBytes.byteLength !== 32 || challengeBytes.toString('base64url') !== value.serverChallenge) {
    fail('CURSOR_CONNECTION_FRAME_INVALID', 'companion challenge is not canonical 256-bit base64url');
  }
  return {
    connectionGeneration: value.connectionGeneration as number,
    serverChallenge: value.serverChallenge,
    expiresAtMs: value.expiresAtMs as number,
  };
}

function parseReady(value: Record<string, unknown>, sessionId: string, generation: number): void {
  exactKeys(value, ['version', 'type', 'sessionId', 'connectionGeneration']);
  if (value.version !== 1 || value.type !== 'ready' || value.sessionId !== sessionId || value.connectionGeneration !== generation) {
    fail('CURSOR_CONNECTION_BINDING_MISMATCH', 'companion ready frame does not match challenged session/generation');
  }
}

export async function connectCursorCompanion(input: ConnectCursorCompanionInput): Promise<CursorCompanionConnection> {
  const rng = input.randomBytes ?? randomBytes;
  const timeoutMs = input.timeoutMs ?? CURSOR_COMPANION_CONNECT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CURSOR_COMPANION_CONNECT_TIMEOUT_MS) {
    fail('CURSOR_CONNECTION_FAILED', 'companion connection timeout bound is invalid');
  }
  const sessionId = opaqueSessionId(rng(16));
  const clientNonce = canonicalNonce(rng(32));
  const hello: IdeCompanionHelloFrame = {
    version: 1,
    type: 'hello',
    enrollmentId: input.credential.enrollmentId,
    ideInstanceId: input.credential.ideInstanceId,
    runtimeInstanceId: input.credential.runtimeInstanceId,
    adapterId: input.credential.adapterId,
    adapterVersion: input.credential.adapterVersion,
    sessionId,
    clientNonce,
  };

  assertTrustedSocketEndpoint(input.credential.socketPath);
  const socket = await openSocket(input.credential.socketPath, timeoutMs);
  try {
    socket.write(`${serializeIdeCompanionHello(hello)}\n`, 'utf8');
    const challenge = parseChallenge(await readFrame(socket, timeoutMs), sessionId);
    const workspaceAttestation = serializeIdeWorkspaceAttestation({
      version: 1,
      enrollmentId: input.credential.enrollmentId,
      ideInstanceId: input.credential.ideInstanceId,
      runtimeInstanceId: input.credential.runtimeInstanceId,
      ideProduct: 'cursor',
      adapterId: input.credential.adapterId,
      adapterVersion: input.credential.adapterVersion,
      sessionId,
      connectionGeneration: challenge.connectionGeneration,
      workspace: input.workspace,
    });
    const now = (input.nowMs ?? (() => Date.now()))();
    if (!Number.isSafeInteger(now) || now < 0 || challenge.expiresAtMs <= now
      || challenge.expiresAtMs - now > IDE_COMPANION_HANDSHAKE_MAX_LIFETIME_MS) {
      fail('CURSOR_CONNECTION_FRAME_INVALID', 'companion challenge time window is invalid');
    }
    const attest = signIdeCompanionAttestFrame(input.credential.secret, {
      version: 1,
      type: 'attest',
      enrollmentId: input.credential.enrollmentId,
      ideInstanceId: input.credential.ideInstanceId,
      runtimeInstanceId: input.credential.runtimeInstanceId,
      adapterId: input.credential.adapterId,
      adapterVersion: input.credential.adapterVersion,
      sessionId,
      connectionGeneration: challenge.connectionGeneration,
      clientNonce,
      serverChallenge: challenge.serverChallenge,
      issuedAtMs: now,
      expiresAtMs: challenge.expiresAtMs,
      payloadSha256: hashIdeCompanionWorkspaceAttestation(workspaceAttestation),
      workspaceAttestation,
    });
    socket.write(`${serializeIdeCompanionAttest(attest)}\n`, 'utf8');
    parseReady(await readFrame(socket, timeoutMs), sessionId, challenge.connectionGeneration);
    return {
      sessionId,
      connectionGeneration: challenge.connectionGeneration,
      socket,
      close: () => socket.destroy(),
    };
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    input.credential.secret.fill(0);
  }
}
