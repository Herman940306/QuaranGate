/**
 * P7 I3 Cursor-side QuaranGate-origin command/event channel.
 *
 * The extension cannot originate an operation here. It only answers an exact
 * QuaranGate authorize_operation command with fresh B5 evidence + B3 auth,
 * then executes after a separate execute_operation command.
 */
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { hashIdeCompanionPayload, signIdeCompanionEnvelope } from '../../shared/ideCompanionAuth.js';
import {
  serializeIdeCompanionImplementationPayload,
  serializeIdeCompanionReviewPayload,
} from '../../shared/ideCompanionOperations.js';
import {
  IDE_REMOTE_IMPLEMENTATION_OUTCOMES,
  IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES,
  parseIdeRemoteServerFrame,
  serializeIdeRemoteClientFrame,
  type IdeRemoteAdapterEventType,
  type IdeRemoteImplementationOutcome,
  type IdeRemoteOperationCapability,
  type IdeRemoteReviewIntentEventFrame,
  type IdeRemoteReviewIntentRejectedFrame,
  type IdeRemoteServerFrame,
} from '../../shared/ideCompanionRemoteTransport.js';
import { serializeIdeWorkspaceAttestation, type IdeWorkspacePhysicalIdentity } from '../../shared/ideWorkspaceAttestation.js';
import { isTerminalIdeEventType } from '../../shared/ideSessions.js';
import type { CursorCompanionConnection } from './cursorCompanionConnection.js';
import { readCursorCompanionCredential, type CursorCompanionCredential } from './cursorCompanionCredential.js';

export const CURSOR_REMOTE_AUTH_LIFETIME_MS = 20_000;
export const CURSOR_REMOTE_MAX_BUFFER_BYTES = IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES * 2;
export const CURSOR_REMOTE_MAX_WRITE_QUEUE_BYTES = 64 * 1024;
export const CURSOR_REMOTE_WORKSPACE_RECHECK_TIMEOUT_MS = 20_000;

export type CursorCommandChannelErrorCode =
  | 'CURSOR_REMOTE_CHANNEL_CLOSED'
  | 'CURSOR_REMOTE_BINDING_MISMATCH'
  | 'CURSOR_REMOTE_SEQUENCE_INVALID'
  | 'CURSOR_REMOTE_STATE_INVALID'
  | 'CURSOR_REMOTE_HANDLER_UNAVAILABLE'
  | 'CURSOR_REMOTE_REVIEW_REJECTED'
  | 'CURSOR_REMOTE_WRITE_FAILED';

export class CursorCommandChannelError extends Error {
  constructor(public readonly code: CursorCommandChannelErrorCode, message: string) {
    super(message);
    this.name = 'CursorCommandChannelError';
  }
}

export interface CursorRemoteOperationInput {
  operationId: string;
  prompt: string;
  signal: AbortSignal;
  emit(type: IdeRemoteAdapterEventType, message?: string): void;
}
export interface CursorRemoteReviewHandler { run(input: CursorRemoteOperationInput): Promise<void>; }
export interface CursorRemoteImplementationHandler {
  run(input: CursorRemoteOperationInput): Promise<{ outcome: IdeRemoteImplementationOutcome }>;
}

export interface CursorGovernedUserReviewInput {
  prompt: string;
  signal: AbortSignal;
  emit(type: 'status' | 'assistant_chunk', message: string): void;
}

export interface CursorGovernedUserReviewResult {
  operationId: string;
  terminalState: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INDETERMINATE';
}

export interface CursorCommandChannelOptions {
  connection: CursorCompanionConnection;
  credentialBinding: Omit<CursorCompanionCredential, 'secret'>;
  collectWorkspace(): Promise<IdeWorkspacePhysicalIdentity>;
  reviewHandler?: CursorRemoteReviewHandler;
  implementationHandler?: CursorRemoteImplementationHandler;
  nowMs?: () => number;
  randomBytes?: (size: number) => Buffer;
}

