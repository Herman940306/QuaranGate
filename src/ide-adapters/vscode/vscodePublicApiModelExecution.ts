/**
 * P7 I2 VS Code supported public-API model execution foundation.
 *
 * This module is intentionally review-only and source-only. It is designed to
 * be injected as the I2.2 `reviewHandler` after QuaranGate has already admitted
 * the exact B7 operation. It does not own transport, operation identity,
 * controller/writer authority, Chat Participant invocation, workspace access,
 * commands, tools, or mutation APIs.
 *
 * Public VS Code API mapping (qualified against the repository-pinned
 * @types/vscode 1.109.0 contract):
 * - vscode.lm.selectChatModels(selector)
 * - ExtensionContext.languageModelAccessInformation.canSendRequest(model)
 * - vscode.LanguageModelChatMessage.User(prompt)
 * - LanguageModelChat.countTokens(...)
 * - LanguageModelChat.sendRequest(...)
 * - LanguageModelChatResponse.text
 * - vscode.CancellationTokenSource
 *
 * The adapter keeps those objects behind a narrow structural seam so the root
 * QuaranGate package does not gain a runtime dependency on the VS Code module.
 */
import { IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES } from '../../shared/ideCompanionOperations.js';
import { MAX_IDE_EVENT_MESSAGE_BYTES } from '../../shared/ideSessions.js';
import type { VsCodeRemoteOperationInput, VsCodeRemoteReviewHandler } from './vscodeCommandChannel.js';

export const VSCODE_MODEL_SELECTOR_MAX_FIELD_BYTES = 256;
export const VSCODE_MODEL_MAX_OUTPUT_BYTES = 64 * 1024;

export type VsCodeModelAccessState =
  | 'MODEL_PREPARATION_REQUIRED'
  | 'MODEL_AVAILABLE'
  | 'MODEL_ACCESS_ALLOWED'
  | 'MODEL_CONSENT_REQUIRED'
  | 'MODEL_ACCESS_DENIED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_SELECTION_AMBIGUOUS'
  | 'MODEL_IDENTITY_MISMATCH'
  | 'MODEL_PREPARATION_FAILED';

export type VsCodeModelExecutionErrorCode =
  | 'VSCODE_MODEL_PREPARATION_REQUIRED'
  | 'VSCODE_MODEL_CONSENT_REQUIRED'
  | 'VSCODE_MODEL_ACCESS_DENIED'
  | 'VSCODE_MODEL_UNAVAILABLE'
  | 'VSCODE_MODEL_SELECTION_AMBIGUOUS'
  | 'VSCODE_MODEL_IDENTITY_MISMATCH'
  | 'VSCODE_MODEL_PROMPT_INVALID'
  | 'VSCODE_MODEL_INPUT_LIMIT'
  | 'VSCODE_MODEL_OUTPUT_LIMIT'
  | 'VSCODE_MODEL_RESPONSE_INVALID'
  | 'VSCODE_MODEL_RESPONSE_EMPTY'
  | 'VSCODE_MODEL_REQUEST_BLOCKED'
  | 'VSCODE_MODEL_REQUEST_FAILED'
  | 'VSCODE_MODEL_CANCELLED';

export class VsCodeModelExecutionError extends Error {
  constructor(public readonly code: VsCodeModelExecutionErrorCode, message: string) {
    super(message);
    this.name = 'VsCodeModelExecutionError';
  }
}

export interface VsCodeExactModelSelector {
  vendor: string;
  id: string;
  family: string;
  version: string;
}

export interface VsCodeModelIdentity extends VsCodeExactModelSelector {
  name: string;
}

/** Opaque public VS Code cancellation token. */
export interface VsCodeCancellationToken {
  readonly isCancellationRequested: boolean;
}

/** Structural subset of vscode.CancellationTokenSource. */
export interface VsCodeCancellationTokenSource {
  readonly token: VsCodeCancellationToken;
  cancel(): void;
  dispose(): void;
}

/** Opaque public VS Code language-model message created by LanguageModelChatMessage.User. */
export interface VsCodeLanguageModelMessage {
  readonly __quarangateOpaqueMessageBrand?: never;
}

