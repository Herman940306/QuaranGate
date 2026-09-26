# Frontend continuation file register — FE3

> **Mandatory current frontend source of truth:** before any frontend task, read [FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md](./FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md). It defines the owner-directed distinction between the accepted functional baseline and the still-required final visual-design convergence.

This register supplements `frontend/README.md` without editing an existing file outside A-008's write scope. FE3-R1-01 has orchestrator PASS_REVIEW; final source qualification is complete and candidate freeze is pending. Default runtime returns integration pending; fixtures prove no live backend behavior.

| Created path (relative to repo) | Purpose / key exports | Owning route or feature / owned state | API or mock dependency / future backend integration |
|---|---|---|---|
| `frontend/src/lib/client/product/contracts.ts` | Semantic contracts; ProductClient, ProductAdapter, ProductContext, ProviderView, ProfileView, intents, options, Result, productCopy | Provider/profile client; no stored state | Injected adapter; exact accepted envelope/context/version/custody contract required |
| `frontend/src/lib/client/product/projection.ts` | Allowlist parsers; record, text, list, unique, context, sameContext, options, provider, profile, allowed | Safe metadata projection; no state | Unknown adapter replies; future server safe projection and bounded options |
| `frontend/src/lib/client/product/client.ts` | createProductClient | Provider/profile operations; transient request objects only | Pending default; future accepted custody/CSRF/context transport |
| `frontend/src/lib/client/product/request.ts` | ProductRequest | Cancellation/arbitration; generation, controller, timer | Injected client promises; no rollback assumption |
| `frontend/src/lib/client/product/fixtures.ts` | createFixtureAdapter, fixtureOptions, fixtureProvider, fixtureProfile, fixtureScenarios | Synthetic tests/preview; metadata maps per workspace | Deterministic fixtures only; no production adapter |
| `frontend/src/components/product-boundary.tsx` | ProductClientProvider, ProductBoundary | Product routes; injected client context, identity epoch | FE2 identity hook; future accepted identity/product binding |
| `frontend/src/components/product-state.tsx` | useProductRequest, ProductFeedback, ProductCancel | Product operations; result/pending request and cancellation | ProductRequest; safe fixed errors, future accepted semantic mapping |
| `frontend/src/components/product-provider-editor.tsx` | ProviderEditor | Providers; uncontrolled transient DOM fields, password cleared | Current inventory options and submit intent; server custody later |
| `frontend/src/components/product-profile-editor.tsx` | ProfileEditor | Agent Profiles; uncontrolled fields and name error | Current returned options and submit intent; server reference authorization later |
| `frontend/src/components/product-inventory.tsx` | Providers, AgentProfiles | Inventories/detail; result, selected id, editing, recovery focus | Injected ProductClient, FE2 context; no live routes |
| `frontend/src/components/product-preview.tsx` | ProductPreview | Development qualification; scenario/surface/synthetic identity, fixture clients | Synthetic identity/product adapters; production refusal requires smoke validation |
| `frontend/src/app/(foundation)/providers/page.tsx` | Page, metadata | /providers; no page state | Providers component; accepted server adapter pending |
| `frontend/src/app/(foundation)/agent-profiles/page.tsx` | Page, metadata | /agent-profiles; no page state | AgentProfiles component; accepted server adapter pending |
| `frontend/src/app/product-preview/page.tsx` | Page, metadata | /product-preview; no page state | Dev-only dynamic import and notFound; production gate still unverified |
| `frontend/tests/unit/product.test.ts` | No public exports; thirteen boundary tests | Qualification; isolated transient synthetic test state | Vitest / injected fixtures; post-integration regressions required |
| `docs/frontend/FE3_HANDOFF.md` | Authority, checkpoints and integration gaps; no exports | FE3 handoff; no runtime state | Source/gate evidence; R1 accepted |
| `docs/frontend/README.md` | This file register; no exports | FE3 documentation; no runtime state | Source paths; maintain every future created file |
| `docs/frontend/fe3-evidence/PARTIAL_VALIDATION.json` | Exact local validation commands/output/exits; no exports | Partial verification; historical evidence only | Typecheck/lint/focused units/diff; no freeze or browser acceptance |

| `frontend/tests/e2e/product.spec.ts` | Chromium FE3 browser qualification | Synthetic provider/profile routes, interactions and screenshots | Dev-only fixtures; production pending checks |
| `docs/frontend/fe3-evidence/validation.json` | Gate commands, outputs and exits | Qualification receipt | Includes failed hydration-race attempts and final pass |
| `docs/frontend/fe3-evidence/premium-ui.json` | Strict premium static audit | Visual/source audit receipt | Zero findings required |
| `docs/frontend/fe3-evidence/security.json` | Bounded changed-file source and ownership scan | Security receipt | Static defense in depth |
| `docs/frontend/fe3-evidence/SHA256SUMS` | Evidence/source digest manifest | Freeze preparation | Hashes user-facing committed evidence |
| `docs/frontend/fe3-evidence/fe3-*.png` | Synthetic browser screenshots | Desktop, narrow, profile and forced-colors evidence | No live provider data |

Existing files changed: `frontend/src/components/shell.tsx` adds navigation links; `frontend/tests/e2e/operational.spec.ts` waits for hydration before legacy input interactions; `frontend/tests/production-smoke.mjs` covers FE3 production routes and preview refusal. Existing appearance/identity/operational owners remain retained.
