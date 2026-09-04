# QuaranGate IDE Chat S1 — VS Code Dual-Mode Companion Spike

> **SPIKE ONLY — NOT PRODUCTION — NO MUTATION AUTHORITY**

**Date:** 2026-09-04

**Branch:** `design/ide-session-control`

**Base HEAD:** `1977290c07a140aad111a6cbc9bbc970f5bfec6f`

**Spike root:** `extensions/quarangate-ide-chat-spike/`

**Verdict:** `S1_ARCHITECTURE_FEASIBILITY=PASS_WITH_EXTERNAL_HOST_LIMITATION`

## 1. Result boundary

The supported dual-mode companion-extension architecture is feasible through the automated and live
evidence listed below. VS Code `1.134.0` loaded the extension in an Extension Development Host on
`WSL: Ubuntu-24.04`; the extension attested the exact workspace, created an owner-only Unix-domain
socket, and served completed and cancelled machine streams through the same `AgentCore` used by its
real Chat Participant handler. A later owner-operated check in the actual Remote WSL Extension
Development Host on VS Code `1.136.1` proved that the public model registry discovers the registered
local deterministic provider model exactly once.

The owner previously confirmed `PARTICIPANT_VISIBLE=PASS`, but VS Code stopped the submitted turn at
its mandatory pre-handler `Language model unavailable` model-resolution gate. The owner approved one
bounded S1 change: register a deterministic local non-inference Language Model Chat Provider shim
through supported public VS Code APIs. The shim is implemented, registered, visible and enabled under
Language Models, and discoverable through `vscode.lm.selectChatModels`; automated tests pass. It is
still absent from the normal Ask picker. Plan mode separately omits it because the model truthfully
advertises no tool-calling capability. On the evidence available, the remaining failure is confined
to normal VS Code Chat picker exposure and is conservatively classified
`HOST_PICKER_LIMITATION_OR_DEFECT`. No exact undocumented internal bug is claimed.

Because the picker prevents the real participant handler from receiving a human turn, live human
streaming and live human cancellation remain `BLOCKED_BY_HOST_PICKER`, not passing. No public
headless API exists for creating that human `ChatRequest`/`ChatResponseStream` interaction, and UI
automation is forbidden.

The shim is not a real LLM and makes no inference, cloud/provider, account, credential, workspace,
telemetry, or external-network call. This bounded provider conclusion is not an air-gap claim for the
entire VS Code host. No root dependency, production source, QuaranGate runtime, Lane A worktree, Kiro
installation, user/global setting, deployment, commit, staging, or push was changed.

## 2. Architecture actually implemented

```text
VS Code Chat
  -> resolve QuaranGate Spike Transport Model (local inert provider shim)
  -> real @quarangate-spike request
  -> VS Code-owned request/stream/token
  -> shared AgentCore

authenticated local machine request
  -> strict one-request NDJSON Unix-socket connection
  -> same shared AgentCore

AgentCore -> per-operation ID / provenance / ordered events
          -> independent abort controller / bounded terminal history
```

The human adapter passes the genuine `ChatRequest.prompt` into the core, renders events through the
genuine `ChatResponseStream`, and maps the genuine `CancellationToken` to the exact operation handle.
The machine adapter parses and authorizes a local frame before calling that same core. It never
fabricates VS Code objects or writes a machine turn into Chat history.

The core is deliberately deterministic. Prompt content is bounded but otherwise ignored. It emits
`started`, five `chunk` events, then `completed`; an abort produces `cancelled`. It has no tools,
model, shell, filesystem mutation, Git, Docker, MCP, network, or production connection.

The provider shim is separate from `AgentCore`. It publishes one fixed model identity, exposes no
tools or image input, and returns one fixed bounded text part only if invoked directly for public-API
compliance. Its response and fixed token-count methods do not inspect opaque request messages. It
does not forward, log, persist, or serialize them outside the in-process VS Code call. The human
participant continues to ignore `request.model`; only `request.prompt` enters the deterministic
core, where prompt text is validated for bounds and otherwise ignored.