export interface VsCodeLanguageModelResponse {
  readonly text: AsyncIterable<string>;
}

/** Structural subset of vscode.LanguageModelChat used by this review-only adapter. */
export interface VsCodeLanguageModelChat {
  readonly vendor: string;
  readonly id: string;
  readonly family: string;
  readonly version: string;
  readonly name: string;
  readonly maxInputTokens: number;
  countTokens(text: string, token?: VsCodeCancellationToken): PromiseLike<number>;
  sendRequest(
    messages: VsCodeLanguageModelMessage[],
    options?: undefined,
    token?: VsCodeCancellationToken,
  ): PromiseLike<VsCodeLanguageModelResponse>;
}

/**
 * Narrow public API seam implemented by the future VS Code composition root.
 * `selectChatModels` is intentionally reachable only from the explicit
 * user-gesture preparation method below, never from a remote operation.
 */
export interface VsCodePublicLanguageModelApi {
  selectChatModels(selector: VsCodeExactModelSelector): PromiseLike<readonly VsCodeLanguageModelChat[]>;
  canSendRequest(model: VsCodeLanguageModelChat): boolean | undefined;
  createUserMessage(prompt: string): VsCodeLanguageModelMessage;
  createCancellationTokenSource(): VsCodeCancellationTokenSource;
}

export interface VsCodePublicModulePort {
  readonly lm: {
    selectChatModels(selector: VsCodeExactModelSelector): PromiseLike<readonly VsCodeLanguageModelChat[]>;
  };
  readonly LanguageModelChatMessage: {
    User(content: string): VsCodeLanguageModelMessage;
  };
  readonly CancellationTokenSource: new () => VsCodeCancellationTokenSource;
}

export interface VsCodeLanguageModelAccessInformationPort {
  canSendRequest(model: VsCodeLanguageModelChat): boolean | undefined;
}

/**
 * Exact documented-public-API binding used later by the extension composition
 * root. Keeping the module/context objects outside the review handler prevents
 * ambient VS Code authority from reaching model-controlled execution.
 */
export function createVsCodePublicLanguageModelApi(
  vscodeApi: VsCodePublicModulePort,
  accessInformation: VsCodeLanguageModelAccessInformationPort,
): VsCodePublicLanguageModelApi {
  return Object.freeze({
    selectChatModels: (selector: VsCodeExactModelSelector) => vscodeApi.lm.selectChatModels(selector),
    canSendRequest: (model: VsCodeLanguageModelChat) => accessInformation.canSendRequest(model),
    createUserMessage: (prompt: string) => vscodeApi.LanguageModelChatMessage.User(prompt),
    createCancellationTokenSource: () => new vscodeApi.CancellationTokenSource(),
  });
}

export interface VsCodeModelAccessResult {
  state: VsCodeModelAccessState;
  identity?: VsCodeModelIdentity;
}

interface PreparedModel {
  model: VsCodeLanguageModelChat;
  identity: VsCodeModelIdentity;
}

function fail(code: VsCodeModelExecutionErrorCode, message: string): never {
  throw new VsCodeModelExecutionError(code, message);
}

function assertSelectorField(value: string, field: keyof VsCodeExactModelSelector): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > VSCODE_MODEL_SELECTOR_MAX_FIELD_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`VS Code model selector ${field} is invalid`);
  }
}

function exactSelector(selector: VsCodeExactModelSelector): VsCodeExactModelSelector {
  assertSelectorField(selector.vendor, 'vendor');
  assertSelectorField(selector.id, 'id');
  assertSelectorField(selector.family, 'family');
  assertSelectorField(selector.version, 'version');
  return Object.freeze({ ...selector });
}

function identity(model: VsCodeLanguageModelChat): VsCodeModelIdentity {
  return {
    vendor: model.vendor,
    id: model.id,
    family: model.family,
    version: model.version,
    name: model.name,
  };
}

function matchesSelector(model: VsCodeLanguageModelChat, selector: VsCodeExactModelSelector): boolean {
  return model.vendor === selector.vendor
    && model.id === selector.id
    && model.family === selector.family
    && model.version === selector.version;
}

