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
import { hashIdeCompanionPayload, signIdeCompanionEnvelope } from '../../src/shared/ideCompanionAuth.js';
import { serializeIdeCompanionImplementationPayload, serializeIdeCompanionOperationControlFrame, serializeIdeCompanionReviewPayload } from '../../src/shared/ideCompanionOperations.js';
import type { IdeReviewOperationAdapter } from '../../src/executor/ide/ideOperationCoordinator.js';
import type { IdeImplementationOperationAdapter } from '../../src/executor/ide/ideImplementationCoordinator.js';
import { admitIdeImplementation } from '../../src/executor/ide/ideImplementationAdmission.js';
import { BridgeError } from '../../src/shared/errors.js';
import { AgentJobStore, type NewAgentJob } from '../../src/executor/agents/jobStore.js';
import { AGENT_RETENTION_DURATION_MS } from '../../src/shared/agents.js';
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
let dbPath: string;
let runtimeRoot: string;
let listener: IdeCompanionListener | undefined;
let sockets: Socket[];
let writerStores: AgentJobStore[];
let jobSeq = 0;

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

function setup(over: { workspace?: IdeWorkspacePhysicalIdentity; capabilities?: IdeEnrollmentRow['capabilities'] } = {}): {
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
    capabilities: over.capabilities ?? ['prompt', 'cancel', 'observe_response', 'request_review'],
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


function signedOperationAuth(
  ctx: ReturnType<typeof setup>, sessionIdValue: string, generation: number, leaseId: string,
  operationId: string, capability: 'request_review'|'request_implementation'|'cancel', payload: string, nonceByte: number,
) {
  const material=readIdeCompanionSecret(ctx.runtime).secret;
  try {
    return signIdeCompanionEnvelope(material,{
      version:1,enrollmentId:ctx.enrollment.enrollmentId,ideInstanceId:ctx.enrollment.ideInstanceId,
      sessionId:sessionIdValue,connectionGeneration:generation,controllerLeaseId:leaseId,operationId,capability,
      nonce:Buffer.alloc(32,nonceByte).toString('base64url'),issuedAtMs:nowMs,expiresAtMs:nowMs+20_000,
      payloadSha256:hashIdeCompanionPayload(payload),
    });
  } finally { material.fill(0); }
}

async function readLines(socket: Socket, count: number): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve,reject)=>{
    let buffer=Buffer.alloc(0); const lines:Array<Record<string,unknown>>=[];
    const cleanup=():void=>{socket.off('data',onData);socket.off('error',onError);socket.off('close',onClose);};
    const onError=(error:Error):void=>{cleanup();reject(error);};
    const onClose=():void=>{if(lines.length>=count){cleanup();resolve(lines);}else{cleanup();reject(new Error(`socket closed after ${lines.length}/${count} frames`));}};
    const onData=(chunk:Buffer):void=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(true){const newline=buffer.indexOf(0x0a);if(newline<0)break;const raw=buffer.subarray(0,newline);buffer=buffer.subarray(newline+1);try{lines.push(JSON.parse(raw.toString('utf8')) as Record<string,unknown>);}catch(error){cleanup();reject(error);return;}if(lines.length>=count){cleanup();resolve(lines);return;}}
    };
    socket.on('data',onData);socket.once('error',onError);socket.once('close',onClose);
  });
}

async function readyController(
  ctx: ReturnType<typeof setup>, adapter: IdeReviewOperationAdapter, operationMaxRuntimeMs?: number,
): Promise<{socket:Socket;sessionId:string;generation:number;leaseId:string}> {
  listener=new IdeCompanionListener({store,runtime:ctx.runtime,operationAdapter:adapter,operationMaxRuntimeMs,nowMs:()=>nowMs,challengeBytes:()=>Buffer.alloc(32,0x42)});
  await listener.start();
  const started=await begin(ctx); const ready=await complete(ctx,started); expect(ready.type).toBe('ready');
  started.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'acquire_controller'})}\n`);
  const acquired=await readLine(started.socket); expect(acquired.type).toBe('controller_acquired');
  return{socket:started.socket,sessionId:started.hello.sessionId,generation:Number(ready.connectionGeneration),leaseId:String(acquired.controllerLeaseId)};
}

async function readyImplementation(
  ctx:ReturnType<typeof setup>, writerStore:AgentJobStore, adapter:IdeImplementationOperationAdapter, implementationMaxRuntimeMs?:number,
):Promise<{socket:Socket;sessionId:string;generation:number;leaseId:string}>{
  listener=new IdeCompanionListener({store,runtime:ctx.runtime,writerStore,implementationAdapter:adapter,implementationMaxRuntimeMs,nowMs:()=>nowMs,challengeBytes:()=>Buffer.alloc(32,0x42)});
  await listener.start();
  const started=await begin(ctx); const ready=await complete(ctx,started); expect(ready.type).toBe('ready');
  started.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'acquire_controller'})}\n`);
  const acquired=await readLine(started.socket); expect(acquired.type).toBe('controller_acquired');
  return{socket:started.socket,sessionId:started.hello.sessionId,generation:Number(ready.connectionGeneration),leaseId:String(acquired.controllerLeaseId)};
}

