# Kiro IDE / Kiro CLI Session Control — I1R1 Reconciled Feasibility

**Status:** I1R1 owner-objective reconciliation; design/research only; no runtime implementation

**Research date:** 2026-09-03

**Scope:** Kiro IDE and Kiro CLI/ACP capability boundaries; Lane B only

**Repository baseline:** `1977290c07a140aad111a6cbc9bbc970f5bfec6f`

## 1. Evidence vocabulary

Material claims use these classifications:

- **OFFICIAL_DOCUMENTED** — stated in current official Kiro, ACP, or VS Code documentation.
- **LOCAL_CONFIRMED** — observed from installed binaries, manifests, or repository evidence without a
  provider inference call.
- **EXPERIMENTALLY_CONFIRMED** — exercised against the exact installed binary, including retained
  repository acceptance evidence whose binary hashes still match.
- **INFERRED** — a conclusion from documented or observed facts, not a supported API guarantee.
- **NOT_FOUND** — no supported public contract was found in the reviewed official sources.
- **PROPOSED** — future QuaranGate behavior, not implemented by this document.
- **UNSUPPORTED_PRIVATE_SURFACE** — observable internals that are not a supported integration contract.

## 2. Revised purpose and authoritative owner objective

I1 originally optimized for QuaranGate concurrently controlling the exact local Kiro agent session
that remained active in Kiro IDE. The owner has clarified that this is not required.

The revised requirement is:

> QuaranGate governs an explicitly selected supported agent surface against an explicitly authorized
> project/worktree while Herman uses an approved IDE/editor surface.

The editor and governed agent surface may be separate products. Supported rotational/composable
examples include Kiro IDE + Claude CLI, Kiro IDE + Copilot CLI, and VS Code + Kiro CLI. This preserves:

```text
many readers
many isolated workers
one controlled live writer per project/worktree
```

Where a provider requires single session ownership, only one process/controller owns that provider
session at a time. QuaranGate must not invent synchronization that lets controllers compete for one
vendor session.

## 3. Reconciled authority model

For a governed agent operation, authorization remains exact:

```text
authenticated principal
  -> logical project + exact worktree
  -> selected agent surface/backend
  -> agent session, where applicable
  -> permitted action/profile
```

The editor is the human development UI. It is not automatically an authority principal merely
because it displays the authorized workspace. A future direct-IDE agent adapter would require its
own enrolled IDE/session binding, but an independent CLI/ACP worker does not inherit that requirement.

For ordinary Kiro CLI/ACP use:

```text
editor:       human-facing workspace view
Kiro CLI ACP: machine-facing governed worker
QuaranGate:   principal/project/backend/profile authorization, sandbox, evidence, diff, apply gate
```

The CLI session is bound to the authorized project/worktree through trusted QuaranGate project
configuration and sandbox materialization, not through the editor window, title, or chat session.

## 4. Exact baseline and installed versions

| Check | Exact observation | Classification |
|---|---|---|
| repository | `/home/herman/projects/quarangate-ide-session` | LOCAL_CONFIRMED |
| branch | `design/ide-session-control` | LOCAL_CONFIRMED |
| HEAD | `1977290c07a140aad111a6cbc9bbc970f5bfec6f` | LOCAL_CONFIRMED |
| Kiro CLI | `/home/herman/.local/bin/kiro-cli`; `kiro-cli 2.5.0` | LOCAL_CONFIRMED |
| Kiro CLI SHA-256 | `0f0e2b8b25a0dae019239b340ce3601e29dd2ea0e63b35f1e685c8d08265c4de` | LOCAL_CONFIRMED |
| `kiro-cli-chat` SHA-256 | `b2142a355add88b1d234ef405a226781aea5719e841c77c0b15ee1abcb2804fc` | LOCAL_CONFIRMED |
| Kiro IDE/WSL server | `1.0.212`, commit `8848ae36c236474760fa07ffaa4358ee3889253a`, `x64` | LOCAL_CONFIRMED |
| bundled remote Kiro agent extension | installed manifest version `1.0.369` | LOCAL_CONFIRMED from I1 evidence |

