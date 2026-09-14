# P7 B7 — Governed IDE Review Operation Control / Audit / Recovery

**Status:** SOURCE FOUNDATION / NOT A LIVE VENDOR ADAPTER / NO WRITER AUTHORITY

P7 B7 extends the accepted B1–B6 IDE Session Control foundation with a bounded, authenticated, non-mutating review-operation lifecycle. It does not expose a public MCP/HTTP route, does not wire IDE Session Control into executor startup, does not call a provider/model, and does not grant `request_implementation` or any real-worktree writer authority.

## Authority ordering

The accepted trust chain remains cumulative and fail closed:

1. B2 trusted enrollment and current connection generation.
2. B4 owner-only runtime credential and exact runtime identity.
3. B6 authenticated AF_UNIX connection and B5 workspace promotion.
4. Explicit controller acquisition on that authenticated connection.
5. Every operation start/cancel uses the accepted B3 signed envelope and durable replay claim.
6. Every `start_review` MAC covers a canonical B7 payload containing both the prompt and a fresh B5 workspace attestation.
7. QuaranGate re-runs B5 workspace/worktree verification immediately before the durable operation-start transaction.
8. B1 authority is re-derived from trusted enrollment/session state. `writerLease` remains `none`.

A B6 connection with no B7 adapter configured preserves B6 behavior and rejects every post-READY operation-control frame.

## Narrow B7 protocol

The source protocol has four control frames only:

- `acquire_controller`
- `release_controller`
- `start_review`
- `cancel_operation`

`start_review` accepts only B1 `request_review`. Generic `prompt` is not executable through B7 because prompt wording is not a technical read-only boundary. `request_implementation` remains excluded by B3 and B2 and is rejected before a B7 operation can exist.

Bounds:

- prompt: non-empty, at most 16 KiB UTF-8;
- fresh B5 workspace attestation: at most 16 KiB;
- canonical authenticated combined payload: at most 40 KiB;
- operation control frame: at most 48 KiB;
- B1 event message: at most 8 KiB;
- durable event count: 4096 slots per operation with the final slot reserved for a terminal outcome;
- review runtime: at most 10 minutes.

The local listener remains AF_UNIX-only at the exact B4-derived path with the B6 connection/write/backpressure controls.

## Durable Plane-B operation state

The dedicated IDE registry advances additively to schema v3. It adds `ide_operations` and `ide_operation_events`; exact v1 and v2 states are structurally verified before migration. Partial/falsely stamped later-schema state is refused rather than repaired.

Operation start is one `BEGIN IMMEDIATE` transaction that:

- re-derives exact enrollment/session/controller state;
- refuses reused operation IDs;
- inserts immutable attribution metadata;
- transitions the exact current session `CONTROLLER_ACQUIRED -> OPERATION_ACTIVE` by CAS;
- inserts sequence 0 `operation_started` audit metadata.

Only one RUNNING/CANCELLING operation can exist for a session via a partial unique index.

Persisted operation attribution includes principal, logical project/worktree, workspace fingerprint, optional base revision, IDE/runtime/adapter identity, session/generation, capability, controller-lease digest, authenticated payload digest/byte count, lifecycle timestamps/state and event sequence. The raw controller lease is not copied into the operation row.

## Metadata-only audit

Prompt and response/event bodies are never persisted by B7.

For each event the durable audit stores only:

- operation ID;
- sequence;
- event type;
- SHA-256 of a message when one exists;
- message byte count;
- timestamp.

There is no prompt, response or raw message column. Tests additionally inspect the live SQLite/WAL/SHM bytes and prove selected prompt/response sentinels are absent.

Durable audit is written before an event is streamed to the client. Initial sink failure therefore terminalizes the operation `INDETERMINATE`; it cannot leave a durable RUNNING operation without an in-process controller.

## Event, cancellation and terminal semantics