function newWriterStore():AgentJobStore{
  const value=new AgentJobStore(join(mkdtempSync(join(tmpdir(),'qg-b93-writer-')),'agents.db'));
  writerStores.push(value);return value;
}

function completedWriterJob(writerStore:AgentJobStore,project='quarangate',principalId='chatgpt-browser'){
  jobSeq+=1;const jobId=`job_${jobSeq.toString(16).padStart(32,'0')}`;
  const input:NewAgentJob={jobId,principalId,backend:'kiro',project,profile:'implement',resourcePolicy:'economy',promptHash:'a'.repeat(64),prompt:'x',sessionPolicy:'new',writer:true,retentionClass:'ephemeral',retentionDurationMs:AGENT_RETENTION_DURATION_MS.ephemeral};
  writerStore.insert(input);writerStore.transition(jobId,'QUEUED','PREPARING',{startedAt:new Date().toISOString()});writerStore.transition(jobId,'PREPARING','RUNNING');writerStore.transition(jobId,'RUNNING','VALIDATING');writerStore.transition(jobId,'VALIDATING','COMPLETED',{completedAt:new Date().toISOString()});
  return writerStore.get(jobId)!;
}

function bridgeCode(fn:()=>unknown):string{
  try{fn();throw new Error('expected BridgeError');}catch(error){if(error instanceof BridgeError)return error.code;throw error;}
}

beforeEach(() => {
  fixtureId=0;jobSeq=0;writerStores=[];
  sockets=[];
  dbPath = join(mkdtempSync(join(tmpdir(), 'qg-b6-db-')), 'ide.db');
  store = new IdeSessionStore(dbPath);
  const base = mkdtempSync(join(tmpdir(), 'qg-b6-runtime-')); chmodSync(base, 0o700);
  runtimeRoot = join(base, 'runtime'); mkdirSync(runtimeRoot, { mode: 0o700 }); chmodSync(runtimeRoot, 0o700);
});

