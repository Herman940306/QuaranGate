# QuaranGate Console

QuaranGate Console is the bundled workstation UI for the existing QuaranGate gateway. It is an **additive web facade**, not a second backend and not an authority shortcut.

```text
Browser
  │
  │ GET /console/
  ▼
QuaranGate Gateway ── static Console assets
  │
  │ authenticated JSON-RPC over POST /mcp
  ▼
Existing MCP authentication / authorization / executor boundary
```

Default loopback URL:

```text
http://127.0.0.1:8787/console/
```

## Product identity and visual contract

The UI product name is **QuaranGate Console**. Durable design/interaction contracts live at repository root:

- [`DESIGN.md`](../../DESIGN.md)
- [`UX-CONTRACT.md`](../../UX-CONTRACT.md)
- [`premium-ui.json`](../../premium-ui.json)

The visual North Star is a precision engineering test bench: graphite authority rail, mineral-light workspace, explicit trust/authority state, and a separate dark machine-output surface. The product intentionally avoids neon/cyberpunk dashboard styling.

## Documentation map

- [`CONSOLE_FRONTEND_ARCHITECTURE.md`](CONSOLE_FRONTEND_ARCHITECTURE.md) — frontend source architecture, data flow, security, responsive and accessibility contracts.
- [`CONSOLE_PRODUCT_SPECIFICATION.md`](CONSOLE_PRODUCT_SPECIFICATION.md) — complete U1 product/functional specification, including all owner-approved monitoring/observability extensions.
- [`CONSOLE_OPERATIONS_SUPPORT_MANUAL.md`](../user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md) — user/operator workflows, troubleshooting and support escalation.
- [`MCP_TOOL_REFERENCE.md`](../reference/MCP_TOOL_REFERENCE.md) — all current MCP calls/functions, required scopes, inputs and representative use cases.

## Security boundary

The Console never receives direct executor access or raw Docker authority. Consequential actions use the same authenticated MCP tool surface available to other clients. The server still decides principal identity, scope, target/project/backend/profile/repository grants, evidence state and whether a mutation may proceed.

Client-side disabled/hidden state and confirmation are UX only. **Server authorization remains authoritative.**

### Credential handling

The connection screen accepts an already-provisioned QuaranGate API key/bearer credential. The Console:

- masks the value by default;
- keeps it only in current-page JavaScript memory;
- never writes it to `localStorage`, `sessionStorage`, IndexedDB, cookies, URLs, toasts or console logs;
- clears the credential and principal-specific in-memory state on Disconnect.

The Console does not create or rotate credentials.

## Current U1 tool surface — 45

The U1 integration branch contains:

- **18 direct target operations**;
- **9 Agent Control Plane operations**;
- **17 GitHub App Control Plane operations**;
- **1 bounded Control Center observability query**.

### Direct target operations — 18

| Group | Tools |
|---|---|
| Targets | `targets_list`, `target_inspect`, `target_logs`, `target_start`, `target_stop`, `target_restart` |
| Files | `fs_list`, `fs_stat`, `fs_read`, `fs_search`, `fs_write`, `fs_patch`, `fs_delete` |
| Terminal | `terminal_exec` |
| Git | `git_status`, `git_diff`, `git_log` |
| Processes | `process_list` |

### Agent Control Plane — 9

`agents_list`, `agent_projects`, `agent_dispatch`, `agent_status`, `agent_result`, `agent_diff`, `agent_apply`, `agent_cancel`, `agent_discard`.

### GitHub App Control Plane — 17

`github_repositories`, `github_repository`, `github_branches`, `github_commits`, `github_pull_requests`, `github_pull_request`, `github_pull_request_files`, `github_issues`, `github_issue`, `github_issue_comments`, `github_pull_request_reviews`, `github_pull_request_review_comments`, `github_checks`, `github_push_branch`, `github_pull_request_create`, `github_pull_request_update`, `github_pull_request_review`.

There is deliberately no merge tool, force-push operation, arbitrary remote URL or generic GitHub API surface.

### Control Center observability — 1

`control_center_query` is a metadata-only read tool. It exposes bounded views such as summary, MCP activity, current-principal authority/preflight, runtime topology/provenance, egress policy, provider health, incidents, statistics, capability state, resource-lifecycle status and recovery state.