The complete file-by-file ownership and integration inventory is in the spike `README.md`.

## 3. Supported APIs and extension-host placement

The extension uses public `contributes.languageModelChatProviders`,
`vscode.lm.registerLanguageModelChatProvider`, `LanguageModelChatProvider`,
`LanguageModelChatInformation`, `LanguageModelTextPart`, `vscode.chat.createChatParticipant`,
`ChatRequestHandler`, `ChatResponseStream`, `CancellationToken`, `commands.registerCommand`,
`workspace.workspaceFolders`, `env.remoteName`, `extensions.getExtension`,
`Extension.extensionKind`, `Uri.file`, `window` output/message APIs, and `ExtensionContext`
lifecycle facilities. It uses no proposed/private API flag, internal workbench service, or
undocumented command.

The manifest declares `extensionKind: ["workspace"]`. The official VS Code extension-host contract
places workspace extensions with remote workspaces, and the public Chat Participant API creates and
streams a participant-owned response. Node's stable IPC API supplies the Unix-domain socket:

- <https://code.visualstudio.com/api/advanced-topics/extension-host>
- <https://code.visualstudio.com/api/advanced-topics/remote-extensions>
- <https://code.visualstudio.com/api/extension-guides/ai/chat>
- <https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider>
- <https://code.visualstudio.com/api/references/contribution-points#contributes.languageModelChatProviders>
- <https://code.visualstudio.com/api/references/vscode-api>
- <https://nodejs.org/api/net.html#ipc-support>

### 3.1 R2 data-leakage boundary

| Property | R2 result |
|---|---|
| prompt body persisted | NO |
| prompt body logged | NO |
| prompt body sent to network | NO |
| provider external endpoints | NONE |
| workspace content requested/read by provider | NO |
| workspace content forwarded by provider | NO |
| workspace content sent to network | NO |
| QuaranGate prompt/workspace telemetry | NONE |
| cloud or provider fallback | NONE |
| account, API key, OAuth, GitHub, or Copilot dependency | NONE |

The public provider callback necessarily has an opaque in-process `messages` parameter if VS Code
invokes it directly. R2 neither inspects nor retains that parameter and discards its reference on
return. The shim does not request workspace context and has no workspace API. If VS Code itself were
to place prompt or workspace-derived content in that opaque argument during a direct invocation,
the shim applies the same no-inspection, no-persistence, no-logging, no-forwarding behavior. No such
direct invocation is needed by the participant's deterministic `AgentCore` path.

Live VS Code status recorded:

```text
Version: Code 1.134.0 (110a328ea54b42367b803ec53ee0bf52ef26b419)
Window: [Extension Development Host] ... [WSL: Ubuntu-24.04]
Remote: WSL: Ubuntu-24.04
Remote OS: Linux x64 6.6.114.1-microsoft-standard-WSL2
Remote extension-host process: present
Development extension: loaded from the WSL spike path
```

## 4. Workspace attestation

Activation fails closed unless:

- `vscode.env.remoteName === "wsl"`;
- VS Code reports this extension as `ExtensionKind.Workspace`;
- exactly one workspace folder is open;
- its URI scheme is `file`;
- its filesystem path resolves through `realpath` to an absolute Linux directory.

The live activation record was:

```json
{
  "workspaceUri": "file:///home/herman/projects/quarangate-ide-session",
  "canonicalWorkspaceUri": "file:///home/herman/projects/quarangate-ide-session",
  "scheme": "file",
  "remoteName": "wsl",
  "canonicalPath": "/home/herman/projects/quarangate-ide-session",
  "extensionHostKind": "workspace"
}
```

Machine requests must supply that exact canonical URI. Relative paths, Windows paths, UNC paths,
alternate projects, and traversal spellings are rejected; they are never canonicalized on behalf of
the caller.

VS Code's public API reports the remote kind as `wsl`, not a durable WSL distribution enrollment
identity. The observed `Ubuntu-24.04` name came from supported VS Code status output. Binding a
production enrollment to an IDE instance, distro, workspace, and connection generation remains a
production requirement.

