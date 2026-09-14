# P7 I2 — VS Code user-facing Chat Participant / setup composition

Date: 2026-09-14

Status: **SOURCE CANDIDATE / NOT YET ACCEPTED**

Base source: `f1432e63a7ff2e315fbc0738a26c81b818bd4904` (`feat(ide): add vscode public-api model execution`)

Base control: `c9020ae5196094d3fc20fdb58125dede4108ad23` (`docs(control): accept vscode public-api review model`)

## Authorized scope

This slice adds a source-only user-facing VS Code Chat Participant/setup composition over the accepted public-model review foundation. It remains **review-only** and does not create a second QuaranGate operation authority.

Intended Agent-A-owned paths:

- `src/ide-adapters/vscode/vscodeChatParticipantSetup.ts`
- `src/ide-adapters/vscode/vscodePublicApiModelExecution.ts`
- `tests/unit/vscode-chat-participant-setup.test.ts`
- `tests/unit/vscode-public-api-model-execution.test.ts`
- `docs/audits/P7_I2_VSCODE_CHAT_PARTICIPANT_SETUP.md`

Agent C owns only its separate qualification-worktree paths and none are touched by this candidate:

- `scripts/vscode-remote-wsl-qualification.mjs`
- `scripts/vscode-qualification-evidence.mjs`
- `tests/integration/p7-i2-vscode-qualification.test.ts`
- `tests/fixtures/vscode-qualification/**`
- `docs/audits/P7_I2_VSCODE_LIVE_QUALIFICATION.md`

`SHARED_PATHS = NONE`.

## Mechanically confirmed VS Code public API contract

The repository's preserved VS Code spike declares `engines.vscode = ^1.109.0` and pins `@types/vscode = 1.109.0` exactly. Before implementation, the pinned package was installed from the existing lock contract and `node_modules/@types/vscode/index.d.ts` was inspected mechanically.

The exact public API evidence used by this slice is:

- `vscode.chat.createChatParticipant(id, handler)` creates a user-invoked participant;
- `ChatRequestHandler` is invoked with `ChatRequest`, `ChatContext`, `ChatResponseStream`, and `CancellationToken`;
- `ChatRequest.prompt` and `ChatRequest.command` are public request fields;
- `ChatResponseStream.markdown(...)` and `progress(...)` are public response methods;
- `LanguageModelChat.sendRequest(...)` explicitly documents that its first use may show consent UI and therefore **must only be called in response to a user action**;
- `ExtensionContext.languageModelAccessInformation.canSendRequest(model)` checks persisted access without triggering consent UI;
- `vscode.lm.selectChatModels(...)`, `LanguageModelChatMessage.User(...)`, and `CancellationTokenSource` remain the accepted public model-execution primitives.

A temporary compile-only compatibility probe against the exact pinned `@types/vscode 1.109.0` proved that the new Chat structural seam accepts the real `vscode.chat` namespace and real `ChatRequest`, `ChatResponseStream`, and `CancellationToken` types:

`VSCODE_1_109_CHAT_API_STRUCTURAL_COMPAT=PASS`.

The probe file was temporary and removed after compilation; it is not candidate source.

No private VS Code/Copilot API, undocumented command ID, UI automation API, generic `executeCommand`, terminal API, `workspace.fs`, language-model tool invocation, child process, browser/webview authority, or hidden provider fallback is used.

## Participant semantics

The source constant participant identity is:

`quarangate.ideChat`

Registration is source-composed through the documented `createChatParticipant` seam only. Registration fails closed without the minimum production placement prerequisites:

- IDE product exactly `vscode`;
- WSL remote host;
- workspace extension host;
- exactly one workspace folder.

The participant is **user-originated**. The handler exposes only bounded presentation/setup actions:

- `status` — displays bounded QuaranGate connection/workspace/transport/model/governed-review readiness metadata;
- `setup` — performs explicit user-driven exact-model preparation/consent;
- `review <prompt>` — validates a bounded review intent and delegates only if a separately supplied QuaranGate-governed review bridge exists and all readiness gates are READY.

Unknown participant input returns bounded help. It is not treated as a remote command surface.

The participant never consumes `ChatRequest.model`, tool references, workspace/editor buffers, or chat-history content as authority. It never fabricates a VS Code chat request for a QuaranGate-origin operation.

## Model setup and consent

