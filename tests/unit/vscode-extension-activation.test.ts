import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IdeCompanionListener } from '../../src/executor/ide/ideCompanionListener.js';
import { createIdeCompanionRuntime } from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';
import { deriveIdeWorkspaceFingerprint } from '../../src/shared/ideWorkspaceAttestation.js';
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
import {
  collectVsCodeWorkspacePhysicalIdentity,
  type VsCodeWorkspaceSnapshot,
} from '../../src/ide-adapters/vscode/vscodeWorkspaceCollector.js';

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

function snapshotFor(path: string): VsCodeWorkspaceSnapshot {
  return {
    remoteName: 'wsl',
    extensionHostKind: 'workspace',
    workspaceFolders: [{ uri: pathToFileURL(path).href, fsPath: path, scheme: 'file' }],
  };
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
      workspaceSnapshotProvider: () => ({ remoteName: 'wsl', extensionHostKind: 'workspace', workspaceFolders: [] }),
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

  it('re-reads the current production workspace snapshot per review and fails closed on A-to-B drift before B7/model execution', async () => {
    const stateBase = mkdtempSync(join(tmpdir(), 'qg-i2-activation-state-'));
    const workspaceParent = dirname(process.cwd());
    const workspaceA = mkdtempSync(join(workspaceParent, 'qg-i2-activation-a-'));
    const workspaceB = mkdtempSync(join(workspaceParent, 'qg-i2-activation-b-'));
    chmodSync(stateBase, 0o700);
    const runtimeRoot = join(stateBase, 'runtime');
    mkdirSync(runtimeRoot, { mode: 0o700 });
    chmodSync(runtimeRoot, 0o700);
    const machineIdPath = join(stateBase, 'machine-id');
    writeFileSync(machineIdPath, `${'a'.repeat(32)}\n`, { mode: 0o600 });
    const workspaceCollectorOptions = { machineIdPath };
    const store = new IdeSessionStore(join(stateBase, 'ide.db'));
    let listener: IdeCompanionListener | undefined;
    let activation: Awaited<ReturnType<typeof activateVsCodeProductionComposition>> | undefined;
    try {
      const initialSnapshot = snapshotFor(workspaceA);
      const initialWorkspace = await collectVsCodeWorkspacePhysicalIdentity(initialSnapshot, workspaceCollectorOptions);
      const ideInstanceId = `ide_${'1'.repeat(32)}`;
      const enrollment = store.createEnrollment({
        principalId: 'chatgpt-browser',
        projectId: 'quarangate',
        worktreeId: 'forward',
        ideProduct: 'vscode',
        ideInstanceId,
        workspaceFingerprint: deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: initialWorkspace }),
        capabilities: ['request_review', 'cancel', 'observe_response'],
      });
      const runtime = createIdeCompanionRuntime({
        runtimeRoot,
        enrollmentId: enrollment.enrollmentId,
        ideInstanceId,
        ideProduct: 'vscode',
        adapterVersion: '0.1.0',
      });
      const expectedOperationId = `ideo_${'ab'.repeat(16)}`;
      listener = new IdeCompanionListener({
        store,
        runtime,
        userReviewIntents: true,
        userReviewIntentOperationIdBytes: (size) => Buffer.alloc(size, 0xab),
      });
      await listener.start();

      const chat = fakeChat();
      const model = modelFixture();
      let currentSnapshot = initialSnapshot;
      const observedWorkspacePaths: string[] = [];
      activation = await activateVsCodeProductionComposition({
        chat: chat.chat,
        registration: { ideProduct: 'vscode', remoteKind: 'wsl', extensionHostKind: 'workspace', workspaceFolderCount: 1 },
        workspaceSnapshotProvider: () => {
          const snapshot = currentSnapshot;
          observedWorkspacePaths.push(snapshot.workspaceFolders.map((folder) => folder.fsPath).join(','));
          return snapshot;
        },
        workspaceCollectorOptions,
        adapterVersion: '0.1.0',
        credentialPath: runtime.credentialPath,
        modelSelector: { vendor: 'approved-vendor', id: 'approved-model', family: 'approved-family', version: '2026-09' },
        modelApi: model.api,
      });
      expect(activation.registration.registered).toBe(true);
      expect(observedWorkspacePaths).toEqual([workspaceA]);

      const setup = await invoke(chat.handler(), 'setup');
      expect(setup.result?.metadata).toMatchObject({ action: 'setup', model: 'READY' });
      expect(model.sent()).toBe(0);

      currentSnapshot = snapshotFor(workspaceB);
      const review = await invoke(chat.handler(), 'review reject stale workspace A');
      expect(review.result?.metadata).toMatchObject({ action: 'review', outcome: 'FAILED' });
      expect(observedWorkspacePaths.at(-1)).toBe(workspaceB);
      expect(observedWorkspacePaths.filter((value) => value === workspaceA)).toHaveLength(1);
      expect(model.sent()).toBe(0);
      expect(store.getOperation(expectedOperationId)).toBeUndefined();
    } finally {
      activation?.dispose();
      if (listener !== undefined) await listener.stop().catch(() => undefined);
      store.close();
      rmSync(stateBase, { recursive: true, force: true });
      rmSync(workspaceA, { recursive: true, force: true });
      rmSync(workspaceB, { recursive: true, force: true });
    }
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
    expect(source).toMatch(/workspaceSnapshotProvider:\s*\(\)\s*=>\s*workspaceSnapshot\(context\)/u);
    expect(source).toMatch(/remoteName:\s*vscode\.env\.remoteName/u);
    expect(source).toMatch(/vscode\.workspace\.workspaceFolders/u);
    expect(source).not.toMatch(/executeCommand\s*\(/u);
    expect(source).not.toMatch(/workspace\.fs/u);
    expect(source).not.toMatch(/createTerminal\s*\(/u);
    expect(source).not.toMatch(/lm\.invokeTool/u);
    expect(source).not.toMatch(/workbench\.action\.chat|clipboard|keyboard|mouse/u);
    expect(source).not.toMatch(/child_process|node:child_process/u);
  });
});