function isSafeModelMetadata(model: VsCodeLanguageModelChat): boolean {
  if (!Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens < 1) return false;
  for (const value of [model.vendor, model.id, model.family, model.version]) {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1
      || Buffer.byteLength(value, 'utf8') > VSCODE_MODEL_SELECTOR_MAX_FIELD_BYTES
      || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  }
  return typeof model.name === 'string' && Buffer.byteLength(model.name, 'utf8') <= 1024;
}

function publicProviderCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function mapProviderFailure(error: unknown, signal: AbortSignal): never {
  if (error instanceof VsCodeModelExecutionError) throw error;
  if (signal.aborted) fail('VSCODE_MODEL_CANCELLED', 'VS Code model operation was cancelled');
  const code = publicProviderCode(error);
  if (code === 'NoPermissions') fail('VSCODE_MODEL_CONSENT_REQUIRED', 'VS Code model access requires user consent');
  if (code === 'NotFound') fail('VSCODE_MODEL_UNAVAILABLE', 'VS Code model is unavailable');
  if (code === 'Blocked') fail('VSCODE_MODEL_REQUEST_BLOCKED', 'VS Code model request was blocked');
  fail('VSCODE_MODEL_REQUEST_FAILED', 'VS Code model request failed');
}

function* splitUtf8Bounded(value: string, maxBytes: number): Generator<string> {
  let current = '';
  let currentBytes = 0;
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (currentBytes + scalarBytes > maxBytes) {
      if (current.length > 0) yield current;
      current = scalar;
      currentBytes = scalarBytes;
    } else {
      current += scalar;
      currentBytes += scalarBytes;
    }
  }
  if (current.length > 0) yield current;
}

/**
 * Consent/model bootstrap. The only method that calls selectChatModels is
 * explicitly named for a user gesture. A remote operation cannot cause model
 * selection or first-use consent UI through this object.
 */
export class VsCodeModelAccessController {
  private readonly selector: VsCodeExactModelSelector;
  private prepared?: PreparedModel;
  private lastState: VsCodeModelAccessState = 'MODEL_PREPARATION_REQUIRED';

  constructor(private readonly api: VsCodePublicLanguageModelApi, selector: VsCodeExactModelSelector) {
    this.selector = exactSelector(selector);
  }

  public async prepareFromUserGesture(): Promise<VsCodeModelAccessResult> {
    this.prepared = undefined;
    let models: readonly VsCodeLanguageModelChat[];
    try {
      models = await this.api.selectChatModels(this.selector);
    } catch (error) {
      const code = publicProviderCode(error);
      if (code === 'NoPermissions') return this.record({ state: 'MODEL_CONSENT_REQUIRED' });
      if (code === 'NotFound') return this.record({ state: 'MODEL_UNAVAILABLE' });
      return this.record({ state: 'MODEL_PREPARATION_FAILED' });
    }
    if (!Array.isArray(models) || models.length === 0) return this.record({ state: 'MODEL_UNAVAILABLE' });
    if (models.length !== 1) return this.record({ state: 'MODEL_SELECTION_AMBIGUOUS' });
    const model = models[0];
    if (model === undefined || !isSafeModelMetadata(model) || !matchesSelector(model, this.selector)) {
      return this.record({ state: 'MODEL_IDENTITY_MISMATCH' });
    }
    const modelIdentity = identity(model);
    const access = this.api.canSendRequest(model);
    if (access === undefined) return this.record({ state: 'MODEL_CONSENT_REQUIRED', identity: modelIdentity });
    if (access !== true) return this.record({ state: 'MODEL_ACCESS_DENIED', identity: modelIdentity });
    this.prepared = { model, identity: modelIdentity };
    return this.record({ state: 'MODEL_ACCESS_ALLOWED', identity: modelIdentity });
  }

  public invalidate(): void {
    this.prepared = undefined;
    this.lastState = 'MODEL_PREPARATION_REQUIRED';
  }

