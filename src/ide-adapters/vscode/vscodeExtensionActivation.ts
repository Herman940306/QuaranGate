/**
 * P7 I2 production VS Code extension-side composition.
 *
 * Activation composes already accepted B4/B5/B6/I2.2/model/participant pieces.
 * It does not create an operation, request model consent, or send a model
 * prompt. A user review request is forwarded only through the command channel's
 * non-authoritative review-intent bridge; QuaranGate creates the controller and
 * authoritative B7 operation identity on the server side.
 */
import type { IdeWorkspacePhysicalIdentity } from '../../shared/ideWorkspaceAttestation.js';
import {
  registerVsCodeChatParticipantSetup,
  type VsCodeChatApiPort,
  type VsCodeGovernedReviewPort,
  type VsCodeParticipantRegistrationContext,
  type VsCodeParticipantRegistrationResult,
  type VsCodeParticipantRuntimeReadiness,
} from './vscodeChatParticipantSetup.js';
import {
  connectVsCodeCompanion,
  type VsCodeCompanionConnection,
} from './vscodeCompanionConnection.js';
import { readVsCodeCompanionCredential } from './vscodeCompanionCredential.js';
import {
  VsCodeCommandChannel,
} from './vscodeCommandChannel.js';
import {
  VsCodeModelAccessController,
  VsCodePublicApiReviewHandler,
  type VsCodeExactModelSelector,
  type VsCodePublicLanguageModelApi,
} from './vscodePublicApiModelExecution.js';
import {
  collectVsCodeWorkspacePhysicalIdentity,
  type VsCodeWorkspaceCollectorOptions,
  type VsCodeWorkspaceSnapshot,
} from './vscodeWorkspaceCollector.js';

export interface VsCodeProductionActivationInput {
  chat: VsCodeChatApiPort;
  registration: VsCodeParticipantRegistrationContext;
  /** Narrow live VS Code fact provider. Every call must observe the current host/folder shape. */
  workspaceSnapshotProvider(): VsCodeWorkspaceSnapshot;
  /** Trusted collector test seam; the production extension entrypoint omits it. */
  workspaceCollectorOptions?: VsCodeWorkspaceCollectorOptions;
  adapterVersion: string;
  credentialPath?: string;
  modelSelector?: VsCodeExactModelSelector;
  modelApi?: VsCodePublicLanguageModelApi;
}

export interface VsCodeProductionActivationHandle {
  registration: VsCodeParticipantRegistrationResult;
  dispose(): void;
}

function bindingWithoutSecret(credential: ReturnType<typeof readVsCodeCompanionCredential>) {
  const { secret: _secret, ...binding } = credential;
  return binding;
}

function disconnectedReadiness(): VsCodeParticipantRuntimeReadiness {
  return { connection: 'UNAVAILABLE', workspace: 'NOT_ATTESTED', transport: 'NOT_READY' };
}

export async function activateVsCodeProductionComposition(
  input: VsCodeProductionActivationInput,
): Promise<VsCodeProductionActivationHandle> {
  let connection: VsCodeCompanionConnection | undefined;
  let channel: VsCodeCommandChannel | undefined;
  let workspace: IdeWorkspacePhysicalIdentity | undefined;
  let readiness = disconnectedReadiness();

  const modelAccess = input.modelSelector !== undefined && input.modelApi !== undefined
    ? new VsCodeModelAccessController(input.modelApi, input.modelSelector)
    : undefined;

  const readinessPort = {
    snapshot: (): VsCodeParticipantRuntimeReadiness => {
      if (channel === undefined || connection === undefined || workspace === undefined || !channel.isReady()) {
        return disconnectedReadiness();
      }
      return readiness;
    },
  };

  const governedReview: VsCodeGovernedReviewPort = {
    isAvailable: () => channel?.isReady() === true,
    requestReview: async (request) => {
      const current = channel;
      if (current === undefined || !current.isReady()) throw new Error('QuaranGate governed review admission is unavailable');
      return await current.requestUserReview({
        prompt: request.prompt,
        signal: request.signal,
        emit: (type, message) => request.emit({ type, message }),
      });
    },
  };

  // Registration prerequisites are checked before any credential read/socket
  // connection. Unsupported placement therefore cannot even transiently open a
  // QuaranGate channel during extension activation.
  const registration = registerVsCodeChatParticipantSetup({
    chat: input.chat,
    registration: input.registration,
    readiness: readinessPort,
    governedReview,
    ...(modelAccess === undefined ? {} : { modelAccess }),
  });

  if (registration.registered && input.credentialPath !== undefined && input.credentialPath.length > 0) {
    try {
      workspace = await collectVsCodeWorkspacePhysicalIdentity(input.workspaceSnapshotProvider(), input.workspaceCollectorOptions);
      const credential = readVsCodeCompanionCredential(input.credentialPath, input.adapterVersion);
      const credentialBinding = bindingWithoutSecret(credential);
      connection = await connectVsCodeCompanion({ credential, workspace });
      const currentConnection = connection;
      const reviewHandler = modelAccess === undefined || input.modelApi === undefined
        ? undefined
        : new VsCodePublicApiReviewHandler({ api: input.modelApi, access: modelAccess.remoteAccess() });
      channel = new VsCodeCommandChannel({
        connection: currentConnection,
        credentialBinding,
        collectWorkspace: async () => await collectVsCodeWorkspacePhysicalIdentity(input.workspaceSnapshotProvider(), input.workspaceCollectorOptions),
        ...(reviewHandler === undefined ? {} : { reviewHandler }),
      });
      channel.start();
      readiness = { connection: 'CONNECTED', workspace: 'ATTESTED', transport: 'READY' };
    } catch {
      channel?.stop();
      connection?.close();
      channel = undefined;
      connection = undefined;
      workspace = undefined;
      readiness = disconnectedReadiness();
    }
  }

  let disposed = false;
  return {
    registration,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (registration.registered) registration.participant.dispose();
      channel?.stop();
      connection?.close();
      channel = undefined;
      connection = undefined;
    },
  };
}
