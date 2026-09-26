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


## FE16 Tool Lab and navigation discovery

| File | Purpose / exports | Route / owned state | API / future integration | Readiness |
|---|---|---|---|---|
| `src/app/(foundation)/tool-lab/page.tsx` | Page/metadata | `/tool-lab`; none | ToolLab; accepted same-origin deployment separate | Scaffold-only candidate |
| `src/components/tool-lab.tsx` | ToolLab | Tool Lab; discovery receipt in memory | fixed tools/list; current source catalog; no generic invocation | Source candidate |
| `src/lib/operational/tool-discovery.ts` | DiscoveredTool/discoveryPage/compareTools | Tool Lab; none | safe schema projection and exact comparison; no silent drift acceptance | Source candidate |
| `src/lib/navigation.ts` | productRoutes | Shell/palette; none | existing accepted routes plus authorized continuation routes | Source candidate |
| `src/components/command-discovery.tsx` | CommandDiscovery | Shell; memory-only search/modal | fixed route links; no tool invocation | Source candidate |
| `tests/unit/tool-lab.test.ts` | current-registration/pagination/drift/security tests; no exports | FE16 tests; fixtures | Vitest/current repository source/injected transport | Test fixture |
| `tests/e2e/tool-lab.spec.ts` | exact/drift/palette/focus/axe/storage/responsive; no exports | FE16 tests; browser state | Playwright/synthetic tools/list; actual deployment discovery remains unverified | Test fixture |

Existing transport adds only fixed bounded MCP discovery (10 pages, 1,000 tools, 2 MB per page, 30-second aggregate timeout); client exposes discoverTools. Existing catalog is checked against current gateway registrations, not a hard-coded historical tool count. Extra tools have UNKNOWN authority and remain unsupported. Destructive/execution requests stay in existing governed workflows; palette navigation never dispatches. Browser credentials/configuration are unchanged.


## Frontend convergence qualification

| File | Purpose / exports | Feature / owned state | API / future integration | Readiness |
|---|---|---|---|---|
| `tests/unit/convergence.test.ts` | required 21 routes and shell coverage; no exports | Convergence; none | current route files/navigation; deployment separate | Test fixture |
| `tests/e2e/convergence.spec.ts` | 21 routes at 1280/360, axe, storage/IDB/cookies, focus/keyboard/reduced-motion; no exports | Convergence; ephemeral browser | explicitly unavailable MCP fixture; no live integration/acceptance claim | Test fixture |

Chat/governed agent experience uses the existing accepted `/arena` route. No accepted route is renamed or removed. Bounded tables own intentional horizontal scrolling. Convergence checks source/browser behavior; identity/adapter/live deployment acceptance remains separate.


`npm run test:e2e` qualifies development-only fixture workflows. `npm run test:e2e:production` requires a prior production build and qualifies all 21 primary product routes, including strict zero IndexedDB/cookie/storage checks. The installed Next development debug channel creates its own IndexedDB database; strict production persistence is therefore checked on the production bundle without disabling framework behavior or relaxing assertions.

| File | Purpose / exports | Feature / owned state | API / future integration | Readiness |
|---|---|---|---|---|
| `playwright.production.config.ts` | fixed loopback production harness; default config | Production convergence; temporary runner/server | existing production start script; no deployed/live backend claim | Test harness |

Existing package scripts add only the production browser qualification command; no dependency changes. Development harness excludes the production-only convergence spec. Existing header CSS allows the palette control to wrap at magnified/narrow layouts.

## VD0 visual baseline evidence

The new evidence directory `../docs/frontend/evidence/VD0/` records the current behavioral substrate before visual changes. It is a review candidate, not owner or independent visual acceptance.

