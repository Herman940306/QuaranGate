# P7 B9.3 — Controlled Implementation Listener Integration / B9 Closure Candidate

**Status:** SOURCE INTEGRATION / ADVERSARIAL CLOSURE CANDIDATE / NOT EXECUTOR-STARTUP-WIRED / NOT PUBLIC / NOT DEPLOYED

P7 B9.3 integrates the independently accepted B9.1 admission and B9.2 durable implementation coordinator into the existing authenticated local companion listener as an explicit trusted opt-in composition. It does not enable a product/public IDE writer by default and does not add vendor-specific adapter code.

## Configuration boundary

Implementation execution exists only when **both** are injected into the listener:

- the accepted B8 `AgentJobStore` live-writer authority; and
- a backend-neutral `IdeImplementationOperationAdapter`.

Supplying only one is a configuration error before socket bind. Supplying neither preserves the accepted B6/B7 behavior. `start_implementation` remains unavailable when implementation dependencies are absent.

No executor startup code, gateway route, HTTP/MCP tool or public catalog entry injects these dependencies in B9.3.

## Operation routing

On an authenticated READY connection:

- controller acquisition/release remains Plane-B controlled;
- `start_review` is accepted only when the B7 review adapter is configured;
- `start_implementation` is accepted only when the B9 implementation coordinator is configured;
- cancel routing is based on the exact durable operation capability, so implementation cancellation cannot be accidentally sent through the review coordinator;
- unknown cancellation targets still undergo the available coordinator's full authenticated runtime admission before failing closed.

B9.3 exposes bounded writer contention errors as `IDE_WRITER_BUSY` / `IDE_WRITER_DENIED`, without exposing host paths or authority internals.

## Disconnect ordering

An implementation-active connection closes in this order:

1. B9 implementation coordinator gets first chance to settle the exact B8 writer `UNCERTAIN` and terminalize the implementation operation;
2. generic Plane-B session disconnect follows;
3. B7 review coordinator reconciles any review turn;
4. B9 terminal writer settlement is reconciled again as a fail-closed fallback.

If any implementation settlement cannot be proven, the B8 writer remains `ACTIVE` or `UNCERTAIN`, which blocks a competing writer. The listener never releases writer authority merely because a socket disappeared.

## Restart boundary

When implementation execution is explicitly configured, listener `start()` is a recovery boundary:

- runtime confinement and existing socket-path ownership are checked first;
- before accepting a new connection, the B9 coordinator runs the accepted B7/B9 restart recovery;
- pre-restart active implementation operations become `INDETERMINATE` and their exact B8 writers become `UNCERTAIN`;
- stale sessions are not revived.

If the socket path is already occupied, listener startup refuses before recovery, avoiding mutation of durable state by a second/foreign listener attempt.

## Bounded response sink / backpressure

Server-frame writes now return explicit success/failure. If the bounded 64 KiB write queue would be exceeded, the socket is destroyed and the operation sink reports failure to the coordinator rather than silently claiming event delivery.

The B9 coordinator's existing fail-closed event path aborts mutation execution; transport loss/disconnect reconciles writer authority conservatively. A real paused AF_UNIX client plus a high-volume bounded adapter regression proves backpressure cannot create `COMPLETED` or release the B8 writer and cannot persist a completed terminal audit event.

The coordinator also has an explicit initial-sink-failure regression: if the first `operation_started` delivery throws before the mutation boundary, the durable operation becomes safe `FAILED`, `mutation_started_at` remains null, and the writer is provably `RELEASED`; the mutation adapter is never invoked.

## Shared-writer integration proofs

Real durable B8/Agent-store tests prove both directions on the exact `(projectId, worktreeId)` target:

- active `agent_apply` -> fully signed IDE implementation is denied before IDE operation creation;
- active IDE implementation -> `agent_apply` admission returns `LIVE_WRITER_BUSY`;
- safe implementation completion/cancel releases the writer only after accepted B9.2 settlement proof;
- disconnect, timeout, revocation and backpressure retain writer uncertainty.

No synthetic project=worktree substitution is introduced.

## Authentication / binding proofs

The live socket path proves:

- exact authenticated companion handshake/runtime identity;
- exact controller lease on the current connection;
- exact current connection generation;
- B3 implementation envelope authentication/replay;
- fresh per-operation B5 workspace/worktree re-attestation;
- B8 writer admission only after those checks;
- stale/future generation fails before writer admission;
- MAC-valid workspace drift fails before operation/writer admission;
- external enrollment revocation cannot release an active implementation writer.

## Validation on final pre-freeze bytes

- B1-B9 focused IDE/security matrix: **225/225 PASS across 15 files**;
- B9.3 listener/coordinator/B8 focused slice: **61/61 PASS across 3 files**;
- full root unit: **2491/2491 PASS across 81/81 files**;
- typecheck: PASS;
- build: PASS;
- diff-check: PASS;
- console catalog + public Agent schema: **16/16 PASS**;
- public MCP catalog remains the accepted exact 45-tool surface;
- source-graph scan: no `ideImplementationCoordinator` / implementation-adapter injection from executor startup, gateway or public server code.

## Findings closed during B9.3

1. **Disconnect ordering:** implementation writer settlement is now attempted before generic Plane-B session disconnect.
2. **Silent bounded-write failure:** listener frame writes now report failure; review/implementation sinks fail rather than silently treating a destroyed/backpressured socket as successful delivery.
3. **Partial implementation configuration:** writer authority and mutation adapter must be injected together or listener construction fails before bind.
4. **Cancel routing:** exact durable operation capability chooses the matching review vs implementation coordinator.
5. **Initial response-sink failure regression:** pre-mutation sink failure is pinned to safe FAILED + RELEASED with no adapter invocation.

## Explicit non-claims

B9.3 does **not** claim:

- executor startup enablement of IDE implementation;
- a public MCP/HTTP IDE writer tool;
- VS Code/Kiro/Cursor/Visual Studio/Antigravity mutation adapter qualification;
- provider/model selection or entitlement qualification;
- arbitrary filesystem/shell/terminal/host-command authority;
- physical path alias equivalence beyond B5;
- deployment/live production qualification;
- final P7 closure by itself.

B9.3 is a source integration and adversarial closure candidate. Final B9/P7 status requires independent review and control reconciliation, followed by an explicit North-Star remaining-obligation audit.
