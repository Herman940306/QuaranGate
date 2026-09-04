# QuaranGate IDE Chat Spike

> **SPIKE ONLY — NOT PRODUCTION — NO MUTATION AUTHORITY**

This isolated VS Code extension proves the transport and control shape for a QuaranGate-owned Chat
Participant and an authenticated local machine client sharing one internal `AgentCore`. It does not
control another vendor's participant, fabricate VS Code chat objects, automate Chat UI, call a real
language model, connect to production QuaranGate, or expose file, shell, Git, Docker, MCP,
external-network, or workspace-mutation capabilities. One deterministic local non-inference
Language Model Chat Provider shim exists only to satisfy VS Code's pre-handler model-resolution
gate. It is not the `AgentCore` and is not a production routing design.

## Architecture

```text
VS Code Chat model resolution
  -> QuaranGate Spike Transport Model (local inert shim)
  -> real @quarangate-spike ChatRequestHandler
     -> shared AgentCore -> deterministic streamed response

authenticated machine NDJSON over Unix socket
  -> shared AgentCore -> deterministic streamed response
```

The provider publishes one fixed model through `contributes.languageModelChatProviders` and
`vscode.lm.registerLanguageModelChatProvider`. If VS Code directly invokes its response method, it
does not inspect the opaque message array and returns one fixed bounded text part. It performs no
inference, account lookup, credential read, workspace access, persistence, telemetry, provider
fallback, or external network operation. VS Code may deliver an opaque in-process request argument
as part of the public API contract; the shim neither reads its content nor forwards it anywhere.

The extension is declared as `extensionKind: ["workspace"]` and fails activation unless it is in a
VS Code Remote WSL workspace extension host with exactly one `file:` workspace folder. The folder is
resolved with `realpath`; machine frames must contain the exact canonical file URI.

The runtime endpoint is created outside the repository in a fresh directory named
`<tmp>/qg-ide-chat-<uid>-<random>/`. The directory is mode `0700`; the socket and credential file are
mode `0600`. The credential contains a fresh 256-bit secret and is removed on normal extension
shutdown. Multiple windows receive independent paths and secrets.

## Build and automated validation

Requirements: Node.js 22 or newer and npm.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

The socket tests require permission to create Unix-domain sockets. A sandbox that denies local bind
operations will report `listen EPERM`; rerun only in an authorized local environment.

## Live VS Code Remote WSL acceptance

### S1 closeout status

The owner completed the bounded public-registry diagnostic in the actual Remote WSL Extension
Development Host on VS Code `1.136.1`. The public registry returned exactly the registered
`QuaranGate Spike Transport Model`, proving that the provider registration is alive and discoverable
through the supported API. The enabled model is visible under **Language Models**, but remains absent
from the normal Ask picker. Plan mode also omits it because the shim truthfully advertises no tool
calling. Consequently, live human streaming and cancellation remain blocked by a host picker
limitation or defect; they are not recorded as passes.

The temporary D2 registry-probe command, source, and tests were removed after capture. The provider
shim and its regression/security tests remain. The detailed evidence and final classification are in
`../../docs/IDE_CHAT_VSCODE_S1.md`.

Build first, then from a WSL shell run:

```bash
code --new-window \
  --extensionDevelopmentPath=/home/herman/projects/quarangate-ide-session/extensions/quarangate-ide-chat-spike \
  /home/herman/projects/quarangate-ide-session
```

In the Extension Development Host:

1. Run `QuaranGate IDE Chat Spike: Show Attestation and IPC Status` from the Command Palette.
2. Confirm the output says `remoteName: "wsl"`, `extensionHostKind: "workspace"`, and identifies
   `/home/herman/projects/quarangate-ide-session`. Copy only the `credentialPath`; never copy or print
   the credential contents.
3. Confirm `QuaranGate Spike Transport Model` remains enabled under **Language Models**. Do not
   configure a cloud, Copilot, GitHub login, credential, or other provider for the shim.
4. Record whether the normal Ask picker exposes the model. On the qualified VS Code `1.136.1` host
   it did not; do not claim participant streaming or cancellation unless the host later exposes the
   model and a new owner-authorized acceptance run proves those behaviors.
5. From a WSL shell, run the helper with the displayed credential path:

   ```bash
   node dist/src/helper.js --credential /tmp/qg-ide-chat-UID-INSTANCE/credential.json \
     run --prompt "machine transport proof"
   ```

