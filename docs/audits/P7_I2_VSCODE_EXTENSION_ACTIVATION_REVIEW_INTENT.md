# P7 I2 — VS Code production extension activation + governed user-review intent bridge

Date: 2026-09-14

Accepted source base: `f0ec7d91055a10f87abb7322ba3fda7bfc76e6e5` (`feat(ide): add vscode chat participant setup`)

Accepted control base: `e31ff0b5765be5da4c0adc874119e818e48b66f2` (`docs(control): accept vscode participant setup foundation`)

## Scope

This source slice turns the accepted VS Code source foundations into a concrete production extension-side composition and adds the narrow QuaranGate-side bridge required for an explicit **user-originated review intent** to enter the already accepted governed review lifecycle.

It remains review-only source implementation. It does not perform live VS Code/Remote-WSL qualification, install a VSIX, deploy QuaranGate, request real provider consent, consume paid model quota, add implementation/mutation authority, close I2/P7, or authorize branch convergence.

The immutable authority chain remains:

`B4 runtime identity -> B6 authenticated IDE channel -> B5 workspace/worktree identity -> B3 authenticated operation material -> B7 durable review lifecycle -> B8 shared writer arbitration -> B9 implementation lifecycle -> I2.2 QuaranGate-origin command/event transport -> accepted public VS Code model execution -> user-facing participant/setup`.

The new user-review bridge is an intent path into that chain; it is not an authority source.

## Production paths in this candidate

Production extension package/composition:

- `extensions/quarangate-vscode/.gitignore`
- `extensions/quarangate-vscode/package.json`
- `extensions/quarangate-vscode/package-lock.json`
- `extensions/quarangate-vscode/tsconfig.json`
- `extensions/quarangate-vscode/src/extension.ts`
- `src/ide-adapters/vscode/vscodeExtensionActivation.ts`
- `src/ide-adapters/vscode/vscodeChatParticipantSetup.ts`
- `src/ide-adapters/vscode/vscodeCommandChannel.ts`

QuaranGate governed transport/admission composition:

- `src/shared/ideCompanionRemoteTransport.ts`
- `src/executor/ide/ideCompanionRemoteChannel.ts`
- `src/executor/ide/ideCompanionUserReviewIntent.ts`
- `src/executor/ide/ideCompanionListener.ts`
- `src/executor/ide/ideOperationCoordinator.ts`

Focused tests:

- `tests/unit/vscode-extension-activation.test.ts`
- `tests/unit/vscode-chat-participant-setup.test.ts`
- `tests/unit/vscode-command-channel.test.ts`
- `tests/unit/ide-companion-remote-channel.test.ts`
- `tests/unit/ide-companion-remote-transport.test.ts`

This audit is `docs/audits/P7_I2_VSCODE_EXTENSION_ACTIVATION_REVIEW_INTENT.md`.

The ChatGPT qualification-lane paths were not created, modified, renamed, deleted, staged or copied into this batch.

## Extension manifest and activation composition

`extensions/quarangate-vscode/package.json` is a source-only production extension manifest using the repository-pinned public VS Code API baseline `^1.109.0` / `@types/vscode 1.109.0`.

It declares:

- workspace extension-host placement via `extensionKind: ["workspace"]`;
- the accepted user-facing participant ID `quarangate.ideChat`;
- `onStartupFinished` and `onChatParticipant:quarangate.ideChat` activation events;
- machine-scoped configuration for the owner-provisioned runtime credential path and exact review-model selector fields;
- no commands contribution;
- no language-model tool contribution;
- no language-model provider contribution;
- no terminal/filesystem/shell capability declaration.

No marketplace publisher identity is invented by this source slice. Publication/signing/VSIX distribution are not claimed.

The production entrypoint uses documented public VS Code surfaces only: `chat.createChatParticipant`, `lm.selectChatModels`, `LanguageModelChatMessage.User`, `CancellationTokenSource`, `ExtensionContext.languageModelAccessInformation.canSendRequest`, workspace-folder/environment metadata, configuration reads and extension lifecycle/disposal.