The tool requires existing read authority, is schema-bounded, performs no mutation and returns no raw prompts, tool arguments, file contents, command output, response bodies, credentials, Docker selectors or secrets.

At connection time Tool Lab compares the server-discovered tool names with the Console catalog and surfaces both missing and extra contracts.

## Navigation

| Route | Purpose |
|---|---|
| Overview | Trust path, target/backend/tool coverage, promotion boundary and recent browser-known work |
| Chat | Governed agent conversation backed by durable `agent_dispatch` jobs |
| Projects | Logical project identity, backend/profile eligibility and truthful cross-plane capability state |
| Targets | Inventory, inspection, bounded logs and start/stop/restart |
| Files | Browse, read, fixed-string search, write, exact patch and delete |
| Terminal | Bounded `terminal_exec` inside an authorized target |
| Git | Read-only status/diff/log |
| Processes | Target process inspection |
| Agents | Backend/project visibility and governed dispatch |
| Jobs | Status/result/diff review and explicit cancel/apply/discard |
| Review & Approvals | Browser-known decision inbox and promotion/preflight boundary |
| IDE Sessions | Truthful IDE/session readiness; no simulated session authority |
| GitHub | Selected-repository discovery, purpose-built reads and confirmed bounded writes |
| Local AI / Models | Provider health, Ollama endpoint state and qualification/capability matrix |
| Monitoring | MCP traffic, topology/provenance, drift, egress, queue/provider health, incidents and resource ownership state |
| Statistics | Bounded principal-scoped MCP/job/target/backend metrics |
| Security & Access | Current-principal grants, Docker boundary and read-only authority preflight |
| Audit & Evidence | Chronological metadata and browser-known evidence lineage |
| Recovery & Backups | Recovery, rollback/backup ownership and resource lifecycle truth |
| Settings | Read-only configuration ownership where no governed mutation contract exists |
| Tool Lab | Complete current low-level MCP contract surface |

Routes are hash-backed so browser Back/Forward and deep links work without a server-side SPA fallback.

## MCP Traffic & Activity Observatory

The gateway audit stream now also feeds a bounded in-memory metadata ring for the current principal. It retains at most **2,048 entries** and at most **24 hours**, whichever bound is reached first. Query responses are capped at **200 entries**.

Stored/queryable metadata includes timestamp, request ID, principal, tool, target/resource metadata, allow/deny decision, safe error code and duration. It deliberately does **not** retain prompts, tool arguments, file content, command output, response bodies, API keys or credentials.

The Monitoring and Statistics routes derive request counts, denials, failures, p50/p95 latency and top-tool counts from this bounded metadata. This is not represented as long-term analytics or a durable audit database.

## Authority Explorer / policy preflight

Security & Access includes a read-only advisory preflight for the current principal. It evaluates the same loaded principal grants for required scope plus optional target/project/backend/profile/GitHub account/project grants. It performs no mutation and never reserves future authority.

A successful preflight means only that the current static grants satisfy the requested check. Operation-specific server checks, live state, stale-base detection, guarded paths, dirty-host state, quarantine and other runtime conditions still apply when the real tool is invoked.

## Runtime topology, provenance and drift

The Control Center read model exposes:

- gateway build revision when embedded in the production image;
- executor build revision;
- executor Docker-readiness state;
- visible governed target health/image metadata;
- explicit expected Docker-authority placement.

The Console labels provenance as `MATCH`, `DRIFT` or `UNKNOWN`; it never infers a match from a mutable tag string alone. Generic Docker IDs/options and administration are not exposed.

## Egress and provider operations

The UI separates declared policy from live evidence. Ollama reports exact local endpoint state (`EXACT_LOCAL`, `DRIFT`, `NOT_CONFIGURED`); GitHub/Kiro policy is shown as declared/limited where live counters are not yet exposed. No packet payload capture is introduced.

Provider operations show executor-reported active/queued jobs where available, visible backend health, and truthful roadmap states for provider admission control/session continuity. Deferred functionality is displayed as `DEFERRED`, `NOT_QUALIFIED`, `NOT_IMPLEMENTED` or `UNKNOWN`, never as fake telemetry.