The accepted `VsCodeModelAccessController` is extended with `authorizeFromUserGesture()` for the documented first-use-consent rule.

The flow is intentionally split:

1. exact configured selector resolves exactly one model;
2. current persisted access is checked;
3. when access is already allowed, no model request is made;
4. when persisted access is unknown, **only the explicit user `setup` action** may call `sendRequest` to allow VS Code to display its normal consent UI;
5. the consent request uses one fixed content-free setup prompt and fixed justification; no user prompt, workspace content, credentials, B4 material, auth MAC, or operation payload enters it;
6. once the request object is created, its cancellation source is cancelled immediately so setup does not intentionally spend output-generation tokens or surface provider output;
7. persisted access is rechecked before state becomes READY;
8. remote QuaranGate review continues to use `requireRemoteModel()` and cannot trigger consent UI.

User-visible model states remain distinct:

- `NOT_CONFIGURED`
- `SETUP_REQUIRED`
- `CONSENT_REQUIRED`
- `ACCESS_DENIED`
- `ACCESS_REVOKED`
- `READY`
- `MODEL_UNAVAILABLE`
- `MODEL_SELECTION_AMBIGUOUS`
- `MODEL_IDENTITY_MISMATCH`
- `CANCELLED`
- `ERROR`

A previously READY model that later returns persisted access `false` is surfaced as `ACCESS_REVOKED`. A previously READY model whose public access lookup becomes `undefined` is treated fail-closed as `MODEL_UNAVAILABLE`; it is not silently reused.

Malformed model-selection runtime values fail as preparation error rather than being treated as a successful empty selection.

## Authority boundaries

The immutable production authority sequence remains:

`B4 runtime identity -> B6 authenticated IDE channel -> B5 exact workspace/worktree identity -> B3 authenticated/replay-protected operation material -> B7 durable review lifecycle -> B8 shared writer arbitration -> B9 implementation lifecycle -> I2.2 QuaranGate-origin transport -> accepted public VS Code model execution -> user-facing participant/setup presentation`.

The participant/setup layer cannot supply or invent:

- operation ID;
- project;
- worktree;
- session;
- connection generation;
- controller lease;
- capability;
- writer lease;
- durable operation state.

`VsCodeGovernedReviewPort` is deliberately a narrow **future integration contract**, not a new authority plane. Its request contains only:

- bounded prompt;
- `AbortSignal`;
- bounded event sink.

It accepts no operation/project/worktree/session/controller/writer identifiers. The operation ID can only come back from the QuaranGate side and is rejected unless it matches the existing canonical `ideo_<32 hex>` format.

The current production tree does **not** provide a concrete implementation of this port. Therefore a participant `review` request currently fails closed as `NOT_WIRED`; it creates no operation and sends no model request. This is intentional rather than fabricating a client-origin operation path around accepted I2.2/B7.

## Review-only boundary

This batch adds no implementation/mutation handler and no mutation API.

Specifically absent:

- `WorkspaceEdit` mutation;
- create/write/delete/rename filesystem authority;
- terminal/task execution;
- arbitrary command execution;
- shell/process proxy;
- generic language-model tool surface;
- extension-owned IPC listener/server;
- public MCP writer;
- direct model execution from the participant review action.

A future user-review bridge must enter QuaranGate operation admission and B7 durable review before the accepted I2.2/public-model handler can run. If that bridge cannot be built through supported authority-preserving APIs, the user-review participant action must remain unsupported.

## Packaging / activation boundary

This candidate intentionally does **not** add a production VSIX/package manifest or activation root. The repository still contains the preserved S1 spike, but it remains feasibility-only and is not promoted or modified by this batch.

The source-level participant registration seam is mechanically compatible with the pinned VS Code Chat API and can be wired by a later production extension composition root. Claiming actual discoverability/activation without that package would be false, so this candidate does not do so.

A later source gate must provide the minimum production extension manifest/activation composition and the concrete QuaranGate-governed user-review intent bridge (or explicitly prove that supported APIs cannot provide it) before live VS Code/Remote-WSL qualification can close I2.

## Security and privacy

- Raw participant prompts are not persisted or logged by this source.
- Setup uses a fixed prompt and fixed justification only.
- User-visible errors are constant/bounded and do not include raw provider exception bodies.
- Model metadata is limited to validated public vendor/id/family/version fields.
- Review event display is bounded to the existing IDE event byte limit.
- No B4 secret, auth MAC, credential path, filesystem dump, editor-buffer content, or provider secret is placed into participant metadata.

