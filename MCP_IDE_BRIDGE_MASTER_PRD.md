# QuaranGate — Master Product Requirements Document (PRD)

**Document ID:** MIB-MASTER-PRD  
**Version:** 1.0  
**Date:** 2026-07-28  
**Status:** Master baseline — current bridge verified; Agent Dispatch phases A0 through A6 complete (PASS); post-A6 gateway readiness + image-provenance remediation complete (PASS); A7 next formal A-gate; IDE Session Control North-Star expansion owner-approved; I0 design candidate documented, not implemented or accepted complete\
**Product identity:** QuaranGate (canonical, current — supersedes the earlier AgentControl identity). Package name and MCP server self-identification are `quarangate`. The GitHub repository rename is complete (`Herman940306/QuaranGate` — see §47.10). Other internal runtime identifiers — Compose project, Docker networks/volumes/labels — intentionally retain their earlier `mcp-ide-bridge` / `mcp-bridge` names pending a controlled compatibility migration; see §47 for the full migration contract.\
**Repository:** `/home/herman/projects/mcp-ide-bridge` (worktree path unchanged; GitHub remote is `Herman940306/QuaranGate` — rename complete, see §47.10)\
**Current canonical Git baseline:** `a5cb6debbeb7a525303ee17e8a601468398d7ac6` — `fix: repair read-only review target runtime`\
**Historical/latest specific gateway-hardening validation evidence:** `67146a4` — `fix: harden gateway readiness and image provenance` (typecheck PASS, unit 1420/1420 PASS)

---

## 0. Purpose of this document

This document is the master product requirements document for QuaranGate.

It has two jobs:

1. Preserve the **verified current state** of the bridge so future work never loses the security, architecture, interoperability, and testing baseline already achieved.
2. Define the **north-star architecture and phased implementation plan** that turns the bridge from a secure MCP-to-Docker execution gateway into a governed engineering control plane. Approved clients can dispatch bounded implementation work to isolated local agents and, under separate explicit authority, communicate with the active AI agent in an authorized IDE session. Isolated work remains independently reviewable and may be applied only through explicit approval gates.

This document is intended to become the canonical planning reference for the project. It should be updated at every completed implementation gate, but historical verified facts must not be silently rewritten.

---

# 1. Executive summary

QuaranGate already provides a working, security-conscious remote MCP control plane.

Today, an approved browser-based MCP client can authenticate to the bridge over public HTTPS, discover authorized Docker targets, read files, inspect Git state, execute bounded shell commands, modify files when permitted, and receive typed MCP results. The bridge preserves a strong privilege split:

```text
External MCP Client
        |
        v
Tailscale Funnel / HTTPS
        |
        v
Gateway
- OAuth / API-key authentication
- client scopes
- target authorization
- rate limiting
- audit
- NO docker.sock
        |
        v
Private Docker network
        |
        v
Executor
- internal only
- Docker target allowlist
- workspace confinement
- Docker socket access
        |
        v
Authorized Docker target
```

Claude browser and ChatGPT browser have both been externally verified against the live bridge.

The next program is not to weaken this model. It is to extend it.

The implemented Agent Control Plane remains one half of the expanded north star:

```text
User + ChatGPT
     |
     | discuss / approve bounded engineering task
     v
QuaranGate
     |
     | agent_dispatch
     v
Governed Agent Execution Plane
     |
     +---- Kiro Agent Runner
     |       primary machine interface: Kiro ACP
     |
     +---- GitHub Copilot Runner
             primary planned interface: Copilot SDK
     |
     v
Isolated job workspace
     |
     v
Agent implementation + tests
     |
     v
Result + exact diff + evidence
     |
     v
ChatGPT independent audit
     |
     v
Explicit approval
     |
     v
Apply to real project
```

The user should no longer need to act as a clipboard between ChatGPT and an IDE coding agent.

The target experience is:

> User: “Continue the next Mickey implementation gate.”  
> ChatGPT: explains the exact bounded task and asks for approval.  
> User: approves.  
> ChatGPT: dispatches the prompt to Kiro itself.  
> Kiro: works inside an isolated sandbox and returns its result.  
> ChatGPT: retrieves the exact diff, validates tests and policy, and reports findings.  
> User: approves application.  
> ChatGPT: applies the reviewed change through the bridge.

This preserves the existing human-approval workflow while removing manual copy/paste orchestration.

The owner-approved expansion adds a complementary, separately authorized path:

```text
Approved client
     |
     v
QuaranGate authorization
     |
     v
Enrolled IDE/session adapter
     |
     v
Exact active IDE + workspace/worktree + interactive agent session
```

This IDE Session Control Plane targets Kiro, VS Code, and Cursor as required integrations. Visual
Studio and Antigravity are secondary feasibility targets. It does not inherit Agent Dispatch
authority, does not replace the isolated sandbox workflow, and is not implemented at this baseline.

---

# 2. Product principles

The following are non-negotiable unless explicitly changed by a future approved architecture decision.

## 2.1 Governed autonomy, not unrestricted remote execution

The bridge exists to provide useful automation without turning ChatGPT, Kiro, Copilot, or any other model into an unrestricted remote host administrator.

Prompts are instructions.

Prompts are **not** security boundaries.

Security must be enforced by:

- authenticated principals;
- explicit scopes;
- project allowlists;
- execution profiles;
- container boundaries;
- resource limits;
- path confinement;
- immutable or append-only evidence;
- explicit apply gates.

## 2.2 Sandbox first

Agent implementation must default to an isolated sandbox.

An implementation agent completing a task does **not** mean the change is accepted.

The lifecycle is:

```text
dispatch
   |
sandbox implementation
   |
agent completes
   |
collect evidence
   |
independent audit
   |
approval
   |
apply
```

`COMPLETED` and `APPLIED` are separate states.

## 2.3 Machine-facing IDE control, not fragile GUI authority

The project will not depend on:

- locating Kiro windows;
- clicking IDE chat fields;
- pasting prompts through simulated keyboard input;
- scraping generated responses from pixels;
- relying on IDE window focus.

Kiro must be controlled through a supported machine-facing protocol, supported CLI where appropriate
to the isolated worker plane, or a narrow authenticated companion extension/local adapter.

GitHub Copilot and other IDE agents must be controlled through supported programmatic interfaces or
narrow authenticated companion extensions/local adapters.

For the isolated Agent Control Plane, the IDE remains a user-facing view rather than the automation
transport. For IDE Session Control, an enrolled companion extension or local adapter may be the
production transport when it exposes a narrow, authenticated, versioned machine-facing interface
bound to an exact IDE instance, workspace/worktree, and active interactive session. Accessibility or
UI automation is fallback-only and cannot establish authority or be selected through silent
downgrade.

## 2.4 Existing privilege separation must survive

The current security architecture must remain true:

```text
Gateway:
  may be publicly reachable through approved HTTPS ingress
  may authenticate and authorize clients
  MUST NOT receive docker.sock
  MUST NOT become an unrestricted WSL shell

Executor:
  remains private/internal
  may hold Docker authority
  MUST NOT expose a public listener

Agent runners:
  MUST NOT receive docker.sock
  MUST NOT mount arbitrary host directories
  MUST NOT run privileged
  MUST NOT receive unrestricted host networking
```

## 2.5 Project IDs, never caller-supplied host paths

Public MCP requests must use identifiers such as:

```text
project: mickey
```

They must never be allowed to provide:

```text
cwd: /home/herman/...
path: /
path: ../../...
```

A trusted executor-side registry resolves the project ID to the approved source.

## 2.6 Least privilege remains the default

Do not make unsafe modes the default just because a tool supports them.

Examples that must not be the normal production path:

```text
Kiro:    --trust-all-tools
Copilot: --allow-all
Copilot: --yolo
```

Profiles must explicitly grant the minimum capabilities needed for the requested lane.

---

# 3. Verified current state

This section records the baseline as verified before the Agent Dispatch implementation begins.

## 3.1 Repository

Repository:

```text
/home/herman/projects/mcp-ide-bridge
```

Verified history at the current checkpoint:

```text
6bf16a8  docs: verify ChatGPT browser MCP integration
2729b5a  feat: add structured output schemas to MCP tools
966e10b  feat: verify Claude browser remote MCP integration
71add9c  test: derive OAuth resource from bridge metadata
c93bb0a  security: harden OAuth browser authorization flow
47c3f50  chore: establish verified initial mcp-ide-bridge baseline
```

Working tree at checkpoint: clean.

## 3.2 Running architecture

Verified services:

```text
mcp-ide-bridge-gateway-1
mcp-ide-bridge-executor-1
```

Verified security properties:

```text
Gateway host bind:
127.0.0.1:8787

Executor published ports:
none

Gateway docker.sock:
absent
```

The gateway and executor were both healthy at the final current-state verification.

## 3.3 Public ingress

Current externally verified HTTPS ingress:

```text
https://wolf.taildc680e.ts.net
```

MCP endpoint:

```text
https://wolf.taildc680e.ts.net/mcp
```

Ingress implementation:

```text
Tailscale Funnel
        |
        v
http://127.0.0.1:8787
```

The public ingress does not require changing the Docker gateway bind from loopback.

Verified public endpoints:

```text
/healthz -> {"ok":true}
/readyz  -> {"ok":true}
```

## 3.4 Current MCP tool surface

> **Status note.** §3 records the verified state of the bridge *before* Agent Dispatch began. It is
> retained as the pre-A0 baseline. The current operational surface is **23 tools**: the 14 below
> plus the nine Agent Control Plane tools activated across A2–A6 (`agents_list`, `agent_projects`,
> `agent_dispatch`, `agent_status`, `agent_result`, `agent_cancel`, `agent_diff`, `agent_apply`,
> `agent_discard`). See §38 for the phase tracker.

The pre-Agent-Dispatch bridge exposed 14 MCP tools:

```text
targets_list
target_inspect

fs_list
fs_stat
fs_read
fs_search
fs_write
fs_patch
fs_delete

terminal_exec

git_status
git_diff
git_log

process_list
```

The tool family supports target discovery, workspace-confined filesystem operations, bounded command execution, Git inspection, and process inspection.

## 3.5 Structured MCP output

All 14 tools above advertise output schemas. The nine Agent Control Plane tools added later carry
strict Zod input/output contracts of their own (`src/gateway/agentSchemas.ts`).

Successful operations return:

1. typed `structuredContent`; and
2. backward-compatible JSON serialized into MCP text content.

The structured-output milestone is checkpointed at:

```text
2729b5a feat: add structured output schemas to MCP tools
```

This gives clients a declared result contract instead of forcing them to infer every result from plain text.

## 3.6 Current automated validation baseline

Final verified baseline before starting Agent Dispatch:

```text
TypeScript typecheck:
PASS

Unit:
20 / 20 PASS

Live integration:
40 / 40 PASS

Public health:
PASS

Executor published ports:
{}

Gateway docker.sock:
ABSENT_GOOD
```

This baseline is a regression gate for future work.

A future implementation phase may add tests, so the absolute test count may increase. Existing tests must not silently disappear.

### Historical/latest specific gateway-hardening validation evidence (post-A6, commit `67146a4`)

```text
TypeScript typecheck:
PASS

Unit:
1420 / 1420 PASS  (35 test files)

Live integration:
Not re-run at this commit — requires an authorized Docker stack
```

The pre-Agent-Dispatch counts above (20 unit / 40 integration) remain the historical record for
that milestone. `docs/TEST_RESULTS.md` holds the full evidence trail.

## 3.7 OAuth/security hardening already completed

The public-browser path includes an OAuth façade that was hardened before public client integration.

Implemented and tested properties include:

- dynamic client registration;
- JSON request handling for DCR;
- exact registered redirect matching;
- HTTPS / valid loopback redirect constraints;
- PKCE S256 validation;
- OAuth authorization code binding to the correct client;
- RFC 8707-style MCP resource binding;
- resource-bound access tokens;
- refresh-token client/resource binding;
- refresh-token rotation;
- replay rejection;
- bounded OAuth client/state persistence;
- safer OAuth authorization HTML headers;
- CSP behavior that permits only the already-validated callback origin required by the real client;
- protected-resource metadata;
- unauthenticated MCP requests producing the expected bearer/resource-metadata challenge.

The OAuth persistent-data directory permissions were also corrected so the non-root gateway process can safely persist OAuth state.

## 3.8 Credential handling baseline

Sensitive runtime material is not intended to be committed to Git.

The project has already used dedicated client principals rather than a single shared browser identity.

A previously exposed Claude browser key was treated as compromised and rotated. The old key was verified invalid.

The security lesson is permanent:

> Any credential printed into an interactive transcript or chat must be considered exposed and rotated.

Future agent credentials must therefore be provisioned outside source control and must never be returned in MCP results or logs.

## 3.9 Claude browser status

Claude browser is externally verified.

Verified capabilities include:

```text
OAuth connection
target discovery
filesystem read
Git status
terminal execution
filesystem write
read-back
filesystem delete
```

The browser test proved execution inside the approved `demo` target workspace.

## 3.10 ChatGPT browser status

ChatGPT browser is externally verified.

Verified live operations include:

```text
targets_list
target_inspect
fs_read
git_status
terminal_exec
fs_write
fs_read-back
```

A live terminal probe returned:

```text
PWD=/workspace
```

inside the authorized Docker target.

The gateway audit independently identified the ChatGPT principal for the tool calls.

### `fs_delete` observation

During the real ChatGPT test:

```text
fs_write -> reached bridge and was allowed
fs_read  -> reached bridge and was allowed
fs_delete -> blocked by the ChatGPT client before the request reached the bridge
```

This is **not** evidence that server-side `fs_delete` is broken.

Server-side delete remains covered by the live integration suite.

`fs_delete` must remain honestly marked as destructive.

A future reversible removal workflow may be added, but destructive semantics must not be disguised merely to bypass a client safety layer.

---

# 4. Current architecture contract

## 4.1 Gateway responsibilities

The gateway is responsible for:

- MCP protocol termination;
- client authentication;
- OAuth handling;
- principal identification;
- scope checks;
- target authorization;
- rate limiting;
- request validation;
- audit entry creation;
- calling the executor through the private internal network;
- returning schema-conforming MCP results.

The gateway must not become the Docker execution authority.

## 4.2 Executor responsibilities

The executor is responsible for privileged execution decisions involving Docker.

Current responsibilities include:

- authorized target lookup;
- workspace-aware operations;
- Docker container inspection/execution;
- target boundary enforcement;
- command timeouts and output limits.

Future responsibilities will include:

- agent job orchestration;
- runner lifecycle;
- sandbox creation;
- sandbox cleanup;
- job-state persistence;
- diff collection;
- apply/discard transactions.

## 4.3 Target boundary

A caller must not be able to address an arbitrary Docker container.

The bridge operates against authorized targets only.

The same model must be extended to projects and agents:

```text
authorized principal
    |
authorized operation
    |
authorized project
    |
authorized backend/profile
    |
bounded sandbox
```

---

# 5. Product north star

## 5.1 Goal

Make QuaranGate the governed control plane through which approved browser and desktop AI clients—
including ChatGPT, Claude, Codex, and future compatible MCP clients—can operate explicitly authorized
workspaces, dispatch isolated governed workers, and, under separate explicit authority, communicate
with the active AI agent in an authorized IDE session while preserving human approval and local
security.

The visible interactive IDE and the isolated Agent Control Plane are complementary execution modes:

