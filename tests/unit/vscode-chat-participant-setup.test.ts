import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_IDE_EVENT_MESSAGE_BYTES } from '../../src/shared/ideSessions.js';
import {
  QUARANGATE_VSCODE_PARTICIPANT_ID,
  registerVsCodeChatParticipantSetup,
  type VsCodeChatApiPort,
  type VsCodeChatParticipantPort,
  type VsCodeChatRequestHandlerPort,
  type VsCodeChatResponseStreamPort,
  type VsCodeGovernedReviewPort,
  type VsCodeParticipantReadinessPort,
  type VsCodeUserCancellationTokenPort,
} from '../../src/ide-adapters/vscode/vscodeChatParticipantSetup.js';
import {
  VsCodeModelAccessController,
  type VsCodeCancellationToken,
  type VsCodeCancellationTokenSource,
  type VsCodeExactModelSelector,
  type VsCodeLanguageModelChat,
  type VsCodeLanguageModelMessage,
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
}

class UserToken implements VsCodeUserCancellationTokenPort {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  public get isCancellationRequested(): boolean { return this.cancelled; }
  public onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) listener();
  }
}

type ModelFixture = {
  access: VsCodeModelAccessController;
  model: VsCodeLanguageModelChat;
  selected: () => number;
  sent: () => number;
  setAccess(value: boolean | undefined): void;
  setModels(value: readonly VsCodeLanguageModelChat[]): void;
};

function modelFixture(initialAccess: boolean | undefined = true, grantOnSend = false): ModelFixture {
  let accessState = initialAccess;
  let selected = 0;
  let sent = 0;
  let models: readonly VsCodeLanguageModelChat[];
  const model: VsCodeLanguageModelChat = {
    ...selector,
    name: 'Approved Model',
    maxInputTokens: 4096,
    countTokens: async () => 1,
    sendRequest: async (): Promise<VsCodeLanguageModelResponse> => {
      sent += 1;
      if (grantOnSend) accessState = true;
      return { text: (async function* () { yield 'ignored-setup-output'; })() };
    },
  };
  models = [model];
  const api: VsCodePublicLanguageModelApi = {
    selectChatModels: async () => { selected += 1; return models; },
    canSendRequest: () => accessState,
    createUserMessage: (prompt) => ({ prompt } as unknown as VsCodeLanguageModelMessage),
    createCancellationTokenSource: () => new TokenSource(),
  };
  return {
    access: new VsCodeModelAccessController(api, selector),
    model,
    selected: () => selected,
    sent: () => sent,
    setAccess(value) { accessState = value; },
    setModels(value) { models = value; },
  };
}

function readiness(overrides: Partial<ReturnType<VsCodeParticipantReadinessPort['snapshot']>> = {}): VsCodeParticipantReadinessPort {
  return {
    snapshot: () => ({ connection: 'CONNECTED', workspace: 'ATTESTED', transport: 'READY', ...overrides }),
  };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    ideProduct: 'vscode',
    remoteKind: 'wsl',
    extensionHostKind: 'workspace',
    workspaceFolderCount: 1,
    ...overrides,
  } as { ideProduct: string; remoteKind: string | undefined; extensionHostKind: string; workspaceFolderCount: number };
}

function fakeChat(returnedId = QUARANGATE_VSCODE_PARTICIPANT_ID): {
  chat: VsCodeChatApiPort;
  registrations: string[];
  handler: () => VsCodeChatRequestHandlerPort;
  disposed: () => boolean;
} {
  const registrations: string[] = [];
  let registeredHandler: VsCodeChatRequestHandlerPort | undefined;
  let wasDisposed = false;
  const participant: VsCodeChatParticipantPort = {
    id: returnedId,
    dispose: () => { wasDisposed = true; },
  };
  return {
    chat: {
      createChatParticipant: (id, handler) => {
        registrations.push(id);
        registeredHandler = handler;
        return participant;
      },
    },
    registrations,
    handler: () => {
      if (registeredHandler === undefined) throw new Error('participant not registered');
      return registeredHandler;
    },
    disposed: () => wasDisposed,
  };
}

function stream() {
  const markdown: string[] = [];
  const progress: string[] = [];
  const port: VsCodeChatResponseStreamPort = {
    markdown: (value) => markdown.push(value),
    progress: (value) => progress.push(value),
  };
  return { port, markdown, progress };
}

async function invoke(
  handler: VsCodeChatRequestHandlerPort,
  prompt: string,
  command: string | undefined = undefined,
  token = new UserToken(),
) {
  const output = stream();
  const result = await handler({ prompt, command }, {}, output.port, token);
  return { result, token, ...output };
}