afterEach(async () => {
  for (const socket of sockets) if (!socket.destroyed) socket.destroy();
  if (listener !== undefined) await listener.stop().catch(() => undefined);
  listener = undefined;
  store.close();
  for(const writerStore of writerStores)writerStore.close();
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

describe('P7 B7 governed review operations over authenticated AF_UNIX connection',()=>{
  const completingAdapter:IdeReviewOperationAdapter={
    async run(input){
      input.emit('assistant_chunk','SENSITIVE_RESPONSE_B7');
      await Promise.resolve();
      input.emit('status','review-complete');
    },
  };
  const blockingAdapter:IdeReviewOperationAdapter={
    async run(input){
      await new Promise<void>((resolve,reject)=>{
        if(input.signal.aborted){reject(input.signal.reason);return;}
        input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});
      });
    },
  };

  it('acquires one controller, starts authenticated request_review, streams ordered events and persists metadata only',async()=>{
    const ctx=setup(); const connection=await readyController(ctx,completingAdapter);
    const prompt='DO_NOT_PERSIST_PROMPT_B7_7a4f'; const operationId=`ideo_${'6'.repeat(32)}`;
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_review',serializeIdeCompanionReviewPayload(prompt,workspaceAttestation),0x51);
    const framesPromise=readLines(connection.socket,4);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth,prompt,workspaceAttestation})}\n`);
    const frames=await framesPromise;
    const events=frames.map(frame=>frame.event as Record<string,unknown>);
    expect(frames.every(frame=>frame.type==='operation_event')).toBe(true);
    expect(events.map(event=>event.type)).toEqual(['operation_started','assistant_chunk','status','completed']);
    expect(events.map(event=>event.sequence)).toEqual([0,1,2,3]);
    expect(events[1]?.message).toBe('SENSITIVE_RESPONSE_B7');
    expect(store.getOperation(operationId)).toMatchObject({state:'COMPLETED',nextSequence:4,payloadSha256:hashIdeCompanionPayload(serializeIdeCompanionReviewPayload(prompt,workspaceAttestation))});
    expect(store.getSession(connection.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
    expect(store.getOperationAudit(operationId).map(row=>row.eventType)).toEqual(['operation_started','assistant_chunk','status','completed']);
    for(const path of [dbPath,`${dbPath}-wal`,`${dbPath}-shm`]){
      if(!existsSync(path))continue; const bytes=readFileSync(path);
      expect(bytes.includes(Buffer.from(prompt,'utf8'))).toBe(false);
      expect(bytes.includes(Buffer.from('SENSITIVE_RESPONSE_B7','utf8'))).toBe(false);
    }
    const releasePromise=readLine(connection.socket);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'release_controller'})}\n`);
    expect(await releasePromise).toMatchObject({type:'controller_released'});
    expect(store.getSession(connection.sessionId)?.state).toBe('AVAILABLE');
  });

  it('authenticates exact-operation cancellation and cannot convert cancel into completion',async()=>{
    const ctx=setup(); const connection=await readyController(ctx,blockingAdapter); const operationId=`ideo_${'7'.repeat(32)}`; const prompt='review until cancelled';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const startAuth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_review',serializeIdeCompanionReviewPayload(prompt,workspaceAttestation),0x52);
    const startedPromise=readLines(connection.socket,1);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth:startAuth,prompt,workspaceAttestation})}\n`);
    expect(((await startedPromise)[0]?.event as Record<string,unknown>).type).toBe('operation_started');
    const cancelAuth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'cancel','',0x53);
    const terminalPromise=readLines(connection.socket,2);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'cancel_operation',auth:cancelAuth})}\n`);
    const frames=await terminalPromise;
    expect(frames.some(frame=>frame.type==='cancel_accepted')).toBe(true);
    const terminal=frames.find(frame=>frame.type==='operation_event')?.event as Record<string,unknown>;
    expect(terminal?.type).toBe('cancelled');
    expect(store.getOperation(operationId)?.state).toBe('CANCELLED');
    expect(store.getSession(connection.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
  });

  it('disconnect during an active adapter turn records DISCONNECTED and aborts the adapter without late CANCELLED/COMPLETED',async()=>{
    const ctx=setup(); const connection=await readyController(ctx,blockingAdapter); const operationId=`ideo_${'8'.repeat(32)}`; const prompt='review until disconnect';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_review',serializeIdeCompanionReviewPayload(prompt,workspaceAttestation),0x54);
    const startedPromise=readLines(connection.socket,1);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth,prompt,workspaceAttestation})}\n`);
    await startedPromise; connection.socket.destroy(); await new Promise(resolve=>setTimeout(resolve,20));
    expect(store.getOperation(operationId)?.state).toBe('DISCONNECTED');
    expect(store.getOperationAudit(operationId).map(row=>row.eventType)).toEqual(['operation_started','disconnected']);
    expect(store.getSession(connection.sessionId)?.state).toBe('DISCONNECTED');
  });

  it('runtime ceiling terminalizes an unresponsive adapter INDETERMINATE and returns the session to controlled state',async()=>{
    const ctx=setup(); const connection=await readyController(ctx,blockingAdapter,20); const operationId=`ideo_${'9'.repeat(32)}`; const prompt='bounded review timeout';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_review',serializeIdeCompanionReviewPayload(prompt,workspaceAttestation),0x55);
    const framesPromise=readLines(connection.socket,2);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth,prompt,workspaceAttestation})}\n`);
    const frames=await framesPromise; const events=frames.map(frame=>frame.event as Record<string,unknown>);
    expect(events.map(event=>event.type)).toEqual(['operation_started','indeterminate']);
    expect(store.getOperation(operationId)?.state).toBe('INDETERMINATE');
    expect(store.getSession(connection.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
  });

  it('keeps a fully signed and enrolled start_implementation frame non-executable in B9.1',async()=>{
    const ctx=setup({capabilities:['prompt','cancel','observe_response','request_review','request_implementation']});
    const connection=await readyController(ctx,completingAdapter); const operationId=`ideo_${'c'.repeat(32)}`; const prompt='implementation must remain disabled in B9.1';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const payload=serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',payload,0x58);
    const responsePromise=readLine(connection.socket);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`);
    expect(await responsePromise).toMatchObject({type:'error',code:'IDE_IMPLEMENTATION_NOT_CONFIGURED'});
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(store.getOperation(operationId)).toBeUndefined();
    expect(store.getSession(connection.sessionId)?.state).toBe('DISCONNECTED');
  });

  it('invalid operation MAC opens no operation and disconnects the controller session fail closed',async()=>{
    const ctx=setup(); const connection=await readyController(ctx,completingAdapter); const operationId=`ideo_${'a'.repeat(32)}`; const prompt='forged review';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const authenticatedPayload=serializeIdeCompanionReviewPayload(prompt,workspaceAttestation);
    const bad=signIdeCompanionEnvelope(Buffer.alloc(32,0x7f),{
      version:1,enrollmentId:ctx.enrollment.enrollmentId,ideInstanceId:ctx.enrollment.ideInstanceId,sessionId:connection.sessionId,
      connectionGeneration:connection.generation,controllerLeaseId:connection.leaseId,operationId,capability:'request_review',
      nonce:Buffer.alloc(32,0x56).toString('base64url'),issuedAtMs:nowMs,expiresAtMs:nowMs+20_000,payloadSha256:hashIdeCompanionPayload(authenticatedPayload),
    });
    const responsePromise=readLine(connection.socket);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth:bad,prompt,workspaceAttestation})}\n`);
    expect(await responsePromise).toMatchObject({type:'error',code:'IDE_COMPANION_AUTH_DENIED'});
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(store.getOperation(operationId)).toBeUndefined();
    expect(store.getSession(connection.sessionId)?.state).toBe('DISCONNECTED');
  });

  it('denies a MAC-valid review start when fresh per-operation workspace evidence drifts from the enrolled worktree',async()=>{
    const ctx=setup(); const connection=await readyController(ctx,completingAdapter); const operationId=`ideo_${'b'.repeat(32)}`; const prompt='review wrong workspace';
    const base=JSON.parse(makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation)) as IdeWorkspaceAttestation;
    const workspaceAttestation=serializeIdeWorkspaceAttestation({...base,workspace:{...base.workspace,filesystemIdentity:'f'.repeat(64)}});
    const authenticatedPayload=serializeIdeCompanionReviewPayload(prompt,workspaceAttestation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_review',authenticatedPayload,0x57);
    const responsePromise=readLine(connection.socket);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_review',auth,prompt,workspaceAttestation})}\n`);
    expect(await responsePromise).toMatchObject({type:'error',code:'IDE_WORKSPACE_DENIED'});
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(store.getOperation(operationId)).toBeUndefined();
    expect(store.getSession(connection.sessionId)?.state).toBe('DISCONNECTED');
  });

});