```text
PLANE A — ISOLATED AGENT CONTROL PLANE
client -> QuaranGate -> governed backend -> isolated sandbox
       -> evidence -> independent review -> explicit apply

PLANE B — IDE SESSION CONTROL PLANE
client -> QuaranGate authorization -> IDE/session adapter
       -> active IDE/workspace/session -> interactive IDE agent
```

Plane B does not replace or weaken Plane A. Because the live IDE is not a sandbox, any interaction
that cannot technically exclude mutation must be treated as live-writer-capable.

The ideal workflow:

```text
1. User discusses requirement with ChatGPT.
2. ChatGPT reasons about the next bounded implementation gate.
3. ChatGPT explains scope, risks, validation, and expected changes.
4. User approves dispatch.
5. ChatGPT calls agent_dispatch.
6. Bridge launches the selected worker in a sandbox.
7. Worker implements and runs allowed validation.
8. Bridge captures response, events, changed files, diff, and evidence.
9. ChatGPT independently audits the evidence.
10. User decides whether to apply.
11. ChatGPT calls agent_apply only after explicit approval.
12. Real project changes.
13. Open Kiro/VS Code naturally sees the applied filesystem changes; this is distinct from the
    separately authorized IDE Session Control Plane.
14. ChatGPT validates the real workspace and advances the project gate.
```

## 5.2 Primary worker backends

Approved target backends:

```text
Kiro
GitHub Copilot
```

### Kiro direction

Primary production integration:

```text
kiro-cli acp
```

Kiro ACP currently exposes a JSON-RPC-over-stdio agent protocol with session management, prompting, cancellation, mode selection, and streamed session events.

The bridge-controlled Kiro environment must be isolated from the user's normal interactive Kiro environment.

### GitHub Copilot direction

Primary planned integration:

```text
GitHub Copilot programmatic agent adapter
```

Initial architectural preference:

```text
Copilot SDK
```

The exact Copilot adapter is an A0/A7 verification decision. Current GitHub Copilot CLI also exposes programmatic execution, granular allow/deny controls, and an ACP server. Those interfaces may be compared during implementation if doing so materially reduces complexity or improves security, but the caller-facing MCP contract must remain backend-neutral.

## 5.3 User experience principle

The project is not trying to remove the user from engineering decisions.

It is trying to remove the repetitive transport work:

```text
copy ChatGPT prompt
paste into IDE agent
wait
copy agent response
paste into ChatGPT
```

The approval loop remains.

The clipboard loop disappears.

## 5.4 IDE Session Control priorities

Primary required targets for the updated North Star:

```text
I1  Kiro
I2  VS Code
I3  Cursor
```

Secondary feasibility targets, which do not block North-Star completion when no safe/stable
integration surface exists:

```text
I4  Visual Studio
I5  Antigravity
```

The common I0 contract, authority and threat model are defined in
`docs/IDE_SESSION_CONTROL.md`. No IDE Session Control implementation is present at this checkpoint.

---

# 6. Proposed Agent Control Plane

## 6.1 Caller-facing tools

The planned MCP surface is:

```text
agents_list
agent_projects

agent_dispatch
agent_status
agent_result
agent_diff
agent_cancel

agent_apply
agent_discard
```

This adds 9 agent-control tools to the current 14-tool bridge.

The exact names remain subject to the A1 contract gate, but semantic separation must remain.

## 6.2 `agents_list`

Purpose:

- show backends the current principal may use;
- report availability;
- report transport type;
- report supported profiles/capabilities without exposing credentials.

Conceptual output:

```json
{
  "backends": [
    {
      "id": "kiro",
      "available": true,
      "transport": "acp",
      "profiles": ["audit", "plan", "implement", "review"]
    },
    {
      "id": "copilot",
      "available": true,
      "transport": "sdk",
      "profiles": ["audit", "plan", "implement", "review"]
    }
  ]
}
```

## 6.3 `agent_projects`

Purpose:

Expose only projects the authenticated principal is authorized to address.

Conceptual output:

```json
{
  "projects": [
    {
      "id": "mcp-ide-bridge",
      "git": true,
      "allowedBackends": ["kiro", "copilot"]
    },
    {
      "id": "mickey",
      "git": true,
      "allowedBackends": ["kiro"]
    }
  ]
}
```

Do not return private host filesystem paths unless a future policy explicitly allows it.

## 6.4 `agent_dispatch`

Purpose:

Create a governed asynchronous agent job.

Conceptual input:

```json
{
  "backend": "kiro",
  "project": "mickey",
  "profile": "implement",
  "prompt": "<bounded implementation prompt>",
  "sessionPolicy": "new"
}
```

Conceptual immediate result:

```json
{
  "jobId": "job_01...",
  "status": "QUEUED",
  "backend": "kiro",
  "project": "mickey",
  "profile": "implement"
}
```

`agent_dispatch` must not hold one MCP/HTTP request open while a coding agent works for many minutes.

## 6.5 `agent_status`

Purpose:

Retrieve state without returning the full result payload.

Conceptual output:

```json
{
  "jobId": "job_01...",
  "status": "RUNNING",
  "phase": "testing",
  "createdAt": "...",
  "startedAt": "...",
  "elapsedMs": 184221
}
```

## 6.6 `agent_result`

Purpose:

Return the agent's completion state and normalized final response.

Conceptual output:

```json
{
  "jobId": "job_01...",
  "status": "COMPLETED",
  "backend": "kiro",
  "agentSessionId": "opaque-backend-session-id",
  "exitCode": 0,
  "summary": "...",
  "baseCommit": "...",
  "changedFiles": [
    "src/foo.ts",
    "tests/foo.test.ts"
  ]
}
```

Backend-specific details should not leak into the top-level MCP API unless required.

## 6.7 `agent_diff`

Purpose:

Provide evidence generated from the sandbox itself.

It must not simply repeat the model's statement of what it changed.

It should expose:

- file status;
- exact changed-file list;
- machine-generated unified diff;
- binary-change metadata where applicable;
- diff hash;
- base commit/hash;
- optional truncation flag for large diffs.

## 6.8 `agent_cancel`

Purpose:

Cancel a queued/running job the current principal is authorized to control.

Preferred behavior:

```text
graceful backend cancel
       |
       v
bounded wait
       |
       v
runner termination if required
```

Kiro ACP supports session cancellation and should use it where practical.

Cancellation must not imply automatic deletion of evidence already produced.

## 6.9 `agent_apply`

Purpose:

Apply a reviewed sandbox change into the real authorized project.

This is a high-risk operation.

Required gates include:

- principal has apply scope;
- job reached a valid completed state;
- job has not already been applied/discarded;
- real project still matches the recorded base state;
- expected working-tree cleanliness policy is satisfied;
- patch passes `git apply --check` or equivalent;
- prohibited files are absent;
- approval context is recorded;
- apply is transactional or safely recoverable.

`agent_dispatch` must never call `agent_apply` implicitly.

## 6.10 `agent_discard`

Purpose:

Mark the result rejected and delete/reclaim the job sandbox once evidence retention policy permits.

Discard must not touch the real project.

---

# 7. Agent job state model

The canonical state machine should distinguish execution state from review/apply state.

Proposed lifecycle:

```text
QUEUED
   |
   v
PREPARING
   |
   v
RUNNING
   |
   v
VALIDATING
   |
   v
COMPLETED
```

Failure/termination states:

```text
FAILED_PRECONDITION
FAILED_POLICY
FAILED_AGENT
FAILED_TIMEOUT
FAILED_INFRASTRUCTURE
CANCELLED
```

Post-completion disposition:

```text
COMPLETED
   | \
   |  \
   v   v
APPLIED  DISCARDED
```

Optional future states:

```text
AWAITING_REVIEW
AWAITING_APPLY_APPROVAL
APPLYING
APPLY_FAILED
```

State transitions must be explicit and validated.

No arbitrary state mutation.

---

# 8. Project registry

## 8.1 Requirement

Public callers refer to approved logical project IDs only.

Example trusted configuration:

```yaml
projects:
  mcp-ide-bridge:
    hostPath: /home/herman/projects/mcp-ide-bridge
    gitRequired: true
    backends:
      - kiro
      - copilot

  mickey:
    hostPath: /home/herman/projects/docker-lab/Mickey Agent
    gitRequired: true
    backends:
      - kiro
```

The exact schema must be finalized in A1.

## 8.2 Public input prohibition

The following must not become caller-controlled inputs:

```text
hostPath
Docker bind source
runner image
credential mount
docker.sock
host network mode
privileged
user namespace mode
```

These are trusted configuration decisions.

## 8.3 Git requirement for v1 apply

For the first production apply implementation, projects should be Git repositories.

Git provides:

- base commit identity;
- dirty-state detection;
- diff generation;
- patch validation;
- stale-state protection;
- rollback/recovery tools.

Read-only audit support for non-Git projects can be considered later.

---

# 9. Sandbox architecture

## 9.1 Core requirement

The agent runner must not directly mount the real project read-write during normal implementation.

Preferred v1 materialization model:

```text
Approved host project
        |
        | read-only source during staging
        v
Short-lived staging container
        |
        | copy
        v
Docker-managed job volume
        |
        v
Agent runner
mounts only the job volume RW
```

The runner should see:

```text
/workspace
```

but `/workspace` should be the sandbox copy, not the live project.

## 9.2 Why a Docker-managed volume

This avoids giving the worker a raw host bind for the real project.

The privileged executor controls the transition:

```text
host project -> sandbox
```

The agent sees only:

```text
sandbox
```

## 9.3 Apply architecture

Applying approved changes should use a separate, explicit operation.

Conceptual flow:

```text
job sandbox
    |
generate exact patch + metadata
    |
verify original base
    |
dedicated apply transaction
    |
real project
```

The apply mechanism must not reuse the unrestricted agent runner.

A dedicated apply helper may temporarily receive narrowly scoped write access to the approved project.

## 9.4 Stale apply prevention

Every job records:

```text
baseCommit
baseWorkingTreeState
baseProjectIdentity
```

Before apply:

```text
current real state == expected base?
```

If not:

```text
APPLY REFUSED
```

No automatic conflict guessing in v1.

A new job/rebase workflow can be created instead.

---

# 10. Execution profiles

Profiles are enforcement policies, not prompt templates.

## 10.1 `audit`

Purpose:

- inspect repository;
- investigate behavior;
- review architecture;
- diagnose issues.

Policy:

```text
workspace read: YES
workspace write: NO
Git read: YES
Git write: NO
bounded shell: optional/read-oriented
network: deny by default
```

## 10.2 `plan`

Purpose:

- produce implementation plan;
- identify files and dependencies;
- propose test matrix.

Policy:

```text
workspace read: YES
workspace write: NO
Git read: YES
tests/build: generally unnecessary
network: deny by default
```

## 10.3 `implement`

Purpose:

- perform an approved bounded implementation in sandbox;
- run validation.

Policy:

```text
workspace read: YES
sandbox write: YES
Git status/diff/log: YES
Git commit: NO by default
Git push: NO
Docker socket: NO
host administration: NO
network: deny unless specifically required/allowlisted
```

## 10.4 `review`

Purpose:

- independently inspect another job/result;
- run read-only analysis or validation.

Policy:

```text
workspace read: YES
workspace write: NO
diff: YES
tests: YES when safe
Git write: NO
```

## 10.5 Future profiles

Future explicitly approved profiles could include:

```text
test
documentation
migration
release-prep
```

They must not bypass the base security model.

---

# 11. Authorization model

Suggested additional OAuth/API scopes:

```text
agents:read
agents:dispatch
agents:cancel
agents:apply
```

Possible finer-grained future model:

```text
agents:result
agents:review
agents:discard
```

Authorization must consider all of:

```text
principal
operation
project
backend
profile
job ownership/control relationship
```

A principal authorized to dispatch Kiro against project A must not automatically gain Copilot access or project B access.

IDE Session Control adds a separate deny-by-default authority relationship:

```text
principal
  -> enrolled IDE instance
  -> logical project + exact workspace/worktree
  -> current interactive session
  -> allowed capability/action
```

Agent Dispatch authority must not imply IDE Session authority. IDE Session authority must not imply
Agent Dispatch, target, filesystem, or terminal authority. Discovery identifies enrolled instances
and sessions; it never authorizes them. No principal receives ambient access to every IDE or session
on the host.

---

# 12. Backend abstraction

The MCP layer must not implement Kiro-specific behavior directly.

Proposed conceptual adapter contract:

```text
AgentBackend

availability()
prepare()
start()
status()
cancel()
result()
cleanup()
```

Possible event interface:

```text
onAgentMessage
onToolCall
onToolResult
onStatus
onError
onCompleted
```

Normalized results allow ChatGPT to orchestrate both backends identically.

---

# 13. Kiro backend requirements

## 13.1 Primary interface

Target:

```text
kiro-cli acp
```

Current official Kiro ACP documentation describes JSON-RPC over stdio and methods including:

```text
initialize
session/new
session/load
session/prompt
session/cancel
session/set_mode
```

Kiro ACP sessions are persisted, enabling later session continuity.

## 13.2 Isolated Kiro home

Bridge-controlled Kiro must not share the user's ordinary interactive Kiro profile.

Target model:

```text
Personal Kiro:
~/.kiro

Bridge Kiro:
dedicated runner state volume
```

Where supported, use:

```text
KIRO_HOME=<bridge-controlled state location>
```

This isolates:

- sessions;
- settings;
- global agents;
- prompts;
- skills;
- related automation state.

## 13.3 Authentication

Kiro headless automation currently supports API-key authentication through `KIRO_API_KEY`.

The raw secret must not:

- appear in Git;
- appear in bridge configuration committed to Git;
- appear in MCP arguments;
- appear in result objects;
- appear in logs;
- be passed as Docker container configuration in a way that makes the raw value casually visible through inspection if a safer mounted-secret bootstrap is practical.

Preferred pattern:

```text
protected secret file / secret provider
        |
runner entrypoint reads secret internally
        |
sets process environment
        |
exec kiro-cli
```

## 13.4 Tool permissions

Production automation should use the minimum trusted tool categories required by the profile.

Do not make `--trust-all-tools` the default.

## 13.5 Session continuity

Future supported policy:

```text
sessionPolicy: new
sessionPolicy: resume
```

The bridge maintains mapping:

```text
project + backend + logical session
    ->
backend session ID
```

Critical safety constraints must still be repeated or enforced independently. Session memory is not authorization.

---

# 14. GitHub Copilot backend requirements

## 14.1 User-selected backend

The VS Code-side implementation agent is GitHub Copilot.

The programmatic worker does not need to inject text into the visible VS Code Copilot chat panel.

It works against the same project source through the controlled job workspace.

After an approved apply, VS Code naturally observes the filesystem changes.

## 14.2 Preferred adapter

Initial preference:

```text
GitHub Copilot SDK
```

The reason is structured programmatic orchestration rather than parsing terminal decoration.

Current GitHub documentation also provides a non-interactive Copilot CLI and an ACP mode.

A0/A7 may compare:

```text
SDK
versus
Copilot ACP
```

if doing so reduces risk or adapter duplication.

This comparison must not change the external MCP tool contract.

## 14.3 Permissions

GitHub Copilot CLI currently supports granular concepts such as:

```text
--allow-tool
--deny-tool
--add-dir
--allow-url
```

The production runner must prefer granular permissions.

Do not default to:

```text
--allow-all
--yolo
--allow-all-paths
--allow-all-urls
```

