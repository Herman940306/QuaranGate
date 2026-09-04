import assert = require("node:assert/strict");
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  assertExactWorkspace,
  MAX_FRAME_BYTES,
  MAX_PROMPT_BYTES,
  parseMachineFrame,
  ProtocolError,
} from "../src/protocol";

function validRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "run",
    version: 1,
    operationId: randomUUID(),
    nonce: "n".repeat(32),
    workspace: "file:///home/herman/projects/quarangate-ide-session",
    prompt: "transport proof",
    secret: "s".repeat(43),
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof ProtocolError && error.code === code);
}

test("accepts the exact run and cancel schemas", () => {
  const run = parseMachineFrame(JSON.stringify(validRun()));
  assert.equal(run.type, "run");
  const cancel = parseMachineFrame(JSON.stringify({
    type: "cancel",
    version: 1,
    operationId: randomUUID(),
    nonce: "c".repeat(32),
    workspace: "file:///workspace",
    secret: "s".repeat(43),
  }));
  assert.equal(cancel.type, "cancel");
});

test("rejects unexpected, missing, and duplicate fields", () => {
  expectCode(() => parseMachineFrame(JSON.stringify(validRun({ admin: true }))), "INVALID_SCHEMA");
  const missing = validRun();
  delete missing.prompt;
  expectCode(() => parseMachineFrame(JSON.stringify(missing)), "INVALID_SCHEMA");
  const duplicate = `{"type":"run","type":"cancel","version":1,"operationId":"${randomUUID()}","nonce":"${"n".repeat(32)}","workspace":"file:///workspace","secret":"${"s".repeat(43)}"}`;
  expectCode(() => parseMachineFrame(duplicate), "INVALID_JSON");
});

test("rejects oversized frames and fields", () => {
  expectCode(() => parseMachineFrame("x".repeat(MAX_FRAME_BYTES + 1)), "FRAME_SIZE");
  expectCode(
    () => parseMachineFrame(JSON.stringify(validRun({ prompt: "p".repeat(MAX_PROMPT_BYTES + 1) }))),
    "INVALID_SCHEMA",
  );
});

test("rejects bad nonce, operation ID, version, and field types", () => {
  expectCode(() => parseMachineFrame(JSON.stringify(validRun({ nonce: "../bad" }))), "INVALID_SCHEMA");
  expectCode(() => parseMachineFrame(JSON.stringify(validRun({ operationId: "operation-1" }))), "INVALID_SCHEMA");
  expectCode(() => parseMachineFrame(JSON.stringify(validRun({ version: 2 }))), "UNSUPPORTED_VERSION");
  expectCode(() => parseMachineFrame(JSON.stringify(validRun({ prompt: 42 }))), "INVALID_SCHEMA");
});

test("workspace matching is exact and rejects alternate path forms", () => {
  const attested = "file:///home/herman/projects/quarangate-ide-session";
  assert.doesNotThrow(() => assertExactWorkspace(attested, attested));
  for (const candidate of [
    "file:///home/herman/projects/other",
    "../quarangate-ide-session",
    "C:\\Users\\herman\\project",
    "\\\\server\\share",
    "file:///home/herman/projects/quarangate-ide-session/../other",
  ]) {
    expectCode(() => assertExactWorkspace(candidate, attested), "WORKSPACE_MISMATCH");
  }
});
