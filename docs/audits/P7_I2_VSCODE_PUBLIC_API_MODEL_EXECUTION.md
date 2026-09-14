# P7 I2 — VS Code supported public-API model execution foundation

Date: 2026-09-14

Status: **SOURCE CANDIDATE / NOT YET ACCEPTED**

Base source: `fe3d585eebf0116bb5140300f5d6f22a8f6e715d` (`fix(ide): harden remote channel fail-close`)

Base control: `ea7464a75c0d852d98c43433ec9dd3ba46340e88` (`docs(control): reconcile P7 I2.2 to R1`)

## Exact scope

This batch adds the first source-only VS Code public Language Model API execution foundation over accepted I2.2. The implementation is deliberately **review-only** and exposes no implementation/mutation handler. It does not startup-wire an extension, package a VSIX, register a Chat Participant, deploy anything, or perform live VS Code/Remote-WSL/model qualification.

Intended source paths for this batch:

- `docs/audits/P7_I2_VSCODE_PUBLIC_API_MODEL_EXECUTION.md`
- `src/ide-adapters/vscode/vscodePublicApiModelExecution.ts`
- `tests/unit/vscode-command-channel.test.ts`
- `tests/unit/vscode-public-api-model-execution.test.ts`

Agent ownership for this batch:

- `AGENT_A_OWNED_PATHS`: the four paths above.
- `AGENT_C_ALLOWED_PATHS`: separate-worktree qualification/evidence-only work; no production path in this candidate is delegated.
- `SHARED_PATHS`: `NONE`.

## API/version qualification

Repository evidence was checked before implementation:

- `extensions/quarangate-ide-chat-spike/package.json` declares `engines.vscode = ^1.109.0`.
- its lockfile pins `@types/vscode = 1.109.0` exactly.
- the current isolated `projects-work` target has no `code` executable, so a current live IDE binary/version cannot be mechanically claimed from this target. Live runtime compatibility remains a later Remote-WSL qualification gate.
- existing repository research (`docs/ide/IDE_CHAT_AGENT_I1R2.md`) records the supported public primitives and the limitation that an external QuaranGate process cannot fabricate a standard VS Code Chat Participant request through a documented public API.

The production core therefore uses `createVsCodePublicLanguageModelApi(...)`, a narrow structural binding to only the documented public API contract required by this source slice. The real `vscode` module and `ExtensionContext.languageModelAccessInformation` remain outside the review handler:

- `vscode.lm.selectChatModels(selector)` — **user-action preparation only**;
- `ExtensionContext.languageModelAccessInformation.canSendRequest(model)` — persisted access check without consent UI;
- `vscode.LanguageModelChatMessage.User(prompt)` — represented by the composition seam;
- `LanguageModelChat.countTokens(...)`;
- `LanguageModelChat.sendRequest(...)`;
- `LanguageModelChatResponse.text`;
- `vscode.CancellationTokenSource`.

No private Copilot API, private provider endpoint, undocumented command ID, arbitrary `executeCommand`, UI automation, terminal API, generic filesystem API, or language-model tool registry is used.

## Authority ordering

The new adapter does not originate operations. The accepted authority chain remains:

`B4 runtime identity -> B6 authenticated IDE connection -> B5 exact physical workspace -> B3 authenticated/replay-protected operation material -> B7 review lifecycle -> B8 writer arbitration -> B9 implementation lifecycle -> I2.2 QuaranGate-origin command/event transport -> VS Code public API execution`.

For this source slice, only the B7/I2.2 **review** path receives the new handler. The handler accepts only the existing `VsCodeRemoteOperationInput` supplied by `VsCodeCommandChannel` after I2.2 authorization, execution-time B4/B5 re-attestation, and QuaranGate durable admission. It has no operation/controller/writer/session/project/worktree creation surface.

The public-API foundation returns no implementation handler. Therefore this batch adds no path around B8/B9 and no model-controlled VS Code mutation object.

## Chat Participant boundary

No Chat Participant is registered or machine-invoked in this batch. This is intentional.

The machine path remains the accepted authenticated I2.2 command/event transport. The new source does not expose a participant-request constructor, arbitrary command bridge, fake user turn, UI automation, or standard Chat-history injection path. A future user-facing participant may share bounded internal model logic, but it must not become QuaranGate's machine authority path.