describe('P7 B9.3 governed implementation operations over authenticated AF_UNIX connection',()=>{
  const completingImplementation:IdeImplementationOperationAdapter={
    async run(input){input.emit('status','implementation-complete');return{outcome:'completed'};},
  };
  const blockingImplementation:IdeImplementationOperationAdapter={
    async run(input){
      return await new Promise((resolve,reject)=>{
        if(input.signal.aborted){reject(input.signal.reason);return;}
        input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});
      });
    },
  };

  it('refuses partial implementation configuration before binding any socket',()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore();
    expect(()=>new IdeCompanionListener({store,runtime:ctx.runtime,writerStore})).toThrow('implementation writer authority and adapter must be configured together');
    expect(()=>new IdeCompanionListener({store,runtime:ctx.runtime,implementationAdapter:completingImplementation})).toThrow('implementation writer authority and adapter must be configured together');
    expect(existsSync(ctx.runtime.socketPath)).toBe(false);
  });

  it('executes a fully authenticated implementation only with opt-in B8+adapter composition and releases the writer after proven completion',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore();
    const connection=await readyImplementation(ctx,writerStore,completingImplementation);
    const operationId=`ideo_${'d'.repeat(32)}`; const prompt='bounded implementation success';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x61);
    const framesPromise=readLines(connection.socket,3);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`);
    const frames=await framesPromise; const events=frames.map(frame=>frame.event as Record<string,unknown>);
    expect(events.map(event=>event.type)).toEqual(['operation_started','status','completed']);
    const op=store.getOperation(operationId)!;
    expect(op).toMatchObject({capability:'request_implementation',state:'COMPLETED',writerSettlement:'RELEASED'});
    expect(op.mutationStartedAt).not.toBeNull(); expect(op.safeTerminalIntent).toBe('COMPLETED');
    expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('RELEASED');
    expect(store.getSession(connection.sessionId)?.state).toBe('CONTROLLER_ACQUIRED');
  });

  it('real agent_apply writer contention denies IDE implementation before an IDE operation is created',async()=>{
    const writerStore=newWriterStore(); const job=completedWriterJob(writerStore);
    const apply=writerStore.startApplyAttempt({attemptId:`att_${'a'.repeat(32)}`,jobId:job.jobId,worktreeId:'forward'});
    expect(writerStore.getLiveWriterLease(apply.writerLeaseId!)?.state).toBe('ACTIVE');
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']});
    const connection=await readyImplementation(ctx,writerStore,completingImplementation);
    const operationId=`ideo_${'e'.repeat(32)}`; const prompt='must lose to agent apply writer';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x62);
    const responsePromise=readLine(connection.socket);
    connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`);
    expect(await responsePromise).toMatchObject({type:'error',code:'IDE_WRITER_BUSY'});
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(store.getOperation(operationId)).toBeUndefined();
    expect(writerStore.getLiveWriterLease(apply.writerLeaseId!)?.state).toBe('ACTIVE');
  });

  it('routes authenticated cancellation to the implementation coordinator and releases only after rollback/no-mutation proof',async()=>{
    const adapter:IdeImplementationOperationAdapter={run(input){return new Promise(resolve=>input.signal.addEventListener('abort',()=>resolve({outcome:'cancelled_rolled_back'}),{once:true}));}};
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore(); const connection=await readyImplementation(ctx,writerStore,adapter);
    const operationId=`ideo_${'f'.repeat(32)}`; const prompt='implementation cancel';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const startAuth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x63);
    const startedPromise=readLines(connection.socket,1); connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth:startAuth,prompt,workspaceAttestation})}\n`); await startedPromise;
    const cancelAuth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'cancel','',0x64);
    const resultPromise=readLines(connection.socket,2); connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'cancel_operation',auth:cancelAuth})}\n`);
    const frames=await resultPromise; expect(frames.some(f=>f.type==='cancel_accepted')).toBe(true);
    expect((frames.find(f=>f.type==='operation_event')?.event as Record<string,unknown>).type).toBe('cancelled');
    const op=store.getOperation(operationId)!;expect(op).toMatchObject({state:'CANCELLED',writerSettlement:'RELEASED'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('RELEASED');
  });

  it('settles B8 uncertainty before session disconnect when transport closes during implementation',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore(); const connection=await readyImplementation(ctx,writerStore,blockingImplementation);
    const operationId=`ideo_${'1'.repeat(32)}`; const prompt='disconnect mutation';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x65);
    const startedPromise=readLines(connection.socket,1); connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`); await startedPromise;
    const before=store.getOperation(operationId)!; expect(writerStore.getLiveWriterLease(before.writerLeaseId!)?.state).toBe('ACTIVE');
    connection.socket.destroy(); await new Promise(resolve=>setTimeout(resolve,30));
    const op=store.getOperation(operationId)!;expect(op).toMatchObject({state:'DISCONNECTED',writerSettlement:'UNCERTAIN'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');expect(store.getSession(connection.sessionId)?.state).toBe('DISCONNECTED');
  });

  it('implementation runtime ceiling becomes INDETERMINATE + UNCERTAIN and never safe success',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore(); const connection=await readyImplementation(ctx,writerStore,blockingImplementation,20);
    const operationId=`ideo_${'2'.repeat(32)}`; const prompt='implementation timeout';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x66);
    const framesPromise=readLines(connection.socket,2); connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`);
    const frames=await framesPromise;expect(frames.map(f=>(f.event as Record<string,unknown>).type)).toEqual(['operation_started','indeterminate']);
    const op=store.getOperation(operationId)!;expect(op).toMatchObject({state:'INDETERMINATE',writerSettlement:'UNCERTAIN'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');
  });

  it('MAC-valid per-operation workspace drift is denied before acquiring a B8 IDE writer',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore(); const connection=await readyImplementation(ctx,writerStore,completingImplementation);
    const operationId=`ideo_${'3'.repeat(32)}`; const prompt='wrong implementation workspace';
    const base=JSON.parse(makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation)) as IdeWorkspaceAttestation;
    const workspaceAttestation=serializeIdeWorkspaceAttestation({...base,workspace:{...base.workspace,filesystemIdentity:'f'.repeat(64)}});
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x67);
    const responsePromise=readLine(connection.socket); connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`);
    expect(await responsePromise).toMatchObject({type:'error',code:'IDE_WORKSPACE_DENIED'});await new Promise(resolve=>setTimeout(resolve,20));expect(store.getOperation(operationId)).toBeUndefined();
  });

  it('an active IDE implementation lease blocks agent_apply on the same logical worktree',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore();
    const connection=await readyImplementation(ctx,writerStore,blockingImplementation); const operationId=`ideo_${'4'.repeat(32)}`; const prompt='hold shared writer';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x68);
    const startedPromise=readLines(connection.socket,1); connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`); await startedPromise;
    const op=store.getOperation(operationId)!; expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('ACTIVE');
    const job=completedWriterJob(writerStore); expect(bridgeCode(()=>writerStore.startApplyAttempt({attemptId:`att_${'b'.repeat(32)}`,jobId:job.jobId,worktreeId:'forward'}))).toBe('LIVE_WRITER_BUSY');
    connection.socket.destroy();await new Promise(resolve=>setTimeout(resolve,25));
    expect(store.getOperation(operationId)).toMatchObject({state:'DISCONNECTED',writerSettlement:'UNCERTAIN'});
  });

  it('implementation-configured listener startup reconciles a pre-restart active operation before binding',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore();
    const sid=sessionId('7'); const opened=store.openSession({enrollmentId:ctx.enrollment.enrollmentId,principalId:ctx.enrollment.principalId,projectId:ctx.enrollment.projectId,worktreeId:ctx.enrollment.worktreeId,ideProduct:ctx.enrollment.ideProduct,ideInstanceId:ctx.enrollment.ideInstanceId,workspaceFingerprint:ctx.enrollment.workspaceFingerprint,baseRevision:ctx.enrollment.baseRevision,sessionId:sid});
    const key={principalId:ctx.enrollment.principalId,projectId:ctx.enrollment.projectId,worktreeId:ctx.enrollment.worktreeId,workspaceFingerprint:ctx.enrollment.workspaceFingerprint,baseRevision:ctx.enrollment.baseRevision,ideProduct:ctx.enrollment.ideProduct,ideInstanceId:ctx.enrollment.ideInstanceId,sessionId:sid,connectionGeneration:opened.connectionGeneration} as const;
    store.markAvailable(key); const controllerLeaseId=store.acquireController(key); const operationId=`ideo_${'7'.repeat(32)}`; const prompt='pre-restart implementation';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,sid),opened.connectionGeneration); const payload=serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation);
    const envelope=signedOperationAuth(ctx,sid,opened.connectionGeneration,controllerLeaseId,operationId,'request_implementation',payload,0x69);
    const admitted=admitIdeImplementation({ideStore:store,writerStore,runtime:ctx.runtime,envelope,prompt,workspaceAttestation,nowMs});
    store.startImplementationOperation({...admitted,runtimeInstanceId:ctx.runtime.runtimeInstanceId,adapterId:ctx.runtime.adapterId,adapterVersion:ctx.runtime.adapterVersion,payloadSha256:admitted.payloadSha256,payloadBytes:Buffer.byteLength(payload,'utf8'),writerLeaseId:admitted.writerLeaseId});
    store.markImplementationMutationStarted(operationId,admitted.writerLeaseId,controllerLeaseId);
    expect(writerStore.getLiveWriterLease(admitted.writerLeaseId)?.state).toBe('ACTIVE');
    listener=new IdeCompanionListener({store,runtime:ctx.runtime,writerStore,implementationAdapter:completingImplementation,nowMs:()=>nowMs,challengeBytes:()=>Buffer.alloc(32,0x42)}); await listener.start();
    expect(store.getOperation(operationId)).toMatchObject({state:'INDETERMINATE',writerSettlement:'UNCERTAIN'}); expect(writerStore.getLiveWriterLease(admitted.writerLeaseId)?.state).toBe('UNCERTAIN'); expect(store.getSession(sid)?.state).toBe('STALE'); expect(existsSync(ctx.runtime.socketPath)).toBe(true);
  });

  it('bounded response backpressure/sink loss cannot become COMPLETED or release the writer',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore();
    const noisy:IdeImplementationOperationAdapter={async run(input){const message='x'.repeat(8_000);for(let i=0;i<200;i++)input.emit('assistant_chunk',message);return{outcome:'completed'};}};
    const connection=await readyImplementation(ctx,writerStore,noisy); const operationId=`ideo_${'8'.repeat(32)}`; const prompt='force bounded response queue';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation); const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x6a);
    connection.socket.pause(); connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`); await new Promise(resolve=>setTimeout(resolve,150));
    const op=store.getOperation(operationId)!; expect(op.state).not.toBe('COMPLETED'); expect(op.writerSettlement).toBe('UNCERTAIN'); expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN'); expect(store.getOperationAudit(operationId).some(row=>row.eventType==='completed')).toBe(false);
  });

  it('rejects a correctly signed implementation frame with a stale/future connection generation before writer admission',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore(); const connection=await readyImplementation(ctx,writerStore,completingImplementation);
    const operationId=`ideo_${'5'.repeat(32)}`; const prompt='generation mismatch';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation+1,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x69);
    const responsePromise=readLine(connection.socket);connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`);
    expect(await responsePromise).toMatchObject({type:'error',code:'IDE_SESSION_DENIED'});await new Promise(resolve=>setTimeout(resolve,20));expect(store.getOperation(operationId)).toBeUndefined();
  });

  it('external enrollment revocation plus socket close reconciles the implementation writer to UNCERTAIN',async()=>{
    const ctx=setup({capabilities:['request_implementation','cancel','observe_response']}); const writerStore=newWriterStore(); const connection=await readyImplementation(ctx,writerStore,blockingImplementation);
    const operationId=`ideo_${'6'.repeat(32)}`; const prompt='revoke while mutating';
    const workspaceAttestation=makeWorkspaceAttestation(ctx,hello(ctx,connection.sessionId),connection.generation);
    const auth=signedOperationAuth(ctx,connection.sessionId,connection.generation,connection.leaseId,operationId,'request_implementation',serializeIdeCompanionImplementationPayload(prompt,workspaceAttestation),0x6a);
    const startedPromise=readLines(connection.socket,1);connection.socket.write(`${serializeIdeCompanionOperationControlFrame({version:1,type:'start_implementation',auth,prompt,workspaceAttestation})}\n`);await startedPromise;
    const op=store.getOperation(operationId)!;expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('ACTIVE');
    expect(store.revokeEnrollment({enrollmentId:ctx.enrollment.enrollmentId,principalId:ctx.enrollment.principalId,projectId:ctx.enrollment.projectId,worktreeId:ctx.enrollment.worktreeId,ideProduct:ctx.enrollment.ideProduct,ideInstanceId:ctx.enrollment.ideInstanceId,workspaceFingerprint:ctx.enrollment.workspaceFingerprint,baseRevision:ctx.enrollment.baseRevision})).toBe(true);
    expect(store.getOperation(operationId)).toMatchObject({state:'DISCONNECTED',writerSettlement:'HELD'});connection.socket.destroy();await new Promise(resolve=>setTimeout(resolve,25));
    expect(store.getOperation(operationId)).toMatchObject({state:'DISCONNECTED',writerSettlement:'UNCERTAIN'});expect(writerStore.getLiveWriterLease(op.writerLeaseId!)?.state).toBe('UNCERTAIN');expect(store.getSession(connection.sessionId)?.state).toBe('STALE');
  });



});
