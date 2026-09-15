import { describe, expect, it } from 'vitest';
import { classifyCursorCompatibility } from '../../src/ide-adapters/cursor/cursorCompatibility.js';

const base = {
  appName: 'Cursor',
  uriScheme: 'cursor',
  remoteName: 'wsl',
  extensionHostKind: 'workspace' as const,
  workspaceFolderCount: 1,
  cursorExtensionApi: true,
  chatParticipantApi: undefined,
  languageModelApi: undefined,
  languageModelAccessApi: undefined,
};

describe('P7 I3 Cursor compatibility classification', () => {
  it('separates proven Cursor/WSL placement from unknown Chat/LM parity', () => {
    expect(classifyCursorCompatibility(base)).toEqual({
      productIdentity: 'PASS',
      remoteWslPlacement: 'PASS',
      chatParticipantApi: 'UNKNOWN',
      languageModelApi: 'UNKNOWN',
      bindingState: 'READY',
      firstClassReviewApiReady: false,
    });
  });

  it('requires exact Cursor product identity before binding authority', () => {
    expect(classifyCursorCompatibility({ ...base, appName: 'Visual Studio Code', uriScheme: 'vscode' }).bindingState).toBe('BLOCKED_PRODUCT');
    expect(classifyCursorCompatibility({ ...base, appName: 'Cursor Dev' }).bindingState).toBe('BLOCKED_PRODUCT');
    expect(classifyCursorCompatibility({ ...base, uriScheme: 'vscode' }).bindingState).toBe('BLOCKED_PRODUCT');
  });

  it('requires one WSL workspace extension host', () => {
    for (const facts of [
      { ...base, remoteName: undefined },
      { ...base, extensionHostKind: 'ui' as const },
      { ...base, workspaceFolderCount: 2 },
    ]) expect(classifyCursorCompatibility(facts).bindingState).toBe('BLOCKED_PLACEMENT');
  });

  it('promotes first-class review capability only when both public API families are directly observed', () => {
    expect(classifyCursorCompatibility({
      ...base,
      chatParticipantApi: true,
      languageModelApi: true,
      languageModelAccessApi: true,
    }).firstClassReviewApiReady).toBe(true);
    expect(classifyCursorCompatibility({ ...base, chatParticipantApi: false, languageModelApi: true, languageModelAccessApi: true })).toMatchObject({
      chatParticipantApi: 'NOT_SUPPORTED',
      firstClassReviewApiReady: false,
    });
  });
});
