/**
 * P7 I2 VS Code user-facing Chat Participant / model-setup composition.
 *
 * This module is deliberately a presentation/setup layer. It registers only a
 * user-invoked Chat Participant through the documented public Chat API and
 * delegates model consent to the accepted public-model access controller.
 * It owns no QuaranGate operation/controller/writer authority and exposes no
 * implementation/mutation, command, terminal, workspace-fs, tool, listener or
 * server surface.
 */
import { IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES } from '../../shared/ideCompanionOperations.js';
import { IDE_OPERATION_ID_PATTERN, MAX_IDE_EVENT_MESSAGE_BYTES } from '../../shared/ideSessions.js';
import {
  type VsCodeModelAccessController,
  type VsCodeModelAccessResult,
  type VsCodeModelIdentity,
} from './vscodePublicApiModelExecution.js';

export const QUARANGATE_VSCODE_PARTICIPANT_ID = 'quarangate.ideChat';
export const QUARANGATE_VSCODE_PARTICIPANT_MAX_VISIBLE_ERROR_BYTES = 512;

export type VsCodeParticipantRegistrationBlock =
  | 'UNSUPPORTED_IDE'
  | 'UNSUPPORTED_REMOTE_HOST'
  | 'NOT_WORKSPACE_EXTENSION_HOST'
  | 'WORKSPACE_COUNT_INVALID';

export type VsCodeParticipantModelState =
  | 'NOT_CONFIGURED'
  | 'SETUP_REQUIRED'
  | 'CONSENT_REQUIRED'
  | 'ACCESS_DENIED'
  | 'ACCESS_REVOKED'
  | 'READY'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_SELECTION_AMBIGUOUS'
  | 'MODEL_IDENTITY_MISMATCH'
  | 'CANCELLED'
  | 'ERROR';

export type VsCodeParticipantConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'UNAVAILABLE';
export type VsCodeParticipantWorkspaceState = 'ATTESTED' | 'NOT_ATTESTED';
export type VsCodeParticipantTransportState = 'READY' | 'NOT_READY';

export interface VsCodeParticipantRegistrationContext {
  ideProduct: 'vscode' | string;
  remoteKind: 'wsl' | string | undefined;
  extensionHostKind: 'workspace' | 'ui' | string;
  workspaceFolderCount: number;
}

export interface VsCodeParticipantRuntimeReadiness {
  connection: VsCodeParticipantConnectionState;
  workspace: VsCodeParticipantWorkspaceState;
  transport: VsCodeParticipantTransportState;
}

export interface VsCodeParticipantReadinessPort {
  snapshot(): VsCodeParticipantRuntimeReadiness;
}

export interface VsCodeChatRequestPort {
  readonly prompt: string;
  readonly command: string | undefined;
}

export interface VsCodeChatContextPort {
  readonly history?: readonly unknown[];
}

export interface VsCodeChatResponseStreamPort {
  markdown(value: string): void;
  progress(value: string): void;
}