6. Run the bounded negative/cancellation probe:

   ```bash
   npm run live-probe -- /tmp/qg-ide-chat-UID-INSTANCE/credential.json
   ```

   It succeeds only when the run ends `cancelled`, the cancel is `accepted`, a bad secret returns
   `AUTH_DENIED`, a wrong workspace returns `WORKSPACE_MISMATCH`, and a repeated cancel is `stale`.
7. Close the Extension Development Host and confirm its exact runtime directory no longer exists.
8. Reopen it and confirm the `instanceId`, runtime directory, socket, credential path, and secret are
   fresh. Do not print the secret.

No UI automation is part of this acceptance.

## Machine request protocol

Each connection sends exactly one UTF-8 JSON object followed by `\n`. The maximum request frame is
16 KiB. Run frames have exactly:

```json
{
  "type": "run",
  "version": 1,
  "operationId": "UUID",
  "nonce": "32-to-128-character-base64url",
  "workspace": "exact-canonical-file-URI",
  "prompt": "at-most-4096-UTF-8-bytes",
  "secret": "runtime-secret"
}
```

Cancel frames omit `prompt` and set `type` to `cancel`. Unknown, missing, duplicate, wrongly typed,
or oversized fields fail closed. Authentication, exact workspace matching, and nonce claiming occur
before operation creation or cancellation. Nonces and operation IDs remain reserved for the runtime
lifetime; bounded capacity fails closed and requires a restart. Server events are newline-framed and
carry version, operation ID, origin, sequence, type, and deterministic chunk text where applicable.

## Security boundary and production gaps

S1 authentication separates OS users, accidental clients, and clients without the random secret.
It does not isolate hostile processes running as the same WSL user or hostile extensions sharing the
extension-host authority; those actors can potentially read the owner-only credential. Production
requires enrolled identities and scoped, short-lived capabilities rather than this runtime file.

Other production gaps include mutual server identity for helpers, crash-stale directory
reconciliation, durable IDE/WSL-distro/window enrollment, credential rotation and revocation,
controller policy, persistent tamper-evident audit, rate limits, stronger connection admission,
protocol negotiation, retention policy, writer arbitration, capability authorization, and a
separately approved production model/provider policy. The deterministic shim does not resolve any
production provider/model decision and must not be promoted as one.

## File inventory

Every repository file created for this spike is recorded below. `dist/`, `node_modules/`, and VSIX
files are generated/ignored and are not owned source files.

