import { describe, expect, it } from 'vitest';
import { MAX_IDE_EVENT_MESSAGE_BYTES } from '../../src/shared/ideSessions.js';
import {
  VSCODE_MODEL_MAX_OUTPUT_BYTES,
  VSCODE_MODEL_SETUP_JUSTIFICATION,
  VSCODE_MODEL_SETUP_PROMPT,
  VsCodeModelAccessController,
  VsCodeModelExecutionError,
  VsCodePublicApiReviewHandler,
  createVsCodePublicApiExecutionFoundation,
  createVsCodePublicLanguageModelApi,
  type VsCodeCancellationToken,
  type VsCodeCancellationTokenSource,
  type VsCodeExactModelSelector,
  type VsCodeLanguageModelChat,
  type VsCodeLanguageModelMessage,
  type VsCodeLanguageModelRequestOptions,
  type VsCodeLanguageModelResponse,
  type VsCodePublicLanguageModelApi,
} from '../../src/ide-adapters/vscode/vscodePublicApiModelExecution.js';

const selector: VsCodeExactModelSelector = {
  vendor: 'approved-vendor',
  id: 'approved-model',
  family: 'approved-family',
  version: '2026-09',
};

class TokenSource implements VsCodeCancellationTokenSource {
  private cancelled = false;
  public disposed = false;
  public readonly token: VsCodeCancellationToken;

  public constructor() {
    const owner = this;
    this.token = { get isCancellationRequested() { return owner.cancelled; } };
  }

  public cancel(): void { this.cancelled = true; }
  public dispose(): void { this.disposed = true; }
  public get isCancelled(): boolean { return this.cancelled; }
}


type Fixture = {
  api: VsCodePublicLanguageModelApi;
  model: VsCodeLanguageModelChat;
  selected: number;
  sent: number;
  counted: number;
  messages: string[];
  requestOptions: Array<VsCodeLanguageModelRequestOptions | undefined>;
  sources: TokenSource[];
  setAccess(value: boolean | undefined): void;
  setModels(value: readonly VsCodeLanguageModelChat[]): void;
  setResponse(factory: (token?: VsCodeCancellationToken) => AsyncIterable<string>): void;
  setSendFailure(value: unknown): void;
};

function fixture(): Fixture {
  let access: boolean | undefined = true;
  let models: readonly VsCodeLanguageModelChat[];
  let responseFactory: (token?: VsCodeCancellationToken) => AsyncIterable<string> = async function* () { yield 'ok'; };
  let sendFailure: unknown;
  let selected = 0;
  let sent = 0;
  let counted = 0;
  const messages: string[] = [];
  const requestOptions: Array<VsCodeLanguageModelRequestOptions | undefined> = [];
  const sources: TokenSource[] = [];

  const model: VsCodeLanguageModelChat = {
    ...selector,
    name: 'Approved Model',
    maxInputTokens: 4096,
    countTokens: async (text) => { counted += 1; return Math.max(1, Math.ceil(text.length / 4)); },
    sendRequest: async (requestMessages, options, token): Promise<VsCodeLanguageModelResponse> => {
      sent += 1;
      requestOptions.push(options);
      if (sendFailure !== undefined) throw sendFailure;
      for (const message of requestMessages) {
        const prompt = (message as { prompt?: unknown }).prompt;
        if (typeof prompt === 'string') messages.push(prompt);
      }
      return { text: responseFactory(token) };
    },
  };
  models = [model];

  const api: VsCodePublicLanguageModelApi = {
    selectChatModels: async () => { selected += 1; return models; },
    canSendRequest: () => access,
    createUserMessage: (prompt): VsCodeLanguageModelMessage => ({ prompt } as unknown as VsCodeLanguageModelMessage),
    createCancellationTokenSource: () => {
      const tokenSource = new TokenSource();
      sources.push(tokenSource);
      return tokenSource;
    },
  };

  return {
    api,
    model,
    get selected() { return selected; },
    get sent() { return sent; },
    get counted() { return counted; },
    messages,
    requestOptions,
    sources,
    setAccess(value) { access = value; },
    setModels(value) { models = value; },
    setResponse(factory) { responseFactory = factory; },
    setSendFailure(value) { sendFailure = value; },
  };
}

async function prepare(ctx: Fixture): Promise<VsCodeModelAccessController> {
  const access = new VsCodeModelAccessController(ctx.api, selector);
  expect(await access.prepareFromUserGesture()).toMatchObject({ state: 'MODEL_ACCESS_ALLOWED', identity: selector });
  return access;
}

function operation(signal = new AbortController().signal, emit: (type: 'assistant_chunk'|'tool_activity'|'status', message?: string) => void = () => undefined) {
  return {
    operationId: `ideo_${'a'.repeat(32)}`,
    prompt: 'review the admitted change',
    signal,
    emit,
  };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(VsCodeModelExecutionError);
  expect((error as VsCodeModelExecutionError).code).toBe(code);
}

