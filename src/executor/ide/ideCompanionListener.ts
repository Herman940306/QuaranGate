/**
 * P7 B6 authenticated local Unix-domain companion listener.
 *
 * B6 establishes authenticated local identity/workspace presence. B7 optionally
 * composes governed review operations. B9.3 may additionally compose the
 * accepted implementation coordinator only when trusted B8 writer authority
 * and a mutation adapter are explicitly injected together. The listener is
 * still not executor-startup or public MCP/HTTP wiring.
 */
import { randomBytes } from 'node:crypto';
import { IdeCompanionAuthError } from '../../shared/ideCompanionAuth.js';
import {
  IDE_COMPANION_OPERATION_MAX_FRAME_BYTES,
  IdeCompanionOperationProtocolError,
  parseIdeCompanionOperationControlFrame,
} from '../../shared/ideCompanionOperations.js';
import { IdeSessionContractError, type IdeOperationEvent } from '../../shared/ideSessions.js';
import { BridgeError } from '../../shared/errors.js';
import type { AgentJobStore } from '../agents/jobStore.js';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import {
  IDE_COMPANION_HANDSHAKE_MAX_FRAME_BYTES,
  IDE_COMPANION_HANDSHAKE_MAX_LIFETIME_MS,
  IDE_COMPANION_HANDSHAKE_VERSION,
  IdeCompanionHandshakeError,
  parseIdeCompanionAttest,
  parseIdeCompanionHello,
  verifyIdeCompanionAttest,
  type IdeCompanionAttestFrame,
  type IdeCompanionHelloFrame,
} from '../../shared/ideCompanionHandshake.js';
import {
  IdeWorkspaceAttestationError,
} from '../../shared/ideWorkspaceAttestation.js';
import {
  IdeRegistryStoreError,
  IdeSessionStore,
  type IdeEnrollmentRow,
  type IdeSessionRegistryKey,
} from './ideSessionStore.js';
import {
  IdeCompanionRuntimeError,
  assertIdeCompanionRuntimeRef,
  hardenAndVerifyIdeCompanionSocket,
  readIdeCompanionSecret,
  type IdeCompanionRuntimeRef,
} from './ideCompanionRuntime.js';
import {
  IdeWorkspaceVerificationError,
  verifyAuthenticatedIdeWorkspace,
} from './ideWorkspaceAttestation.js';
import {
  IdeOperationCoordinator,
  IdeOperationCoordinatorError,
  type IdeReviewOperationAdapter,
} from './ideOperationCoordinator.js';
import {
  IdeImplementationCoordinator,
  IdeImplementationCoordinatorError,
  type IdeImplementationOperationAdapter,
} from './ideImplementationCoordinator.js';

export const IDE_COMPANION_LISTENER_MAX_CONNECTIONS = 16;
export const IDE_COMPANION_LISTENER_HANDSHAKE_TIMEOUT_MS = 20_000;
export const IDE_COMPANION_LISTENER_MAX_WRITE_QUEUE_BYTES = 64 * 1024;

export type IdeCompanionListenerErrorCode =
  | 'IDE_LISTENER_UNSUPPORTED_OS'
  | 'IDE_LISTENER_ALREADY_STARTED'
  | 'IDE_LISTENER_SOCKET_EXISTS'
  | 'IDE_LISTENER_CONFIGURATION_INVALID'
  | 'IDE_LISTENER_BIND_FAILED';

export class IdeCompanionListenerError extends Error {
  constructor(public readonly code: IdeCompanionListenerErrorCode, message: string) {
    super(message);
    this.name = 'IdeCompanionListenerError';
  }
}

export interface IdeCompanionListenerOptions {
  store: IdeSessionStore;
  runtime: IdeCompanionRuntimeRef;
  /** Trusted test seam; production callers omit it. */
  nowMs?: () => number;
  /** Trusted test seam; must return exactly 32 fresh random bytes in production. */
  challengeBytes?: () => Buffer;
  /** B7 source-only adapter seam. Omit to preserve B6 handshake-only behavior. */
  operationAdapter?: IdeReviewOperationAdapter;
  /** Trusted test seam for B7 review-operation runtime bound. */
  operationMaxRuntimeMs?: number;
  /** B9.3 opt-in shared B8 writer authority. Must be paired with implementationAdapter. */
  writerStore?: AgentJobStore;
  /** B9.3 opt-in backend-neutral mutation adapter. Must be paired with writerStore. */
  implementationAdapter?: IdeImplementationOperationAdapter;
  /** Trusted test seam for B9 implementation runtime bound. */
  implementationMaxRuntimeMs?: number;
}