  public currentState(): VsCodeModelAccessResult {
    const prepared = this.prepared;
    if (prepared === undefined) return { state: this.lastState };
    if (!isSafeModelMetadata(prepared.model) || !matchesSelector(prepared.model, this.selector)) {
      this.prepared = undefined;
      return this.record({ state: 'MODEL_IDENTITY_MISMATCH' });
    }
    const access = this.api.canSendRequest(prepared.model);
    if (access === undefined) {
      this.prepared = undefined;
      return this.record({ state: 'MODEL_CONSENT_REQUIRED', identity: prepared.identity });
    }
    if (access !== true) {
      this.prepared = undefined;
      return this.record({ state: 'MODEL_ACCESS_DENIED', identity: prepared.identity });
    }
    return { state: 'MODEL_AVAILABLE', identity: prepared.identity };
  }

  public remoteAccess(): VsCodeRemoteModelAccess {
    return Object.freeze({ requireRemoteModel: () => this.requireRemoteModel() });
  }

  private record(result: VsCodeModelAccessResult): VsCodeModelAccessResult {
    this.lastState = result.state;
    return result;
  }

  private requireRemoteModel(): VsCodeLanguageModelChat {
    const prepared = this.prepared;
    if (prepared === undefined) {
      if (this.lastState === 'MODEL_CONSENT_REQUIRED') fail('VSCODE_MODEL_CONSENT_REQUIRED', 'VS Code model access requires user consent');
      if (this.lastState === 'MODEL_ACCESS_DENIED') fail('VSCODE_MODEL_ACCESS_DENIED', 'VS Code model access is not allowed');
      if (this.lastState === 'MODEL_UNAVAILABLE') fail('VSCODE_MODEL_UNAVAILABLE', 'VS Code model is unavailable');
      if (this.lastState === 'MODEL_SELECTION_AMBIGUOUS') fail('VSCODE_MODEL_SELECTION_AMBIGUOUS', 'VS Code model selector did not resolve exactly one model');
      if (this.lastState === 'MODEL_IDENTITY_MISMATCH') fail('VSCODE_MODEL_IDENTITY_MISMATCH', 'VS Code model identity does not match the exact allowed selector');
      if (this.lastState === 'MODEL_PREPARATION_FAILED') fail('VSCODE_MODEL_REQUEST_FAILED', 'VS Code model preparation failed');
      fail('VSCODE_MODEL_PREPARATION_REQUIRED', 'VS Code model access must be prepared by an explicit user action');
    }
    if (!isSafeModelMetadata(prepared.model) || !matchesSelector(prepared.model, this.selector)) {
      this.prepared = undefined;
      fail('VSCODE_MODEL_IDENTITY_MISMATCH', 'VS Code model identity no longer matches the exact allowed selector');
    }
    const access = this.api.canSendRequest(prepared.model);
    if (access === undefined) {
      this.prepared = undefined;
      fail('VSCODE_MODEL_CONSENT_REQUIRED', 'VS Code model access requires user consent');
    }
    if (access !== true) {
      this.prepared = undefined;
      fail('VSCODE_MODEL_ACCESS_DENIED', 'VS Code model access is not allowed');
    }
    return prepared.model;
  }
}

export interface VsCodeRemoteModelAccess {
  requireRemoteModel(): VsCodeLanguageModelChat;
}

export interface VsCodePublicApiReviewHandlerOptions {
  api: VsCodePublicLanguageModelApi;
  /** Narrow machine-side view: no model discovery/consent method is exposed. */
  access: VsCodeRemoteModelAccess;
  maxOutputBytes?: number;
}

/** Review-only handler. There is deliberately no implementation handler. */
export class VsCodePublicApiReviewHandler implements VsCodeRemoteReviewHandler {
  private readonly maxOutputBytes: number;

