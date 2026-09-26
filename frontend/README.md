# QuaranGate product frontend — FE2 identity candidate

This directory owns the additive Next.js product frontend foundation. It does not replace or modify the accepted static operational Console in `../console/`, and it exposes no MCP, gateway, database, identity, provider, Docker, deployment, or production authority.

F1 and FE1 are accepted by the current owner prompt. FE2 is an unreviewed identity frontend source candidate. Before continuing implementation or relying on validation results, read [`../docs/frontend/F1_FRONTEND_FOUNDATION_HANDOFF.md`](../docs/frontend/F1_FRONTEND_FOUNDATION_HANDOFF.md).

## Toolchain

- Node.js 24.15 or newer
- npm with the committed `package-lock.json`
- Next.js App Router, React, strict TypeScript, Tailwind CSS, Motion for React
- locally packaged IBM Plex Sans and IBM Plex Mono assets

Install and run locally:

```bash
npm ci
npm run dev
```

The foundation route is `/`. `/design-system` exists only in development and returns 404 from the production build. It is excluded from normal product navigation outside development.

## Ownership

- `src/app/` owns layouts, route boundaries, semantic CSS tokens, and the F1 shell.
- `src/components/` owns shared controls, status/state surfaces, appearance controls, tabs, overlays, focus behavior, and motion examples.
- `src/lib/appearance.ts` owns the typed appearance schema and replaceable persistence adapter.
- `src/lib/motion.ts` owns the four approved motion categories.
- `tests/unit/` owns pure contracts and server-safe primitive assertions.
- `tests/e2e/` owns real-browser accessibility, keyboard, focus, responsive, storage, local-font, appearance, and reduced-motion evidence.

`DESIGN.md` remains the visual source of truth. `src/app/globals.css` is the product-foundation runtime adapter. Tailwind v4 exposes the semantic variables to utilities through `@theme inline`; shared components consume stable semantic CSS classes.

