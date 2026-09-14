import * as vscode from 'vscode';
import {
  activateVsCodeProductionComposition,
  type VsCodeProductionActivationHandle,
} from '../../../src/ide-adapters/vscode/vscodeExtensionActivation.js';
import type {
  VsCodeChatApiPort,
} from '../../../src/ide-adapters/vscode/vscodeChatParticipantSetup.js';
import type {
  VsCodeCancellationToken,
  VsCodeCancellationTokenSource,
  VsCodeExactModelSelector,
  VsCodeLanguageModelChat,
  VsCodeLanguageModelMessage,
  VsCodeLanguageModelRequestOptions,
  VsCodePublicLanguageModelApi,
} from '../../../src/ide-adapters/vscode/vscodePublicApiModelExecution.js';

let active: VsCodeProductionActivationHandle | undefined;

function setting(config: vscode.WorkspaceConfiguration, key: string): string | undefined {
  const value = config.get<string>(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function selector(config: vscode.WorkspaceConfiguration): VsCodeExactModelSelector | undefined {
  const vendor = setting(config, 'reviewModel.vendor');
  const id = setting(config, 'reviewModel.id');
  const family = setting(config, 'reviewModel.family');
  const version = setting(config, 'reviewModel.version');
  if (vendor === undefined || id === undefined || family === undefined || version === undefined) return undefined;
  return { vendor, id, family, version };
}

function chatPort(): VsCodeChatApiPort {
  return {
    createChatParticipant: (id, handler) => {
      const participant = vscode.chat.createChatParticipant(id, handler as unknown as vscode.ChatRequestHandler);
      return { id: participant.id, dispose: () => participant.dispose() };
    },
  };
}

function modelApi(context: vscode.ExtensionContext): VsCodePublicLanguageModelApi {
  const rawModels = new WeakMap<object, vscode.LanguageModelChat>();
  const wrap = (raw: vscode.LanguageModelChat): VsCodeLanguageModelChat => {
    const model: VsCodeLanguageModelChat = Object.freeze({
      vendor: raw.vendor,
      id: raw.id,
      family: raw.family,
      version: raw.version,
      name: raw.name,
      maxInputTokens: raw.maxInputTokens,
      countTokens: async (text: string, token?: VsCodeCancellationToken) => await raw.countTokens(text, token as vscode.CancellationToken | undefined),
      sendRequest: async (messages: VsCodeLanguageModelMessage[], options?: VsCodeLanguageModelRequestOptions, token?: VsCodeCancellationToken) => {
        const response = await raw.sendRequest(
          messages as unknown as vscode.LanguageModelChatMessage[],
          options === undefined ? undefined : { justification: options.justification },
          token as vscode.CancellationToken | undefined,
        );
        return { text: response.text };
      },
    });
    rawModels.set(model, raw);
    return model;
  };
  return {
    selectChatModels: async (modelSelector) => (await vscode.lm.selectChatModels(modelSelector)).map(wrap),
    canSendRequest: (model) => {
      const raw = rawModels.get(model as object);
      return raw === undefined ? false : context.languageModelAccessInformation.canSendRequest(raw);
    },
    createUserMessage: (prompt) => vscode.LanguageModelChatMessage.User(prompt) as unknown as VsCodeLanguageModelMessage,
    createCancellationTokenSource: () => new vscode.CancellationTokenSource() as unknown as VsCodeCancellationTokenSource,
  };
}

function registrationContext(context: vscode.ExtensionContext) {
  return {
    ideProduct: 'vscode',
    remoteKind: vscode.env.remoteName,
    extensionHostKind: context.extension.extensionKind === vscode.ExtensionKind.Workspace ? 'workspace' : 'ui',
    workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
  } as const;
}

function workspaceSnapshot(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return {
    remoteName: vscode.env.remoteName,
    extensionHostKind: context.extension.extensionKind === vscode.ExtensionKind.Workspace ? 'workspace' as const : 'ui' as const,
    workspaceFolders: folders.map((folder) => ({
      uri: folder.uri.toString(),
      fsPath: folder.uri.fsPath,
      scheme: folder.uri.scheme,
    })),
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('quarangate');
  const packageVersion = (context.extension.packageJSON as { version?: unknown }).version;
  if (typeof packageVersion !== 'string') throw new Error('QuaranGate extension package version is unavailable');
  const modelSelector = selector(config);
  const credentialPath = setting(config, 'runtimeCredentialPath');

  active = await activateVsCodeProductionComposition({
    chat: chatPort(),
    registration: registrationContext(context),
    workspaceSnapshot: workspaceSnapshot(context),
    adapterVersion: packageVersion,
    ...(credentialPath === undefined ? {} : { credentialPath }),
    ...(modelSelector === undefined ? {} : { modelSelector, modelApi: modelApi(context) }),
  });

  context.subscriptions.push(new vscode.Disposable(() => active?.dispose()));
}

export function deactivate(): void {
  active?.dispose();
  active = undefined;
}