## 14.4 Copilot state isolation

As with Kiro, the bridge-controlled Copilot environment should use dedicated state/config where feasible rather than modifying the user's normal CLI/VS Code state.

Credentials must remain runtime secrets.

---

# 15. Job persistence and evidence

## 15.1 Persistence requirement

A gateway restart or transient client disconnect must not make an already-started agent job unknowable.

Agent job state belongs on the trusted local side.

Recommended v1 persistence:

```text
executor-owned local persistent store
```

SQLite is a strong candidate because the workload is local, structured, transactional, and does not need a separate database service. Final storage technology is an A1 implementation decision.

## 15.2 Required job metadata

At minimum:

```text
jobId
principalId
backend
projectId
profile
status
createdAt
startedAt
completedAt
baseCommit
baseWorkspaceState
runnerImage
backendSessionId
promptHash
resultHash
diffHash
changedFiles
exitCode
failureCode
applyStatus
applyTimestamp
```

## 15.3 Prompt retention

Do not assume full raw prompts should live forever.

A retention policy should distinguish:

- prompt hash for identity/audit;
- raw prompt for bounded troubleshooting;
- sensitive content redaction;
- configurable expiration.

## 15.4 Event evidence

Useful events include:

```text
agent message
tool call
tool completion
test command
status change
policy denial
timeout
cancel request
runner exit
```

Event payloads must be bounded and redacted.

---

# 16. Audit requirements

Every agent-control action should produce an audit event comparable to the existing gateway tool audit.

Examples:

```text
agent_dispatch
agent_status
agent_result
agent_diff
agent_cancel
agent_apply
agent_discard
```

Audit fields should include:

```text
timestamp
request ID
principal
tool
job ID
project
backend
profile
decision
reason
duration
```

Sensitive prompt/result bodies should not be blindly logged.

IDE-session audit must additionally bind the action to the IDE type/version, enrolled instance,
logical project, non-secret workspace/worktree identity, interactive session reference, adapter
identity/version, connection generation, capability snapshot, controller/writer lease where
applicable, ordered operation events, and disconnect/cancel/recovery outcome. Prompt, response,
terminal, editor, and filesystem bodies remain bounded and redacted rather than blindly logged.

---

# 17. Concurrency model

Initial production rule:

```text
global active writer jobs: 1
active writer jobs per project: 1
```

Read-only jobs may initially also be serialized for simplicity.

Later:

```text
multiple read-only reviewers
+
maximum one writer per project
```

Never allow two independent write agents to mutate the same sandbox or live project concurrently unless a future design explicitly implements safe branch/worktree isolation.

The broader North-Star rule across both execution planes is:

```text
many readers
many isolated workers
one controlled live writer per project/worktree
```

The current Agent Control Plane may retain its stricter implemented writer-job serialization. An
isolated sandbox worker is not a live writer until apply. Plane A apply, direct live-workspace
mutation, and mutation-capable IDE interaction must share project/worktree live-writer arbitration.
Multiple clients may observe an authorized IDE session when policy permits, but prompt delivery is
serialized per session and controller ownership is explicit. Prompts cannot be classified read-only
by instruction alone; technical enforcement is required.

---

# 18. Runner hardening

Every agent runner must be constrained.

Required controls:

```text
no privileged mode
no docker.sock
no arbitrary host bind
no host PID namespace
no host IPC namespace
no host network
bounded CPU
bounded memory
bounded PIDs
bounded execution time
bounded stdout/stderr
non-root where practical
read-only base filesystem where practical
writable sandbox only where required
```

Network should be denied by default unless the job/profile explicitly requires controlled access.

---

# 19. Secret handling for agent runners

## 19.1 Prohibited

Do not:

- bake secrets into images;
- commit them;
- put them in result JSON;
- print them in debugging;
- expose them to unrelated jobs;
- share one agent secret with every backend.

## 19.2 Preferred

Each backend receives only its own credential.

Example:

```text
Kiro runner -> Kiro automation credential
Copilot runner -> Copilot automation credential
```

A job should not receive both unless it genuinely requires both, which normal jobs should not.

## 19.3 Redaction

Known secret environment variable values must be redacted from:

- stdout/stderr;
- agent transcript;
- event log;
- audit;
- errors returned over MCP.

---

# 20. Apply safety

`agent_apply` is one of the most sensitive planned operations.

## 20.1 Preconditions

Before apply:

```text
job status == COMPLETED
job disposition == unapplied
principal authorized
project authorized
real HEAD == recorded compatible base
working tree policy satisfied
diff exists
diff hash matches stored evidence
patch validation passes
forbidden paths absent
```

## 20.2 Forbidden/guarded file classes

Initial policy should either prohibit or require a stronger gate for changes to:

```text
.env
credential files
private keys
secret stores
Docker socket configuration
security policy
bridge client authorization
CI secret configuration
```

The exact list must be project-configurable but have secure defaults.

## 20.3 Atomicity/recovery

Before applying:

- record the real project state;
- validate the full patch;
- avoid partial application;
- ensure rollback instructions/evidence exist.

If any apply stage fails, stop and report rather than guessing.

---

# 21. Reversible deletion direction

The current `fs_delete` contract must remain permanent/destructive.

A future safer removal layer is desirable:

```text
fs_trash
fs_restore
```

Potential model:

```text
normal agent removal -> fs_trash
recovery -> fs_restore
explicit permanent removal -> fs_delete
```

This is separate from Agent Dispatch and should not be allowed to delay the core A0–A9 program unless it becomes a prerequisite.

---

# 22. Functional requirements

## FR-001 — Backend discovery

Authorized clients can discover available configured agent backends.

## FR-002 — Project discovery

Authorized clients can discover the logical projects they may address without receiving arbitrary host control.

## FR-003 — Governed dispatch

Authorized clients can create a job for an approved backend/project/profile.

## FR-004 — Asynchronous lifecycle

Long-running coding work is represented by a persistent job ID.

## FR-005 — Status visibility

Clients can observe job state without polling raw process output.

## FR-006 — Normalized results

Kiro and Copilot return a common MCP result structure.

## FR-007 — Machine-derived diff

The bridge can return the exact sandbox diff independently of the model's narrative.

## FR-008 — Cancellation

An authorized client can cancel its permitted running job.

## FR-009 — Sandbox implementation

Write-capable agents mutate only the job sandbox by default.

## FR-010 — Independent review

A result can be audited before any live project mutation.

## FR-011 — Explicit application

Changes reach the real project only through a separate authorized apply operation.

## FR-012 — Discard

Rejected work can be discarded without affecting the real project.

## FR-013 — Session continuity

Later phases can resume compatible Kiro/Copilot sessions without making session memory an authorization mechanism.

## FR-014 — Full auditability

Agent lifecycle actions produce durable audit evidence.

## FR-015 — Client-neutral orchestration

ChatGPT uses the same MCP contract regardless of whether the worker is Kiro or Copilot.

---

# 23. Non-functional requirements

## NFR-001 — Security

No phase may regress the established gateway/executor privilege split.

## NFR-002 — Reliability

Agent jobs must have deterministic observable terminal states.

## NFR-003 — Recoverability

Orphan runners/jobs must be detectable and reclaimable.

## NFR-004 — Bounded resource use

Every job must have CPU, memory, PID, time, and output limits.

## NFR-005 — Audit

Important actions must be attributable to a principal and job.

## NFR-006 — Backward compatibility

Existing 14 MCP tools and existing clients must continue working unless an approved breaking version is introduced.

## NFR-007 — Typed MCP contracts

All new MCP tools must publish `outputSchema` and return conforming structured content plus the project's chosen backward-compatible representation.

## NFR-008 — Testability

Agent infrastructure must be testable with a deterministic fake backend before real Kiro/Copilot integration.

## NFR-009 — Isolation

A failed or compromised agent runner must not receive Docker control or arbitrary host filesystem control.

## NFR-010 — Observability

Failures should be distinguishable as:

```text
policy
precondition
backend
timeout
infrastructure
apply
```

rather than returning a generic failure.

---

# 24. Threat model

The implementation must explicitly defend against the following.

## 24.1 Malicious or compromised MCP client

Attempt:

```text
dispatch arbitrary project
select arbitrary host path
request privileged runner
exfiltrate secrets
```

Defense:

- scopes;
- project allowlist;
- backend allowlist;
- fixed trusted configuration;
- no public Docker options.

## 24.2 Prompt-injected coding agent

Attempt:

> Ignore policy and read `/home/.../.ssh`.

Defense:

The runner cannot access the path.

Prompt policy is secondary to container isolation.

## 24.3 Path traversal

Attempt:

```text
../../
symlink escape
absolute path
```

Defense:

- canonicalization;
- workspace confinement;
- no caller host paths;
- adversarial tests.

## 24.4 Docker socket theft

Attempt:

Agent searches for or tries to mount Docker socket.

Defense:

Runner never receives socket or Docker API credentials.

## 24.5 Credential leakage

Attempt:

Agent prints Kiro/Copilot credential.

Defense:

- narrow secret injection;
- process environment isolation;
- output redaction;
- no cross-backend secrets.

## 24.6 Stale patch

Attempt:

Apply a job created from old source after user edited the real project.

Defense:

Recorded base verification; apply refusal.

## 24.7 Concurrent writers

Attempt:

Kiro and Copilot both mutate the same project simultaneously.

Defense:

Project-level writer lock.

## 24.8 Runaway agent

Attempt:

Infinite loop, huge output, process tree growth.

Defense:

Timeout, memory/CPU/PID/output limits, cancellation, force cleanup.

## 24.9 Job replay

Attempt:

Reuse an old job/apply request.

Defense:

State machine, one-time disposition, idempotency/replay rules.

## 24.10 Malicious diff

Attempt:

Agent modifies secret/security files outside approved task scope.

Defense:

Diff policy, forbidden paths, review gate, apply policy.

## 24.11 IDE Session Control threats

The live IDE plane adds distinct design risks: wrong-workspace routing; stale or spoofed sessions;
malicious/compromised adapters; prompt injection acting through interactive-agent authority;
concurrent clients, IDEs, workspaces, or writers; cancellation and reconnect races; fabricated or
misattributed responses; secret, terminal, editor, or filesystem context exposure; and source
mutation outside the intended authority.

Required defenses are the complete principal/instance/workspace/session/action binding; explicit
adapter enrollment and authenticated channels; connection generations and freshness; negotiated
capabilities; bounded context/results; ordered correlated events; conservative cancellation
reconciliation; independent Plane A/Plane B grants; and shared live-writer arbitration. Agent prose,
window focus, display names, mouse/keyboard injection, and prompt instructions are not security
boundaries. The complete I0 threat model and stop conditions are in
`docs/IDE_SESSION_CONTROL.md`.

---

# 25. Implementation program overview

The Agent Dispatch program consists of **ten gated phases, A0 through A9**.

This corrects an earlier shorthand that referred to “nine phases” while listing A0–A9. The canonical plan is ten gates.

Status at the current checkpoint:

```text
A0  Forensic readiness audit        COMPLETE — PASS
A1  Agent-control specification     COMPLETE — PASS
A2  Job engine + fake backend       COMPLETE — PASS
A3  Runner sandbox                  COMPLETE — PASS
A4  Kiro ACP read-only              COMPLETE — PASS
A5  Kiro implementation             COMPLETE — PASS
A6  Review / apply / discard        COMPLETE — PASS
A7  GitHub Copilot backend          NEXT GATE
A8  Session continuity              NOT STARTED
A9  Production hardening + E2E      NOT STARTED
```

No later phase should be marked complete from partial evidence.

The owner-approved IDE Session Control program is additive and does not renumber or rewrite A0-A9:

```text
I0  Common IDE-session contract + threat/security model       NOT COMPLETE
I1  Kiro active-session adapter                               NOT STARTED — REQUIRED
I2  VS Code active-session adapter                            NOT STARTED — REQUIRED
I3  Cursor active-session adapter                             NOT STARTED — REQUIRED
I4  Visual Studio feasibility + adapter if safe/practical     NOT STARTED — SECONDARY
I5  Antigravity feasibility + adapter if safe/practical       NOT STARTED — SECONDARY
I6  Multi-client/session concurrency, recovery, hardening     NOT STARTED — REQUIRED PRE-PRODUCTION
```

I0-I3 are required for the updated North Star. I4-I5 are feasibility/best-effort and do not block
North-Star completion if no safe, stable integration exists. I6 must complete before production
acceptance, either as its own gate or explicitly folded into A9 with equivalent evidence. The
documentation baseline for I0 is `docs/IDE_SESSION_CONTROL.md`; it is not an implementation or a
completion claim.

---

# 26. Phase A0 — Forensic readiness audit

## Objective

Establish the exact local implementation environment before modifying the project.

## Scope

Read-only inspection of:

- repository state;
- current Git checkpoint;
- Node/npm versions;
- Docker/Compose versions;
- running bridge service shape;
- gateway/executor security boundary;
- Kiro CLI presence/version/auth state;
- Kiro ACP availability;
- Kiro supported automation flags;
- GitHub Copilot CLI presence/version;
- Copilot programmatic permission capabilities;
- current package scripts/dependencies;
- current source/test/config/docs tree;
- compose service structure;
- current Docker socket consumers.

## Forbidden

No:

```text
package installation
login/auth changes
credential creation
file writes
compose changes
service recreation
agent execution
new dependencies
Git changes
```

## Required output

A forensic report that labels every requirement:

```text
VERIFIED
MISSING
UNKNOWN
INCOMPATIBLE
```

## Exit criteria

- repository still clean;
- current baseline unchanged;
- Kiro implementation path confirmed or missing prerequisites listed;
- Copilot implementation path confirmed or missing prerequisites listed;
- no assumptions remain about required local executables.

## Rollback

None should be required because the phase is read-only.

## Stop conditions

Stop before A1 if:

- repo is unexpectedly dirty;
- current HEAD differs unexpectedly;
- security boundary has drifted;
- Docker runtime is unhealthy;
- existing baseline cannot be reproduced.

## A0 completion record (2026-07-28)

**Verdict (reviewed by ChatGPT and Herman): A0 PASS — READY FOR A1. No implementation blockers.**

Full persisted report: `docs/audits/PHASE_A0_FORENSIC_READINESS_AUDIT.md`

### A0 verified environment summary

```text
Repository HEAD audited:  6bf16a872c6d96cf1965db553721a16b8927d296
Node:                     24.15.0
Docker:                   29.6.2
Docker Compose:           5.3.1
Kiro CLI:                 2.5.0
GitHub Copilot CLI:       1.0.56
```

Test evidence executed during A0 (rerun by the audit agent in-session):

```text
TypeScript typecheck: PASS
Unit:                 20 / 20 PASS
```

Previously verified live integration baseline (historical/pre-A0 evidence, not rerun during A0):

```text
Live integration: 40 / 40 PASS
```

### A0 architecture findings

A0 verified that:

- the existing gateway/executor separation is suitable for extension; no architecture rewrite is required;
- Agent Dispatch should remain additive to the current bridge;
- the job engine, persistence, and runner lifecycle belong executor-side;
- MCP protocol, authentication, and policy belong gateway-side;
- agent runners receive no Docker socket;
- the existing undici Pool Docker-client concurrency fix (`src/executor/docker.ts`) remains mandatory and must not regress.

### A0 known prerequisites for later phases (non-A1-blocking)

