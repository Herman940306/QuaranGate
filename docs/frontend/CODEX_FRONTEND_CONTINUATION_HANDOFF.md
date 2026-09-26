# Codex frontend continuation handoff

Lane: `/home/herman/projects/QuaranGate-product-frontend-continuation-codex` on `feature/qg-product-frontend-continuation-codex`. This is a frontend source candidate, not an acceptance or production qualification claim. No push, merge, deployment, canonical mutation, or backend edit is part of this lane.

## Immutable continuation base

- Owner-provided accepted FE3 commit: `9ef3b0a0f8d9c4c191cc0be183c8b893f741877e`
- Verified tree: `c11151847cf66965b38afc7c734ba2962f4ad06b`
- Verified parent: `e470d8303efeb70d243785f5b934cec1fa0d277a`
- Verified subject: `FE3 provider and Agent Profile frontend candidate`
- Current FE3 source and FE1/FE2/FE3 handoffs were read before FE4 mutation. FE3's frozen handoff predates the owner's final acceptance; it was not rewritten.

## FE4 checkpoint

CHECKPOINT: FE4 — Operational workstation completion
STATUS: PARTIAL

IMPLEMENTED:
- `/files`: authorized logical-target selection; workspace-relative browse, stat, bounded UTF-8 read, fixed-string search; exact-path create/overwrite, exact patch and single-file delete request forms. Delete requires typed target/path confirmation. Mutation acknowledgements are checked against the requested path, displayed with a request correlation when supplied, and followed by a fresh server read. No recursive delete control is exposed.
- `/terminal`: target-scoped command request with a 20-second requested timeout, optional workspace-relative cwd, bounded command input, whole-response output and server receipt. No streaming, command history, or unsupported cancellation is shown.
- `/processes`: bounded process output and execution metadata; no kill control.
- `/targets`: start/stop/restart request controls with typed target confirmation, exact target/action acknowledgement and post-action target inspection. No arbitrary Docker selection or container creation.
- The shell lists the new workstation routes and remounts them when the accepted identity projection epoch changes. Read failures, late results and unknown write outcomes stay explicit.

CONTRACTS USED:
- FE1 same-origin, exact `/mcp` JSON-RPC tool-call transport and read receipt/correlation boundary.
- Current `src/gateway/mcp.ts` contracts for `fs_list`, `fs_stat`, `fs_read`, `fs_search`, `fs_write`, `fs_patch`, `fs_delete`, `terminal_exec`, `process_list`, `target_start`, `target_stop`, `target_restart` and `target_inspect`. The gateway remains the authority for scopes, target confinement and policy.
- FE2 `IdentityStore` projection epoch and active mapped-principal display. A browser presentation of that state never grants operation authority.