  constructor(private readonly options: VsCodePublicApiReviewHandlerOptions) {
    this.maxOutputBytes = options.maxOutputBytes ?? VSCODE_MODEL_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1
      || this.maxOutputBytes > VSCODE_MODEL_MAX_OUTPUT_BYTES) {
      throw new TypeError('VS Code model output byte bound is invalid');
    }
  }

  public async run(input: VsCodeRemoteOperationInput): Promise<void> {
    const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
    if (promptBytes < 1 || promptBytes > IDE_COMPANION_OPERATION_MAX_PROMPT_BYTES) {
      fail('VSCODE_MODEL_PROMPT_INVALID', 'VS Code model prompt is outside the admitted I2.2 bound');
    }
    if (input.signal.aborted) fail('VSCODE_MODEL_CANCELLED', 'VS Code model operation was cancelled');

    const model = this.options.access.requireRemoteModel();
    const cancellation = this.options.api.createCancellationTokenSource();
    const abort = (): void => cancellation.cancel();
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal.aborted) {
        cancellation.cancel();
        fail('VSCODE_MODEL_CANCELLED', 'VS Code model operation was cancelled');
      }

      let tokenCount: number;
      try {
        tokenCount = await model.countTokens(input.prompt, cancellation.token);
      } catch (error) {
        mapProviderFailure(error, input.signal);
      }
      if (!Number.isSafeInteger(tokenCount!) || tokenCount! < 0 || tokenCount! > model.maxInputTokens) {
        fail('VSCODE_MODEL_INPUT_LIMIT', 'VS Code model prompt exceeds the selected model input bound');
      }

      let response: VsCodeLanguageModelResponse;
      try {
        const message = this.options.api.createUserMessage(input.prompt);
        response = await model.sendRequest([message], undefined, cancellation.token);
      } catch (error) {
        mapProviderFailure(error, input.signal);
      }
      if (response! === undefined || response!.text === undefined
        || typeof (response!.text as AsyncIterable<string>)[Symbol.asyncIterator] !== 'function') {
        fail('VSCODE_MODEL_RESPONSE_INVALID', 'VS Code model returned an invalid text stream');
      }

      let totalBytes = 0;
      try {
        for await (const chunk of response!.text) {
          if (input.signal.aborted || cancellation.token.isCancellationRequested) {
            fail('VSCODE_MODEL_CANCELLED', 'VS Code model operation was cancelled');
          }
          if (typeof chunk !== 'string') fail('VSCODE_MODEL_RESPONSE_INVALID', 'VS Code model returned a non-text response chunk');
          const chunkBytes = Buffer.byteLength(chunk, 'utf8');
          if (chunkBytes === 0) continue;
          totalBytes += chunkBytes;
          if (totalBytes > this.maxOutputBytes) {
            cancellation.cancel();
            fail('VSCODE_MODEL_OUTPUT_LIMIT', 'VS Code model output exceeded the configured byte bound');
          }
          for (const bounded of splitUtf8Bounded(chunk, MAX_IDE_EVENT_MESSAGE_BYTES)) {
            if (input.signal.aborted || cancellation.token.isCancellationRequested) {
              fail('VSCODE_MODEL_CANCELLED', 'VS Code model operation was cancelled');
            }
            input.emit('assistant_chunk', bounded);
          }
        }
      } catch (error) {
        mapProviderFailure(error, input.signal);
      }
      if (input.signal.aborted || cancellation.token.isCancellationRequested) {
        fail('VSCODE_MODEL_CANCELLED', 'VS Code model operation was cancelled');
      }
      if (totalBytes === 0) fail('VSCODE_MODEL_RESPONSE_EMPTY', 'VS Code model produced no bounded text output');
    } finally {
      input.signal.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  }
}

export interface VsCodePublicApiExecutionFoundation {
  access: VsCodeModelAccessController;
  reviewHandler: VsCodeRemoteReviewHandler;
}

/**
 * Source-only composition helper. It intentionally exposes no implementation
 * handler and no Chat Participant/machine listener entrypoint.
 */
export function createVsCodePublicApiExecutionFoundation(
  api: VsCodePublicLanguageModelApi,
  selector: VsCodeExactModelSelector,
): VsCodePublicApiExecutionFoundation {
  const access = new VsCodeModelAccessController(api, selector);
  return {
    access,
    reviewHandler: new VsCodePublicApiReviewHandler({ api, access: access.remoteAccess() }),
  };
}
