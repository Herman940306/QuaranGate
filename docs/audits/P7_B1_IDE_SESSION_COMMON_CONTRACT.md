# P7 B1 — IDE Session Common Contract Foundation

Status: **SOURCE FOUNDATION / NOT A LIVE IDE RUNTIME**

## Scope

P7 B1 implements the backend-neutral I0 contract required before any production IDE adapter is exposed through QuaranGate. It deliberately adds no MCP tool, IDE listener, provider/model call, host-path input, credential, enrollment store, Docker authority, network authority, or mutation path.

Implemented source:

- `src/shared/ideSessions.ts` — closed IDE/product/capability vocabulary, opaque logical identities, connection generations, session/operation state machines, exact full-tuple binding checks, controller-lease/session-state enforcement, writer-lease requirement for implementation capability, normalized event envelopes, monotonic event sequencing and exactly-one-terminal enforcement.
- `tests/unit/ide-session-contract.test.ts` — deterministic negative/positive contract coverage.

The initial review capability set is exactly `prompt`, `cancel`, `observe_response`, and `request_review`. `read_bounded_editor_context` remains a separate explicit opt-in. `request_implementation` is not part of the base review grant and cannot pass the common authority check without an acquired writer lease.

## Security boundary frozen by B1

The common contract binds logical authority to:

`principal -> project -> worktree -> workspace fingerprint/base revision -> IDE product/instance -> session -> connection generation -> controller/session state -> capability -> writer lease when required`

The common module accepts no canonical host path, socket path, command ID, argv, shell text, arbitrary tool name, provider endpoint, model name, Docker option, secret, or credential. Exact host/workspace attestation and enrollment remain trusted adapter/executor responsibilities for later P7 batches.

Machine start-turn authority requires an acquired controller in `CONTROLLER_ACQUIRED`; cancel/observe/context authority requires that controller in `OPERATION_ACTIVE`; implementation additionally requires an acquired writer lease. A disconnected or stale session generation is terminal. Reconnect must therefore create a new generation instead of reviving an old handle. Operation outcomes preserve `DISCONNECTED` and `INDETERMINATE` as terminal states distinct from success. Event streams bind operation/session/generation, start at sequence 0 with `operation_started`, increase monotonically, and reject every event after the first terminal event.

## Evidence boundary

The preserved S1 feasibility package at `extensions/quarangate-ide-chat-spike/` was inspected before implementation. Its source remains unchanged. Package-level typecheck could not be re-run in the forward worktree because that isolated spike's local development dependencies are not installed; the failure was missing `vscode` type declarations, not a protocol/core test failure. B1 therefore does not modify or re-certify S1.

B1 uses only the already-qualified root QuaranGate dependency/test environment. It does not claim VS Code, Kiro, Cursor, Visual Studio or Antigravity live compatibility. Vendor adapters, authenticated enrollment/MAC transport, persistent audit, controller arbitration, trusted worktree attestation, provider/model consent and live qualification remain subsequent P7 gates.

## P7 continuation

Next production work should consume this contract from a trusted IDE enrollment/adapter registry and preserve the existing 45-tool public MCP surface until authorization and lifecycle storage are independently hardened. VS Code remains the first companion qualification target; Kiro/Cursor compatibility must be established independently and must not use private built-in-chat/session interfaces.
