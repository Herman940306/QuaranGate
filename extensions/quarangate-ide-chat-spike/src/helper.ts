import { randomUUID } from "node:crypto";
import { createNonce, readCredential, sendMachineRequest } from "./client";
import { MachineRequest, PROTOCOL_VERSION } from "./protocol";

type HelperArguments = Readonly<{
  credentialPath: string;
  action: "run" | "cancel";
  operationId: string;
  prompt?: string;
}>;

function usage(): never {
  throw new Error(
    "usage: node dist/src/helper.js --credential <path> run --prompt <text> [--operation-id <uuid>] | "
      + "--credential <path> cancel --operation-id <uuid>",
  );
}

function parseArguments(argv: readonly string[]): HelperArguments {
  let credentialPath: string | undefined;
  let action: "run" | "cancel" | undefined;
  let operationId: string | undefined;
  let prompt: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--credential") {
      credentialPath = argv[index + 1];
      index += 1;
    } else if (argument === "--operation-id") {
      operationId = argv[index + 1];
      index += 1;
    } else if (argument === "--prompt") {
      prompt = argv[index + 1];
      index += 1;
    } else if (argument === "run" || argument === "cancel") {
      action = argument;
    } else {
      usage();
    }
  }
  if (credentialPath === undefined || action === undefined) {
    usage();
  }
  const resolvedOperationId = operationId ?? (action === "run" ? randomUUID() : undefined);
  if (resolvedOperationId === undefined) {
    usage();
  }
  if (action === "run") {
    if (prompt === undefined) {
      usage();
    }
    return { credentialPath, action, operationId: resolvedOperationId, prompt };
  }
  return { credentialPath, action, operationId: resolvedOperationId };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const credential = await readCredential(args.credentialPath);
  const base = {
    version: PROTOCOL_VERSION,
    operationId: args.operationId,
    nonce: createNonce(),
    workspace: credential.workspace,
    secret: credential.secret,
  } as const;
  const request: MachineRequest = args.action === "run"
    ? { ...base, type: "run", prompt: args.prompt ?? "" }
    : { ...base, type: "cancel" };

  process.stderr.write(`operationId=${args.operationId}\n`);
  const frames = await sendMachineRequest(credential, request, (frame) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  });
  if (frames.some((frame) => frame.type === "error")) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "helper failed"}\n`);
  process.exitCode = 1;
});