interface AuthorizedOperation {
  operationId: string;
  capability: IdeRemoteOperationCapability;
  prompt: string;
  /** Exact B3-authenticated B5 bytes. Execution must re-attest to these bytes before any handler runs. */
  workspaceAttestation: string;
}
interface ActiveOperation extends AuthorizedOperation {
  controller: AbortController;
  nextEventSequence: number;
}
interface PendingUserReview {
  intentSequence: number;
  input: CursorGovernedUserReviewInput;
  nextEventSequence: number;
  operationId?: string;
  cancelSent: boolean;
  abort: () => void;
  resolve(value: CursorGovernedUserReviewResult): void;
  reject(error: Error): void;
}

function fail(code: CursorCommandChannelErrorCode, message: string): never {
  throw new CursorCommandChannelError(code, message);
}

export class CursorCommandChannel {
  private readonly socket: Socket;
  private readonly clock: () => number;
  private readonly rng: (size:number)=>Buffer;
  private expectedCommandSequence = 1;
  private nextIntentSequence = 1;
  private buffer = Buffer.alloc(0);
  private chain = Promise.resolve();
  private started = false;
  private closed = false;
  private authorized?: AuthorizedOperation;
  private active?: ActiveOperation;
  private pendingUserReview?: PendingUserReview;

  constructor(private readonly opts: CursorCommandChannelOptions) {
    this.socket = opts.connection.socket;
    this.clock = opts.nowMs ?? (() => Date.now());
    this.rng = opts.randomBytes ?? randomBytes;
    const binding = opts.credentialBinding;
    if (binding.credentialPath.length === 0 || binding.adapterVersion.length === 0) {
      fail('CURSOR_REMOTE_BINDING_MISMATCH', 'credential binding is incomplete');
    }
  }

  start(): void {
    if (this.started || this.closed) fail('CURSOR_REMOTE_STATE_INVALID', 'Cursor command channel cannot be started in current state');
    this.started = true;
    this.socket.on('data', this.onData);
    this.socket.once('close', this.onClose);
    this.socket.once('error', this.onError);
    this.write({version:1,type:'transport_ready',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration});
  }

  isReady(): boolean {
    return this.started && !this.closed && !this.socket.destroyed;
  }

