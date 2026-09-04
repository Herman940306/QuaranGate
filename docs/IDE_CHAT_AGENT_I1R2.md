# QuaranGate First-Class IDE Chat Agent Surface — I1R2 Qualification

**Status:** research/design only; no runtime implementation, installation, upgrade, staging, commit, or push

**Research date:** 2026-09-04

**Scope:** Lane B only; first-class IDE chat/agent surface qualification for Kiro, VS Code, and Cursor

**Repository baseline:** `1977290c07a140aad111a6cbc9bbc970f5bfec6f`

## 1. Evidence and status vocabulary

Every material capability claim in this document has one of these evidence tags:

- **[OFFICIAL_DOCUMENTED]** — stated by current official vendor documentation or a public API reference.
- **[LOCAL_CONFIRMED]** — observed in this checkout or the installed local product without a provider turn.
- **[INFERRED]** — a conclusion drawn from documented or local facts, not a vendor guarantee.
- **[PROPOSED]** — future QuaranGate architecture or qualification behavior; not implemented.
- **[UNKNOWN]** — official evidence is insufficient and a live, owner-approved qualification is required.

Capability tables additionally use the requested surface classifications:

- `SUPPORTED_PUBLIC_API`
- `DOCUMENTED_BUT_NOT_PROGRAMMATIC`
- `LOCAL_PUBLIC_SURFACE_CONFIRMED`
- `NOT_FOUND`
- `PRIVATE_UNSUPPORTED`

Architecture tables use `SUPPORTED_NOW`, `REQUIRES_CURRENT_KIRO`, `REQUIRES_SPIKE`, `BLOCKED`, or
`FUTURE`. `NOT_FOUND` means no supported contract was found in the official sources reviewed; it is
not a claim that a private implementation detail cannot exist. Private details are deliberately not
an integration surface.

## 2. Clarified owner objective and preserved I2 result

**[LOCAL_CONFIRMED]** The owner requires two independently governed agent surfaces to operate against
the same logical project in parallel. They may use different vendors, processes, conversations, and
sessions. Examples include a Kiro IDE chat agent plus Copilot or Codex CLI, and a VS Code IDE chat
agent plus Kiro CLI or another governed CLI worker.

**[LOCAL_CONFIRMED]** Same-session Kiro IDE plus Kiro CLI attachment is not required and is not a
blocker. This qualification does not reopen that question.

**[LOCAL_CONFIRMED]** The accepted I2 conclusion is preserved: VS Code as the human editor plus a
distinct Kiro CLI/ACP worker is already compatible with QuaranGate's implemented Agent Control Plane.
That composition uses the existing sandbox/evidence/diff/apply path and needs no VS Code-specific
runtime adapter merely because VS Code is the editor.

**[LOCAL_CONFIRMED]** Repository authority requires logical project identifiers, sandbox-first agent
execution, independently captured evidence, explicit guarded apply, independent Agent Dispatch and
IDE Session grants, and this broader concurrency invariant:

```text
many readers
many isolated workers
one controlled live writer per project/worktree
```

**[PROPOSED]** I1R2 adds a different optional worker type: an extension-owned IDE agent surface that
QuaranGate can address directly. It does not replace the already-compatible editor plus external CLI
composition and does not require control of a vendor's private built-in chat.

## 3. Source basis

### Kiro official sources