| Path | Purpose | Key exports | Owning route or feature | Owned state | API or mock dependency | Future backend expectation | Status |
|---|---|---|---|---|---|---|---|
| `.gitignore` | Excludes local build/install artifacts | none | package hygiene | none | Git ignore syntax | production packaging policy may differ | spike-ready |
| `.vscodeignore` | Excludes source/tests/maps from a future VSIX | none | extension packaging | none | VS Code packaging rules | review published artifact contents before promotion | scaffold-only |
| `package.json` | Extension manifest, participant/provider/command contributions, scripts, pinned dependencies | extension entrypoint declaration | package, Chat Participant, and local provider shim | manifest metadata | public VS Code contribution points, npm | production needs approved publisher/version/capabilities | spike-ready |
| `package-lock.json` | Reproducible dependency resolution and integrity | none | package installation | locked dependency graph | npm registry metadata | refresh only through an approved dependency review | spike-ready |
| `tsconfig.json` | Strict CommonJS TypeScript build | none | build | compiler policy | TypeScript | align to approved extension-host Node baseline | spike-ready |
| `README.md` | Scope, architecture, manual acceptance, protocol, gaps, and complete file inventory | none | whole spike | documentation only | repository evidence | replace with production operator/developer docs if promoted | spike-ready |
| `src/audit.ts` | Minimal secret-free operation audit contract and test logger | `AuditLogger`, `AuditRecord`, `MemoryAuditLogger` | shared core audit | in-memory test entries | none | durable tamper-evident audit sink required | spike-ready |
| `src/client.ts` | Reads a runtime credential and exchanges bounded NDJSON frames | `readCredential`, `createNonce`, `sendMachineRequest` | machine helper/probe | response buffer per connection | Node `fs`, `net`, `crypto` | mutual endpoint identity and capability enrollment required | spike-ready |
| `src/core.ts` | Shared deterministic streamed operation lifecycle | `AgentCore`, `OperationEvent`, `OperationHandle`, `CoreError` | human and machine paths | active operations, bounded history, used IDs, abort controllers | Node `crypto`, injected delay | future agent/model backend must retain bounds and never infer authority from output | spike-ready |
| `src/extension.ts` | Activation, participant adapter, provider registration, status command, IPC lifecycle | `activate`, `deactivate` | VS Code human path and extension lifecycle | one active core/server/runtime | public VS Code Chat, LM provider registration, command, output APIs | future enrollment/model integration needs separate approval | spike-ready |
| `src/human.ts` | Testable human participant-to-core adapter with exact cancellation binding | `HumanCancellationToken`, `HumanOperationResult`, `runHumanOperation` | human participant path | one operation handle and cancellation subscription per invocation | shared `AgentCore`; public-token-compatible structural contract | preserve exact operation ownership when production policy is added | spike-ready |
| `src/helper.ts` | User-operated machine run/cancel CLI | executable `main` | machine path | command arguments and returned frames | `src/client.ts` | replace or wrap with authenticated QuaranGate broker client | spike-ready |
| `src/ipc.ts` | Authenticated bounded Unix-socket server | `MachineIpcServer`, `ServerFrame` | machine path | sockets, nonce registry, server lifecycle | Node `net`, `crypto`; shared core | production protocol needs identities, grants, rate policy, and version negotiation | spike-ready |
| `src/liveProbe.ts` | Bounded negative and cancellation checks against a live extension | executable `main` | live machine acceptance | temporary operation IDs/promises | `src/client.ts` | test-only; not a production client | spike-ready |
| `src/protocol.ts` | Strict request parser, bounds, IDs, duplicate-key and workspace checks | request types, constants, assertions, `parseMachineFrame` | machine protocol | none | Node `Buffer` | evolve only through versioned schema review | spike-ready |
| `src/provider.ts` | Inert deterministic local provider shim and public registration seam | provider identity constants, `SPIKE_MODEL_INFORMATION`, `DeterministicLocalChatProvider`, `registerDeterministicLocalProvider` | VS Code pre-handler model resolution only | none | public VS Code LM provider types; injected text-part constructor | remove or separately redesign after production provider/model policy approval | feature-gated S1 spike only |
| `src/runtime.ts` | Owner-only runtime paths, credential write, socket checks, cleanup | runtime types and lifecycle helpers | IPC runtime material | random instance path and secret returned to caller | Node `fs`, `os`, `path`, `crypto` | replace minimal secret lifecycle and add safe crash reconciliation | spike-ready |
| `src/workspace.ts` | Supported-API WSL workspace attestation | `WorkspaceAttestation`, `attestWorkspace` | extension activation/workspace binding | none | VS Code workspace/env/extension/URI APIs; Node `realpath` | bind to trusted logical project, IDE instance, distro, and generation | spike-ready |
| `test/core.test.ts` | Streaming, terminal state, cancellation, isolation, collision, shutdown, log omission | Node tests | shared core | test-local cores/loggers | Node test runner | retain as contract tests | spike-ready |
| `test/human.test.ts` | Human-adapter/core sharing, ordered stream, exact cancellation, model-independent input, provenance isolation | Node tests | human participant path | test-local cancellation listeners and cores | Node test runner; `src/human.ts` | replace structural token fixture only if public API contract changes | spike-ready |
| `test/ipc.test.ts` | Real Unix-socket auth, replay, workspace, streaming, cancel, isolation, log omission | Node tests | machine path | disposable `/tmp` runtimes | Node test runner and local IPC | expand with production broker/enrollment tests | spike-ready |
| `test/protocol.test.ts` | Exact schema, duplicate, size, nonce, ID, type, and workspace rejection | Node tests | protocol | none | Node test runner | retain and add version migration fixtures | spike-ready |
| `test/provider.test.ts` | Public registration seam, identity, bounded inert output, opaque-message noninspection, manifest and forbidden-capability checks | Node tests | deterministic provider shim | test-local fake registrar and output array | Node test runner; source/manifest read by tests only | delete with shim or retain as a hard boundary if explicitly promoted | feature-gated S1 spike only |
| `test/runtime.test.ts` | Permission, path-length, cleanup, and fresh-identity checks | Node tests | runtime security | disposable `/tmp` directories | Node test runner and filesystem | add crash/symlink/race reconciliation tests before promotion | spike-ready |
