import assert = require("node:assert/strict");
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type * as vscode from "vscode";
import {
  DeterministicLocalChatProvider,
  registerDeterministicLocalProvider,
  SPIKE_MODEL_INFORMATION,
  SPIKE_PROVIDER_NAME,
  SPIKE_PROVIDER_RESPONSE,
  SPIKE_PROVIDER_VENDOR,
} from "../src/provider";

const cancellation = {} as vscode.CancellationToken;
const options = {} as vscode.ProvideLanguageModelChatResponseOptions;

test("registers one deterministic provider through the public registration seam", () => {
  let registeredVendor: string | undefined;
  let registeredProvider: vscode.LanguageModelChatProvider | undefined;
  const disposable = { dispose: () => undefined };
  const result = registerDeterministicLocalProvider(
    {
      registerLanguageModelChatProvider: (vendor, provider) => {
        registeredVendor = vendor;
        registeredProvider = provider;
        return disposable;
      },
    },
    (value) => ({ value }) as vscode.LanguageModelTextPart,
  );

  assert.equal(result, disposable);
  assert.equal(registeredVendor, SPIKE_PROVIDER_VENDOR);
  assert.ok(registeredProvider instanceof DeterministicLocalChatProvider);
});

test("publishes an unmistakable no-account, no-tools, non-inference model", () => {
  const provider = new DeterministicLocalChatProvider(
    (value) => ({ value }) as vscode.LanguageModelTextPart,
  );
  const models = provider.provideLanguageModelChatInformation(
    { silent: true },
    cancellation,
  );

  assert.deepEqual(models, [SPIKE_MODEL_INFORMATION]);
  assert.equal(SPIKE_MODEL_INFORMATION.name, SPIKE_PROVIDER_NAME);
  assert.match(SPIKE_MODEL_INFORMATION.detail ?? "", /LOCAL.*DETERMINISTIC.*NON-INFERENCE.*NOT PRODUCTION/u);
  assert.equal(SPIKE_MODEL_INFORMATION.capabilities.toolCalling, false);
  assert.equal(SPIKE_MODEL_INFORMATION.capabilities.imageInput, false);
});

test("ignores opaque messages and returns one bounded deterministic text part", async () => {
  const parts: vscode.LanguageModelResponsePart[] = [];
  const provider = new DeterministicLocalChatProvider(
    (value) => ({ value }) as vscode.LanguageModelTextPart,
  );
  const messages = new Proxy([] as vscode.LanguageModelChatRequestMessage[], {
    get: () => {
      throw new Error("provider inspected message content");
    },
  });

  await provider.provideLanguageModelChatResponse(
    SPIKE_MODEL_INFORMATION,
    messages,
    options,
    { report: (part) => parts.push(part) },
    cancellation,
  );

  assert.equal(parts.length, 1);
  assert.equal((parts[0] as vscode.LanguageModelTextPart).value, SPIKE_PROVIDER_RESPONSE);
  assert.ok(Buffer.byteLength(SPIKE_PROVIDER_RESPONSE, "utf8") <= 128);
});

test("token counting is fixed and does not inspect request content", async () => {
  const provider = new DeterministicLocalChatProvider(
    (value) => ({ value }) as vscode.LanguageModelTextPart,
  );
  const message = new Proxy({} as vscode.LanguageModelChatRequestMessage, {
    get: () => {
      throw new Error("provider inspected token-count content");
    },
  });
  assert.equal(await provider.provideTokenCount(SPIKE_MODEL_INFORMATION, message, cancellation), 1);
});

test("provider source has no network, filesystem, process, credential, persistence, telemetry, or logging path", async () => {
  const source = await readFile(resolve(process.cwd(), "src/provider.ts"), "utf8");
  const forbidden = [
    /from\s+["']node:(?:http|https|net|tls|fs|fs\/promises|child_process)["']/u,
    /\b(?:fetch|axios|WebSocket|EventSource|XMLHttpRequest|exec|spawn)\s*\(/u,
    /process\.env/u,
    /\b(?:authentication|getSession|secrets|globalState|workspaceState|telemetry|console\.log)\b/u,
    /\b(?:selectChatModels|sendRequest|AgentCore|MachineIpcServer)\b/u,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `forbidden provider source pattern: ${pattern.source}`);
  }
});

test("manifest contribution matches registration and has no management or account configuration", async () => {
  const manifestText = await readFile(resolve(process.cwd(), "package.json"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    activationEvents?: string[];
    contributes?: {
      languageModelChatProviders?: Array<Record<string, unknown>>;
      configuration?: unknown;
    };
  };
  assert.deepEqual(manifest.contributes?.languageModelChatProviders, [{
    vendor: SPIKE_PROVIDER_VENDOR,
    displayName: "QuaranGate Spike Local Provider (Non-Inference)",
  }]);
  assert.equal(manifest.contributes?.configuration, undefined);
  assert.equal("managementCommand" in (manifest.contributes?.languageModelChatProviders?.[0] ?? {}), false);
  assert.equal(
    manifest.activationEvents?.includes(`onLanguageModelChat:${SPIKE_PROVIDER_VENDOR}`),
    true,
  );
});
