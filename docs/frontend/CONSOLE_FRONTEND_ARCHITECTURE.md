# QuaranGate Console — Frontend Architecture

**Product:** QuaranGate Console  
**Lane:** `integrate/u1-control-center-full`  
**Accepted source base:** `b01015c4c2854881aeac7cab6e2caf45d978a75d`  
**Status:** U1 implementation candidate; independent review and rendered-browser E2E remain required before production promotion.

## Purpose

QuaranGate Console is the human-facing workstation for the existing governed QuaranGate control plane. It is an **additive same-origin web facade**, not a second backend and not a privileged administration path.

```text
Browser
  │ GET /console/
  ▼
QuaranGate Gateway ── static Console assets
  │ authenticated JSON-RPC / MCP
  ▼
Gateway AuthN/AuthZ/audit boundary
  │
  ▼
Private Executor / Agent Control Plane / QuaranHUB
```

The browser cannot acquire authority that the authenticated principal does not already have.

## Frontend source map

| Path | Responsibility |
|---|---|
| `console/index.html` | Semantic application shell, navigation host, main-content landmark and dialog/toast roots. |
| `console/app.js` | Route rendering, page-memory state, workflows, confirmations, job polling, command palette and Control Center reads. |
| `console/styles.css` | Precision-engineering visual system, responsive behavior, focus states, reduced-motion and forced-colors support. |
| `console/mcp-client.js` | Same-origin MCP JSON-RPC transport, bearer handling, error normalization and tool discovery. |
| `console/tool-catalog.js` | Expected MCP catalog, authority classification, defaults and runtime drift comparison. |
| `src/gateway/consoleWeb.ts` | Serves `/console/` with restrictive security headers and no new public service/port. |
| `src/gateway/controlCenterTools.ts` | Bounded read-only metadata contract for operational views. |
| `src/gateway/audit.ts` | Structured audit plus bounded metadata-only activity ring. |
| `src/executor/index.ts` | Private bounded runtime metadata read model; no generic Docker API. |
| `tests/unit/console-*.test.ts` | Console catalog, client, web and full-surface contracts. |
| `tests/unit/control-center-observability.test.ts` | Observability, redaction, retention and read-only policy contracts. |

The frontend uses plain HTML, CSS and ES modules. It introduces no browser framework and no third-party CDN dependency.

## Product shell and navigation

The implemented navigation contains:

1. Overview / Home
2. Chat
3. Projects
4. Targets
5. Files
6. Terminal
7. Git
8. Processes
9. Agents
10. Jobs
11. Review & Approvals
12. IDE Sessions
13. GitHub
14. Local AI / Models
15. Monitoring
16. Statistics
17. Security & Access
18. Audit & Evidence
19. Recovery & Backups
20. Settings
21. Tool Lab

`Ctrl/Cmd + K` opens the global command palette for page and tool discovery.

## Design system

The visual North Star is **precision engineering test bench** rather than generic SaaS or cyberpunk styling:

- graphite authority rail;
- mineral-light workspace;
- dark machine-output surfaces;
- restrained semantic status colors;
- visible **Read / Write / Execution / Destructive** authority language;
- high technical density without hiding trust boundaries;
- human-readable default wording with exact evidence available in advanced views.

The shipped CSS uses only local/system font stacks:

- Sans/display: Aptos / Segoe UI / system UI fallbacks;
- Monospace: Cascadia Code / SFMono / Consolas / Liberation Mono fallbacks.

No remote font is required.

## Browser state and credentials

Short-lived operational state exists only in page memory: credential, discovered tools, visible targets/backends/projects, locally observed jobs, selections, route results, bounded chat context and Control Center responses.

The bearer credential is **never persisted** to `localStorage`, `sessionStorage`, IndexedDB, cookies or URLs. Disconnect clears the credential and principal-specific in-memory state.

The browser is not the durable job database; QuaranGate is.

## Data-access model

Normal pages call the existing governed MCP tools. Examples:

- target inventory → `targets_list`;
- file reads → `fs_read`;
- Chat → `agent_dispatch` + `agent_status` + `agent_result`;
- review → `agent_diff`;
- promotion → explicit `agent_apply`;
- GitHub → bounded `github_*` tools.

The U1 candidate adds one read-only tool, `control_center_query`, for operational metadata views:

`summary`, `activity`, `authority`, `topology`, `egress`, `providers`, `incidents`, `statistics`, `capabilities`, `resources`, `recovery`.

It requires normal authentication/authorization and adds no Docker or mutation authority.

## Tool surface and drift behavior

The accepted `b01015c…` base contains 44 tools:

- 18 direct target operations;
- 9 Agent Control Plane operations;
- 17 GitHub App Control Plane operations.