## 5. IPC contract and authentication

The WSL extension host listens only on a filesystem Unix-domain socket beneath a new random runtime
directory outside the repository. It does not open TCP, `0.0.0.0`, LAN, Tailscale, Funnel, or a
Docker-published port.

Each run request contains exactly:

```text
type = run
version = 1
operationId = UUID
nonce = 32..128 base64url characters
workspace = exact attested canonical URI, at most 2048 bytes
prompt = non-empty, at most 4096 bytes
secret = non-empty, at most 128 bytes
```

Cancel uses the same fields except `prompt` and names the exact target operation. Unknown, missing,
duplicate, wrongly typed, malformed, and oversized fields fail closed. One connection carries one
request frame; the request frame is capped at 16 KiB. There are at most 16 active connections and 16
active operations. Nonces and operation IDs remain reserved for the runtime lifetime; after 2,048
values the endpoint fails closed until restart.

The runtime creates a 256-bit random base64url secret. The directory is `0700`, while the socket and
credential are `0600`. Credential comparison hashes both inputs to equal-length digests and uses
`timingSafeEqual`. Authentication and exact workspace matching occur before nonce claiming or
operation creation. The secret is not passed to `AgentCore`, Chat, a model, or logs.

The helper reads the credential file by an explicit path and generates a new nonce. The bounded live
probe does not print the credential.

## 6. Streaming, cancellation, concurrency, and attribution

Every event contains the protocol version, operation ID, `human` or `machine` origin, monotonically
increasing sequence number, and event type. Each operation owns a distinct `AbortController`; there
is no global cancellation flag.

Human cancellation is wired from the VS Code `CancellationToken` to the returned human operation
handle. Machine cancellation is a new authenticated socket connection, exact workspace check, fresh
nonce, exact operation ID, and machine-origin check. A machine request cannot cancel a human
operation through this adapter. Disconnecting a run socket cancels only its machine operation.

Tests ran human operation A and machine operation B concurrently, cancelled A, and observed B
complete. Live machine tests ran independent operations, observed a normal completed stream, and
observed an exact cancelled stream. Streams retained distinct IDs and terminal states.

Audit records contain only operation ID, origin, state, sequence, and a short workspace fingerprint.
They omit prompt and credential material.

## 7. Automated validation

