# P7 B9.2 — IDE Implementation Operation / Writer-Settlement Foundation

**Status:** SOURCE EXECUTION-AUTHORITY SUB-BATCH / BACKEND-NEUTRAL ADAPTER SEAM / NOT STARTUP-WIRED / NOT DEPLOYED

P7 B9.2 builds only on independently accepted B9.1. It makes implementation operations durably representable and executable through a backend-neutral adapter seam, but does not wire that seam into the live companion listener, executor startup, a vendor adapter, or a public MCP/HTTP mutation surface.

## Accepted predecessor chain

B9.2 preserves the exact accepted chain:

1. B3/B4 authenticated companion request and runtime identity;
2. B5 fresh canonical workspace/worktree attestation;
3. B7 durable operation lifecycle/audit/recovery;
4. B8 shared live-writer authority for the trusted logical `(projectId, worktreeId)`;
5. B9.1 authenticated `request_implementation` admission and exact B8 lease proof.

No caller-selected project, worktree, host path, writer lease, credential, shell, provider or Docker authority is added.

## Durable Plane-B schema v4

The IDE registry advances from v3 to v4 additively. Every `request_implementation` operation now carries:

- exact `writer_lease_id`;
- local writer-settlement mirror: `HELD`, `RELEASED`, or `UNCERTAIN`;
- conservative `mutation_started_at` marker;
- `writer_settled_at` when settlement is proven;
- optional safe-terminal intent (`COMPLETED`, `FAILED`, `CANCELLED`) plus timestamp.

`idx_ide_operations_writer_lease` is an exact UNIQUE partial index over non-null writer lease IDs, so one B8 lease cannot be attributed to two Plane-B operations.

Historical v3 review-only operations migrate without invented writer provenance. A v3 database that already contains partial v4 columns/index is rejected rather than repaired. A historical v3 implementation row is impossible under the accepted predecessor contract and is rejected rather than assigned fabricated authority.

## Mutation boundary

B9.2 creates the durable implementation operation before a mutation-capable adapter may run. Immediately before adapter invocation it:

1. re-reads the exact B8 lease as ACTIVE and exact-bound to `ownerKind=ide`, the operation ID, trusted principal/project/worktree;
2. durably marks `mutation_started_at` under the exact current controller lease;
3. only then invokes the backend-neutral adapter.

The adapter receives only:

- operation ID;
- session ID;
- connection generation;
- prompt;
- AbortSignal;
- bounded event-emission callback.

It receives no host path, filesystem API, shell, credential, writer store, B8 lease object, project configuration, Docker API or provider/model selector.

## Explicit adapter outcomes

The adapter must return exactly one bounded outcome:

- `completed`;
- `failed_no_mutation`;
- `failed_rolled_back`;
- `cancelled_no_mutation`;
- `cancelled_rolled_back`;
- `indeterminate`.

Throw, malformed output, timeout, disconnect, lost in-process handle, or any unclassified result is never interpreted as a normal safe failure. It becomes an unsafe/ambiguous terminal and retains writer blocking as `UNCERTAIN`.

## Two-database settlement protocol

Plane-B and B8 intentionally remain separate durable SQLite authorities. B9.2 does not claim cross-database atomicity.

Safe terminalization therefore uses an explicit two-phase proof:

1. Plane-B durably records a safe terminal intent while operation state remains active and local writer state remains `HELD`.
2. QuaranGate settles the exact B8 lease and re-reads it from the durable B8 store.
3. Only if the exact lease is proven immutable `RELEASED` may Plane-B atomically append the safe terminal audit event, set the operation to `COMPLETED`/`FAILED`/`CANCELLED`, mirror `RELEASED`, and return the session to `CONTROLLER_ACQUIRED`.

If safe release cannot be proven, the exact B8 lease is marked `UNCERTAIN` where possible and Plane-B can only become `INDETERMINATE`; it cannot report safe completion.

A crash after safe intent but before B8 release therefore recovers as `INDETERMINATE + UNCERTAIN`. A crash after B8 release but before Plane-B finalization recovers as `INDETERMINATE + RELEASED` with the preserved safe intent; it does not fabricate `COMPLETED`. This can over-report uncertainty but cannot admit a concurrent writer before safe B8 release.

Unsafe terminals (`INDETERMINATE`/`DISCONNECTED`) require exact B8 `UNCERTAIN` proof before the Plane-B terminal settlement finalizer may commit. Existing B7 generic terminal append is explicitly unable to terminalize an implementation operation, preventing bypass of B9 writer settlement.

## Cancellation / disconnect / restart

- authenticated cancellation moves the durable operation to `CANCELLING` and aborts the active adapter;
- cancellation is safe only when the adapter explicitly proves no mutation or verified rollback;
- lost adapter handle during cancellation becomes `INDETERMINATE + UNCERTAIN`;
- disconnect aborts the live adapter and settles `DISCONNECTED + UNCERTAIN`;
- revocation/lifecycle terminalization can be reconciled without the original in-process handle;
- restart first uses B7 to terminalize active operations conservatively, then reconciles exact B8 writer authority; no success is synthesized from a crash window.

## Persisted-state fail-closed checks

Schema-v4 reopen verification rejects, among other corruption cases:

- active implementation operation with already-settled writer authority;
- safe terminal state without matching `RELEASED` writer proof and matching safe intent;
- unsafe terminal with `RELEASED` writer but no prior safe intent;
- invalid/missing writer lease identity or settlement timestamp;
- weakened writer-lease unique partial index;
- operation/audit sequence or terminal-state disagreement;
- incoherent active session/controller binding.

## Security findings closed during implementation

Two non-trivial issues were found before freeze and corrected:

1. **Safe-completion release window:** an earlier draft could commit `COMPLETED` before B8 release was proven and then downgrade local writer settlement after release failure. This was replaced by the durable safe-intent + external-release-proof + terminal-finalization protocol above.
2. **Historical migration fixture truth:** tests initially synthesized v3 from a current v4 DB without removing every new v4 column. The migration guard correctly rejected that contradictory image. Fixtures now construct genuine v3 state and separately prove partial-v4-under-v3 fails closed.

## Explicit non-claims

B9.2 does **not** claim or provide:

- final P7 B9 acceptance;
- companion-listener implementation execution wiring;
- executor startup integration;
- VS Code/Kiro/Cursor/Visual Studio/Antigravity mutation adapter qualification;
- public IDE mutation MCP/HTTP surface;
- provider/model selection;
- arbitrary shell/filesystem/host-command authority;
- physical host-path alias equivalence beyond B5;
- IDE-host air-gap/egress qualification;
- live deployment or production qualification.

Those remain for B9.3/final P7 qualification or later vendor/live gates as authorized by control.

## Validation on final pre-freeze B9.2 code bytes

- critical B9.2 store/coordinator matrix: **73/73 PASS**;
- broader B9.2 store/coordinator/admission/B8/B7 focused matrix: **93/93 PASS across 5 files**;
- full root unit: **2478/2478 PASS across 81/81 files**;
- typecheck: PASS;
- build: PASS;
- diff-check: PASS;
- console catalog + public Agent schema regression: **16/16 PASS**;
- public MCP catalog remains exact **45 tools**, with no IDE implementation tool;
- source-graph inspection: no import of `ideImplementationCoordinator` outside its own module/tests, so no listener/startup/public runtime execution wiring exists in B9.2.

The final executable/test bytes also include explicit regressions for B8 release failure, safe-intent crash windows, generic B7 terminal-bypass denial, forged persisted settlement states, and genuine-v3/partial-v4 migration handling.