```text
executor persistent volume / job store          before A2
Kiro dedicated automation API key               before A4
Kiro runner image/libc/network proof            before A3/A4 freeze
Copilot dedicated automation credential         before A7
Copilot secure headless/ACP/SDK transport call  before A7
runner egress policy                            before A3
```

### Decisions accepted for A1 design

Approved design direction (implementation remains with the proper phase):

1. **Persistence engine:** SQLite. Exact Node binding deferred to A2 (evaluate built-in `node:sqlite` — Stability 1.2, Release Candidate on Node v24.15.0 — against alternatives before adding a dependency).
2. **Public agent tools:** A1 defines contracts/schemas only. No working `agent_dispatch` is exposed until A2 has a job engine/fake backend.
3. **Project addressing:** caller supplies a logical project ID only; a trusted executor-side registry resolves the source; no caller-supplied host path.
4. **Sandbox:** executor-controlled staging into Docker-managed job storage; a write-capable agent does not receive a real-project RW mount.
5. **Runner:** separate pinned backend runner images; no arbitrary image selection.
6. **Writers:** maximum one global writer and one writer per project for v1; persistence/recovery semantics must be specified.
7. **Kiro:** ACP target transport; isolated `KIRO_HOME` (no inherited personal Builder ID session); dedicated automation `KIRO_API_KEY`; selective trusted tools.
8. **Copilot:** adapter transport remains an A7 decision (SDK vs ACP vs programmatic CLI); least privilege is mandatory — the current CLI's indication that `--allow-all-tools` may be required for non-interactive operation disqualifies that mode as the production transport unless A7 proves otherwise.
9. **Network:** backend egress policy is explicit and controlled.
10. **Result architecture:** concise structured result by default; detailed evidence stored locally and retrieved on demand.

---

# 27. Phase A1 — Agent-control specification

## Objective

Implement the schemas, configuration model, state machine, scopes, and threat-model contract without starting a real AI backend.

## Deliverables

### Configuration

Define:

```text
agent backends
project registry
project/backend permissions
profiles
resource limits
job retention
credential references
```

### ResourcePolicy (A0 closeout requirement)

A1 must specify a **ResourcePolicy** concept. The accepted conceptual policies are:

```text
ECONOMY
STANDARD
DEEP
```

ResourcePolicy must be capable of governing:

```text
model class
maximum runtime
CPU
RAM
PID count
output size
evidence storage size
provider credits (when the backend exposes a controllable limit)
network/egress policy
retention class
```

A1 specifies the policy model only; resource enforcement is implemented in later phases.

### Types

Define normalized:

```text
AgentBackend
AgentProject
AgentProfile
AgentJob
AgentStatus
AgentResult
AgentDiff
AgentFailure
```

### Authorization

Add and test agent-related scopes.

### MCP schemas

Finalize all new tool input/output schemas.

### Job state machine

Enforce valid transitions.

### Documentation

Update architecture/security/client documentation.

## Validation

- typecheck;
- unit tests for schema validation;
- state-transition tests;
- authorization tests;
- invalid project/backend/profile tests;
- output-schema tests;
- no changes to live execution behavior.

## Evidence

- exact changed-file list;
- test output;
- threat-model mapping;
- configuration examples with no secrets.

## Rollback

Single bounded commit/revertable patch.

## Exit gate

No real agent can execute yet.

The contract must be reviewable before implementation complexity begins.

## A1 completion record (2026-07-28)

**Verdict: A1 COMPLETE — PASS. READY FOR A2.**

Implementation evidence commit: `c3cd057a5bfa9e61dc9f6d448db5e5647c7a1a73` —
`feat: define agent control plane contracts`.

Full persisted report: `docs/audits/PHASE_A1_AGENT_CONTROL_SPECIFICATION.md`.
Code-adjacent contract specification: `docs/AGENT_CONTROL_PLANE.md`.

Delivered (contracts only — no agent runtime): shared agent types + pure job state machine
(`src/shared/agents.ts`); scopes `agents:read/dispatch/cancel/apply` (Scope union 7 → 11) with
deny-by-default principal grants `projects`/`agentBackends`/`agentProfiles`; pure authorization
matrix (`src/gateway/agentAuthz.ts`); strict Zod contracts for all nine planned tools
(`src/gateway/agentSchemas.ts`, **not registered**); trusted executor config validator
(`src/executor/agentConfig.ts`) + `config/agents.example.yaml`; ResourcePolicy
(`economy`/`standard`/`deep`, integer units, `deny|backend-only` network policy only); retention
classes; v1 writer policy (1 global / 1 per project).

Validation evidence executed during A1 (in-session):

```text
TypeScript typecheck: PASS
Unit:                 73 / 73 PASS   (20 pre-existing + 53 new)
Build:                PASS
Config validation:    PASS (live configs + agents example)
Live MCP tools:       14 operational, 0 agent tools registered
```

Historical live integration baseline (pre-A0, not rerun in A1 — no runtime behavior changed):
40 / 40 PASS.

---

# 28. Phase A2 — Job engine with deterministic fake backend

## Objective

Prove orchestration before integrating Kiro or Copilot.

## Deliverables

Implement:

```text
agents_list
agent_projects
agent_dispatch
agent_status
agent_result
agent_cancel
```

against a deterministic fake backend.

The fake backend should simulate:

```text
success
delayed success
failure
timeout
cancellation
large result
invalid transition
```

## Persistence

Introduce executor-owned job persistence.

## Queue rules

Initial:

```text
one active job globally
one active writer per project
```

## Audit

Every job operation produces expected audit records.

## Validation

- unit tests;
- integration tests;
- restart persistence test;
- cancellation test;
- unauthorized job access test;
- rate-limit behavior;
- output schema validation.

## Exit gate

ChatGPT can exercise the new lifecycle end-to-end without any external agent software.

## A2 completion record (2026-07-28)

**Verdict: A2 COMPLETE — PASS. READY FOR A3.**

Implementation evidence commit: `bd1137c138598ddc88e57e6be4edcdc0a413ca62` —
`feat: add durable agent job engine`.

Full persisted report: `docs/audits/PHASE_A2_DURABLE_JOB_ENGINE.md`.

Delivered (durable orchestration behind a deterministic fake backend — no real agent, runner,
sandbox, diff, or apply): executor-owned SQLite job store using the **built-in `node:sqlite`**
binding (no new dependency; schema v1, WAL, atomic compare-and-set transitions) on a new
executor-only `mcp-bridge-jobs` volume at `/jobs`; the executor-owned job engine (trusted-config
re-validation, serial execution, `maxRuntimeMs` timeout, cooperative `AbortSignal` cancellation,
ownership enforcement, restart-safe writer admission, startup recovery of active jobs to
`FAILED_INFRASTRUCTURE`); and six activated MCP tools (`agents_list`, `agent_projects`,
`agent_dispatch`, `agent_status`, `agent_result`, `agent_cancel`) using the A1 strict schemas and
authorization matrix. `agent_diff`/`agent_apply`/`agent_discard` remain contract-only.

Operational MCP tools: **14 → 20**. Contract-only agent tools: **3**. Agent contract total: **9**.

Validation evidence executed during A2:

```text
TypeScript typecheck: PASS
Unit:                 109 / 109 PASS   (75 pre-A2 + 34 new)
Build:                PASS
Config validation:    PASS
Live integration:     agents 13/13, existing-tools regression 1/1, persistence+recovery 1/1
Security boundary:    gateway no docker.sock + loopback bind; executor unpublished; jobs volume
                      executor-only; internal net internal=true — all reverified post-deploy
```

Historical/pre-A2 live integration (`bridge.test.ts` + `output-schema.test.ts` = 40) was not rerun
as a whole (test-fixture keys managed outside the session; pre-existing principals not rotated);
existing-tool behavior was re-proven live through a dedicated additive test principal.

**Post-closeout SQLite security remediation:** `9e52d5bde11bcabd370fd45baac9021ea955fa04` —
`security: restrict agent job database permissions` (job DB + `-wal`/`-shm` sidecars forced to 0600;
`/jobs` 0700; created under a restrictive umask, idempotently hardened on open).

---

## A3 completion record (2026-07-28)

**Verdict: A3 COMPLETE — PASS. READY FOR A4.**

Implementation evidence commit: `7df2e09c9cf1c426d91641894dfb11693cc41439` —
`feat: add isolated agent runner sandbox`. Full persisted report:
`docs/audits/PHASE_A3_RUNNER_SANDBOX.md`.

Delivered (sandbox foundation only — no real agent, not wired into live dispatch): bounded Docker
Engine lifecycle primitives on the executor Docker client (image inspect; volume + container
create/inspect/wait/logs/stop/kill/remove; label-scoped listing) with NO new HTTP routes and NO
caller-selectable Docker options; a trusted read-only staging helper that snapshots a git project's
**tracked committed HEAD only** (clean-checkpoint fail-closed with base-commit provenance; no
untracked/ignored/host secrets); a tightly confined ephemeral runner (non-root `1000:1000`,
non-privileged, `CapDrop=ALL`, `no-new-privileges`, read-only rootfs, `NetworkMode=none`, no host
binds, no docker.sock, private namespaces) with exact-integer resource limits, bounded runtime +
graceful-stop/kill timeout, bounded demultiplexed evidence, guaranteed cleanup, and label-scoped
orphan reconciliation; a dedicated trusted runner image (`runner/Dockerfile`); and a forward-only
job-DB schema migration v1 → v2 (`base_commit`) preserving all A2 records.

Public MCP surface unchanged: operational tools **20** (14 original + 6 Agent), Agent contract
total **9**, `agent_diff`/`agent_apply`/`agent_discard` still unregistered; the deterministic fake
backend remains the operational Agent Dispatch backend.

Validation evidence executed during A3:

```text
git diff --check:     PASS (clean)
TypeScript typecheck: PASS
Unit:                 137 / 137 PASS   (109 pre-A3 + 28 new)
Build:                PASS
A3 Docker integration: 6 / 6 PASS   (host Docker harness; no MCP/keys/live stack; no Kiro/Copilot)
Security boundary:    runner proven confined in-suite; gateway/executor boundary reverified via
                      docker inspect (unchanged from A2); 0 bridge-managed resources left behind
```