Activation does **not** call model selection, model `sendRequest`, participant review, B7 operation creation, writer acquisition or mutation. Unsupported registration placement is rejected before any credential read or QuaranGate socket connection. When configured, activation only composes the existing B5 collector, B4 credential reader, B6 authenticated connection, I2.2 command channel, accepted review-model handler and participant surface.

## User review intent protocol

The I2.2 transport now has a direction-separated, bounded user-intent sub-protocol on the already authenticated B6/I2.2 socket:

Client to QuaranGate:

- `review_intent`: exact authenticated `sessionId`, current `connectionGeneration`, connection-local `intentSequence`, bounded review prompt;
- `review_intent_cancel`: exact session/generation + the local intent sequence.

QuaranGate to client:

- `review_intent_event`: exact intent sequence plus a validated durable B7 `IdeOperationEvent`;
- `review_intent_rejected`: exact intent sequence plus one bounded rejection classification.

The intent frame has no `projectId`, `worktreeId`, `operationId`, controller lease, writer lease, capability-selection field, host path or durable-state field. The local `intentSequence` is correlation only and is sequence-checked per authenticated connection. It is never used as operation authority.

## Governed admission and operation-ID origin

`IdeCompanionUserReviewIntentCoordinator` is the trusted QuaranGate-side bridge. For one authenticated review intent it:

1. validates the exact B6 session/generation binding;
2. acquires the controller through the existing durable session store using that already authenticated session;
3. creates the authoritative `ideo_...` operation identity on the QuaranGate side, never from participant input;
4. asks the existing I2.2 remote channel for `request_review` authorization;
5. causes the extension to re-read B4 credential material and collect fresh B5 workspace evidence, then return exact B3-authenticated material;
6. submits that authenticated material to the existing B7 `IdeOperationCoordinator.startReview()`;
7. only after B7 durable admission/start does the existing I2.2 review adapter send `execute_operation` to the accepted VS Code public-model handler;
8. mirrors only the resulting durable B7 event stream back to the participant correlation;
9. releases the exact controller after terminal settlement.

Project/worktree identity is therefore re-derived from trusted enrollment/B5 state. The participant cannot choose it. The participant also cannot create a controller, operation ID, capability, writer lease or durable operation row.

The focused end-to-end regression deliberately blocks fresh B5 collection after the user intent has reached QuaranGate and proves that at that point the authoritative operation row does not yet exist and the model send count is still zero. Releasing the fresh B5 check allows B3 authorization and B7 durable start; only then does model execution occur.

## Failure and reconnect behavior

Fail-closed cases are mechanically covered:

- no trusted review-intent bridge -> `BRIDGE_UNAVAILABLE`, no operation;
- already-pending local user intent -> local rejection before a second authority path can exist;
- existing controller conflict -> admission rejection, no operation/model send;
- fresh B5 workspace drift -> B7 admission rejection, no model send;
- stale/closed authenticated channel -> local failure before admission, no model send;
- replayed/skipped intent sequence -> remote channel closes fail-safe;
- transport disconnect -> pending participant intent rejects; existing B6/B7 exact session-generation disconnect reconciliation remains authoritative.

No participant-specific reconnect authority or cached controller/operation authority is introduced.

## Cancellation

Pre-admission cancellation carries only `intentSequence`. It marks the local intent cancelled; if a pending B3/B5 authorization finishes, QuaranGate discards that unused authorization, releases the controller and creates no durable B7 operation.

After B7 admission, the coordinator already holds the server-generated operation ID and controller lease. `cancelTrusted()` re-derives enrollment/session/generation fields from the durable operation row, requests exact B7 cancellation, and aborts only that active review adapter. Existing I2.2 cancellation then targets the same operation, which cancels the exact VS Code model token. B7 owns terminal `CANCELLED` settlement and the participant sees only that durable terminal result. The participant never supplies the authoritative operation ID for cancellation.

Focused regression proves cancellation during model streaming affects one operation and suppresses late model output/completion.

## Consent and model execution

The accepted consent boundary is preserved:

- explicit user `setup` remains the only path that may run first-use model authorization;
- activation performs zero model selections/sends;
- status/help perform zero model selections/sends;
- `review_intent` and B7 admission do not trigger first-use consent;
- the remote review handler uses only already-prepared model access and rechecks persisted access;
- a revoked/unprepared model fails before model send rather than presenting surprise consent UI.