B1 normalized event validation is retained. Sequence 0 is atomically `operation_started`; later events must be contiguous and exact-bound. Terminal events are permanent.

Cancellation:

- uses a fresh B3 authenticated `cancel` envelope;
- binds the exact operation ID, session, generation and current controller;
- moves RUNNING -> CANCELLING durably;
- aborts only that in-memory adapter handle;
- terminalizes as CANCELLED only after the adapter path reconciles.

A missing in-process handle after authenticated cancellation is not reported as success; it is terminalized `INDETERMINATE`.

Disconnect/reconnect/revocation terminalizes an in-flight operation `DISCONNECTED` before session/controller authority is cleared. Restart recovery terminalizes active operations `INDETERMINATE` before live sessions become STALE. Late adapter completion/cancellation cannot overwrite a durable terminal outcome.

A runtime ceiling terminalizes an unresolved turn `INDETERMINATE` and aborts its adapter handle; no timeout path fabricates completion.

## Backend-neutral adapter seam

B7 supplies a review-only adapter interface with only:

- operation ID;
- session ID;
- connection generation;
- prompt;
- AbortSignal;
- bounded normalized event emitter.

It supplies no filesystem/terminal API, host path, project path, Docker authority, target handle, credential, model selector, writer lease or generic tool executor. This is a source seam for later vendor-specific qualification, not a provider implementation.

## Reopen integrity

Schema-v3 reopen validates durable operation histories, including:

- operation row/field grammar;
- contiguous audit sequence beginning with `operation_started`;
- `next_sequence` equality;
- terminal-state/terminal-event agreement;
- cancellation attribution for CANCELLED;
- active operation attached to the exact current `OPERATION_ACTIVE` session/generation/controller digest.

Forged success rows or active-operation/session disagreement fail closed as registry schema corruption.

## Validation before freeze

Focused B1–B7 suite: **169/169 PASS across 12 files**.

Additional B7-focused evidence includes:

- operation protocol: 7/7 PASS;
- registry suite: 49/49 PASS;
- real AF_UNIX B6/B7 listener suite: 22/22 PASS;
- coordinator failure seams: 3/3 PASS.

Final candidate validation on these source bytes: full root unit **2428/2428 PASS across 78/78 files**; typecheck PASS; build PASS; diff-check PASS; console catalog **4/4 PASS**. Static source-graph inspection found no executor-startup/public-tool reference to the B7 listener/coordinator; the public MCP surface remains unchanged.

## Explicit non-claims / residual gates

B7 does **not** claim:

- executor-startup integration or a deployed IDE listener;
- VS Code/Kiro/Cursor/Visual Studio/Antigravity production compatibility;
- that a vendor adapter truthfully collects OS/filesystem/Git facts (B5 residual still requires live vendor qualification);
- IDE-host air-gap/egress qualification;
- provider/model execution;
- generic `prompt` execution;
- `request_implementation`;
- shared live-writer arbitration;
- real-worktree mutation;
- public MCP/HTTP IDE-operation tools;
- a final retention policy for historical operation metadata.

The next authority-sensitive gate must be shared live-writer arbitration across all real-worktree mutation lanes. IDE implementation authority must remain impossible until that separately reviewed gate is accepted.

## R1 concurrency clarification

B7 admission is serialized twice at the durable boundary. `startOperation` executes under SQLite `BEGIN IMMEDIATE`, then requires the exact current session to still be `CONTROLLER_ACQUIRED` with the exact raw controller lease before transitioning it to `OPERATION_ACTIVE`. Schema v3 also carries the partial unique index `idx_ide_operations_one_active_session`, which permits only one `RUNNING`/`CANCELLING` operation per session. A competing otherwise-valid start therefore cannot create a second active operation: after SQLite writer serialization it observes `OPERATION_ACTIVE` (or loses the session CAS) and the entire second transaction rolls back. A direct two-store regression pins this property. No external Redis/process lock is relied on for this Plane-B invariant.