  requestUserReview(input: CursorGovernedUserReviewInput): Promise<CursorGovernedUserReviewResult> {
    if (!this.isReady()) return Promise.reject(new CursorCommandChannelError('CURSOR_REMOTE_CHANNEL_CLOSED', 'QuaranGate review transport is unavailable'));
    if (this.pendingUserReview !== undefined) return Promise.reject(new CursorCommandChannelError('CURSOR_REMOTE_STATE_INVALID', 'a user review intent is already pending'));
    if (input.signal.aborted) return Promise.reject(new CursorCommandChannelError('CURSOR_REMOTE_REVIEW_REJECTED', 'user review intent was cancelled before admission'));
    const intentSequence = this.nextIntentSequence;
    if (!Number.isSafeInteger(intentSequence) || intentSequence < 1 || intentSequence === Number.MAX_SAFE_INTEGER) {
      this.failClosed();
      return Promise.reject(new CursorCommandChannelError('CURSOR_REMOTE_SEQUENCE_INVALID', 'review intent sequence exhausted'));
    }
    this.nextIntentSequence += 1;
    return new Promise((resolve, reject) => {
      const pending: PendingUserReview = {
        intentSequence,
        input,
        nextEventSequence: 0,
        cancelSent: false,
        abort: () => this.cancelUserReviewIntent(intentSequence),
        resolve,
        reject,
      };
      this.pendingUserReview = pending;
      try {
        this.write({
          version: 1,
          type: 'review_intent',
          sessionId: this.opts.connection.sessionId,
          connectionGeneration: this.opts.connection.connectionGeneration,
          intentSequence,
          prompt: input.prompt,
        });
        input.signal.addEventListener('abort', pending.abort, { once: true });
        if (input.signal.aborted) pending.abort();
      } catch (error) {
        this.finishUserReview(pending);
        reject(error instanceof Error ? error : new CursorCommandChannelError('CURSOR_REMOTE_WRITE_FAILED', 'review intent could not be sent'));
      }
    });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.active?.controller.abort(new Error('Cursor command channel stopped'));
    this.active = undefined;
    this.authorized = undefined;
    this.rejectPendingUserReview(new CursorCommandChannelError('CURSOR_REMOTE_CHANNEL_CLOSED', 'Cursor command channel stopped'));
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.closed) return;
    if (this.buffer.byteLength + chunk.byteLength > CURSOR_REMOTE_MAX_BUFFER_BYTES) {
      this.failClosed(); return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.byteLength > IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES) this.failClosed();
        return;
      }
      if (newline > IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES) { this.failClosed(); return; }
      const frame = Buffer.from(this.buffer.subarray(0, newline));
      this.buffer = this.buffer.subarray(newline + 1);
      this.chain = this.chain.then(() => this.handleFrame(frame)).catch(() => this.failClosed());
    }
  };
  private readonly onClose = (): void => { this.closed = true; this.detach(); this.active?.controller.abort(new Error('authenticated QuaranGate connection closed')); this.rejectPendingUserReview(new CursorCommandChannelError('CURSOR_REMOTE_CHANNEL_CLOSED','authenticated QuaranGate connection closed')); };
  private readonly onError = (): void => { this.failClosed(); };

  private async handleFrame(bytes: Buffer): Promise<void> {
    if (this.closed) return;
    const frame = parseIdeRemoteServerFrame(bytes);
    this.assertCommon(frame);
    if (frame.commandSequence !== this.expectedCommandSequence) {
      fail('CURSOR_REMOTE_SEQUENCE_INVALID', 'QuaranGate command sequence is stale, replayed or skipped');
    }
    this.expectedCommandSequence += 1;
    if (frame.type === 'review_intent_event') { this.acceptUserReviewEvent(frame); return; }
    if (frame.type === 'review_intent_rejected') { this.acceptUserReviewRejected(frame); return; }
    if (frame.type === 'authorize_operation') { await this.authorize(frame); return; }
    if (frame.type === 'execute_operation') { await this.execute(frame); return; }
    this.cancel(frame);
  }

  private acceptUserReviewEvent(frame: IdeRemoteReviewIntentEventFrame): void {
    const pending = this.pendingUserReview;
    if (pending === undefined || frame.intentSequence !== pending.intentSequence) {
      fail('CURSOR_REMOTE_SEQUENCE_INVALID', 'review intent event has no exact pending request');
    }
    const event = frame.event;
    if (event.origin !== 'machine' || event.sequence !== pending.nextEventSequence) {
      fail('CURSOR_REMOTE_SEQUENCE_INVALID', 'review intent durable event sequence/origin is invalid');
    }
    if (pending.operationId === undefined) {
      if (event.type !== 'operation_started' || event.sequence !== 0) {
        fail('CURSOR_REMOTE_SEQUENCE_INVALID', 'review intent first durable event must be operation_started');
      }
      pending.operationId = event.operationId;
    } else if (event.operationId !== pending.operationId) {
      fail('CURSOR_REMOTE_BINDING_MISMATCH', 'review intent event changed authoritative operation identity');
    }
    pending.nextEventSequence += 1;
    if (event.type === 'assistant_chunk' && event.message !== undefined) pending.input.emit('assistant_chunk', event.message);
    else if ((event.type === 'status' || event.type === 'tool_activity') && event.message !== undefined) pending.input.emit('status', event.message);
    if (!isTerminalIdeEventType(event.type)) return;
    const operationId = pending.operationId;
    if (operationId === undefined) fail('CURSOR_REMOTE_BINDING_MISMATCH', 'review intent terminal event lacks admitted operation identity');
    const terminalState = event.type === 'completed' ? 'COMPLETED'
      : event.type === 'cancelled' ? 'CANCELLED'
      : event.type === 'failed' ? 'FAILED'
      : 'INDETERMINATE';
    this.finishUserReview(pending);
    pending.resolve({ operationId, terminalState });
  }

  private acceptUserReviewRejected(frame: IdeRemoteReviewIntentRejectedFrame): void {
    const pending = this.pendingUserReview;
    if (pending === undefined || frame.intentSequence !== pending.intentSequence) {
      fail('CURSOR_REMOTE_SEQUENCE_INVALID', 'review intent rejection has no exact pending request');
    }
    this.finishUserReview(pending);
    pending.reject(new CursorCommandChannelError('CURSOR_REMOTE_REVIEW_REJECTED', `QuaranGate review intent rejected: ${frame.reason}`));
  }

  private cancelUserReviewIntent(intentSequence: number): void {
    const pending = this.pendingUserReview;
    if (pending === undefined || pending.intentSequence !== intentSequence || pending.cancelSent || this.closed) return;
    pending.cancelSent = true;
    try {
      this.write({
        version: 1,
        type: 'review_intent_cancel',
        sessionId: this.opts.connection.sessionId,
        connectionGeneration: this.opts.connection.connectionGeneration,
        intentSequence,
      });
    } catch (error) {
      this.finishUserReview(pending);
      pending.reject(error instanceof Error ? error : new CursorCommandChannelError('CURSOR_REMOTE_WRITE_FAILED', 'review intent cancellation could not be sent'));
    }
  }

  private finishUserReview(pending: PendingUserReview): void {
    pending.input.signal.removeEventListener('abort', pending.abort);
    if (this.pendingUserReview === pending) this.pendingUserReview = undefined;
  }

  private rejectPendingUserReview(error: Error): void {
    const pending = this.pendingUserReview;
    if (pending === undefined) return;
    this.finishUserReview(pending);
    pending.reject(error);
  }

  private async authorize(frame: Extract<IdeRemoteServerFrame,{type:'authorize_operation'}>): Promise<void> {
    if (this.authorized !== undefined || this.active !== undefined) fail('CURSOR_REMOTE_STATE_INVALID', 'operation already authorized or active');
    const credential = readCursorCompanionCredential(this.opts.credentialBinding.credentialPath, this.opts.credentialBinding.adapterVersion);
    try {
      this.assertCredentialBinding(credential);
      const workspace = await this.opts.collectWorkspace();
      const workspaceAttestation = serializeIdeWorkspaceAttestation({
        version:1,
        enrollmentId:credential.enrollmentId,
        ideInstanceId:credential.ideInstanceId,
        runtimeInstanceId:credential.runtimeInstanceId,
        ideProduct:'cursor',
        adapterId:credential.adapterId,
        adapterVersion:credential.adapterVersion,
        sessionId:this.opts.connection.sessionId,
        connectionGeneration:this.opts.connection.connectionGeneration,
        workspace,
      });
      const payload = frame.capability === 'request_review'
        ? serializeIdeCompanionReviewPayload(frame.prompt, workspaceAttestation)
        : serializeIdeCompanionImplementationPayload(frame.prompt, workspaceAttestation);
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - CURSOR_REMOTE_AUTH_LIFETIME_MS) {
        fail('CURSOR_REMOTE_STATE_INVALID', 'local clock is invalid');
      }
      const nonceBytes = this.rng(32);
      if (!Buffer.isBuffer(nonceBytes) || nonceBytes.byteLength !== 32) fail('CURSOR_REMOTE_STATE_INVALID', 'nonce source did not return 32 bytes');
      const auth = signIdeCompanionEnvelope(credential.secret, {
        version:1,
        enrollmentId:credential.enrollmentId,
        ideInstanceId:credential.ideInstanceId,
        sessionId:this.opts.connection.sessionId,
        connectionGeneration:this.opts.connection.connectionGeneration,
        controllerLeaseId:frame.controllerLeaseId,
        operationId:frame.operationId,
        capability:frame.capability,
        nonce:nonceBytes.toString('base64url'),
        issuedAtMs:now,
        expiresAtMs:now+CURSOR_REMOTE_AUTH_LIFETIME_MS,
        payloadSha256:hashIdeCompanionPayload(payload),
      });
      this.authorized={operationId:frame.operationId,capability:frame.capability,prompt:frame.prompt,workspaceAttestation};
      this.write({
        version:1,type:'operation_authorized',sessionId:this.opts.connection.sessionId,
        connectionGeneration:this.opts.connection.connectionGeneration,commandSequence:frame.commandSequence,
        operationId:frame.operationId,auth,workspaceAttestation,
      });
    } finally { credential.secret.fill(0); }
  }

  private async execute(frame: Extract<IdeRemoteServerFrame,{type:'execute_operation'}>): Promise<void> {
    const authorized=this.authorized;
    if (authorized===undefined||this.active!==undefined||authorized.operationId!==frame.operationId||authorized.capability!==frame.capability) {
      fail('CURSOR_REMOTE_STATE_INVALID','execute command lacks exact prior authorization');
    }
    if (frame.capability==='request_review' && this.opts.reviewHandler===undefined) fail('CURSOR_REMOTE_HANDLER_UNAVAILABLE','review handler is unavailable');
    if (frame.capability==='request_implementation' && this.opts.implementationHandler===undefined) fail('CURSOR_REMOTE_HANDLER_UNAVAILABLE','implementation handler is unavailable');

    // Close the authorization->execution TOCTOU gap without creating a second
    // authority protocol: re-read the current B4 binding and re-collect exact
    // B5 evidence immediately before invoking any vendor/model handler. The
    // fresh canonical attestation must be byte-identical to the B3-authenticated
    // operation attestation. A mismatch is a proven pre-mutation failure.
    try {
      const currentWorkspaceAttestation = await this.collectExecutionWorkspaceAttestation();
      if (currentWorkspaceAttestation !== authorized.workspaceAttestation) {
        fail('CURSOR_REMOTE_BINDING_MISMATCH','workspace identity changed after operation authorization');
      }
    } catch {
      this.authorized=undefined;
      if (frame.capability==='request_review') {
        this.write({version:1,type:'review_result',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration,operationId:frame.operationId,eventSequence:0,result:'failed'});
      } else {
        this.write({version:1,type:'implementation_result',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration,operationId:frame.operationId,eventSequence:0,outcome:'failed_no_mutation'});
      }
      return;
    }

    const active:ActiveOperation={...authorized,controller:new AbortController(),nextEventSequence:0};
    this.active=active;
    if(frame.capability==='request_review') void this.runReview(active);
    else void this.runImplementation(active);
  }

  private async collectExecutionWorkspaceAttestation(): Promise<string> {
    const credential = readCursorCompanionCredential(this.opts.credentialBinding.credentialPath, this.opts.credentialBinding.adapterVersion);
    let timer: NodeJS.Timeout | undefined;
    try {
      this.assertCredentialBinding(credential);
      const workspace = await Promise.race([
        this.opts.collectWorkspace(),
        new Promise<never>((_resolve,reject)=>{
          timer=setTimeout(()=>reject(new CursorCommandChannelError('CURSOR_REMOTE_STATE_INVALID','execution workspace re-attestation timed out')),CURSOR_REMOTE_WORKSPACE_RECHECK_TIMEOUT_MS);
        }),
      ]);
      return serializeIdeWorkspaceAttestation({
        version:1,
        enrollmentId:credential.enrollmentId,
        ideInstanceId:credential.ideInstanceId,
        runtimeInstanceId:credential.runtimeInstanceId,
        ideProduct:'cursor',
        adapterId:credential.adapterId,
        adapterVersion:credential.adapterVersion,
        sessionId:this.opts.connection.sessionId,
        connectionGeneration:this.opts.connection.connectionGeneration,
        workspace,
      });
    } finally {
      if(timer!==undefined)clearTimeout(timer);
      credential.secret.fill(0);
    }
  }

  private cancel(frame: Extract<IdeRemoteServerFrame,{type:'cancel_operation'}>): void {
    const active=this.active;
    if(active===undefined||active.operationId!==frame.operationId) fail('CURSOR_REMOTE_STATE_INVALID','cancel does not name exact active operation');
    active.controller.abort(new Error('QuaranGate cancelled operation'));
    this.write({version:1,type:'cancel_ack',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration,commandSequence:frame.commandSequence,operationId:frame.operationId});
  }

  private async runReview(active:ActiveOperation):Promise<void>{
    try{
      await this.opts.reviewHandler!.run(this.handlerInput(active));
      this.sendReviewResult(active,active.controller.signal.aborted?'cancelled':'completed');
    }catch{
      this.sendReviewResult(active,active.controller.signal.aborted?'cancelled':'failed');
    }
  }
  private async runImplementation(active:ActiveOperation):Promise<void>{
    let outcome:IdeRemoteImplementationOutcome='indeterminate';
    try{
      const result=await this.opts.implementationHandler!.run(this.handlerInput(active));
      if(!result||!(IDE_REMOTE_IMPLEMENTATION_OUTCOMES as readonly string[]).includes(result.outcome)) outcome='indeterminate';
      else outcome=result.outcome;
    }catch{ outcome='indeterminate'; }
    if(this.active!==active||this.closed)return;
    this.write({version:1,type:'implementation_result',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration,operationId:active.operationId,eventSequence:active.nextEventSequence,outcome});
    this.active=undefined;this.authorized=undefined;
  }
  private sendReviewResult(active:ActiveOperation,result:'completed'|'failed'|'cancelled'):void{
    if(this.active!==active||this.closed)return;
    this.write({version:1,type:'review_result',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration,operationId:active.operationId,eventSequence:active.nextEventSequence,result});
    this.active=undefined;this.authorized=undefined;
  }
  private handlerInput(active:ActiveOperation):CursorRemoteOperationInput{
    return{operationId:active.operationId,prompt:active.prompt,signal:active.controller.signal,emit:(type,message)=>{
      if(this.active!==active||active.controller.signal.aborted||this.closed)return;
      this.write({version:1,type:'adapter_event',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration,operationId:active.operationId,eventSequence:active.nextEventSequence,eventType:type,...(message===undefined?{}:{message})});
      active.nextEventSequence+=1;
    }};
  }

  private assertCommon(frame:IdeRemoteServerFrame):void{
    if(frame.sessionId!==this.opts.connection.sessionId||frame.connectionGeneration!==this.opts.connection.connectionGeneration) {
      fail('CURSOR_REMOTE_BINDING_MISMATCH','QuaranGate command does not match authenticated session/generation');
    }
  }
  private assertCredentialBinding(current:CursorCompanionCredential):void{
    const expected=this.opts.credentialBinding;
    const fields:Array<[unknown,unknown]>=[
      [current.runtimeInstanceId,expected.runtimeInstanceId],[current.enrollmentId,expected.enrollmentId],[current.ideInstanceId,expected.ideInstanceId],
      [current.ideProduct,expected.ideProduct],[current.adapterId,expected.adapterId],[current.adapterVersion,expected.adapterVersion],
      [current.credentialPath,expected.credentialPath],[current.socketPath,expected.socketPath],
    ];
    if(fields.some(([a,b])=>a!==b)) fail('CURSOR_REMOTE_BINDING_MISMATCH','current B4 credential no longer matches authenticated runtime binding');
  }
  private write(frame:Parameters<typeof serializeIdeRemoteClientFrame>[0]):void{
    if(this.closed||this.socket.destroyed)fail('CURSOR_REMOTE_CHANNEL_CLOSED','Cursor remote channel is closed');
    let encoded:string;
    try{encoded=serializeIdeRemoteClientFrame(frame);}catch{this.failClosed();fail('CURSOR_REMOTE_WRITE_FAILED','Cursor remote response is outside protocol bounds');}
    const body=Buffer.from(`${encoded}\n`,'utf8');
    if(body.byteLength>CURSOR_REMOTE_MAX_WRITE_QUEUE_BYTES||this.socket.writableLength+body.byteLength>CURSOR_REMOTE_MAX_WRITE_QUEUE_BYTES){this.failClosed();fail('CURSOR_REMOTE_WRITE_FAILED','Cursor remote response queue exceeded bound');}
    try { this.socket.write(body); }
    catch { this.failClosed(); fail('CURSOR_REMOTE_WRITE_FAILED','Cursor remote response write failed'); }
  }
  private failClosed():void{if(this.closed)return;this.closed=true;this.detach();this.active?.controller.abort(new Error('Cursor remote channel failed closed'));this.rejectPendingUserReview(new CursorCommandChannelError('CURSOR_REMOTE_CHANNEL_CLOSED','Cursor remote channel failed closed'));this.socket.destroy();}
  private detach():void{this.socket.off('data',this.onData);this.socket.off('close',this.onClose);this.socket.off('error',this.onError);}
}
