# P7 I2.2 — VS Code QuaranGate-Origin Command/Event Transport

## Classification

**Candidate status:** `IN_PROGRESS / UNACCEPTED` until immutable-source review and project-control reconciliation complete.

This slice implements and qualifies one bounded, versioned QuaranGate-origin command/event transport over the already accepted B6-authenticated VS Code companion connection. It does **not** complete I2 and does not attach a public Chat Participant/model core, public MCP operation, arbitrary VS Code API bridge, host shell, deployment wiring, or provider-specific hidden fallback.

## Accepted baseline

- Forward branch: `integrate/quarangate-forward`
- Accepted parent: `9247fb380228405e47f154be4a4969a16f2b671d`
- Accepted control: `control/project-closure @ 0ce0734133ffabc2c1c2de6085f32ff08aa3a0f8`
- I2.1 remains the accepted B6 VS Code identity/authenticated-connection baseline.
- B3/B5/B7/B8/B9 remain the authority chain. I2.2 transports that authority; it does not replace or enlarge it.

## Unattributed-candidate reconciliation

The initial I2.2 working-tree input could not be attributed to an authorized historical writer. Owner-authorized reconciliation therefore treated the bytes as hostile/untrusted input rather than as accepted implementation.

Historical seven-path snapshot:

- path/status SHA-256: `7c26fc237a71b25b40f5ba972188ba28389ff123341841634c952fe8106b1139`
- content-manifest SHA-256: `65aaadcb0197eecd01e44d152f5293556ed2789e0f739d68cc8f3569b3753b89`

Post-snapshot eight-path unattributed input:

- path/status SHA-256: `ee40cc4cac1a8bff17bbf38d0db247f4a791e42110cde9c360f5a2c99103b6b1`
- content-manifest SHA-256: `8559a68dac9dd3a617b6a5e9d764957616a09f27622cae65a662c441b8072bf2`

Mechanically reconstructed provenance:

1. `2026-09-14T17:02:27Z` — accepted I2.1 commit `9247fb3...` created; index last updated.
2. `2026-09-14T17:17:23.465671183Z` — `/tmp/i22-manifest.txt` captured the exact historical seven-file manifest.
3. `2026-09-14T17:17:23.473657214Z` — `/tmp/i22-status.txt` captured the exact seven-path status.
4. `2026-09-14T17:17:26.192625001Z` — five I2.2 files show in-place post-snapshot mutation.
5. Approximately `2026-09-14T17:17:33Z` — I2.2-named runtime/IDE/writer test fixtures prove focused post-rewrite test activity; no qualification verdict was preserved or trusted.
6. `2026-09-14T17:18:51.074141673Z` — `src/shared/ideCompanionRemotePreflight.ts` was created as an eighth, unreferenced file.
7. Historical writer identity remains unresolved and is not attributed to the browser agent, Kiro, an IDE agent, or any particular QuaranGate job.

Before source mutation, three quiet-window checks plus a final immediate pre-mutation check proved the eight-path input byte-identical, staging empty, no Git locks, accepted HEAD/control unchanged, and no current writer observable.

- `HISTORICAL_WRITER_IDENTITY: UNRESOLVED`
- `CURRENT_CONCURRENT_WRITER: NONE_OBSERVED`

Forensic preservation outside the active repository:

- directory: `/workspace/.quarangate-forensics/I2.2-unattributed-pre-reconciliation-20260914T174742Z`
- sealed archive: `/workspace/.quarangate-forensics/I2.2-unattributed-pre-reconciliation-20260914T174742Z.tar.gz`
- archive SHA-256: `752204f3b02ed5b5155ce68408cc9bc4e271d4264fe03487602aed94bddf4fc3`
- classification: `UNATTRIBUTED_I2_2_PRE_RECONCILIATION`

The preservation bundle contains copied bytes, individual hashes, combined manifest/status hashes, accepted HEAD/branch/control identity, historical snapshot manifests, and the provenance timeline.

### Historical seven-path delta availability

Exact byte-level comparison is available only where historical bytes survived. The original seven-path evidence preserved exact hashes/status for all seven paths, but did not preserve old untracked file contents for the five subsequently rewritten paths. Therefore no content diff is invented for those five files. The proven transition is:

- unchanged through the unattributed transition: `src/executor/ide/ideCompanionListener.ts` and `tests/unit/vscode-command-channel.test.ts` matched their seven-path snapshot hashes before reconciliation;
- changed after the seven-path snapshot: `src/executor/ide/ideCompanionRemoteChannel.ts`, `src/ide-adapters/vscode/vscodeCommandChannel.ts`, `src/shared/ideCompanionRemoteTransport.ts`, `tests/unit/ide-companion-remote-channel.test.ts`, and `tests/unit/ide-companion-remote-transport.test.ts` had new hashes;
- added later: `src/shared/ideCompanionRemotePreflight.ts`.

The complete eight-path pre-reconciliation bytes are preserved in the forensic archive, and the reconciliation delta from those bytes to the final candidate is mechanically diffable.

## Hostile-input review and reconciled design

### Authority direction

The transport is direction-separated:

- QuaranGate -> companion: `authorize_operation`, `execute_operation`, `cancel_operation`.
- companion -> QuaranGate: `transport_ready`, `operation_authorized`, bounded ordered adapter events, terminal result, `cancel_ack`.

The extension cannot create a QuaranGate operation, controller lease, project/worktree identity, or B8 writer lease through this protocol. Operation IDs and controller leases originate from trusted QuaranGate callers and are rebound at B3/B7/B9. Project/worktree authority is re-derived from trusted enrollment by B5. B8 writer authority is acquired and verified by B9 before mutation-capable adapter execution.

### Durable admission before execution

A client authorization frame is not operation authority. The QuaranGate-side remote adapter checks the exact durable Plane-B operation immediately before sending `execute_operation`:

- exact operation ID;
- exact session and connection generation;
- exact capability;
- durable state `RUNNING` or `CANCELLING`.

Review execution therefore follows B7 admission. Implementation execution follows B9 admission, including exact B8 writer acquisition and the durable mutation-start transition before the remote adapter can execute.

### Replay, reflection, sequence and binding

The transport uses exact canonical schemas and direction-specific frame types. It rejects unknown fields, malformed nested auth, unsupported versions, cross-direction reflection, cross-session/generation frames, command replay/gaps, event replay/gaps, stale/unexpected authorization, and stale/unexpected cancel acknowledgements.

Only one pending/authorized/active remote operation is permitted per channel. Operation IDs, capabilities, prompt bytes, session ID, generation, and controller lease are rebound at each handoff. A returned authorization must hash the exact canonical prompt+workspace payload expected by QuaranGate.

### Credential rotation

The VS Code command channel rereads the current owner-only B4 credential for each operation authorization. The server-side B3 admission rereads the current B4 runtime secret before durable admission. A secret rotated after B6 connection or after client authorization invalidates stale operation authentication rather than silently retaining bootstrap authority.

### Workspace freshness and authorization-to-execution TOCTOU

The unattributed candidate already collected fresh B5 evidence while responding to each QuaranGate `authorize_operation`, and B3 authenticated the exact prompt plus canonical workspace attestation. The review found a narrower remaining gap: workspace identity could change after that authorization but before the separately admitted `execute_operation` reached the extension.

The reconciled implementation closes that transport-time gap without creating a second authority protocol:

1. authorization collects canonical B5 evidence and B3-authenticates its exact bytes;
2. QuaranGate independently verifies B3/B5 and performs B7/B9 durable admission;
3. immediately before invoking any remote handler, the VS Code channel rereads the current B4 credential binding and recollects canonical B5 evidence;
4. execution proceeds only if those fresh canonical bytes are byte-identical to the B3-authenticated operation attestation;
5. failure is reported before handler invocation as `failed` for review or `failed_no_mutation` for implementation.

For implementation, the accepted B9 coordinator therefore settles the exact B8 writer as `RELEASED` only after the adapter proves the execution-time workspace recheck failed before mutation. Unknown execution/mutation state remains `indeterminate`/`UNCERTAIN` through accepted B9 settlement logic.

## `ideCompanionRemotePreflight.ts` adjudication

**Outcome: `REDUNDANT_REMOVE`.**