interface PendingHandshake {
  hello: IdeCompanionHelloFrame;
  enrollment: IdeEnrollmentRow;
  expectedCurrentGeneration: number;
  proposedGeneration: number;
  serverChallenge: string;
  expiresAtMs: number;
}

interface ConnectionState {
  phase: 'HELLO' | 'ATTEST' | 'READY' | 'CLOSED';
  buffer: Buffer;
  processing: boolean;
  pending?: PendingHandshake;
  sessionKey?: IdeSessionRegistryKey;
  enrollmentId?: string;
  controllerLeaseId?: string;
}

type PublicServerFrame =
  | { version: 1; type: 'challenge'; sessionId: string; connectionGeneration: number; serverChallenge: string; expiresAtMs: number }
  | { version: 1; type: 'ready'; sessionId: string; connectionGeneration: number }
  | { version: 1; type: 'controller_acquired'; controllerLeaseId: string }
  | { version: 1; type: 'controller_released' }
  | { version: 1; type: 'operation_event'; event: IdeOperationEvent }
  | { version: 1; type: 'cancel_accepted'; operationId: string; result: 'accepted'|'indeterminate' }
  | { version: 1; type: 'error'; code: string };

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw new IdeCompanionListenerError('IDE_LISTENER_UNSUPPORTED_OS', 'Unix uid support is required');
  return process.getuid();
}

function publicCode(error: unknown): string {
  if (error instanceof IdeCompanionHandshakeError) return error.code;
  if (error instanceof IdeCompanionOperationProtocolError) return error.code;
  if (error instanceof IdeOperationCoordinatorError) return error.code;
  if (error instanceof IdeImplementationCoordinatorError) return error.code;
  if (error instanceof IdeCompanionAuthError) return error.code;
  if (error instanceof IdeCompanionRuntimeError) return 'IDE_RUNTIME_DENIED';
  if (error instanceof IdeWorkspaceAttestationError || error instanceof IdeWorkspaceVerificationError) return 'IDE_WORKSPACE_DENIED';
  if (error instanceof IdeSessionContractError) return 'IDE_OPERATION_DENIED';
  if (error instanceof BridgeError) {
    if(error.code==='LIVE_WRITER_BUSY') return 'IDE_WRITER_BUSY';
    return 'IDE_WRITER_DENIED';
  }
  if (error instanceof IdeRegistryStoreError) return 'IDE_SESSION_DENIED';
  return 'INTERNAL';
}

function writeFrame(socket: Socket, frame: PublicServerFrame): boolean {
  if (socket.destroyed) return false;
  const body = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
  if (body.byteLength > IDE_COMPANION_LISTENER_MAX_WRITE_QUEUE_BYTES
    || socket.writableLength + body.byteLength > IDE_COMPANION_LISTENER_MAX_WRITE_QUEUE_BYTES) {
    socket.destroy();
    return false;
  }
  socket.write(body);
  return true;
}

function sessionKey(enrollment: IdeEnrollmentRow, sessionId: string, connectionGeneration: number): IdeSessionRegistryKey {
  return {
    principalId: enrollment.principalId,
    projectId: enrollment.projectId,
    worktreeId: enrollment.worktreeId,
    workspaceFingerprint: enrollment.workspaceFingerprint,
    baseRevision: enrollment.baseRevision,
    ideProduct: enrollment.ideProduct,
    ideInstanceId: enrollment.ideInstanceId,
    sessionId,
    connectionGeneration,
  };
}

export class IdeCompanionListener {
  private readonly server: Server;
  private readonly sockets = new Map<Socket, ConnectionState>();
  private readonly enrollmentSockets = new Map<string, Socket>();
  private readonly clock: () => number;
  private readonly challenge: () => Buffer;
  private readonly operationCoordinator?: IdeOperationCoordinator;
  private readonly implementationCoordinator?: IdeImplementationCoordinator;
  private started = false;
  private ownsSocketPath = false;

