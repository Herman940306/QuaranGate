# P7 I3 — Cursor source implementation and external live qualification

## Status

`SOURCE_CANDIDATE_IMPLEMENTED / LIVE_DEFERRED_EXTERNAL_CURSOR_ENVIRONMENT`

This batch implements a distinct Cursor-bound QuaranGate companion path without
claiming VS Code compatibility by inheritance. The owner workstation used for
this implementation does **not** have Cursor installed and has no Cursor
account. No Cursor installation, account creation, provider activation, model
consent, or live Cursor qualification was attempted.

Final I3 live acceptance must be performed by a developer with a supported
Cursor installation in an isolated authorized environment.

## External product facts used narrowly

Cursor's current documentation states that it supports third-party extensions
through its extension ecosystem and documents Cursor-specific extension APIs
under the `vscode.cursor` namespace. These facts justify a bounded extension
compatibility implementation; they do **not** establish Chat Participant,
Language Model, consent, Remote-WSL, or session-behavior parity with VS Code.

References:

- https://cursor.com/help/customization/extensions
- https://cursor.com/docs/extension-api

No private Cursor Composer/Agent protocol or UI automation is used.

## Source architecture

### Distinct product identity

Cursor uses the already-reserved common product identifier `cursor` and the
accepted runtime adapter identifier `quarangate-cursor-companion`.

The trusted IDE enrollment schema now accepts exactly `vscode` or `cursor`.
Kiro/Visual Studio/Antigravity are not silently enabled by this change.
Review-only capabilities remain exact and unchanged.

### B4 credential binding

`cursorCompanionCredential.ts` independently validates:

- owner-only canonical runtime directory;
- exact `credential.json` path;
- 0700 directory / 0600 credential semantics;
- canonical runtime JSON;
- exact `ideProduct=cursor`;
- exact `adapterId=quarangate-cursor-companion`;
- exact adapter version;
- exact runtime/enrollment/IDE instance identity;
- exact QuaranGate-derived socket path;
- revoked credential rejection.

A VS Code credential cannot be consumed as a Cursor credential.

### B5 workspace identity

`cursorWorkspaceCollector.ts` performs a fresh mechanical Remote-WSL workspace
collection using the same accepted physical security properties as I2 without
reusing VS Code product identity:

- exactly one workspace folder;
- WSL workspace extension host;
- canonical POSIX file URI/path equivalence;
- realpath exactness and filesystem identity;
- qualified case-sensitive filesystem;
- WSL machine/environment identity;
- Git common-dir/worktree identity and exact HEAD revision;
- no shell command or caller-selected project/worktree authority.

### B6 authenticated session

`cursorCompanionConnection.ts` performs the accepted hello/challenge/attest/
ready protocol with `ideProduct=cursor` and the Cursor adapter identity.

### Command/event transport

`cursorCommandChannel.ts` implements the accepted bounded QuaranGate-origin
transport for a Cursor-authenticated companion. It preserves fresh credential
reads, fresh workspace re-attestation, B3 authenticated envelopes, bounded
ordered events, exact cancellation, disconnect fail-closed behavior and B7/B8/
B9 authority ownership on the QuaranGate side.

This source does not grant Cursor arbitrary command, terminal, filesystem,
Docker, MCP, UI-automation or private vendor authority.

### Runtime compatibility classification

`cursorCompatibility.ts` keeps three questions separate:

1. Is this exact host attributable to Cursor?
2. Is the extension in the required WSL workspace placement?
3. Are optional Chat Participant / Language Model public APIs actually present?

Product identity requires all of:

- `appName === "Cursor"`;
- `uriScheme === "cursor"`;
- direct observation of the Cursor-specific `vscode.cursor` namespace.

Chat/LM absence or uncertainty does not become PASS. First-class review API
readiness requires direct observation of both public API families.

### Minimal extension entrypoint

`extensions/quarangate-cursor` is a workspace extension that:

- activates on startup;
- observes product/placement/API capability facts;
- reads only one owner-provisioned machine-scoped Cursor runtime credential
  path;
- opens B6 only after exact product/placement classification;
- establishes the authenticated B5/B6 command/event channel;
- contains no command execution, terminal, workspace-write, tool, shell, child
  process or UI automation surface;
- does not invoke Cursor Chat/LM APIs merely because similarly named VS Code
  APIs exist.

The manifest minimum engine is `^1.105.0`; the source entrypoint intentionally
uses only long-standing extension environment/workspace APIs plus defensive
runtime feature probes. The development type package remains repository-pinned
at 1.109.0. Live Cursor compatibility must still be proven against the exact
installed Cursor/Code-OSS version.

## Deterministic qualification harness

I3 adds:

- `scripts/cursor-qualification-evidence.mjs`
- `scripts/cursor-remote-wsl-qualification.mjs`
- `tests/fixtures/cursor-qualification/**`
- `tests/integration/p7-i3-cursor-qualification.test.ts`

The harness preserves PASS/FAIL/BLOCKED/NOT_SUPPORTED/NOT_RUN distinctions,
bounds/redacts evidence, requires clean source identity, and records separate
Cursor product, placement, Chat API and model API observations.

## Required external live qualification

The developer performing final I3 qualification must use a disposable,
authorized WSL Git workspace and record exact immutable evidence for:

1. Cursor installer/source provenance, exact version and executable hash.
2. Cursor Code-OSS/extension-host version and Node runtime identity.
3. Exact Cursor WSL/remote extension identity and version.
4. QuaranGate Cursor extension source/VSIX identity and hash.
5. `appName`, URI scheme and direct `vscode.cursor` API presence.
6. Workspace-extension placement in WSL.
7. B4 credential owner/mode/runtime binding.
8. B6 authenticated Cursor session and generation.
9. B5 canonical workspace/worktree identity and Git revision.
10. A-to-B workspace drift denial before handler/model execution.
11. Reconnect with generation advance and stale generation rejection.
12. Disconnect fail-closed behavior and no false completion.
13. Bounded transport/backpressure behavior.
14. Isolated executor restart/recovery and fresh reconnect.
15. Whether `chat.createChatParticipant` is actually present/supported in that
    exact Cursor build.
16. Whether `lm.selectChatModels` plus access-information APIs are actually
    present/supported in that exact Cursor build.
17. Model entitlement/consent separately, without purchase or surprise consent.
18. If the public Chat/LM APIs are supported and explicitly consented: governed
    read-only review, exact operation identity, bounded output, cancellation and
    zero workspace mutation.
19. Exact restoration/cleanup of developer settings/runtime state.

If Chat/LM public APIs are absent, classify them `NOT_SUPPORTED`; do not use a
private Cursor Agent/Composer protocol, generic MCP bridge, shell, clipboard or
UI automation as a fallback.

## Current owner-environment classification

`CURSOR_INSTALLED: NO`

`CURSOR_ACCOUNT_AVAILABLE: NO`

`LIVE_CURSOR_EXTENSION_PLACEMENT: DEFERRED_EXTERNAL_CURSOR_ENVIRONMENT`

`LIVE_CURSOR_B6_B5: DEFERRED_EXTERNAL_CURSOR_ENVIRONMENT`

`LIVE_CURSOR_CHAT_API: DEFERRED_EXTERNAL_CURSOR_ENVIRONMENT`

`LIVE_CURSOR_MODEL_API: DEFERRED_EXTERNAL_CURSOR_ENVIRONMENT`

`LIVE_CURSOR_REVIEW/CANCEL: DEFERRED_EXTERNAL_CURSOR_ENVIRONMENT`

This is an environment/ownership limitation, not source evidence of failure.