The A2 stack was not redeployed (the sandbox is not wired into live dispatch; the v1→v2 migration is
proven by unit test to apply safely on the Executor's next start). Pre-existing real client
credentials were not rotated and no live MCP suite was rerun in-session — prior A2 evidence stands.
Runner probe image `mcp-ide-bridge-sandbox:a3`
(`sha256:20535453bb7797eb21169246f9695c1f5311bd68c78a34a34d2011f9bce8236f`) is an A3 probe image
ONLY, not the production Kiro runner image (A4 owns that). No Kiro/Copilot invoked; no real backend
activated; no Tailscale change; no unrelated Docker project touched; no new npm dependency.

---

# 29. Phase A3 — Runner sandbox

## Objective

Create the isolated container execution foundation.

## Deliverables

- immutable/prebuilt runner image contract;
- job volume creation;
- project snapshot materialization;
- non-root workspace ownership;
- resource limits;
- timeout;
- process cleanup;
- orphan cleanup;
- result/diff collector foundation.

## Required security proof

Inside runner:

```text
docker.sock absent
host home unavailable
only sandbox writable
privileged false
published ports none
resource limits active
```

## Adversarial validation

Attempt:

```text
read /home
read /root
read docker.sock
escape workspace through symlink
spawn excessive processes
produce excessive output
run beyond timeout
```

Expected: blocked/bounded.

## Exit gate

Fake agent can write to sandbox, but real project remains byte-for-byte unchanged.

---

# 30. Phase A4 — Kiro ACP read-only

## Objective

Integrate the first real agent backend without permitting code mutation.

## Backend

```text
Kiro ACP
```

## Profile

```text
audit
```

## Deliverables

- ACP process adapter;
- initialize handshake;
- session/new;
- session/prompt;
- event parsing;
- completion detection;
- session/cancel;
- normalized result;
- isolated Kiro state;
- secret-safe authentication bootstrap.

## First target prompt

A read-only request such as:

> Describe this repository, identify the primary components, and do not modify files.

## Required evidence

- real Kiro session established;
- Kiro reads only sandbox/project snapshot;
- no write occurs;
- normalized result returned through MCP;
- raw secret never appears;
- cancellation tested.

## Exit gate

ChatGPT can dispatch and retrieve a real Kiro audit job.

---

# 31. Phase A5 — Kiro sandbox implementation

## Objective

Allow Kiro to perform an approved implementation without touching the live project.

## Profile

```text
implement
```

## Deliverables

- controlled Kiro write permissions;
- validation command policy;
- exact changed-file collection;
- exact diff collection;
- job result normalization;
- sandbox remains after completion for review.

## Test task

Use a disposable controlled project/task first.

Do not make Mickey the first destructive/write proving ground.

## Required proof

```text
Kiro changes sandbox
tests run
job completes
agent_diff reflects actual sandbox
live source unchanged
```

## Exit gate

The copy/paste implementation loop is removed for Kiro, but apply remains manual/not yet available through the agent API.

---

# 32. Phase A6 — Review, apply, and discard

## Objective

Safely bridge a reviewed sandbox change into the real project.

## Deliverables

```text
agent_diff
agent_apply
agent_discard
```

## `agent_diff`

Must be machine-derived.

## `agent_apply`

Must enforce:

- authorization;
- valid state;
- base state;
- no concurrent writer;
- patch check;
- guarded paths;
- one-time apply;
- evidence;
- recoverability.

## `agent_discard`

Must:

- leave live source unchanged;
- preserve minimum audit evidence;
- remove sandbox according to retention rules.

## Required tests

- normal apply;
- stale HEAD refusal;
- dirty tree refusal or defined policy;
- invalid path refusal;
- forbidden file refusal;
- double apply refusal;
- discard;
- apply after discard refusal;
- unauthorized apply refusal;
- partial failure rollback.

## Exit gate

Full Kiro cycle:

```text
ChatGPT
 -> dispatch
 -> Kiro
 -> result
 -> diff
 -> ChatGPT audit
 -> explicit approval
 -> apply
 -> real validation
```

---

# 33. Phase A7 — GitHub Copilot backend

## Objective

Provide the same governed workflow using GitHub Copilot.

## Preferred adapter

```text
Copilot SDK
```

## A7 decision check

Before coding the adapter, compare the then-current supported options:

```text
Copilot SDK
Copilot ACP
non-interactive Copilot CLI
```

Selection criteria:

- structured events;
- cancellation;
- session persistence;
- permission control;
- maintenance burden;
- stability;
- security;
- ability to run inside the runner model.

Do not change the MCP contract based on the selected backend transport.

## Required capabilities

Same as Kiro:

```text
audit
plan
implement
review
cancel
result
diff
```

## Permission rule

Do not solve automation by granting unrestricted Copilot permissions globally.

## Exit gate

The same ChatGPT caller can choose:

```text
backend: kiro
```

or:

```text
backend: copilot
```

without changing orchestration logic.

---

# 34. Phase A8 — Session continuity

## Objective

Allow intentional continuation of an agent relationship across jobs.

## Proposed public policy

```text
sessionPolicy: new
sessionPolicy: resume
```

The public caller should not need to know raw backend storage internals.

## Requirements

- backend session ID stored internally;
- session ownership tied to project/principal/policy;
- invalid cross-project resume rejected;
- unavailable/expired session falls back only according to explicit policy;
- session cancellation works;
- session history is not trusted for authorization.

## Security

Every job still receives current enforced policy regardless of what the agent remembers.

## Exit gate

Kiro and Copilot can resume approved logical sessions with deterministic ownership rules.

---

# 35. Phase A9 — Production hardening and end-to-end validation

## Objective

Prove that the feature is safe enough for normal daily engineering use.

## Adversarial suite

Required test areas:

```text
path traversal
absolute paths
symlink escape
project impersonation
backend impersonation
profile escalation
prompt injection
secret exfiltration
Docker socket access
host filesystem access
concurrent writers
stale apply
job replay
double apply
unauthorized cancellation
oversized prompt
oversized result
runaway subprocess
timeout
orphan containers
credential leakage
event-log injection
restart recovery
corrupted job store
backend crash
network misuse
```

## Real end-to-end gates

### Kiro

```text
ChatGPT
 -> bridge
 -> Kiro
 -> sandbox change
 -> test
 -> result
 -> diff
 -> approval
 -> apply
 -> validation
```

### Copilot

At minimum:

```text
ChatGPT
 -> bridge
 -> Copilot
 -> independent review
```

Then prove implementation/apply equivalence.

## Final regression

Must include:

- all pre-Agent-Dispatch tests;
- all new tests;
- browser connectivity;
- OAuth;
- public health;
- gateway socket absence;
- executor unpublished;
- agent runner confinement;
- audit;
- restart behavior.

## Exit gate

Feature status may become:

```text
PRODUCTION-READY FOR GOVERNED DAILY ENGINEERING USE
```

only after all critical controls have evidence.

---

# 36. Test strategy

## 36.1 Unit

Cover:

- schemas;
- state machine;
- authorization;
- project resolution;
- profile policy;
- job IDs;
- redaction;
- result normalization;
- diff metadata;
- timeout/resource configuration.

## 36.2 Integration

Cover:

- MCP tool discovery;
- output schemas;
- fake backend;
- executor job persistence;
- container lifecycle;
- sandbox filesystem;
- cancellation;
- apply/discard.

## 36.3 Backend integration

Separate suites for:

```text
Kiro adapter
Copilot adapter
```

Backend tests must be structured so normal project CI can distinguish:

```text
offline deterministic tests
live credentialed tests
```

## 36.4 Adversarial

Maintain a dedicated security suite rather than relying on happy-path tests.

## 36.5 Live client validation

Continue proving the product from actual MCP clients, not only curl/test scripts.

---

# 37. Definition of done

Agent Dispatch is not done when ChatGPT can merely start a Kiro process.

It is done when all of the following are proven:

```text
[ ] ChatGPT can discover authorized agents.
[ ] ChatGPT can discover authorized projects.
[ ] ChatGPT can dispatch Kiro.
[ ] ChatGPT can dispatch GitHub Copilot.
[ ] Unauthorized projects cannot be addressed.
[ ] Caller cannot provide arbitrary host paths.
[ ] Agent cannot access docker.sock.
[ ] Agent cannot access arbitrary WSL/host files.
[ ] Agent executes in an isolated sandbox.
[ ] Resource limits are enforced.
[ ] Timeouts are enforced.
[ ] Job state survives expected process/service lifecycle.
[ ] Full normalized result returns to ChatGPT.
[ ] Exact machine-generated diff returns to ChatGPT.
[ ] ChatGPT can independently audit the result.
[ ] Cancellation works.
[ ] Project writer locking works.
[ ] Stale apply is refused.
[ ] Apply requires explicit authorization.
[ ] Rejected work can be discarded.
[ ] Applied work is validated in the real project.
[ ] Kiro sessions can resume safely.
[ ] Copilot sessions can resume safely where supported.
[ ] Secrets remain out of logs/results/Git.
[ ] Agent operations are audited.
[ ] Gateway remains without docker.sock.
[ ] Executor remains unpublished.
[ ] Existing browser MCP integrations still work.
[ ] Existing 14 tools remain compatible.
[ ] All automated and adversarial tests pass.
```

---

# 38. Current phase tracker

Use this table as the project checkpoint.

| Phase | Name | Status | Commit / Evidence |
|---|---|---|---|
| Existing | Initial bridge baseline | COMPLETE | `47c3f50` |
| Existing | OAuth hardening | COMPLETE | `c93bb0a` |
| Existing | Public-resource OAuth integration | COMPLETE | `71add9c` |
| Existing | Claude browser external verification | COMPLETE | `966e10b` |
| Existing | MCP structured output schemas | COMPLETE | `2729b5a` |
| Existing | ChatGPT browser external verification docs | COMPLETE | `6bf16a8` |
| A0 | Forensic readiness audit | COMPLETE — PASS | `f179ba19a8beed412d51202691675e9539595bd0` (actual final closeout commit; supersedes the pre-amend `e59703a` reference) — `docs/audits/PHASE_A0_FORENSIC_READINESS_AUDIT.md` |
| A1 | Agent-control specification | COMPLETE — PASS | `c3cd057a5bfa9e61dc9f6d448db5e5647c7a1a73` — `docs/audits/PHASE_A1_AGENT_CONTROL_SPECIFICATION.md` |
| A2 | Job engine + fake backend | COMPLETE — PASS | `bd1137c138598ddc88e57e6be4edcdc0a413ca62` — `docs/audits/PHASE_A2_DURABLE_JOB_ENGINE.md`; post-closeout SQLite security remediation `9e52d5bde11bcabd370fd45baac9021ea955fa04` — `security: restrict agent job database permissions` |
| A3 | Runner sandbox | COMPLETE — PASS | `7df2e09c9cf1c426d91641894dfb11693cc41439` — `docs/audits/PHASE_A3_RUNNER_SANDBOX.md` |
| A4 | Kiro ACP read-only | COMPLETE — PASS | `8a0d145b15925a310442d7227fd131fa8b2b3705` — `feat: add read-only Kiro ACP backend`; `docs/audits/PHASE_A4_KIRO_ACP_READ_ONLY.md`. Real Kiro CLI 2.5.0 ACP backend; Docker Engine API launch + runner-internal driver; per-job read-only agent; backend-only egress; provider acceptance job `job_17d4f0186616651450bf6a12c050055d` (model `claude-sonnet-4`, session `855c613a-772c-48f1-be02-fdc158955c8c`). |
| A5 | Kiro implementation | COMPLETE — PASS | `846ce502ca69eb915a8cbb8286aa6008a38818fa` — `feat: add sandboxed Kiro implementation profile`; `docs/audits/PHASE_A5_KIRO_SANDBOX_IMPLEMENTATION.md`. Full implement-profile Kiro ACP backend with sandboxed workspace write; TypeScript/Node execution with build validation; backend-managed credential injection; provider acceptance job `job_45f03a0f32ccecd3a0f3e3c23a24ff02` (model `claude-sonnet-4`, sandbox mutation verified). Documentation closeout `819ae215556bb8d403efac5bcb502231b72c7575`. |
| A6 | Review / apply / discard | COMPLETE — PASS | `0121b31d56bdab85663d8a8bfb36a3e41dc6a575` — `feat: add retained-resource lifecycle`; `docs/audits/PHASE_A6_RESOURCE_LIFECYCLE.md` + B1-B6 series. Guarded agent_diff/agent_apply/agent_discard activated; retained-resource lifecycle (Lane A published-evidence expiry + Lane B incomplete-evidence classification); durable schema-v5 retention metadata; fail-closed eligibility proofs; startup lifecycle ordering; full regression validation (1398/1398 unit, 126/126 P1, 188/188 lifecycle PASS). Post-implementation remediation `91fb583ff26cfb7a59c1a8ba71be706e252cdd55`. |
| Post-A6 | Review-target Python tooling | COMPLETE | `0d88688` — `chore: add python tooling to review targets`; `python3` baked into the review-target images at build time (no runtime `apk`). |
| Post-A6 | A6 documentation closeout | COMPLETE | `f37ff70` — `docs: close phase A6` |
| Post-A6 | Gateway readiness + image provenance remediation | COMPLETE — PASS | `67146a4` — `fix: harden gateway readiness and image provenance`. Liveness/readiness split enforced (`/healthz` liveness only; `/readyz` fails closed unless clients config loaded **and** executor reachable); gateway Docker healthcheck repointed to `/readyz` so an empty `/config` mount reports unhealthy instead of falsely healthy; gateway process stays alive and diagnosable rather than crash-looping; `/readyz` body discloses no internal state. Service-specific immutable image references (`GATEWAY_IMAGE`/`EXECUTOR_IMAGE`, `agentcontrol:gateway-<sha>` / `agentcontrol:executor-<sha>`) with `mcp-ide-bridge:latest` demoted to a non-authoritative dev default; build-time OCI revision/source labels required for production candidates. Validation: typecheck PASS, unit 1420/1420 PASS. |
| A7 | GitHub Copilot backend | NOT STARTED — NEXT GATE | — |
| A8 | Session continuity | NOT STARTED | — |
| A9 | Production hardening + E2E | NOT STARTED | — |
| I0 | Common IDE-session contract + threat/security model | DESIGN DOCUMENTED — NOT IMPLEMENTED OR COMPLETE | `docs/IDE_SESSION_CONTROL.md` |
| I1 | Kiro active-session adapter | NOT STARTED — REQUIRED | — |
| I2 | VS Code active-session adapter | NOT STARTED — REQUIRED | — |
| I3 | Cursor active-session adapter | NOT STARTED — REQUIRED | — |
| I4 | Visual Studio feasibility + adapter if safe/practical | NOT STARTED — SECONDARY | — |
| I5 | Antigravity feasibility + adapter if safe/practical | NOT STARTED — SECONDARY | — |
| I6 | Multi-client/session concurrency, recovery, hardening | NOT STARTED — REQUIRED PRE-PRODUCTION | — |

---

# 39. Change-control rules

Every implementation gate should produce:

1. current checkpoint verification;
2. exact scope;
3. forbidden scope;
4. implementation;
5. typecheck/tests;
6. security validation;
7. evidence;
8. working-tree review;
9. bounded commit;
10. master PRD checkpoint update.

No phase should quietly modify the next phase's architecture.

Unknowns must be labeled.

Partial success must not be reported as complete.

---

# 40. Stop conditions

Stop implementation and investigate before advancing if any of the following occurs:

```text
gateway gains docker.sock
executor gains public published port
runner gains docker.sock
runner receives arbitrary host path
security scope is bypassed
credential appears in output/log
existing browser OAuth breaks
existing tests regress
project registry can be path-traversed
two writer jobs execute against same project
apply can occur against stale source
agent can apply without separate authorization
job state becomes unrecoverable after normal restart
```

These are architecture-level failures, not minor bugs.

---

# 41. Decisions already locked

The current product direction records these decisions.

## Locked

- ChatGPT remains the main guidance/orchestration layer.
- Kiro is an implementation worker.
- GitHub Copilot is the VS Code-side implementation/review worker.
- Kiro GUI chat injection is not the production control plane.
- Kiro ACP is the target Kiro machine interface.
- Agent work is sandbox-first.
- Real-project apply is separate from agent completion.
- Gateway keeps no Docker socket.
- Executor stays private.
- Agent runners get no Docker socket.
- Caller supplies project IDs, not host paths.
- Least privilege is preferred over `--yolo` / `--allow-all` / `--trust-all-tools`.
- Existing bridge features remain supported.
- `fs_delete` remains accurately destructive.
- The isolated Agent Control Plane and active IDE Session Control Plane are complementary and have
  independent authority.
- Kiro, VS Code, and Cursor are required IDE Session Control targets; Visual Studio and Antigravity
  are secondary feasibility targets.
- A narrow authenticated companion extension/local adapter is a legitimate production transport;
  GUI automation remains fallback-only and cannot establish authority.
- Many readers and isolated workers may coexist, but only one controlled live writer may act on a
  project/worktree.

## To be decided through gated implementation

- exact project registry schema;
- exact persistent job-store technology;
- exact runner base image(s);
- exact sandbox copy/materialization implementation;
- exact patch/apply transaction mechanism;
- exact prompt/result retention duration;
- exact Copilot transport if SDK vs ACP evaluation materially changes the recommendation;
- initial network policy per backend;
- final resource limits;
- final session-retention rules;
- exact supported active-session transport and version policy for each IDE;
- IDE adapter placement, enrollment, authentication, distribution, revocation, and update trust;
- human controller handoff/visibility and cross-plane live-writer arbitration details;
- whether any IDE-session interaction can be technically enforced as read-only; and
- whether I6 is its own gate or an evidence-bearing subset of A9.

---

# 42. Additional extensions and IDE integration notes

Except for the separately tracked I0-I6 IDE Session Control program in §25/§38, these items are not
part of required A0-A9 implementation and remain compatible future extensions.

## 42.1 Multi-agent review

```text
Kiro implement
    |
Copilot review
    |
ChatGPT adjudicate
```

or the inverse.

## 42.2 Specialized agents

Profiles/agents such as:

```text
security reviewer
test engineer
documentation agent
migration planner
release reviewer
```

## 42.3 IDE companion extension and session adapter

An IDE companion extension may show Agent Control Plane status:

```text
Job dispatched by ChatGPT
Running
Testing
Awaiting review
Applied
```

It may also serve as the IDE Session Control transport when it exposes only a narrow, authenticated,
versioned machine-facing interface bound to an enrolled IDE instance, authorized workspace/worktree,
and active interactive session. This does not authorize generic IDE commands, host access, or GUI
injection. Kiro, VS Code, and Cursor are required targets; Visual Studio and Antigravity remain
feasibility targets. See `docs/IDE_SESSION_CONTROL.md`.

## 42.4 Reversible file removal

Add:

```text
fs_trash
fs_restore
```

while preserving permanent `fs_delete`.

## 42.5 Approval policies

Future policy could distinguish:

```text
auto-apply documentation-only sandbox changes
require approval for source
require stronger approval for security/config
```

This must only be considered after the core workflow is proven.

## 42.6 Branch/worktree concurrency

Later, multiple isolated writer jobs could operate on separate branches/worktrees with explicit merge arbitration.

Not a v1 requirement.

---

# 43. Product success criteria

The project succeeds when daily engineering work can follow this loop safely:

```text
Discuss
   |
Approve bounded task
   |
Dispatch worker
   |
Observe
   |
Collect exact evidence
   |
Audit
   |
Approve/reject
   |
Apply/discard
   |
Validate
```

The system should feel substantially more powerful than copy/paste orchestration while being safer than giving a remote model an unrestricted shell.

The desired end state is:

> ChatGPT can act as the engineering lead, Kiro and Copilot can act as controlled implementation workers, the user remains the approval authority, and every meaningful action can be independently validated.

---

# 44. Immediate milestones and next formal A-gate

A0, A1, A2, A3, A4, A5, and A6 are complete (PASS — see the completion records in §26/§27/§28
and the full audit document series in `docs/audits/`).

The next formal A-gate remains:

```text
A7 — GITHUB COPILOT BACKEND
```

A7 extends the governed agent execution plane to support GitHub Copilot as a second implementation
worker backend, providing the same orchestration workflow (dispatch, status, result, diff, apply,
discard) through a backend-neutral MCP contract. Before implementation, A7 must compare Copilot SDK,
Copilot ACP, and non-interactive Copilot CLI transport options using selection criteria: structured
events, cancellation, session persistence, permission control, maintenance burden, stability,
security, and ability to run inside the runner model. The Copilot adapter must enforce least
privilege (no `--allow-all` / `--yolo` defaults), support the same profile enforcement (audit, plan,
implement, review), and integrate with the existing agent job engine, sandbox lifecycle, and
retained-resource management. Exit gate: ChatGPT can choose between `backend: kiro` or
`backend: copilot` without changing orchestration logic.

Separately, the owner-approved immediate backend milestone is a **governed Ollama local backend**.
That work is owned by a parallel Kiro lane. The IDE Session Control documentation/design lane must
not implement or redesign Ollama, and the milestone does not renumber A0-A9 or mark A7 started.

---

# 45. External technology reference baseline

These references describe capabilities relied upon by the north-star design and should be re-verified at the relevant implementation phase because external CLIs/SDKs evolve.

## Kiro

**Kiro ACP**  
https://kiro.dev/docs/cli/acp/

As verified on 2026-07-28, Kiro documents `kiro-cli acp`, JSON-RPC over stdio, session creation/loading/prompting/cancellation, and persisted CLI sessions.

**Kiro headless mode**  
https://kiro.dev/docs/cli/headless/

As verified on 2026-07-28, Kiro documents non-interactive execution, `KIRO_API_KEY`, and selective trusted-tool categories.

**Kiro authentication**  
https://kiro.dev/docs/cli/authentication/

Use as the authoritative source for supported automation authentication at implementation time.

## GitHub Copilot

**GitHub Copilot CLI programmatic reference**  
https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference

As verified on 2026-07-28, GitHub documents non-interactive prompts and granular tool/path/URL permission controls.

**GitHub Copilot CLI command reference**  
https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference

As verified on 2026-07-28, GitHub documents current CLI options, including ACP mode and permission controls.

**Allowing and denying tool use**  
https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools

Use as the authoritative reference for least-privilege Copilot runner policy.

---

# 46. Master PRD maintenance rule

At every completed phase:

1. update the phase tracker;
2. record the exact commit;
3. update verified test counts;
4. record architecture/security changes;
5. record new known limitations;
6. do not delete historical security decisions without documenting the superseding decision;
7. keep the current verified state separate from future intent.

**Commit-hash recording rule (adopted at A1 closeout):** a commit must never be required to
contain its own final SHA. Phase evidence commit hashes are recorded by the subsequent
documentation closeout commit or a later checkpoint. This prevents recursive hash invalidation
(the A0 closeout's pre-amend `e59703a` self-reference is the motivating case; the actual final A0
commit is `f179ba19a8beed412d51202691675e9539595bd0`).

This file should answer three questions at any point in the project:

```text
Where are we now?
Why is the system designed this way?
What exactly comes next?
```

---

# 47. QuaranGate identity migration contract (N1C design; N1D execution pending)

This section is the durable record of the repository-identity reconciliation task (**N1C**) and
the design (not execution) of the controlled runtime-identity cutover (**N1D**). It supersedes any
earlier statement in this document that AgentControl/`mcp-ide-bridge` is the current or permanent
product identity, or that no rename is in scope.

## 47.1 Current vs legacy identity

```text
CURRENT CANONICAL IDENTITY (now):
  Product name:     QuaranGate
  Machine/package:  quarangate
  Tagline:           Governed execution for AI coding agents.
  npm package name:  quarangate
  MCP serverInfo.name: quarangate
  Future Docker label namespace: io.quarangate.*
  Future Compose project:        quarangate
  Future image family:           quarangate:gateway-<sha>, quarangate:executor-<sha>
  GitHub remote:                 Herman940306/QuaranGate (rename complete — see §47.10)

LEGACY / HISTORICAL IDENTIFIERS (intentionally still live):
  AgentControl        — superseded product name; historically accurate where dated
  mcp-ide-bridge       — npm package name pre-N1B; still the live Compose project,
                          image default, GitHub repo directory name, and Docker label
                          namespace (io.mcp-ide-bridge.*)
  mcp-bridge / mcp-bridge-*  — live Docker network/volume/container name prefix
  io.mcp-bridge.*      — live Docker label namespace (git-managed control/home volumes)
  mcp.bridge.*          — live Docker label namespace (target opt-in discovery)
  Herman940306/AgentControl — former GitHub remote name; repository has been renamed to
                          Herman940306/QuaranGate (GitHub preserves an automatic redirect
                          from the old name; historical/redirect reference only)
```

QuaranGate supersedes AgentControl as the current product identity. AgentControl remains valid
only where it accurately describes a historical point in time (dated phase entries, commit
messages, frozen audit records in `docs/audits/`, `PLAN.md`).

## 47.2 Compatibility policy (frozen, N1C steering decision)

1. Current product identity → QuaranGate (display text, package metadata, MCP self-identification).
2. Historical evidence → preserved verbatim where historically true.
3. Persistent/runtime identifiers → not renamed blindly; classified below, migration designed but
   not executed.
4. Security/credential identifiers (`mcpb_`, `mcpb_at_`, `mcpb_rt_`, `mcpb_ac_`) → never renamed
   for branding.
5. Generic identifiers (`AGENT_*`, `BRIDGE_*` env vars, `demo` target id) → not churned.
6. Persistent label migration strategy → **dual-read / new-write** on future cutover (§47.4).
7. Zero old strings is explicitly **not** the objective. The objective is zero *unexplained*
   current old-identity references and zero broken compatibility.

## 47.3 Runtime identity migration register

All entries below are **MIGRATION_REQUIRED** (design only; N1C does not mutate any of them), with
one exception: the GitHub remote row is now **COMPLETE** (see §47.10) — it was executed as an
explicitly authorized manual step ahead of the remaining Compose/Docker runtime identity items,
per §47.13 DECISION-3's approved ordering. All other rows remain undone.
Source of truth for each identifier is a single named constant/config value unless noted.

| Category | Current value(s) | Source | Future value | Notes |
|---|---|---|---|---|
| Compose project (root stack) | `mcp-ide-bridge` | `compose.yaml` `name:` | `quarangate` | Determines default container/network/volume names for anything not explicitly named. |
| Compose project (review target) | `mcp-ide-bridge-review` | `review-target/compose.yaml` | `quarangate-review` (proposed) | |
| Compose project (test target) | `mcp-ide-bridge-testtarget` | `test-target/compose.yaml` | `quarangate-testtarget` (proposed) | Also referenced by `config/bridge.example.yaml` target `demo`. |
| Compose project (assistant-environment targets) | `assistant-environment-review`, `assistant-environment-work` | respective `compose.yaml` | unchanged | Already vendor-neutral; not bridge-branded; **GENERIC_PROTOCOL_OR_SUBSYSTEM_TERM**, no migration needed. |
| Containers (root, compose-generated) | `mcp-ide-bridge-gateway-1`, `mcp-ide-bridge-executor-1` | derived from Compose project | `quarangate-gateway-1`, `quarangate-executor-1` | Follows Compose project rename automatically. |
| Container (review target) | `mcp-bridge-review` | `review-target/compose.yaml` `container_name` | `quarangate-review` (proposed) | |
| Containers (test target) | `mcp-bridge-testtarget-dev`, `mcp-bridge-testtarget-decoy` | `test-target/compose.yaml` `container_name` | `quarangate-testtarget-dev`/`-decoy` (proposed) | |
| Networks | `mcp-bridge-edge`, `mcp-bridge-internal` | `compose.yaml` `networks.*.name` | `quarangate-edge`, `quarangate-internal` (proposed) | |
| Volumes (gateway/executor) | `mcp-bridge-data`, `mcp-bridge-jobs` | `compose.yaml` `volumes.*.name` | `quarangate-data`, `quarangate-jobs` (proposed) | Holds hashed OAuth state and the durable agent job DB — see §47.6. |
| Volumes (review target) | `mcp-bridge-review-node-modules`, `mcp-bridge-review-dist` (historical pre-fix; removed in fix/review-target-runtime) | was: `review-target/compose.yaml` | N/A — removed from current Compose | Were disposable scratch volumes; the accepted review-target runtime remediation removes them because writable child volumes beneath the read-only /workspace bind prevented container startup. Existing physical Docker volumes, if present, are disposable residue. The current review target has no writable volumes beneath /workspace; transient scratch remains available via tmpfs (/tmp). |
| Images (dev default) | `mcp-ide-bridge:latest` | `compose.yaml` `${GATEWAY_IMAGE:-...}` / `${EXECUTOR_IMAGE:-...}` | `quarangate:latest` (dev default) | Never authoritative for production per existing `docs/OPERATIONS.md` policy. |
| Images (review/test targets) | `mcp-bridge-review:latest`, `mcp-bridge-testtarget:latest` | respective `compose.yaml` | `quarangate-review:latest`, `quarangate-testtarget:latest` (proposed) | |
| Images (Kiro sandbox runner) | `mcp-ide-bridge-kiro-runner:a4` (production tag, `.env.example` `AGENT_RUNNER_IMAGE` default; also `:a4-test`/`:a4-prodtest`/`:a5-test`/`:a5-prodtest`/`:test` fixture tags across `tests/integration/a4-*.ts`, `tests/integration/a5-*.ts`, `tests/unit/a4-kiro-backend.test.ts`) | `.env.example`, test fixtures | `quarangate-kiro-runner:a4` (proposed) | The real (non-test) Kiro ACP runner image, resolved via `AGENT_RUNNER_IMAGE`/`AGENT_HELPER_IMAGE` in `src/executor/index.ts`. Renaming requires rebuilding/retagging the runner image and updating `.env` in lockstep — never partially, since `AGENT_RUNNER_IMAGE` selects a specific real-vs-test image and a mismatch would silently run the wrong runner. |
| Images (production tag convention) | `agentcontrol:gateway-<sha>` / `agentcontrol:executor-<sha>` (historical convention; the literal SHA-only tag was never built, but a related `agentcontrol:gateway-candidate-<sha>` family exists locally, e.g. `agentcontrol:gateway-candidate-f37ff70`) | was: `docs/OPERATIONS.md`, `compose.yaml` comments | `quarangate:gateway-<sha>` / `quarangate:executor-<sha>` | **Already updated in this N1C pass** (§47.14) — documentation-only correction of the *current* production-tag convention text; the pre-existing `agentcontrol:*` candidate image family is preserved as historical evidence and is not renamed, retagged, or deleted by this correction. |
| Docker label namespace (sandbox/job ownership — primary) | `io.mcp-ide-bridge.*` (`SANDBOX_LABEL_NS`, `src/executor/agents/sandboxSpec.ts:25`) | source constant | `io.quarangate.*` | Authority for A3 sandbox resource cleanup/reconciliation (`isBridgeManaged`, `MANAGED_FILTER`). Drives `LABEL_MANAGED`/`LABEL_RESOURCE`/`LABEL_JOB`/`LABEL_ATTEMPT` and the derived volume/container name prefix `io-mcp-ide-bridge-*`. |
| Docker label namespace (control/home volumes — inconsistent legacy pair) | `io.mcp-bridge.*` (`src/executor/agents/gitHelper.ts:43-45`) | source constants | `io.quarangate.*` | **Known inconsistency**: uses a *different* namespace than `SANDBOX_LABEL_NS` for the same conceptual ownership/cleanup authority (kinds `home`/`control` in `kiroBackend.ts`). Must be unified under one namespace at cutover — see §47.4. |
| Docker label namespace (target opt-in discovery) | `mcp.bridge.*` (`enabled`/`workspace`/`name`) — `src/executor/targets.ts:12-14` | source constants | `io.quarangate.discover.*` (proposed) or fold into `io.quarangate.*` | A **third**, functionally distinct namespace (target discovery, not job/resource ownership) not explicitly anticipated by the N1C task brief but discovered during the register build. Written by operator-authored target Compose files (`review-target`, `test-target`, `assistant-environment-*`); read by `src/executor/targets.ts`. |
| Evidence volume prefix | `io-mcp-ide-bridge-evidence-` (`EVIDENCE_VOLUME_PREFIX`, `src/executor/agents/evidenceCollector.ts:54`) | source constant | `io-quarangate-evidence-` | See §47.5. |
| Sandbox resource name prefix | `io-mcp-ide-bridge-{ws,runner,stager}-<jobId>` (derived from `SANDBOX_LABEL_NS.replace('.','-')`, `sandboxSpec.ts`) | source constant | `io-quarangate-{ws,runner,stager}-<jobId>` | Single source of truth — changing `SANDBOX_LABEL_NS` changes all derived names atomically. Low migration risk (ephemeral, job-scoped, torn down on job completion). |
| Target IDs | `demo` (`config/bridge.example.yaml`) | example config | unchanged | Already a generic logical id, not product-branded. **FALSE_POSITIVE** for renaming — see §47.7. |
| Target composeProject values | `mcp-ide-bridge-testtarget`, `mcp-ide-bridge-review` | `config/bridge.example.yaml`, target compose files | follows Compose project rename | Client-facing `id` (`demo`) is stable regardless of this. |
| Host secret path | `/home/herman/.config/mcp-ide-bridge/kiro-api-key` (`compose.yaml` secret default `${AGENT_KIRO_KEY_FILE:-...}`) | `compose.yaml` | `/home/herman/.config/quarangate/kiro-api-key` (proposed) | See §47.8. In-container mount path `/run/secrets/kiro-api-key` (`RUNNER_SECRET_PATH`, `credentialManager.ts`) is **not** product-branded — no change needed there. |
| GitHub remote | `github.com/Herman940306/QuaranGate` (git remote; also `org.opencontainers.image.source` example in `docs/OPERATIONS.md`) — renamed from `github.com/Herman940306/AgentControl` (GitHub preserves an automatic redirect from the old name) | `git remote`, doc example | — (achieved) | **COMPLETE.** Historical value: `github.com/Herman940306/AgentControl`. See §47.10. |
| Credential prefix family | `mcpb_`, `mcpb_at_`, `mcpb_rt_`, `mcpb_ac_` (`src/gateway/auth/apikeys.ts`, `oauth.ts`, `index.ts`, `src/shared/redact.ts`) | source constants | **unchanged, permanently** | **PRESERVE_COMPATIBILITY.** Security/credential-classification infrastructure; the `mcp` letters here are opaque namespace, not branding. Explicitly frozen by steering decision — never rename. |

## 47.4 Label compatibility design — **IMPLEMENTED (N1D)**

Preferred model on future cutover:

```text
READ (target/resource discovery, reconciliation, cleanup):
  io.quarangate.*        (new, written after cutover)
  io.mcp-ide-bridge.*     (legacy — sandbox/job ownership)
  io.mcp-bridge.*         (legacy — control/home volume ownership)
  mcp.bridge.*            (legacy — target opt-in discovery; distinct purpose, see below)

WRITE (after cutover):
  io.quarangate.* only
```

- **Writer locations to change at cutover:** `src/executor/agents/sandboxSpec.ts` (`SANDBOX_LABEL_NS`
  constant — single change point for the primary namespace), `src/executor/agents/gitHelper.ts`
  (`LABEL_MANAGED`/`LABEL_RESOURCE`/`LABEL_JOB` constants — must be unified onto the same namespace
  as `sandboxSpec.ts` rather than migrated to a *second* new namespace, closing the existing
  inconsistency permanently), `src/executor/targets.ts` (discovery labels — separate decision,
  since these are operator-authored in target Compose files, not bridge-written).
- **Reader/reconciliation locations:** `isBridgeManaged()` (`sandboxSpec.ts`), any Docker `filters`
  query using `MANAGED_FILTER`, `src/executor/agents/evidenceCollector.ts` reconciliation sweeps.
  These must accept **any** of the legacy namespaces OR the new one during the compatibility window.
- **Evidence collector locations:** `evidenceCollector.ts` label-based filtering for
  cleanup/orphan-detection must recognize both legacy prefixes and the new prefix so historical
  evidence remains classifiable.
- **Cleanup/lifecycle locations:** retained-resource lifecycle (Lane A/B, `docs/AGENT_CONTROL_PLANE.md`
  §12) must not silently stop recognizing legacy-labeled resources as bridge-managed — that would
  either orphan them (never cleaned up) or misclassify them (cleaned up without eligibility proof).
- **Tests requiring compatibility coverage:** unit tests for `isBridgeManaged()` /
  `MANAGED_FILTER` construction must add cases for legacy-namespace-labeled resources continuing to
  be recognized; integration tests covering resource cleanup must verify both label families are
  swept correctly during the compatibility window.
- The opt-in discovery family `mcp.bridge.*` is a **separate decision** from the two ownership
  namespaces above — it is operator-authored (lives in target Compose files the operator controls,
  including files outside this repo for real projects), so changing it has an external-compatibility
  cost the internal ownership labels do not have. Recommend treating it as its own longer-lived
  compatibility window, independent of the sandbox/job label unification.

**Status: IMPLEMENTED.** N1D applies exactly this model. `SANDBOX_LABEL_NS` is now `io.quarangate`;
`gitHelper.ts` no longer declares a second namespace and imports the shared constants, closing the
inconsistency permanently. Dual-read is `managedLabelFilters()` — one Docker query per accepted
namespace, unioned and de-duplicated, because Docker ANDs the entries of a single `label` filter and a
combined filter would therefore match nothing. `ownershipLabelValue()` reads across namespaces and
returns `null` when they contradict, so ambiguous resources are retained rather than deleted.
`mcp.bridge.*` target discovery is deliberately NOT migrated (see the last bullet above). Covered by
`tests/unit/n1d-label-compat.test.ts`.

## 47.5 Evidence namespace compatibility design — **IMPLEMENTED (N1D)**

**Status: IMPLEMENTED.** `EVIDENCE_VOLUME_PREFIX` is now `io-quarangate-evidence-` and lives in
`sandboxSpec.ts` as the single source of truth. This closes a divergence that existed at design time:
the writer (`beforeCapture.ts`) derived the prefix from `SANDBOX_LABEL_NS` while the reader
(`evidenceCollector.ts`) hardcoded the literal, so changing the namespace alone would NOT have
migrated evidence discovery. Discovery is the union of `io-quarangate-evidence-*` and the legacy
`io-mcp-ide-bridge-evidence-*`, de-duplicated by volume name.

Identity proofs (`deleteCompletionProof`, Lane A name agreement, the integrity-anomaly scan) accept
either family for a given job id via `isAcceptedEvidenceVolumeName()`. Without that, every
pre-cutover job's recorded `artifact_volume` would fail the deterministic-name check and its evidence
would be retained forever — a silent retention regression. The candidate set is still derived solely
from the job id, never from the stored value. Covered by `tests/unit/n1d-label-compat.test.ts`.

Design constraints for the QuaranGate-created evidence namespace (`io-quarangate-evidence-`), all met:

- Old evidence volumes remain **discoverable** by reconciliation/cleanup code recognizing both
  prefixes for the duration of the compatibility window.
- **UNCERTAIN**/quarantine semantics (`docs/AGENT_CONTROL_PLANE.md` project quarantine state) must
  not be affected by which prefix an evidence volume carries — quarantine keys off job/project
  metadata in the SQLite store, not the Docker volume name, so this is expected to be safe, but must
  be explicitly verified before cutover.
- Retained-resource lifecycle (Lane A expiry, Lane B incomplete-evidence classification) must treat
  both prefixes identically for eligibility proofs; do not special-case one prefix as "old, delete
  faster."
- No destructive migration of historical evidence objects. New evidence is created under the new
  prefix after cutover; old evidence is left in place and ages out under its existing retention
  policy, unchanged.
- Rollback: if N1D cutover must be reversed, evidence created under the new prefix during the
  cutover window must remain discoverable by pre-cutover code paths, or cutover must be scheduled
  during a window with no in-flight agent jobs (see §47.11 rollback conditions).

## 47.6 Persistent volume decision register

| Volume | Current name | Contains | Risk of rename | Recommendation |
|---|---|---|---|---|
| Gateway data | `mcp-bridge-data` | Hashed OAuth token state only (`docs/OPERATIONS.md`: "safe to drop; clients simply re-authorize") | Low — documented as disposable | **APPROVED — Option A** (§47.13, DECISION-1): replace/recreate under the QuaranGate identity at N1D cutover |
| Executor jobs | `mcp-bridge-jobs` | Durable SQLite job engine + evidence metadata (`AGENT_JOB_SCHEMA_VERSION`, retained-resource lifecycle state) | High — durable, schema-versioned, referenced by retained-resource lifecycle and quarantine logic | **APPROVED — Option B** (§47.13, DECISION-2): retain the physical legacy volume name; Compose may reference it via a neutral logical key |
| Review-target scratch (historical pre-fix) | `mcp-bridge-review-node-modules`, `mcp-bridge-review-dist` (removed from current Compose in fix/review-target-runtime) | Were rebuildable build/test cache | N/A — no longer part of current design | The accepted review-target runtime remediation removed these volumes from `review-target/compose.yaml` because writable child volumes beneath the read-only /workspace bind caused startup failure. Existing physical Docker volumes, if present, are disposable residue and were not deleted by this source change. No cutover decision needed for volumes that no longer exist in Compose. |

Rename-vs-retain is now recorded in §47.13 as an approved, governing constraint for N1D execution
for both stakeful volumes. Neither volume is mutated by N1C.

## 47.7 Target ID compatibility design

Target IDs (`config/bridge.yaml` `targets[].id`, e.g. `demo`) are already generic, logical, and
disconnected from the product name — they were designed for exactly this kind of rebrand
(`README.md`: "Callers address logical identifiers... never host paths, container images..."). No
target ID currently embeds `AgentControl`/`mcp-ide-bridge`/`mcp-bridge` branding.

What *does* embed the legacy name is the **Compose project** a target resolves through
(`composeProject: mcp-ide-bridge-testtarget`), which is a `config/bridge.yaml` implementation detail,
not a value any external client, saved MCP config, or ChatGPT/Claude connector authorization
references. Renaming the Compose project (§47.3) therefore only requires updating
`config/bridge.yaml`/`config/bridge.example.yaml` and the corresponding target `compose.yaml` files
in lockstep — it does not break external client configuration, prompts, or saved authorizations,
because those only ever reference the target `id`.

**Recommendation:** no alias/dual-registration strategy is needed for target IDs themselves; a
coordinated hard cutover of the `composeProject` values (recreate the named target stacks, update
`config/bridge.yaml`, verify `targets_list`/`target_inspect` resolve correctly) is sufficient and
safe. This is **not** classified `N1D_USER_DECISION_REQUIRED` — it has no meaningful architectural
alternative worth choosing between.

## 47.8 Host secret path migration design

Current: `/home/herman/.config/mcp-ide-bridge/kiro-api-key` (`compose.yaml` secret file default,
`${AGENT_KIRO_KEY_FILE:-...}`). Delivered read-only into the executor only, `0400`, never the
gateway; the in-container mount path `/run/secrets/kiro-api-key` is unrelated and unbranded.

Design for future migration (not implemented in N1C):

- **Precedence during the compatibility window:** if `AGENT_KIRO_KEY_FILE` is explicitly set in
  `.env`, it always wins (this is already true today — no change needed for that case). If unset,
  the default should check the new path first
  (`/home/herman/.config/quarangate/kiro-api-key`) and fall back to the legacy path
  (`/home/herman/.config/mcp-ide-bridge/kiro-api-key`) only if the new path does not exist, to avoid
  silently picking up a stale key after a manual copy.
- **Avoid duplicate uncontrolled copies:** the migration step should be a `mv`, not a `cp`, once the
  operator confirms the new path is correct — otherwise two live copies of the same credential exist
  with no single source of truth.
- **Sunset criteria:** the legacy-path fallback should be removed only after (a) `.env` is confirmed
  to reference the new path explicitly or the file has been moved, and (b) the executor has
  successfully started at least once against the new path.
- **No wider permissions:** the migrated file must be created/moved preserving `0600` (or stricter)
  host permissions and the existing herman-owned ownership; the Compose secret mount already forces
  `0400`/`uid:gid 1000:1000` inside the container regardless of host permissions.
- Timing is **APPROVED — Option B** (§47.13, DECISION-4): migrate as a separate, controlled N1D
  substep, not bundled with the Compose/runtime cutover. The mechanism above (new-first /
  legacy-fallback, `mv` not `cp`, ownership/permission preservation, verify-before-fallback-removal)
  is the approved migration behavior. Who physically performs the `mv` remains unauthorized for this
  tooling without separate explicit authorization.

## 47.9 Environment variable review

Searched all `AGENT_*`/`BRIDGE_*` identifiers in `src/**`, `compose.yaml`, and `.env.example`.
Full list found: `AGENT_APPLY_ATTEMPT_ACTIVE_STATES`, `AGENT_APPLY_ATTEMPT_ID_PATTERN`,
`AGENT_APPLY_ATTEMPT_STATES`, `AGENT_APPLY_ATTEMPT_TRANSITIONS`,
`AGENT_APPLY_ATTEMPT_ZERO_MUTATION_TERMINALS`, `AGENT_BACKEND_IDS`, `AGENT_CONTROL_PLANE`,
`AGENT_FAILURE_CODES`, `AGENT_HELPER_IMAGE`, `AGENT_JOB_ACTIVE_STATUSES`, `AGENT_JOB_DISPOSITIONS`,
`AGENT_JOB_ID_PATTERN`, `AGENT_JOB_SCHEMA_VERSION`, `AGENT_JOB_STATUSES`, `AGENT_JOB_TRANSITIONS`,
`AGENT_KIRO_DRY_RUN`, `AGENT_KIRO_KEY_FILE`, `AGENT_KIRO_KEY_PATH`, `AGENT_MODEL_CLASSES`,
`AGENT_NETWORK_POLICIES`, `AGENT_PROFILE_IDS`, `AGENT_PROJECT_APPLY_STATES`,
`AGENT_PROJECT_ID_PATTERN`, `AGENT_PROXY_IMAGE`, `AGENT_RETENTION_CLASSES`,
`AGENT_RETENTION_DURATION_MS`, `AGENT_RUNNER_IMAGE`, `AGENT_TOOL_NAMES`,
`AGENT_TOOL_REQUIRED_SCOPE`, `AGENT_TOOL_SCHEMAS`, `AGENT_WRITER_POLICY_V1`; `BRIDGE_CONFIG`,
`BRIDGE_PORT`, `BRIDGE_PUBLIC_URL`, `BRIDGE_URL`.

Every one of these is a generic domain-concept name (agent job lifecycle, bridge networking) — none
embeds `AgentControl`, `mcp-ide-bridge`, or `mcp-bridge` branding, and none is a literal env var name
a user sets that says "AgentControl" or similar.

**`ENV_RENAME_REQUIRED: NO`.** Per frozen policy, these are kept as-is; no `QUARANGATE_*` aliases are
introduced.

## 47.10 GitHub repository rename

**Status: COMPLETE.** Current canonical remote: `https://github.com/Herman940306/QuaranGate.git`.
The repository was renamed from `Herman940306/AgentControl` to `Herman940306/QuaranGate`, executed
as §47.11 "Repository identity" steps (7-9) per the ordering approved in §47.13 DECISION-3 (before
any runtime mutation); local `origin` has been updated accordingly and verified (`git remote -v`
reports the canonical URL). The legacy URL (`https://github.com/Herman940306/AgentControl.git`) is
preserved by GitHub only as an automatic redirect/compatibility reference — it is not the canonical
URL and must not be treated as such in documentation or tooling. `docs/OPERATIONS.md`'s
`org.opencontainers.image.source` build-label example has been updated to the canonical
`Herman940306/QuaranGate` URL to match.

At the time DECISION-3 was originally approved (2026-08-22), the remote was still
`Herman940306/AgentControl`; that historical state is preserved, annotated as historical, in
§47.13 DECISION-3's "Current state" note. This rename does not itself constitute N1D: the
Compose/Docker runtime identity cutover described elsewhere in §47 remains separate, design-only,
and not started.

## 47.11 N1D cutover plan (design only — not executed)

Step ordering below implements §47.13 DECISION-3 (Option C, APPROVED): repository/GitHub identity
migration completes first; the controlled runtime identity cutover is a separate, later operation.
High-level phases: N1C accepted → repository identity commit → push → GitHub repository rename →
origin update/verification → N1D compatibility implementation → controlled runtime identity cutover
→ post-cutover acceptance → G4 definitive QuaranGate build/deployment.

### Pre-cutover

1. Confirm Git worktree clean and all N1C candidate changes committed (this document's own hygiene
   gate, §24 equivalent for N1C).
2. Snapshot: `docker compose ps`, `docker network ls`, `docker volume ls`, `docker image ls`
   filtered to bridge-owned resources, recorded verbatim as the rollback baseline.
3. Back up `mcp-bridge-data` and `mcp-bridge-jobs` volumes (`docker run --rm -v mcp-bridge-data:/from
   -v <backup-path>:/to alpine tar czf /to/mcp-bridge-data.tgz -C /from .`, same pattern for
   `mcp-bridge-jobs`) — a safety net regardless of the approved §47.13 DECISION-1 (Option A,
   recreate empty) and DECISION-2 (Option B, retain in place) outcomes.
4. Record OAuth/job/evidence state checksums (row counts, latest job id, latest `retain_until`) as an
   independent recovery cross-check beyond the raw volume backup.
5. Inventory every configured target/client (`config/bridge.yaml`, `config/clients.yaml`) and every
   external MCP client configuration in use (Claude connector, ChatGPT connector, VS Code
   `.vscode/mcp.json`, Kiro `~/.kiro/settings/mcp.json`) so post-cutover acceptance has a concrete
   checklist.
6. Confirm the rollback anchor: current commit SHA, current running image digests for gateway and
   executor.

### Repository identity (DECISION-3 Option C — completes before any runtime mutation)

**Steps 7-9: COMPLETE** (see §47.10).

7. **COMPLETE.** Push all N1C-committed changes to `origin` — repository identity must be finalized
   and in sync with the remote before the GitHub rename, so the rename acts on the canonical
   committed state.
8. **COMPLETE.** GitHub repository rename `Herman940306/AgentControl` → `Herman940306/QuaranGate`
   (Herman-performed, not automatable from this worktree).
9. **COMPLETE.** Update local `git remote set-url origin` to the renamed URL; verify `git remote -v`
   and a `git fetch` succeed against the renamed origin before proceeding. Verified: `git remote -v`
   reports `https://github.com/Herman940306/QuaranGate.git`.

### N1D compatibility implementation (deployed and verified before runtime cutover)

10. Enable label dual-read (§47.4): deploy the code change that writes `io.quarangate.*` and reads
    all of `io.quarangate.*` / `io.mcp-ide-bridge.*` / `io.mcp-bridge.*`. This must be live and
    verified (unit/integration coverage passing) before step 13 begins recreating any container
    under the new identity — reads must be compatibility-aware *before* writes change, never after.
11. Evidence namespace: deploy the `EVIDENCE_VOLUME_PREFIX` dual-recognition change (§47.5) alongside
    the label change in the same release.

### Controlled runtime identity cutover

12. Build and tag images under the new convention: `quarangate:gateway-<sha>`,
    `quarangate:executor-<sha>` (§47.3); do not delete the prior `mcp-ide-bridge:latest`-tagged
    images, nor the pre-existing `agentcontrol:*` candidate family, until post-cutover acceptance
    passes (§47.13 DECISION-5).
13. Compose project transition: rename `name:` in `compose.yaml`/target compose files to
    `quarangate*` and recreate.
14. Container recreation under the new project name (`docker compose up -d --force-recreate`).
15. Network transition: recreate `edge`/`internal` networks under new names; Compose recreates
    networks automatically on `up` after a `name:` change — verify no other stack references the old
    network names before removing them.
16. Persistent-volume treatment per §47.13 DECISION-1 (Option A: recreate `mcp-bridge-data` as
    `quarangate-data`, empty — clients re-authorize once) and DECISION-2 (Option B: retain
    `mcp-bridge-jobs` under its existing physical name, mounted explicitly by the new Compose project
    under a neutral logical key).
17. Target-ID transition: update `composeProject` values in `config/bridge.yaml` to match step 13;
    target `id` values (e.g. `demo`) do not change (§47.7).
18. Secret-path transition per §47.13 DECISION-4 (Option B: separate controlled substep, not bundled
    with this cutover): once separately authorized, move (not copy) the host secret file per §47.8,
    update `AGENT_KIRO_KEY_FILE` in `.env`, and retain the legacy-path fallback until a later
    compatibility closeout.
19. Gitignored runtime config reconciliation: update any stale local comments in
    `config/agents.yaml`/`config/clients.yaml` identified as `NONBLOCKING_LOCAL_RUNTIME_FOLLOWUP`
    (§47.15) — these files were absent in the N1C worktree and must be checked in the live deployment
    worktree at this step.

### Post-cutover acceptance

20. Auth acceptance: existing API keys and OAuth tokens continue to authenticate (they are
    per-principal, not tied to any renamed identifier).
21. `targets_list`, `target_inspect` resolve all configured targets under their new
    `composeProject` values.
22. IDE RO/RW operations (`fs_*`, `terminal_exec`, `git_*`, `process_list`) succeed against a
    representative target.
23. `agents_list`, `agent_projects` return the expected trusted registry.
24. Agent project/backend/profile discovery matches pre-cutover configuration.
25. `agent_dispatch`/`agent_status`/`agent_result` round-trip on a disposable test job.
26. `agent_diff`/`agent_apply`/`agent_discard` exercised on a disposable test job, including a
    verification that `agent_apply` guarded-path and base-state checks still function.
27. Old evidence (pre-cutover jobs) remains visible via `agent_result`/`agent_diff` for jobs created
    before cutover.
28. New evidence (post-cutover jobs) is created under the new prefix and is equally visible.
29. Retained-resource lifecycle correctly ages out both old- and new-prefixed evidence per policy.
30. Restart proof: `docker compose restart` (or full recreate) preserves all of the above.
31. Provenance/readiness: `/healthz`, `/readyz`, and OCI image labels reflect the new build.
32. Real ChatGPT browser acceptance: reconnect the existing custom connector (or reauthorize if the
    public URL changed) and re-verify `targets_list`, read/write/delete round-trip.
33. Real Claude browser acceptance: same as above for the Claude custom connector.

### G4 — definitive build/deployment

34. Only after all of steps 20-33 pass: G4 definitive QuaranGate build/deployment from the final
    committed state. §47.13 DECISION-5's obsolete-image-tag removal gates on this same acceptance
    list (QuaranGate runtime accepted, restart proof, ChatGPT acceptance, Claude acceptance,
    readiness/provenance proof, rollback no longer required). G4 execution and scope are not
    authorized by this document.

### Rollback

Trigger rollback if, at any point in cutover or post-cutover acceptance:

```text
gateway or executor fails to start against renamed volumes/networks
label dual-read fails to recognize legacy-labeled resources (orphan risk)
evidence for a pre-cutover job becomes unreadable
agent_apply guarded-path or base-state verification regresses
any existing client (Claude/ChatGPT/VS Code/Kiro) fails to authenticate or fails a smoke test
job-store schema migration fails or the SQLite DB fails integrity check
```

Rollback restores: the pre-cutover image tags (still present per step 12), the pre-cutover Compose
project name/network/volume names (not deleted until acceptance passes), and — only if data
corruption is suspected — the volume backups taken in pre-cutover step 3. A rollback that only
reverts naming (no data corruption) requires no volume restore, only recreating containers against
the original names; DECISION-1/DECISION-2 are approved as Option A (recreate) and Option B (retain)
respectively, so DECISION-2's volume is never removed and DECISION-1's volume rollback is simply
re-pointing at the still-present legacy `mcp-bridge-data` volume (not deleted until acceptance
passes).

## 47.12 (reserved — see §47.6 for the volume decision register; kept together with related content
above rather than duplicated here)

