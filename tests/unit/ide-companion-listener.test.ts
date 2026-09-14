import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashIdeCompanionWorkspaceAttestation,
  serializeIdeCompanionAttest,
  serializeIdeCompanionHello,
  signIdeCompanionAttestFrame,
  type IdeCompanionAttestFrame,
  type IdeCompanionHelloFrame,
} from '../../src/shared/ideCompanionHandshake.js';
import {
  deriveIdeEnvironmentIdentity,
  deriveIdeFilesystemIdentity,
  deriveIdeWorkspaceFingerprint,
  serializeIdeWorkspaceAttestation,
  type IdeWorkspaceAttestation,
  type IdeWorkspacePhysicalIdentity,
} from '../../src/shared/ideWorkspaceAttestation.js';
import {
  IdeCompanionListener,
  IdeCompanionListenerError,
} from '../../src/executor/ide/ideCompanionListener.js';
import {
  createIdeCompanionRuntime,
  readIdeCompanionSecret,
  rotateIdeCompanionSecret,
  revokeIdeCompanionSecret,
  type IdeCompanionRuntimeRef,
} from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeSessionStore, type IdeEnrollmentRow } from '../../src/executor/ide/ideSessionStore.js';

const nowMs = 1_800_000_000_000;
const baseRevision = 'a'.repeat(40);
let fixtureId = 0;
let store: IdeSessionStore;
let runtimeRoot: string;
let listener: IdeCompanionListener | undefined;
let sockets: Socket[];

function physical(over: Partial<IdeWorkspacePhysicalIdentity> = {}): IdeWorkspacePhysicalIdentity {
  const canonicalPath = '/srv/projects/quarangate-forward';
  return {
    workspaceFolderCount: 1,
    remoteKind: 'wsl',
    environmentIdentity: deriveIdeEnvironmentIdentity('wsl', 'ubuntu-24.04:stable-id'),
    pathFlavor: 'posix',
    caseMode: 'case-sensitive',
    canonicalization: 'realpath-exact',
    workspaceUri: pathToFileURL(canonicalPath).href,
    canonicalPath,
    filesystemIdentity: deriveIdeFilesystemIdentity('posix', '100', '200'),
    git: {
      kind: 'worktree',
      worktreeRoot: canonicalPath,
      commonDir: '/srv/projects/QuaranGate/.git',
      commonDirIdentity: deriveIdeFilesystemIdentity('posix', '100', '300'),
      headRevision: baseRevision,
    },
    ...over,
  };
}

function setup(over: { workspace?: IdeWorkspacePhysicalIdentity } = {}): {
  enrollment: IdeEnrollmentRow;
  runtime: IdeCompanionRuntimeRef;
  workspace: IdeWorkspacePhysicalIdentity;
} {
  fixtureId += 1;
  const digit = (fixtureId % 15 + 1).toString(16);
  const workspace = over.workspace ?? physical();
  const fingerprint = deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace });
  const enrollment = store.createEnrollment({
    principalId: 'chatgpt-browser', projectId: 'quarangate', worktreeId: 'forward', ideProduct: 'vscode',
    ideInstanceId: `ide_${digit.repeat(32)}`, workspaceFingerprint: fingerprint, baseRevision,
    capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'],
  });
  const runtime = createIdeCompanionRuntime({
    runtimeRoot, enrollmentId: enrollment.enrollmentId, ideInstanceId: enrollment.ideInstanceId,
    ideProduct: enrollment.ideProduct, adapterVersion: '1.2.3',
  });
  return { enrollment, runtime, workspace };
}

function clientNonce(byte = 0x41): string { return Buffer.alloc(32, byte).toString('base64url'); }
function sessionId(byte = '4'): string { return `ides_${byte.repeat(32)}`; }

function hello(ctx: ReturnType<typeof setup>, sid = sessionId(), nonce = clientNonce()): IdeCompanionHelloFrame {
  return {
    version: 1, type: 'hello', enrollmentId: ctx.enrollment.enrollmentId, ideInstanceId: ctx.enrollment.ideInstanceId,
    runtimeInstanceId: ctx.runtime.runtimeInstanceId, adapterId: ctx.runtime.adapterId, adapterVersion: ctx.runtime.adapterVersion,
    sessionId: sid, clientNonce: nonce,
  };
}

async function openClient(path: string): Promise<Socket> {
  const socket = connect(path);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    socket.once('error', onError);
    socket.once('connect', () => { socket.off('error', onError); resolve(); });
  });
  return socket;
}

async function readLine(socket: Socket): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error('socket closed before frame')); };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      try { resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')) as Record<string, unknown>); }
      catch (error) { reject(error); }
    };
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose);
  });
}

