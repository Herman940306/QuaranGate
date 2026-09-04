import assert = require("node:assert/strict");
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MemoryAuditLogger } from "../src/audit";
import { AgentCore, CoreError, OperationEvent } from "../src/core";

const WORKSPACE = "file:///home/herman/projects/quarangate-ide-session";

function timerDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

test("streams ordered events and records a terminal state", async () => {
  const logger = new MemoryAuditLogger();
  const events: OperationEvent[] = [];
  const core = new AgentCore(logger, WORKSPACE, async () => undefined, 0);
  const handle = core.run({ origin: "human", prompt: "hello", workspace: WORKSPACE }, (event) => events.push(event));
  const terminal = await handle.completion;

  assert.deepEqual(events.map((event) => event.type), [
    "started", "chunk", "chunk", "chunk", "chunk", "chunk", "completed",
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(terminal.type, "completed");
  assert.equal(core.getOperation(handle.operationId)?.state, "completed");
  assert.equal(logger.entries.at(-1)?.state, "completed");
});

test("human-style cancellation reaches only its operation", async () => {
  const logger = new MemoryAuditLogger();
  const core = new AgentCore(logger, WORKSPACE, timerDelay, 15);
  const humanEvents: OperationEvent[] = [];
  const machineEvents: OperationEvent[] = [];
  const human = core.run({ origin: "human", prompt: "human", workspace: WORKSPACE }, (event) => humanEvents.push(event));
  const machine = core.run({ origin: "machine", prompt: "machine", workspace: WORKSPACE }, (event) => machineEvents.push(event));

  assert.equal(core.cancel(human.operationId, "machine"), "wrong-origin");
  assert.equal(human.cancel(), "accepted");
  const [humanTerminal, machineTerminal] = await Promise.all([human.completion, machine.completion]);
  assert.equal(humanTerminal.type, "cancelled");
  assert.equal(machineTerminal.type, "completed");
  assert.equal(humanEvents.at(-1)?.type, "cancelled");
  assert.equal(machineEvents.at(-1)?.type, "completed");
  assert.equal(core.cancel(human.operationId, "human"), "stale");
});

test("rejects operation-ID collisions without merging streams", async () => {
  const core = new AgentCore(new MemoryAuditLogger(), WORKSPACE, timerDelay, 10);
  const operationId = randomUUID();
  const first = core.run({ operationId, origin: "machine", prompt: "first", workspace: WORKSPACE }, () => undefined);
  assert.throws(
    () => core.run({ operationId, origin: "machine", prompt: "second", workspace: WORKSPACE }, () => undefined),
    (error: unknown) => error instanceof CoreError && error.code === "OPERATION_COLLISION",
  );
  first.cancel();
  await first.completion;
});

test("operation IDs remain reserved after history eviction and capacity fails closed", async () => {
  const core = new AgentCore(new MemoryAuditLogger(), WORKSPACE, async () => undefined, 0, 16, 1, 2);
  const firstId = randomUUID();
  const secondId = randomUUID();
  await core.run({ operationId: firstId, origin: "machine", prompt: "first", workspace: WORKSPACE }, () => undefined).completion;
  await core.run({ operationId: secondId, origin: "machine", prompt: "second", workspace: WORKSPACE }, () => undefined).completion;
  assert.equal(core.getOperation(firstId), undefined);
  assert.throws(
    () => core.run({ operationId: firstId, origin: "machine", prompt: "reused", workspace: WORKSPACE }, () => undefined),
    (error: unknown) => error instanceof CoreError && error.code === "OPERATION_COLLISION",
  );
  assert.throws(
    () => core.run({ origin: "human", prompt: "over capacity", workspace: WORKSPACE }, () => undefined),
    (error: unknown) => error instanceof CoreError && error.code === "OPERATION_ID_CAPACITY",
  );
});

test("shutdown aborts all active operations independently", async () => {
  const core = new AgentCore(new MemoryAuditLogger(), WORKSPACE, timerDelay, 20);
  const human = core.run({ origin: "human", prompt: "human", workspace: WORKSPACE }, () => undefined);
  const machine = core.run({ origin: "machine", prompt: "machine", workspace: WORKSPACE }, () => undefined);
  core.shutdown();
  const terminals = await Promise.all([human.completion, machine.completion]);
  assert.deepEqual(terminals.map((terminal) => terminal.type), ["cancelled", "cancelled"]);
});

test("audit records omit prompts and credentials by construction", async () => {
  const logger = new MemoryAuditLogger();
  const core = new AgentCore(logger, WORKSPACE, async () => undefined, 0);
  const secretMarker = "SECRET-MUST-NOT-BE-LOGGED";
  const promptMarker = "PROMPT-MUST-NOT-BE-LOGGED";
  const handle = core.run({
    origin: "machine",
    prompt: `${promptMarker} ${secretMarker}`,
    workspace: WORKSPACE,
  }, () => undefined);
  await handle.completion;
  const serialized = JSON.stringify(logger.entries);
  assert.equal(serialized.includes(secretMarker), false);
  assert.equal(serialized.includes(promptMarker), false);
});
