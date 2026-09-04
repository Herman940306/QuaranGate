import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, Server, Socket } from "node:net";
import { AgentCore, CoreError, OperationEvent } from "./core";
import {
  assertExactWorkspace,
  MAX_FRAME_BYTES,
  MachineRequest,
  parseMachineFrame,
  ProtocolError,
  PROTOCOL_VERSION,
} from "./protocol";
import { assertSocketReady } from "./runtime";

const MAX_CONNECTIONS = 16;
const CONNECTION_TIMEOUT_MILLISECONDS = 30_000;
const MAX_NONCES = 2_048;

type ErrorFrame = Readonly<{
  version: typeof PROTOCOL_VERSION;
  type: "error";
  code: string;
}>;

type CancelFrame = Readonly<{
  version: typeof PROTOCOL_VERSION;
  type: "cancelResult";
  operationId: string;
  result: "accepted" | "stale" | "wrong-origin";
}>;

export type ServerFrame = OperationEvent | ErrorFrame | CancelFrame;

class NonceRegistry {
  private readonly values = new Set<string>();

  public claim(nonce: string): void {
    if (this.values.has(nonce)) {
      throw new ProtocolError("REPLAY", "nonce has already been used");
    }
    if (this.values.size >= MAX_NONCES) {
      throw new ProtocolError("NONCE_CAPACITY", "nonce capacity reached; restart required");
    }
    this.values.add(nonce);
  }
}

function secretMatches(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function writeFrame(socket: Socket, frame: ServerFrame): void {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(frame)}\n`, "utf8");
  }
}

function publicError(error: unknown): ErrorFrame {
  if (error instanceof ProtocolError || error instanceof CoreError) {
    return { version: PROTOCOL_VERSION, type: "error", code: error.code };
  }
  return { version: PROTOCOL_VERSION, type: "error", code: "INTERNAL" };
}

export class MachineIpcServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly nonces = new NonceRegistry();
  private started = false;

  public constructor(
    private readonly socketPath: string,
    private readonly secret: string,
    private readonly workspace: string,
    private readonly core: AgentCore,
  ) {
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = MAX_CONNECTIONS;
  }

  public async start(): Promise<void> {
    if (process.platform === "win32") {
      throw new Error("Unix-domain sockets are required for this WSL spike");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    this.started = true;
    await assertSocketReady(this.socketPath);
  }

  public async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (!this.started) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.started = false;
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= MAX_CONNECTIONS) {
      writeFrame(socket, { version: PROTOCOL_VERSION, type: "error", code: "CAPACITY" });
      socket.end();
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(CONNECTION_TIMEOUT_MILLISECONDS);
    let buffer = Buffer.alloc(0);
    let handled = false;
    let runningOperationId: string | undefined;

    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (runningOperationId !== undefined) {
        this.core.cancel(runningOperationId, "machine");
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (handled) {
        socket.destroy();
        return;
      }
      if (buffer.byteLength + chunk.byteLength > MAX_FRAME_BYTES + 1) {
        handled = true;
        writeFrame(socket, { version: PROTOCOL_VERSION, type: "error", code: "FRAME_SIZE" });
        socket.end();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const remainder = buffer.subarray(newline + 1).toString("utf8").trim();
      handled = true;
      if (remainder.length !== 0) {
        writeFrame(socket, { version: PROTOCOL_VERSION, type: "error", code: "MULTIPLE_FRAMES" });
        socket.end();
        return;
      }
      const frame = buffer.subarray(0, newline);
      void this.handleFrame(socket, frame, (operationId) => {
        runningOperationId = operationId;
      }).finally(() => {
        runningOperationId = undefined;
      });
    });
  }

  private async handleFrame(
    socket: Socket,
    frame: Buffer,
    setRunningOperation: (operationId: string) => void,
  ): Promise<void> {
    try {
      const request = parseMachineFrame(frame);
      this.authorize(request);
      if (request.type === "cancel") {
        const result = this.core.cancel(request.operationId, "machine");
        writeFrame(socket, {
          version: PROTOCOL_VERSION,
          type: "cancelResult",
          operationId: request.operationId,
          result,
        });
        socket.end();
        return;
      }
      const handle = this.core.run(
        {
          operationId: request.operationId,
          origin: "machine",
          prompt: request.prompt,
          workspace: this.workspace,
        },
        (event) => writeFrame(socket, event),
      );
      setRunningOperation(handle.operationId);
      await handle.completion;
      socket.end();
    } catch (error: unknown) {
      writeFrame(socket, publicError(error));
      socket.end();
    }
  }

  private authorize(request: MachineRequest): void {
    if (!secretMatches(request.secret, this.secret)) {
      throw new ProtocolError("AUTH_DENIED", "authentication denied");
    }
    assertExactWorkspace(request.workspace, this.workspace);
    this.nonces.claim(request.nonce);
  }
}