The U1 candidate adds `control_center_query`, so candidate source contains **45 tools**.

Tool Lab compares live MCP discovery against the expected catalog and exposes missing/extra tools instead of silently accepting drift.

See [`MCP_TOOL_REFERENCE.md`](../reference/MCP_TOOL_REFERENCE.md) for every tool, scope, inputs and use case.

## Authority UX

The Console groups actions into:

- **Read** — inspection only;
- **Write** — bounded content or job creation;
- **Execution** — bounded shell execution inside an authorized target;
- **Destructive** — lifecycle, deletion, promotion/cancel/discard or bounded remote-write actions.

Browser confirmation is UX, not authority. Server policy still decides the operation.

`agent_apply` receives the strongest warning because it crosses the evidence-to-live-source promotion boundary.

Permanent semantic rule:

> `COMPLETED` does not mean `APPLIED`.

The Console never auto-applies a completed job.

## Chat architecture

Chat is a durable Agent Control Plane workflow, not a direct model socket:

```text
User message
  ↓
agent_dispatch
  ↓
QUEUED / PREPARING / RUNNING / VALIDATING
  ↓
COMPLETED or failure
  ↓
agent_result
  ↓
optional agent_diff
  ↓
optional separately confirmed agent_apply
```

The current MCP contract has no token-streaming result channel, so the Console shows truthful job lifecycle state rather than simulated token streaming.

## Monitoring privacy and retention

The U1 activity read model is deliberately bounded and metadata-only:

- gateway memory only;
- maximum 2,048 retained events;
- maximum age 24 hours;
- maximum 200 rows returned per query;
- current-principal filtering.

It does **not** expose raw prompts, tool arguments, file contents, terminal output, response bodies, API keys or credentials.

Unavailable values are rendered as `UNKNOWN`, `NOT_AVAILABLE`, `NOT_IMPLEMENTED`, `NOT_QUALIFIED` or `DEFERRED` instead of being estimated.

## Topology and provenance truth rules

Topology/provenance may display only values known from trusted configuration or measured runtime metadata. The top-level comparison states are:

- `MATCH`
- `DRIFT`
- `UNKNOWN`

A mutable image tag alone is never sufficient evidence for `MATCH`. Runtime-specific attributes that are not measured remain unknown.

## GitHub boundary

GitHub screens preserve the QuaranHUB control-plane constraints:

- GitHub App **Selected repositories** installations are supported;
- only App-granted/trusted repositories are discoverable;
- no arbitrary remote URL;
- no force push;
- no delete ref;
- no repository/secret administration;
- no merge tool;
- direct push requires exact HEAD and trusted local-project mapping.

## Responsive behavior

Desktop is the primary workstation target, but narrow-screen use remains supported:

- drawer navigation below 880 px;
- primary actions remain reachable;
- tables scroll horizontally when needed;
- dialogs stay viewport-safe;
- machine output owns its scrolling;
- small layouts collapse to one column.

## Accessibility

Target: **WCAG 2.2 AA**.

Static/implementation contracts include semantic landmarks/forms/tables, labels, skip link, keyboard navigation, `:focus-visible`, focus trapping/restoration, Escape behavior, screen-reader live regions, non-color-only status, reduced motion and forced-colors support.

Rendered-browser accessibility qualification remains required.

## Browser security

`src/gateway/consoleWeb.ts` applies Console-specific controls including CSP, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, restrictive Permissions Policy and `Cache-Control: no-store`.

Scripts/assets and MCP connections are same-origin. No remote scripts/styles/fonts are required. Untrusted strings are escaped before HTML composition.

## Verification state

Current U1 candidate verification includes passing Console tests, observability tests, full unit suite, TypeScript typecheck, production build and `git diff --check` at the latest run.

**Rendered browser E2E remains `BLOCKED_ENVIRONMENT`** because the governed implementation target currently has no Chromium/Firefox/Playwright/Puppeteer runtime. It remains a release gate and must not be represented as passed.

## Related documents

- [`CONSOLE.md`](CONSOLE.md) — Console overview and implementation notes.
- [`CONSOLE_PRODUCT_SPECIFICATION.md`](CONSOLE_PRODUCT_SPECIFICATION.md) — complete U1 product/functional specification.
- [`CONSOLE_OPERATIONS_SUPPORT_MANUAL.md`](../user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md) — operator/support manual.
- [`MCP_TOOL_REFERENCE.md`](../reference/MCP_TOOL_REFERENCE.md) — complete MCP function reference.
- [`../DESIGN.md`](../../DESIGN.md) — visual/design decisions.
- [`../UX-CONTRACT.md`](../../UX-CONTRACT.md) — interaction contracts and ownership ledger.
