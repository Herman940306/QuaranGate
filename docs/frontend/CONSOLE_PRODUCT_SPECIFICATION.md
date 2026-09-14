# QuaranGate Console — U1 Product & Functional Specification

**Specification status:** Owner-approved U1 target with implementation candidate in progress.  
**Implementation lane:** `integrate/u1-control-center-full`  
**Accepted base:** `b01015c4c2854881aeac7cab6e2caf45d978a75d`

## Product objective

QuaranGate Console must make the governed engineering control plane understandable and operable without requiring routine knowledge of MCP schemas, Docker internals, WSL paths, YAML files or raw scope strings.

The Console is a user interface over existing QuaranGate authority. It must never become a parallel authorization, Docker, provider or GitHub control path.

## Non-negotiable invariants

1. Browser convenience never grants authority.
2. Every consequential action remains server-authorized.
3. Sandbox completion is not live application.
4. `COMPLETED != APPLIED`.
5. Session identity is not authorization.
6. Model prose is not machine evidence.
7. Local inference is not automatic privacy proof.
8. Missing or ambiguous operational state is displayed as unknown/fail-closed.
9. Gateway and worker surfaces do not gain Docker socket authority.
10. No automatic cloud/provider fallback may be invented by the UI.
11. Credentials remain secret and browser-memory-only.
12. Unsupported future capabilities are shown truthfully, never mocked as successful.

## Required primary screens

| Screen | Required capability |
|---|---|
| Overview | Health, trust path, current activity, incidents, provider and drift summary. |
| Chat | Governed durable agent conversation using Agent Control Plane jobs. |
| Projects | Logical project identity, Git/policy/backend/profile state and related work. |
| Targets | Authorized target inventory, inspect/logs and bounded lifecycle controls. |
| Files | Browse/stat/read/search/write/patch/delete inside authorized workspace. |
| Terminal | Bounded governed `terminal_exec` with explicit Execution authority. |
| Git | Read-only status/diff/log for authorized target workspace. |
| Processes | Target process inspection. |
| Agents | Backend availability, profiles, projects and governed dispatch. |
| Jobs | Status/result/diff plus cancel/apply/discard lifecycle. |
| Review & Approvals | Human decision surface for evidence promotion and future approval workflows. |
| IDE Sessions | Truthful current/future IDE session capability state; no fake sessions. |
| GitHub | Repositories, branches, commits, PRs, issues, comments, checks and bounded write/review. |
| Local AI / Models | Exact model/provider/qualification/locality state where measurable. |
| Monitoring | MCP activity, runtime topology, egress, provider health and drift. |
| Statistics | Bounded analytics derived only from actually retained data. |
| Security & Access | Current principal grants, authority explorer and Docker-boundary state. |
| Audit & Evidence | Chronological metadata and evidence lineage. |
| Recovery & Backups | Recovery/quarantine/uncertainty state; unsupported backup actions remain external. |
| Settings | Read-only current state where no governed mutation API exists. |
| Tool Lab | Complete low-level MCP catalog with live drift detection. |

## Expanded production capabilities

### MCP Traffic & Activity Observatory

Expose safe metadata where available:

- timestamp and request/correlation ID;
- principal/client;
- tool and authority class;
- logical target/project/repository when safe;
- allow/deny decision;
- safe error code;
- duration;
- associated job ID only where already represented by safe metadata.

Aggregate retained-window request count, allow/deny/failure count, p50/p95 latency, top tools and rate-limit state where available.

**Privacy rule:** no raw prompt, command output, file content, credential or arbitrary payload capture.

### Authority Explorer

Display effective authority as:

`principal → scopes → targets/projects/backends/profiles/GitHub grants → actions`

Provide read-only server-backed policy preflight. It is advisory only and must state that runtime/operation-specific checks can still deny the real operation.

### Runtime Topology & Provenance

Display gateway, executor, governed targets, agents/providers, GitHub components and future IDE adapters where actual data exists.

Prefer role, health/readiness, source/build revision, image identity when known, publication state when measured and Docker-authority state when measured or guaranteed by architecture. Unknown attributes remain `UNKNOWN`.

### Source → Image → Runtime Drift

Compare known source/build/runtime identities using only:

- `MATCH`
- `DRIFT`
- `UNKNOWN`

Never infer match from a mutable image tag alone.

### Egress & Network Policy Monitor

Display expected provider destinations and known policy state. No packet-content capture. Missing live counters remain unavailable rather than fabricated.

### Queue, Rate Limit & Provider Health

Show active/queued jobs and provider availability. Future P3 fields such as Retry-After, cooldown, backoff and circuit-breaker state appear only when actually exposed. Until then show `DEFERRED` or `NOT_IMPLEMENTED`.

### Session Continuity Inspector

After A8 qualification, expose NEW/RESUME state, provider session identity, generation, source/project binding and recovery/refusal information. Before qualification show `NOT_QUALIFIED` or `NOT_AVAILABLE`.

### Evidence Lineage / Chain of Custody

Represent only provable links:

`request → job → sandbox/evidence → diff → review → apply/discard → commit/image/runtime`

Every displayed hop must be backed by a known identifier or observed relationship.

### Resource Lifecycle / Orphan Inspector

Show only QuaranGate-owned resources if a bounded ownership-proving backend read model exists. Generic Docker enumeration or cleanup is forbidden. Current lack of a safe enumeration API must be displayed truthfully.

### Policy Dry-Run / Preflight

