# P7 B9.1 — IDE Implementation Admission Authority Foundation

**Status:** SOURCE AUTHORITY SUB-BATCH / NO IMPLEMENTATION EXECUTION / NOT STARTUP-WIRED / NOT DEPLOYED

P7 B9.1 is the first deliberately bounded source slice of the accepted B9 gate. It does **not** complete B9 and does not make `request_implementation` executable. Its purpose is to establish the exact authenticated admission chain that a later mutation-capable IDE operation must satisfy before any adapter can be invoked.

## Accepted predecessor chain

B9.1 builds only on already accepted source authorities:

1. B3/B4 authenticated companion envelope, runtime credential and durable replay claim.
2. B5 authenticated exact workspace/worktree attestation.
3. B7 controller/session/operation identity contract and bounded operation protocol.
4. B8 one-held-writer authority for exact trusted logical `(projectId, worktreeId)`.

B9.1 does not weaken or replace any predecessor.

## Narrow capability opening

`request_implementation` is added to the authenticated companion capability vocabulary and may be explicitly granted in an IDE enrollment. That grant is intentionally inert by itself.

A valid MAC, active enrollment, current session and controller are still insufficient to authorize implementation. The ordinary companion authority path continues to use `writerLease=none`, so B1 rejects `request_implementation` with `IDE_WRITER_LEASE_REQUIRED` unless the separate B9 writer-aware path proves a current B8 lease.

The current canonical authenticated capability set is `IDE_COMPANION_AUTH_CAPABILITIES`. The historical `IDE_COMPANION_B3_CAPABILITIES` symbol remains an exact alias only to preserve earlier evidence/source compatibility; it no longer describes the whole lifecycle by name.

## Two-layer authenticated payload binding

A B9 implementation start uses a domain distinct from B7 review:

`quarangate.ide.implementation.payload.v1`

The outer companion HMAC covers the exact bounded serialization of:

- implementation domain;
- prompt bytes;
- exact serialized B5 workspace-attestation bytes.

Only after that outer frame verifies and its replay token is durably claimed does B5 verify the nested attestation. B5 receives the SHA-256 of the exact attestation bytes, not the outer combined-payload digest. Prompt or nested-attestation substitution therefore invalidates the outer MAC before writer acquisition, while B5 independently validates the exact attested physical/logical workspace binding.

Review and implementation starts are not interchangeable: `start_review` requires `request_review`; `start_implementation` requires `request_implementation`; generic `prompt` remains non-executable through this operation protocol.

## B9.1 admission order

`admitIdeImplementation` performs this exact order:

1. require `request_implementation` capability;
2. construct the canonical domain-separated combined implementation payload;
3. re-read the current B4 runtime secret;
4. verify runtime/enrollment identity, time window, HMAC and exact combined payload;
5. durably consume the replay nonce;
6. re-verify exact B5 workspace/worktree evidence against trusted enrollment/session/runtime state;
7. acquire one B8 `ownerKind=ide` live-writer lease for the verified trusted project/worktree, with `ownerId=operationId` and trusted principal;
8. Plane B re-reads that exact lease from the B8 durable authority store by opaque writer-lease ID;
9. require the re-read lease to be ACTIVE and exact-bound to trusted principal/project/worktree and the exact operation ID;
10. re-run B1 full-tuple session authority with `controllerLease=acquired` and `writerLease=acquired`;
11. return bounded admitted identity plus the writer-lease ID to the later B9 operation-binding layer.

The writer proof is therefore not a structurally supplied object. Plane B asks a B8 authority reader for the persisted row and derives writer authority only from that durable result.

## Cross-database boundary and compensation

Plane-B IDE state and B8 live-writer state intentionally remain in separate durable SQLite databases. B9.1 does not pretend that a cross-database transaction exists.

The ordering is fail closed:

- B5 verification happens before B8 acquisition;
- B8 acquisition happens before writer-capable B1 authority;
- if authority fails synchronously after acquisition but before a durable B7 operation exists, B9.1 attempts an exact safe release;
- if safe release cannot be proven, it attempts to mark that exact lease `UNCERTAIN` and reports `IDE_IMPLEMENTATION_WRITER_SETTLEMENT_FAILED` rather than claiming release;
- if the process disappears after B8 acquisition, B8 startup recovery converts unresolved ACTIVE live-writer leases to `UNCERTAIN` rather than silently freeing them.

