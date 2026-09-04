import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { MAX_FRAME_BYTES, MachineRequest, PROTOCOL_VERSION } from "./protocol";
import { RuntimeCredential } from "./runtime";
import { ServerFrame } from "./ipc";

function isCredential(value: unknown): value is RuntimeCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "instanceId,secret,socketPath,version,workspace"
    && record.version === PROTOCOL_VERSION
    && typeof record.instanceId === "string"
    && typeof record.secret === "string"
    && typeof record.socketPath === "string"
    && typeof record.workspace === "string";
}

export async function readCredential(path: string): Promise<RuntimeCredential> {
  const text = await readFile(path, { encoding: "utf8" });
  const value = JSON.parse(text) as unknown;
  if (!isCredential(value)) {
    throw new Error("credential file has an invalid schema");
  }
  return value;
}

export function createNonce(): string {
  return randomBytes(24).toString("base64url");
}

export async function sendMachineRequest(
  credential: RuntimeCredential,
  request: MachineRequest,
  onFrame?: (frame: ServerFrame) => void,
): Promise<ServerFrame[]> {
  return await new Promise<ServerFrame[]>((resolve, reject) => {
    const socket = createConnection(credential.socketPath);
    const frames: ServerFrame[] = [];
    let buffer = Buffer.alloc(0);
    socket.setTimeout(30_000);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`, "utf8"));
    socket.on("timeout", () => socket.destroy(new Error("IPC response timed out")));
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      if (buffer.byteLength + chunk.byteLength > MAX_FRAME_BYTES * 16) {
        socket.destroy(new Error("IPC response exceeded the client bound"));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          break;
        }
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        const parsed = JSON.parse(line) as ServerFrame;
        frames.push(parsed);
        onFrame?.(parsed);
      }
    });
    socket.on("end", () => {
      if (buffer.toString("utf8").trim().length !== 0) {
        reject(new Error("IPC response ended with an incomplete frame"));
      } else {
        resolve(frames);
      }
    });
  });
}