Evaluate principal scope and logical grants without executing mutation. It must not reserve future authority and must not duplicate full server eligibility policy in browser JavaScript.

### Incident & Alert Center

Aggregate actionable authorization denials, readiness degradation, runtime drift, provider issues and uncertain state. Deduplicate repeated events and attach safe evidence identifiers.

### Model / Provider Operations

Display exact provider/model identity, configuration, qualification status, local/cloud classification and available resource telemetry. Unknown metrics remain unknown.

### Global Search / Command Palette

`Ctrl/Cmd + K` provides keyboard-first page and tool discovery. Any action opened from the palette still passes normal confirmation and server authorization.

### Compatibility / Capability Matrix

Represent Kiro, Ollama, Copilot, VS Code, Cursor, Visual Studio and Antigravity using explicit states such as:

- `SUPPORTED`
- `NOT_SUPPORTED`
- `IMPLEMENTED_NOT_QUALIFIED`
- `NOT_IMPLEMENTED`
- `OWNER_DECISION`
- `UNKNOWN`

Architecture availability and production qualification remain distinct.

## MCP coverage requirement

Accepted base:

`18 direct + 9 ACP + 17 GitHub = 44 tools`

U1 candidate:

`44 + control_center_query = 45 tools`

Tool Lab must compare live discovery against the candidate catalog and expose missing/extra tools.

## GitHub product requirements

The GitHub UI must preserve:

- GitHub App **Selected repositories** support;
- discovery limited to App-granted/trusted repositories;
- no merge;
- no force push;
- no delete ref;
- no arbitrary GitHub API;
- no arbitrary remote URL;
- no repository/admin/secret authority;
- exact local push only through trusted project mapping and exact expected HEAD.

## Security and credential requirements

- Bearer/API key in page memory only.
- No credential in local/session storage, IndexedDB, cookie, URL, toast or log.
- Same-origin assets and `/mcp` calls only.
- Restrictive CSP/browser headers.
- No third-party CDN dependencies.
- No `eval` or `new Function`.
- No unescaped rendering of backend/user strings.
- No generic Docker or host administration API.
- No new mutation API solely for UI convenience.

## Consequential/destructive action requirements

Prominent authority treatment is required for:

- `target_start`
- `target_stop`
- `target_restart`
- `fs_delete`
- `terminal_exec` as visible Execution authority
- `agent_apply`
- `agent_cancel`
- `agent_discard`
- `github_push_branch`
- `github_pull_request_create`
- `github_pull_request_update`
- `github_pull_request_review`

`agent_apply` is the strongest promotion warning.

## Async and failure requirements

- pessimistic UI updates after server success;
- duplicate identical in-flight browser submissions suppressed;
- 401 clears connection and secret state;
- 403 shown as an authority boundary, not a missing feature;
- 429 shown as bounded rate/concurrency state;
- durable agent polling bounded;
- no fake token streaming;
- no auto-apply;
- no silent provider fallback.

## Accessibility requirements

Target WCAG 2.2 AA:

- semantic landmarks/forms/tables;
- keyboard-only operation;
- visible focus;
- dialog focus trap/restoration;
- Escape behavior;
- screen-reader status regions;
- non-color-only state;
- reduced motion;
- forced-colors support;
- 200% zoom usability;
- accessible equivalents for future charts.

## Responsive requirements

- desktop-first workstation UX;
- usable at 360 px width;
- navigation drawer on narrow screens;
- no clipped primary actions;
- tables horizontally scroll rather than drop important columns;
- output panels own scrolling;
- dialogs remain viewport-safe.

## Observability retention contract

Current U1 candidate metadata retention:

- memory-only;
- max 2,048 events;
- max 24 hours;
- max 200 returned rows per query;
- current-principal visibility only.

Longer-term/persisted telemetry requires a separate retention/privacy decision.

## User-visible truth vocabulary

Use explicit status rather than optimistic guesses:

- `READY`
- `DEGRADED`
- `MATCH`
- `DRIFT`
- `UNKNOWN`
- `NOT_AVAILABLE`
- `NOT_IMPLEMENTED`
- `IMPLEMENTED_NOT_QUALIFIED`
- `NOT_QUALIFIED`
- `DEFERRED`
- `OWNER_DECISION_REQUIRED`

## Acceptance gates

U1 is not closed until applicable gates pass:

1. forward-integration on accepted baseline;
2. complete current tool/catalog coverage;
3. independent source/security review;
4. Console and observability tests;
5. affected authorization/GitHub/ACP/H1/O1 regression;
6. full unit suite;
7. typecheck;
8. production build;
9. `git diff --check`;
10. security anti-pattern audit;
11. rendered-browser E2E;
12. browser accessibility qualification;
13. production deployment through accepted promotion path;
14. source/image/runtime parity after deployment.

At the time of writing, rendered-browser E2E remains an unpassed gate because the governed implementation environment has no supported browser runtime.

## Documentation set

- [`CONSOLE_FRONTEND_ARCHITECTURE.md`](CONSOLE_FRONTEND_ARCHITECTURE.md)
- [`CONSOLE_OPERATIONS_SUPPORT_MANUAL.md`](../user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md)
- [`MCP_TOOL_REFERENCE.md`](../reference/MCP_TOOL_REFERENCE.md)
- [`CONSOLE.md`](CONSOLE.md)
- [`../DESIGN.md`](../../DESIGN.md)
- [`../UX-CONTRACT.md`](../../UX-CONTRACT.md)