  constructor(private readonly opts: IdeCompanionListenerOptions) {
    this.clock = opts.nowMs ?? (() => Date.now());
    this.challenge = opts.challengeBytes ?? (() => randomBytes(32));
    this.operationCoordinator = opts.operationAdapter === undefined ? undefined : new IdeOperationCoordinator({
      store: opts.store, runtime: opts.runtime, adapter: opts.operationAdapter, nowMs: opts.nowMs, maxRuntimeMs: opts.operationMaxRuntimeMs,
    });
    const hasWriterStore=opts.writerStore!==undefined;
    const hasImplementationAdapter=opts.implementationAdapter!==undefined;
    if(hasWriterStore!==hasImplementationAdapter){
      throw new IdeCompanionListenerError('IDE_LISTENER_CONFIGURATION_INVALID','implementation writer authority and adapter must be configured together');
    }
    this.implementationCoordinator = !hasWriterStore ? undefined : new IdeImplementationCoordinator({
      store:opts.store,writerStore:opts.writerStore!,runtime:opts.runtime,adapter:opts.implementationAdapter!,nowMs:opts.nowMs,maxRuntimeMs:opts.implementationMaxRuntimeMs,
    });
    this.server = createServer((socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    if (this.started) throw new IdeCompanionListenerError('IDE_LISTENER_ALREADY_STARTED', 'IDE companion listener is already started');
    if (process.platform === 'win32') throw new IdeCompanionListenerError('IDE_LISTENER_UNSUPPORTED_OS', 'Unix-domain sockets are required');
    assertIdeCompanionRuntimeRef(this.opts.runtime);
    // Refuse to expose even a local endpoint for a revoked/tampered runtime.
    // The actual request path still re-reads the credential again per attest.
    const startupMaterial = readIdeCompanionSecret(this.opts.runtime);
    startupMaterial.secret.fill(0);
    if (existsSync(this.opts.runtime.socketPath)) {
      throw new IdeCompanionListenerError('IDE_LISTENER_SOCKET_EXISTS', 'IDE companion socket path already exists');
    }
    // B9.3 opt-in execution turns listener startup into a recovery boundary.
    // Do this only after proving the endpoint path is not already occupied and
    // before accepting any new connection.
    this.implementationCoordinator?.recoverAfterRestart();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(new IdeCompanionListenerError('IDE_LISTENER_BIND_FAILED', error.message));
      this.server.once('error', onError);
      this.server.listen(this.opts.runtime.socketPath, () => {
        this.server.off('error', onError);
        this.ownsSocketPath = true;
        resolve();
      });
    });
    try {
      hardenAndVerifyIdeCompanionSocket(this.opts.runtime);
      this.started = true;
    } catch (error) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.removeOwnedSocketIfPresent();
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Reconcile durable session state synchronously before relying on socket
    // close-event ordering. A controlled shutdown must not return while a
    // previously READY session can still appear live in Plane-B.
    for (const [socket, state] of [...this.sockets.entries()]) {
      this.reconcileDisconnect(socket, state);
      state.phase = 'CLOSED';
      socket.destroy();
    }
    this.sockets.clear();
    this.enrollmentSockets.clear();
    if (this.started) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.started = false;
    }
    this.removeOwnedSocketIfPresent();
  }

  private removeOwnedSocketIfPresent(): void {
    if (!this.ownsSocketPath) return;
    try {
      if (existsSync(this.opts.runtime.socketPath)) {
        const info = lstatSync(this.opts.runtime.socketPath);
        if (info.isSocket() && !info.isSymbolicLink() && info.uid === currentUid()) rmSync(this.opts.runtime.socketPath);
      }
    } catch { /* fail safe: never unlink an unproven path */ }
    finally { this.ownsSocketPath = false; }
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= IDE_COMPANION_LISTENER_MAX_CONNECTIONS) {
      writeFrame(socket, { version: 1, type: 'error', code: 'CAPACITY' });
      socket.end();
      return;
    }
    const state: ConnectionState = { phase: 'HELLO', buffer: Buffer.alloc(0), processing: false };
    this.sockets.set(socket, state);
    socket.setTimeout(IDE_COMPANION_LISTENER_HANDSHAKE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('close', () => this.closed(socket, state));
    socket.on('data', (chunk: Buffer) => this.onData(socket, state, chunk));
  }

  private closed(socket: Socket, state: ConnectionState): void {
    this.reconcileDisconnect(socket, state);
    state.phase = 'CLOSED';
  }

  private reconcileDisconnect(socket: Socket, state: ConnectionState): void {
    this.sockets.delete(socket);
    if (state.enrollmentId !== undefined && this.enrollmentSockets.get(state.enrollmentId) === socket) {
      this.enrollmentSockets.delete(state.enrollmentId);
    }
    if (state.sessionKey !== undefined) {
      // B9 implementation writers get first chance to retain/block the exact
      // B8 lease before generic session disconnect terminalizes Plane-B. Any
      // settlement failure is still fail closed because ACTIVE/UNCERTAIN B8
      // writer state continues to block competitors.
      try { this.implementationCoordinator?.connectionClosed(state.sessionKey.sessionId,state.sessionKey.connectionGeneration); }
      catch { /* unresolved writer remains blocking */ }
      try {
        const row = this.opts.store.getSession(state.sessionKey.sessionId);
        if (row !== undefined && row.connectionGeneration === state.sessionKey.connectionGeneration
          && row.state !== 'DISCONNECTED' && row.state !== 'STALE') {
          this.opts.store.disconnect(state.sessionKey);
        }
      } catch { /* terminal/replaced state already fails closed */ }
      this.operationCoordinator?.connectionClosed(state.sessionKey.sessionId, state.sessionKey.connectionGeneration);
      try { this.implementationCoordinator?.reconcileTerminalWriterSettlements(); }
      catch { /* unresolved writer remains ACTIVE/UNCERTAIN and therefore blocking */ }
    }
    state.controllerLeaseId = undefined;
  }

  private onData(socket: Socket, state: ConnectionState, chunk: Buffer): void {
    if (state.phase === 'CLOSED' || state.processing) {
      writeFrame(socket, { version: 1, type: 'error', code: 'UNEXPECTED_FRAME' });
      socket.end();
      return;
    }
    const maxFrameBytes = state.phase === 'READY' ? IDE_COMPANION_OPERATION_MAX_FRAME_BYTES : IDE_COMPANION_HANDSHAKE_MAX_FRAME_BYTES;
    if (state.buffer.byteLength + chunk.byteLength > maxFrameBytes + 1) {
      writeFrame(socket, { version: 1, type: 'error', code: state.phase === 'READY' ? 'IDE_OPERATION_FRAME_SIZE' : 'IDE_HANDSHAKE_FRAME_SIZE' });
      socket.end();
      return;
    }
    state.buffer = Buffer.concat([state.buffer, chunk]);
    const newline = state.buffer.indexOf(0x0a);
    if (newline < 0) return;
    if (newline !== state.buffer.byteLength - 1) {
      writeFrame(socket, { version: 1, type: 'error', code: 'MULTIPLE_FRAMES' });
      socket.end();
      return;
    }
    const frame = state.buffer.subarray(0, newline);
    state.buffer = Buffer.alloc(0);
    state.processing = true;
    void this.handleFrame(socket, state, frame).finally(() => { state.processing = false; });
  }

  private async handleFrame(socket: Socket, state: ConnectionState, frame: Buffer): Promise<void> {
    try {
      if (state.phase === 'HELLO') {
        this.handleHello(socket, state, frame);
        return;
      }
      if (state.phase === 'ATTEST') {
        this.handleAttest(socket, state, frame);
        return;
      }
      if (state.phase === 'READY') {
        if(this.operationCoordinator===undefined&&this.implementationCoordinator===undefined){
          writeFrame(socket,{version:1,type:'error',code:'UNEXPECTED_FRAME'});
          socket.end();
          return;
        }
        this.handleOperationControl(socket, state, frame);
        return;
      }
      throw new IdeCompanionListenerError('IDE_LISTENER_BIND_FAILED', 'unexpected connection phase');
    } catch (error) {
      writeFrame(socket, { version: 1, type: 'error', code: publicCode(error) });
      socket.end();
    }
  }

  private handleHello(socket: Socket, state: ConnectionState, bytes: Buffer): void {
    const hello = parseIdeCompanionHello(bytes);
    const runtime = this.opts.runtime;
    assertIdeCompanionRuntimeRef(runtime);
    if (hello.enrollmentId !== runtime.enrollmentId || hello.ideInstanceId !== runtime.ideInstanceId
      || hello.runtimeInstanceId !== runtime.runtimeInstanceId || hello.adapterId !== runtime.adapterId
      || hello.adapterVersion !== runtime.adapterVersion) {
      throw new IdeCompanionRuntimeError('IDE_RUNTIME_BINDING_MISMATCH', 'hello does not match trusted runtime identity');
    }
    const enrollment = this.opts.store.getEnrollment(hello.enrollmentId);
    if (!enrollment || enrollment.state !== 'ACTIVE' || enrollment.ideInstanceId !== hello.ideInstanceId
      || enrollment.ideProduct !== runtime.ideProduct) {
      throw new IdeRegistryStoreError('IDE_ENROLLMENT_NOT_ACTIVE', 'IDE enrollment is not active for this runtime');
    }
    const proposedGeneration = enrollment.currentGeneration + 1;
    if (!Number.isSafeInteger(proposedGeneration) || proposedGeneration < 1) {
      throw new IdeRegistryStoreError('IDE_REGISTRY_SCHEMA', 'IDE connection generation exhausted');
    }
    const challengeBytes = this.challenge();
    if (!Buffer.isBuffer(challengeBytes) || challengeBytes.byteLength !== 32) throw new Error('challenge source did not return 32 bytes');
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - IDE_COMPANION_HANDSHAKE_MAX_LIFETIME_MS) throw new Error('clock is invalid');
    const pending: PendingHandshake = {
      hello,
      enrollment,
      expectedCurrentGeneration: enrollment.currentGeneration,
      proposedGeneration,
      serverChallenge: challengeBytes.toString('base64url'),
      expiresAtMs: now + IDE_COMPANION_HANDSHAKE_MAX_LIFETIME_MS,
    };
    state.pending = pending;
    state.phase = 'ATTEST';
    writeFrame(socket, {
      version: IDE_COMPANION_HANDSHAKE_VERSION,
      type: 'challenge',
      sessionId: hello.sessionId,
      connectionGeneration: proposedGeneration,
      serverChallenge: pending.serverChallenge,
      expiresAtMs: pending.expiresAtMs,
    });
  }

  private handleAttest(socket: Socket, state: ConnectionState, bytes: Buffer): void {
    const pending = state.pending;
    if (!pending) throw new Error('missing handshake challenge');
    const frame = parseIdeCompanionAttest(bytes);
    this.assertAttestMatchesChallenge(frame, pending);
    const material = readIdeCompanionSecret(this.opts.runtime);
    try { verifyIdeCompanionAttest({ frame, secret: material.secret, nowMs: this.clock() }); }
    finally { material.secret.fill(0); }

    const enrollment = pending.enrollment;
    const opened = this.opts.store.openSessionIfCurrent({
      enrollmentId: enrollment.enrollmentId,
      principalId: enrollment.principalId,
      projectId: enrollment.projectId,
      worktreeId: enrollment.worktreeId,
      ideProduct: enrollment.ideProduct,
      ideInstanceId: enrollment.ideInstanceId,
      workspaceFingerprint: enrollment.workspaceFingerprint,
      baseRevision: enrollment.baseRevision,
      sessionId: pending.hello.sessionId,
    }, pending.expectedCurrentGeneration);
    if (opened.connectionGeneration !== pending.proposedGeneration) throw new IdeRegistryStoreError('IDE_SESSION_BINDING_MISMATCH', 'handshake generation changed unexpectedly');
    state.sessionKey = sessionKey(enrollment, opened.sessionId, opened.connectionGeneration);

    verifyAuthenticatedIdeWorkspace({
      store: this.opts.store,
      runtime: this.opts.runtime,
      admitted: {
        enrollmentId: frame.enrollmentId,
        ideInstanceId: frame.ideInstanceId,
        sessionId: frame.sessionId,
        connectionGeneration: frame.connectionGeneration,
        payloadSha256: frame.payloadSha256,
      },
      payload: frame.workspaceAttestation,
    });
    this.opts.store.markAvailable(state.sessionKey);

    const prior = this.enrollmentSockets.get(enrollment.enrollmentId);
    if (prior !== undefined && prior !== socket) prior.destroy();
    this.enrollmentSockets.set(enrollment.enrollmentId, socket);
    state.enrollmentId = enrollment.enrollmentId;
    state.phase = 'READY';
    state.pending = undefined;
    socket.setTimeout(0);
    writeFrame(socket, { version: 1, type: 'ready', sessionId: opened.sessionId, connectionGeneration: opened.connectionGeneration });
  }

  private handleOperationControl(socket: Socket, state: ConnectionState, bytes: Buffer): void {
    if (state.sessionKey === undefined) throw new IdeRegistryStoreError('IDE_SESSION_NOT_FOUND','IDE ready connection has no session binding');
    const frame=parseIdeCompanionOperationControlFrame(bytes);
    if(frame.type==='acquire_controller'){
      if(state.controllerLeaseId!==undefined)throw new IdeRegistryStoreError('IDE_SESSION_STATE_MISMATCH','controller already acquired on this connection');
      const lease=this.opts.store.acquireController(state.sessionKey);
      state.controllerLeaseId=lease;
      writeFrame(socket,{version:1,type:'controller_acquired',controllerLeaseId:lease});
      return;
    }
    if(frame.type==='release_controller'){
      if(state.controllerLeaseId===undefined)throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','this connection does not own a controller lease');
      this.opts.store.releaseController(state.sessionKey,state.controllerLeaseId);
      state.controllerLeaseId=undefined;
      writeFrame(socket,{version:1,type:'controller_released'});
      return;
    }
    if(state.controllerLeaseId===undefined||frame.auth.controllerLeaseId!==state.controllerLeaseId){
      throw new IdeRegistryStoreError('IDE_CONTROLLER_LEASE_MISMATCH','operation frame does not own this connection controller');
    }
    if(frame.type==='start_review'){
      if(this.operationCoordinator===undefined) throw new IdeOperationCoordinatorError('IDE_OPERATION_NOT_CONFIGURED','IDE review operation adapter is not configured');
      this.operationCoordinator.startReview(frame.auth,frame.prompt,frame.workspaceAttestation,(event:IdeOperationEvent)=>{
        if(!writeFrame(socket,{version:1,type:'operation_event',event})) throw new IdeOperationCoordinatorError('IDE_OPERATION_SINK_FAILED','IDE review response sink is unavailable');
      });
      return;
    }
    if(frame.type==='start_implementation'){
      if(this.implementationCoordinator===undefined) throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_NOT_CONFIGURED','IDE implementation execution is not configured');
      this.implementationCoordinator.startImplementation(frame.auth,frame.prompt,frame.workspaceAttestation,(event:IdeOperationEvent)=>{
        if(!writeFrame(socket,{version:1,type:'operation_event',event})) throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_SINK_FAILED','IDE implementation response sink is unavailable');
      });
      return;
    }
    const target=this.opts.store.getOperation(frame.auth.operationId);
    let result:'accepted'|'indeterminate';
    if(target?.capability==='request_implementation'){
      if(this.implementationCoordinator===undefined) throw new IdeImplementationCoordinatorError('IDE_IMPLEMENTATION_NOT_CONFIGURED','IDE implementation execution is not configured');
      result=this.implementationCoordinator.cancel(frame.auth);
    }else if(target?.capability==='request_review'){
      if(this.operationCoordinator===undefined) throw new IdeOperationCoordinatorError('IDE_OPERATION_NOT_CONFIGURED','IDE review operation adapter is not configured');
      result=this.operationCoordinator.cancel(frame.auth);
    }else if(this.operationCoordinator!==undefined){
      result=this.operationCoordinator.cancel(frame.auth);
    }else if(this.implementationCoordinator!==undefined){
      result=this.implementationCoordinator.cancel(frame.auth);
    }else{
      throw new IdeOperationCoordinatorError('IDE_OPERATION_NOT_CONFIGURED','IDE operation adapter is not configured');
    }
    writeFrame(socket,{version:1,type:'cancel_accepted',operationId:frame.auth.operationId,result});
  }

  private assertAttestMatchesChallenge(frame: IdeCompanionAttestFrame, pending: PendingHandshake): void {
    const hello = pending.hello;
    const mismatched = frame.enrollmentId !== hello.enrollmentId || frame.ideInstanceId !== hello.ideInstanceId
      || frame.runtimeInstanceId !== hello.runtimeInstanceId || frame.adapterId !== hello.adapterId
      || frame.adapterVersion !== hello.adapterVersion || frame.sessionId !== hello.sessionId
      || frame.clientNonce !== hello.clientNonce || frame.connectionGeneration !== pending.proposedGeneration
      || frame.serverChallenge !== pending.serverChallenge || frame.expiresAtMs !== pending.expiresAtMs;
    if (mismatched) throw new IdeCompanionHandshakeError('IDE_HANDSHAKE_AUTH_DENIED', 'authentication denied');
  }
}
