# QuaranGate product frontend — F1 foundation

This directory owns the additive Next.js product frontend foundation. It does not replace or modify the accepted static operational Console in `../console/`, and it exposes no MCP, gateway, database, identity, provider, Docker, deployment, or production authority.

The current candidate is implemented for F1 and awaits independent review; it is unaccepted. Before continuing implementation or relying on validation results, read [`../docs/frontend/F1_FRONTEND_FOUNDATION_HANDOFF.md`](../docs/frontend/F1_FRONTEND_FOUNDATION_HANDOFF.md).

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
- No business routes or operational backend calls exist.
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
| `tests/production-smoke.mjs` | Production route/storage/header checks; no exports | Tests; bounded server/browser | Production Next; later deployment qualification | Foundation |
