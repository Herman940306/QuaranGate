import { randomUUID } from "node:crypto";
import { createNonce, readCredential, sendMachineRequest } from "./client";
import { ServerFrame } from "./ipc";
import { MachineCancelRequest, MachineRunRequest, PROTOCOL_VERSION } from "./protocol";

function errorCode(frames: readonly ServerFrame[]): string | undefined {
  const frame = frames.find((candidate) => "code" in candidate);
  return frame !== undefined && "code" in frame ? frame.code : undefined;
}

async function main(): Promise<void> {
  const credentialPath = process.argv[2];
  if (credentialPath === undefined || process.argv.length !== 3) {
    throw new Error("usage: node dist/src/liveProbe.js <credential-path>");
  }
  const credential = await readCredential(credentialPath);
  const operationId = randomUUID();
  const run: MachineRunRequest = {
    type: "run",
    version: PROTOCOL_VERSION,
    operationId,
    nonce: createNonce(),
    workspace: credential.workspace,
    prompt: "bounded live machine cancellation probe",
    secret: credential.secret,
  };
  let cancelPromise: Promise<ServerFrame[]> | undefined;
  const runPromise = sendMachineRequest(credential, run, (frame) => {
    if (frame.type === "started" && cancelPromise === undefined) {
      const cancel: MachineCancelRequest = {
        type: "cancel",
        version: PROTOCOL_VERSION,
        operationId,
        nonce: createNonce(),
        workspace: credential.workspace,
        secret: credential.secret,
      };
      cancelPromise = sendMachineRequest(credential, cancel);
    }
  });
  const runFrames = await runPromise;
  const cancelFrames = cancelPromise === undefined ? [] : await cancelPromise;

  const badSecretFrames = await sendMachineRequest(credential, {
    ...run,
    operationId: randomUUID(),
    nonce: createNonce(),
    secret: "invalid-local-secret",
  });
  const wrongWorkspaceFrames = await sendMachineRequest(credential, {
    ...run,
    operationId: randomUUID(),
    nonce: createNonce(),
    workspace: "file:///wrong-workspace",
  });
  const staleFrames = await sendMachineRequest(credential, {
    type: "cancel",
    version: PROTOCOL_VERSION,
    operationId,
    nonce: createNonce(),
    workspace: credential.workspace,
    secret: credential.secret,
  });

  const result = {
    operationId,
    runTerminal: runFrames.at(-1)?.type,
    cancelResult: cancelFrames[0]?.type === "cancelResult" ? cancelFrames[0].result : undefined,
    badSecret: errorCode(badSecretFrames),
    wrongWorkspace: errorCode(wrongWorkspaceFrames),
    staleCancel: staleFrames[0]?.type === "cancelResult" ? staleFrames[0].result : undefined,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (
    result.runTerminal !== "cancelled"
    || result.cancelResult !== "accepted"
    || result.badSecret !== "AUTH_DENIED"
    || result.wrongWorkspace !== "WORKSPACE_MISMATCH"
    || result.staleCancel !== "stale"
  ) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "live probe failed"}\n`);
  process.exitCode = 1;
});