Native `<select>` is intentional. The current contract accepts the platform-owned popup because F1 choices are short, stable, and do not require authored search or popup geometry.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm run test:production-smoke
```

The repository-wide existing Console and backend gates remain separate and must also pass before handoff.

## F1 limitations

- Appearance preferences live only in page memory and reset on reload. The adapter is ready for later authenticated persistence.
- Historical F1 account/workspace placeholders are replaced by FE2 explicit identity-integration-pending states.
- F1 itself is disconnected; the FE1 routes below make explicit same-origin read calls.
- No user, health, provider, security, monitoring, or authorization value is synthesized.
- Production deployment topology is not changed by F1.

## File ownership register

All entries are F1 candidates pending independent review. “Foundation” means implemented for the bounded F1 scope, with no backend integration or production deployment claim. Development examples are feature-gated. Tooling owns no product state.

| File | Purpose / key exports | Route or feature / owned state | API or mock dependency / future integration | Readiness |
|---|---|---|---|---|
| `package.json` | Package scripts and pinned dependencies; no exports | Toolchain; none | npm; separate frontend build | Foundation |
| `package-lock.json` | Exact dependency graph and integrity; no exports | Toolchain; none | npm registry; retain reproducibility | Foundation |
| `.gitignore` | Generated-path exclusions; no exports | Source hygiene; none | Git; no backend expectation | Foundation |
| `AGENTS.md` | Installed Next agent guidance; no exports | Engineering; none | Local Next docs; no backend expectation | Foundation |
| `CLAUDE.md` | Installed Next agent guidance; no exports | Engineering; none | Local Next docs; no backend expectation | Foundation |
| `README.md` | Install, ownership, validation, file register; no exports | Documentation; none | Source/tests; update with later phases | Foundation |
| `DEPENDENCIES.md` | Dependency purpose/license notes; no exports | Supply chain; none | Locked packages; future scan evidence | Foundation |
| `biome.json` | Tailwind-aware recommended lint config; no exports | Toolchain; none | Biome; no backend expectation | Foundation |
| `next.config.ts` | Local build root and response headers; default config | Framework; none | Next; deployment headers require later review | Foundation |
| `next-env.d.ts` | Generated framework types; no value exports | Types; none | Next; no backend expectation | Foundation |
| `postcss.config.mjs` | Tailwind compiler adapter; default config | Styles; none | Tailwind; no backend expectation | Foundation |
| `tsconfig.json` | Strict compile contract; no exports | Types; none | TypeScript; later typed adapters | Foundation |
| `premium-ui.json` | Scoped audit contract; no exports | Audit; none | Premium audit; retain separate Console gates | Foundation |
| `vitest.config.ts` | Unit harness; default config | Tests; none | Vitest; add later contract tests | Foundation |
| `playwright.config.ts` | Loopback browser harness; default config | Tests; ephemeral server | Playwright; later integration harness | Foundation |
| `src/proxy.ts` | Production design-route refusal; `proxy`, `config` | Design route gate; none | Next request/response; no operational proxy | Foundation |
| `src/app/layout.tsx` | Fonts, metadata, appearance/overlay providers; default layout, metadata | All routes; provider composition | Local fonts/providers; later authenticated shell | Foundation |
| `src/app/globals.css` | Semantic tokens, density, responsive/focus/scroll/system-color styles | All routes; appearance presentation | DESIGN.md; later approved token changes | Foundation |
| `src/app/not-found.tsx` | Unknown-route view; default component | 404; none | Next; no backend expectation | Foundation |
| `src/app/(foundation)/layout.tsx` | Shared shell; default layout | Foundation routes; none | Shell; later route integration | Foundation |
| `src/app/(foundation)/page.tsx` | Honest disconnected foundation; default page, metadata | `/`; none | Shared primitives; future pages separately authorized | Foundation |
| `src/app/(foundation)/loading.tsx` | Stable loading view; default component | Foundation routes; none | LoadingState; later real data boundary | Foundation |
| `src/app/(foundation)/error.tsx` | Safe render failure/retry; default component | Foundation routes; error/reset | Next error boundary; later typed data errors | Foundation |
| `src/app/(foundation)/design-system/page.tsx` | Inert component inventory; default page, metadata | `/design-system`; none | Design fixtures; never operational data | Feature-gated |
| `src/components/shell.tsx` | Rail/header/drawer shell; `Shell` | Foundation routes; narrow overlay trigger | OverlayProvider; future authenticated context | Foundation |
| `src/components/appearance-provider.tsx` | Typed appearance context; provider/hook | Appearance; page-memory preferences | Memory adapter; replace with authorized persistence later | Foundation |
| `src/components/appearance-controls.tsx` | Mode/palette/density fields; `AppearanceControls` | Appearance; context selections | Native Select/provider; later preference API | Foundation |
| `src/components/primitives.tsx` | Buttons, fields, state/permission/output/table; named components, `Tone`, `TableRow` | Shared UI; props only | No API; accept typed server data in later phases | Foundation |
| `src/components/tabs.tsx` | Keyboard tabs; `Tabs` | Shared UI; active tab | React state; future route-specific content | Foundation |
| `src/components/overlays.tsx` | Modal/drawer/live feedback; `OverlayProvider`, `useOverlay` | Shared UI; overlay, trigger, message | Native dialog/Motion; navigation-only breakpoint dismissal; future bounded actions | Foundation |
| `src/components/design-examples.tsx` | Validation/overlay/tab fixtures; `DesignExamples` | Design route; local error/form values | Inert design data; no backend expectation | Feature-gated |
| `src/components/motion-sample.tsx` | Four spring demonstrations; `MotionSample` | Design route; user-triggered motion | Motion tokens; no operational activity | Feature-gated |
| `src/lib/appearance.ts` | Preference enums/parser/defaults/memory adapter | Appearance; adapter memory | No API; later authenticated preference adapter | Foundation |
| `src/lib/errors.ts` | Safe typed error copy; `errorCopy`, `ErrorCategory` | Shared errors; none | No API; later error normalization | Foundation |
| `src/lib/motion.ts` | Central springs/reduced transition; `motionSpring`, `transitionFor` | Motion; none | Motion; no backend expectation | Foundation |
| `tests/unit/foundation.test.tsx` | Pure contracts and safe-render assertions; no exports | Tests; isolated fixtures | Vitest/React rendering; extend with later behavior | Foundation |
| `tests/e2e/foundation.spec.ts` | Browser, axe, keyboard, appearance, responsive, forced-colors and 200% CSS layout-zoom evidence; no exports | Tests; isolated browser contexts | Loopback Next/axe; later authorized integration | Foundation |
| `tests/production-smoke.mjs` | Production F1 + nine FE1 route, unavailable /mcp, storage/header checks; no exports | Tests; bounded server/browser | Production Next; later deployment qualification | Foundation |

## FE1 operational client and routes

Read [`../docs/frontend/FE1_HANDOFF.md`](../docs/frontend/FE1_HANDOFF.md) for authority, checkpoint evidence and promotion limits. `/` preserves the F1 preview. The operational pages request data only through explicit reads; they do not establish identity or route `/mcp`. The default transport targets exactly relative `/mcp`, accepts same-origin cookies if provided by a later accepted identity integration, and sets no credential headers. No development Bearer adapter is shipped.

All FE1 entries below are **scaffold-only source candidates** until orchestrator review, identity/principal integration and deployment routing qualification. They own only page-memory data. No credentials, selections, prompts or output are persisted or written to URLs. The public client exposes only the listed read operations. Backend and HTTP errors are mapped to fixed safe copy, not raw messages. Control metadata is projected through an allowlist; job summaries and progress prose are omitted. Diff/Git content renders as untrusted text in bounded code panes.

| File | Purpose / key exports | Owning route or feature / owned state | API or mock dependency / future backend integration | Readiness |
|---|---|---|---|---|
| `src/lib/operational/state.ts` | Safe states, `OperationalError`, `stateCopy`, `freshness` | All reads; no mutable state | Current MCP denials; one-minute display freshness, not an authority lease | Scaffold-only |
| `src/lib/operational/transport.ts` | Typed envelopes/receipt, injected `Transport`, internal allowlisted `createReader`, `record` | MCP wire; per-request UUID, byte/time bound | Exact `/mcp` JSON/SSE; future session transport replaces injection seam | Scaffold-only |
| `src/lib/operational/contracts.ts` | Bounded decoders, safe projections and surface types | Read contracts; none | Existing gateway schemas; no backend source import in browser | Scaffold-only |
| `src/lib/operational/client.ts` | `createOperationalClient`, `OperationalClient` | Purpose-specific reads; injected transport | Targets, ACP metadata, Git, repository discovery, Control Center; future identity seam | Scaffold-only |
| `src/lib/client/use-operational-read.ts` | `useOperationalRead` | Shared read lifecycle; receipt, cancellation, pending, safe failure | Operational client; rejects superseded/unmounted reads | Scaffold-only |
| `src/components/operational-provider.tsx` | `OperationalProvider`, `useOperational` | Shell; page-memory client/last read connection state | Injected client; future accepted identity adapter | Scaffold-only |
| `src/components/operational-read.tsx` | `ReadPanel`, `ReceiptTime`, `OperationalStateView`, `MetadataTable`, `OperationalHeading` | Shared reads; request state and freshness clock | Client receipts and F1 primitives; server authority remains canonical | Scaffold-only |
| `src/components/operational-overview.tsx` | `Overview` | `/overview`; independent summary/provider/authority reads | `control_center_query`; no analytics synthesis | Scaffold-only |
| `src/components/operational-targets.tsx` | `Targets` | `/targets`; logical selection, list/detail receipts | `targets_list`, `target_inspect`; health unknown if absent; render cap is not upstream paging | Scaffold-only |
| `src/components/operational-agents.tsx` | `Projects`, `Agents` | `/projects`, `/agents`; metadata receipts | `agent_projects`, `agents_list`; no dispatch or qualification inference | Scaffold-only |
| `src/components/operational-jobs.tsx` | `Jobs`, `jobDiscoveryNotice` | `/jobs`; known ID and separate read receipts | `agent_status`, safe result metadata, first 16KiB diff, provider aggregate counts; no discovery/apply | Scaffold-only |
| `src/components/operational-git.tsx` | `Git`, `GitExecution` | `/git`; target and execution receipts | `git_status`, `git_diff` (statistics only), `git_log` (last 30); retain exit/timeout/truncation/stdout/stderr | Scaffold-only |
| `src/components/operational-github.tsx` | `GitHub` | `/github`; discovery receipt | `github_repositories`; no write/review authority inferred, no remote operations | Scaffold-only |
| `src/components/operational-control.tsx` | `ControlCenter` | `/control-center`, `/security`; independent metadata snapshots | Six current Control Center views; retain generatedAt and qualification/deferred/unknown values | Scaffold-only |
| `tests/unit/operational.test.ts` | Wire/contract regressions; no exports | Tests; isolated injected responses | Vitest; no live provider or root harness | Scaffold-only |
| `tests/unit/operational-ui.test.tsx` | Safe state/evidence/authority rendering checks; no exports | Tests; isolated static markup | Vitest/React rendering; complements browser acceptance | Scaffold-only |
| `tests/e2e/operational.spec.ts` | Browser read/error/keyboard/axe/responsive tests; no exports | Tests; mocked `/mcp` and browser memory | Playwright/axe; later live routing/identity qualification is separate | Scaffold-only |
| `src/app/(foundation)/overview/page.tsx` | Overview route, default `Page`, `metadata` | `/overview`; none | `Overview`; client-only reads, no server API | Scaffold-only |
| `src/app/(foundation)/targets/page.tsx` | Targets route, default `Page`, `metadata` | `/targets`; none | `Targets`; client-only reads, no server API | Scaffold-only |
| `src/app/(foundation)/projects/page.tsx` | Projects route, default `Page`, `metadata` | `/projects`; none | `Projects`; client-only reads, no server API | Scaffold-only |
| `src/app/(foundation)/agents/page.tsx` | Agents route, default `Page`, `metadata` | `/agents`; none | `Agents`; client-only reads, no server API | Scaffold-only |
| `src/app/(foundation)/jobs/page.tsx` | Jobs route, default `Page`, `metadata` | `/jobs`; none | `Jobs`; client-only reads, no server API | Scaffold-only |
| `src/app/(foundation)/git/page.tsx` | Git route, default `Page`, `metadata` | `/git`; none | `Git`; client-only reads, no server API | Scaffold-only |
| `src/app/(foundation)/github/page.tsx` | GitHub route, default `Page`, `metadata` | `/github`; none | `GitHub`; client-only reads, no server API | Scaffold-only |
| `src/app/(foundation)/control-center/page.tsx` | Control Center route, default `Page`, `metadata` | `/control-center`; none | `ControlCenter`; client-only reads, no server API | Scaffold-only |
| `src/app/(foundation)/security/page.tsx` | Security & Access route, default `Page`, `metadata` | `/security`; none | `ControlCenter`; client-only reads, no server API | Scaffold-only |

FE1 retains F1 typography, tokens, native fields, keyboard output scrolling, responsive drawer and motion rules. `src/components/shell.tsx` adds route links and a last-read connection label, which is not a session or authority claim. Live deployment routing and product identity mapping remain unverified promotion gates. Optional files/processes/terminal surfaces are deferred; no terminal execution was introduced.

## FE2 identity boundary (A-007)

Owner prompt accepts FE1. FE2 adds identity presentation against an injected semantic client, with no accepted BE1 adapter. Default identity is unavailable/integration pending; no successful login is fabricated. `/sign-in`, `/account`, `/workspaces`, `/permissions` are public presentation routes, not route protection or operational authorization. Every operation remains server-authorized. `/identity-preview` is a development-only synthetic qualification surface, 404 in production. No email, token, claim, cookie or operational credential is included in the session view.

Read [`../docs/frontend/FE2_HANDOFF.md`](../docs/frontend/FE2_HANDOFF.md) for checkpoints, safe shape and integration requirements. `IdentityStore` clears account context and increments a projection epoch before identity requests and after their outcomes. Operational hooks immediately hide prior receipts and abort pending reads on an epoch change; existing FE1 route subtrees also remount to clear resource inputs. Identity controls stay mounted; appearance remains page-memory only outside the reset boundary. No localStorage, sessionStorage, indexedDB or URL identity state is used. Cancellation of a mutation does not prove server rollback: check session to reconcile.

### FE2 file register

All FE2 entries are **scaffold-only source candidates** pending review and accepted BE1 integration, except explicitly feature-gated fixture tooling. No production deployment readiness is claimed.

| Created file | Purpose / key exports | Owning route or feature / owned state | API or mock dependency / future integration | Readiness |
|---|---|---|---|---|
| `src/lib/identity/contracts.ts` | Safe session/state/adapter types; SessionView, IdentityState, IdentityClient, IdentityAdapter, identityCopy | Identity; no runtime state | Semantic accepted server projection; no credentials/email/raw claims | Scaffold-only |
| `src/lib/identity/client.ts` | Runtime whitelist projection and semantic adapter; projectIdentity, createIdentityClient | Identity; no retained state | Injected adapter; default unavailable, accepted BE1 cookie/CSRF/redirect transport later | Scaffold-only |
| `src/lib/identity/store.ts` | Cancellable ordered bounded identity store; IdentityStore, IdentitySnapshot | Identity; memory snapshot, generation, controller, projection epoch | IdentityClient; version-aware server switching/reconciliation later | Scaffold-only |
| `src/lib/product/preferences.ts` | Future per-user sync seam; PreferenceSyncClient, PreferenceView, PreferenceReply, createPendingPreferenceSync | Appearance; no persisted state | Pending-only client; owner-approved versioned preference adapter later | Scaffold-only |
| `src/components/identity-provider.tsx` | Reactive context, expiry/focus/visibility revalidation; IdentityProvider, useIdentity | Shell/identity; store instance, cleanup timer/listeners | Injected semantic client; accepted identity adapter later | Scaffold-only |
| `src/components/identity-status.tsx` | Safe shared lifecycle/principal copy; IdentityStateView, PrincipalStateView, IdentityFeedback, principalCopy | Identity; props/context only | IdentityProvider; safe typed errors only | Scaffold-only |
| `src/components/identity-sign-in.tsx` | Redirect-intent sign-in; SignIn | `/sign-in`; context only | IdentityClient.beginLogin; accepted navigation adapter later | Scaffold-only |
| `src/components/identity-account.tsx` | Safe account/session and local appearance; Account, AccountSession | `/account`; context only | IdentityProvider/AppearanceProvider; safe server session later | Scaffold-only |
| `src/components/identity-workspaces.tsx` | Version-aware membership selection; Workspaces | `/workspaces`; selected member id in memory | IdentityClient.switchWorkspace; atomic server version/membership recheck later | Scaffold-only |
| `src/components/identity-permissions.tsx` | Read-only product workflow summary; Permissions, ProductAuthorization, permissionBoundary | `/permissions` + account; props/context only | Safe server summary; never computes operational grants | Scaffold-only |
| `src/components/identity-preview.tsx` | Synthetic injected adapter and projection probe; IdentityPreview | `/identity-preview`; synthetic scenario/surface/session | Deterministic synthetic data and bounded delayed replies; no live integration expectation | Feature-gated |
| `src/app/(foundation)/sign-in/page.tsx` | Sign-in route/title; default Page, metadata | `/sign-in`; none | SignIn; accepted adapter later | Scaffold-only |
| `src/app/(foundation)/account/page.tsx` | Account route/title; default Page, metadata | `/account`; none | Account; accepted adapter later | Scaffold-only |
| `src/app/(foundation)/workspaces/page.tsx` | Membership route/title; default Page, metadata | `/workspaces`; none | Workspaces; accepted adapter later | Scaffold-only |
| `src/app/(foundation)/permissions/page.tsx` | Permission route/title; default Page, metadata | `/permissions`; none | Permissions; accepted safe summaries later | Scaffold-only |
| `src/app/identity-preview/page.tsx` | Development-only fixture route, production 404; default Page, metadata | Synthetic qualification; none | Conditional dynamic IdentityPreview import; never production integration | Feature-gated |
| `tests/unit/identity.test.ts` | Session/security/concurrency/expiry contracts; no exports | Tests; synthetic sessions/deferred replies | Vitest, injected adapter; extend after BE1 integration | Scaffold-only |
| `tests/unit/identity-ui.test.tsx` | Safe UI/copy/escaping/authority assertions; no exports | Tests; inert synthetic props | Vitest/React server rendering; live integration tests later | Scaffold-only |
| `tests/unit/preferences.test.ts` | Memory/pending-only sync proof; no exports | Tests; isolated memory adapter | Vitest; real sync qualification later | Scaffold-only |
| `tests/e2e/identity.spec.ts` | Identity/browser/axe/storage/keyboard/responsive/motion coverage; no exports | Tests; isolated browser/loopback harness | Playwright + axe + synthetic preview; repeat with accepted BE1 | Scaffold-only |
| `../docs/frontend/FE2_HANDOFF.md` | Authority, checkpoints and integration handoff; no exports | FE2 documentation; no product state | Source and fresh validation receipts; orchestrator review later | Scaffold-only |
| `../docs/frontend/fe2-evidence/fe2-account-1280.png` | Desktop account screenshot; no exports | Qualification; no product state | Synthetic browser render; live visual recheck later | Scaffold-only |
| `../docs/frontend/fe2-evidence/fe2-account-360.png` | Narrow account screenshot; no exports | Qualification; no product state | Synthetic browser render; live visual recheck later | Scaffold-only |
| `../docs/frontend/fe2-evidence/fe2-stale-1280.png` | Desktop conflict screenshot; no exports | Qualification; no product state | Synthetic browser render; live visual recheck later | Scaffold-only |
| `../docs/frontend/fe2-evidence/fe2-stale-360.png` | Narrow conflict screenshot; no exports | Qualification; no product state | Synthetic browser render; live visual recheck later | Scaffold-only |

Changed existing owners: `shell.tsx` now composes identity and operational epochs; `operational-provider.tsx` tags connection state by epoch; `lib/client/use-operational-read.ts` hides/aborts prior projections; `tests/production-smoke.mjs` adds four identity routes and fixture-production exclusion. Existing file-register descriptions above remain historical F1/FE1 scope; this section records FE2 behavior.

Additional FE2 evidence register (no product state or runtime exports; all source qualification scaffolds):

| Created file | Purpose / key exports | Owning feature / state | Dependency / future integration | Readiness |
|---|---|---|---|---|
| `../docs/frontend/fe2-evidence/validation.json` | Exact mandatory frontend commands, timestamps, exits and bounded captured output; no exports | Qualification; receipts only | Local npm harness; re-run after accepted adapter | Scaffold-only |
| `../docs/frontend/fe2-evidence/premium-ui.json` | Strict static UI audit receipt; no exports | Qualification; findings only | Premium auditor; repeat after integration | Scaffold-only |
| `../docs/frontend/fe2-evidence/security.json` | Bounded changed-file credential-pattern scan and boundary assertions; no exports | Qualification; source evidence only | Changed files and browser/unit tests; live security qualification later | Scaffold-only |
| `../docs/frontend/fe2-evidence/FREEZE.json` | Post-commit immutable identity, hashes, paths and gate receipt; no exports | Review; evidence only | Git/source/evidence SHA256; orchestrator review | Scaffold-only |

`FREEZE.json` stays untracked after freezing to avoid altering the immutable candidate. Synthetic preview uses an injected fixed clock; production uses the browser clock only to restrict expired display. Appearance remains page-memory preview; preference sync stays integration pending.


## FE11 Statistics continuation

The Statistics surface reads only bounded principal-scoped `control_center_query` aggregates. Window selection remounts and automatically reads a new snapshot; previous requests are aborted and old values are cleared. The server remains the authority. Retention is gateway memory, at most 2,048 entries and 24 hours, with no durable analytics claim. These files are implementation candidates requiring independent review and live integration qualification.

| File | Purpose / key exports | Owning route / owned state | API dependency / future integration | Readiness |
|---|---|---|---|---|
| `src/app/(foundation)/statistics/page.tsx` | Statistics route; default Page and metadata | `/statistics`; none | StatisticsCenter; accepted same-origin routing still requires deployment qualification | Scaffold-only candidate |
| `src/components/statistics-center.tsx` | Bounded aggregate UI; StatisticsCenter | `/statistics`; page-memory selected window | OperationalClient statistics; current MCP read contract, no database adapter | Scaffold-only candidate |
| `tests/unit/statistics.test.ts` | Projection, bounds and invariant regression; no exports | Statistics tests; isolated synthetic responses | Vitest and injected transport; no live integration claim | Test fixture |
| `tests/e2e/statistics.spec.ts` | Desktop/narrow, axe, storage and window-read regression; no exports | Statistics tests; ephemeral browser state | Playwright/axe and explicitly synthetic MCP interception; later live qualification separate | Test fixture |

Existing `src/components/operational-read.tsx` adds an opt-in automatic read on mount, disabled by default. Statistics owns that opt-in. Existing `src/lib/operational/client.ts` and `contracts.ts` own the purpose-specific statistics request and typed bounded decoder; `shell.tsx` owns Statistics navigation. All state remains page-memory-only.


## FE12 Security & Authority Explorer

Existing `/security` now projects server grants and operation-specific advisory preflight; impact classifications never imply permission. Missing fields remain UNKNOWN. All selections/results are page-memory-only. Capability/topology reads remain the existing accepted metadata projections. Production identity integration remains pending.

| File | Purpose / key exports | Owning route / state | API / future integration | Readiness |
|---|---|---|---|---|
| `src/lib/operational/tool-catalog.ts` | Current expected source tools, ToolName, knownTool | Security/Tool Lab; none | Current gateway registrations and purpose documentation; drift must be explicit | Source candidate |
| `src/lib/operational/authority.ts` | AuthoritySnapshot, PreflightRequest, decoder and argument guard | Security; none | control_center_query authority; accepted same-origin integration | Source candidate |
| `src/components/security-explorer.tsx` | SecurityExplorer | `/security`; memory-only tool/selectors/receipts | Purpose-specific authority and capability/topology reads; live qualification separate | Scaffold-only candidate |
| `tests/unit/authority.test.ts` | Projection, denial and bounds regressions; no exports | FE12 tests; fixtures | Vitest/injected transport; no runtime claim | Test fixture |
| `tests/e2e/security.spec.ts` | Advisory denial, unavailable, keyboard, axe, storage, responsive; no exports | FE12 tests; browser state | Playwright/synthetic interception; live qualification separate | Test fixture |

Changed existing route `src/app/(foundation)/security/page.tsx` owns only route metadata/composition. Existing `client.ts` adds a bounded authority-read method. No backend, policy or authorization mutation is introduced.


## FE13 Audit & Evidence

| File | Purpose / exports | Route / owned state | API / future integration | Readiness |
|---|---|---|---|---|
| `src/app/(foundation)/audit-evidence/page.tsx` | Page/metadata | `/audit-evidence`; none | AuditEvidence; same-origin deployment separate | Scaffold-only candidate |
| `src/components/audit-evidence.tsx` | AuditEvidence | Audit; selected request and receipt in memory | activity query; richer lineage requires accepted relationships | Scaffold-only candidate |
| `src/lib/operational/activity.ts` | ActivityRow/ActivitySnapshot/activity | Audit; none | bounded metadata-only activity projection; no durable history | Source candidate |
| `tests/unit/activity.test.ts` | projection/bounds/chronology; no exports | FE13 tests; fixtures | Vitest; integration separate | Test fixture |
| `tests/e2e/audit-evidence.spec.ts` | responsive/axe/storage/unavailable; no exports | FE13 tests; browser memory | Playwright/synthetic MCP; live qualification separate | Test fixture |

Existing shell owns the added navigation and identity-epoch remount; client owns the closed activity read. Lineage stops at request → job UNKNOWN. No raw payload export or inferred relationship exists.


## FE14 Recovery & Backups

| File | Purpose / exports | Route / owned state | API / future integration | Readiness |
|---|---|---|---|---|
| `src/app/(foundation)/recovery-backups/page.tsx` | Page/metadata | `/recovery-backups`; none | RecoveryBackups; deployment separate | Scaffold-only candidate |
| `src/components/recovery-backups.tsx` | RecoveryBackups | Recovery; read receipts in memory | control recovery/resources; actual recovery evidence requires a new accepted contract | Scaffold-only candidate |
| `src/lib/operational/recovery.ts` | ResourceBoundary/resources projection | Recovery; none | existing resource boundary metadata; no cleanup API | Source candidate |
| `tests/unit/recovery.test.ts` | unknown/projection/bounds; no exports | FE14 tests; fixtures | Vitest; integration separate | Test fixture |
| `tests/e2e/recovery-backups.spec.ts` | read-only/axe/keyboard/responsive/storage/unavailable; no exports | FE14 tests; ephemeral browser | Playwright/synthetic MCP; live qualification separate | Test fixture |

Existing shell and client own navigation/context invalidation and closed read transport. CONFIGURED is not recovery success. Unsupported mutations remain external.


## FE15 Settings

| File | Purpose / exports | Route / owned state | API / future integration | Readiness |
|---|---|---|---|---|
| `src/app/(foundation)/settings/page.tsx` | Page/metadata; package-version input | `/settings`; none | existing package manifest; no runtime/deployment inference | Scaffold-only candidate |
| `src/components/settings-center.tsx` | SettingsCenter | Settings; appearance context and read receipts in memory | existing identity, capability/provider reads; settings mutation unavailable | Scaffold-only candidate |
| `src/lib/settings.ts` | settingsIdentity | Settings; none | existing safe IdentityState; integrated session adapter still pending | Source candidate |
| `tests/unit/settings.test.ts` | missing identity/authority separation; no exports | FE15 tests; fixtures | Vitest; live integration separate | Test fixture |
| `tests/e2e/settings.spec.ts` | local reset/read-only/axe/storage/keyboard/responsive; no exports | FE15 tests; ephemeral browser | Playwright/synthetic MCP; no live configuration qualification | Test fixture |

Existing shell owns navigation/context invalidation. Existing AppearanceControls remain memory-only. Backend policy and credential editing are unavailable; declared frontend version is distinct from deployed runtime evidence.