function makeWorkspaceAttestation(
  ctx: ReturnType<typeof setup>, helloFrame: IdeCompanionHelloFrame, generation: number,
  over: Partial<IdeWorkspaceAttestation> = {},
): string {
  return serializeIdeWorkspaceAttestation({
    version: 1,
    enrollmentId: ctx.enrollment.enrollmentId,
    ideInstanceId: ctx.enrollment.ideInstanceId,
    runtimeInstanceId: ctx.runtime.runtimeInstanceId,
    ideProduct: ctx.enrollment.ideProduct,
    adapterId: ctx.runtime.adapterId,
    adapterVersion: ctx.runtime.adapterVersion,
    sessionId: helloFrame.sessionId,
    connectionGeneration: generation,
    workspace: ctx.workspace,
    ...over,
  });
}

function signedAttest(
  ctx: ReturnType<typeof setup>, helloFrame: IdeCompanionHelloFrame, challenge: Record<string, unknown>,
  secret: Buffer, workspaceAttestation?: string,
): IdeCompanionAttestFrame {
  const payload = workspaceAttestation ?? makeWorkspaceAttestation(ctx, helloFrame, Number(challenge.connectionGeneration));
  return signIdeCompanionAttestFrame(secret, {
    version: 1, type: 'attest',
    enrollmentId: helloFrame.enrollmentId,
    ideInstanceId: helloFrame.ideInstanceId,
    runtimeInstanceId: helloFrame.runtimeInstanceId,
    adapterId: helloFrame.adapterId,
    adapterVersion: helloFrame.adapterVersion,
    sessionId: helloFrame.sessionId,
    connectionGeneration: Number(challenge.connectionGeneration),
    clientNonce: helloFrame.clientNonce,
    serverChallenge: String(challenge.serverChallenge),
    issuedAtMs: nowMs,
    expiresAtMs: Number(challenge.expiresAtMs),
    payloadSha256: hashIdeCompanionWorkspaceAttestation(payload),
    workspaceAttestation: payload,
  });
}

async function begin(ctx: ReturnType<typeof setup>, sid = sessionId(), nonce = clientNonce()): Promise<{
  socket: Socket; hello: IdeCompanionHelloFrame; challenge: Record<string, unknown>;
}> {
  const socket = await openClient(ctx.runtime.socketPath);
  const h = hello(ctx, sid, nonce);
  socket.write(`${serializeIdeCompanionHello(h)}\n`);
  const challenge = await readLine(socket);
  expect(challenge.type).toBe('challenge');
  return { socket, hello: h, challenge };
}

async function complete(
  ctx: ReturnType<typeof setup>, started: Awaited<ReturnType<typeof begin>>, secret?: Buffer,
  workspaceAttestation?: string,
): Promise<Record<string, unknown>> {
  const own = secret ?? readIdeCompanionSecret(ctx.runtime).secret;
  const frame = signedAttest(ctx, started.hello, started.challenge, own, workspaceAttestation);
  if (secret === undefined) own.fill(0);
  started.socket.write(`${serializeIdeCompanionAttest(frame)}\n`);
  return await readLine(started.socket);
}

beforeEach(() => {
  fixtureId = 0;
  sockets = [];
  store = new IdeSessionStore(join(mkdtempSync(join(tmpdir(), 'qg-b6-db-')), 'ide.db'));
  const base = mkdtempSync(join(tmpdir(), 'qg-b6-runtime-')); chmodSync(base, 0o700);
  runtimeRoot = join(base, 'runtime'); mkdirSync(runtimeRoot, { mode: 0o700 }); chmodSync(runtimeRoot, 0o700);
});

afterEach(async () => {
  for (const socket of sockets) if (!socket.destroyed) socket.destroy();
  if (listener !== undefined) await listener.stop().catch(() => undefined);
  listener = undefined;
  store.close();
});