The participant itself never performs governed-review `model.sendRequest()`. Its review request calls only the narrow governed-review port. The only production `sendRequest` wrapper remains the accepted public-model execution seam; it is reached for governed reviews only downstream of B7/I2.2 execution. The separate fixed setup probe remains user-gesture-only.

## Streaming and durable truth

The participant does not own operation lifecycle truth. It accepts only contiguous durable B7 events for the exact server-origin operation ID learned from the first `operation_started` event. A later event cannot change that identity. Bounded assistant/status text is rendered, while terminal truth comes from the durable B7 terminal event.

Disconnect/error cannot be promoted to completion. `disconnected` or `indeterminate` durable terminals map to participant `INDETERMINATE`; a channel close rejects a still-pending local request.

## Review-only enforcement

This source slice adds no implementation handler, `WorkspaceEdit`, file create/delete/rename, terminal, task execution, arbitrary `executeCommand`, shell, generic `workspace.fs`, model tool invocation, Docker authority, second local listener/server, public MCP tool, or model-controlled generic VS Code API object.

The existing B8/B9 implementation path is unchanged and remains separately governed. The user-intent bridge hardcodes its governed server-side operation capability to `request_review` after receiving an authority-free intent.

## Security/privacy

The bridge does not add prompt/model-response persistence. B7 continues to persist operation provenance and hashes/bounds rather than complete prompt/response bodies. The new extension source does not log B4 secret material, MACs, provider secrets, arbitrary editor buffers or workspace dumps.

Static candidate scans found no private Copilot API, undocumented Chat command ID, UI automation, terminal API, generic `workspace.fs`, generic `executeCommand`, tool invocation, child process, Docker authority or new listener/server in the extension/bridge additions. The public extension entrypoint necessarily wraps `LanguageModelChat.sendRequest`; manual adjudication confirms that wrapper is the already accepted model-execution seam and is not called directly by participant review logic.

## Validation

Validation on the candidate source before freeze:

- focused activation/bridge + participant/model/I2.2/B7/listener matrix: **114/114 PASS across 8 files**;
- complete P7 B1-B9 + I2 regression matrix: **325/325 PASS across 24 files**;
- shared writer / `agent_apply`: **246/246 PASS across 4 files**;
- canonical `npm test`: **2591/2591 PASS across 90/90 unit files**, exit `0`;
- catalog/public subset: **26/26 PASS across 4 files** and exact public MCP catalog remains **45**;
- root typecheck: **PASS**;
- production extension offline dependency install/audit: **PASS / 0 vulnerabilities**;
- production extension typecheck: **PASS**;
- production extension build: **PASS**;
- root build: **PASS**;
- `git diff --check`: **PASS**;
- ChatGPT qualification-path collision: **NONE**.

The final authoritative validation recheck reproduced the focused, P7, shared-writer, catalog/public, typecheck/build and canonical unit results above on the completed implementation bytes. The audit-only documentation freeze that follows does not alter executable source.

## Explicit non-claims

This source candidate does **not** claim:

- live VS Code or Remote-WSL execution;
- VSIX installation, signing, publication or marketplace identity;
- live model discovery, consent, entitlement, quota or provider compatibility;
- deployment;
- executor-wide production startup/provisioning of the IDE listener/runtime;
- implementation/mutation capability;
- Cursor support;
- I2 completion;
- I6 completion;
- P7 final acceptance;
- branch convergence/canonical merge.

The repository source graph still contains no executor-root startup composition for `IdeCompanionListener`/B4 runtime provisioning. This slice deliberately does not invent that wider lifecycle while implementing the authorized extension-side activation and concrete governed user-review bridge. That absence must be resolved or explicitly proven to be supplied by an already accepted owner-host/install composition before live production acceptance.

## Next evidence-backed gate

After immutable source review and control reconciliation, the next required source/operational decision should be derived from the remaining startup/provisioning gap above:

`QUARANGATE IDE COMPANION RUNTIME/ENROLLMENT + LISTENER STARTUP COMPOSITION` if no already accepted production composition supplies it; otherwise proceed to the separately owned live VS Code/Remote-WSL qualification gate.

No live qualification is authorized by this audit itself.