describe('P7 I2 VS Code supported public-API model execution foundation', () => {
  it('binds only the documented VS Code lm/message/cancellation/access public API surface', async () => {
    const ctx = fixture();
    let lmCalls=0;let messageCalls=0;let accessCalls=0;let cancellationSources=0;
    class PublicCancellationSource extends TokenSource { public constructor(){super();cancellationSources+=1;} }
    const api=createVsCodePublicLanguageModelApi({
      lm:{selectChatModels:async(selectorValue)=>{lmCalls+=1;expect(selectorValue).toEqual(selector);return[ctx.model];}},
      LanguageModelChatMessage:{User:(content)=>{messageCalls+=1;return({prompt:content} as unknown as VsCodeLanguageModelMessage);}},
      CancellationTokenSource:PublicCancellationSource,
    },{canSendRequest:(model)=>{accessCalls+=1;expect(model).toBe(ctx.model);return true;}});
    const access=new VsCodeModelAccessController(api,selector);
    expect(await access.prepareFromUserGesture()).toMatchObject({state:'MODEL_ACCESS_ALLOWED'});
    const handler=new VsCodePublicApiReviewHandler({api,access:access.remoteAccess()});
    await handler.run(operation());
    expect(lmCalls).toBe(1);
    expect(messageCalls).toBe(1);
    expect(accessCalls).toBeGreaterThanOrEqual(2);
    expect(cancellationSources).toBe(1);
  });

  it('never performs model selection or consent-triggering discovery from a remote review before explicit user preparation', async () => {
    const ctx = fixture();
    const access = new VsCodeModelAccessController(ctx.api, selector);
    const handler = new VsCodePublicApiReviewHandler({ api: ctx.api, access: access.remoteAccess() });
    try { await handler.run(operation()); throw new Error('expected rejection'); }
    catch (error) { expectCode(error, 'VSCODE_MODEL_PREPARATION_REQUIRED'); }
    expect(ctx.selected).toBe(0);
    expect(ctx.counted).toBe(0);
    expect(ctx.sent).toBe(0);
  });

  it('keeps unavailable, consent-required, denied and allowed model-access states distinct', async () => {
    const ctx = fixture();
    const access = new VsCodeModelAccessController(ctx.api, selector);
    ctx.setModels([]);
    expect(await access.prepareFromUserGesture()).toEqual({ state: 'MODEL_UNAVAILABLE' });
    ctx.setModels([ctx.model]); ctx.setAccess(undefined);
    expect(await access.prepareFromUserGesture()).toMatchObject({ state: 'MODEL_CONSENT_REQUIRED' });
    ctx.setAccess(false);
    expect(await access.prepareFromUserGesture()).toMatchObject({ state: 'MODEL_ACCESS_DENIED' });
    ctx.setAccess(true);
    expect(await access.prepareFromUserGesture()).toMatchObject({ state: 'MODEL_ACCESS_ALLOWED' });
    expect(access.currentState()).toMatchObject({ state: 'MODEL_AVAILABLE' });
  });

  it('classifies public model-selection permission/not-found/unknown failures without conflating them', async () => {
    const base=fixture();
    const make=(error:unknown)=>new VsCodeModelAccessController({
      ...base.api,
      selectChatModels:async()=>{throw error;},
    },selector);
    expect(await make({code:'NoPermissions'}).prepareFromUserGesture()).toEqual({state:'MODEL_CONSENT_REQUIRED'});
    expect(await make({code:'NotFound'}).prepareFromUserGesture()).toEqual({state:'MODEL_UNAVAILABLE'});
    expect(await make(new Error('transport failed')).prepareFromUserGesture()).toEqual({state:'MODEL_PREPARATION_FAILED'});
  });

  it('fails bounded when the public model selector returns a structurally malformed runtime result', async () => {
    const ctx = fixture();
    const malformed: VsCodePublicLanguageModelApi = {
      ...ctx.api,
      selectChatModels: async () => ({} as unknown as readonly VsCodeLanguageModelChat[]),
    };
    const access = new VsCodeModelAccessController(malformed, selector);
    expect(await access.prepareFromUserGesture()).toEqual({ state: 'MODEL_PREPARATION_FAILED' });
  });

  it('fails closed when exact selector resolution is ambiguous or model identity drifts', async () => {
    const ctx = fixture();
    const access = new VsCodeModelAccessController(ctx.api, selector);
    ctx.setModels([ctx.model, { ...ctx.model }]);
    expect(await access.prepareFromUserGesture()).toEqual({ state: 'MODEL_SELECTION_AMBIGUOUS' });
    ctx.setModels([{ ...ctx.model, version: 'unexpected' }]);
    expect(await access.prepareFromUserGesture()).toEqual({ state: 'MODEL_IDENTITY_MISMATCH' });
  });

  it('streams only bounded text through the admitted review sink and preserves the caller operation identity', async () => {
    const ctx = fixture();
    const access = await prepare(ctx);
    const events: string[] = [];
    ctx.setResponse(async function* () { yield 'alpha'; yield 'βeta'; });
    const handler = new VsCodePublicApiReviewHandler({ api: ctx.api, access: access.remoteAccess() });
    const input = operation(undefined, (type, message) => { if (type === 'assistant_chunk' && message !== undefined) events.push(message); });
    const operationId = input.operationId;
    await handler.run(input);
    expect(input.operationId).toBe(operationId);
    expect(ctx.messages).toEqual(['review the admitted change']);
    expect(events).toEqual(['alpha', 'βeta']);
    expect(events.every((value) => Buffer.byteLength(value, 'utf8') <= MAX_IDE_EVENT_MESSAGE_BYTES)).toBe(true);
    expect(ctx.sources[0]?.disposed).toBe(true);
  });

  it('splits an oversized provider text fragment into protocol-safe UTF-8 event fragments', async () => {
    const ctx = fixture();
    const access = await prepare(ctx);
    const events: string[] = [];
    const content = '界'.repeat(MAX_IDE_EVENT_MESSAGE_BYTES);
    ctx.setResponse(async function* () { yield content; });
    const handler = new VsCodePublicApiReviewHandler({ api: ctx.api, access: access.remoteAccess() });
    await handler.run(operation(undefined, (type, message) => { if (type === 'assistant_chunk' && message !== undefined) events.push(message); }));
    expect(events.length).toBeGreaterThan(1);
    expect(events.join('')).toBe(content);
    expect(events.every((value) => Buffer.byteLength(value, 'utf8') <= MAX_IDE_EVENT_MESSAGE_BYTES)).toBe(true);
  });

  it('cancels the exact active VS Code model token and emits no late output after QuaranGate cancellation', async () => {
    const ctx = fixture();
    const access = await prepare(ctx);
    const abort = new AbortController();
    const events: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    ctx.setResponse(async function* (token) {
      yield 'before-cancel';
      await released;
      if (!token?.isCancellationRequested) yield 'late-output';
    });
    const handler = new VsCodePublicApiReviewHandler({ api: ctx.api, access: access.remoteAccess() });
    const promise = handler.run(operation(abort.signal, (_type, message) => {
      if (message !== undefined) {
        events.push(message);
        if (message === 'before-cancel') abort.abort();
      }
    }));
    release();
    try { await promise; throw new Error('expected cancellation'); }
    catch (error) { expectCode(error, 'VSCODE_MODEL_CANCELLED'); }
    expect(ctx.sources[0]?.isCancelled).toBe(true);
    expect(events).toEqual(['before-cancel']);
  });

  it('maps provider errors to bounded codes without persisting raw exception bodies', async () => {
    const ctx = fixture();
    const access = await prepare(ctx);
    ctx.setSendFailure({ code: 'Blocked', message: 'SECRET_PROVIDER_BODY_SHOULD_NOT_ESCAPE' });
    const handler = new VsCodePublicApiReviewHandler({ api: ctx.api, access: access.remoteAccess() });
    try { await handler.run(operation()); throw new Error('expected blocked failure'); }
    catch (error) {
      expectCode(error, 'VSCODE_MODEL_REQUEST_BLOCKED');
      expect(String((error as Error).message)).not.toContain('SECRET_PROVIDER_BODY_SHOULD_NOT_ESCAPE');
    }
  });

  it('fails the review rather than truncating or falsely completing output beyond the total response bound', async () => {
    const ctx = fixture();
    const access = await prepare(ctx);
    ctx.setResponse(async function* () { yield 'x'.repeat(VSCODE_MODEL_MAX_OUTPUT_BYTES); yield 'y'; });
    const handler = new VsCodePublicApiReviewHandler({ api: ctx.api, access: access.remoteAccess() });
    try { await handler.run(operation()); throw new Error('expected output limit'); }
    catch (error) { expectCode(error, 'VSCODE_MODEL_OUTPUT_LIMIT'); }
    expect(ctx.sources[0]?.isCancelled).toBe(true);
  });

  it('uses the model tokenizer bound before request execution and never sends an oversized prompt', async () => {
    const ctx = fixture();
    const narrow = { ...ctx.model, maxInputTokens: 1, countTokens: async () => 2 };
    ctx.setModels([narrow]);
    const access = await prepare(ctx);
    const handler = new VsCodePublicApiReviewHandler({ api: ctx.api, access: access.remoteAccess() });
    try { await handler.run(operation()); throw new Error('expected input limit'); }
    catch (error) { expectCode(error, 'VSCODE_MODEL_INPUT_LIMIT'); }
    expect(ctx.sent).toBe(0);
  });

  it('rechecks persisted access for every remote turn and does not reuse a revoked permission', async () => {
    const ctx = fixture();
    const access = await prepare(ctx);
    ctx.setAccess(false);
    const handler = new VsCodePublicApiReviewHandler({ api: ctx.api, access: access.remoteAccess() });
    try { await handler.run(operation()); throw new Error('expected access denial'); }
    catch (error) { expectCode(error, 'VSCODE_MODEL_ACCESS_DENIED'); }
    expect(ctx.sent).toBe(0);
  });


  it('authorizes first-use model access only from an explicit user gesture using a fixed content-free consent probe', async () => {
    const ctx = fixture();
    let accessState: boolean | undefined = undefined;
    const api: VsCodePublicLanguageModelApi = {
      ...ctx.api,
      canSendRequest: () => accessState,
      selectChatModels: async () => [ctx.model],
    };
    const originalSend = ctx.model.sendRequest.bind(ctx.model);
    const model: VsCodeLanguageModelChat = {
      ...ctx.model,
      sendRequest: async (messages, options, token) => {
        accessState = true;
        return await originalSend(messages, options, token);
      },
    };
    const consentApi: VsCodePublicLanguageModelApi = { ...api, selectChatModels: async () => [model] };
    const access = new VsCodeModelAccessController(consentApi, selector);
    const result = await access.authorizeFromUserGesture();
    expect(result).toMatchObject({ state: 'MODEL_ACCESS_ALLOWED', identity: selector });
    expect(ctx.sent).toBe(1);
    expect(ctx.messages).toEqual([VSCODE_MODEL_SETUP_PROMPT]);
    expect(ctx.requestOptions).toEqual([{ justification: VSCODE_MODEL_SETUP_JUSTIFICATION }]);
    expect(ctx.sources[0]?.isCancelled).toBe(true);
    expect(ctx.sources[0]?.disposed).toBe(true);
    expect(access.currentState()).toMatchObject({ state: 'MODEL_AVAILABLE' });
  });

  it('keeps consent-time model disappearance and provider blocking distinct from consent-required state', async () => {
    const base = fixture();
    const make = (failure: { code: string }) => {
      const model: VsCodeLanguageModelChat = { ...base.model, sendRequest: async () => { throw failure; } };
      return new VsCodeModelAccessController({
        ...base.api,
        selectChatModels: async () => [model],
        canSendRequest: () => undefined,
      }, selector);
    };
    expect(await make({ code: 'NotFound' }).authorizeFromUserGesture()).toMatchObject({ state: 'MODEL_UNAVAILABLE' });
    expect(await make({ code: 'Blocked' }).authorizeFromUserGesture()).toMatchObject({ state: 'MODEL_PREPARATION_FAILED' });
  });

  it('keeps explicit consent denial and setup cancellation distinct and never forwards user prompt content during setup', async () => {
    const denied = fixture();
    let deniedAccess: boolean | undefined = undefined;
    const deniedModel: VsCodeLanguageModelChat = {
      ...denied.model,
      sendRequest: async () => {
        deniedAccess = false;
        throw { code: 'NoPermissions', message: 'PRIVATE_PROVIDER_DETAIL' };
      },
    };
    const deniedApi: VsCodePublicLanguageModelApi = {
      ...denied.api,
      selectChatModels: async () => [deniedModel],
      canSendRequest: () => deniedAccess,
    };
    const deniedController = new VsCodeModelAccessController(deniedApi, selector);
    expect(await deniedController.authorizeFromUserGesture()).toMatchObject({ state: 'MODEL_ACCESS_DENIED' });

    const cancelled = fixture();
    cancelled.setAccess(undefined);
    const cancelledController = new VsCodeModelAccessController(cancelled.api, selector);
    const abort = new AbortController();
    abort.abort();
    expect(await cancelledController.authorizeFromUserGesture(abort.signal)).toMatchObject({ state: 'MODEL_PREPARATION_CANCELLED' });
    expect(cancelled.sent).toBe(0);
  });

  it('exposes review execution only: no implementation adapter, operation originator, participant injection or mutation capability is returned', () => {
    const ctx = fixture();
    const foundation = createVsCodePublicApiExecutionFoundation(ctx.api, selector);
    expect(Object.keys(foundation).sort()).toEqual(['access', 'reviewHandler']);
    expect(Object.keys(foundation.reviewHandler)).not.toContain('implementationHandler');
    expect('authorizeOperation' in foundation.reviewHandler).toBe(false);
    expect('executeCommand' in foundation.reviewHandler).toBe(false);
    expect('workspace' in foundation.reviewHandler).toBe(false);
    expect('terminal' in foundation.reviewHandler).toBe(false);
  });
});