export interface VsCodeUserCancellationTokenPort {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface VsCodeChatResultPort {
  errorDetails?: { message: string };
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export type VsCodeChatRequestHandlerPort = (
  request: VsCodeChatRequestPort,
  context: VsCodeChatContextPort,
  response: VsCodeChatResponseStreamPort,
  token: VsCodeUserCancellationTokenPort,
) => Promise<VsCodeChatResultPort | void>;

export interface VsCodeChatParticipantPort {
  readonly id: string;
  dispose(): void;
}

/** Structural subset of vscode.chat used by this source-only composition. */
export interface VsCodeChatApiPort {
  createChatParticipant(id: string, handler: VsCodeChatRequestHandlerPort): VsCodeChatParticipantPort;
}

export type VsCodeGovernedReviewEvent = Readonly<{
  type: 'status' | 'assistant_chunk';
  message: string;
}>;

export type VsCodeGovernedReviewResult = Readonly<{
  operationId: string;
  terminalState: 'COMPLETED' | 'FAILED' | 'CANCELLED';
}>;

/**
 * Future production bridge contract for a USER request to ask QuaranGate to
 * admit a review. The participant supplies only prompt/cancellation/event sink;
 * it cannot supply operationId/project/worktree/session/controller/writer data.
 * A concrete bridge is intentionally not invented in this slice because I2.2
 * currently authorizes only QuaranGate-origin operations.
 */
export interface VsCodeGovernedReviewPort {
  requestReview(input: Readonly<{
    prompt: string;
    signal: AbortSignal;
    emit(event: VsCodeGovernedReviewEvent): void;
  }>): Promise<VsCodeGovernedReviewResult>;
}

export interface VsCodeParticipantSetupOptions {
  chat: VsCodeChatApiPort;
  registration: VsCodeParticipantRegistrationContext;
  readiness: VsCodeParticipantReadinessPort;
  modelAccess?: VsCodeModelAccessController;
  governedReview?: VsCodeGovernedReviewPort;
}

export type VsCodeParticipantRegistrationResult =
  | Readonly<{ registered: false; reason: VsCodeParticipantRegistrationBlock }>
  | Readonly<{ registered: true; participant: VsCodeChatParticipantPort; setup: VsCodeChatParticipantSetup }>;

function safeRegistrationContext(context: VsCodeParticipantRegistrationContext): VsCodeParticipantRegistrationBlock | undefined {
  if (context.ideProduct !== 'vscode') return 'UNSUPPORTED_IDE';
  if (context.remoteKind !== 'wsl') return 'UNSUPPORTED_REMOTE_HOST';
  if (context.extensionHostKind !== 'workspace') return 'NOT_WORKSPACE_EXTENSION_HOST';
  if (context.workspaceFolderCount !== 1) return 'WORKSPACE_COUNT_INVALID';
  return undefined;
}

function boundedVisibleText(value: string, limit = MAX_IDE_EVENT_MESSAGE_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  let out = '';
  for (const scalar of value) {
    if (Buffer.byteLength(out + scalar, 'utf8') > limit) break;
    out += scalar;
  }
  return out;
}

function boundedError(message: string): string {
  return boundedVisibleText(message, QUARANGATE_VSCODE_PARTICIPANT_MAX_VISIBLE_ERROR_BYTES);
}

function modelIdentityLabel(identity: VsCodeModelIdentity | undefined): string {
  if (identity === undefined) return 'none';
  return boundedVisibleText(`${identity.vendor}/${identity.id} (${identity.family} ${identity.version})`, 512);
}

function parseAction(request: VsCodeChatRequestPort): { action: 'status' | 'setup' | 'review' | 'help'; prompt?: string } {
  const explicit = request.command?.trim().toLowerCase();
  const body = request.prompt.trim();
  if (explicit === 'status' || explicit === 'setup') return { action: explicit };
  if (explicit === 'review') return { action: 'review', prompt: body };
  if (explicit !== undefined && explicit.length > 0) return { action: 'help' };
  if (body === '' || body.toLowerCase() === 'status') return { action: 'status' };
  if (body.toLowerCase() === 'setup') return { action: 'setup' };
  if (/^review(?:\s|$)/iu.test(body)) return { action: 'review', prompt: body.replace(/^review\s*/iu, '') };
  return { action: 'help' };
}

function validateReviewPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  const value = prompt.trim();
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES) return undefined;
  return value;
}

export class VsCodeChatParticipantSetup {
  private everReady = false;

  public constructor(private readonly options: VsCodeParticipantSetupOptions) {}

  public modelState(): { state: VsCodeParticipantModelState; identity?: VsCodeModelIdentity } {
    const access = this.options.modelAccess;
    if (access === undefined) return { state: 'NOT_CONFIGURED' };
    return this.mapModelState(access.currentState());
  }

  public statusSnapshot(): Readonly<{
    connection: VsCodeParticipantConnectionState;
    workspace: VsCodeParticipantWorkspaceState;
    transport: VsCodeParticipantTransportState;
    model: VsCodeParticipantModelState;
    modelIdentity?: VsCodeModelIdentity;
    governedReview: 'READY' | 'NOT_WIRED';
  }> {
    const runtime = this.options.readiness.snapshot();
    const model = this.modelState();
    return {
      ...runtime,
      model: model.state,
      ...(model.identity === undefined ? {} : { modelIdentity: model.identity }),
      governedReview: this.options.governedReview === undefined ? 'NOT_WIRED' : 'READY',
    };
  }