Preserved unattributed file:

- path: `src/shared/ideCompanionRemotePreflight.ts`
- historical SHA-256: `34963edc8cb86b600e45ce1e449755b78af4a1c2906a2c07cec384168d8df4e6`

The file implemented a second domain-separated HMAC/challenge shape over session/generation/command/operation/controller/capability/challenge/expiry/payload hash, but it was unreferenced and had no proven post-creation qualification. Wiring it would create a second cryptographic security surface without granting stronger logical authority than the accepted B3/B5/B7/B9 chain.

The real uncovered property was execution-time workspace freshness, not absence of another MAC. That property is now enforced by exact local B4+B5 re-attestation immediately before handler invocation, while B3 remains the operation-payload authentication mechanism and B7/B9 remain the durable operation/writer admission mechanisms. The dead preflight helper is therefore removed from the reconciled candidate; its bytes remain preserved in the forensic archive.

## Cancellation, disconnect and backpressure

- `transport_ready` is bounded by the same maximum remote authorization timeout; a client that never upgrades the B6 connection to I2.2 transport is closed fail-safe.
- Server send/serialization exceptions are converted to fail-closed channel failure rather than escaping with reusable authorization state.
- Listener remote writes enforce the bounded write queue and destroy the connection on serialization/write failure.
- Client writes enforce bounded buffering/write queue and fail-close on serialization, queue or synchronous write failure.
- Cancellation names the exact active operation; QuaranGate sends one exact cancel command and requires the matching cancel acknowledgment.
- B7/B9 remain authoritative for timeout/disconnect terminal state. Review cannot become false completion after timeout. Implementation disconnect/timeout/unknown outcomes retain B8 writer uncertainty unless a safe no-mutation/rollback outcome is proven.

## Authority-surface review

The reconciled I2.2 source introduces no child process, shell, arbitrary filesystem, arbitrary VS Code API, Docker, HTTP, public MCP, or startup registration path. The only changed listener filesystem operation is the already-existing owner-socket cleanup path. Static source-graph scans found I2.2 wiring only in the bounded listener/adapter/test modules and no executor/gateway startup or public MCP registration.

The listener also rejects configuration that attempts to combine this QuaranGate-origin remote mode with the prior client-origin operation adapters on the same socket, preventing dual operation-start authority.

## Independent review R0 and remediation

Immutable R0 candidate `ae6910b03792b0178ddb1e8198905e54406aab8a` (parent `9247fb380228405e47f154be4a4969a16f2b671d`, patch SHA-256 `20f27709ef66211dede98b5b997a57fda03820c1c7f4f1cc9942fc7bf2630c5b`) received an independent prompt-only source-bearing review from job `job_ab2231f363c167aa14cd4a6c5e51cbf4`. The reviewer returned `FAIL_REVIEW`, changedFiles empty, on one narrow concern: fail-close cleanup should not depend on a later socket-close callback to reject an active adapter after a fatal send/backpressure failure.

The complete source already had `connectionClosed()` and `protocolFailure()` rejection paths, so the R0 finding overstated the existing gap. It nevertheless identified a worthwhile defense-in-depth invariant at the channel abstraction boundary. R1 therefore makes `failClosed()` itself terminal for all channel-local state before invoking the transport close callback:

- clears/rejects any pending authorization;
- rejects any active review/implementation adapter promise immediately;
- clears retained authorization;
- rejects/clears `transport_ready` waiters;
- only then invokes `opts.close()`.

A regression test now forces `cancel_operation` send failure while an adapter is active and proves the adapter promise rejects immediately with `IDE_REMOTE_CHANNEL_CLOSED` without manually invoking `connectionClosed()`. This removes reliance on socket close-event ordering and directly closes the independent review concern.

## Qualification evidence on reconciled bytes

All evidence below was rerun after reconciliation; no unattributed historical test claim is reused.

### Focused/adversarial I2.2

`npx vitest run tests/unit/ide-companion-remote-transport.test.ts tests/unit/ide-companion-remote-channel.test.ts tests/unit/vscode-command-channel.test.ts --reporter=verbose`