| File | Purpose / exports | Feature / owned state | Dependency / integration expectation | Readiness |
|---|---|---|---|---|
| `../docs/frontend/evidence/VD0/capture.mjs` | Reproducible route screenshots; no exports | VD evidence; temporary browser/server | Installed Playwright and fresh production build; synthetic unavailable MCP only | Evidence harness |
| `../docs/frontend/evidence/VD0/manifest.py` | SHA-256 inventory; no exports | VD evidence; no product state | Python/Git/files; no backend integration | Evidence harness |
| `../docs/frontend/evidence/VD0/REVIEW.md` | Baseline findings and scope; no exports | VD0; no product state | DESIGN.md, normative SOT, inspected renders | Review candidate |
| `../docs/frontend/evidence/VD0/capture.json` | Exact per-file route/viewport/state register; no exports | VD0; capture receipts | Production render with synthetic MCP unavailable; live integration separate | Evidence |
| `../docs/frontend/evidence/VD0/historical-hashes.json` | Historical PNG preservation inventory; no exports | VD0; hashes only | Tracked immutable baseline bytes | Evidence |
| `../docs/frontend/evidence/VD0/SHA256SUMS.json` | Every new evidence file and its SHA-256; no exports | VD0; hashes only | New evidence bytes | Evidence |
| `../docs/frontend/evidence/VD0/build.txt`, `capture.txt` | Fresh build/capture logs; no exports | VD0; logs only | Local production harness; no deployment proof | Evidence |

All 48 individual PNG paths, owning route, viewport and synthetic-state limitations are registered in `capture.json`; they have no exports/product state/backend integration and remain evidence-only candidates.

## VD1 draft and evidence correction

`../docs/frontend/evidence/VD1/INVALIDATION.md` supersedes VD0's production-render provenance claim. A pre-existing Next development server owns port 3100; the initial capture helper failed to verify server ownership. VD0 bytes remain historical, but the phase must be recaptured before VD1 can qualify/freeze. VD1 source changes are an uncommitted draft.

| File | Purpose / exports | Feature / owned state | Dependency / integration expectation | Readiness |
|---|---|---|---|---|
| `../docs/frontend/evidence/VD1/INVALIDATION.md` | Provenance correction, failure and exact continuation; no exports | VD0/VD1; no product state | Observed processes and runner logs; ownership resolution required | Blocked review receipt |
| `../docs/frontend/evidence/VD1/capture.json` | Individual PNG path/route/viewport register; no exports | VD1; capture receipts only | Unowned development server, synthetic unavailable MCP; production provenance unverified | Invalid for qualification |
| `../docs/frontend/evidence/VD1/capture.txt` | Capture progress; no exports | VD1; logs only | Unverified render provenance | Evidence only |
| `../docs/frontend/evidence/VD1/typecheck.txt`, `lint.txt`, `test.txt` | Earlier draft source checks; no exports | VD1; logs only | Local tools; final two adjustments not covered | Partial evidence |
| `../docs/frontend/evidence/VD1/build.txt`, `audit.txt`, `secret-scan.json` | Build exit, vulnerability report and bounded source scan; no exports | VD1; receipts only | Local build shares generated output with existing dev process; scan not exhaustive | Partial evidence |
| `../docs/frontend/evidence/VD1/browser-production.txt` | Port-conflict failure; no exports | VD1; log only | No browser tests executed | Blocked evidence |
| `../docs/frontend/evidence/VD1/SHA256SUMS.json` | Every draft evidence file and hash; no exports | VD1; hashes only | Current new evidence bytes; no acceptance implication | Evidence |

The 48 VD1 PNGs are individually registered in capture.json: each owns its named route/viewport, has no exports/product state, depends on an unowned development render with synthetic MCP unavailable, has no backend integration expectation and is invalid for phase qualification. Do not reuse the VD0 capture helper without resolving its readiness/ownership flaw.

## Ownership release and VD0 recapture continuation

The owner authorized SIGTERM to exactly PIDs 480503 and 327402. Both identities were verified using cwd, command line, start ticks and pidfds; 480503 owned loopback port 3100. Both exited and their observed children 480633/480657 disappeared. No other PID was signalled. The preserved seven-file VD1 draft matches INVALIDATION.md and remains unstaged. Historical VD0/VD1 files are preserved.

