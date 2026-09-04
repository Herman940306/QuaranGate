import { Buffer } from "node:buffer";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_PROMPT_BYTES = 4 * 1024;
export const MAX_WORKSPACE_BYTES = 2 * 1024;
export const MAX_OPERATION_ID_BYTES = 64;
export const MAX_NONCE_BYTES = 128;
export const MAX_SECRET_BYTES = 128;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

export type MachineRunRequest = Readonly<{
  type: "run";
  version: typeof PROTOCOL_VERSION;
  operationId: string;
  nonce: string;
  workspace: string;
  prompt: string;
  secret: string;
}>;

export type MachineCancelRequest = Readonly<{
  type: "cancel";
  version: typeof PROTOCOL_VERSION;
  operationId: string;
  nonce: string;
  workspace: string;
  secret: string;
}>;

export type MachineRequest = MachineRunRequest | MachineCancelRequest;

export class ProtocolError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBoundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== "string") {
    throw new ProtocolError("INVALID_SCHEMA", `${field} must be a string`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if ((!allowEmpty && bytes === 0) || bytes > maximumBytes) {
    throw new ProtocolError("INVALID_SCHEMA", `${field} has an invalid length`);
  }
}

function scanJsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "\"") {
      return index + 1;
    }
  }
  return -1;
}

function rejectDuplicateTopLevelKeys(text: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (index < text.length && /\s/u.test(text[index] ?? "")) {
      index += 1;
    }
  };

  skipWhitespace();
  if (text[index] !== "{") {
    return;
  }
  index += 1;
  const keys = new Set<string>();

  while (index < text.length) {
    skipWhitespace();
    if (text[index] === "}") {
      return;
    }
    if (text[index] !== "\"") {
      return;
    }
    const end = scanJsonStringEnd(text, index);
    if (end < 0) {
      return;
    }
    let key: unknown;
    try {
      key = JSON.parse(text.slice(index, end)) as unknown;
    } catch {
      return;
    }
    if (typeof key !== "string") {
      return;
    }
    if (keys.has(key)) {
      throw new ProtocolError("INVALID_JSON", `duplicate field: ${key}`);
    }
    keys.add(key);
    index = end;
    skipWhitespace();
    if (text[index] !== ":") {
      return;
    }
    index += 1;

    let nestedDepth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{" || character === "[") {
        nestedDepth += 1;
      } else if (character === "}" || character === "]") {
        if (nestedDepth === 0 && character === "}") {
          return;
        }
        nestedDepth -= 1;
      } else if (character === "," && nestedDepth === 0) {
        index += 1;
        break;
      }
    }
  }
}

function requireExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new ProtocolError("INVALID_SCHEMA", `unexpected field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) {
      throw new ProtocolError("INVALID_SCHEMA", `missing field: ${key}`);
    }
  }
}

export function assertOperationId(value: unknown): asserts value is string {
  assertBoundedString(value, "operationId", MAX_OPERATION_ID_BYTES);
  if (!UUID_PATTERN.test(value)) {
    throw new ProtocolError("INVALID_SCHEMA", "operationId must be a UUID");
  }
}

export function assertNonce(value: unknown): asserts value is string {
  assertBoundedString(value, "nonce", MAX_NONCE_BYTES);
  if (!NONCE_PATTERN.test(value)) {
    throw new ProtocolError("INVALID_SCHEMA", "nonce has an invalid shape");
  }
}

export function assertPrompt(value: unknown): asserts value is string {
  assertBoundedString(value, "prompt", MAX_PROMPT_BYTES);
}

export function parseMachineFrame(frame: Buffer | string): MachineRequest {
  const byteLength = typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
  if (byteLength === 0 || byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError("FRAME_SIZE", "frame has an invalid size");
  }
  const text = typeof frame === "string" ? frame : frame.toString("utf8");
  rejectDuplicateTopLevelKeys(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError("INVALID_JSON", "frame is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ProtocolError("INVALID_SCHEMA", "request must be an object");
  }
  if (parsed.type !== "run" && parsed.type !== "cancel") {
    throw new ProtocolError("INVALID_SCHEMA", "type must be run or cancel");
  }
  const allowed = parsed.type === "run"
    ? ["type", "version", "operationId", "nonce", "workspace", "prompt", "secret"] as const
    : ["type", "version", "operationId", "nonce", "workspace", "secret"] as const;
  requireExactKeys(parsed, allowed);
  if (parsed.version !== PROTOCOL_VERSION) {
    throw new ProtocolError("UNSUPPORTED_VERSION", "unsupported protocol version");
  }
  assertOperationId(parsed.operationId);
  assertNonce(parsed.nonce);
  assertBoundedString(parsed.workspace, "workspace", MAX_WORKSPACE_BYTES);
  assertBoundedString(parsed.secret, "secret", MAX_SECRET_BYTES);

  if (parsed.type === "run") {
    assertPrompt(parsed.prompt);
    return {
      type: "run",
      version: PROTOCOL_VERSION,
      operationId: parsed.operationId,
      nonce: parsed.nonce,
      workspace: parsed.workspace,
      prompt: parsed.prompt,
      secret: parsed.secret,
    };
  }
  return {
    type: "cancel",
    version: PROTOCOL_VERSION,
    operationId: parsed.operationId,
    nonce: parsed.nonce,
    workspace: parsed.workspace,
    secret: parsed.secret,
  };
}

export function assertExactWorkspace(requested: string, attested: string): void {
  if (requested !== attested) {
    throw new ProtocolError("WORKSPACE_MISMATCH", "workspace does not match the attested workspace");
  }
}
