import { randomUUID } from "node:crypto";
import { AgentCore, CoreError, OperationEvent } from "./core";

export interface HumanCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export type HumanOperationResult = Readonly<{
  operationId: string;
  terminalState: string;
  rejectionCode?: string;
}>;

export async function runHumanOperation(
  core: AgentCore,
  prompt: string,
  workspace: string,
  sink: (event: OperationEvent) => void,
  token: HumanCancellationToken,
): Promise<HumanOperationResult> {
  const operationId = randomUUID();
  try {
    const handle = core.run({ operationId, origin: "human", prompt, workspace }, sink);
    const cancellation = token.onCancellationRequested(() => handle.cancel());
    if (token.isCancellationRequested) {
      handle.cancel();
    }
    try {
      const terminal = await handle.completion;
      return { operationId, terminalState: terminal.type };
    } finally {
      cancellation.dispose();
    }
  } catch (error: unknown) {
    return {
      operationId,
      terminalState: "error",
      rejectionCode: error instanceof CoreError ? error.code : "INVALID_REQUEST",
    };
  }
}
