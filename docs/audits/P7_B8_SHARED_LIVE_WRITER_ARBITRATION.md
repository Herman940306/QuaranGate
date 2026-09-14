# P7 B8 — Shared Live-Worktree Writer Arbitration

**Status:** SOURCE AUTHORITY FOUNDATION / EXISTING `agent_apply` INTEGRATED / NO IDE MUTATION EXECUTION

P7 B8 establishes one durable arbitration boundary for operations that may mutate a registered real worktree. It integrates the already-accepted `agent_apply` lane into that boundary and provides an internal owner-kind seam for a future IDE mutation lane. It does **not** enable `request_implementation`, does not expose a public IDE writer tool/route, does not execute an IDE mutation, and does not deploy or qualify any vendor adapter.

## Governing invariant

The source invariant is:

```text
many readers
many isolated sandbox workers
one controlled live writer per trusted logical (projectId, worktreeId)
```

The shared held-writer states are `ACTIVE` and `UNCERTAIN`. `RELEASED` no longer blocks the tuple. `UNCERTAIN` is deliberately blocking and cannot be automatically released.

Owner kinds are a closed B8 vocabulary:

- `agent_apply` — the existing guarded real-worktree apply path;
- `ide` — an internal future-lane identity only. B8 does not execute IDE mutations.

Writer lease IDs are opaque `wrl_` identifiers. Apply owner IDs remain opaque `att_` IDs and IDE owner IDs use the existing opaque `ideo_` operation identity shape.

## Trusted worktree identity

Agent project configuration gains an optional `worktreeId` with the same bounded logical-ID grammar used by the IDE session contract. Real `agent_apply` fails closed if its trusted project entry has no `worktreeId`.

The MCP caller still supplies only `jobId` to `agent_apply`. A caller cannot select or restate:

- `projectId`;
- `worktreeId`;
- writer lease ID;
- host path;
- principal identity.

Project and principal are re-derived from the durable job. Worktree identity is supplied only by the trusted executor project registry. Duplicate exact configured `hostPath` values are rejected by both runtime config validation and the standalone config validator.

The logical authority is the exact tuple `(projectId, worktreeId)`. The same logical worktree name may legitimately exist under distinct project IDs.

## Durable schema v8

The existing Agent job SQLite database advances from schema v7 to v8. B8 deliberately uses the same durable database as apply-attempt admission so there is no cross-database crash or commit window between “apply admitted” and “writer lease acquired.”

New table:

`live_writer_leases`

with bounded logical/audit metadata only:

- writer lease ID;
- project ID;
- worktree ID;
- owner kind;
- owner ID;
- principal ID;
- lease state;
- acquired/finished timestamps;
- bounded reason.

No host path, prompt, response, source bytes, credential, provider state, model selection, Docker handle or raw IDE controller lease is stored in this table.

Two durable uniqueness authorities are required and schema-verified:

1. `idx_live_writer_one_held_target` — unique `(project_id, worktree_id)` while state is `ACTIVE` or `UNCERTAIN`;
2. `idx_live_writer_owner_once` — unique `(owner_kind, owner_id)` for the complete lease history, preventing owner-identity reuse.

`agent_apply_attempts` gains nullable historical `worktree_id` and `writer_lease_id` columns; `writer_lease_id` has a foreign key to the new lease table.

## Migration and reopen integrity

The v7 -> v8 migration is additive and forward-only. Historical apply attempts retain `NULL` worktree/lease provenance; B8 never fabricates historical authority from current configuration.

Before migration, a v6/v7 database must prove its exact historical schema shape. Any database stamped below v8 that already contains a B8 writer table/index or either new apply-attempt column is treated as partial/out-of-tree v8 state and refused before migration. There is no automatic repair/adoption of partial writer authority.

A current v8 reopen verifies:

- required table/column affinities;
- exact normalized `live_writer_leases` table definition, including closed owner/state CHECK constraints;
- exact writer foreign key;
- exact writer indexes, including uniqueness, partial/full shape, columns and normalized SQL;
- every persisted writer lease row grammar and ACTIVE/terminal timestamp consistency;
- every B8 apply attempt has complete worktree/lease provenance;
- exact apply-attempt ↔ lease owner/project/worktree/principal binding;
- exact apply lifecycle ↔ lease lifecycle agreement;
- every historical `agent_apply` lease refers to a matching apply attempt.

Malformed/weakened current-v8 state fails closed on reopen.

## Atomic `agent_apply` integration

`startApplyAttempt` is the sole `agent_apply` writer-admission primitive. Generic writer-lease acquisition explicitly refuses owner kind `agent_apply` so future code cannot accidentally split apply admission from writer admission.

Within one SQLite `BEGIN IMMEDIATE` transaction, apply admission:

1. validates the trusted worktree ID and opaque attempt identity;
2. loads the durable job and requires `COMPLETED`;
3. re-derives project/principal/base/artifact identity from that row;
4. refuses project quarantine;
5. preserves the pre-existing per-job/per-project active-apply exclusion;
6. acquires the shared `(projectId, worktreeId)` live-writer lease;
7. inserts the apply attempt bound to that exact lease;
8. commits both facts together.

