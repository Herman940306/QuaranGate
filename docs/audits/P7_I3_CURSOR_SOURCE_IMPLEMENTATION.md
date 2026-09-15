# P7 I3 — Cursor source implementation and external live qualification

## Status

`SOURCE_CANDIDATE_IMPLEMENTED / SELF_AUDIT_REMEDIATED / LIVE_BLOCKED_EXTERNAL_CURSOR_ENVIRONMENT`

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

## Forensic self-audit remediation

The writer performed a strict red-team self-audit before freezing this lane. This is **not** an independent review. The audit attempted to falsify product identity, authority, qualification and recovery claims rather than trusting the original candidate report.

The audit found and remediated six concrete issues:

1. A known non-Cursor host could be classified `UNKNOWN` when the Cursor-specific namespace probe was unavailable. Product identity now returns `NOT_SUPPORTED` whenever `appName` / URI-scheme identity is definitively non-Cursor; `UNKNOWN` is reserved for an otherwise exact Cursor host whose namespace availability cannot be observed.
2. Qualification evidence always recorded `liveQualificationExecuted=false`, even when a live runtime probe was supplied. It now records whether live runtime observations were actually supplied.
3. The required isolated-executor restart/recovery scenario existed in this document but had no evidence step. `restart.recovery` is now explicit and can PASS only when enrollment/runtime recovery, stale prior authority, conservative active-operation handling, fresh generation and no duplicate enrollment are all proven.
4. Review/cancellation evidence could be internally contradictory. A review or cancellation PASS now additionally requires the observed Cursor product/placement, B4, B6, B5, public Chat/LM API and ready model-access prerequisite chain. Claims that contradict unsupported/missing prerequisites fail instead of being promoted.
5. The original document stated that no Cursor account was available without evidence. Account/entitlement status is now correctly `NOT_PROVEN`; local installation absence is reported only from the bounded host inspection actually performed.
6. Cursor-specific source/tests retained stale I2 phase labels from the accepted security-mechanics template. Those labels were corrected to I3 so the final source does not obscure phase ownership.

A production-composition regression was also added proving that a trusted `ideProduct=cursor` enrollment provisions the distinct `quarangate-cursor-companion` runtime while preserving review-only startup authority (no operation adapter, writer store or implementation adapter).

### Self-audit validation receipts

After remediation:

- focused I3/runtime corpus: `96/96 PASS` across 10 files before the final contradictory-evidence regression;
- full unit corpus: `2653/2653 PASS` across 98 files;
- I2 + I3 qualification regression at that gate: `40/40 PASS`;
- root TypeScript typecheck: `PASS`;
- root build: `PASS`;
- Cursor extension typecheck/build: `PASS`;
- `git diff --check`: `PASS`.

The final immutable-candidate receipts must be regenerated after this remediation is committed; these intermediate counts are evidence of the audit cycle, not the immutable final receipt.

## Current owner-environment classification

Bounded owner-host inspection job: `ohj_570ed94dce80cfdfcf263f8953d18d0f`.

Observed:

- common Windows Cursor executable locations checked: no file found;
- WSL `cursor` CLI: absent;
- `~/.cursor`: absent;
- `~/.cursor-server`: absent.

Therefore:

`CURSOR_INSTALLATION: NOT_FOUND_BOUNDED_HOST_CHECK`

`CURSOR_ACCOUNT_OR_ENTITLEMENT: NOT_PROVEN`

`LIVE_CURSOR_EXTENSION_PLACEMENT: BLOCKED_EXTERNAL_CURSOR_ENVIRONMENT`

`LIVE_CURSOR_B6_B5: BLOCKED_EXTERNAL_CURSOR_ENVIRONMENT`

`LIVE_CURSOR_CHAT_API: BLOCKED_EXTERNAL_CURSOR_ENVIRONMENT`

`LIVE_CURSOR_MODEL_API: BLOCKED_EXTERNAL_CURSOR_ENVIRONMENT`

`LIVE_CURSOR_REVIEW/CANCEL: BLOCKED_EXTERNAL_CURSOR_ENVIRONMENT`

No network acquisition or installation was authorized or attempted. This is an external environment prerequisite limitation, not source evidence of failure.