  public readonly handler: VsCodeChatRequestHandlerPort = async (request, _context, response, token) => {
    const action = parseAction(request);
    if (action.action === 'setup') return await this.handleSetup(response, token);
    if (action.action === 'review') return await this.handleReview(action.prompt, response, token);
    if (action.action === 'status') return this.handleStatus(response);
    response.markdown('QuaranGate supports `status`, `setup`, and `review <prompt>`. Review remains QuaranGate-governed and is unavailable until the governed review bridge is wired.');
    return { metadata: { action: 'help' } };
  };

  private handleStatus(response: VsCodeChatResponseStreamPort): VsCodeChatResultPort {
    const status = this.statusSnapshot();
    response.markdown(
      `QuaranGate setup: connection=${status.connection}, workspace=${status.workspace}, transport=${status.transport}, model=${status.model}, governedReview=${status.governedReview}.`,
    );
    if (status.modelIdentity !== undefined) response.markdown(`Model: ${modelIdentityLabel(status.modelIdentity)}.`);
    return {
      metadata: {
        action: 'status',
        connection: status.connection,
        workspace: status.workspace,
        transport: status.transport,
        model: status.model,
        governedReview: status.governedReview,
      },
    };
  }

  private async handleSetup(response: VsCodeChatResponseStreamPort, token: VsCodeUserCancellationTokenPort): Promise<VsCodeChatResultPort> {
    const access = this.options.modelAccess;
    if (access === undefined) {
      response.markdown('QuaranGate model setup is not configured for this extension instance.');
      return { metadata: { action: 'setup', model: 'NOT_CONFIGURED' } };
    }
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      response.progress('Checking the configured VS Code model and persisted access.');
      const result = await access.authorizeFromUserGesture(controller.signal);
      const mapped = this.mapModelState(result);
      if (mapped.state === 'READY') this.everReady = true;
      response.markdown(this.setupMessage(mapped.state, mapped.identity));
      return {
        metadata: {
          action: 'setup',
          model: mapped.state,
          ...(mapped.identity === undefined ? {} : {
            modelVendor: mapped.identity.vendor,
            modelId: mapped.identity.id,
            modelFamily: mapped.identity.family,
            modelVersion: mapped.identity.version,
          }),
        },
      };
    } catch {
      response.markdown('QuaranGate model setup failed safely. No remote review was started.');
      return { errorDetails: { message: boundedError('QuaranGate model setup failed safely.') }, metadata: { action: 'setup', model: 'ERROR' } };
    } finally {
      subscription.dispose();
    }
  }

  private async handleReview(
    prompt: string | undefined,
    response: VsCodeChatResponseStreamPort,
    token: VsCodeUserCancellationTokenPort,
  ): Promise<VsCodeChatResultPort> {
    const boundedPrompt = validateReviewPrompt(prompt);
    if (boundedPrompt === undefined) {
      response.markdown('A bounded non-empty review prompt is required.');
      return { errorDetails: { message: 'A bounded non-empty review prompt is required.' }, metadata: { action: 'review', outcome: 'REJECTED' } };
    }
    const status = this.statusSnapshot();
    if (status.connection !== 'CONNECTED' || status.workspace !== 'ATTESTED' || status.transport !== 'READY' || status.model !== 'READY') {
      response.markdown('QuaranGate review is not ready. Run `status` and complete `setup` first.');
      return { metadata: { action: 'review', outcome: 'NOT_READY' } };
    }
    const review = this.options.governedReview;
    if (review === undefined) {
      response.markdown('Governed review submission is not wired in this source slice. No operation was created and no model request was sent.');
      return { metadata: { action: 'review', outcome: 'NOT_WIRED' } };
    }

    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      const result = await review.requestReview({
        prompt: boundedPrompt,
        signal: controller.signal,
        emit: (event) => {
          const text = boundedVisibleText(event.message);
          if (event.type === 'status') response.progress(text);
          else response.markdown(text);
        },
      });
      if (!IDE_OPERATION_ID_PATTERN.test(result.operationId)) {
        response.markdown('QuaranGate returned an invalid operation identity; the result was rejected.');
        return { errorDetails: { message: 'QuaranGate returned an invalid operation identity.' }, metadata: { action: 'review', outcome: 'REJECTED' } };
      }
      response.progress(`QuaranGate operation ${result.operationId} ${result.terminalState.toLowerCase()}.`);
      return { metadata: { action: 'review', outcome: result.terminalState, operationId: result.operationId } };
    } catch {
      response.markdown('QuaranGate governed review failed safely.');
      return { errorDetails: { message: boundedError('QuaranGate governed review failed safely.') }, metadata: { action: 'review', outcome: 'FAILED' } };
    } finally {
      subscription.dispose();
    }
  }

  private mapModelState(result: VsCodeModelAccessResult): { state: VsCodeParticipantModelState; identity?: VsCodeModelIdentity } {
    let state: VsCodeParticipantModelState;
    switch (result.state) {
      case 'MODEL_PREPARATION_REQUIRED': state = 'SETUP_REQUIRED'; break;
      case 'MODEL_AVAILABLE':
      case 'MODEL_ACCESS_ALLOWED': state = 'READY'; this.everReady = true; break;
      case 'MODEL_CONSENT_REQUIRED': state = this.everReady ? 'MODEL_UNAVAILABLE' : 'CONSENT_REQUIRED'; break;
      case 'MODEL_ACCESS_DENIED': state = this.everReady ? 'ACCESS_REVOKED' : 'ACCESS_DENIED'; break;
      case 'MODEL_UNAVAILABLE': state = 'MODEL_UNAVAILABLE'; break;
      case 'MODEL_SELECTION_AMBIGUOUS': state = 'MODEL_SELECTION_AMBIGUOUS'; break;
      case 'MODEL_IDENTITY_MISMATCH': state = 'MODEL_IDENTITY_MISMATCH'; break;
      case 'MODEL_PREPARATION_CANCELLED': state = 'CANCELLED'; break;
      case 'MODEL_PREPARATION_FAILED': state = 'ERROR'; break;
    }
    return result.identity === undefined ? { state } : { state, identity: result.identity };
  }

  private setupMessage(state: VsCodeParticipantModelState, identity: VsCodeModelIdentity | undefined): string {
    if (state === 'READY') return `QuaranGate model access is ready: ${modelIdentityLabel(identity)}.`;
    if (state === 'CONSENT_REQUIRED') return 'VS Code model consent is still required. No remote review will trigger consent UI.';
    if (state === 'ACCESS_DENIED') return 'VS Code model access was denied. No remote review will be sent.';
    if (state === 'ACCESS_REVOKED') return 'VS Code model access was revoked. QuaranGate remote review is disabled until setup succeeds again.';
    if (state === 'MODEL_UNAVAILABLE') return 'The configured VS Code model is unavailable.';
    if (state === 'MODEL_SELECTION_AMBIGUOUS') return 'The configured VS Code model selector did not resolve exactly one model.';
    if (state === 'MODEL_IDENTITY_MISMATCH') return 'The resolved VS Code model identity does not match the configured selector.';
    if (state === 'CANCELLED') return 'QuaranGate model setup was cancelled.';
    if (state === 'SETUP_REQUIRED') return 'QuaranGate model setup is required.';
    return 'QuaranGate model setup failed safely.';
  }
}

export function registerVsCodeChatParticipantSetup(options: VsCodeParticipantSetupOptions): VsCodeParticipantRegistrationResult {
  const blocked = safeRegistrationContext(options.registration);
  if (blocked !== undefined) return { registered: false, reason: blocked };
  const setup = new VsCodeChatParticipantSetup(options);
  const participant = options.chat.createChatParticipant(QUARANGATE_VSCODE_PARTICIPANT_ID, setup.handler);
  if (participant.id !== QUARANGATE_VSCODE_PARTICIPANT_ID) {
    participant.dispose();
    throw new Error('VS Code Chat Participant registration returned an unexpected identity');
  }
  return { registered: true, participant, setup };
}