Thus the unavoidable cross-database interruption window fails toward a blocked writer, not duplicate writer authority. B9.2 must bind the admitted lease into the durable B7 implementation-operation lifecycle and own all later terminal settlement.

## B9.1 does not create an operation

A successful B9.1 admission intentionally leaves the Plane-B session at `CONTROLLER_ACQUIRED` and creates no `ide_operations` row. It invokes no adapter and performs no mutation.

This separation allows the admission ordering and writer proof to be independently reviewed before a mutation-capable execution seam exists.

## Live listener remains fail closed

The B7 AF_UNIX listener can parse the new bounded `start_implementation` frame shape so protocol/authentication work can be frozen independently. It still has no B9 implementation executor or B8 writer store wired into it.

A fully signed, explicitly enrolled `start_implementation` frame is rejected with `IDE_IMPLEMENTATION_NOT_CONFIGURED`; no operation is created and the connection/session fails closed under the existing listener error policy.

No new public MCP/HTTP tool or route exists. The public MCP catalog remains exactly 45 tools.

## Security properties pinned by tests

B9.1 regressions prove:

- valid implementation envelope + B5 evidence can acquire exactly one B8 IDE writer lease;
- the successful sub-batch stops before durable B7 operation creation;
- writerless B1 authority rejects implementation;
- B5 mismatch occurs before B8 owner identity consumption;
- existing B8 contention blocks implementation admission;
- post-acquisition B1 failure safely releases the exact pre-operation lease;
- Plane B re-reads durable B8 state and rejects a lease belonging to another target;
- outer HMAC binds the prompt and exact nested attestation before B8 acquisition;
- review/implementation operation domains and capabilities are non-interchangeable;
- a fully signed/enrolled live-listener implementation frame remains non-executable in B9.1.

## Explicit non-claims

B9.1 does **not** claim or provide:

- complete P7 B9 acceptance;
- durable implementation-operation creation;
- mutation-capable adapter execution;
- mutation success, rollback or exactly-once semantics;
- B8 lease settlement after a durable operation begins;
- implementation cancellation/disconnect/revocation terminal coupling;
- implementation restart recovery beyond B8's conservative unresolved-writer recovery;
- VS Code/Kiro/Cursor/Visual Studio/Antigravity implementation adapter qualification;
- provider/model selection or execution;
- arbitrary terminal/filesystem/host-command authority;
- caller-selected host path, project, worktree, lease or credential authority;
- public IDE mutation MCP/HTTP tools;
- executor-startup wiring or deployment;
- IDE-host air-gap/egress qualification;
- physical path alias equivalence beyond the accepted B5 attestation contract.

## Next bounded sub-batches

**B9.2** may integrate the accepted B9.1 admission with a backend-neutral mutation-capable adapter seam and a durable B7 implementation-operation lifecycle. It must durably attribute the exact B8 lease to the exact operation before adapter mutation begins and settle safe terminal, cancellation, disconnect, revocation and uncertainty outcomes fail closed.

**B9.3** remains the adversarial recovery/concurrency/corruption closure and final B9 acceptance slice. B9 as a whole must not be promoted CLOSED until those later slices are independently frozen and accepted.

## Validation on final pre-freeze B9.1 code bytes

- focused B9.1/B3/B7/B8 authority slice: **102/102 PASS across 5 files** after adversarial hardening;
- full root unit: **2455/2455 PASS across 80/80 files**;
- typecheck: PASS;
- build: PASS;
- diff-check: PASS;
- console catalog + public Agent schemas: **16/16 PASS**;
- public MCP catalog: exact **45/45**, missing 0, extra 0;
- source-graph inspection: no B9 implementation admission import in executor startup/public gateway; listener explicitly refuses implementation execution.

The only edit after that full code validation is this audit-document receipt update; no executable/test/config byte changed afterward. `git diff --check` is re-run as part of the freeze.
