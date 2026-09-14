/**
 * P7 I2.2 VS Code-side QuaranGate-origin command/event channel.
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
  type IdeRemoteServerFrame,
} from '../../shared/ideCompanionRemoteTransport.js';
import { serializeIdeWorkspaceAttestation, type IdeWorkspacePhysicalIdentity } from '../../shared/ideWorkspaceAttestation.js';
import type { VsCodeCompanionConnection } from './vscodeCompanionConnection.js';
import { readVsCodeCompanionCredential, type VsCodeCompanionCredential } from './vscodeCompanionCredential.js';

export const VSCODE_REMOTE_AUTH_LIFETIME_MS = 20_000;
export const VSCODE_REMOTE_MAX_BUFFER_BYTES = IDE_REMOTE_TRANSPORT_MAX_FRAME_BYTES * 2;
export const VSCODE_REMOTE_MAX_WRITE_QUEUE_BYTES = 64 * 1024;
export const VSCODE_REMOTE_WORKSPACE_RECHECK_TIMEOUT_MS = 20_000;

export type VsCodeCommandChannelErrorCode =
  | 'VSCODE_REMOTE_CHANNEL_CLOSED'
  | 'VSCODE_REMOTE_BINDING_MISMATCH'
  | 'VSCODE_REMOTE_SEQUENCE_INVALID'
  | 'VSCODE_REMOTE_STATE_INVALID'
  | 'VSCODE_REMOTE_HANDLER_UNAVAILABLE'
  | 'VSCODE_REMOTE_WRITE_FAILED';

export class VsCodeCommandChannelError extends Error {
  constructor(public readonly code: VsCodeCommandChannelErrorCode, message: string) {
    super(message);
    this.name = 'VsCodeCommandChannelError';
  }
}

export interface VsCodeRemoteOperationInput {
  operationId: string;
  prompt: string;
  signal: AbortSignal;
  emit(type: IdeRemoteAdapterEventType, message?: string): void;
}
export interface VsCodeRemoteReviewHandler { run(input: VsCodeRemoteOperationInput): Promise<void>; }
export interface VsCodeRemoteImplementationHandler {
  run(input: VsCodeRemoteOperationInput): Promise<{ outcome: IdeRemoteImplementationOutcome }>;
}

export interface VsCodeCommandChannelOptions {
  connection: VsCodeCompanionConnection;
  credentialBinding: Omit<VsCodeCompanionCredential, 'secret'>;
  collectWorkspace(): Promise<IdeWorkspacePhysicalIdentity>;
  reviewHandler?: VsCodeRemoteReviewHandler;
  implementationHandler?: VsCodeRemoteImplementationHandler;
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

function fail(code: VsCodeCommandChannelErrorCode, message: string): never {
  throw new VsCodeCommandChannelError(code, message);
}

export class VsCodeCommandChannel {
  private readonly socket: Socket;
  private readonly clock: () => number;
  private readonly rng: (size:number)=>Buffer;
  private expectedCommandSequence = 1;
  private buffer = Buffer.alloc(0);
  private chain = Promise.resolve();
  private started = false;
  private closed = false;
  private authorized?: AuthorizedOperation;
  private active?: ActiveOperation;

  constructor(private readonly opts: VsCodeCommandChannelOptions) {
    this.socket = opts.connection.socket;
    this.clock = opts.nowMs ?? (() => Date.now());
    this.rng = opts.randomBytes ?? randomBytes;
    const binding = opts.credentialBinding;
    if (binding.credentialPath.length === 0 || binding.adapterVersion.length === 0) {
      fail('VSCODE_REMOTE_BINDING_MISMATCH', 'credential binding is incomplete');
    }
  }

  start(): void {
    if (this.started || this.closed) fail('VSCODE_REMOTE_STATE_INVALID', 'VS Code command channel cannot be started in current state');
    this.started = true;
    this.socket.on('data', this.onData);
    this.socket.once('close', this.onClose);
    this.socket.once('error', this.onError);
    this.write({version:1,type:'transport_ready',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration});
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.active?.controller.abort(new Error('VS Code command channel stopped'));
    this.active = undefined;
    this.authorized = undefined;
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.closed) return;
    if (this.buffer.byteLength + chunk.byteLength > VSCODE_REMOTE_MAX_BUFFER_BYTES) {
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
  private readonly onClose = (): void => { this.closed = true; this.detach(); this.active?.controller.abort(new Error('authenticated QuaranGate connection closed')); };
  private readonly onError = (): void => { this.failClosed(); };

  private async handleFrame(bytes: Buffer): Promise<void> {
    if (this.closed) return;
    const frame = parseIdeRemoteServerFrame(bytes);
    this.assertCommon(frame);
    if (frame.commandSequence !== this.expectedCommandSequence) {
      fail('VSCODE_REMOTE_SEQUENCE_INVALID', 'QuaranGate command sequence is stale, replayed or skipped');
    }
    this.expectedCommandSequence += 1;
    if (frame.type === 'authorize_operation') { await this.authorize(frame); return; }
    if (frame.type === 'execute_operation') { await this.execute(frame); return; }
    this.cancel(frame);
  }

  private async authorize(frame: Extract<IdeRemoteServerFrame,{type:'authorize_operation'}>): Promise<void> {
    if (this.authorized !== undefined || this.active !== undefined) fail('VSCODE_REMOTE_STATE_INVALID', 'operation already authorized or active');
    const credential = readVsCodeCompanionCredential(this.opts.credentialBinding.credentialPath, this.opts.credentialBinding.adapterVersion);
    try {
      this.assertCredentialBinding(credential);
      const workspace = await this.opts.collectWorkspace();
      const workspaceAttestation = serializeIdeWorkspaceAttestation({
        version:1,
        enrollmentId:credential.enrollmentId,
        ideInstanceId:credential.ideInstanceId,
        runtimeInstanceId:credential.runtimeInstanceId,
        ideProduct:'vscode',
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
      if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - VSCODE_REMOTE_AUTH_LIFETIME_MS) {
        fail('VSCODE_REMOTE_STATE_INVALID', 'local clock is invalid');
      }
      const nonceBytes = this.rng(32);
      if (!Buffer.isBuffer(nonceBytes) || nonceBytes.byteLength !== 32) fail('VSCODE_REMOTE_STATE_INVALID', 'nonce source did not return 32 bytes');
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
        expiresAtMs:now+VSCODE_REMOTE_AUTH_LIFETIME_MS,
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
      fail('VSCODE_REMOTE_STATE_INVALID','execute command lacks exact prior authorization');
    }
    if (frame.capability==='request_review' && this.opts.reviewHandler===undefined) fail('VSCODE_REMOTE_HANDLER_UNAVAILABLE','review handler is unavailable');
    if (frame.capability==='request_implementation' && this.opts.implementationHandler===undefined) fail('VSCODE_REMOTE_HANDLER_UNAVAILABLE','implementation handler is unavailable');

    // Close the authorization->execution TOCTOU gap without creating a second
    // authority protocol: re-read the current B4 binding and re-collect exact
    // B5 evidence immediately before invoking any vendor/model handler. The
    // fresh canonical attestation must be byte-identical to the B3-authenticated
    // operation attestation. A mismatch is a proven pre-mutation failure.
    try {
      const currentWorkspaceAttestation = await this.collectExecutionWorkspaceAttestation();
      if (currentWorkspaceAttestation !== authorized.workspaceAttestation) {
        fail('VSCODE_REMOTE_BINDING_MISMATCH','workspace identity changed after operation authorization');
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
    const credential = readVsCodeCompanionCredential(this.opts.credentialBinding.credentialPath, this.opts.credentialBinding.adapterVersion);
    let timer: NodeJS.Timeout | undefined;
    try {
      this.assertCredentialBinding(credential);
      const workspace = await Promise.race([
        this.opts.collectWorkspace(),
        new Promise<never>((_resolve,reject)=>{
          timer=setTimeout(()=>reject(new VsCodeCommandChannelError('VSCODE_REMOTE_STATE_INVALID','execution workspace re-attestation timed out')),VSCODE_REMOTE_WORKSPACE_RECHECK_TIMEOUT_MS);
        }),
      ]);
      return serializeIdeWorkspaceAttestation({
        version:1,
        enrollmentId:credential.enrollmentId,
        ideInstanceId:credential.ideInstanceId,
        runtimeInstanceId:credential.runtimeInstanceId,
        ideProduct:'vscode',
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
    if(active===undefined||active.operationId!==frame.operationId) fail('VSCODE_REMOTE_STATE_INVALID','cancel does not name exact active operation');
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
  private handlerInput(active:ActiveOperation):VsCodeRemoteOperationInput{
    return{operationId:active.operationId,prompt:active.prompt,signal:active.controller.signal,emit:(type,message)=>{
      if(this.active!==active||active.controller.signal.aborted||this.closed)return;
      this.write({version:1,type:'adapter_event',sessionId:this.opts.connection.sessionId,connectionGeneration:this.opts.connection.connectionGeneration,operationId:active.operationId,eventSequence:active.nextEventSequence,eventType:type,...(message===undefined?{}:{message})});
      active.nextEventSequence+=1;
    }};
  }

  private assertCommon(frame:IdeRemoteServerFrame):void{
    if(frame.sessionId!==this.opts.connection.sessionId||frame.connectionGeneration!==this.opts.connection.connectionGeneration) {
      fail('VSCODE_REMOTE_BINDING_MISMATCH','QuaranGate command does not match authenticated session/generation');
    }
  }
  private assertCredentialBinding(current:VsCodeCompanionCredential):void{
    const expected=this.opts.credentialBinding;
    const fields:Array<[unknown,unknown]>=[
      [current.runtimeInstanceId,expected.runtimeInstanceId],[current.enrollmentId,expected.enrollmentId],[current.ideInstanceId,expected.ideInstanceId],
      [current.ideProduct,expected.ideProduct],[current.adapterId,expected.adapterId],[current.adapterVersion,expected.adapterVersion],
      [current.credentialPath,expected.credentialPath],[current.socketPath,expected.socketPath],
    ];
    if(fields.some(([a,b])=>a!==b)) fail('VSCODE_REMOTE_BINDING_MISMATCH','current B4 credential no longer matches authenticated runtime binding');
  }
  private write(frame:Parameters<typeof serializeIdeRemoteClientFrame>[0]):void{
    if(this.closed||this.socket.destroyed)fail('VSCODE_REMOTE_CHANNEL_CLOSED','VS Code remote channel is closed');
    let encoded:string;
    try{encoded=serializeIdeRemoteClientFrame(frame);}catch{this.failClosed();fail('VSCODE_REMOTE_WRITE_FAILED','VS Code remote response is outside protocol bounds');}
    const body=Buffer.from(`${encoded}\n`,'utf8');
    if(body.byteLength>VSCODE_REMOTE_MAX_WRITE_QUEUE_BYTES||this.socket.writableLength+body.byteLength>VSCODE_REMOTE_MAX_WRITE_QUEUE_BYTES){this.failClosed();fail('VSCODE_REMOTE_WRITE_FAILED','VS Code remote response queue exceeded bound');}
    try { this.socket.write(body); }
    catch { this.failClosed(); fail('VSCODE_REMOTE_WRITE_FAILED','VS Code remote response write failed'); }
  }
  private failClosed():void{if(this.closed)return;this.closed=true;this.detach();this.active?.controller.abort(new Error('VS Code remote channel failed closed'));this.socket.destroy();}
  private detach():void{this.socket.off('data',this.onData);this.socket.off('close',this.onClose);this.socket.off('error',this.onError);}
}
