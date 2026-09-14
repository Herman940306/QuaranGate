# QuaranGate Console UX Contract

## Product context

- **Audience:** developers and technical operators running governed AI engineering workflows.
- **Primary jobs:** inspect authorized environments, operate bounded target tools, dispatch/review agent jobs, and make explicit evidence promotion/discard decisions.
- **Target markets:** self-hosted developer workstations and engineering environments; no locale-specific market assumptions in v1.
- **Active locales:** English (`en`).
- **Language/content register:** concise technical product copy. Tool names, paths, commands, hashes, and backend output remain exact.
- **Timezone/calendar policy:** display ISO timestamps from QuaranGate with the browser-local readable representation where useful; never alter stored values.
- **Accessibility target:** WCAG 2.2 AA.

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Product purpose / status language | `README.md` | Maintained product documentation | 2026-09-07 |
| Runtime trust zones | `docs/architecture/ARCHITECTURE.md` | Maintained architecture contract | 2026-09-07 |
| Permission model / credential handling | `docs/security/SECURITY.md`, `src/gateway/config.ts` | Security policy + verified source contract | 2026-09-07 |
| Agent lifecycle / promotion boundary | `docs/backend/AGENT_CONTROL_PLANE.md`, `src/shared/agents.ts` | Domain contract + verified source contract | 2026-09-07 |
| Public MCP schemas | `src/gateway/mcp.ts`, `src/gateway/agentSchemas.ts`, `src/gateway/agentTools.ts` | Verified API contract | 2026-09-07 |
| Deletion / retention | `docs/backend/AGENT_CONTROL_PLANE.md` | Maintained domain contract | 2026-09-07 |
| Billing / payment | Not applicable | — | 2026-09-07 |
| Legal / regulatory copy | Not applicable to current console | — | 2026-09-07 |

## Visual contract

- **Project `DESIGN.md`:** `DESIGN.md`
- **Token ownership model:** `DESIGN.md` is normative; CSS custom properties are the runtime adapter.
- **Runtime design-system/token source:** `console/styles.css` under `:root` and semantic component classes.
- **Mapping/export/adapters:** one-to-one named CSS custom properties; no generated export layer in v1.
- **Token drift gate:** UI review + premium static audit + grep for raw palette values outside token definitions.
- **Supported themes:** light workstation theme in v1; system high-contrast/forced-colors remains operable.
- **Design-context owner/review policy:** durable visual decisions update `DESIGN.md` and runtime tokens in the same changeset.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | Native `<select>` via shared field builder | This contract + `console/app.js` | native | keyboard + browser popup |
| Form | Shared `tool-form` / field helpers | This contract + `console/app.js` | tool / chat / connection | validation browser flow |
| Scrollbar | Application-root CSS baseline | `DESIGN.md` + `console/styles.css` | stable-gutter geometry exceptions | computed style + browser |
| Toast | `ToastCenter` | This contract + `console/app.js` | success / warning / info / error | live-region + browser |
| Dialog | `ConfirmDialog` | This contract + `console/app.js` | warning / danger | focus trap + Escape + restoration |

No CRUD domain exists in the current facade. Target control, filesystem mutation, and agent disposition are operation workflows, not record CRUD.

## Component behavior

| Component | Default | Hover | Focus | Active | Disabled | Busy | Error |
|---|---|---|---|---|---|---|---|
| Button | intent + emphasis | tonal/border change | visible focus ring | pressed offset/tone | disabled + explanation where relevant | fixed geometry + spinner | inline/banner outcome |
| Icon button | visible icon + accessible name | tonal change | visible focus ring | pressed | inert | fixed geometry | n/a |
| Input | labeled | border emphasis | focus ring | n/a | muted | reserved adornment | inline text + `aria-invalid` |
| Secret input | masked | n/a | focus ring | reveal toggle explicit | n/a | n/a | connection error below form |
| Search | clear button when non-empty | clear/action hover | input/button ring | n/a | n/a | result region stable | retry/clear path |
| Textarea | resize none + auto-grow | border emphasis | focus ring | n/a | muted | stable | inline text |
| Table/list | stable rows | row/action affordance | action-level focus | selected when applicable | n/a | stable loading footprint | panel error + retry |