- [Kiro downloads](https://kiro.dev/downloads/)
- [Kiro IDE changelog 1.0.288](https://kiro.dev/changelog/ide/1-0-288/)
- [Kiro IDE changelog 1.0.395](https://kiro.dev/changelog/ide/1-0-395/)
- [Kiro IDE changelog 1.0.437](https://kiro.dev/changelog/ide/1-0-437/)
- [Kiro Agent Focus Mode](https://kiro.dev/docs/ide/experimental/focus-mode/)
- [Kiro IDE chat](https://kiro.dev/docs/ide/chat/)
- [Kiro migration and extension compatibility](https://kiro.dev/docs/upgrade-guides/migrating-from-vscode/)
- [Kiro CLI ACP](https://kiro.dev/docs/cli/acp/)
- [Kiro privacy and extension security](https://kiro.dev/docs/privacy-and-security/)

### VS Code and Node.js official sources

- [VS Code Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat)
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [VS Code Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code Commands API](https://code.visualstudio.com/api/extension-guides/command)
- [VS Code command-line interface](https://code.visualstudio.com/docs/configure/command-line)
- [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [VS Code remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [Node.js IPC support](https://nodejs.org/api/net.html#ipc-support)

### Cursor official source

- [Cursor extensions](https://cursor.com/help/customization/extensions)

### Local repository sources

- `README.md`
- `MCP_IDE_BRIDGE_MASTER_PRD.md`
- `docs/AGENT_CONTROL_PLANE.md`
- `docs/IDE_SESSION_CONTROL.md`
- `docs/IDE_SESSION_KIRO_I1.md`
- `docs/IDE_SESSION_VSCODE_I2.md`

No private extension internals, webview inspection, undocumented socket discovery, session database,
process injection, UI automation, keyboard injection, upgrade, extension installation, provider call,
or live chat action was used.

## 4. Kiro local/current version gap

| Item | Finding | Evidence |
|---|---|---|
| `LOCAL_VERSION` | Kiro IDE/WSL server `1.0.212`, commit `8848ae36c236474760fa07ffaa4358ee3889253a` | **[LOCAL_CONFIRMED]** installed `product.json`; matches the owner-provided observation |
| `CURRENT_DOCUMENTED_VERSION` | Kiro IDE `1.0.437`, released 2026-09-01 | **[OFFICIAL_DOCUMENTED]** current downloads and changelog |
| version gap | local `1.0.212` predates the relevant current capabilities below | **[INFERRED]** numeric/release ordering |
| upgrade performed | no | **[LOCAL_CONFIRMED]** this gate is read-only |

### Capability differences relevant to I1

| Minimum documented release | Relevant change | Qualification effect | Evidence |
|---|---|---|---|
| `1.0.288` | Agent Focus session pinning, **Open with Kiro CLI**, in-app updates, and move to Code OSS `1.109.5` | Confirms supported sequential IDE→CLI handoff and a newer Code OSS base; does not expose the live built-in IDE chat to external control | **[OFFICIAL_DOCUMENTED]** |
| `1.0.293+` | current Kiro material identifies cloud-session access from Agent Focus Mode | Relevant to Kiro-owned cross-surface cloud sessions, not a public API for a local built-in IDE chat | **[OFFICIAL_DOCUMENTED]** |
| `1.0.395` | third-party extensions can work alongside Kiro | Establishes current generic extension compatibility only | **[OFFICIAL_DOCUMENTED]** |
| `1.0.437` | current release; cloud configuration and synced Powers refinements | Establishes the current version, but adds no documented IDE-chat control API | **[OFFICIAL_DOCUMENTED]** for release; **[UNKNOWN]** for any unadvertised API |

**[UNKNOWN]** Local `1.0.212` predates the explicit `1.0.395` third-party compatibility statement and
cannot qualify the current companion-extension design. A Kiro live spike therefore requires an
owner-approved upgrade to an exact supported build, preferably the current stable build at spike
time, followed by version/hash recording. Required return: `OWNER_UPGRADE_DECISION_REQUIRED`. No
upgrade is authorized by this document.

## 5. Vendor-native versus QuaranGate-provided IDE agent

### A. Vendor-native IDE chat agent

**[OFFICIAL_DOCUMENTED]** Kiro supplies its own interactive IDE chat, agents, model picker, modes,
session history, execution history, cancellation UI, parallel Agent Focus sessions, and sequential
IDE→CLI handoff.

**[UNKNOWN]** Those user-facing features do not establish a supported machine-facing API through
which another extension or process can identify the live built-in session, prompt it, stream its
events, cancel it, or prove completion. No such public contract was found in the reviewed official
Kiro surfaces.

### B. QuaranGate-provided IDE chat agent

**[PROPOSED]** A QuaranGate companion extension registers and owns its own chat participant where the
IDE supports the public Chat Participant API. The extension also exposes a narrow authenticated local
machine endpoint. Human participant turns and QuaranGate machine turns call the same internal agent
service, but remain separate invocation types with separate identity, model selection, cancellation,
and presentation behavior.

**[PROPOSED]** This participant does not inspect, attach to, impersonate, mirror, or control Kiro,
Copilot, Cursor, or another vendor's built-in chat. It is a separately addressable QuaranGate worker.

## 6. Kiro built-in chat public-surface findings

| Required capability | Classification | Finding | Evidence |
|---|---|---|---|
| enumerate active Kiro IDE chat/agent sessions | `DOCUMENTED_BUT_NOT_PROGRAMMATIC` | Agent Focus and Chat document human session lists/history, but no extension/process enumeration API was found | **[OFFICIAL_DOCUMENTED]** for UI; **[UNKNOWN]** for a public API |
| identify exact active session and workspace | `DOCUMENTED_BUT_NOT_PROGRAMMATIC` | Kiro displays/group sessions by workspace, but no supported external session/workspace binding API was found | **[OFFICIAL_DOCUMENTED]** for UI; **[UNKNOWN]** for a public API |
| send an instruction into built-in IDE chat | `NOT_FOUND` | No supported extension/process prompt method was found | **[UNKNOWN]** |
| receive ordered streamed response events | `NOT_FOUND` | No supported built-in IDE chat event stream was found | **[UNKNOWN]** |
| cancel a built-in IDE turn | `DOCUMENTED_BUT_NOT_PROGRAMMATIC` | Human interrupt/cancel behavior is documented; no external cancel method was found | **[OFFICIAL_DOCUMENTED]** for UI; **[UNKNOWN]** for a public API |
| identify selected agent/model/mode | `DOCUMENTED_BUT_NOT_PROGRAMMATIC` | The IDE exposes human selectors, not a documented external query API | **[OFFICIAL_DOCUMENTED]** for UI; **[UNKNOWN]** for a public API |
| detect built-in session start/end | `NOT_FOUND` | No supported lifecycle event API was found | **[UNKNOWN]** |
| attribute built-in tool execution | `DOCUMENTED_BUT_NOT_PROGRAMMATIC` | Execution history is human-visible; no supported machine event contract was found | **[OFFICIAL_DOCUMENTED]** for UI; **[UNKNOWN]** for a public API |
| receive terminal completion/error status | `NOT_FOUND` | No supported external terminal-result contract was found | **[UNKNOWN]** |
| control Kiro CLI as a separate worker | `SUPPORTED_PUBLIC_API` | `kiro-cli acp` documents initialize/new/load/prompt/cancel/model/mode and streamed notifications over JSON-RPC/stdio | **[OFFICIAL_DOCUMENTED]** |
| a locally confirmed public Kiro built-in-chat API | `NOT_FOUND` | No approved live test or public local declaration qualified such a surface | **[LOCAL_CONFIRMED]** for absence of a qualification; **[UNKNOWN]** for vendor internals |

**[OFFICIAL_DOCUMENTED]** Kiro CLI ACP is a supported machine-facing surface for a distinct Kiro CLI
worker. **[INFERRED]** It is not evidence that the Kiro IDE's private active chat is an ACP server or
that a third party may attach to the IDE-owned agent process.

**[PROPOSED]** Candidate A, a direct adapter to Kiro's built-in live IDE chat, must remain blocked
unless Kiro publishes an explicit supported contract covering the complete identify/prompt/stream/
cancel/workspace/provenance lifecycle. Private commands, extension exports, sockets, storage, or
webview behavior are not acceptable substitutes.

## 7. Current Kiro extension compatibility

These four claims are intentionally separate:

| Claim | Status | Evidence |
|---|---|---|
| third-party extensions run in current Kiro | `SUPPORTED_NOW` for current Kiro releases | **[OFFICIAL_DOCUMENTED]** `1.0.395` says third-party extensions work alongside Kiro; Kiro documents Open VSX compatibility |
| VS Code Chat Participant API is supported by current Kiro | `REQUIRES_CURRENT_KIRO` + `REQUIRES_SPIKE` | **[UNKNOWN]** Kiro's official compatibility material does not enumerate `vscode.chat.createChatParticipant` or its contribution point |
| VS Code Language Model API is supported by current Kiro | `REQUIRES_CURRENT_KIRO` + `REQUIRES_SPIKE` | **[UNKNOWN]** no Kiro contract was found for `vscode.lm.selectChatModels`, `sendRequest`, consent, streaming, or model identity |
| access to Kiro's built-in agent is supported for third-party extensions | `BLOCKED` | **[UNKNOWN]** no supported Kiro built-in-agent API was found; generic extension compatibility does not imply it |

**[INFERRED]** Kiro `1.0.288` moving to Code OSS `1.109.5` makes the public VS Code Chat/LM API shape
technically plausible in later Kiro builds, because those APIs exist in upstream VS Code. It is not a
compatibility guarantee: Kiro may omit contribution points, model providers, consent flows, UI
integration, or API behavior.

**[PROPOSED]** The smallest safe Kiro live qualification is the ten-step spike in section 21. It uses
only a QuaranGate-owned test extension, a disposable authorized WSL workspace, current public APIs,
and a local authenticated endpoint. It does not probe Kiro internals or its built-in chat.

## 8. VS Code Chat Participant, Language Model, Tool, and Command APIs

### 8.1 Supported public capabilities

| Capability | VS Code finding | Evidence |
|---|---|---|
| register own Chat Participant | `vscode.chat.createChatParticipant(id, handler)` plus `chatParticipants` manifest contribution | **[OFFICIAL_DOCUMENTED]** |
| own its participant conversation | handler receives participant-scoped `ChatContext.history`; only messages in which that participant was mentioned are included | **[OFFICIAL_DOCUMENTED]** |
| receive user's prompt | `ChatRequest.prompt`, command, references, tool references, location, and selected model are provided to the handler | **[OFFICIAL_DOCUMENTED]** |
| access editor/workspace APIs | a participant runs in the extension host and can use VS Code extension APIs | **[OFFICIAL_DOCUMENTED]** |
| use human-selected model | `ChatRequest.model` is the model selected in the Chat model picker and is valid only for that request lifetime | **[OFFICIAL_DOCUMENTED]** |
| stream response into standard Chat | `ChatResponseStream` supports streamed markdown, progress, references, buttons, and other supported response parts | **[OFFICIAL_DOCUMENTED]** |
| receive cancellation | the participant handler receives a `CancellationToken`; the same token can cancel LM requests and tool work that honors it | **[OFFICIAL_DOCUMENTED]** |
| use tools chosen for the human request | `ChatRequest.toolReferences` identifies attached tools; the participant can pass an explicit filtered tool set and invoke registered/private tools | **[OFFICIAL_DOCUMENTED]** |
| expose commands and status | extensions may register commands and publish status/progress/output UI | **[OFFICIAL_DOCUMENTED]** |
| use an authenticated local IPC service | desktop local/remote extension hosts run Node.js; Node supports Unix-domain sockets and Windows named pipes | **[OFFICIAL_DOCUMENTED]** platform primitives; authentication design is **[PROPOSED]** |
| make an extension-owned LM request outside Chat | `lm.selectChatModels` and `LanguageModelChat.sendRequest` support extension flows; responses are async streams | **[OFFICIAL_DOCUMENTED]** subject to access, consent, availability, and provider policy |
| invoke a registered tool outside Chat | `lm.invokeTool` may be called globally with no chat invocation token; no chat-specific progress binding then exists | **[OFFICIAL_DOCUMENTED]** |

### 8.2 Supported limitations

| Question | Answer | Evidence |
|---|---|---|
| Can an external QuaranGate process directly submit to this participant through the public Chat API and receive its stream? | **No supported external-process API was found.** `ChatRequestHandler` is entered for a user Chat request and receives VS Code-created request/context/stream objects. | **[OFFICIAL_DOCUMENTED]** handler semantics; **[UNKNOWN]** for any future API |
| Can the extension inject a machine turn into standard Chat history? | **No supported injection API was found.** The public `chat` namespace creates a participant; it does not create an external `ChatRequest`/`ChatResponseStream` transaction. | **[UNKNOWN]** after review of the current public API |
| Does `sendChatParticipantRequest` solve external invocation? | **No.** The documented helper operates on the existing request/context/stream inside a participant handler; it is not a creator of an external chat turn. | **[OFFICIAL_DOCUMENTED]** |
| Can public APIs control another vendor's existing participant? | **No supported API was found.** Participant history is scoped, and even follow-ups can target only a participant contributed by the same extension. | **[OFFICIAL_DOCUMENTED]** for scoping; **[UNKNOWN]** for any future cross-participant API |
| Does `code chat` provide the required machine authority surface? | **No.** It can start a UI chat with a prompt and agent/custom-agent mode, but no official participant target, duplex response stream, operation ID, cancellation handle, or terminal proof is documented. | **[OFFICIAL_DOCUMENTED]** for CLI behavior; **[INFERRED]** insufficiency |
| Can an external process call `vscode.commands.executeCommand` directly? | **No.** It is an in-extension API. Other extensions/UI can call an extension-owned command, but an external process still needs a supported bridge such as the companion's authenticated IPC. | **[OFFICIAL_DOCUMENTED]** command API; **[INFERRED]** process boundary |
| May an undocumented `workbench.action.chat.*` command be production authority? | **No.** Discoverability or current behavior is not a stable supported parameter/result contract. | **[PROPOSED]** policy |
| Can a URI handler be the duplex control channel? | **Not for this design.** It can deliver an external URI callback, but does not provide the required authenticated streaming/cancel channel and risks exposing request material in URI handling paths. | **[OFFICIAL_DOCUMENTED]** URI callback capability; **[INFERRED]** insufficiency |
| Is an extension process sandboxed from the user's workspace/host? | **No fine-grained extension capability sandbox is established by these APIs.** Node workspace extensions are trusted local code with broad host/workspace potential. | **[OFFICIAL_DOCUMENTED]** host placement and API reach; **[INFERRED]** security consequence |

### 8.3 Machine-initiated turn conclusion

**[PROPOSED]** The supported architecture is not to forge a `ChatRequest`. The human Chat handler and
the QuaranGate IPC handler normalize their inputs and call the same internal `IdeAgentService`.

```text
human @quarangate turn
  -> VS Code ChatRequestHandler
  -> normalize HUMAN origin + request.model + request cancellation
  -> IdeAgentService.runTurn()
  -> ChatResponseStream

QuaranGate machine turn
  -> authenticated local IPC request
  -> normalize QUARANGATE origin + authorized operation/model policy
  -> IdeAgentService.runTurn()
  -> ordered IPC event stream + terminal result
  -> optional extension-owned Output/Status/Tree view
```

**[PROPOSED]** A machine result must not be represented as though a human submitted it to VS Code
Chat. Until a public injection API exists, it does not enter standard Chat history. An extension-owned
output channel, status item, or dedicated view may display its status/result, clearly labeled as a
QuaranGate-initiated operation.

## 9. Model and provider identity

### Human Chat turn

**[OFFICIAL_DOCUMENTED]** `ChatRequest.model` is the model selected in the IDE Chat model picker for
that human request. The participant may use it and record its public `id`, `vendor`, `family`,
`version`, and human-readable `name`. It must not retain the model object past the request lifetime.

### QuaranGate-initiated IDE agent turn

**[OFFICIAL_DOCUMENTED]** An extension can query models using `lm.selectChatModels` with vendor/id/
family/version selectors and send a streaming request. First access can require user consent;
`sendRequest` that would show first-use consent must occur only in response to a user action.
`ExtensionContext.languageModelAccessInformation.canSendRequest(model)` can check persisted access
without triggering consent.

**[PROPOSED]** Machine turns use a separately configured, exact model selector established during an
explicit human enrollment/consent command. On each machine request the extension re-resolves the
selector, checks persisted access, records the resolved identity, and fails closed if zero, multiple,
changed, inaccessible, or disallowed models result. A machine turn never reuses or assumes the last
human picker choice and never retains a prior `ChatRequest.model` object.

**[UNKNOWN]** Provider terms and IDE behavior may further restrict non-gesture/background requests.
The live spike must prove that a pre-consented model can be used from the authenticated machine path.
If it cannot, machine-turn model selection remains blocked or must use a separately owner-approved
provider/backend; it must not simulate consent or drive UI.

## 10. Recommended dual-mode companion architecture

**[PROPOSED]** Candidate C is the recommended architecture:

```text
QuaranGate control plane
  |  authenticated, local, versioned IPC
  v
QuaranGate IDE companion (trusted extension component)
  |-- exact IDE/extension/workspace attestation
  |-- human Chat Participant adapter
  |-- machine request/cancel/event adapter
  |-- shared typed IdeAgentService
  |-- closed capability/tool registry
  |-- model resolver and persisted-consent check
  |-- provenance/event hashing
  `-- extension-owned status/output surface
        |
        v
supported IDE Language Model API / selected provider
```

**[PROPOSED]** Both entry paths share prompt normalization, context bounds, tool policy, cancellation,
stream parsing, resource limits, final hashing, and audit correlation. They do not share an implicit
conversation. A machine session is an extension-owned logical session bound by QuaranGate, not a
vendor Chat title or a fabricated VS Code chat session.

**[PROPOSED]** Version negotiation is fail-closed. Enrollment records IDE product/version, public API
capabilities, extension id/version/hash, runtime/remote placement, logical project/worktree mapping,
and IPC protocol version. Any incompatible product, extension, workspace, model, or capability change
stops new turns until re-attested.

## 11. Windows/WSL extension-host placement and local IPC

### Preferred placement

**[OFFICIAL_DOCUMENTED]** In VS Code Remote WSL, the Windows desktop UI/local host and WSL remote
workspace host are distinct. A workspace extension can run where the workspace is located. Kiro's
current compatibility documentation establishes Code OSS/Open VSX extension support generally but
does not prove identical placement behavior for the required APIs.

**[PROPOSED]** For a WSL project, package the companion as a Node workspace extension with preferred
`extensionKind: ["workspace"]`. The agent core, workspace attestation, bounded context reader, and IPC
endpoint should run in the WSL remote extension host beside QuaranGate. This avoids a Windows↔WSL
listener and keeps Linux path identity canonical in one trust zone.

**[PROPOSED]** A single workspace-host extension should contribute the standard participant and UI
elements through supported VS Code APIs. Do not add a Windows UI half unless a qualified IDE proves
that its Chat contribution cannot run from the workspace host.

### WSL IPC

**[PROPOSED]** Prefer a filesystem Unix-domain socket under a per-user runtime directory outside every
repository. The parent directory is owner-only, the socket is owner-only, the path contains a random
enrollment/instance identifier, and stale socket handling verifies ownership/type before unlinking
only the exact enrolled path.

**[PROPOSED]** Filesystem permissions are not sufficient authentication. Enrollment provisions a
high-entropy per-adapter secret outside the repository and outside model/tool context. Each connection
uses protocol version, adapter instance, nonce, timestamp/expiry, and an authenticated request MAC;
nonces are one-use and requests are length-bounded. Rotate/revoke on re-enrollment, extension update,
IDE reset, suspected exposure, or policy change. Never log the secret.

### Windows fallback

**[PROPOSED]** If an owner-approved spike proves a UI-local Windows component is required, prefer a
Windows named pipe with a DACL restricted to the intended user/service identity plus the same
application-layer authentication. A tightly authenticated loopback endpoint bound only to
`127.0.0.1` is a last local fallback after review. It must use an ephemeral/non-public binding,
mutual request authentication, replay protection, and no browser CORS assumption.

**[PROPOSED]** There is no public listener, Funnel, tailnet exposure, repository credential, or
model-visible adapter secret in any variant.

### Attestation fields

**[OFFICIAL_DOCUMENTED]** VS Code exposes product/application information, a per-start `env.sessionId`,
`env.remoteName`, extension identity/version, and workspace folder URIs. **[PROPOSED]** The extension
sends these as claims; QuaranGate independently matches them to trusted logical project/worktree
configuration and canonical WSL filesystem/Git identity. Window title, focus, displayed folder name,
Chat title, caller path, or extension claim alone never selects authority.

## 12. Authority and capability boundary

**[INFERRED]** A Node workspace extension is a high-trust installed component because it runs with
the extension host's user-level potential. The VS Code extension model does not provide the narrow OS
sandbox that QuaranGate gives an isolated runner. Therefore model-facing capability control can be
made narrow, but a malicious/compromised extension package cannot be treated as untrusted code.
Signing/hash pinning, reviewed distribution, update control, and small code size are mandatory human
trust controls.

**[PROPOSED]** QuaranGate grants only an exact tuple:

```text
principal
  -> logical project
  -> exact canonical worktree + base state
  -> enrolled IDE instance + extension instance/generation
  -> IDE agent surface + logical session
  -> operation/request
  -> profile + closed capabilities
  -> model policy
```

### Initial visible capabilities

| Capability | Meaning | Initial status | Evidence |
|---|---|---|---|
| `prompt` | start one bounded turn | allowed by exact operation grant | **[PROPOSED]** |
| `cancel` | cancel exact active operation | allowed to owner/authorized canceller | **[PROPOSED]** |
| `observe_response` | receive ordered bounded events/final result | allowed for exact bound operation | **[PROPOSED]** |
| `read_bounded_editor_context` | exact selected/ranged saved text or explicitly approved URI set | separate opt-in; default none | **[PROPOSED]** |
| `request_review` | read-only LM turn with no tools or mutation APIs | recommended first profile | **[PROPOSED]** |
| `request_implementation` | mutation-capable operation against an admitted independent worktree | future-gated | **[PROPOSED]** |

### Not inherited

**[PROPOSED]** No request automatically grants terminal, arbitrary filesystem read/write, credential
access, extension installation, settings mutation, Git write, Docker, network, MCP, process execution,
raw command execution, arbitrary URI access, or all registered LM tools. The IPC schema has no method
name, argv, shell text, host path, command id, tool name, provider endpoint, or credential supplied by
the caller unless that exact typed field and closed value are part of an approved operation contract.

**[PROPOSED]** The read-only profile exposes no LM tools and calls no edit/write/terminal/command API.
Context comes only from a bounded extension-owned reader after QuaranGate authorizes exact saved
documents/ranges. Unsaved buffer inclusion is a separate explicit capability and is identified as
in-memory evidence.

**[PROPOSED]** A future implementation profile exposes only reviewed QuaranGate-owned tools from a
closed registry. Tool calls are schema-validated, operation-bound, budgeted, independently audited,
and executed only after real writer admission for an independent mutation domain. Passing all
`vscode.lm.tools`, calling arbitrary VS Code commands, or relying on “do not write” prompts is forbidden.

## 13. Provenance and terminal proof

**[PROPOSED]** Every QuaranGate-initiated turn binds and records:

- principal and authentication assurance, without the credential;
- logical project, canonical worktree identity, captured base revision/state;
- IDE product/version, `env.sessionId`, remote kind, extension id/version/hash, adapter generation;
- IDE agent surface, logical session id, operation/request/idempotency ids;
- exact capability/profile and tool-policy revision;
- requested selector and resolved model `vendor/id/family/version/name`, when available;
- start state/time, ordered event sequence, bounded response stream, tool request/result metadata;
- cancellation requester/state and late-event disposition;
- terminal completion/error/cancel/indeterminate state;
- final canonical result hash and evidence/mutation identity where applicable.

**[PROPOSED]** The IPC stream uses monotonically increasing sequence numbers and exactly one terminal
event. QuaranGate hashes the canonical ordered event/result envelope. The extension's success return
does not prove filesystem mutation; mutation evidence must come from the governed mutation domain.

**[PROPOSED]** Cancellation maps an exact operation to an owned `CancellationTokenSource`, stops new
tool calls, cancels the LM request, awaits/quarantines outstanding owned work, and emits a terminal
state only when the extension core has ceased processing. A sent cancellation token is not proof that
an external provider stopped computation. Disconnect, host reload, or ambiguous tool state produces
`INDETERMINATE`, never success or writer release without reconciliation.

## 14. Parallel IDE plus CLI worker model

### Safe writer composition

**[PROPOSED]** Two mutation-capable surfaces use separate real worktrees or the existing isolated
sandbox path:

```text
logical PROJECT X
  |
  |-- WORKTREE A / base A
  |     QuaranGate IDE Agent writer
  |     exact IDE + extension + session + operation binding
  |
  `-- WORKTREE B or job sandbox / base B
        governed CLI Agent writer
        exact backend + session + operation binding
```

**[PROPOSED]** QuaranGate's trusted project registry, not the IDE or caller, maps the logical project
to approved canonical worktree identities. Each active operation records agent surface, session,
read-only/writer capability, current operation, and base state. Worktree admission proves that the
mutation domains are distinct; path spelling, Git branch name, or prompt assertions are insufficient.

**[PROPOSED]** The one-controlled-live-writer rule remains per real worktree. The existing stricter
global/per-project writer policy may remain until a separate gate explicitly and atomically permits
multiple independent-worktree writers. A CLI sandbox writer is not a live-worktree writer until
apply; apply and any IDE direct-write operation contend for the target worktree's real writer slot.

### Safe review composition

**[PROPOSED]** The preferred first deployment is:

```text
IDE Chat Agent: read-only review, no tools, bounded saved editor context
CLI Agent: isolated sandbox implementation through existing Agent Control Plane
```

This provides useful parallelism without granting the extension a mutation path. The IDE review may
observe a separately approved worktree/base; it must not receive ambient access to every open folder.

## 15. IDE applicability

| IDE | Third-party extension | Chat Participant API | Language Model API | Built-in agent access | QuaranGate dual-mode path | Evidence |
|---|---|---|---|---|---|---|
| VS Code | supported | supported public API | supported public API with consent/availability constraints | no cross-participant control found | `SUPPORTED_NOW` at API/design level; `REQUIRES_SPIKE` before implementation | **[OFFICIAL_DOCUMENTED]** |
| Kiro `1.0.437` | supported generally since `1.0.395` | not established by Kiro docs | not established by Kiro docs | not found | `REQUIRES_CURRENT_KIRO` + `REQUIRES_SPIKE` | **[OFFICIAL_DOCUMENTED]** for generic extensions; **[UNKNOWN]** for Chat/LM/built-in access |
| local Kiro `1.0.212` | predates current compatibility guarantee | unqualified | unqualified | not found | `BLOCKED` for spike until owner-approved upgrade | **[LOCAL_CONFIRMED]** version; **[UNKNOWN]** capabilities |
| Cursor | supports many Open VSX extensions, not every VS Code extension | not established by official Cursor docs | not established by official Cursor docs | not found | `REQUIRES_SPIKE`; extension-owned non-Chat view is only a fallback UX, not Chat API proof | **[OFFICIAL_DOCUMENTED]** for generic extensions; **[UNKNOWN]** for APIs |

**[PROPOSED]** VS Code is the first qualification target because its required public APIs and remote
extension-host model are documented. Kiro follows only after owner-approved upgrade. Cursor is a
separate compatibility target and must not inherit the VS Code result.

## 16. Candidate architecture decision table

| Candidate | Classification | Qualification | Evidence |
|---|---|---|---|
| A. Kiro built-in chat direct adapter | `BLOCKED` | No supported public Kiro IDE chat identify/prompt/stream/cancel contract was found | **[UNKNOWN]** API absence; block is **[PROPOSED]** fail-closed policy |
| B. QuaranGate Chat Participant | `SUPPORTED_NOW` for VS Code APIs; `REQUIRES_CURRENT_KIRO` + `REQUIRES_SPIKE` for Kiro; `REQUIRES_SPIKE` for Cursor | Viable without private built-in-chat access | **[OFFICIAL_DOCUMENTED]** VS Code; **[UNKNOWN]** Kiro/Cursor parity |
| C. Dual-mode companion | `REQUIRES_SPIKE`; **recommended** | Human participant plus authenticated machine endpoint share one governed core; machine output stays outside standard Chat history | **[PROPOSED]** based on supported VS Code extension/LM/IPC primitives |
| D. Future vendor-native plus fallback participant | `FUTURE` | Use a vendor-native API only if one later satisfies the full contract; otherwise select the companion explicitly, never silently | **[PROPOSED]** |

## 17. Recommended architecture and why

**[PROPOSED]** Select Candidate C, the dual-mode QuaranGate companion, beginning with VS Code and a
read-only review profile.

Reasons:

1. **[OFFICIAL_DOCUMENTED]** VS Code publicly supports an extension-owned participant, human-selected
   model access, streamed responses, cancellation tokens, explicit tools, commands/status, and remote
   workspace extension placement.
2. **[PROPOSED]** A separate authenticated IPC entrypoint gives QuaranGate a real machine authority
   surface without UI automation, keyboard injection, undocumented workbench commands, or pretending
   a machine request is a human `ChatRequest`.
3. **[PROPOSED]** Sharing one internal core prevents semantic drift between human and machine paths
   while preserving different provenance and presentation.
4. **[LOCAL_CONFIRMED]** It reuses QuaranGate logical-project/worktree authority and writer rules
   instead of creating a second backend or weakening sandbox/apply controls.
5. **[PROPOSED]** It remains vendor-independent at the internal contract while allowing each IDE to
   fail closed when its public APIs are absent.
6. **[PROPOSED]** Vendor-native integration can be added later behind the same common contract only
   after a supported API qualifies; no private Kiro dependency is required now.

## 18. Limitations and technical blockers

### Confirmed design limitations

- **[OFFICIAL_DOCUMENTED]** Standard VS Code Chat streaming is tied to a VS Code-created human
  `ChatRequestHandler` invocation; machine turns cannot currently be claimed as standard participant
  history.
- **[OFFICIAL_DOCUMENTED]** The human picker model object is request-scoped; a machine turn requires
  separate resolution and persisted permission.
- **[INFERRED]** A trusted Node extension remains a high-privilege supply-chain component. Narrow
  model tools do not sandbox compromised extension code.
- **[UNKNOWN]** Kiro and Cursor do not officially establish Chat Participant/LM API parity.
- **[UNKNOWN]** Provider policy for pre-consented machine-initiated LM requests requires live proof.
- **[PROPOSED]** Read-only is the only initial profile. Direct mutation remains feature-gated until
  exact worktree admission, tool mediation, evidence, cancellation, and recovery are separately
  accepted.

### Technical blockers to implementation-ready status

1. **[UNKNOWN]** Kiro requires an owner-approved upgrade and live Chat/LM/placement spike.
2. **[UNKNOWN]** Cursor requires an independent live Chat/LM/placement spike.
3. **[UNKNOWN]** VS Code requires a live proof of pre-consented machine LM invocation and cancellation.
4. **[PROPOSED]** IPC enrollment, secret storage/rotation, extension signing/hash pinning, and update
   policy require owner decisions and security review.
5. **[PROPOSED]** Production mutation needs an accepted worktree-aware writer admission integration;
   prompt-only read-only classification is forbidden.

## 19. Future implementation file plan

**[PROPOSED]** This is a plan, not authorization. Exact paths must be re-derived after Lane A lands.
The first spike should be isolated and should not alter current Agent Control Plane behavior.

### Companion extension package

| Future path | Purpose |
|---|---|
| `extensions/quarangate-ide-chat/package.json` | VS Code/Kiro/Cursor contribution points, exact engine range, workspace extension placement, commands, configuration |
| `extensions/quarangate-ide-chat/src/extension.ts` | composition root only |
| `extensions/quarangate-ide-chat/src/core/contracts.ts` | normalized human/machine turn, event, terminal, capability, model, provenance types |
| `extensions/quarangate-ide-chat/src/core/ideAgentService.ts` | shared bounded agent core |
| `extensions/quarangate-ide-chat/src/chat/participant.ts` | human `ChatRequestHandler` adapter and Chat streaming |
| `extensions/quarangate-ide-chat/src/ipc/protocol.ts` | closed framed schema, limits, authentication metadata, sequence/terminal envelopes |
| `extensions/quarangate-ide-chat/src/ipc/server.ts` | UDS/named-pipe lifecycle and authenticated request/cancel/event handling |
| `extensions/quarangate-ide-chat/src/attestation/workspace.ts` | IDE/remote/workspace/worktree claims; no authority decision |
| `extensions/quarangate-ide-chat/src/model/modelResolver.ts` | exact selector, access check, identity capture, fail-closed drift handling |
| `extensions/quarangate-ide-chat/src/context/boundedEditorContext.ts` | explicit saved-document/range reads and byte/token budgets |
| `extensions/quarangate-ide-chat/src/tools/governedToolRegistry.ts` | closed allowlist; empty for initial read-only spike |
| `extensions/quarangate-ide-chat/src/provenance/turnRecorder.ts` | ordered events and canonical result hash inputs |
| `extensions/quarangate-ide-chat/src/ui/status.ts` | clearly labeled machine-operation status/output UX |
| `extensions/quarangate-ide-chat/test/**` | deterministic protocol/core/attestation/model/tool/cancel tests |

### QuaranGate-side integration after the spike

| Future path/area | Purpose and constraint |
|---|---|
| `src/shared/ideChat/**` | backend-neutral IDE-agent contract; do not overload existing CLI backend/session meaning |
| `src/gateway/ideChat/**` | separate deny-by-default scopes/schemas/tools; no raw path/command/tool/provider input |
| `src/executor/ideChat/**` | enrolled adapter registry, IPC client, state machine, provenance, cancellation/recovery |
| trusted agent/project configuration | reuse logical project and canonical worktree authority; add explicit IDE/worktree grants only after schema review |
| dedicated IDE-chat tests | authorization matrix, instance/workspace/session binding, cancellation, writer races, restart/revocation |
| future audit document | exact versions/hashes/topology and PASS/BLOCK evidence |

**[PROPOSED]** Do not add an IDE-specific backend to the existing CLI ACP adapter merely to support
this surface. The common IDE-agent contract should be separate while reusing trusted project/worktree
identity, operation ownership, audit conventions, and live-writer admission.

### Ollama O1 conflict assessment

**[LOCAL_CONFIRMED]** Current I1R2 changes only `docs/IDE_CHAT_AGENT_I1R2.md`; conflict with Lane A is
none. No Ollama path or shared source was inspected or modified.

**[PROPOSED]** The isolated extension package and `src/**/ideChat/**` namespaces minimize future
overlap. Shared project registry, principal/grant schema, job state, audit, and writer-admission files
may overlap Lane A after it lands. Before any implementation gate, rebase/inspect the landed public
diff, derive exact ownership, and stop on overlap rather than editing concurrently.

## 20. Deterministic test plan

**[PROPOSED]** Run without a real model, GUI automation, personal session, or network:

1. validate every IPC request/event/terminal envelope against strict schemas, byte/count/depth limits,
   protocol version, operation id, adapter generation, and exact one-terminal rule;
2. reject wrong MAC, stale timestamp, reused nonce, unknown adapter, wrong extension hash/version,
   cross-operation cancel, duplicate/gap/out-of-order/late events, and oversized frames;
3. canonicalize temporary WSL Git worktrees and deny symlinks, path aliases, multi-root ambiguity,
   caller-supplied paths, wrong project/worktree/base, local/remote placement mismatch, and IDE restart;
4. drive human and machine adapters through the same fake `IdeAgentService` and prove identical core
   policy with distinct origin/session/provenance;
5. prove the human adapter streams to a fake Chat stream and cancellation reaches the core;
6. prove the machine adapter streams ordered IPC events and exact cancellation reaches the same core;
7. make model selection return zero, one, multiple, changed, and inaccessible models; only the exact
   accessible configured identity proceeds;
8. prove first-use/no-consent paths fail closed without UI injection or background consent prompts;
9. prove the read-only profile has an empty tool set and never calls editor edit, workspace write,
   command, terminal, process, network, Git-write, Docker, MCP, or credential APIs;
10. fuzz tool call names/arguments and prove only exact separately authorized closed tools can execute;
11. enforce prompt/context/response/tool/turn/runtime budgets and secret/log redaction;
12. simulate extension/IDE/IPC restart, cancellation races, disconnect, partial streams, and unresolved
    tools; no replay, false success, or premature writer release occurs;
13. hash canonical result/provenance and prove changes in event order, identity, model, capability, base,
    or result change the hash;
14. create two temporary Git worktrees and prove exact separate mutation-domain admission; two writers
    for one canonical worktree deny atomically;
15. prove a CLI sandbox worker and IDE read-only reviewer coexist, and a CLI apply contends with any
    future IDE writer for the exact target worktree.

## 21. Future live spike plan

**[PROPOSED]** The spike answers only the ten owner questions below. Start with current supported VS
Code in a disposable authorized WSL Git project/worktree. Repeat in Kiro only after the owner approves
an exact Kiro upgrade and the version/hash is recorded. Run Cursor separately; never inherit results.

1. Can the extension load in the exact supported IDE/version and report its extension-host placement?
2. Can it attest the exact canonical WSL workspace/worktree and reject a wrong or ambiguous workspace?
3. Can it register its own Chat Participant through a supported public API?
4. Can that participant receive a human prompt and bind it to the attested workspace?
5. Can it stream a bounded response into standard Chat using the human-selected model?
6. Does Chat cancellation reach the shared core and produce a reconciled terminal state?
7. Can it expose only a local authenticated machine command over UDS, with no public listener?
8. Can the machine command run the same internal core using an exact pre-consented model without
   fabricating a `ChatRequest` or driving UI?
9. Can it stream ordered events/final hash back to QuaranGate and cancel/reconcile the exact operation?
10. Can the read-only IDE worker coexist with a separate CLI worker on another worktree, and can
    mutation-domain tests prevent two uncontrolled writers from sharing one real worktree?

**[PROPOSED]** Retain exact IDE/Code OSS/extension host/Node/extension versions and hashes, remote kind,
workspace/worktree/base identity, public API probe results, model identity/consent state, IPC endpoint
type and permissions without secrets, event transcript hashes, cancellation outcome, Git status for
both worktrees, and cleanup evidence.

**[UNKNOWN]** For Kiro, `OWNER_UPGRADE_DECISION_REQUIRED` is a prerequisite. Local `1.0.212` is not a
valid current-product qualification target for the documented post-`1.0.395` extension capability.

## 22. Human review gates

**[PROPOSED]** Stop for human approval at each gate:

1. approve the exact Kiro upgrade target and capture rollback/installer provenance; do not auto-update;
2. approve the VS Code-first, Kiro-second, Cursor-third spike order and disposable worktrees;
3. review the extension manifest, dependency lock, bundled code, source hash/signature, and update policy
   before installing a development or packaged extension;
4. explicitly enroll the IDE/extension instance and compare the canonical logical project/worktree;
5. explicitly choose/consent to the machine-turn model selector and review provider policy;
6. approve IPC secret provisioning, storage, rotation, revocation, and recovery;
7. review deterministic and live spike evidence and issue separate per-IDE PASS/BLOCK decisions;
8. approve any production runtime implementation only after the spike passes;
9. approve a mutation profile only after independent worktree/writer/tool/evidence/recovery review;
10. re-review on IDE, Code OSS base, extension, LM provider, protocol, or permission-policy change.

## 23. Owner decisions

### Already authoritative

- **[LOCAL_CONFIRMED]** Two independently governed agent surfaces need not share vendor/process/chat/session.
- **[LOCAL_CONFIRMED]** Same-session Kiro IDE plus Kiro CLI attachment is not required.
- **[LOCAL_CONFIRMED]** VS Code plus a distinct Kiro CLI/ACP worker remains valid without a VS Code runtime adapter.
- **[LOCAL_CONFIRMED]** One controlled live writer per worktree remains mandatory.
- **[LOCAL_CONFIRMED]** No private protocol, UI automation, second backend, or Lane A interference is allowed.

### Open decisions before the spike/implementation

1. **[PROPOSED]** Approve or decline upgrade from Kiro `1.0.212` to exact current supported Kiro; record
   version/hash and update policy.
2. **[PROPOSED]** Confirm VS Code as the first live spike target.
3. **[PROPOSED]** Confirm the initial participant profile is read-only review with no tools.
4. **[PROPOSED]** Select the permitted machine-turn model vendor/selector and consent/bootstrap policy.
5. **[PROPOSED]** Select extension packaging, signature/hash pinning, dependency, installation, update,
   rollback, and revocation policy.
6. **[PROPOSED]** Select IPC enrollment secret owner/storage/rotation and whether QuaranGate connects to
   the extension or the extension registers outbound with QuaranGate.
7. **[PROPOSED]** Approve the extension-owned status/output UX for machine turns that cannot enter
   standard Chat history.
8. **[PROPOSED]** Decide whether a future mutation profile may write an admitted dedicated worktree or
   must route all mutations through the existing sandbox/evidence/apply plane.
9. **[PROPOSED]** Set prompt/response/context/provenance retention, redaction, encryption, and operator access.
10. **[PROPOSED]** Decide whether failure of Kiro/Cursor Chat API spikes permits an extension-owned
    dedicated view as a lower-tier IDE agent surface, or leaves that IDE blocked for first-class Chat.

## 24. Qualification verdict

**[PROPOSED] `QUALIFIED_GO_FOR_BOUNDED_DUAL_MODE_SPIKE`; `NO_GO` for a Kiro built-in-chat direct adapter.**

**[OFFICIAL_DOCUMENTED]** VS Code has the public primitives required for a QuaranGate-owned human Chat
Participant and extension-owned LM agent core. **[INFERRED]** It does not have the required public
external-process-to-standard-Chat transaction surface. **[PROPOSED]** The safe answer is a dual-mode
companion whose authenticated machine endpoint and human participant share one internal core while
keeping machine results explicitly outside standard Chat history.

**[UNKNOWN]** Current Kiro and Cursor applicability is not implementation-ready until separate live
spikes prove the exact Chat/LM/extension-host behavior. Kiro's spike additionally requires an
owner-approved upgrade from local `1.0.212`. No supported path was found to control Kiro's built-in
IDE chat directly.

**[LOCAL_CONFIRMED]** The result does not change I2, does not require same-session synchronization,
does not modify runtime, and does not touch Ollama O1.