| File | Purpose / key exports | Owning feature / state | API/mock dependency / future integration | Readiness |
|---|---|---|---|---|
| `tests/visual-recapture.mjs` | CLI capture harness; no exports; exclusive port probe, exact child listener ownership, readiness timeout, served-asset hashes, stable bundle hashes and awaited SIGTERM cleanup | VD0/VD1 visual evidence; owns only spawned production server/browser | Next production snapshot, Playwright, Linux `/proc` and `ss`; synthetic unavailable MCP, no live integration | Qualification harness candidate |
| `../docs/frontend/evidence/VD0-RECAPTURE-20260926/source.json` | Immutable HEAD/tree and per-file source register; no exports | VD0 baseline; evidence state only | Git blob bytes, isolated snapshot; no backend integration | Evidence candidate, uncommitted |
| `../docs/frontend/evidence/VD0-RECAPTURE-20260926/build.txt`, `capture.txt`, `server.txt` | Build/capture/server logs; no exports | VD0 baseline; logs only | Isolated webpack production build/server; no deployment proof | Evidence |
| `../docs/frontend/evidence/VD0-RECAPTURE-20260926/capture.json` | Individual PNG paths, route/viewport/image hashes, bundle manifest and owned-server provenance; no exports | VD0; capture receipts only | Synthetic unavailable MCP; no backend integration expectation | Rendered baseline candidate; not owner acceptance |

Every PNG created by recapture is individually registered in capture.json with path, owning route, viewport, hashes and measurements. Each has no exports/product state and is evidence-only. The ignored `test-results/vd0-source-20260926/` is a generated copy of the tracked frontend at HEAD; its complete file inventory is source.json. It owns no product state, uses the existing installed dependencies via a symlink, and is never the implementation lane. Baseline screenshots never include the dirty VD1 source. No old capture evidence is overwritten.

Additional continuation evidence in `../docs/frontend/evidence/VD0-RECAPTURE-20260926/`:

| File | Purpose / key exports | Owner / state | Dependency / future integration | Readiness |
|---|---|---|---|---|
| `conflict-regression.json` | Existing-listener refusal and preservation check; no exports | Capture harness; receipt only | Live owned capture listener, second invocation; no backend expectation | Regression evidence |
| `vd1-browser-recheck.txt` | Full VD1 development E2E log; no exports | VD1; logs only | Playwright fixtures; no production-render or deployment proof | Validation evidence |
| `premium-audit.json` | Strict static audit output; no exports | VD1; 51 findings, exit 2 | Premium audit scans frontend including generated output; no backend expectation | Failed check; findings require review |
| `qualification.json` | Fresh check commands/results and remaining gaps; no exports | VD0/VD1; receipt only | Local source/capture/validation tools; no integration claim | Partial qualification, implementation stopped on audit failure |
| `vd1-source-hashes.json` | Hash register for six preserved VD1 implementation/test files; no exports | VD1; evidence only | Working source; no backend expectation | Provenance receipt |
| `LANE_RELEASE.md` | Authorized release identities, signals, poststate, capture correction and stopped handoff; no exports | VD0/VD1; handoff only | Process/kernel observations, Git and validation receipts; no backend expectation | Unaccepted candidate handoff |
| `SHA256SUMS.json` | Hash register of all new evidence files except itself; no exports | VD0 recapture/VD1 recheck; evidence only | Local immutable file bytes; no backend expectation | Evidence manifest, no acceptance implication |

Strict Premium audit exited 2. Implementation stopped under the owner's validation rule. The scan also treats generated HTML and ignored source snapshots as input and does not discover the repository-root DESIGN.md when invoked on frontend; its findings are not automatically runtime regressions. It also reports findings in existing components. No contracts or components were changed to bypass this failure. VD1 remains an uncommitted, partially rechecked draft. New baseline evidence is uncommitted and not an independent or owner visual acceptance.

