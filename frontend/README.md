# QuaranGate product frontend — F1 foundation and FE1 read candidate

This directory owns the additive Next.js product frontend foundation. It does not replace or modify the accepted static operational Console in `../console/`, and it exposes no MCP, gateway, database, identity, provider, Docker, deployment, or production authority.

F1 is accepted by the current owner prompt. FE1 is an unreviewed read-only source candidate. Before continuing implementation or relying on validation results, read [`../docs/frontend/F1_FRONTEND_FOUNDATION_HANDOFF.md`](../docs/frontend/F1_FRONTEND_FOUNDATION_HANDOFF.md).

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
- Account and workspace context are explicitly labeled placeholders.
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