## Dataset navigation

- **Targets and agent metadata:** bounded render-all from server responses; current APIs already return bounded sets.
- **Tool Lab catalog:** search/filter client-side over the server-discovered tool list; no remote search is performed.
- **URL state:** route is hash-backed. Sensitive values, commands, prompts, filesystem content, tool arguments, target selection, and job IDs are not written to the URL.
- **Empty/no-results/error/loading:** distinct states with reset/retry actions where safe.
- **Back/scroll restoration:** browser hash history restores route; each route owns its own output scroll area.

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| Connect console | `Connect` | button busy | requested/current route | connected status + toast | key preserved in current field for correction | connection key / route heading | `src/gateway/index.ts`, `docs/security/SECURITY.md` |
| Run read tool | explicit action | control busy | same panel | result surface + status | inline error + retry | trigger/result heading | `src/gateway/mcp.ts` |
| Run write tool | explicit action | control busy | same panel | result + toast | preserve entered values | trigger/result | `src/gateway/mcp.ts` |
| Run destructive-class tool | explicit action → confirm | confirm action busy | same panel | result + toast | dialog stays open on failure | trigger or surviving context | `src/gateway/mcp.ts`, `src/gateway/agentTools.ts` |
| Dispatch agent job | Send / Dispatch | message/job status card | Chat / Jobs | job status then normalized result | preserve user message; retry creates a new job | composer | `docs/backend/AGENT_CONTROL_PLANE.md` |
| Cancel active job | Cancel → confirm | dialog action busy | same job | terminal status | show failure; no auto-retry | job card action | `src/shared/agents.ts` |
| Review diff | Review diff | output busy | Jobs / Tool result | canonical diff chunk | cursor/path preserved for retry | diff output | `src/gateway/agentTools.ts` |
| Apply completed job | Apply verified changes → strong confirm | dialog action busy | same job | server-confirmed APPLIED | dialog remains; explain rejection/quarantine result | job action / status | `docs/backend/AGENT_CONTROL_PLANE.md` |
| Discard completed job | Discard → confirm | dialog action busy | same job | server-confirmed DISCARDED | dialog remains on failure | job action / status | `docs/backend/AGENT_CONTROL_PLANE.md` |
| Disconnect | Disconnect | immediate | Connection screen | key cleared from memory | n/a | API key field | `docs/security/SECURITY.md` |

## Navigation and responsive behavior

- **Route document title:** `{Page} — QuaranGate Console`; connection/error states update the title honestly.
- **Route errors / 403:** transport/tool 403 is an in-context access-boundary state; unknown hash routes render an app-owned Not Found view with a link to Overview.
- **Sidebar:** persistent at >= 880px; app-owned modal drawer below that width with focus trap, Escape close, inert background, and trigger focus restoration.
- **Responsive tables:** preserve table semantics and use explicit horizontal overflow; do not silently drop columns.
- **Truncation/full-value access:** IDs may visually truncate only where an adjacent explicit copy/view action or wrapped detail exists. Secrets are never shown by default.
- **Focus restoration:** dialogs/drawers restore focus; sticky surfaces must not cover focused content.

## Overlays and feedback

- **Dialog primitive:** `ConfirmDialog`, one shared app-owned modal implementation.
- **Destructive confirmation:** warning for stop/restart/cancel/discard; danger for delete and live `agent_apply`. Copy names the tool/object and consequence.
- **Toast:** bottom-right desktop, bottom inset narrow screens; deduplicated by message+tone; routine duration 4.5s; never includes secrets/raw backend payloads.
- **Alert/banner:** connection, degraded state, forbidden, and persistent tool errors use inline/page banners when action is required.
- **Tooltip:** native `title` is not used as the product tooltip system. Controls that need explanation expose visible helper text or `aria-describedby`.
- **Unsaved changes:** not applicable to route navigation because command/tool forms are transient by design; navigation does not silently submit them.
- **Layer order:** drawer < dialog < toast. Only one modal layer may be active.

## Async and resilience

