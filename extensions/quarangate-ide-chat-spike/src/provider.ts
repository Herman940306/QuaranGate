import type * as vscode from "vscode";

export const SPIKE_PROVIDER_VENDOR = "quarangate-spike-local-deterministic";
export const SPIKE_PROVIDER_NAME = "QuaranGate Spike Transport Model";
export const SPIKE_PROVIDER_RESPONSE =
  "QuaranGate deterministic local non-inference transport shim.";

export const SPIKE_MODEL_INFORMATION: vscode.LanguageModelChatInformation = Object.freeze({
  id: "deterministic-transport-non-inference",
  name: SPIKE_PROVIDER_NAME,
  family: "quarangate-spike-deterministic-local-non-inference",
  version: "s1-r2",
  maxInputTokens: 4_096,
  maxOutputTokens: 16,
  tooltip: "SPIKE ONLY: deterministic local non-inference transport; not production.",
  detail: "LOCAL / DETERMINISTIC / NON-INFERENCE / NOT PRODUCTION",
  capabilities: Object.freeze({
    imageInput: false,
    toolCalling: false,
  }),
});

type TextPartFactory = (value: string) => vscode.LanguageModelTextPart;

export interface LanguageModelProviderRegistrationApi {
  registerLanguageModelChatProvider(
    vendor: string,
    provider: vscode.LanguageModelChatProvider,
  ): vscode.Disposable;
}

export class DeterministicLocalChatProvider implements vscode.LanguageModelChatProvider {
  public constructor(private readonly createTextPart: TextPartFactory) {}

  public provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.LanguageModelChatInformation[] {
    return [SPIKE_MODEL_INFORMATION];
  }

  public provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Thenable<void> {
    progress.report(this.createTextPart(SPIKE_PROVIDER_RESPONSE));
    return Promise.resolve();
  }

  public provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(1);
  }
}

export function registerDeterministicLocalProvider(
  api: LanguageModelProviderRegistrationApi,
  createTextPart: TextPartFactory,
): vscode.Disposable {
  return api.registerLanguageModelChatProvider(
    SPIKE_PROVIDER_VENDOR,
    new DeterministicLocalChatProvider(createTextPart),
  );
}