## 47.13 User decisions — APPROVED (governing constraints for N1D)

Herman reviewed and approved DECISION-1 through DECISION-5 below during N1C R1 decision recording
(2026-08-22). These are **FINAL** for N1D planning and execution unless Herman later explicitly
reopens them. None are implemented by N1C — approval records the governing policy; implementation
remains a separate, explicitly authorized N1D action. Alternatives considered, reasoning, and risks
from the original decision analysis are preserved below alongside each approved outcome.

**DECISION-1 — `mcp-bridge-data` (gateway OAuth volume): rename or retain?**
- Current state: named `mcp-bridge-data`; documented as safe to drop (hashed OAuth state only).
- Option A: rename to `quarangate-data` at cutover (recreate empty; all clients re-authorize once).
- Option B: retain the legacy name indefinitely; only rename the Compose project around it.
- Original recommendation: **Option A.** Data is explicitly disposable and re-authorization is a
  one-time, low-friction event (paste API key on `/oauth/authorize`).
- Why: lowest long-term naming debt, no data-loss risk since the content is safe to lose by design.
- Risk A: brief re-auth friction for every connected browser client after cutover.
- Risk B: the legacy name persists forever, undermining the rename's own purpose for this volume.
- **APPROVED: Option A.** Replace/recreate `mcp-bridge-data` under the QuaranGate runtime identity
  at N1D cutover. Herman's stated reasoning: documented low-stakes/disposable data; no benefit in
  retaining obsolete physical branding; do not copy unnecessary state merely to preserve the old
  name. Do not perform this volume change before N1D cutover.

