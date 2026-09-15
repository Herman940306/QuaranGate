/**
 * P7 I3 Cursor runtime capability/placement classification.
 *
 * Cursor is VS Code-extension compatible at a product level, but QuaranGate
 * must not infer Chat Participant or Language Model API parity from that fact.
 * This module therefore separates product/placement proof from optional public
 * API capability proof and keeps unknown capabilities fail-closed.
 */

export type CursorCapabilityState = 'PASS' | 'NOT_SUPPORTED' | 'UNKNOWN';
export type CursorBindingState = 'READY' | 'BLOCKED_PRODUCT' | 'BLOCKED_PLACEMENT';

export interface CursorRuntimeFacts {
  appName: string;
  uriScheme: string;
  remoteName: string | undefined;
  extensionHostKind: 'workspace' | 'ui' | 'unknown';
  workspaceFolderCount: number;
  cursorExtensionApi: boolean | undefined;
  chatParticipantApi: boolean | undefined;
  languageModelApi: boolean | undefined;
  languageModelAccessApi: boolean | undefined;
}

export interface CursorCompatibilityResult {
  productIdentity: CursorCapabilityState;
  remoteWslPlacement: CursorCapabilityState;
  chatParticipantApi: CursorCapabilityState;
  languageModelApi: CursorCapabilityState;
  bindingState: CursorBindingState;
  firstClassReviewApiReady: boolean;
}

function capability(value: boolean | undefined): CursorCapabilityState {
  return value === true ? 'PASS' : value === false ? 'NOT_SUPPORTED' : 'UNKNOWN';
}

/**
 * Product identity is intentionally strict. A future Cursor build that reports
 * different public environment identity must be qualified and this allowlist
 * deliberately updated; it must not silently become trusted by substring.
 */
export function classifyCursorCompatibility(facts: CursorRuntimeFacts): CursorCompatibilityResult {
  const productIdentity: CursorCapabilityState = facts.appName === 'Cursor'
    && facts.uriScheme === 'cursor'
    && facts.cursorExtensionApi === true
    ? 'PASS'
    : facts.cursorExtensionApi === undefined
      ? 'UNKNOWN'
      : 'NOT_SUPPORTED';
  const remoteWslPlacement: CursorCapabilityState = facts.remoteName === 'wsl'
    && facts.extensionHostKind === 'workspace'
    && facts.workspaceFolderCount === 1
    ? 'PASS'
    : 'NOT_SUPPORTED';
  const chatParticipantApi = capability(facts.chatParticipantApi);
  const languageModelApi = facts.languageModelApi === true && facts.languageModelAccessApi === true
    ? 'PASS'
    : facts.languageModelApi === false || facts.languageModelAccessApi === false
      ? 'NOT_SUPPORTED'
      : 'UNKNOWN';
  const bindingState: CursorBindingState = productIdentity !== 'PASS'
    ? 'BLOCKED_PRODUCT'
    : remoteWslPlacement !== 'PASS'
      ? 'BLOCKED_PLACEMENT'
      : 'READY';
  return Object.freeze({
    productIdentity,
    remoteWslPlacement,
    chatParticipantApi,
    languageModelApi,
    bindingState,
    firstClassReviewApiReady: bindingState === 'READY' && chatParticipantApi === 'PASS' && languageModelApi === 'PASS',
  });
}
