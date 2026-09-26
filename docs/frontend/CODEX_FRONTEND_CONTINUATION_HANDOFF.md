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
- FE5 Agent Arena: inspect accepted job mutation contracts and implement a semantic client/chat surface without inventing profile integration or streaming.

## Phase commit ledger

| Phase | Commit | Tree | Parent | Subject | Tests |
| --- | --- | --- | --- | --- | --- |
| FE4 | Pending final gate | Pending | `9ef3b0a0f8d9c4c191cc0be183c8b893f741877e` | Operational workstation | See FE4 checkpoint |
