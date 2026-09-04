import * as vscode from "vscode";
import { AuditLogger, AuditRecord } from "./audit";
import { AgentCore, OperationEvent } from "./core";
import { runHumanOperation } from "./human";
import { MachineIpcServer } from "./ipc";
import { registerDeterministicLocalProvider } from "./provider";
import { cleanupRuntime, createRuntimePaths, RuntimePaths, writeRuntimeCredential } from "./runtime";
import { attestWorkspace, WorkspaceAttestation } from "./workspace";

const PARTICIPANT_ID = "quarangate.ideChatSpike";

type SpikeChatResult = vscode.ChatResult & {
  metadata: {
    operationId: string;
    terminalState: string;
    origin: "human";
  };
};

class OutputAuditLogger implements AuditLogger {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public record(entry: AuditRecord): void {
    this.output.appendLine(JSON.stringify({ kind: "operation", ...entry }));
  }
}

type ActiveExtension = {
  paths: RuntimePaths;
  server: MachineIpcServer;
  core: AgentCore;
  output: vscode.OutputChannel;
  disposed: boolean;
};

let active: ActiveExtension | undefined;

function renderHumanEvent(stream: vscode.ChatResponseStream, event: OperationEvent): void {
  if (event.type === "started") {
    stream.progress(`Operation ${event.operationId} started (human).`);
  } else if (event.type === "chunk" && event.message !== undefined) {
    stream.markdown(`${event.message}\n\n`);
  } else if (event.type === "completed") {
    stream.markdown(`Operation ${event.operationId} completed.\n`);
  } else if (event.type === "cancelled") {
    stream.markdown(`Operation ${event.operationId} cancelled.\n`);
  } else if (event.type === "error") {
    stream.markdown(`Operation ${event.operationId} failed.\n`);
  }
}

function statusRecord(
  attestation: WorkspaceAttestation,
  paths: RuntimePaths,
): Record<string, unknown> {
  return {
    kind: "status",
    label: "SPIKE ONLY / NOT PRODUCTION / NO MUTATION AUTHORITY",
    workspaceUri: attestation.workspaceUri,
    canonicalWorkspaceUri: attestation.canonicalWorkspaceUri,
    scheme: attestation.scheme,
    remoteName: attestation.remoteName,
    canonicalPath: attestation.canonicalPath,
    extensionHostKind: attestation.extensionHostKind,
    extensionUri: attestation.extensionUri,
    instanceId: paths.instanceId,
    socketPath: paths.socketPath,
    credentialPath: paths.credentialPath,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("QuaranGate IDE Chat Spike", { log: true });
  let paths: RuntimePaths | undefined;
  let server: MachineIpcServer | undefined;
  try {
    const attestation = await attestWorkspace(context);
    paths = await createRuntimePaths();
    const logger = new OutputAuditLogger(output);
    const core = new AgentCore(logger, attestation.canonicalWorkspaceUri);
    server = new MachineIpcServer(paths.socketPath, paths.secret, attestation.canonicalWorkspaceUri, core);
    await server.start();
    await writeRuntimeCredential(paths, attestation.canonicalWorkspaceUri);

    const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
      const result = await runHumanOperation(
        core,
        request.prompt,
        attestation.canonicalWorkspaceUri,
        (event) => renderHumanEvent(stream, event),
        token,
      );
      if (result.rejectionCode !== undefined) {
        stream.markdown(`Operation ${result.operationId} was rejected (${result.rejectionCode}).\n`);
      }
      return {
        metadata: {
          operationId: result.operationId,
          terminalState: result.terminalState,
          origin: "human",
        },
      } satisfies SpikeChatResult;
    };

    const provider = registerDeterministicLocalProvider(
      vscode.lm,
      (value) => new vscode.LanguageModelTextPart(value),
    );
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    const statusCommand = vscode.commands.registerCommand("quarangateIdeChatSpike.showStatus", () => {
      output.appendLine(JSON.stringify(statusRecord(attestation, paths as RuntimePaths)));
      output.show(true);
      void vscode.window.showInformationMessage(
        "QuaranGate IDE Chat Spike is active in the WSL workspace host. See the output channel for attestation and helper paths.",
      );
    });
    context.subscriptions.push(provider, participant, statusCommand, output);
    output.appendLine(JSON.stringify(statusRecord(attestation, paths)));
    active = { paths, server, core, output, disposed: false };
  } catch (error: unknown) {
    if (server !== undefined) {
      await server.stop().catch(() => undefined);
    }
    if (paths !== undefined) {
      await cleanupRuntime(paths).catch(() => undefined);
    }
    output.dispose();
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  const current = active;
  if (current === undefined || current.disposed) {
    return;
  }
  current.disposed = true;
  current.core.shutdown();
  await current.server.stop();
  await cleanupRuntime(current.paths);
  active = undefined;
}