TESTS:
- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run test`: 127/127 unit tests pass, including four new FE4 boundary tests.
- `npm run build`: pass, 24 static routes.
- `npm audit --audit-level=high --json`: zero reported vulnerabilities.
- Targeted `npm run test:e2e -- tests/e2e/workstation.spec.ts`: 3/3 pass at 1280 and 360 pixels, with axe zero violations in tested Files and Processes states.
- The first full browser run passed 37/38 tests; one new FE4 test raced FE2 hydration and was corrected to wait for network idle before interacting. Targeted rerun passed, then full Chromium suite passed 38/38. Existing E2E visual tests overwrote five tracked FE2/FE3 reference PNGs as side effects; those generated changes were restored without modifying the accepted files.
- `git diff --check`: pass; final staged check remains.
- Focused post-copy browser regression: 12/12 operational and FE4 tests pass.

INTEGRATION GAPS:
- Production identity is not connected. File/terminal/target mutation controls are disabled until an integrated active product session supplies a mapped principal. The bounded mutation transport is prepared but no live mutation was claimed or attempted.
- BE4 adapter, CSRF/session binding and route acceptance remain pending. No speculative `/api/product/*` route was added.
- The current terminal tool returns a final bounded result, not a stream or cancellation handle. Its result schema carries no host-impact warning field; the UI cannot attribute such a warning to the server.
- `fs_read` returns UTF-8 content in the gateway implementation. The UI presents bounded UTF-8 text only; binary file editing is not qualified.
- A targeted selected path is a client request, not proof of confinement. The gateway/executor must continue to enforce path and scope boundaries.

SECURITY NOTES:
- Read and mutation tool names are separate closed allowlists. No generic browser tool name or arbitrary URL is accepted.
- No credential, command history, file draft, result or target selection is persisted in browser storage. Untrusted file/process output is rendered as text in the accepted machine-output component.
- Path checks reject absolute paths, traversal, backslashes and control characters before transport; this is defense in depth and never substitutes for server confinement.
- Timeout or transport failure after a mutation is labeled unverified, never success. Automatic retry is absent.

FILES:
- `frontend/src/app/(foundation)/files/page.tsx`, `terminal/page.tsx`, `processes/page.tsx`
- `frontend/src/components/operational-workstation.tsx`, `operational-targets.tsx`, `shell.tsx`
- `frontend/src/lib/client/workstation/*`, `frontend/src/lib/operational/transport.ts`
- `frontend/tests/unit/workstation.test.ts`, `frontend/tests/e2e/workstation.spec.ts`
- `frontend/src/app/globals.css`

NEXT:
- FE5 Agent Arena completed as an implementation candidate on top of FE4. Acceptance remains external to this implementation lane.

## FE5 checkpoint

CHECKPOINT: FE5 — Agent Arena / governed agent jobs
STATUS: FROZEN IMPLEMENTATION CANDIDATE — NOT SELF-ACCEPTED

IMPLEMENTED:
- `/arena`: governed work-request composition against bounded returned project/backend/profile values only; no arbitrary tool name, provider URL, or browser-synthesized authority.
- Dispatch uses the accepted Agent Control Plane semantic operations only: `agent_projects`, `agents_list`, `agent_dispatch`, `agent_status`, `agent_result`, `agent_diff`, `agent_cancel`, `agent_discard`, and `agent_apply`.
- Active jobs poll every four seconds only while the tab is visible and polling stops on terminal lifecycle states. No token-stream or conversation-stream behavior is fabricated.
- Result and diff content render as untrusted inert text. Diff requests are bounded; apply remains unavailable unless evidence is complete, non-truncated, applicable, and bound to the current result/diff hash when the result supplies one.
- `COMPLETED` remains distinct from `APPLIED`. Cancel, discard, and apply use explicit typed confirmation; apply receives the strongest treatment and remains a separate server-authorized mutation.
- Known server-issued job IDs can be reopened without inventing a discovery API. Microphone and attachment controls remain disabled because no accepted FE5 contract exists for them.
- Identity/workspace projection changes invalidate Arena reads/actions and suppress late prior-context responses. Prompt, result, diff, job selections, and confirmations are not persisted to browser storage or the URL.

SECURITY / AUTHORITY:
- Product identity and configured Agent Profiles are presentation/configuration inputs, never authority grants.
- The browser never computes operational authorization. Consequential actions remain same-origin, server-authorized, explicit, pessimistic, and non-retrying after an unknown outcome.
- A completed agent job is reviewable evidence only. It never implies that the registered project was changed.

LOCAL QUALIFICATION AFTER EXTERNAL BROWSER RUN:
- `npm run lint`: PASS, 109 files checked.
- `npm run typecheck`: PASS.
- `npm run test`: PASS, 131/131 unit tests including FE5 4/4.
- `git diff --check`: PASS.
- Earlier unchanged-source qualification also passed production build and `npm audit --audit-level=high` with zero vulnerabilities.

EXTERNAL ORCHESTRATOR BROWSER QUALIFICATION:
- Playwright: `1.63.0`.
- Container image: `mcr.microsoft.com/playwright:v1.63.0-noble` pinned at `sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`.
- Owner-host job: `ohj_b6f0ff748d7b223da78eb67158619faf`.
- Full Chromium E2E: 41/41 PASS.
- Execution was disposable, `--network none`, 1 GB shm, host FE5 worktree mounted read-only, writable project copy and generated outputs confined to container tmpfs, and `CI=1`.
- Host worktree status was identical before and after browser qualification. No package installation, root grant, canonical/runtime mutation, or live backend integration was performed or claimed.

INTEGRATION GAPS:
- Production product adapter convergence remains separate. Synthetic preview fixtures prove frontend behavior only.
- No live backend execution, deployment, or authority mutation is claimed by the browser qualification.

FILES:
- `frontend/src/app/(foundation)/arena/page.tsx`
- `frontend/src/app/arena-preview/page.tsx`
- `frontend/src/components/agent-arena.tsx`
- `frontend/src/components/arena-preview.tsx`
- `frontend/src/lib/client/arena/client.ts`
- `frontend/src/components/shell.tsx`
- `frontend/src/lib/client/workstation/use-action.ts`
- `frontend/src/lib/operational/transport.ts`
- `frontend/src/app/globals.css`
- `frontend/tests/unit/arena.test.ts`
- `frontend/tests/e2e/arena.spec.ts`

NEXT:
- FE6 Review & Approvals against the independently accepted BE5 frontend integration contract. Preserve the invariant `APPROVED != OPERATION EXECUTED`.

## FE6 checkpoint

CHECKPOINT: FE6 — Review & Approvals
STATUS: FROZEN IMPLEMENTATION CANDIDATE — NOT SELF-ACCEPTED

IMPLEMENTED:
- `/approvals`: workspace/session-scoped approval inbox and decision review surface.
- Safe BE5 approval projection includes requester product-user reference, action class, subject type/id, evidence SHA-256 reference, correlation id, rationale, status, expiry/decision timestamps and numeric version only.
- Decision controls are available only for `PENDING` records and permit only `APPROVED` or `REJECTED` with the displayed `expectedVersion`.
- Explicit typed confirmation is required before submitting a decision. Stale/conflict/unavailable/cancelled results fail closed and are never shown as success.
- The acknowledged decision record is reconciled locally without implying execution. A fresh list remains an explicit server re-read.
- `/approvals-preview` provides deterministic development-only fixtures for available, empty, stale, forbidden, unavailable and slow scenarios. Production `/approvals` remains truthfully integration-pending until an accepted adapter is connected.

SECURITY / AUTHORITY:
- Permanent invariant: `APPROVED != OPERATION EXECUTED`.
- Approval records are decision evidence, not capability tokens. The frontend never turns approval state into MCP, ACP, GitHub, Docker, host or other operational authority.
- Browser-supplied organization/workspace/Principal/scope/grant authority is not created by FE6; current product context is derived from the accepted identity projection.
- Returned metadata is bounded and projected; unknown fields are discarded. Evidence is displayed as a digest/reference only.
- Session/workspace projection changes remount the approval boundary and discard stale UI state. No approval selection, rationale or decision confirmation is persisted in browser storage or URL state.

CONTRACT SOURCE:
- Accepted BE5 source commit: `08cf081e6e47f0296ce1f567de3e3a49cbf62b25`, tree `790043979c9c5267486ffb5c20b461bccddf59cf`.
- Read-only contract: `docs/product-platform/be5/BE5_FRONTEND_INTEGRATION_CONTRACT.md` plus the accepted SafeApproval DTO/decision route for exact field and `expectedVersion` semantics. No backend merge or backend write occurred.

QUALIFICATION:
- `npm run lint`: PASS, 120 files checked.
- `npm run typecheck`: PASS.
- FE6 focused unit tests: 4/4 PASS.
- Full frontend unit suite: 135/135 PASS.
- `npm run build`: PASS, 28 static routes generated.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: PASS.
- Governed Chromium FE6 qualification: 4/4 PASS at 1280 and 360 pixels, explicit approval semantics, stale/unavailable fail-closed behavior and axe checks.
- Browser job: `ohj_488329ff479b097e8182e8d45ee7ed35`.
- Browser image: `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`.
- Browser container ran `--network none`, 1 GB shm, host worktree bind-mounted read-only, and an executable container-only tmpfs project copy. Host Git status SHA-256 remained `88359dc385cecd56f87ec7c12fbe98f4ab477ab639919df7b69ab4e49e7cee7d` before and after qualification.
- Earlier owner-host attempts failed only in disposable harness setup before semantic qualification (legacy U1 browser endpoint mismatch; copied CLI executable-bit/noexec tmpfs issues). They did not mutate source and are not counted as FE6 product failures.

INTEGRATION GAPS:
- The accepted BE5 product routes exist in the backend source, but this frontend lane does not yet contain a converged production approval adapter. Production UI therefore remains integration-pending by design.
- Live PostgreSQL/realtime/attachment/presence availability is not claimed by FE6.
- FE6 does not create approval requests or execute approved operations; it is a review/decision surface only.

FILES:
- `frontend/src/app/(foundation)/approvals/page.tsx`
- `frontend/src/app/approvals-preview/page.tsx`
- `frontend/src/components/approval-boundary.tsx`
- `frontend/src/components/approvals.tsx`
- `frontend/src/components/approvals-preview.tsx`
- `frontend/src/lib/client/approvals/*`
- `frontend/src/components/shell.tsx`
- `frontend/src/app/globals.css`
- `frontend/tests/unit/approvals.test.ts`
- `frontend/tests/e2e/approvals.spec.ts`

NEXT:
- FE7 IDE Session Center only if an accepted current frontend-consumable IDE session contract is available; otherwise stop at the dependency boundary rather than inventing a session API.

## FE7 checkpoint

CHECKPOINT: FE7 — IDE Session Center
STATUS: FROZEN IMPLEMENTATION CANDIDATE — READINESS ONLY — NOT SELF-ACCEPTED

IMPLEMENTED:
- `/ide-sessions` exposes only bounded metadata already available through the public `control_center_query` read contract.
- “IDE control readiness” reads `capabilityState.ideSessionControl` from the summary view.
- “Adapter qualification” projects only VS Code/Cursor component readiness fields from the capabilities matrix.
- The surface explicitly states that the current public contract does not expose session discovery, controller acquisition, prompts, operation cancellation or writer controls.
- No fake live session, active agent, project/worktree attachment, controller lease or implementation authority is synthesized.

CONTRACT / AUTHORITY TRUTH:
- Current `docs/ide/IDE_SESSION_CONTROL.md` classifies Plane B as separately authorized North-Star/not-production while VS Code/Cursor source qualification remains partially open/blocked.
- Current accepted B7 review-operation foundation explicitly exposes no public MCP/HTTP route and no writer authority.
- FE7 therefore uses only the existing metadata-only Control Center contract; it does not reach into executor SQLite, AF_UNIX companion channels or private IDE adapter protocols.
- Agent Control Plane permissions do not imply IDE Session Control authority.

QUALIFICATION:
- `npm run lint`: PASS, 123 files checked.
- `npm run typecheck`: PASS.
- Full frontend unit suite: 135/135 PASS.
- `npm run build`: PASS, 29 static routes generated.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: PASS.
- Governed Chromium FE7 qualification: 2/2 PASS at 1280 and 360 pixels, including metadata-only boundary, no synthetic control buttons, no browser persistence, no overflow and axe checks.
- Owner-host job: `ohj_cd29fa74dba2a77bd58e70870db1b0ca`.
- Host Git status SHA-256 remained `ef78e4e084147633266f2cf54c114d09c387358affb985bc2cd43b7d268110f8` before and after browser qualification.

INTEGRATION GAP:
- A real IDE-session inventory/control frontend must wait for an accepted public, frontend-consumable Plane-B route/tool contract. FE7 intentionally stops at truthful readiness metadata.

FILES:
- `frontend/src/app/(foundation)/ide-sessions/page.tsx`
- `frontend/src/components/ide-session-center.tsx`
- `frontend/src/components/shell.tsx`
- `frontend/tests/e2e/ide-sessions.spec.ts`

NEXT:
- FE8 GitHub product experience: inspect the current trusted GitHub gateway/tool contracts and implement only bounded, explicitly authorized frontend seams that exist today.

## FE8 checkpoint

CHECKPOINT: FE8 — GitHub product experience
STATUS: FROZEN IMPLEMENTATION CANDIDATE — NOT SELF-ACCEPTED

IMPLEMENTED:
- `/github` now exposes a bounded QuaranHUB/GitHub App product experience instead of repository discovery only.
- Repository selection is limited to server-returned trusted repositories; no arbitrary remote URL input is accepted.
- Read surfaces cover governed repositories, pull requests, issues, changed files, submitted reviews and commit-status compatibility output.
- Untrusted GitHub patches render as inert text. No script execution path is introduced.
- Remote actions are closed, purpose-specific controls only: publish exact local HEAD, create/update pull request and submit pull request review.
- Mutation controls remain disabled unless product identity is integrated, active and mapped. Each mutation requires explicit typed confirmation and uses the closed operational transport allowlist.
- There is no merge, force-push, ref-delete, workflow/settings/secrets/collaborator mutation, arbitrary remote selection or generic GitHub tool UI.

CONTRACT / AUTHORITY TRUTH:
- Tool names and scope classes were checked directly against current `src/gateway/githubTools.ts`, `src/gateway/controlCenterTools.ts`, `docs/backend/GITHUB_CONTROL_PLANE.md` and `docs/reference/MCP_TOOL_REFERENCE.md`.
- `github:read` remains distinct from `github:write` and `github:review`; read availability does not grant mutation authority.
- `github_push_branch` remains tied to a trusted local project mapping and exact expected local HEAD.
- `github_checks` remains commit-status-compatible and does not require GitHub Checks permission.

QUALIFICATION:
- `npm run lint`: PASS, 127 files checked.
- `npm run typecheck`: PASS.
- FE8 focused unit tests: 5/5 PASS.
- Full frontend unit suite: 140/140 PASS.
- `npm run build`: PASS, 29 static routes generated.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: PASS.
- Governed Chromium FE8 + operational regression qualification: 11/11 PASS.
- Owner-host job: `ohj_9818ea93357bb4f74903ac5c3187ce02`.
- Browser image: `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`.
- Browser container ran `--network none`, 1 GB shm, host worktree bind-mounted read-only and a disposable container-only project copy. Host Git status SHA-256 remained `b01ee70117bc1342af3a9b8358310c1165b46b3b53485c282b49ca8193a1da46` before and after qualification.

INTEGRATION GAP:
- Live GitHub operations were not performed. FE8 proves frontend contract binding, closed transport arguments, UI authority separation and browser behavior only.

FILES:
- `frontend/src/app/(foundation)/github/page.tsx`
- `frontend/src/components/github-experience.tsx`
- `frontend/src/lib/client/github/client.ts`
- `frontend/src/lib/operational/transport.ts`
- `frontend/tests/unit/github-experience.test.ts`
- `frontend/tests/e2e/github-experience.spec.ts`
- `frontend/tests/e2e/operational.spec.ts`

NEXT:
- FE9 Local AI / Models: implement only truthful model/provider/hardware readiness seams from accepted contracts; do not infer live model entitlement, GPU availability or provider authority in the browser.

## FE9 checkpoint

CHECKPOINT: FE9 — Local AI / Models
STATUS: FROZEN IMPLEMENTATION CANDIDATE — READINESS ONLY — NOT SELF-ACCEPTED

IMPLEMENTED:
- `/models` presents O1/local-Ollama model qualification and deployment truth without live runtime control.
- Owner-approved model set is shown with primary, capacity reserve, alternate and deferred candidate statuses.
- Deployment truth distinguishes source/model qualification and production deployment from incomplete post-remediation live acceptance.
- Authority boundary states audit/plan/review only, no implement/writer/live mutation, and read-only model-facing tools only.
- Resource evidence is labeled host-specific and not portable universal requirements.
- The page exposes no pull, switch, enable, seed, probe or provider-control button because no accepted public frontend contract exists for those operations.

CONTRACT / AUTHORITY TRUTH:
- Source basis is current `docs/backend/O1_MODEL_QUALIFICATION.md` and `docs/security/SECURITY.md` local-model boundary language.
- Running local Ollama can remove cloud-model prompt transmission from that model call, but does not prove surrounding IDE/build/provider processes have no external network path.
- No live GPU, VRAM, model inventory, entitlement, model-store or Ollama API status is inferred in the browser.

QUALIFICATION:
- `npm run lint`: PASS, 130 files checked.
- `npm run typecheck`: PASS.
- Full frontend unit suite: 140/140 PASS.
- `npm run build`: PASS, 30 static routes generated.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: PASS.
- Governed Chromium FE9 qualification: 2/2 PASS at 1280 and 360 pixels, readiness-only boundary, no control buttons, no browser persistence, no overflow and axe checks.
- Owner-host job: `ohj_b23d271e333ce5cd8a3545ccd3bb1e59`.
- Browser image: `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`.
- Host Git status SHA-256 remained `04448b8289298720241cc89721eaa8da8383c27abe8adc2fdc5c795d8542d52d` before and after browser qualification.

INTEGRATION GAP:
- FE9 does not implement live model management. A future live Local AI product surface needs an accepted frontend-consumable model/runtime inventory and control contract.

FILES:
- `frontend/src/app/(foundation)/models/page.tsx`
- `frontend/src/components/local-ai-models.tsx`
- `frontend/src/components/shell.tsx`
- `frontend/tests/e2e/models.spec.ts`

NEXT:
- FE10 Monitoring: implement truthful monitoring surfaces only from current metadata contracts; do not fabricate hardware metrics, telemetry streams or health success.

## FE10 checkpoint

CHECKPOINT: FE10 — Monitoring
STATUS: FROZEN IMPLEMENTATION CANDIDATE — METADATA ONLY — NOT SELF-ACCEPTED

IMPLEMENTED:
- `/monitoring` presents bounded Control Center metadata snapshots for runtime summary, provider aggregates, topology and capabilities.
- Monitoring explicitly states that snapshots are not live telemetry streams, hardware probes, uptime guarantees or production-health certifications.
- The UI does not expose telemetry start, probe enablement, log streaming, GPU/VRAM/temperature/network-flow or alerting controls because no accepted frontend contract exists for those operations.

CONTRACT / AUTHORITY TRUTH:
- FE10 uses only the existing `control_center_query` read contract.
- Provider aggregate counts remain aggregate counters, not a job list or principal-specific eligibility proof.
- Unknown telemetry values remain unknown; the browser does not infer health success or hardware state.

QUALIFICATION:
- `npm run lint`: PASS, 133 files checked.
- `npm run typecheck`: PASS.
- Full frontend unit suite: 140/140 PASS.
- `npm run build`: PASS, 31 static routes generated.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: PASS.
- Governed Chromium FE10 qualification: 2/2 PASS at 1280 and 360 pixels, metadata-only boundary, no control buttons, no browser persistence, no overflow and axe checks.
- Owner-host job: `ohj_d889d253f4858c451b748774749f057a`.
- Browser image: `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`.
- Host Git status SHA-256 remained `294b5405dabb2e62ba3cd23e3fe10cd0aaed07e780b075f7501a346d1ee89370` before and after browser qualification.

INTEGRATION GAP:
- FE10 does not implement hardware telemetry, realtime monitoring, alerts, log streaming or health scoring. Those require a future accepted backend contract defining source, freshness, authorization, retention and failure semantics.

FILES:
- `frontend/src/app/(foundation)/monitoring/page.tsx`
- `frontend/src/components/monitoring-center.tsx`
- `frontend/src/components/shell.tsx`
- `frontend/tests/e2e/monitoring.spec.ts`

NEXT:
- FE11 Statistics: use only current aggregate/read contracts; do not fabricate analytics, historical retention or business/product metrics without an accepted data source.

## FE11 checkpoint

CHECKPOINT: FE11 — Statistics
STATUS: FROZEN IMPLEMENTATION CANDIDATE — OPERATIONAL WINDOW ONLY — NOT SELF-ACCEPTED

IMPLEMENTED:
- `/statistics` reads the existing `control_center_query` `statistics` view through a dedicated purpose-specific frontend client method.
- The page exposes bounded current-window choices only: 15 minutes, 1 hour, 6 hours and the contract maximum of 24 hours.
- Activity projection includes retained principal entries, entries in the selected window, allowed/denied/failure counts, p50/p95 duration and up to ten server-returned top-tool counts.
- Current runtime aggregates include active/queued jobs, visible/running targets and visible/available backends. Server `null` counts remain `UNKNOWN`; the frontend never invents zero.
- Decoder invariants fail closed on impossible totals, invalid percentiles, invalid window bounds, ring overflow, impossible target/backend counts or top-tool totals exceeding the activity total.
- Changing the window performs a fresh snapshot read only. No historical series, chart, warehouse query or reconstruction is synthesized.

CONTRACT / DATA TRUTH:
- Current gateway contract: `src/gateway/controlCenterTools.ts` exposes the read-only `statistics` view and accepts `sinceMs` only from 60,000 through 86,400,000 ms.
- Current activity source: `src/gateway/audit.ts` retains an in-memory ring capped at 2,048 entries and 24 hours. Statistics are principal-scoped operational-window aggregates over retained entries.
- Current product docs explicitly state that these statistics are not durable 24h/7d/30d analytics and that durable rolling analytics remain a future product service.
- No Supabase/PostgreSQL schema, view, migration or client integration was added. Supabase documentation was consulted for future database-view security context only; current FE11 has no accepted durable database source to bind.
- No token usage, provider cost, billing, business/product KPI, durable retention, trend or historical completeness claim is made.

QUALIFICATION:
- `npm run lint`: PASS, 137 files checked.
- `npm run typecheck`: PASS.
- FE11 focused unit tests: 4/4 PASS.
- Full frontend unit suite: 144/144 PASS.
- `npm run build`: PASS, 32 static routes generated including `/statistics`.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: PASS.
- Governed Chromium FE11 qualification: 3/3 PASS — 1280px, 360px and bounded 6-hour window change, including accessibility, no overflow and no browser persistence.
- Owner-host job: `ohj_8a3fb7ba8830690e67340acc165b8aa0`.
- Browser image: `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`.
- Browser container ran `--network none`, 1 GB shm and a read-only host worktree mount. Only the disposable container copy was adjusted for the Next 16 dev harness (`allowedDevOrigins: ["127.0.0.1"]` and direct Node CLI invocation); host source was unchanged.
- Host Git status SHA-256 remained `94296aa9e2bc4fdd55c5365025e57a5f396f0e56d60ae4a40a8beac3da498130` before and after the successful qualification.
- Earlier browser attempts failed only in disposable harness setup / pre-interaction hydration conditions and did not mutate source; they are not counted as FE11 product failures.

FILES:
- `frontend/src/app/(foundation)/statistics/page.tsx`
- `frontend/src/components/statistics-center.tsx`
- `frontend/src/components/shell.tsx`
- `frontend/src/lib/operational/client.ts`
- `frontend/src/lib/operational/contracts.ts`
- `frontend/tests/unit/statistics.test.ts`
- `frontend/tests/unit/operational.test.ts`
- `frontend/tests/e2e/statistics.spec.ts`

NEXT:
- FE12 Security & Authority Explorer: use current authority/capability metadata and existing safe preflight semantics only; do not fabricate risk scores, vulnerability findings or authorization outcomes.

## Phase commit ledger

| Phase | Commit | Tree | Parent | Subject | Tests |
| --- | --- | --- | --- | --- | --- |
| FE4 | `70dcb70d4cef9ceae8539fc95004a37dd87a60c9` | `3d18dcaffec0d465015ae91435ce45ddb8ec9428` | `9ef3b0a0f8d9c4c191cc0be183c8b893f741877e` | `feat(frontend): add governed operational workstation` | See FE4 checkpoint |
| FE5 | `e00465cc730379cef2c78d859dc433a87850ebc9` | `a317b1e9fe5c1a9df3dc41bee878ecb28cd00ca6` | `70dcb70d4cef9ceae8539fc95004a37dd87a60c9` | `feat(frontend): add governed Agent Arena` | Local gates PASS; external Chromium 41/41 PASS |
| FE6 | `5b18bc366d6bb6d51c5a37353c9e849b0c38d753` | `686fed609fee76b56cfc6fa64812d292f57c5dfd` | `e00465cc730379cef2c78d859dc433a87850ebc9` | `feat(frontend): add review and approvals` | Local gates PASS; governed Chromium 4/4 PASS |
| FE7 | `af878246675adf203670e2b36e06e54fed477962` | `e9fadd93e4c44c20108dd87ea3e8456a019e2d8b` | `5b18bc366d6bb6d51c5a37353c9e849b0c38d753` | `feat(frontend): add IDE session readiness center` | Local gates PASS; governed Chromium 2/2 PASS |
| FE8 | `424bf907f1677f0cd4c22467bb06b41dc105c96f` | `7725a0d111744830fa1c03d1b2db364176a70111` | `af878246675adf203670e2b36e06e54fed477962` | `feat(frontend): add GitHub product experience` | Local gates PASS; governed Chromium 11/11 PASS |
| FE9 | `438ab446093d43a3251bd5beaf5ef76d344b4671` | `3dc669788e459d47ac830af2168de3eac281bd40` | `424bf907f1677f0cd4c22467bb06b41dc105c96f` | `feat(frontend): add Local AI model readiness` | Local gates PASS; governed Chromium 2/2 PASS |
| FE10 | `d8e335812b48a520c7f520dcccfd664609d5ff80` | `e1bf058c49ed99d2b44e9fa82e645ebcd6574922` | `438ab446093d43a3251bd5beaf5ef76d344b4671` | `feat(frontend): add monitoring metadata center` | Local gates PASS; governed Chromium 2/2 PASS |
| FE11 | Pending immutable commit | Pending | `d8e335812b48a520c7f520dcccfd664609d5ff80` | `feat(frontend): add bounded statistics center` | Local gates PASS; governed Chromium 3/3 PASS |