Final validation environment: Node `v24.15.0`, npm `11.12.1`, TypeScript `5.9.2`, VS Code API types
`1.109.0`.

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` with local Unix-socket permission | PASS — 27 passed, 0 failed |
| public provider registration seam and manifest identity | PASS |
| no-account/no-credential discovery, including silent discovery | PASS |
| fixed bounded provider output and fixed token count | PASS |
| opaque provider messages/token-count input not inspected | PASS |
| provider source forbidden capability checks | PASS |
| human participant adapter calls the shared `AgentCore` without model input | PASS |
| two-human-operation cancellation isolation | PASS |
| human cancellation cannot cancel a machine operation | PASS |
| strict run/cancel schemas | PASS |
| unknown/missing/duplicate fields | PASS |
| oversized frame and prompt | PASS |
| bad nonce/operation/version/type | PASS |
| wrong/Windows/UNC/traversal workspace | PASS |
| bad secret | PASS |
| nonce replay | PASS |
| ordered stream and terminal state | PASS |
| human-style cancellation abstraction | PASS |
| machine cancellation and stale cancellation | PASS |
| operation isolation and collision | PASS |
| lifetime ID reservation/capacity | PASS |
| extension/core shutdown cancellation | PASS |
| prompt/credential audit omission | PASS |
| runtime permissions/path bound/fresh identity | PASS |

The restricted sandbox run reported only the unchanged IPC test-file process as failed, consistent
with its documented inability to bind local sockets. The identical 27-test suite passed outside
that bind restriction under the owner's local Unix-socket authorization.

The dependency graph contains only pinned development dependencies: TypeScript, VS Code types, Node
types, and the Node types' `undici-types` dependency. The lockfile records integrity values. An npm
advisory query was attempted, but the endpoint returned no usable result after the initial restricted
DNS failure; dependency advisory status is therefore unknown, not passing.

## 8. Live acceptance evidence

Automated/supported-CLI evidence passed:

1. VS Code `1.134.0` opened an Extension Development Host in `WSL: Ubuntu-24.04`.
2. The remote server logged loading the development extension from the spike path.
3. Activation logged the exact canonical workspace and `workspace` extension-host kind.
4. Runtime instance `a69ef36f2869b2ea6864c270fc407213` created `0700` directory and `0600`
   socket/credential.
5. Machine operation `7e2e10b6-7f6d-4fc7-8b6d-11b1c411b817` streamed sequences `0..6` and
   completed.
6. Machine operation `99211c63-dce2-4ae9-a3cf-fb4528ce0ff2` was cancelled and recorded terminal
   `cancelled`; the probe also returned `AUTH_DENIED`, `WORKSPACE_MISMATCH`, and stale cancel.
7. Reopening the Development Host removed the prior exact runtime directory and created fresh
   instance `7c623b21fbde1be2a1625488ed570146` with a distinct socket and credential path.
8. After the final bounded-delay source adjustment, the prior runtime was removed and exact final
   build instance `f30bbc57fdb2eb229204aeb170b9c98e` repeated the live probe: operation
   `550acb2a-c974-404f-a5d6-94adb82d8b00` reached `cancelled`, with `AUTH_DENIED`,
   `WORKSPACE_MISMATCH`, and stale-cancel checks all passing.
9. Exact final-build operation `c811ebf1-1a33-4a7b-98ae-041f8733e75c` streamed sequences `0..6`
   through terminal `completed`.

No secret value was printed or retained in this document.

The subsequent owner-operated human check confirmed the participant appears in the picker:
`PARTICIPANT_VISIBLE=PASS`. Sending a request did not reach the handler because the current host
required a model to resolve first. That pre-handler `Language model unavailable` block is the sole
reason for the owner-approved local provider shim.

### 8.1 D2 live-evidence reconciliation and closeout

The owner then ran the bounded D2 probe in the actual Remote WSL Extension Development Host, not the
launcher/source window. The target host reported:

```text
workspaceUri=file:///home/herman/projects/quarangate-ide-session
canonicalWorkspaceUri=file:///home/herman/projects/quarangate-ide-session
remoteName=wsl
extensionHostKind=workspace
extensionUri=file:///home/herman/projects/quarangate-ide-session/extensions/quarangate-ide-chat-spike
```

The public `vscode.lm.selectChatModels` result was:

```text
[D2_MODEL_REGISTRY_PROBE] count=1
id=deterministic-transport-non-inference
vendor=quarangate-spike-local-deterministic
family=quarangate-spike-deterministic-local-non-inference
version=s1-r2
name=QuaranGate Spike Transport Model
maxInputTokens=4096
toolCalling=UNAVAILABLE
imageInput=UNAVAILABLE
```

This supersedes the prior D2 `INSUFFICIENT_EVIDENCE` disposition without rewriting the historical
observation that led to it. The reconciled D2 facts are:

| D2 question | Reconciled result |
|---|---|
| public registry result count | `1` |
| public registry match | `YES` |
| provider registration alive | `YES` |
| registry changed after activation | `NO_EVIDENCE` |
| wrong vendor or ID | `NO` |
| public API discovery failure | `NO` |

The owner additionally verified `REMOTE_WSL_EXTENSION_HOST=PASS`,
`PROVIDER_VISIBLE_IN_LANGUAGE_MODELS=PASS`, `MODEL_VISIBLE_IN_LANGUAGE_MODELS=PASS`, and
`MODEL_VISIBILITY_ENABLED=PASS`. The host settings observed were
`chat.agentHost.enabled=false` and `chat.agentHost.byokModels.enabled=true`. Nevertheless, the model
was absent from both the normal Ask picker and the Plan picker. The Plan result is separately
consistent with its tool-calling requirement; the shim must not advertise a false tool capability.
The normal Ask result remains unexplained by supported public evidence. The narrowest supportable
root-cause classification is therefore `HOST_PICKER_LIMITATION_OR_DEFECT`, with no supported public
fix currently demonstrated.

The picker block prevents a real human request from reaching the participant. Accordingly:

- `LIVE_HUMAN_PARTICIPANT_STREAMING=BLOCKED_BY_HOST_PICKER`
- `LIVE_HUMAN_CANCELLATION=BLOCKED_BY_HOST_PICKER`

Neither human UI test is a pass. UI automation and fabricated VS Code request/stream objects remain
out of scope.

The temporary D2 public-registry probe command, source, and its D2-only tests were removed after this
evidence was captured. They were forensic plumbing rather than S1 architecture or durable provider
coverage. The provider shim and the provider registration, identity, bounded-output,
opaque-message-noninspection, and forbidden-capability regression tests remain.

## 9. Security review

A single-pass, complete source audit covered the spike manifest, lockfile, TypeScript source, test
source, and package exclusions. The source scan was local-only because no independent sub-agent was
authorized. Canonical scan artifacts were finalized under:

```text
/tmp/codex-security-scans/quarangate-ide-session/5c1fe584-b2e8-4521-91fa-a5a9c8d28516/
```

That sealed scan snapshot preceded the R2 provider shim. R2 therefore performed a fresh exact-source
audit of the provider, participant adapter, registration call, manifest, compiled provider output,
tests, and dependency graph. The provider module has only an erased type import; its compiled output
has no imports. It contains no network, filesystem, child-process, environment, authentication,
secret-store, state-store, telemetry, or logging call. It neither reads nor iterates opaque request
messages. The machine IPC/parser/runtime source was not changed by R2 and the complete 27-test suite
passed.

The required term scan produced only these classified hits: package-lock registry URLs and the
pre-existing transitive development-only `undici-types`; the allowed pre-existing `node:net`
Unix-domain IPC; its `AUTH_DENIED` error text; test-only forbidden-pattern literals and source-file
reads. No provider-related external network, TCP, DNS, credential, filesystem, shell, persistence,
prompt logging, telemetry, real-provider fallback, or cloud fallback path exists.

**Validated vulnerabilities:** none in the bounded no-tools S1 threat boundary.

Controls challenged included socket authentication, workspace binding, duplicate/multiple/oversized
framing, nonce replay, operation-ID reuse, cross-stream routing, origin-restricted cancellation,
credential/prompt logging, normal stale-socket cleanup, restart identity, multiple-window collision,
wrong workspace/path forms, runtime path ownership/symlink assumptions, request injection, and
prompt injection affecting authorization.

The review found and implementation immediately remediated four lifecycle weaknesses before the
final scan: operation ID reuse after history eviction, missing explicit human-operation shutdown
abort, post-listen validation cleanup, and event-sink exceptions potentially stranding lifecycle
state.

### External host trace boundary

The owner separately captured a long Copilot/VS Code trace from the launcher/source window whose
workspace was `/tmp/quarangate-spike-launch`. That trace is not evidence for the target Extension
Development Host's picker decision and is not used to claim that the QuaranGate model was filtered
there.

It does establish a distinct host-security observation: the broader VS Code/Copilot environment
performs external authentication, metadata fetching, telemetry/fetch activity, and GitHub/Copilot
initialization. This does not prove that QuaranGate prompt or repository data leaked. It does prove
that “QuaranGate provider local-only” is not equivalent to “entire VS Code host air-gapped or
offline-safe.” Production IDE-host egress qualification remains mandatory.

### Residual security and production gaps

- `0700`/`0600` plus a bearer secret does not isolate another process running as the same WSL UID or
  a hostile extension sharing the extension-host authority. This has low S1 impact because the core
  is deterministic and capability-free, but it blocks production authentication acceptance.
- The helper authenticates to the server, but S1 has no mutually authenticated server enrollment or
  signed capability binding.
- Normal shutdown cleanup and fresh restart were live-confirmed. Crash-left random runtime
  directories are not reconciled; S1 never reuses or unlinks them on startup.
- Public VS Code APIs do not supply a durable WSL-distro/IDE-window enrollment identity. Production
  needs trusted local enrollment and connection generations.
- S1 has in-memory, best-effort logs, no tamper-evident persistent audit, retention/redaction policy,
  rate policy, controller arbitration, or production credential lifecycle.
- A future model is untrusted output. It must never select IPC identity, workspace, operation,
  capability, tool, or writer authority.
- The local deterministic provider is an S1-only host-gate shim, not a production model or routing
  policy. Production provider/model policy remains unresolved.
- Production data-leakage qualification is a later hard gate. S1 does not claim air-gap
  certification, zero risk, or full IDE-host isolation. It must include the broader host's external
  authentication, metadata, telemetry/fetch, and GitHub/Copilot activity rather than assessing only
  the QuaranGate shim.
- Any future mutation-capable prompt path must join QuaranGate's one-writer/worktree arbitration and
  requires separate owner approval. S1 cannot mutate.

## 10. CLI coexistence and future production model

S1 neither launches nor owns a terminal/CLI agent session. The companion needs only its own VS Code
workspace host and local endpoint, so the intended topology remains:

```text
logical project
├── IDE-agent worktree/sandbox — independently enrolled and controlled
└── CLI-agent worktree/sandbox — independently dispatched and controlled
```

No shared agent session and no same-worktree parallel mutation are required. Future production work
must add a QuaranGate broker binding logical project, IDE instance, WSL distro, exact worktree,
connection generation, principal, action, bounds, audit correlation, and controller/writer lease.
Provider/model enrollment and persisted consent must be a separate explicit owner action. The S1
shim requires neither and must not be silently substituted for a production provider.

## 11. Kiro S2 implications

S1 supports the feasibility of a QuaranGate-owned dual-mode participant on upstream VS Code. It does
not prove that Kiro exposes the Chat Participant contribution point, loads this extension in the
required remote host, or supports the same API behavior. It does not provide access to Kiro's
built-in agent.

Kiro S2 remains blocked pending the separately authorized Kiro upgrade and a fresh equivalent live
qualification on the exact installed build. No Kiro upgrade or S2 work was performed.

## 12. Promotion decision

| S1 property | Final result |
|---|---|
| participant registration | `PASS` |
| Remote WSL placement | `PASS` |
| public provider API | `PASS` |
| local deterministic provider registration | `PASS` |
| public model registry discovery | `PASS` |
| shared `AgentCore` | `PASS` |
| machine IPC | `PASS` |
| automated human streaming path | `PASS` |
| automated human cancellation path | `PASS` |
| operation provenance | `PASS` |
| bounded S1 data-leakage code boundary | `PASS` |
| live human participant streaming | `BLOCKED_BY_HOST_PICKER` |
| live human cancellation | `BLOCKED_BY_HOST_PICKER` |

`S1_ARCHITECTURE_FEASIBILITY=PASS_WITH_EXTERNAL_HOST_LIMITATION`.

The proposed dual-mode companion-extension architecture is technically feasible: machine IPC,
participant registration, the shared core, and supported provider registration/discovery are proven.
The current VS Code `1.136.1` normal Chat picker prevents the final human streaming and cancellation
proof. No supported public fix is established by the evidence.

This classification does not mean `PRODUCTION_READY`, `AIR_GAP_CERTIFIED`,
`FULL_UI_ACCEPTANCE_PASS`, or `HOST_SECURITY_QUALIFIED`. Production identity/authentication design,
trusted enrollment, audit, crash recovery, capability policy, writer arbitration, production
provider/model policy, and IDE-host egress/data-leakage qualification must all precede production
work. Kiro S2 remains unauthorized, and no production implementation has started.