The installed IDE and CLI versions are older than the current documentation reviewed on the
research date. Any future adapter must pin and qualify its exact negotiated ACP profile rather than
blend current documentation with installed 2.5.0 event shapes.

## 5. Preserved I1 factual findings

Primary official sources:

- [How Kiro works](https://kiro.dev/docs/how-kiro-works/)
- [Kiro CLI ACP](https://kiro.dev/docs/cli/acp/)
- [CLI session management](https://kiro.dev/docs/cli/chat/session-management/)
- [Agent Focus Mode](https://kiro.dev/docs/ide/experimental/focus-mode/)
- [Kiro permissions](https://kiro.dev/docs/cli/chat/permissions/)
- [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [VS Code remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions)

| Finding | Classification | Preserved conclusion |
|---|---|---|
| shared Kiro harness architecture | OFFICIAL_DOCUMENTED | Kiro clients use a common agent harness/protocol architecture; this does not imply shared live-process ownership. |
| ACP availability | OFFICIAL_DOCUMENTED + LOCAL_CONFIRMED | `kiro-cli acp` exposes a supported JSON-RPC-over-stdio agent surface. |
| ACP lifecycle | OFFICIAL_DOCUMENTED | `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, mode/model selection, and streamed updates are documented. |
| exact installed ACP behavior | EXPERIMENTALLY_CONFIRMED | Retained A4 evidence for the matching 2.5.0 hashes confirms initialization, new session, prompt, streamed updates, and cancellation. |
| session persistence | OFFICIAL_DOCUMENTED | CLI sessions persist and can be loaded/resumed according to supported Kiro semantics. Storage is not an authorization surface. |
| single-process session ownership | OFFICIAL_DOCUMENTED | A local session may be active in only one process; concurrent resume is rejected to prevent corruption. |
| IDE-to-CLI handoff | OFFICIAL_DOCUMENTED | Current Kiro documents a sequential **Open with Kiro CLI** continuation flow. |
| concurrent control of one active IDE-owned local session | NOT_FOUND | No supported concurrent attach or takeover contract was found. |
| supported Kiro agent API for third-party extensions | NOT_FOUND | Generic extension compatibility does not expose Kiro chat prompt/stream/cancel APIs. |
| direct attach to an IDE-spawned harness | NOT_FOUND | Local stdio is a spawned parent/child transport, not a documented discovery endpoint. |

The installed 2.5.0 binary's retained event shapes differ from the current documentation. A future
adapter must strictly parse only a pinned, negotiated, tested version profile.

## 6. Single-owner session semantics

**OFFICIAL_DOCUMENTED:** Kiro reports `Session is active in another process` when another process
owns a local session. The supported responses are to close the existing owner and resume, or to
export/load a separate fork. Sessions are scoped per directory and local sessions do not synchronize
across machines.

Therefore:

- a Kiro IDE session and a Kiro CLI ACP session may be distinct governed sessions;
- QuaranGate must not attempt to load, steal, copy, or manipulate a session owned by the IDE;
- one ACP process/controller owns a governed Kiro CLI session at a time;
- an `active elsewhere` response is a session-specific denial, not a product-wide failure;
- sequential IDE-to-CLI continuity remains supported vendor behavior where the installed version
  provides it, but it is not required for ordinary QuaranGate use.

## 7. Revised classification

The inability to concurrently control the same local Kiro session while it remains active in Kiro
IDE is a **SUPPORTED PRODUCT CONSTRAINT / CURRENT NON-GOAL**.

It is **not a blocker to the overall QuaranGate North Star** because Kiro CLI/ACP can be treated as
its own governed agent surface with its own session. The Kiro IDE agent session and Kiro CLI session
do not need to be the same conversation or share live ownership.

No companion extension is required solely to bridge Kiro IDE chat into Kiro CLI. No explicit
IDE-to-CLI session transfer is required for ordinary dispatch. Session handoff may remain an optional
future continuity feature and must use supported, single-owner semantics if pursued.

## 8. Supported ordinary architecture

```text
approved human editor (Kiro IDE, VS Code, or another supported editor)
  displays the authorized project/worktree

approved MCP client
  -> QuaranGate authenticates principal
  -> authorizes logical project + backend=Kiro + profile
  -> starts Kiro CLI ACP as a distinct governed worker
  -> gives the worker only the isolated sandbox/context
  -> captures result, exact diff, and evidence
  -> explicit authorized apply is the only normal crossing into the real worktree
```

The editor does not proxy Kiro traffic and does not need access to the Kiro CLI session. QuaranGate
must continue using logical project identifiers and trusted executor-side path mappings; caller- or
editor-supplied paths are not authority.

## 9. Controls retained because they address real risk

- exact principal -> project/worktree -> backend -> session where applicable -> action/profile binding;
- strict ACP schema/version negotiation and bounded messages/events;
- one in-flight prompt per governed ACP session;
- one owning ACP process/controller per Kiro session;
- many isolated workers, with no shared writable sandbox;
- project/worktree live-writer arbitration at apply or any exceptional direct-write boundary;
- sandbox-first execution, independently constructed evidence/diff, and explicit apply;
- provider credential isolation, least-privilege Kiro permissions, constrained network, resource
  bounds, cancellation, terminal-state proof, and fail-closed recovery;
- no prompt or model statement as an authorization decision.

## 10. Controls not required for ordinary independent CLI sessions

Unless a future direct-IDE adapter technically needs them, I1R1 does not require:

- controller leases between a human IDE and a separate Kiro CLI session;
- IDE connection generations for an independent CLI worker;
- a companion extension;
- IDE chat interception or mirroring;
- private Kiro APIs, undocumented extension commands, or session-file manipulation;
- GUI, keyboard, clipboard, accessibility-tree, focus, or pixel automation;
- automatic IDE-to-CLI handoff, prompt merging, or shared conversation state.

An operation/session state machine, bounded cancellation, and project writer admission remain needed
inside QuaranGate because those controls address actual worker concurrency and failure.

## 11. Kiro permissions, cancellation, and recovery

**OFFICIAL_DOCUMENTED:** Kiro has capability-based permissions with deny/ask/allow effects and
deny-overrides evaluation. The governed profile should allow only the sandbox-relative filesystem
and exact validation tools required for the selected profile. It must not use blanket trust merely
for convenience.

**OFFICIAL_DOCUMENTED + EXPERIMENTALLY_CONFIRMED:** ACP exposes `session/cancel`; for the installed
2.5.0 evidence it is a notification targeting the session's current operation. Cancel send alone is
not terminal proof.

**PROPOSED:** QuaranGate serializes prompts per session, maps the active operation to that session,
does not automatically resend after disconnect, and treats an uncertain operation as indeterminate
until a terminal response/event or owned-process termination is confirmed. A compatible persisted
session may be reloaded only after its old owner is known to have released it and its project binding
still matches. Session content or a session UUID never grants authority.

## 12. Security boundary

Kiro CLI receives only the job sandbox, a dedicated automation credential at runner startup, its
required provider egress, bounded resources, and explicitly allowed tools. It must not receive:

- Docker authority or `docker.sock`;
- a raw host bind to the real project/worktree;
- host-global filesystem access or Herman's ordinary interactive Kiro home;
- QuaranGate gateway, MCP control-plane, or unrelated provider credentials;
- unbounded network access;
- direct authority to apply to the real worktree.

QuaranGate retains authorization, project selection, sandbox creation, evidence construction, diff,
apply authority, audit, cancellation orchestration, and failure classification. Kiro retains model
and provider interaction, agent reasoning, and its supported ACP behavior.

## 13. Optional future continuity

A future IDE-to-CLI continuity feature may be evaluated separately if Kiro exposes or preserves a
supported release/resume contract for the target versions. It must remain sequential, visible, and
single-owner. It must not become a prerequisite for independent Kiro CLI dispatch, and absence of
the feature must not trigger a private-API or GUI fallback.

## 14. Deterministic qualification plan

No provider call or active user session is required for deterministic contract tests:

1. pin CLI executable/version/hash and expected ACP schema profile;
2. fake initialize/new/load/prompt/stream/cancel and terminal completion;
3. deny malformed, oversized, unknown-version, wrong-session, duplicate, gap, and late events;
4. serialize one prompt per session and deny a second controller for the same session;
5. confirm two isolated jobs never share a writable sandbox;
6. prove logical project mapping and wrong project/worktree/backend/profile denial;
7. prove sandbox changes leave the live project unchanged before apply;
8. prove one-writer admission and stale-base/guarded-path checks at apply;
9. exercise cancel/completion races, disconnect, process exit, no replay, and indeterminate recovery;
10. prove credentials, host paths, session storage, and control-plane access are absent from worker
    inputs, mounts, output, and normal audit bodies.

## 15. Live acceptance plan

Using a disposable authorized project and dedicated automation credential:

1. record exact CLI version/hash and negotiated ACP capabilities;
2. dispatch a non-mutating Kiro ACP job against an isolated snapshot and bind its returned session;
3. prove wrong principal/project/backend/profile/session requests deny;
4. prove an independently active Kiro IDE session is irrelevant to the distinct ACP session;
5. run a bounded sandbox-write job and confirm the real worktree is unchanged;
6. retrieve result, evidence, and exact `agent_diff`;
7. exercise cancellation and confirm terminal cessation or safe indeterminate quarantine;
8. explicitly authorize `agent_apply`, prove writer admission/base-state checks, and confirm only the
   reviewed diff crosses into the disposable real worktree;
9. verify cleanup and absence of residual listeners, host binds, or leaked credentials.

## 16. Blockers and owner decisions

### Current blockers

- **No blocker to distinct Kiro CLI/ACP agent-surface use was found.** The repository already contains
  the implemented Agent Control Plane architecture; this document does not revalidate production.
- Fresh acceptance against the installed local CLI requires a dedicated authenticated disposable
  environment and a provider-backed call. That is an acceptance prerequisite, not a design blocker.
- Concurrent same-session IDE + CLI control remains unsupported, but is a current non-goal.

### Owner decisions recorded

- Rotational/composable editor and agent surfaces are accepted.
- Concurrent attachment to the exact active Kiro IDE chat is not required.
- Kiro CLI/ACP may be its own governed agent surface and its session may be distinct.
- No companion extension, automatic handoff, or shared conversation is required for ordinary use.
- Sandbox-first execution and one controlled live writer per project/worktree remain mandatory.

Open for a future implementation/operations gate: exact supported Kiro CLI upgrade/pin, automation
credential provisioning, provider egress allowlist/profile, evidence retention, and whether optional
IDE-to-CLI conversation continuity is worth pursuing.

## 17. I1R1 verdict

**SUPPORTED PRODUCT CONSTRAINT / CURRENT NON-GOAL:** Kiro does not document concurrent control of one
local session by the active IDE and a CLI/ACP process. Single-process session ownership and sequential
handoff semantics remain factual constraints.

**OVERALL NORTH-STAR VERDICT: NOT BLOCKED BY THIS LIMITATION.** A distinct Kiro CLI/ACP session is a
supported machine-facing agent surface that QuaranGate can govern against an explicitly authorized
project/worktree while Herman uses Kiro IDE, VS Code, or another approved editor. No Kiro companion
extension or GUI automation is required for that ordinary model.