## Deterministic focused tests

Current focused candidate tests cover:

- exact participant identity and public registration seam;
- registration refusal for wrong IDE, wrong remote host, wrong extension-host placement, and multi-workspace input;
- disposal on participant-ID mismatch;
- status/help cannot select a model or trigger first-use consent;
- setup is the explicit action that may trigger consent;
- not-configured / unavailable / denied / ready / revoked / disappeared model states;
- setup cancellation;
- malformed public model-selection result;
- fixed setup prompt + justification and no user-content consent probe;
- no model send before explicit preparation;
- review readiness gating;
- `NOT_WIRED` fail-close when the governed user-review bridge is absent;
- narrow delegated review input with no authority fields;
- canonical operation-ID validation on returned governed review result;
- cancellation propagation only as an AbortSignal;
- bounded review event/error output;
- static absence of private API, UI automation, generic command, terminal, workspace-fs, tool invocation, child-process, and implementation-handler authority.

## Validation

All validation below was run on the final candidate bytes before freeze.

- focused participant/setup + accepted public-model + I2.2: **63/63 PASS across 5 files**;
- B1-B9 + I2 regression: **312/312 PASS across 23 files**;
- shared writer / `agent_apply`: **246/246 PASS across 4 files**;
- canonical `npm test`: **2578/2578 PASS across 89/89 unit files**, exit `0`; no bounded fallback was required;
- catalog/schema/public surface: **41/41 PASS across 4 files**;
- typecheck: **PASS**;
- build: **PASS**;
- `git diff --check`: **PASS**;
- public MCP tool contract: exact **45 expected / 45 server / no missing / no extra**;
- startup/public source-graph scan: **PASS** — no new participant/setup reference in executor startup or gateway/public surface;
- private API / UI automation / generic proxy scan of the changed production files: **NONE**;
- Agent C owned-path status: **UNCHANGED / NONE TOUCHED**.

## Explicit non-claims

This source candidate does **not** claim:

- production extension manifest acceptance;
- extension activation/startup wiring;
- actual Chat Participant discoverability in a live VS Code window;
- a concrete user-origin governed-review admission bridge;
- implementation/mutation capability;
- real VSIX packaging/install acceptance;
- live Remote-WSL execution;
- live consent acceptance;
- live model/provider availability, entitlement, quota, or policy qualification;
- Cursor support;
- I2 completion;
- P7 final acceptance;
- deployment;
- branch convergence/canonical merge.

## Next gate

If this immutable source candidate independently passes review and control reconciliation, the next evidence-backed VS Code I2 source gate is:

`PRODUCTION EXTENSION MANIFEST/ACTIVATION COMPOSITION + QUARANGATE-GOVERNED USER-REVIEW INTENT BRIDGE`

That gate must wire this participant/setup foundation to the accepted I2.1/I2.2/public-model stack without creating client-owned operation authority. Only after all required VS Code source slices are accepted should Agent C's separate live Remote-WSL qualification evidence be integrated/adjudicated.

## Candidate component hashes before documentation freeze

The non-self-referential candidate component hashes immediately before final documentation freeze are:

- `9bb9fca469e42a5f9ac9566355fa844eea237a3a070c0096bb9aa8a29574c36e  src/ide-adapters/vscode/vscodeChatParticipantSetup.ts`
- `276b6e7d937ddae79d2848a8a339be109cf2678faa732c0908410d2b8342ce1c  src/ide-adapters/vscode/vscodePublicApiModelExecution.ts`
- `1bf7cb6df7907a732d35210756511a79fdbea2d07549e24d3a78da779c5589b3  tests/unit/vscode-chat-participant-setup.test.ts`
- `63304ed1dec360e3e70047c0f81d6c5f912ea47001071aa49ee4dcbc977a56d3  tests/unit/vscode-public-api-model-execution.test.ts`

The final freeze includes this audit document as the fifth intended path. `PATH_STATUS_SHA256` and the exact five-path `CONTENT_MANIFEST_SHA256` are computed mechanically only after these audit bytes are final, then the staged candidate must reproduce the same manifest exactly. Immutable commit identity/patch hash are recorded after commit rather than self-referenced inside the commit.