A competing IDE writer on the same tuple therefore blocks `agent_apply`, and an admitted `agent_apply` blocks an IDE writer on the same tuple. Different worktrees may proceed independently subject to their other governing limits.

## Terminal and uncertainty semantics

Safe apply terminals release the shared writer lease in the **same transaction** as the apply-attempt terminal state:

- `PRECONDITION_FAILED`;
- `ARTIFACT_INVALID`;
- `ABORTED_NO_MUTATION`;
- `FAILED_ROLLED_BACK` after rollback has been proven;
- `VERIFIED_SUCCESS` through the dedicated atomic `markApplySuccess` path.

`markApplySuccess` couples:

- apply `APPLYING -> VERIFIED_SUCCESS`;
- job `COMPLETED -> APPLIED` and retention metadata;
- writer lease `ACTIVE -> RELEASED`;

in one transaction.

An unprovable mutation outcome uses the dedicated uncertainty path and couples:

- apply `APPLYING -> UNCERTAIN`;
- durable project quarantine;
- writer lease `ACTIVE -> UNCERTAIN`;

in one transaction. The caller-supplied project argument is checked against the durable attempt before quarantine; project substitution is rejected without changing attempt or lease state.

An `UNCERTAIN` lease remains inside the held-target unique index. Generic release refuses it. B8 provides no automatic “clear uncertainty” path.

## Restart behavior

Startup apply recovery remains conservative:

- orphaned `STARTED` / `VERIFYING` attempts are proven pre-mutation, become `ABORTED_NO_MUTATION`, and release their exact writer lease;
- orphaned `APPLYING` attempts become `UNCERTAIN`, quarantine the project, and keep the exact writer lease `UNCERTAIN`;
- any remaining `ACTIVE` writer lease not resolved by the coherent apply recovery (including a future IDE writer) becomes `UNCERTAIN`, never `RELEASED`.

Thus restart cannot silently free a potentially mutating live writer.

## Internal IDE seam only

The store has exact-bound internal acquire/release/uncertain primitives for owner kind `ide`. They require project/worktree/operation/principal identity to match on settlement. Binding substitution is rejected and owner identity is one-use.

This seam is **not** a public tool, route, listener command or executor mutation implementation. It exists so a later, separately accepted IDE implementation lane can join the same durable arbitration policy instead of inventing an independent lock.

## Physical identity boundary

B8 arbitrates the trusted logical `(projectId, worktreeId)` tuple. It does **not** independently prove that two differently registered host-path aliases or symlink spellings resolve to the same physical filesystem worktree.

That physical binding remains a separate security layer. The already-accepted B5 workspace/worktree attestation supplies the IDE-side canonical workspace/worktree verification prerequisite. Any future live IDE mutation must combine the accepted B5 attestation/binding with this B8 writer lease before it may mutate. B8 therefore does not claim physical-host alias equivalence by itself.

## Public surface

B8 adds no public MCP tool and no public HTTP IDE mutation route.

The public tool catalog remains exactly **45/45** with no missing/extra entries. `agent_apply` remains the existing guarded mutation tool and its public input remains strict `jobId`-only. `request_implementation` remains excluded from executable IDE operation control.

## Validation before freeze

Final source bytes before freeze:

- full root unit: **2446/2446 PASS across 79/79 files**;
- B8 live-writer arbitration: **10/10 PASS**;
- Agent DB migration/reopen suite: **54/54 PASS**;
- typecheck: PASS;
- build: PASS;
- `git diff --check`: PASS;
- console catalog + agent public schemas: **16/16 PASS**;
- public tool catalog: **45 expected / 45 server / 0 missing / 0 extra**.

Adversarial regressions specifically prove:

- IDE ↔ `agent_apply` conflict on one exact tuple;
- different worktrees remain independent;
- owner IDs cannot be reused;
- generic lease APIs cannot bypass atomic `agent_apply` admission/terminalization;
- safe terminals release while `UNCERTAIN` remains blocking;
- restart distinguishes proven-zero-mutation from potentially-mutating work;
- wrong-project uncertainty substitution is rejected with no state change;
- genuine v7 migrates without fabricated historical writer provenance;
- partial v8 state under a v7 stamp is refused;
- weakened current-v8 table/index definitions are refused;
- malformed persisted current-v8 lease rows are refused;
- the writer schema contains logical authority only and no host path.

## Explicit non-claims / residual gates

B8 does **not** claim:

- public IDE implementation/write tools;
- execution of `request_implementation`;
- that B7 review operations gained writer authority;
- a vendor-specific IDE mutation adapter;
- executor-startup deployment of a live IDE writer;
- VS Code/Kiro/Cursor/Visual Studio/Antigravity live mutation qualification;
- provider/model qualification;
- IDE-host egress/air-gap qualification;
- physical host-path alias equivalence from logical IDs alone;
- owner/operator reconciliation or automatic release of an `UNCERTAIN` writer;
- product deployment of this B8 source candidate.

The next P7 gate must be derived from the North-Star/security ordering after B8 acceptance. It must not enable `request_implementation` merely because the shared lease now exists; the complete attestation, operation/audit, writer authority and vendor-runtime chain must remain cumulative and fail closed.