**DECISION-2 — `mcp-bridge-jobs` (durable agent job/evidence store): rename or retain?**
- Current state: named `mcp-bridge-jobs`; contains the schema-versioned SQLite job engine, retained
  evidence metadata, and quarantine state referenced by the retained-resource lifecycle.
- Option A: rename to `quarangate-jobs`, migrate data via `docker run` volume-to-volume copy,
  verified against a pre-cutover backup before the old volume is removed.
- Option B: retain the legacy volume name indefinitely; only rename the Compose project around it.
- Option C: create a new empty `quarangate-jobs` volume and treat all pre-cutover jobs as frozen
  historical evidence accessible only via a documented legacy-volume-mount procedure.
- Original recommendation: **Option B.** This volume is high-value, schema-versioned, and
  referenced by quarantine/retention logic; a byte-for-byte copy carries needless risk for a purely
  cosmetic gain, and retaining the name has no functional cost (it is never client-visible).
- Why: rollback complexity and backup/copy risk outweigh cosmetic benefit for a durable data store.
- Risk A (rename+copy): copy failure or partial copy corrupts the live job store.
- Risk B (retain): the legacy name is permanent for this volume specifically.
- Risk C (fork): operational complexity of two job stores; historical evidence becomes harder to
  reach through normal tool calls.
