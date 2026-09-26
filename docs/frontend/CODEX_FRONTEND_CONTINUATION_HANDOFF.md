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

## Phase commit ledger

| Phase | Commit | Tree | Parent | Subject | Tests |
| --- | --- | --- | --- | --- | --- |
| FE4 | `70dcb70d4cef9ceae8539fc95004a37dd87a60c9` | `3d18dcaffec0d465015ae91435ce45ddb8ec9428` | `9ef3b0a0f8d9c4c191cc0be183c8b893f741877e` | `feat(frontend): add governed operational workstation` | See FE4 checkpoint |
| FE5 | `e00465cc730379cef2c78d859dc433a87850ebc9` | `a317b1e9fe5c1a9df3dc41bee878ecb28cd00ca6` | `70dcb70d4cef9ceae8539fc95004a37dd87a60c9` | `feat(frontend): add governed Agent Arena` | Local gates PASS; external Chromium 41/41 PASS |
| FE6 | Pending immutable commit | Pending | `e00465cc730379cef2c78d859dc433a87850ebc9` | `feat(frontend): add review and approvals` | Local gates PASS; governed Chromium 4/4 PASS |
