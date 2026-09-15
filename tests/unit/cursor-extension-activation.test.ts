import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IdeCompanionListener } from '../../src/executor/ide/ideCompanionListener.js';
import { createIdeCompanionRuntime } from '../../src/executor/ide/ideCompanionRuntime.js';
import { IdeSessionStore } from '../../src/executor/ide/ideSessionStore.js';
import { deriveIdeWorkspaceFingerprint } from '../../src/shared/ideWorkspaceAttestation.js';
import { activateCursorProductionComposition } from '../../src/ide-adapters/cursor/cursorExtensionActivation.js';
import { collectCursorWorkspacePhysicalIdentity } from '../../src/ide-adapters/cursor/cursorWorkspaceCollector.js';

function facts(overrides: Record<string, unknown> = {}) {
  return {
    appName: 'Cursor', uriScheme: 'cursor', remoteName: 'wsl', extensionHostKind: 'workspace' as const,
    workspaceFolderCount: 1, cursorExtensionApi: true, chatParticipantApi: undefined, languageModelApi: undefined, languageModelAccessApi: undefined,
    ...overrides,
  };
}

function snapshot(path: string) {
  return {
    remoteName: 'wsl', extensionHostKind: 'workspace' as const,
    workspaceFolders: [{ uri: pathToFileURL(path).href, fsPath: path, scheme: 'file' }],
  };
}

describe('P7 I3 Cursor companion activation', () => {
  it('does not read credentials/connect when product identity is not exact Cursor', async () => {
    const activation = await activateCursorProductionComposition({
      runtimeFacts: facts({ appName: 'Visual Studio Code', uriScheme: 'vscode' }),
      workspaceSnapshotProvider: () => ({ remoteName: 'wsl', extensionHostKind: 'workspace', workspaceFolders: [] }),
      adapterVersion: '0.1.0', credentialPath: '/definitely/not/read/credential.json',
    });
    expect(activation.compatibility.bindingState).toBe('BLOCKED_PRODUCT');
    expect(activation.readiness()).toBe('UNAVAILABLE');
    activation.dispose();
  });

  it('establishes real B6/B5 Cursor binding without claiming Chat/LM support', async () => {
    const state = mkdtempSync(join(tmpdir(), 'qg-i3-cursor-state-'));
    const workspace = mkdtempSync(join(dirname(process.cwd()), 'qg-i3-cursor-workspace-'));
    chmodSync(state, 0o700);
    const runtimeRoot = join(state, 'runtime'); mkdirSync(runtimeRoot, { mode: 0o700 }); chmodSync(runtimeRoot, 0o700);
    const machineIdPath = join(state, 'machine-id'); writeFileSync(machineIdPath, `${'a'.repeat(32)}\n`, { mode: 0o600 });
    const store = new IdeSessionStore(join(state, 'ide.db'));
    let listener: IdeCompanionListener | undefined;
    let activation: Awaited<ReturnType<typeof activateCursorProductionComposition>> | undefined;
    try {
      const snap = snapshot(workspace);
      const physical = await collectCursorWorkspacePhysicalIdentity(snap, { machineIdPath });
      const ideInstanceId = `ide_${'3'.repeat(32)}`;
      const enrollment = store.createEnrollment({
        principalId: 'chatgpt-browser', projectId: 'quarangate', worktreeId: 'forward', ideProduct: 'cursor', ideInstanceId,
        workspaceFingerprint: deriveIdeWorkspaceFingerprint({ projectId: 'quarangate', worktreeId: 'forward', workspace: physical }),
        capabilities: ['prompt', 'cancel', 'observe_response', 'request_review'],
      });
      const runtime = createIdeCompanionRuntime({ runtimeRoot, enrollmentId: enrollment.enrollmentId, ideInstanceId, ideProduct: 'cursor', adapterVersion: '0.1.0' });
      listener = new IdeCompanionListener({ store, runtime }); await listener.start();
      activation = await activateCursorProductionComposition({
        runtimeFacts: facts(), workspaceSnapshotProvider: () => snap, workspaceCollectorOptions: { machineIdPath },
        adapterVersion: '0.1.0', credentialPath: runtime.credentialPath,
      });
      expect(activation.compatibility).toMatchObject({ bindingState: 'READY', chatParticipantApi: 'UNKNOWN', languageModelApi: 'UNKNOWN', firstClassReviewApiReady: false });
      expect(activation.readiness()).toBe('CONNECTED_ATTESTED_READY');
      expect(store.getEnrollment(enrollment.enrollmentId)?.currentGeneration).toBe(1);
    } finally {
      activation?.dispose();
      if (listener !== undefined) await listener.stop().catch(() => undefined);
      store.close();
      rmSync(state, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('minimal Cursor manifest exposes no chat participant, command, tool, terminal, or mutation contribution', () => {
    const manifest = JSON.parse(readFileSync('extensions/quarangate-cursor/package.json', 'utf8')) as Record<string, any>;
    expect(manifest.extensionKind).toEqual(['workspace']);
    expect(manifest.activationEvents).toEqual(['onStartupFinished']);
    expect(manifest.contributes.chatParticipants).toBeUndefined();
    expect(manifest.contributes.commands).toBeUndefined();
    expect(manifest.contributes.languageModelTools).toBeUndefined();
    expect(manifest.contributes.languageModelChatProviders).toBeUndefined();
    expect(Object.keys(manifest.contributes.configuration.properties)).toEqual(['quarangate.cursorRuntimeCredentialPath']);
  });

  it('Cursor entrypoint only probes optional public APIs and exposes no private agent/UI/host-command authority', () => {
    const source = readFileSync('extensions/quarangate-cursor/src/extension.ts', 'utf8') as string;
    expect(source).toMatch(/vscode\.env\.appName/u);
    expect(source).toMatch(/vscode\.env\.uriScheme/u);
    expect(source).toMatch(/cursorExtensionApi/u);
    expect(source).not.toMatch(/executeCommand\s*\(/u);
    expect(source).not.toMatch(/createTerminal\s*\(/u);
    expect(source).not.toMatch(/workspace\.fs/u);
    expect(source).not.toMatch(/child_process|node:child_process/u);
    expect(source).not.toMatch(/clipboard|keyboard|mouse|composer|agent\.invoke/iu);
    expect(source).not.toMatch(/cursor\.mcp|registerMcpServer|registerPluginPath/iu);
  });

});