## Consent and model access

Model selection is separated from remote execution in code:

- `VsCodeModelAccessController.prepareFromUserGesture()` is the only method that can call `selectChatModels`.
- the remote review handler receives `VsCodeRemoteModelAccess`, a narrower object exposing only `requireRemoteModel()`; it cannot select/discover a model or initiate consent.
- remote execution before any explicit user preparation fails closed with `VSCODE_MODEL_PREPARATION_REQUIRED` and performs zero model selection/request calls.
- exact `vendor/id/family/version` selector fields are supplied by configuration, not hard-coded in the adapter.
- no preparation yet -> `MODEL_PREPARATION_REQUIRED`.
- zero matches / public `NotFound` -> `MODEL_UNAVAILABLE`.
- public `NoPermissions` during explicit user preparation -> `MODEL_CONSENT_REQUIRED`.
- unknown preparation failure -> `MODEL_PREPARATION_FAILED` rather than falsely classifying it as provider absence.
- multiple matches -> `MODEL_SELECTION_AMBIGUOUS`.
- identity mismatch -> `MODEL_IDENTITY_MISMATCH`.
- persisted access unknown -> `MODEL_CONSENT_REQUIRED`.
- persisted access false -> `MODEL_ACCESS_DENIED`.
- access is rechecked for each remote turn; a prepared permission is not assumed indefinitely.

Actual user-facing command/participant registration that invokes the preparation method is intentionally not startup-wired here. That composition must remain a user-originated action in the later extension/package slice.

## Review capability separation

The review handler receives only:

- exact admitted `operationId` (preserved by the enclosing I2.2 channel);
- prompt;
- exact-operation abort signal;
- bounded I2.2 event emitter;
- narrow remote model-access interface;
- minimal public LM message/cancellation construction seam.

It receives no `vscode` namespace, workspace object, terminal, filesystem, `WorkspaceEdit`, command registry, language-model tools, process execution, or mutation API. No editor/workspace context is added in this batch.

## Model execution semantics

Before provider execution the adapter:

1. rechecks prompt bytes against the existing I2.2 operation limit;
2. fails if already cancelled;
3. requires a previously user-prepared exact model with currently allowed persisted access;
4. creates one operation-local cancellation source;
5. calls the selected model tokenizer and rejects a token count outside `maxInputTokens`;
6. constructs one user message through the public API composition seam;
7. calls the selected model's public `sendRequest`;
8. consumes only the public text stream.

No model name/vendor/family/version is embedded as a product constant.

## Streaming and bounds

- I2.2 remains responsible for session/generation/operation binding and ordered event sequencing.
- only `assistant_chunk` text is emitted by this handler.
- one event is at most existing `MAX_IDE_EVENT_MESSAGE_BYTES` (8 KiB UTF-8), splitting provider fragments on Unicode scalar boundaries when necessary.
- total useful model output is capped at 64 KiB.
- output beyond the total bound cancels the provider token and fails the operation; it is never silently truncated into success.
- empty or structurally invalid response streams fail.
- raw provider error messages/causes are not forwarded or persisted by this adapter; known public error codes are mapped to bounded QuaranGate error classes.

## Cancellation

The exact I2.2 operation abort signal owns one VS Code cancellation token source. Abort cancels that token source. The handler checks cancellation before request, during streamed output, and before successful return; late output is not emitted after cancellation.

Stopping model generation does **not** imply implementation rollback or safe mutation because this source slice has no implementation handler at all.

## Deterministic tests

Focused public-API/I2.2 matrix:

- **43/43 PASS across 4 files**:
  - I2.2 transport/channel/VS Code command-channel tests including the new end-to-end review-handler integration (`30/30`);
  - new public-API model execution tests (`13/13`).

New deterministic tests prove:

- remote execution cannot select a model or trigger consent discovery before explicit user preparation;
- unavailable / preparation-required / consent-required / denied / allowed access states remain distinct;
- public selection failures (`NoPermissions`, `NotFound`, unknown failure) are classified without conflation;
- ambiguous selection and exact identity drift fail closed;
- text streaming stays bounded and operation identity is not rewritten;
- oversized provider fragments are split into protocol-safe UTF-8 events;
- cancellation maps to the operation-local model token and emits no late output;
- provider raw error body is not surfaced;
- total output overflow fails/cancels instead of truncating to success;
- `countTokens`/`maxInputTokens` prevent oversized input from reaching `sendRequest`;
- persisted access is rechecked for every remote turn;
- the foundation exposes review only and no implementation/origin/command/workspace/terminal surface;
- the documented VS Code public lm/message/cancellation/access objects are bound through the narrow public composition seam.

`tests/unit/vscode-command-channel.test.ts` additionally proves the intended composition path: exact I2.2 authorization alone performs zero model sends; only after the existing B7 coordinator durably admits/starts the review does the public-API handler send the request and stream the bounded result back through the existing operation events.

Lower-layer operation/session/generation/B7/B8/B9 no-bypass guarantees are not artificially duplicated; the complete P7 regression below reruns those accepted contracts with this new handler source present.

## Regression/qualification evidence

All commands below were run on the candidate bytes before freeze.

- Complete B1-B9 + I2.1 + I2.2 + current public-API slice matrix: **292/292 PASS across 22 files**.
- Shared writer / `agent_apply`: **246/246 PASS across 4 files**.
- Canonical `npm test`: **2558/2558 PASS across 88/88 unit files**, exit `0`; no bounded fallback was needed.
- Catalog/schema/public-surface matrix: **41/41 PASS across 4 files**.
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**.
- `git diff --check`: **PASS**.
- public MCP catalog contract remains exact **45 expected / 45 server / no missing / no extra**.

## Startup/public authority and forbidden-surface scan

A source-graph scan for `vscodePublicApiModelExecution`, `VsCodePublicApiReviewHandler`, and `createVsCodePublicApiExecutionFoundation` finds them only inside the new adapter source itself. No reference exists in `src/executor/index.ts` or `src/gateway`.

The new production source contains no direct `vscode` import and no runtime import of filesystem, network, HTTP, terminal, process, or child-process modules. The public VS Code namespace will be supplied by a later extension composition root through the narrow interface; this keeps this source slice type/runtime isolated and prevents accidental ambient API authority.

A forbidden-surface scan of the production file found no `executeCommand`, command registry, terminal API, `workspace.fs`, private language-model provider registration, `lm.tools`/`invokeTool`, private workbench Chat command, child process, filesystem, network, keyboard/mouse automation, or private Copilot usage.

## Explicit non-claims

This batch does **not** claim:

- Chat Participant registration or acceptance;
- VSIX/package acceptance;
- extension activation/startup wiring;
- live VS Code or Remote-WSL qualification;
- live model availability, account entitlement, first-use consent, quota, or provider-policy qualification;
- implementation/mutation capability;
- editor/workspace context access;
- Cursor acceptance;
- I2 completion;
- P7 final acceptance;
- deployment;
- branch convergence/canonical merge.

## Next gate

If this immutable source candidate independently passes Agent B review, reconcile project control to the accepted source. The subsequent I2 work must be derived from the accepted control/North-Star state. At minimum, the still-unaccepted user-facing Chat Participant/setup composition and live VS Code/Remote-WSL qualification remain separate from this source-only review execution foundation; no later gate is promoted merely by this audit.

## Candidate component hashes before documentation freeze

The non-self-referential candidate component hashes immediately before final documentation freeze are:

- `9d7df6e339b5f868593ff297665af1a9009bd0cc6f5b9d7b38c79dc72289b809  src/ide-adapters/vscode/vscodePublicApiModelExecution.ts`
- `823a953419493d987410b869dc654c4f5ca68f333335cbe98e4061232d988c86  tests/unit/vscode-command-channel.test.ts`
- `28dd23d71104cdd0b1f995ed5057ddbdf4a48815eae97895cea5d70b4043b06e  tests/unit/vscode-public-api-model-execution.test.ts`

The final freeze includes this audit document as the fourth intended path. `PATH_STATUS_SHA256` and the exact four-path `CONTENT_MANIFEST_SHA256` are computed mechanically only after these audit bytes are final, then the staged candidate must reproduce the same manifest exactly. Immutable commit identity/patch hash are recorded after commit rather than self-referenced inside the commit.