## Evidence lineage and resource lifecycle

Audit & Evidence builds only links actually observed in the browser session: request/job/evidence/review/disposition. Missing commit/image linkage remains `UNKNOWN` until machine-derived evidence exposes it.

The resource-lifecycle view intentionally refuses generic Docker enumeration/cleanup. Until a bounded ownership-proven executor resource read model exists, it reports that runtime resource enumeration is not exposed rather than offering `docker rm`/volume/network controls.

## Interactive chat contract

Chat never bypasses the Agent Control Plane. Each Send creates a normal `agent_dispatch` job using the selected backend, project, profile and resource policy. The Console polls `agent_status` and retrieves `agent_result` when appropriate.

The current job tools do not expose token streaming, so the Console shows truthful lifecycle progress rather than simulated token streaming. Until A8 session continuity is production-qualified, Chat uses a new-session policy and browser context does not confer server authority.

### Promotion remains separate

```text
chat / agent job
      │
      ▼
   COMPLETED
      │
      ├── review agent_result
      ├── review agent_diff
      │
      └── explicit confirmation
                │
                ▼
            agent_apply
```

The Console never auto-applies completed work.

## Destructive-class confirmation

Current destructive-class Console tools are:

- `target_start`, `target_stop`, `target_restart`;
- `fs_delete`;
- `agent_apply`, `agent_cancel`, `agent_discard`;
- `github_push_branch`, `github_pull_request_create`, `github_pull_request_update`, `github_pull_request_review`.

These actions cross an app-owned confirmation dialog. `agent_apply` retains the strongest promotion warning. Server policy re-verifies every operation after confirmation.

## Global search / command palette

`Ctrl+K` / `Cmd+K` opens an app-owned command palette over routes and tool metadata. It may navigate to Tool Lab but does not execute a destructive operation directly, so all normal confirmation and server policy gates remain intact.

## Async and failure behavior

- Mutations are pessimistic; canonical UI state changes only after server confirmation.
- Duplicate identical requests from one control are suppressed while pending.
- A 401 disconnects the Console and clears credential/principal-specific memory.
- A 403 is shown as an authorization boundary, not a missing feature.
- Non-sensitive form input survives recoverable failures.
- Agent polling is bounded; timeout directs the operator back to durable job inspection.
- Unknown/unsupported telemetry is visibly `UNKNOWN`/not available.

## Accessibility and responsive contract

The Console targets WCAG 2.2 AA. Implemented baseline includes semantic landmarks/controls/tables, visible `:focus-visible`, skip link, app-owned dialogs with focus trap/Escape/restoration, `aria-live` feedback, text-associated errors, no native `alert()/confirm()/prompt()`, IME-safe Chat Enter handling, reduced-motion and forced-colors handling, drawer navigation below 880px, horizontal table overflow and workstation layouts that remain usable down to narrow mobile widths.

## Browser security headers

`src/gateway/consoleWeb.ts` applies Console-specific CSP, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, restrictive Permissions Policy and `Cache-Control: no-store`.

Scripts/MCP are same-origin. There are no third-party CDN/runtime dependencies.

## Build and deployment

The Console uses plain HTML/CSS/ES modules and adds no browser framework/runtime dependency. The normal Dockerfile copies `console/` beside the compiled gateway/executor code. `QUARANGATE_BUILD_REVISION` is embedded from the same immutable build revision used for image provenance so the read-only topology view can compare gateway/executor revisions without parsing mutable image tags.

No additional public port or Compose service is introduced.

## Verification

Console-specific tests:

```bash
npm run test:console
```

They cover MCP transport parsing, credential clearing, 401/403/tool errors, exact catalog coverage, destructive-class coverage, static serving, security headers and unknown-asset behavior.

U1 observability tests additionally cover principal-scoped metadata, absence of detail/payload data from queries, 200-row read bounds, statistics aggregation and static assurance that the new Control Center surface exposes no generic Docker/host mutation path.

Normal project gates still apply:

```bash
npm run typecheck
npm test
npm run build
```

A real rendered-browser E2E/accessibility pass remains required before production promotion. If the governed implementation environment has no supported browser runtime, that gate must be reported as `BLOCKED_ENVIRONMENT`, not inferred from static/unit tests.