| Additional generated file | Purpose / key exports | Owner / state | Dependency / future integration | Readiness |
|---|---|---|---|---|
| `premium-audit.json` | Audit tool's default duplicate JSON report; no exports | VD1 static audit; findings only | Same strict audit command; no backend expectation | Failed audit evidence; untracked |

The development browser recheck finished with 71 passing tests and one contrast failure (attention badge in light/Warm Workbench/comfortable, 4.45:1 vs required 4.5:1). Next also regenerated the existing `next-env.d.ts` to development route-type imports; that new generated drift is separate from the interrupted VD1 source and is preserved. No further source implementation occurred after validation failed. See LANE_RELEASE.md for the exact stopped handoff.

## VD1 R1 inspection stop

R1 stopped before source mutation under the owner's separate-issue stop condition. Strict Premium findings differ from the attention contrast failure: generated trace HTML, incorrect audit project-root resolution, and historical source findings. The concrete Agent Arena form noValidate omission predates VD1. Historical evidence and generated next-env drift remain preserved; no R1 gates or freeze are asserted.

| File | Purpose / key exports | Owner / state | API/mock dependency / future integration | Readiness |
|---|---|---|---|---|
| `../docs/frontend/evidence/VD1-R1/prestate.json` | HEAD/tree/status and source/historical evidence hash registers; no exports | VD1 R1; receipt only | Git and local file bytes; no backend integration | Evidence only |
| `../docs/frontend/evidence/VD1-R1/findings-classification.json` | All 51 unchanged audit findings classified; exact badge failure and token trace; no exports | VD1 R1; diagnostic state only | Preserved failure logs, current source and HEAD blob comparisons; no live backend | Inspection evidence; no acceptance |
| `../docs/frontend/evidence/VD1-R1/REPORT.md` | Required report fields and owner-directed scope stop; no exports | VD1 R1; handoff only | Local provenance/classification; no backend integration | Stopped before remediation |
| `../docs/frontend/evidence/VD1-R1/diff-check.txt` | Fresh whitespace/diff validation result; no exports | VD1 R1; log only | git diff --check; no backend integration | Documentation validation |
| `../docs/frontend/evidence/VD1-R1/SHA256SUMS.json` | Every new R1 evidence file hash except itself; no exports | VD1 R1; hashes only | New local evidence bytes; no backend integration | Evidence manifest |

## VD1 R2 bounded continuation

R2 adds `noValidate` only to the Agent Arena composer, preserves its submit/requestSubmit semantics, and derives light Warm Workbench attention text from 85% normative attention plus 15% ink. The override applies to explicit Light and System with a light preference; other palettes and dark presentation retain their existing derivation. Existing Arena and foundation browser cases cover submission, themes, narrow layout, forced colors and 200% layout magnification.

Run Strict Premium from the repository root and explicitly select the tracked frontend manifest:

```sh
python3 <frontend-design-premium-skill>/scripts/audit_project.py . --config frontend/premium-ui.json --mode strict --output docs/frontend/evidence/VD1-R2/premium-after.json
```

For later runs, use a NEW evidence output path. The manifest's `frontend/src`, `UX-CONTRACT.md`, and failure-test paths are repository-root-relative. Do not invoke the scanner with `frontend` as project root or add duplicate contracts there. Correct root/config selection scans only `frontend/src`; generated test reports and Next output are excluded. No scanner rule was changed.

Correct invocation reduces 51 findings to nine before product edits and eight after the form repair. The remaining eight are the scanner treating imported JSX `Textarea` calls as literal textarea elements. The shared primitive supplies `resize-none`; global CSS supplies `resize: none`; runtime browser assertions verify the owner. The scanner has no supported Textarea ownership-resolution option. Status remains `BLOCKED_SCANNER_STATIC_RESOLUTION`, requiring owner/reviewer adjudication, not scanner PASS.