describe('P7 I2 VS Code user-facing Chat Participant / setup composition', () => {
  it('registers the exact QuaranGate participant only through the public createChatParticipant seam', () => {
    const ctx = fakeChat();
    const result = registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness() });
    expect(result.registered).toBe(true);
    expect(ctx.registrations).toEqual([QUARANGATE_VSCODE_PARTICIPANT_ID]);
    if (result.registered) expect(result.participant.id).toBe('quarangate.ideChat');
  });

  it('fails closed and disposes registration if the public API returns the wrong participant identity', () => {
    const ctx = fakeChat('unexpected.participant');
    expect(() => registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness() }))
      .toThrow('unexpected identity');
    expect(ctx.disposed()).toBe(true);
  });

  it.each([
    [{ ideProduct: 'cursor' }, 'UNSUPPORTED_IDE'],
    [{ remoteKind: undefined }, 'UNSUPPORTED_REMOTE_HOST'],
    [{ extensionHostKind: 'ui' }, 'NOT_WORKSPACE_EXTENSION_HOST'],
    [{ workspaceFolderCount: 2 }, 'WORKSPACE_COUNT_INVALID'],
  ] as const)('does not register when a required production placement prerequisite is absent: %j', (override, reason) => {
    const ctx = fakeChat();
    const result = registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(override), readiness: readiness() });
    expect(result).toEqual({ registered: false, reason });
    expect(ctx.registrations).toEqual([]);
  });

  it('status/help never select a model or trigger first-use consent; setup is the explicit user action', async () => {
    const model = modelFixture(true, true);
    model.setAccess(undefined);
    const ctx = fakeChat();
    const result = registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness(), modelAccess: model.access });
    expect(result.registered).toBe(true);
    await invoke(ctx.handler(), 'status');
    await invoke(ctx.handler(), 'what can you do?');
    expect(model.selected()).toBe(0);
    expect(model.sent()).toBe(0);
    const setup = await invoke(ctx.handler(), 'setup');
    expect(model.selected()).toBe(1);
    expect(model.sent()).toBe(1);
    expect(setup.result?.metadata).toMatchObject({ action: 'setup', model: 'READY' });
  });

  it('keeps not-configured, unavailable, denied, ready, revoked and disappeared model states distinct', async () => {
    const noConfig = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: noConfig.chat, registration: registration(), readiness: readiness() });
    expect((await invoke(noConfig.handler(), 'status')).result?.metadata).toMatchObject({ model: 'NOT_CONFIGURED' });

    const unavailable = modelFixture(true);
    unavailable.setModels([]);
    const unavailableChat = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: unavailableChat.chat, registration: registration(), readiness: readiness(), modelAccess: unavailable.access });
    expect((await invoke(unavailableChat.handler(), 'setup')).result?.metadata).toMatchObject({ model: 'MODEL_UNAVAILABLE' });

    const denied = modelFixture(false);
    const deniedChat = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: deniedChat.chat, registration: registration(), readiness: readiness(), modelAccess: denied.access });
    expect((await invoke(deniedChat.handler(), 'setup')).result?.metadata).toMatchObject({ model: 'ACCESS_DENIED' });

    const ready = modelFixture(true);
    const readyChat = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: readyChat.chat, registration: registration(), readiness: readiness(), modelAccess: ready.access });
    expect((await invoke(readyChat.handler(), 'setup')).result?.metadata).toMatchObject({ model: 'READY' });
    ready.setAccess(false);
    expect((await invoke(readyChat.handler(), 'status')).result?.metadata).toMatchObject({ model: 'ACCESS_REVOKED' });

    const disappeared = modelFixture(true);
    const disappearedChat = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: disappearedChat.chat, registration: registration(), readiness: readiness(), modelAccess: disappeared.access });
    await invoke(disappearedChat.handler(), 'setup');
    disappeared.setAccess(undefined);
    expect((await invoke(disappearedChat.handler(), 'status')).result?.metadata).toMatchObject({ model: 'MODEL_UNAVAILABLE' });
  });

  it('cancellation during explicit model setup is bounded and never creates a governed review', async () => {
    const model = modelFixture(true, false);
    model.setAccess(undefined);
    const ctx = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness(), modelAccess: model.access });
    const token = new UserToken();
    token.cancel();
    const result = await invoke(ctx.handler(), 'setup', undefined, token);
    expect(result.result?.metadata).toMatchObject({ action: 'setup', model: 'CANCELLED' });
    expect(model.sent()).toBe(0);
  });

  it('never treats a participant review prompt as authority when runtime/model prerequisites are not ready', async () => {
    const model = modelFixture(true);
    await model.access.prepareFromUserGesture();
    let reviewCalls = 0;
    const review: VsCodeGovernedReviewPort = { requestReview: async () => { reviewCalls += 1; return { operationId: `ideo_${'a'.repeat(32)}`, terminalState: 'COMPLETED' }; } };
    const ctx = fakeChat();
    registerVsCodeChatParticipantSetup({
      chat: ctx.chat,
      registration: registration(),
      readiness: readiness({ transport: 'NOT_READY' }),
      modelAccess: model.access,
      governedReview: review,
    });
    const result = await invoke(ctx.handler(), 'review inspect the change');
    expect(result.result?.metadata).toMatchObject({ action: 'review', outcome: 'NOT_READY' });
    expect(reviewCalls).toBe(0);
  });

  it('fails closed when the governed user-review bridge is absent instead of directly sending a model request', async () => {
    const model = modelFixture(true);
    await model.access.prepareFromUserGesture();
    const ctx = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness(), modelAccess: model.access });
    const result = await invoke(ctx.handler(), 'review inspect the change');
    expect(result.result?.metadata).toMatchObject({ action: 'review', outcome: 'NOT_WIRED' });
    expect(model.sent()).toBe(0);
    expect(result.markdown.join('\n')).toContain('No operation was created');
  });

  it('delegates a user review only to the narrow QuaranGate-governed port and cannot fabricate operation/controller/project/worktree identity', async () => {
    const model = modelFixture(true);
    await model.access.prepareFromUserGesture();
    const seen: Array<Record<string, unknown>> = [];
    const review: VsCodeGovernedReviewPort = {
      requestReview: async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        input.emit({ type: 'status', message: 'durably admitted' });
        input.emit({ type: 'assistant_chunk', message: 'bounded review result' });
        return { operationId: `ideo_${'b'.repeat(32)}`, terminalState: 'COMPLETED' };
      },
    };
    const ctx = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness(), modelAccess: model.access, governedReview: review });
    const result = await invoke(ctx.handler(), 'review inspect the change');
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(['emit', 'prompt', 'signal']);
    expect(seen[0]).not.toHaveProperty('operationId');
    expect(seen[0]).not.toHaveProperty('project');
    expect(seen[0]).not.toHaveProperty('worktree');
    expect(seen[0]).not.toHaveProperty('controllerLeaseId');
    expect(seen[0]).not.toHaveProperty('writerLeaseId');
    expect(result.result?.metadata).toEqual({ action: 'review', outcome: 'COMPLETED', operationId: `ideo_${'b'.repeat(32)}` });
    expect(model.sent()).toBe(0);
  });

  it('rejects an invalid operation identity returned by the governed review boundary', async () => {
    const model = modelFixture(true);
    await model.access.prepareFromUserGesture();
    const review: VsCodeGovernedReviewPort = { requestReview: async () => ({ operationId: 'participant-invented-id', terminalState: 'COMPLETED' }) };
    const ctx = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness(), modelAccess: model.access, governedReview: review });
    const result = await invoke(ctx.handler(), 'review inspect');
    expect(result.result?.metadata).toMatchObject({ action: 'review', outcome: 'REJECTED' });
  });

  it('propagates user cancellation only as an AbortSignal to the governed review port', async () => {
    const model = modelFixture(true);
    await model.access.prepareFromUserGesture();
    let sawAbort = false;
    const review: VsCodeGovernedReviewPort = {
      requestReview: async ({ signal }) => await new Promise((resolve) => {
        signal.addEventListener('abort', () => { sawAbort = true; resolve({ operationId: `ideo_${'c'.repeat(32)}`, terminalState: 'CANCELLED' }); }, { once: true });
      }),
    };
    const ctx = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness(), modelAccess: model.access, governedReview: review });
    const token = new UserToken();
    const pending = invoke(ctx.handler(), 'review inspect', undefined, token);
    token.cancel();
    const result = await pending;
    expect(sawAbort).toBe(true);
    expect(result.result?.metadata).toMatchObject({ outcome: 'CANCELLED' });
  });

  it('bounds governed event output and never exposes raw review-provider failures', async () => {
    const model = modelFixture(true);
    await model.access.prepareFromUserGesture();
    const huge = '界'.repeat(MAX_IDE_EVENT_MESSAGE_BYTES);
    const review: VsCodeGovernedReviewPort = {
      requestReview: async ({ emit }) => {
        emit({ type: 'assistant_chunk', message: huge });
        throw new Error('SECRET_PROVIDER_ERROR_BODY');
      },
    };
    const ctx = fakeChat();
    registerVsCodeChatParticipantSetup({ chat: ctx.chat, registration: registration(), readiness: readiness(), modelAccess: model.access, governedReview: review });
    const result = await invoke(ctx.handler(), 'review inspect');
    expect(result.markdown.some((value) => value.includes('SECRET_PROVIDER_ERROR_BODY'))).toBe(false);
    expect(result.markdown.every((value) => Buffer.byteLength(value, 'utf8') <= MAX_IDE_EVENT_MESSAGE_BYTES)).toBe(true);
    expect(result.result?.metadata).toMatchObject({ outcome: 'FAILED' });
  });

  it('is review-only and statically contains no private/UI-automation/generic command-terminal-filesystem authority', () => {
    const source = readFileSync('src/ide-adapters/vscode/vscodeChatParticipantSetup.ts', 'utf8');
    expect(source).not.toMatch(/from\s+['"]vscode['"]/u);
    expect(source).not.toMatch(/executeCommand\s*\(/u);
    expect(source).not.toMatch(/workspace\.fs/u);
    expect(source).not.toMatch(/createTerminal\s*\(/u);
    expect(source).not.toMatch(/lm\.invokeTool/u);
    expect(source).not.toMatch(/child_process|node:child_process/u);
    expect(source).not.toMatch(/keyboard|mouse|clipboard/u);
    expect(source).not.toMatch(/implementationHandler\s*:/u);
  });
});
