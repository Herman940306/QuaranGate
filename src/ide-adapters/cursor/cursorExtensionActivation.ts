/**
 * P7 I3 Cursor companion composition.
 *
 * This source slice intentionally qualifies only the authenticated Cursor
 * companion/session/workspace path. It does not assume Cursor Chat Participant
 * or Language Model API parity with VS Code. Those optional APIs are classified
 * separately and must be live-proven before a first-class Cursor review UX is
 * enabled.
 */
import type { IdeWorkspacePhysicalIdentity } from '../../shared/ideWorkspaceAttestation.js';
import {
  CursorCommandChannel,
  type CursorRemoteReviewHandler,
} from './cursorCommandChannel.js';
import {
  connectCursorCompanion,
  type CursorCompanionConnection,
} from './cursorCompanionConnection.js';
import { readCursorCompanionCredential } from './cursorCompanionCredential.js';
import {
  classifyCursorCompatibility,
  type CursorCompatibilityResult,
  type CursorRuntimeFacts,
} from './cursorCompatibility.js';
import {
  collectCursorWorkspacePhysicalIdentity,
  type CursorWorkspaceCollectorOptions,
  type CursorWorkspaceSnapshot,
} from './cursorWorkspaceCollector.js';

export interface CursorProductionActivationInput {
  runtimeFacts: CursorRuntimeFacts;
  workspaceSnapshotProvider(): CursorWorkspaceSnapshot;
  workspaceCollectorOptions?: CursorWorkspaceCollectorOptions;
  adapterVersion: string;
  credentialPath?: string;
  reviewHandler?: CursorRemoteReviewHandler;
}

export type CursorCompanionReadiness = 'UNAVAILABLE' | 'CONNECTED_ATTESTED_READY';

export interface CursorProductionActivationHandle {
  compatibility: CursorCompatibilityResult;
  readiness(): CursorCompanionReadiness;
  dispose(): void;
}

function bindingWithoutSecret(credential: ReturnType<typeof readCursorCompanionCredential>) {
  const { secret: _secret, ...binding } = credential;
  return binding;
}

export async function activateCursorProductionComposition(
  input: CursorProductionActivationInput,
): Promise<CursorProductionActivationHandle> {
  const compatibility = classifyCursorCompatibility(input.runtimeFacts);
  let connection: CursorCompanionConnection | undefined;
  let channel: CursorCommandChannel | undefined;
  let workspace: IdeWorkspacePhysicalIdentity | undefined;

  // Product/placement is proven before any credential read or socket open.
  if (compatibility.bindingState === 'READY' && input.credentialPath !== undefined && input.credentialPath.length > 0) {
    try {
      workspace = await collectCursorWorkspacePhysicalIdentity(input.workspaceSnapshotProvider(), input.workspaceCollectorOptions);
      const credential = readCursorCompanionCredential(input.credentialPath, input.adapterVersion);
      const credentialBinding = bindingWithoutSecret(credential);
      connection = await connectCursorCompanion({ credential, workspace });
      channel = new CursorCommandChannel({
        connection,
        credentialBinding,
        collectWorkspace: async () => await collectCursorWorkspacePhysicalIdentity(
          input.workspaceSnapshotProvider(),
          input.workspaceCollectorOptions,
        ),
        ...(input.reviewHandler === undefined ? {} : { reviewHandler: input.reviewHandler }),
      });
      channel.start();
    } catch {
      channel?.stop();
      connection?.close();
      channel = undefined;
      connection = undefined;
      workspace = undefined;
    }
  }

  let disposed = false;
  return {
    compatibility,
    readiness: () => channel !== undefined && connection !== undefined && workspace !== undefined && channel.isReady()
      ? 'CONNECTED_ATTESTED_READY'
      : 'UNAVAILABLE',
    dispose: () => {
      if (disposed) return;
      disposed = true;
      channel?.stop();
      connection?.close();
      channel = undefined;
      connection = undefined;
      workspace = undefined;
    },
  };
}
