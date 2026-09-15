import * as vscode from 'vscode';
import {
  activateCursorProductionComposition,
  type CursorProductionActivationHandle,
} from '../../../src/ide-adapters/cursor/cursorExtensionActivation.js';

let active: CursorProductionActivationHandle | undefined;

function setting(config: vscode.WorkspaceConfiguration, key: string): string | undefined {
  const value = config.get<string>(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function workspaceSnapshot(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return {
    remoteName: vscode.env.remoteName,
    extensionHostKind: context.extension.extensionKind === vscode.ExtensionKind.Workspace ? 'workspace' as const : 'ui' as const,
    workspaceFolders: folders.map((folder) => ({ uri: folder.uri.toString(), fsPath: folder.uri.fsPath, scheme: folder.uri.scheme })),
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const packageVersion = (context.extension.packageJSON as { version?: unknown }).version;
  if (typeof packageVersion !== 'string') throw new Error('QuaranGate Cursor extension package version is unavailable');
  const credentialPath = setting(vscode.workspace.getConfiguration('quarangate'), 'cursorRuntimeCredentialPath');
  const cursorExtensionApi = (vscode as unknown as { cursor?: unknown }).cursor;
  const chatApi = (vscode as unknown as { chat?: { createChatParticipant?: unknown } }).chat;
  const lmApi = (vscode as unknown as { lm?: { selectChatModels?: unknown } }).lm;
  const access = context as unknown as { languageModelAccessInformation?: { canSendRequest?: unknown } };

  active = await activateCursorProductionComposition({
    runtimeFacts: {
      appName: vscode.env.appName,
      uriScheme: vscode.env.uriScheme,
      remoteName: vscode.env.remoteName,
      extensionHostKind: context.extension.extensionKind === vscode.ExtensionKind.Workspace ? 'workspace' : 'ui',
      workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
      cursorExtensionApi: cursorExtensionApi !== undefined && cursorExtensionApi !== null,
      chatParticipantApi: typeof chatApi?.createChatParticipant === 'function',
      languageModelApi: typeof lmApi?.selectChatModels === 'function',
      languageModelAccessApi: typeof access.languageModelAccessInformation?.canSendRequest === 'function',
    },
    workspaceSnapshotProvider: () => workspaceSnapshot(context),
    adapterVersion: packageVersion,
    ...(credentialPath === undefined ? {} : { credentialPath }),
  });

  context.subscriptions.push(new vscode.Disposable(() => active?.dispose()));
}

export function deactivate(): void {
  active?.dispose();
  active = undefined;
}
