import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  activateVsCodeProductionComposition,
} from '../../src/ide-adapters/vscode/vscodeExtensionActivation.js';
import type {
  VsCodeChatApiPort,
  VsCodeChatRequestHandlerPort,
  VsCodeChatResponseStreamPort,
  VsCodeUserCancellationTokenPort,
} from '../../src/ide-adapters/vscode/vscodeChatParticipantSetup.js';
import type {
  VsCodeCancellationToken,
  VsCodeCancellationTokenSource,
  VsCodeLanguageModelChat,
  VsCodeLanguageModelMessage,
  VsCodeLanguageModelResponse,
  VsCodePublicLanguageModelApi,
} from '../../src/ide-adapters/vscode/vscodePublicApiModelExecution.js';

class UserToken implements VsCodeUserCancellationTokenPort {
  public readonly isCancellationRequested = false;
  public onCancellationRequested(): { dispose(): void } { return { dispose: () => undefined }; }
}

class ModelTokenSource implements VsCodeCancellationTokenSource {
  public readonly token: VsCodeCancellationToken = { isCancellationRequested: false };
  public cancel(): void {}
  public dispose(): void {}
}

function fakeChat(): { chat: VsCodeChatApiPort; handler(): VsCodeChatRequestHandlerPort; registrations: string[]; disposed(): boolean } {
  let requestHandler: VsCodeChatRequestHandlerPort | undefined;
  let wasDisposed = false;
  const registrations: string[] = [];
  return {
    chat: {
      createChatParticipant: (id, handler) => {
        registrations.push(id);
        requestHandler = handler;
        return { id, dispose: () => { wasDisposed = true; } };
      },
    },
    handler: () => {
      if (requestHandler === undefined) throw new Error('participant was not registered');
      return requestHandler;
    },
    registrations,
    disposed: () => wasDisposed,
  };
}

async function invoke(handler: VsCodeChatRequestHandlerPort, prompt: string) {
  const markdown: string[] = [];
  const progress: string[] = [];
  const stream: VsCodeChatResponseStreamPort = {
    markdown: (value) => markdown.push(value),
    progress: (value) => progress.push(value),
  };
  const result = await handler({ prompt, command: undefined }, {}, stream, new UserToken());
  return { result, markdown, progress };
}

function modelFixture() {
  let selected = 0;
  let sent = 0;
  const model: VsCodeLanguageModelChat = {
    vendor: 'approved-vendor',
    id: 'approved-model',
    family: 'approved-family',
    version: '2026-09',
    name: 'Approved Model',
    maxInputTokens: 4096,
    countTokens: async () => 1,
    sendRequest: async (): Promise<VsCodeLanguageModelResponse> => {
      sent += 1;
      return { text: (async function* () { yield 'unused'; })() };
    },
  };
  const api: VsCodePublicLanguageModelApi = {
    selectChatModels: async () => { selected += 1; return [model]; },
    canSendRequest: () => true,
    createUserMessage: (prompt) => ({ prompt } as unknown as VsCodeLanguageModelMessage),
    createCancellationTokenSource: () => new ModelTokenSource(),
  };
  return { api, selected: () => selected, sent: () => sent };
}

describe('P7 I2 production VS Code extension activation composition', () => {
  it('registers the user participant without selecting/sending a model or creating review authority during activation', async () => {
    const chat = fakeChat();
    const model = modelFixture();
    const activation = await activateVsCodeProductionComposition({
      chat: chat.chat,
      registration: { ideProduct: 'vscode', remoteKind: 'wsl', extensionHostKind: 'workspace', workspaceFolderCount: 1 },
      workspaceSnapshot: { remoteName: 'wsl', extensionHostKind: 'workspace', workspaceFolders: [] },
      adapterVersion: '0.1.0',
      modelSelector: { vendor: 'approved-vendor', id: 'approved-model', family: 'approved-family', version: '2026-09' },
      modelApi: model.api,
    });
    expect(activation.registration.registered).toBe(true);
    expect(chat.registrations).toEqual(['quarangate.ideChat']);
    expect(model.selected()).toBe(0);
    expect(model.sent()).toBe(0);
    const status = await invoke(chat.handler(), 'status');
    expect(status.result?.metadata).toMatchObject({ connection: 'UNAVAILABLE', transport: 'NOT_READY' });
    expect(model.selected()).toBe(0);
    expect(model.sent()).toBe(0);
    const review = await invoke(chat.handler(), 'review inspect');
    expect(review.result?.metadata).toMatchObject({ action: 'review', outcome: 'NOT_READY' });
    expect(model.sent()).toBe(0);
    activation.dispose();
    expect(chat.disposed()).toBe(true);
  });

  it('production manifest is a workspace Chat extension with only the bounded participant/configuration surface', () => {
    const manifest = JSON.parse(readFileSync('extensions/quarangate-vscode/package.json', 'utf8')) as Record<string, any>;
    expect(manifest.engines).toEqual({ vscode: '^1.109.0' });
    expect(manifest.extensionKind).toEqual(['workspace']);
    expect(manifest.activationEvents).toEqual(['onStartupFinished', 'onChatParticipant:quarangate.ideChat']);
    expect(manifest.contributes.chatParticipants).toEqual([expect.objectContaining({ id: 'quarangate.ideChat', name: 'quarangate' })]);
    expect(manifest.contributes.commands).toBeUndefined();
    expect(manifest.contributes.languageModelTools).toBeUndefined();
    expect(manifest.contributes.languageModelChatProviders).toBeUndefined();
    const properties = manifest.contributes.configuration.properties as Record<string, { scope?: string }>;
    expect(Object.keys(properties).sort()).toEqual([
      'quarangate.reviewModel.family',
      'quarangate.reviewModel.id',
      'quarangate.reviewModel.vendor',
      'quarangate.reviewModel.version',
      'quarangate.runtimeCredentialPath',
    ]);
    expect(Object.values(properties).every((value) => value.scope === 'machine')).toBe(true);
  });

  it('production entrypoint uses only documented public composition APIs and exposes no command/terminal/fs/UI-automation authority', () => {
    const source = readFileSync('extensions/quarangate-vscode/src/extension.ts', 'utf8');
    expect(source).toMatch(/vscode\.chat\.createChatParticipant/u);
    expect(source).toMatch(/vscode\.lm\.selectChatModels/u);
    expect(source).toMatch(/languageModelAccessInformation\.canSendRequest/u);
    expect(source).not.toMatch(/executeCommand\s*\(/u);
    expect(source).not.toMatch(/workspace\.fs/u);
    expect(source).not.toMatch(/createTerminal\s*\(/u);
    expect(source).not.toMatch(/lm\.invokeTool/u);
    expect(source).not.toMatch(/workbench\.action\.chat|clipboard|keyboard|mouse/u);
    expect(source).not.toMatch(/child_process|node:child_process/u);
  });
});