- **Mutation default:** pessimistic. The UI changes canonical state only after MCP confirms success.
- **Duplicate-submit:** every operation owns a pending key; same operation cannot run twice concurrently from the same control.
- **Auto-save/drafts:** none. Prompts, commands, credentials, and tool JSON are not persisted.
- **Offline/degraded:** request failure keeps readable prior output, shows a stable connection state, and offers reconnect/retry.
- **Retry/backoff:** direct tool calls are user-retried. Agent status polling uses bounded interval and stops on terminal state, explicit cancellation, disconnect, or timeout.
- **Conflict/multi-tab:** no client-side shared mutation state is assumed. Server remains authoritative.
- **Session expiry/auth:** 401/invalid credential moves console to disconnected state without retaining the credential outside memory.
- **Long-running work:** agent jobs show truthful lifecycle states (QUEUED/PREPARING/RUNNING/VALIDATING/etc.), elapsed time when available, and Cancel only when active.
- **Stale requests:** route/view rendering is keyed to request tokens; late responses never overwrite a newer invocation's result for the same output slot.
- **Mutation failure:** forms/dialog context stays intact so the user can correct or retry.

## Validation

- **Schema layer:** server MCP Zod schemas are canonical. Client validation handles required/obvious bounds only and does not duplicate security policy.
- **Trigger timing:** validate on explicit submit; then correct inline.
- **Error policy:** concise product error + safe server message. Raw stack traces are not rendered as product copy.
- **Sensitive values:** API key is masked and held in JavaScript memory only. Never store in URL, localStorage, sessionStorage, toast, or console output.
- **Product forms:** `novalidate`; first invalid field is focused; duplicate submission prevented; entered non-sensitive values survive failures.

## Permission and clipboard

- **Permission UI:** server authorization is source of truth. Unknown permission remains visible; after a 403/forbidden result the specific action is marked unavailable with explanation for the current connection.
- **Clipboard:** no automatic clipboard use in v1. Technical values can be selected manually; the API key is never copied by the application.
- **Disabled-state explanation:** visible helper/error text or `aria-describedby`, never color-only.

## Full U1 operational surfaces

The production Console navigation additionally owns Projects, Review & Approvals, IDE Sessions, GitHub, Local AI / Models, Monitoring, Statistics, Security & Access, Audit & Evidence, Recovery & Backups and Settings. These routes must not become dead placeholders: where a backend contract does not yet exist or is not qualified, the route renders the exact capability state (`UNKNOWN`, `NOT_IMPLEMENTED`, `NOT_QUALIFIED`, `DEFERRED`, or equivalent) and explains the authority boundary.

Monitoring uses the authenticated `control_center_query` read model. Its default telemetry is metadata-only and principal-scoped; prompts, tool arguments, file contents, command output, response bodies and credentials are excluded. Activity retention is bounded in gateway memory and is not represented as long-term analytics. Topology/provenance, egress policy, provider state, incidents and resource lifecycle must distinguish live evidence from declared policy.

Security & Access owns the read-only Authority Explorer/preflight. A preflight result is advisory and never reserves or creates authority. GitHub write workflows and all other destructive-class operations still cross the shared app-owned confirmation primitive and the server remains canonical.

`Ctrl+K` / `Cmd+K` opens the command palette for pages and tool metadata. The palette can navigate to Tool Lab but never executes a destructive tool directly.

## Verification

- **Required static commands:** `npm run typecheck`, `npm test`, `npm run build`, `npm run test:console`, premium strict audit, anti-pattern grep.
- **Browser matrix:** Chromium desktop + narrow viewport; keyboard-only navigation; reduced motion; connection error; loading; empty/no-results; forbidden; tool success/failure; destructive confirmation; chat/job success/cancel where an authorized runtime is available.
- **Accessibility:** semantic landmark/control inspection, focus-visible, modal trap/restoration, live regions, form labels/errors, and 200% zoom spot check.
- **Canonical sibling flow:** none existed before U1; the shared primitives defined by this changeset become the canonical console behavior.
- **Project audit:** premium strict audit is mandatory before completion.
- **Failure-path evidence:** browser/mock tests must cover 401/403, MCP error, destructive confirmation cancellation, and agent polling termination.
