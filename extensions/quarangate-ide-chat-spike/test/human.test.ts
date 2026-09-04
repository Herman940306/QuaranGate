import assert = require("node:assert/strict");
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { MemoryAuditLogger } from "../src/audit";
import { AgentCore, OperationEvent } from "../src/core";
import { HumanCancellationToken, runHumanOperation } from "../src/human";

const WORKSPACE = "file:///home/herman/projects/quarangate-ide-session";

class TestCancellationToken implements HumanCancellationToken {
  public isCancellationRequested = false;
  private readonly listeners = new Set<() => void>();

  public onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function timerDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

test("human adapter invokes shared AgentCore with ordered human events and no model input", async () => {
  const logger = new MemoryAuditLogger();
  const core = new AgentCore(logger, WORKSPACE, async () => undefined, 0);
  const events: OperationEvent[] = [];
  const result = await runHumanOperation(core, "deterministic transport proof", WORKSPACE, (event) => {
    events.push(event);
  }, new TestCancellationToken());

  assert.equal(result.terminalState, "completed");
  assert.deepEqual(events.map((event) => event.type), [
    "started", "chunk", "chunk", "chunk", "chunk", "chunk", "completed",
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(events.every((event) => event.operationId === result.operationId), true);
  assert.equal(events.every((event) => event.origin === "human"), true);
  assert.equal(logger.entries.every((entry) => entry.origin === "human"), true);
});

test("human cancellation token cancels only its exact human operation", async () => {
  const core = new AgentCore(new MemoryAuditLogger(), WORKSPACE, timerDelay, 10);
  const cancelledToken = new TestCancellationToken();
  const independentToken = new TestCancellationToken();
  const cancelled = runHumanOperation(core, "cancel me", WORKSPACE, () => undefined, cancelledToken);
  const independent = runHumanOperation(core, "leave me", WORKSPACE, () => undefined, independentToken);

  cancelledToken.cancel();
  const [cancelledResult, independentResult] = await Promise.all([cancelled, independent]);
  assert.equal(cancelledResult.terminalState, "cancelled");
  assert.equal(independentResult.terminalState, "completed");
  assert.notEqual(cancelledResult.operationId, independentResult.operationId);
  assert.equal(core.cancel(cancelledResult.operationId, "human"), "stale");
  assert.equal(core.getOperation(independentResult.operationId)?.state, "completed");
});

test("pre-cancelled human token reaches cancelled without affecting a machine operation", async () => {
  const core = new AgentCore(new MemoryAuditLogger(), WORKSPACE, timerDelay, 10);
  const token = new TestCancellationToken();
  token.cancel();
  const machine = core.run({ origin: "machine", prompt: "machine", workspace: WORKSPACE }, () => undefined);
  const human = runHumanOperation(core, "human", WORKSPACE, () => undefined, token);
  const [humanResult, machineResult] = await Promise.all([human, machine.completion]);

  assert.equal(humanResult.terminalState, "cancelled");
  assert.equal(machineResult.type, "completed");
});

test("real participant handler delegates to human adapter without using request.model", async () => {
  const source = await readFile(resolve(process.cwd(), "src/extension.ts"), "utf8");
  assert.match(source, /runHumanOperation\(\s*core,\s*request\.prompt,/u);
  assert.equal(source.includes("request.model"), false);
});
