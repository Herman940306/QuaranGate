# VS Code + Kiro CLI/ACP — I2 Feasibility

**Status:** I2 feasibility/design candidate; documentation and read-only research only; no runtime implementation

**Research date:** 2026-09-03

**Scope:** VS Code as human editor with a distinct QuaranGate-governed Kiro CLI/ACP worker

**Repository baseline:** `1977290c07a140aad111a6cbc9bbc970f5bfec6f`

## 1. Evidence vocabulary

- **OFFICIAL_DOCUMENTED** — stated in current official VS Code or Kiro documentation.
- **LOCAL_CONFIRMED** — observed from local binaries, paths, manifests, or repository files without a
  provider inference call.
- **EXPERIMENTALLY_CONFIRMED** — exercised against the exact installed binary, including retained
  repository acceptance evidence whose hashes still match.
- **INFERRED** — a conclusion from documented or observed facts, not a vendor guarantee.
- **NOT_FOUND** — no supported public contract was found in reviewed official sources.
- **PROPOSED** — future implementation or acceptance behavior; not implemented by this document.

## 2. Revised purpose

I2 asks the simplest supported question:

> Can VS Code remain Herman's human-facing editor while QuaranGate governs a distinct Kiro CLI ACP
> process against an isolated copy/context of the same explicitly authorized WSL project/worktree?

It does not require QuaranGate to control VS Code chat, attach to a VS Code agent session, proxy Kiro
traffic through VS Code, or share conversation state with the editor.

**Feasibility answer: YES, subject to live acceptance of the pinned Kiro ACP runner profile.** VS Code
and Kiro CLI can operate as independent consumers of the same project identity because the normal
QuaranGate path gives Kiro a sandbox snapshot, not write access to the open real worktree. The only
normal crossing into the real worktree is separately authorized `agent_apply`.

## 3. Editor and agent-surface separation

```text
EDITOR SURFACE
VS Code Windows UI + Remote WSL workspace
purpose: human editing, inspection, source-control view, diff review

AGENT SURFACE
Kiro CLI ACP process in a governed WSL/Docker runner
purpose: machine-facing reasoning and bounded sandbox tools

CONTROL PLANE
QuaranGate in WSL/Docker
purpose: authentication, authorization, sandbox, evidence, diff, cancellation, apply
```

The surfaces may be supplied by different vendors. The editor process is not an authority principal
merely because it displays the workspace. The Kiro CLI worker is the authorized machine-facing
surface. A distinct Kiro ACP session is sufficient.

## 4. Evidence basis

Official sources reviewed:

- [Developing in WSL](https://code.visualstudio.com/docs/remote/wsl)
- [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [Supporting Remote Development](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [VS Code API](https://code.visualstudio.com/api/references/vscode-api)
- [Kiro CLI ACP](https://kiro.dev/docs/cli/acp/)
- [Kiro CLI session management](https://kiro.dev/docs/cli/chat/session-management/)
- [Kiro CLI permissions](https://kiro.dev/docs/cli/chat/permissions/)
- [Kiro CLI authentication](https://kiro.dev/docs/cli/authentication/)
- [Kiro CLI network requirements](https://kiro.dev/docs/cli/privacy-and-security/firewalls/)

Local evidence:

| Observation | Classification | Result |
|---|---|---|
| branch and HEAD match request | LOCAL_CONFIRMED | `design/ide-session-control`; `1977290c07a140aad111a6cbc9bbc970f5bfec6f` |
| VS Code launcher visible in WSL | LOCAL_CONFIRMED | `/mnt/c/Users/herma/AppData/Local/Programs/Microsoft VS Code/bin/code` |
| VS Code version query | NOT_FOUND in this qualification | launcher failed at the Windows/WSL vsock boundary in the restricted shell; no GUI or escalation was needed |
| Kiro CLI | LOCAL_CONFIRMED | `/home/herman/.local/bin/kiro-cli`; version `2.5.0` |
| Kiro CLI SHA-256 | LOCAL_CONFIRMED | `0f0e2b8b25a0dae019239b340ce3601e29dd2ea0e63b35f1e685c8d08265c4de` |
| ACP command | LOCAL_CONFIRMED | `kiro-cli acp` help exposes agent/model, selective trust, engine, and token-path options |
| exact 2.5.0 ACP lifecycle | EXPERIMENTALLY_CONFIRMED from retained repository A4 evidence | initialize, new session, prompt, streaming, and cancel were previously exercised for matching hashes |
| implemented QuaranGate Agent Control Plane design | LOCAL_CONFIRMED from repository authority/security docs | logical grants, isolated Docker-managed workspace, backend-only egress, evidence/diff, guarded explicit apply |

No provider inference call, live Kiro session, VS Code extension action, or GUI action was used.

## 5. Windows 11 / WSL topology

**OFFICIAL_DOCUMENTED:** VS Code Remote WSL uses a Windows desktop UI with a VS Code Server and
remote extension host in WSL. Local/UI and remote/workspace extension hosts are separate runtimes and
locations. Workspace extensions run where the WSL workspace resides; UI extensions run locally on
Windows. An extension API exported in one host is not automatically callable in another host.

Target placement:

```text
Windows 11
  VS Code desktop process
  local/UI extension host (Windows), if any
       |
       | vendor-managed Remote WSL channel
       v
Ubuntu-24.04 WSL
  VS Code Server + remote/workspace extension host
  real project: /home/herman/projects/<project>
  QuaranGate gateway/executor environment
       |
       | executor-managed Docker API boundary
       v
  isolated Linux runner/container
    Kiro CLI 2.5.0 ACP child process
    isolated Kiro state and automation credential
    Docker-managed sandbox snapshot mounted as its workspace
    backend-only provider egress
```

**INFERRED:** in the target topology Docker runs under or is reachable from the WSL environment; the
exact Docker Desktop versus native-engine placement is operational configuration and must be recorded
at live acceptance. It does not change the required container boundary.

Windows paths and WSL Linux paths must never be treated as interchangeable identity strings. The
trusted project mapping and canonical filesystem checks occur in the WSL/executor trust zone. The
Kiro runner receives its sandbox workspace path, not the Windows launcher path or real host root.

## 6. VS Code role and minimum integration

### Option A — no companion extension

**RECOMMENDED / SUFFICIENT.** VS Code opens the real project through Remote WSL and remains the human
editor and review surface. QuaranGate already owns the authoritative logical-project-to-worktree
mapping and the Agent Control Plane lifecycle. Kiro traffic does not traverse VS Code.

Minimum VS Code integration is therefore zero:

- no extension enrollment;
- no VS Code chat or language-model API;
- no workspace proxy;
- no editor-held control credential;
- no dependency on window focus, title, active file, or UI state.

Herman can use VS Code's existing editor, terminal, source-control, and diff views to inspect the
real project and reviewed/applicable artifacts. Those views are convenience surfaces, not security
proofs.

### Option B — small companion extension

**OPTIONAL FUTURE UX ONLY.** Official VS Code APIs can support a status-bar item, notifications,
commands, workspace-folder reporting, and secret storage. In Remote WSL, a workspace-aware extension
must be deliberately placed/tested in the remote extension host; a Windows UI half is a different
process and must not be assumed to share an API object.

A least-privilege companion could display:

- trusted QuaranGate logical project identity after authenticated comparison;
- active governed job/backend/profile;
- approval-required or cancellation state;
- a command to open a returned diff/evidence location;
- optional pre-apply warning when VS Code has dirty buffers.

It must not become an authority source, apply automatically, intercept/mirror chat, proxy arbitrary
VS Code APIs, expose a listener, or receive Kiro/QuaranGate provider credentials. It is not required
for I2 feasibility.

### Option C — deep VS Code agent integration

**NOT REQUIRED; NO MATERIAL VALUE FOUND FOR I2.** VS Code extension APIs are capable, but the target
agent surface is Kiro CLI ACP and the accepted workflow does not require VS Code chat control. Deep
integration adds another trust boundary and cross-host lifecycle without improving sandbox, evidence,
or apply authority.

**Decision:** choose Option A. Reconsider B only for demonstrated UX needs. Do not choose C for this
architecture.

## 7. Kiro CLI role

**OFFICIAL_DOCUMENTED:** Kiro CLI provides ACP over JSON-RPC/stdio. A client spawns `kiro-cli acp`,
initializes it, creates or loads a session, sends prompts, receives streamed agent/tool/turn events,
and can cancel the current operation. Kiro sessions persist; a local session is active in only one
process at a time.

Kiro owns:

- supported ACP protocol behavior;
- provider/model interaction and agent reasoning;
- execution of only the tool capabilities made available inside its runner;
- its own distinct persisted ACP session under a dedicated governed state root.

Kiro does not own project authorization, selection of the real host path, sandbox construction,
evidence truth, live-worktree writer admission, or apply authority.

## 8. QuaranGate role

QuaranGate owns and must enforce:

- authentication and exact `principal -> project/worktree -> backend -> session where applicable ->
  action/profile` authorization;
- trusted logical project mapping and base revision/state capture;
- isolated sandbox materialization and lifecycle;
- constrained Kiro runner creation, isolated Kiro state, credential injection, resource limits, and
  backend-only network policy;
- strict ACP version/schema negotiation, request/event bounds, correlation, cancellation, and
  terminal-state classification;
- independent result/evidence collection and exact `agent_diff` construction;
- guarded, explicit, separately authorized `agent_apply` with live-writer arbitration;
- audit, redaction, retention, recovery, and cleanup.

The caller chooses only trusted logical identifiers. It does not supply a host path, image, mount,
network mode, Docker option, credential, raw ACP executable, or patch text.

## 9. Project/worktree identity

```text
principal grant
  -> logical QuaranGate project ID
  -> trusted executor configuration
  -> canonical real WSL project/worktree identity
  -> captured base revision and state
  -> job-specific sandbox snapshot
  -> selected backend/profile and governed ACP session
```

The VS Code folder path is not authorization. For human correctness, VS Code should display the same
canonical WSL worktree, but QuaranGate does not trust an editor report to select the execution target.
Multi-root workspaces require Herman to select the matching authorized logical project; ambiguity
denies rather than guessing.

The job binds its session and artifacts to the logical project, canonical worktree identity, captured
base, principal, backend, and profile. A Kiro session ID or conversation text is never authority.

## 10. Concurrent file activity and one-writer model

### Normal mode: isolated sandbox — selected

**PROPOSED and aligned with the implemented repository design:** Kiro writes only a job-specific
sandbox snapshot. VS Code may remain open on the real worktree because the agent is not concurrently
writing those files.

```text
VS Code / Herman ----------------------> real WSL worktree

Kiro CLI ACP -> isolated job sandbox -> evidence + agent_diff
                                            |
                                            v
                                  explicit guarded agent_apply
                                            |
                                  one live-writer admission
                                            v
                                      real worktree
```

Many isolated workers may exist when their writable sandboxes are disjoint. They are not live
worktree writers. The shared per-project/worktree live-writer rule applies when a reviewed change is
applied or whenever any exceptional path can mutate the real worktree.

Before apply, QuaranGate must revalidate the on-disk base and protected paths and atomically admit one
live writer. A stale base, concurrent apply, direct live writer, or uncertain prior apply denies.

VS Code can hold unsaved in-memory buffers that are newer than disk. Without an extension,
QuaranGate cannot observe those buffers. Therefore the ordinary human gate must require Herman to
save/reconcile relevant buffers and review the current disk diff before authorizing apply. The apply
engine must still fail on on-disk base drift; user confirmation is not a substitute for that check.
An optional future extension may improve dirty-buffer visibility but must not become the sole guard.

### Direct real-worktree writes — rejected as normal mode

Giving Kiro CLI direct write access to the real worktree would make the worker a live writer, expose
Herman's uncommitted work to tool races, weaken independent diff/apply separation, and complicate
cancellation/recovery. No source evidence requires this path. It must not be the I2 default.

## 11. Session model

- The governed Kiro CLI ACP session is distinct from VS Code editor state and from any agent/chat
  extension session in VS Code.
- One QuaranGate-owned ACP process/controller owns a Kiro session at a time because Kiro documents
  single-process ownership.
- QuaranGate may persist an opaque reference to a compatible Kiro session, bound to the principal,
  project/worktree, backend/profile, runner/state domain, and supported CLI version.
- Loading/resuming is allowed only after proving the previous owning process ended and the binding is
  still valid. `Session is active in another process` is a hard session-busy denial.
- A new job/session is acceptable; IDE-to-CLI shared conversation continuity is not an I2 requirement.
- No automatic prompt replay occurs after disconnect, timeout, restart, or ambiguous completion.

No controller lease or connection generation is required between VS Code and an independent Kiro
session. QuaranGate still needs operation identity, per-session serialization, and runner/process
lifecycle state for its own safe cancellation and recovery.

## 12. Cancellation

**OFFICIAL_DOCUMENTED:** ACP provides `session/cancel` for the current operation.

**EXPERIMENTALLY_CONFIRMED:** retained evidence for the matching installed 2.5.0 binaries observed
cancellation as a notification associated with the session, without a response acknowledgement.

**PROPOSED:** one prompt may be in flight per session. QuaranGate maps the job operation to the ACP
session, sends cancel once, stops admitting new work, and waits for a terminal prompt result/event or
confirmed termination of its owned runner process. Cancel send or timeout alone does not prove tools
stopped. Uncertainty yields an indeterminate/failed-infrastructure result, quarantines incomplete
evidence, and never enables apply.

VS Code does not participate in this cancellation path.

## 13. Provider, authentication, and network requirements

**OFFICIAL_DOCUMENTED:** Kiro CLI supports interactive browser/device authentication and API-key
authentication for automation/non-interactive use. Official firewall documentation lists required
Kiro service/authentication destinations, optional destinations for optional features, and standard
proxy environment variables.

For QuaranGate automation:

- use a dedicated automation credential injected only into the owned runner at startup;
- do not reuse or mount Herman's personal Kiro/VS Code profile;
- provide egress only to the exact Kiro provider/auth endpoints required by the pinned version and
  selected feature set;
- deny arbitrary network and omit optional GitHub/MCP destinations unless explicitly required;
- do not give the worker QuaranGate, MCP control-plane, Docker, or unrelated credentials;
- redact credential values and provider payloads from normal logs/evidence.

The exact domain/IP/TLS policy for installed 2.5.0 must be requalified in the deployment network;
current documentation can change and wildcard allowlisting should not be assumed necessary. No
provider call was required for this architecture decision.

## 14. Security boundary

The Kiro runner must remain non-root, non-privileged, capability-dropped, resource-bounded, and
without `docker.sock`, host-global filesystem, raw real-project bind, or public listener. Its writable
surface is the sandbox volume and isolated ephemeral/state paths required by the pinned adapter.

ACP stdio stays between the QuaranGate-owned driver and its spawned Kiro process. It is not exposed
as TCP and is not discoverable by VS Code or arbitrary WSL processes. Strict parsing treats all model,
tool, and provider output as untrusted data.

Kiro permissions are defense in depth: deny/ask/allow rules should grant only the sandbox-relative
filesystem and exact validation commands required by the selected profile. QuaranGate's container,
mount, network, and apply boundaries remain authoritative even if Kiro misbehaves or is prompt-injected.

## 15. Failure and recovery

| Failure | Required response |
|---|---|
| wrong/ambiguous project or multi-root selection | deny before runner creation |
| Kiro unavailable, wrong hash/version, unknown ACP schema | fail closed; do not fall back to headless prose or GUI automation |
| authentication/provider/network failure | bounded failure; no credential logging; no expanded egress retry |
| malformed/oversized/out-of-order ACP event | reject/quarantine operation; terminate owned runner when safe |
| session already active elsewhere | return session busy; create a new explicitly distinct session only through a new authorized operation |
| cancel/completion race | accept one terminal result; quarantine late events |
| driver/runner/WSL/Docker restart | no prompt replay; mark active job failed/indeterminate; reconcile owned resources |
| evidence missing/incomplete | no diff/apply eligibility; retain diagnostic classification per policy |
| real worktree changed after snapshot | stale-base refusal at apply; generate a new job/review rather than force |
| VS Code unsaved buffer may conflict | human saves/reconciles before apply; apply still validates disk state |
| apply interrupted or outcome uncertain | quarantine project/apply state; no second writer until deterministic reconciliation |

VS Code closing, reloading, or losing Remote WSL does not terminate the independent Kiro job. It may
affect Herman's ability to review, so apply should wait, but editor lifecycle is not worker authority.

## 16. Deterministic test plan

Use fake ACP processes and isolated temporary projects; no provider, GUI, or personal session:

1. authorize the exact principal/project/backend/profile tuple; deny each wrong or missing element;
2. prove caller/editor paths, executable, image, mounts, network, credentials, and patch text are rejected;
3. canonicalize a WSL worktree and deny symlink, wrong worktree, multi-root ambiguity, and stale base;
4. create disjoint sandbox snapshots and prove writes never touch the real project before apply;
5. parse pinned initialize/new/load/prompt/update/cancel fixtures and deny unknown/malformed shapes;
6. bind session to operation/project/backend/profile and deny cross-job/session reuse;
7. serialize one prompt per session and reject a second controller for an owned session;
8. handle cancel-before-start, cancel-during-stream, completion race, timeout, crash, and late events;
9. prove missing/incomplete evidence can never become diff/apply eligible;
10. construct `agent_diff` independently from sandbox state, not agent prose;
11. atomically deny two concurrent applies/direct live writers for one project/worktree;
12. prove stale disk state, protected paths, unreviewed diff, and absent apply scope all deny;
13. simulate VS Code remaining open while sandbox work runs; verify no dependency on VS Code IPC;
14. assert no Docker socket, host bind, personal Kiro home, public listener, or forbidden egress exists;
15. restart executor/runner and prove no automatic prompt replay or double writer admission.

## 17. Live acceptance plan

Use a disposable WSL repository/worktree and dedicated Kiro automation credential:

```text
Herman opens the project in VS Code through Remote WSL
  -> QuaranGate authorizes principal + project + Kiro backend + profile
  -> QuaranGate launches and controls a Kiro CLI ACP worker
  -> worker operates only in the governed sandbox/context
  -> result and independently captured evidence return
  -> exact agent_diff is available
  -> Herman reviews in VS Code and/or ChatGPT
  -> Herman saves/reconciles relevant editor buffers
  -> explicit agent_apply occurs only if separately authorized
```

Acceptance steps:

1. record Windows VS Code, WSL extension/server, WSL distribution, Docker, Kiro CLI, runner image,
   ACP profile, and binary/image hashes;
2. prove VS Code is connected through Remote WSL to the disposable canonical Linux worktree;
3. prove no QuaranGate companion extension is installed or needed and no VS Code IPC is contacted;
4. dispatch a read-only job, verify exact authorization/audit binding, and retrieve a real response;
5. dispatch a bounded write-profile job, verify only the sandbox changes, and retrieve exact evidence/diff;
6. keep VS Code open on the real worktree throughout and prove it remains unchanged before apply;
7. exercise cancellation and prove terminal cessation or safe indeterminate/no-apply behavior;
8. prove wrong project/backend/profile/principal/session and concurrent writer/apply requests deny;
9. make the real worktree stale and prove apply refusal;
10. restore a clean known base, save/reconcile VS Code buffers, explicitly authorize apply, and prove
    only the reviewed diff crosses into the real worktree;
11. verify VS Code observes the disk change normally, then validate tests/status and cleanup;
12. verify no residual runner/listener/credential/host bind remains and audit contains no secret value.

VS Code does not relay Kiro chat at any step.

## 18. Future implementation file plan

The minimum I2 architecture requires **no VS Code-specific runtime implementation**. It should reuse
the existing Agent Control Plane boundaries rather than create a second adapter stack.

| Existing/future area | Likely files | I2 responsibility |
|---|---|---|
| shared contract | `src/shared/agents.ts` | retain backend-neutral job/session/result/diff/apply contract |
| gateway authorization/schema/tools | `src/gateway/agentAuthz.ts`, `src/gateway/agentSchemas.ts`, `src/gateway/agentTools.ts` | exact logical grants; no editor- or caller-supplied host path |
| trusted project/backend config | `src/executor/agentConfig.ts`, trusted agent configuration | canonical WSL project mapping and pinned Kiro profile |
| job/session orchestration | `src/executor/agents/jobEngine.ts`, `src/executor/agents/jobStore.ts` | operation/session ownership, writer admission, recovery |
| Kiro ACP adapter | `src/executor/agents/kiroFactory.ts`, `src/executor/agents/kiroBackend.ts`, `src/executor/agents/acpDriver.ts` | spawn pinned ACP, strict schemas, stream/cancel/terminal handling |
| sandbox boundary | `src/executor/agents/sandboxSpec.ts`, `src/executor/agents/sandboxRunner.ts`, `src/executor/agents/credentialManager.ts`, `src/executor/agents/egressProxy.ts` | isolated snapshot, least privilege, credentials, provider-only egress |
| evidence/diff/apply | existing `artifact*`, `evidenceCollector.ts`, `canonicalDiff.ts`, `applyEngine.ts`, `applyPolicy.ts` | independent artifacts and guarded live-worktree crossing |
| deterministic tests | existing `tests/unit/agent-*`, `tests/unit/a4-*`, `tests/integration/agents.test.ts`, `tests/integration/a3-sandbox.test.ts` plus narrowly named I2 cases | prove editor independence and Windows/WSL identity assumptions |
| live acceptance artifact | future `docs/audits/` I2 report only after owner-approved execution | exact topology/version/hash and pass/fail evidence |

This is a plan, not authorization to modify those files. Exact changes must be derived from a fresh
gap analysis; if current Agent Control Plane behavior already satisfies a row, do not rewrite it.

If a later owner-approved UX need justifies Option B, keep it isolated under a single new
`extensions/quarangate-vscode-status/` package with its own tests and security review. It must remain
optional and must not alter Kiro ACP or apply authority.

### Ollama O1 conflict assessment

This I2 gate changes documentation only and touches no Ollama path, so it has no current file conflict
with Lane A. A future I2 validation may read or add tests around generic gateway/executor/agent files
that Ollama O1 also integrates with; rebase and inspect Lane A's landed diff before planning exact
runtime edits. Do not modify Ollama backend, relay, image, network, or test files from this lane.

## 19. Technical blockers

### Architecture blockers

**NONE FOUND** for Option A: VS Code as editor plus a distinct sandboxed Kiro CLI/ACP worker. Official
VS Code Remote WSL placement and official Kiro ACP stdio behavior are compatible without a companion
extension.

### Live-acceptance prerequisites / unresolved evidence

- exact Windows VS Code version and live Windows/WSL process placement were not locally confirmed in
  this restricted qualification shell;
- installed Kiro CLI 2.5.0 is behind current documentation and must use its pinned tested schema;
- a fresh real ACP turn requires a dedicated valid automation credential and provider call;
- exact provider egress for the pinned version must pass the deployment network policy;
- real Docker/WSL runner placement and cleanup must be recorded during acceptance;
- the no-extension pre-apply UX relies on Herman saving/reconciling unsaved buffers.

These items block a claim of fresh live acceptance, not the architecture decision.

## 20. Owner decisions

### Recorded authoritative decisions

- editor and governed agent surfaces may be different products;
- VS Code need not control, proxy, or mirror Kiro chat;
- a distinct Kiro CLI ACP session is sufficient;
- same-session IDE/CLI continuity is not required;
- sandbox-first execution and one controlled live writer per project/worktree remain mandatory;
- Kiro has no direct real-worktree apply authority.

### Open for a future implementation/acceptance gate

1. exact Kiro CLI version/engine and runner image pin;
2. dedicated automation credential owner, storage, rotation, and revocation policy;
3. exact provider egress allowlist/proxy/TLS policy for that pin;
4. whether human save/reconcile confirmation is sufficient before apply or an optional dirty-buffer
   status extension is worth building;
5. session retention/resume lifetime and evidence retention for governed Kiro sessions;
6. whether optional VS Code status/approval UX provides enough value to justify Option B.

## 21. I2 verdict

**VSCODE + KIRO CLI/ACP COMBINATION: FEASIBLE.** The simplest technically sound architecture is
Option A: VS Code is the human-facing Remote WSL editor; QuaranGate independently governs Kiro CLI
through supported ACP in an isolated WSL/Docker runner; the worker sees only its sandbox; QuaranGate
returns result/evidence/`agent_diff`; and a separately authorized guarded `agent_apply` is the only
normal live-worktree mutation.

**VS CODE EXTENSION REQUIRED: NO.** A small extension is an optional future status/dirty-buffer UX
enhancement, not an authorization or transport prerequisite. Deep VS Code agent integration, chat
relay, GUI automation, private Kiro APIs, and IDE-to-CLI session sharing are out of scope and
unnecessary.

**IMPLEMENTATION-READY AS AN ARCHITECTURE: YES, after the listed version/auth/network live-acceptance
prerequisites are explicitly provisioned.** No runtime implementation begins in I2.