- **29/29 PASS across 3 files**.
- Includes canonical frame bounds, invalid UTF-8, direction reflection, replay/gap rejection, exact session/generation binding, exact authorization, durable-admission reread, cancellation ordering/ack binding, bounded `transport_ready`, thrown send failure, immediate active rejection on cancel-send failure, fresh B4 rotation, fresh operation B5 drift denial, post-authorization/pre-execution B5 drift, B8 safe release on proven no-mutation, B7 timeout, and dual-authority listener refusal.

### B1-B9 + I2.1 + I2.2 focused regression

Bounded serial matrix across 21 IDE authority/runtime/workspace/operation/writer/listener/VS Code/I2.2 unit files:

- **278/278 PASS across 21 files**.

### Shared writer + `agent_apply`

`live-writer-arbitration`, `agent-apply-state`, A6 apply-engine and apply-policy:

- **246/246 PASS across 4 files**.

### Every repository unit file / canonical command

Canonical `npm test` was attempted on the final reconciled source and did **not** reproduce the historical Vitest worker failure:

- exit: **0**
- **87/87 unit files PASS**
- **2544/2544 tests PASS**

Because the canonical command completed successfully, a bounded-process fallback corpus was not required.

### Catalog/schema/public surface

`console-catalog`, `agent-schemas`, `github-surface`, `console-full-ui`:

- **41/41 PASS across 4 files**.
- static catalog count: **45**.
- console catalog asserts **45 expected / 45 server-contract names / no duplicate expected names**.
- I2.2 adds no public MCP tool.

### Compiler/build/diff gates

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `git diff --check` — PASS.

### Source-graph/startup/public authority scan

Searches for `remoteChannelReady`, `IdeCompanionRemoteChannel`, `VsCodeCommandChannel`, and `ideCompanionRemoteTransport` found source wiring only in:

- `src/executor/ide/ideCompanionListener.ts`
- `src/executor/ide/ideCompanionRemoteChannel.ts`
- `src/ide-adapters/vscode/vscodeCommandChannel.ts`
- `src/shared/ideCompanionRemoteTransport.ts`

and their unit tests. No I2.2 reference was found in `src/executor/index.ts` or `src/gateway`. No `ideCompanionRemotePreflight` reference remains. Changed I2.2 surfaces expose no shell/child-process, arbitrary host filesystem, arbitrary VS Code command/API, Docker or network-client authority.

## Reconciled candidate source hashes before documentation freeze

- `6d9f6a1a63e3955a7edbf1ef3f8dd6d34fa5bf73ffcab3985ba12d69083ade8e  src/executor/ide/ideCompanionListener.ts`
- `3d4e72abd66fae4e8a6c126f19a89f1cb84a6a856113ef397fee4fd0001d0e55  src/executor/ide/ideCompanionRemoteChannel.ts`
- `804cd45fcdfd9925a57272698025a052bb7f3dc36f1cfd3c1b2f3fa516c16942  src/ide-adapters/vscode/vscodeCommandChannel.ts`
- `92bde81a3ed34ee3aec4203da71650d4ad7f5d951344af716dff577db11921f6  src/shared/ideCompanionRemoteTransport.ts`
- `ec85d5435c94db9ca14cc37ed72354db4bb7b32d828574dcee483f87bb7b39d8  tests/unit/ide-companion-remote-channel.test.ts`
- `12668e63f6314ea041fa98a605fa8b681353c2ef651d052825cc1cb661ec0b1f  tests/unit/ide-companion-remote-transport.test.ts`
- `e34c0719a029a2ff70470148fd9e7904d96f3d54eb3b9bcde41d75cae638f51e  tests/unit/vscode-command-channel.test.ts`

The final freeze must include this audit document and mechanically recompute the exact path/status and content manifests before staging.

## Residual/non-claims

- I2.2 remains unaccepted until immutable independent review and control reconciliation both pass.
- This is source qualification, not live VS Code/Remote-WSL rendered qualification.
- It does not claim provider/model integration, Chat Participant/public extension UX, Cursor support, I6 completion, final P7 acceptance, branch convergence, canonical merge, or SH-01..SH-15 execution.
- Live extension/model work must remain a later I2 slice and cannot weaken the authority chain proven here.