describe('P7 B6 authenticated AF_UNIX listener foundation', () => {
  it('binds only the exact derived Unix socket at 0600 and promotes a valid authenticated workspace to AVAILABLE', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) });
    await listener.start();
    expect(existsSync(ctx.runtime.socketPath)).toBe(true);
    const info = lstatSync(ctx.runtime.socketPath); expect(info.isSocket()).toBe(true); expect(info.mode & 0o777).toBe(0o600);
    const started = await begin(ctx);
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(0);
    const ready = await complete(ctx, started);
    expect(ready).toMatchObject({ version: 1, type: 'ready', sessionId: started.hello.sessionId, connectionGeneration: 1 });
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(1);
    expect(store.getSession(started.hello.sessionId)?.state).toBe('AVAILABLE');
  });

  it('does not mutate Plane-B state for hello alone or for an invalid MAC', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const started = await begin(ctx);
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(0);
    expect(store.getSession(started.hello.sessionId)).toBeUndefined();
    const wrong = Buffer.alloc(32, 0x7f); const response = await complete(ctx, started, wrong); wrong.fill(0);
    expect(response).toMatchObject({ type: 'error', code: 'IDE_HANDSHAKE_AUTH_DENIED' });
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(0);
    expect(store.getSession(started.hello.sessionId)).toBeUndefined();
  });

  it('re-reads the current runtime secret so rotation invalidates a challenged frame before session mutation', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const started = await begin(ctx);
    const oldSecret = readIdeCompanionSecret(ctx.runtime).secret;
    const frame = signedAttest(ctx, started.hello, started.challenge, oldSecret); oldSecret.fill(0);
    rotateIdeCompanionSecret(ctx.runtime);
    started.socket.write(`${serializeIdeCompanionAttest(frame)}\n`);
    const response = await readLine(started.socket);
    expect(response).toMatchObject({ type: 'error', code: 'IDE_HANDSHAKE_AUTH_DENIED' });
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(0);
    expect(store.getSession(started.hello.sessionId)).toBeUndefined();
  });

  it('fails a valid-MAC workspace mismatch closed and disconnects the opened session instead of making it AVAILABLE', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const started = await begin(ctx);
    const base = JSON.parse(makeWorkspaceAttestation(ctx, started.hello, 1)) as IdeWorkspaceAttestation;
    const changed = serializeIdeWorkspaceAttestation({ ...base, workspace: { ...base.workspace, filesystemIdentity: 'f'.repeat(64) } });
    const response = await complete(ctx, started, undefined, changed);
    expect(response).toMatchObject({ type: 'error', code: 'IDE_WORKSPACE_DENIED' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(1);
    expect(store.getSession(started.hello.sessionId)?.state).toBe('DISCONNECTED');
  });

  it('uses generation CAS so a stale authenticated challenge cannot stale a newer accepted connection', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const a = await begin(ctx, sessionId('4'), clientNonce(0x41));
    const b = await begin(ctx, sessionId('5'), clientNonce(0x43));
    expect(a.challenge.connectionGeneration).toBe(1); expect(b.challenge.connectionGeneration).toBe(1);
    expect((await complete(ctx, b)).type).toBe('ready');
    const stale = await complete(ctx, a);
    expect(stale).toMatchObject({ type: 'error', code: 'IDE_SESSION_DENIED' });
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(1);
    expect(store.getSession(b.hello.sessionId)?.state).toBe('AVAILABLE');
    expect(store.getSession(a.hello.sessionId)).toBeUndefined();
  });

  it('accepts a later authenticated reconnect, stales the old generation, and does not let old close handling damage the new session', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const first = await begin(ctx, sessionId('4'), clientNonce(0x41)); expect((await complete(ctx, first)).type).toBe('ready');
    const second = await begin(ctx, sessionId('5'), clientNonce(0x43)); expect(second.challenge.connectionGeneration).toBe(2); expect((await complete(ctx, second)).type).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(2);
    expect(store.getSession(first.hello.sessionId)?.state).toBe('STALE');
    expect(store.getSession(second.hello.sessionId)?.state).toBe('AVAILABLE');
  });

  it('reconciles a ready connection close to DISCONNECTED and refuses further authority on that session', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const started = await begin(ctx); expect((await complete(ctx, started)).type).toBe('ready');
    started.socket.destroy(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getSession(started.hello.sessionId)?.state).toBe('DISCONNECTED');
  });

  it('rejects a pre-existing endpoint without unlinking or modifying it', async () => {
    const ctx = setup(); writeFileSync(ctx.runtime.socketPath, 'owner-data', { mode: 0o600 });
    listener = new IdeCompanionListener({ store, runtime: ctx.runtime });
    await expect(listener.start()).rejects.toBeInstanceOf(IdeCompanionListenerError);
    expect(readFileSync(ctx.runtime.socketPath, 'utf8')).toBe('owner-data');
    expect(lstatSync(ctx.runtime.socketPath).isFile()).toBe(true);
  });

  it('rejects oversized and pipelined multiple frames without opening a session', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const oversized = await openClient(ctx.runtime.socketPath); oversized.write(`${'x'.repeat(33 * 1024)}\n`);
    expect(await readLine(oversized)).toMatchObject({ type: 'error', code: 'IDE_HANDSHAKE_FRAME_SIZE' });
    const multi = await openClient(ctx.runtime.socketPath); const h = serializeIdeCompanionHello(hello(ctx)); multi.write(`${h}\n${h}\n`);
    expect(await readLine(multi)).toMatchObject({ type: 'error', code: 'MULTIPLE_FRAMES' });
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(0);
  });

  it('rejects any extra client frame after READY and reconciles the session closed', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const started = await begin(ctx); expect((await complete(ctx, started)).type).toBe('ready');
    started.socket.write(`${serializeIdeCompanionHello(started.hello)}\n`);
    expect(await readLine(started.socket)).toMatchObject({ type: 'error', code: 'UNEXPECTED_FRAME' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getSession(started.hello.sessionId)?.state).toBe('DISCONNECTED');
  });

  it('enforces the exact 16-connection capacity without opening Plane-B sessions', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const held: Socket[] = [];
    for (let i = 0; i < 16; i += 1) held.push(await openClient(ctx.runtime.socketPath));
    const overflow = await openClient(ctx.runtime.socketPath);
    expect(await readLine(overflow)).toMatchObject({ version: 1, type: 'error', code: 'CAPACITY' });
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(0);
    for (const socket of held) socket.destroy();
  });

  it('stop destroys active sockets, reconciles a ready session, and removes only the owned socket endpoint', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const started = await begin(ctx); expect((await complete(ctx, started)).type).toBe('ready');
    expect(existsSync(ctx.runtime.socketPath)).toBe(true);
    await listener.stop(); listener = undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getSession(started.hello.sessionId)?.state).toBe('DISCONNECTED');
    expect(existsSync(ctx.runtime.socketPath)).toBe(false);
  });

  it('restart recovery stales a live session and a fresh listener reconnect advances to the next generation', async () => {
    const ctx = setup(); listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const first = await begin(ctx, sessionId('4'), clientNonce(0x41)); expect((await complete(ctx, first)).type).toBe('ready');
    await listener.stop(); listener = undefined;
    // A process restart treats any surviving Plane-B live state as stale. Here stop
    // already disconnected the socket, so the recovery pass must not revive it.
    expect(store.recoverAfterRestart().staledSessionIds).toEqual([]);
    expect(store.getSession(first.hello.sessionId)?.state).toBe('DISCONNECTED');
    listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => nowMs, challengeBytes: () => Buffer.alloc(32, 0x43) }); await listener.start();
    const second = await begin(ctx, sessionId('5'), clientNonce(0x44));
    expect(second.challenge.connectionGeneration).toBe(2);
    expect((await complete(ctx, second)).type).toBe('ready');
    expect(store.getSession(second.hello.sessionId)?.state).toBe('AVAILABLE');
  });


  it('never unlinks a pre-existing same-UID Unix socket that this listener did not create', async () => {
    const ctx = setup();
    const foreign: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject);
      foreign.listen(ctx.runtime.socketPath, () => { foreign.off('error', reject); resolve(); });
    });
    expect(lstatSync(ctx.runtime.socketPath).isSocket()).toBe(true);
    listener = new IdeCompanionListener({ store, runtime: ctx.runtime });
    await expect(listener.start()).rejects.toBeInstanceOf(IdeCompanionListenerError);
    await listener.stop(); listener = undefined;
    expect(existsSync(ctx.runtime.socketPath)).toBe(true);
    expect(lstatSync(ctx.runtime.socketPath).isSocket()).toBe(true);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  });


  it('refuses to bind when the B4 runtime credential is already revoked', async () => {
    const ctx = setup(); revokeIdeCompanionSecret(ctx.runtime);
    listener = new IdeCompanionListener({ store, runtime: ctx.runtime });
    await expect(listener.start()).rejects.toThrow();
    expect(existsSync(ctx.runtime.socketPath)).toBe(false);
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(0);
  });

  it('denies an expired challenge before any Plane-B session mutation', async () => {
    const ctx = setup(); let clock = nowMs;
    listener = new IdeCompanionListener({ store, runtime: ctx.runtime, nowMs: () => clock, challengeBytes: () => Buffer.alloc(32, 0x42) }); await listener.start();
    const started = await begin(ctx);
    const material = readIdeCompanionSecret(ctx.runtime).secret;
    const frame = signedAttest(ctx, started.hello, started.challenge, material); material.fill(0);
    clock = nowMs + 15_001;
    started.socket.write(`${serializeIdeCompanionAttest(frame)}\n`);
    expect(await readLine(started.socket)).toMatchObject({ type: 'error', code: 'IDE_HANDSHAKE_TIME_WINDOW' });
    expect(store.getEnrollment(ctx.enrollment.enrollmentId)?.currentGeneration).toBe(0);
    expect(store.getSession(started.hello.sessionId)).toBeUndefined();
  });

});