- **APPROVED: Option B.** Retain the existing physical `mcp-bridge-jobs` volume name. Herman's
  stated reasoning: durable schema-versioned job state; copy/rename introduces avoidable data and
  rollback risk; the physical Docker volume name is an internal compatibility artifact, not the
  canonical product identity. A future Compose project may use a neutral logical key while
  explicitly mounting the physical volume named `mcp-bridge-jobs`. Do not copy, rename, fork, or
  mutate this volume before N1D cutover.

**DECISION-3 — Compose/runtime cutover timing relative to repository identity**
- Current state (as of DECISION-3 approval, 2026-08-22): `name: mcp-ide-bridge` in `compose.yaml`;
  determines default container/network names for anything not explicitly named. At DECISION-3
  approval time, the GitHub remote was still `Herman940306/AgentControl`. That repository rename
  has since completed; the canonical repository is now `Herman940306/QuaranGate` (see §47.10). The
  Compose/Docker runtime identity portion of this "current state" remains unexecuted (N1D, not
  started).
- Option A: cut over Compose/runtime at the same time as the GitHub repository rename (single
  coordinated event).
- Option B: cut over Compose/runtime independently, *ahead of* the GitHub rename, once N1D tooling
  changes (label dual-read, evidence prefix dual-recognition) are deployed and verified.
- Original recommendation: **Option B**, gated on the label/evidence compatibility deploy landing
  first — decouples the (reversible, low-risk) container/network rename from the (harder to
  reverse) GitHub rename.
- Why (original): smaller independently-verifiable steps reduce blast radius per change.
- Risk A: a single large cutover event is harder to isolate if something fails.
- Risk B (as originally framed — compose first): two separate "cutover" events instead of one, more
  operator overhead.
- **APPROVED: Option C (repository identity first, decoupled from and preceding runtime cutover).**
  This is a third option, distinct from both A and B above: repository/GitHub identity migration
  completes **first**; live Compose/runtime identity cutover occurs **afterward** as a separate,
  controlled operation — the reverse ordering from the originally recommended Option B, which put
  Compose/runtime ahead of the GitHub rename. Herman's stated reasoning: do not bundle the GitHub
  rename and Docker runtime mutation into one uncontrolled step; canonical repository identity
  should be settled before any live runtime is touched. Required ordering, superseding both
  original options and reflected in §47.11:
  ```text
  1. N1C accepted                                                    — COMPLETE
  2. QuaranGate repository commit                                    — COMPLETE
  3. push                                                             — COMPLETE
  4. GitHub AgentControl -> QuaranGate rename                        — COMPLETE
  5. origin update / repository verification                         — COMPLETE
  6. N1D compatibility implementation (label dual-read, evidence dual-recognition)  — NOT STARTED
  7. N1D controlled runtime cutover                                  — NOT STARTED
  8. post-cutover acceptance                                         — NOT STARTED
  9. G4 definitive QuaranGate build/deployment                       — NOT STARTED
  ```
  Risk A (original, single coordinated event) and Risk B (original, compose-before-GitHub) are
  superseded by this ordering; the residual risk under Option C is that repository identity and
  live runtime identity are visibly out of sync for the duration between step 5 and step 7 — judged
  acceptable since it is the harder-to-reverse action (GitHub rename) that is resolved first, not
  left pending behind a runtime change.

**DECISION-4 — Host secret path (`~/.config/mcp-ide-bridge/kiro-api-key`): when to move?**
- Design in §47.8 (fallback precedence, `mv` not `cp`, sunset criteria). The mechanism is
  recommended; the timing was not decided.
- Option A: move at the same time as DECISION-3 (Compose project cutover).
- Option B: move independently, any time before N1D fully closes out.
- Original recommendation: **Option A** — bundling reduces the number of distinct "touch the live
  secret" events.
- Risk A: coupling means a secret-path issue could block/complicate the Compose cutover.
- Risk B: an extra, separately-tracked maintenance window.
- **APPROVED: Option B.** Migrate as a separate, controlled N1D substep — not bundled with the
  Compose/runtime cutover. Preferred compatibility behavior: new path
  (`~/.config/quarangate/kiro-api-key`) checked first, legacy path
  (`~/.config/mcp-ide-bridge/kiro-api-key`) as fallback. Migration requirements: first deploy the
  read code/config capable of new-first / legacy-fallback; verify legacy fallback still works;
  migrate with `mv`, not `cp`; preserve owner; preserve restrictive permissions; avoid duplicate
  uncontrolled secret copies; verify successful read from the new path; retain legacy fallback
  temporarily; remove the fallback only in a later compatibility closeout. Who physically performs
  the `mv` is not decided by this approval — this tooling remains unauthorized to move it without
  separate explicit authorization. Do not move, copy, read secret content, or change permissions
  before that authorization.

**DECISION-5 — Obsolete image tags: delete after validation, or retain?**
- Current state: N1D will produce new `quarangate:gateway-<sha>`/`executor-<sha>` images alongside
  existing `mcp-ide-bridge:latest`-tagged images (and the pre-existing `agentcontrol:*` candidate
  family — see §47.3, §47.14's image-history correction).
- Option A: delete the old dev-default tag once post-cutover acceptance (§47.11 acceptance steps)
  fully passes.
- Option B: retain both indefinitely as a manual rollback convenience.
- Original recommendation: **Option B** for one full operational cycle after cutover (e.g., until
  the next planned rebuild), then delete — balances rollback convenience against indefinite
  disk/registry growth.
- Risk A: faster cleanup, less rollback convenience if a delayed issue surfaces.
- Risk B: stale images accumulate if "one cycle" is never revisited.
- **APPROVED: Option B, with explicit completion criteria (supersedes the original "one operational
  cycle" framing with concrete gates).** Retain previous known-good legacy images for one validated
  rollback cycle. Remove obsolete image tags/images only after **all** of the following succeed:
  - QuaranGate runtime cutover succeeds
  - restart/recreation succeeds
  - real ChatGPT MCP acceptance succeeds
  - real Claude MCP acceptance succeeds
  - provenance/readiness checks succeed
  - rollback is no longer required for the validation cycle

  Do not delete, tag, or build images before N1D cutover.

## 47.14 What N1C actually changed (source-behavior boundary)

N1C changed only current-facing identity/documentation: `README.md`, this document's header and
this §47, `docs/CLIENT_SETUP.md` (two JSON example server-name strings, to match the N1B-updated
`config/*.example.json` files they mirror), `docs/OPERATIONS.md` (the `agentcontrol:` → `quarangate:`
production image-tag *convention* text, to stay consistent with the equivalent comment N1B already
updated in `compose.yaml`; the literal SHA-only convention text was never built under either name,
though a related `agentcontrol:gateway-candidate-<sha>` image family exists as separate historical
evidence — see §47.3), and `compose.yaml`'s top-of-file comment (text only; the `name:` field itself
is untouched). No label read/write
behavior, no volume/network/image naming, no target resolution, no secret path, no Docker
orchestration, no auth, and no schema changed. Everything in §47.3–§47.13 is a design record for a
future, separately authorized N1D change.

## 47.15 Gitignored local runtime config follow-up

`config/agents.yaml` and `config/clients.yaml` do not exist in this N1C worktree (gitignored, and
absent — only their committed `.example` counterparts are present). The task brief noted "known
stale local comments were previously observed" in these files; that could not be verified from this
worktree. Classified **NONBLOCKING_LOCAL_RUNTIME_FOLLOWUP** — check these files for stale
identity comments in the live deployment worktree at N1D cutover step 19 (§47.11).

---

# END — QUARANGATE MASTER PRD v1.0
