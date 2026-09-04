import { createHash, randomUUID } from "node:crypto";
import { AuditLogger, InvocationOrigin, OperationState } from "./audit";
import { assertOperationId, assertPrompt } from "./protocol";

const DEFAULT_CHUNKS = [
  "request accepted",
  "workspace verified",
  "step 1",
  "step 2",
  "complete",
] as const;

export type OperationEvent = Readonly<{
  version: 1;
  operationId: string;
  origin: InvocationOrigin;
  sequence: number;
  type: OperationState;
  message?: string;
}>;

export type OperationSnapshot = Readonly<{
  operationId: string;
  origin: InvocationOrigin;
  state: "running" | "cancelling" | "completed" | "cancelled" | "error";
}>;

export type CancelResult = "accepted" | "stale" | "wrong-origin";

export type CoreRunInput = Readonly<{
  operationId?: string;
  origin: InvocationOrigin;
  prompt: string;
  workspace: string;
}>;

export type OperationHandle = Readonly<{
  operationId: string;
  completion: Promise<OperationEvent>;
  cancel: () => CancelResult;
}>;

type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;

type ActiveOperation = {
  origin: InvocationOrigin;
  controller: AbortController;
  state: "running" | "cancelling";
};

export class CoreError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CoreError";
  }
}

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class AgentCore {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly history = new Map<string, OperationSnapshot>();
  private readonly usedOperationIds = new Set<string>();
  private readonly workspaceFingerprint: string;

  public constructor(
    private readonly audit: AuditLogger,
    workspace: string,
    private readonly delay: Delay = defaultDelay,
    private readonly stepDelayMilliseconds = 750,
    private readonly maxActiveOperations = 16,
    private readonly maxHistory = 256,
    private readonly maxOperationIds = 2_048,
  ) {
    this.workspaceFingerprint = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  }

  public run(input: CoreRunInput, sink: (event: OperationEvent) => void): OperationHandle {
    assertPrompt(input.prompt);
    const operationId = input.operationId ?? randomUUID();
    assertOperationId(operationId);
    if (this.usedOperationIds.has(operationId)) {
      throw new CoreError("OPERATION_COLLISION", "operation ID already exists");
    }
    if (this.usedOperationIds.size >= this.maxOperationIds) {
      throw new CoreError("OPERATION_ID_CAPACITY", "operation ID capacity reached; restart required");
    }
    if (this.active.size >= this.maxActiveOperations) {
      throw new CoreError("CAPACITY", "operation capacity reached");
    }

    const controller = new AbortController();
    this.usedOperationIds.add(operationId);
    this.active.set(operationId, { origin: input.origin, controller, state: "running" });
    const completion = this.execute(operationId, input.origin, sink, controller.signal);
    return {
      operationId,
      completion,
      cancel: () => this.cancel(operationId, input.origin),
    };
  }

  public cancel(operationId: string, requester: InvocationOrigin): CancelResult {
    const operation = this.active.get(operationId);
    if (operation === undefined) {
      return "stale";
    }
    if (operation.origin !== requester) {
      return "wrong-origin";
    }
    if (operation.state === "cancelling") {
      return "accepted";
    }
    operation.state = "cancelling";
    operation.controller.abort(new Error("operation cancelled"));
    return "accepted";
  }

  public getOperation(operationId: string): OperationSnapshot | undefined {
    const active = this.active.get(operationId);
    if (active !== undefined) {
      return { operationId, origin: active.origin, state: active.state };
    }
    return this.history.get(operationId);
  }

  public shutdown(): void {
    for (const operation of this.active.values()) {
      operation.state = "cancelling";
      operation.controller.abort(new Error("agent core shutting down"));
    }
  }

  private async execute(
    operationId: string,
    origin: InvocationOrigin,
    sink: (event: OperationEvent) => void,
    signal: AbortSignal,
  ): Promise<OperationEvent> {
    let sequence = 0;
    const emit = (type: OperationState, message?: string): OperationEvent => {
      const event: OperationEvent = message === undefined
        ? { version: 1, operationId, origin, sequence, type }
        : { version: 1, operationId, origin, sequence, type, message };
      sequence += 1;
      try {
        sink(event);
      } catch {
        // A presentation channel cannot own or strand the operation lifecycle.
      }
      try {
        this.audit.record({
          operationId,
          origin,
          state: type,
          sequence: event.sequence,
          workspaceFingerprint: this.workspaceFingerprint,
        });
      } catch {
        // Audit availability is a production gap; S1 remains deterministic and bounded.
      }
      return event;
    };

    emit("started");
    try {
      for (const chunk of DEFAULT_CHUNKS) {
        await this.delay(this.stepDelayMilliseconds, signal);
        if (signal.aborted) {
          throw signal.reason;
        }
        emit("chunk", chunk);
      }
      const terminal = emit("completed");
      this.finish(operationId, origin, "completed");
      return terminal;
    } catch (error: unknown) {
      if (signal.aborted) {
        const terminal = emit("cancelled");
        this.finish(operationId, origin, "cancelled");
        return terminal;
      }
      const terminal = emit("error", error instanceof Error ? "operation failed" : "unknown failure");
      this.finish(operationId, origin, "error");
      return terminal;
    }
  }

  private finish(
    operationId: string,
    origin: InvocationOrigin,
    state: "completed" | "cancelled" | "error",
  ): void {
    this.active.delete(operationId);
    if (this.history.size >= this.maxHistory) {
      const oldest = this.history.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.history.delete(oldest);
      }
    }
    this.history.set(operationId, { operationId, origin, state });
  }
}
