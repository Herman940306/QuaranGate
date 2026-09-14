# P7 B3 — Authenticated IDE Companion Request Foundation

Status: **SOURCE FOUNDATION / NOT A LIVE IDE TRANSPORT**

## Scope

P7 B3 builds the backend-neutral authentication and replay-admission substrate required before any QuaranGate-owned IDE companion can be wired to a local IPC listener. It extends accepted B1/B2 logical authority without exposing a new MCP tool, executor route, socket listener, provider/model call, caller-selected host path, Docker/network option, credential store, operation executor, or writer authority.

Implemented source:

- `src/shared/ideCompanionAuth.ts` — closed authenticated-envelope schema, domain-separated HMAC-SHA-256, exact payload hashing, bounded time window, strict frame parser, duplicate-key rejection and constant-time verification.
- `src/executor/ide/ideCompanionAdmission.ts` — one canonical internal admission order: cryptographic verification -> durable replay claim -> trusted B1/B2 authority. It performs no IDE/provider operation.
- `src/executor/ide/ideSessionStore.ts` — additive registry schema v2 with durable hashed-nonce replay state, exact B2 v1 preflight/migration, replay-capacity bound and companion authority derived from trusted enrollment.
- `tests/unit/ide-companion-auth.test.ts`, `tests/unit/ide-companion-admission.test.ts`, and B3 additions to `tests/unit/ide-session-store.test.ts` — deterministic positive, adversarial, migration, replay and lifecycle coverage.

The preserved `extensions/quarangate-ide-chat-spike/` S1 package remains untouched feasibility evidence. B3 does **not** carry forward S1's weaker raw-shared-secret-in-every-frame design or restart-local nonce registry.

## Authenticated envelope

Protocol version `1` authenticates exactly:

`enrollmentId -> ideInstanceId -> sessionId -> connectionGeneration -> controllerLeaseId -> operationId -> capability -> nonce -> issuedAtMs -> expiresAtMs -> payloadSha256`

The MAC input is a fixed-order JSON array prefixed by the domain string `quarangate.ide.companion.request.v1`. The MAC is HMAC-SHA-256 with a 32–64 byte secret supplied by a later trusted credential layer. The secret itself is never a frame field. The payload body is not copied into the authentication envelope or registry; B3 authenticates its exact SHA-256 digest.

Binding the opaque controller lease is deliberate. A request signed under a prior controller lease remains cryptographically self-consistent, but registry admission rejects it after controller release/reacquisition because the live session owns a different lease. Reconnect similarly invalidates old signed requests because the durable enrollment generation advances and the old session becomes stale.

## Time and parsing bounds

- authentication frame maximum: 4 KiB;
- authenticated lifetime maximum: 30 seconds;
- accepted future clock skew: at most 5 seconds;
- timestamps must be non-negative safe integers;
- expiry must be after issue time and after the trusted verification time;
- overflow-sensitive comparisons use subtraction rather than unsafe `now + bound` arithmetic;
- nonce format is exactly 43 base64url characters, suitable for 32 random bytes;
- payload digest and MAC are exact lowercase 64-character SHA-256 hex;
- parser rejects unknown, missing and duplicate top-level fields before authorization;
- `request_implementation` is rejected at the B3 protocol boundary.

Wrong secret, wrong MAC and wrong payload collapse to the same fixed authentication-denied class. Error messages do not echo secrets, MACs, payloads, prompts, or raw nonce values.

## Durable replay authority

B3 advances the separate Plane-B registry from schema v1 to v2. The additive `ide_auth_replays` table stores only:

- SHA-256 of the public nonce;
- opaque enrollment/session/controller/operation identities;
- connection generation;
- capability;
- expiry timestamp;
- bounded claim timestamp.

It stores no raw nonce, shared secret, MAC, payload, prompt/response body, provider state, model selector, host path, or writer lease.

Replay identity is a durable primary key, so executor/store restart does not reopen the authenticated validity window. Expired rows are pruned before a new claim. A reused nonce is permitted only after the prior authenticated validity window has ended; the captured prior frame is already expired at that point. Active replay state is capped at 4096 entries per enrollment/generation. Capacity exhaustion fails closed and does not evict a still-valid entry.

The exact accepted B2 v1 required security shape is verified before v1->v2 mutation. Malformed v1 and partially-present v2 replay state under a v1 stamp are refused without repair. Current v2 opening verifies the replay nonce primary key and expiry-index columns in addition to the previously accepted B2 table/column/security-index checks.

## Trusted authority derivation

The machine frame does not carry project ID, worktree ID, workspace fingerprint, base revision, IDE product, principal, host path, or writer grant. After MAC verification, B3 resolves the opaque enrollment/session through the durable Plane-B registry and re-derives those fields from trusted enrollment state.

The canonical admission funnel is intentionally ordered:

1. validate schema/time and verify HMAC + payload hash;
2. durably claim the hashed replay identity;
3. apply accepted B1/B2 authority against current enrollment/session/controller state.

A cryptographically invalid attempt does not consume replay state. A cryptographically valid frame that is currently lifecycle-denied **does** consume its nonce, preventing the same signed frame from becoming authorized later merely because session state changes.

All B3 companion authority still reaches B1 with `writerLease='none'`. B3 neither enrolls nor authorizes `request_implementation`.

## Explicit non-claims / later gates

B3 does not qualify or implement:

- generation, storage, delivery, revocation, or rotation of enrollment secrets;
- multi-key/key-ID rotation or overlap policy;
- adapter binary/version attestation;
- creation, ownership, permissions, discovery, or cleanup of an actual Unix-domain socket;
- a public/internal HTTP or MCP route for IDE control;
- trusted host-path/worktree canonicalization and live IDE workspace attestation;
- persistent append-only IDE operation/event audit;
- operation creation, execution, cancellation reconciliation, or exactly-once terminal coordination;
- shared live-writer arbitration with `agent_apply` or any direct live mutation lane;
- provider/model selection or provider session attachment;
- VS Code, Kiro, Cursor, Visual Studio, or Antigravity production compatibility.

A later transport/credential gate must resolve the correct enrollment-bound secret out of band and supply a **trusted server-side clock** to B3 verification. No client-provided `now` value exists in the authenticated frame. Secret rotation may not be claimed until its own atomic single-active-key or explicitly versioned multi-key policy is implemented and tested.

## Validation receipt before immutable freeze

- focused B1/B2/B3 suites: `71/71 PASS` across common authority, registry/replay, cryptographic envelope and canonical admission;
- full root unit suite: `2329/2329 PASS` across `70/70` files;
- TypeScript typecheck: PASS;
- build: PASS;
- `git diff --check`: PASS;
- console-catalog regression: `4/4 PASS`; public MCP catalog remains exactly `45` tools.

One attempted combined validation shell was rejected by the external tool-safety wrapper **before execution**. It performed no project mutation and is not a QuaranGate/test failure. The same validations were then executed as smaller independent calls and produced the PASS receipts above.

These are source-candidate receipts only. Final B3 acceptance still requires exact immutable source freeze plus independent read-only review of that immutable candidate; no live/runtime claim is made by the pre-freeze tests.

## P7 continuation

After B3 acceptance, the next gate must be derived from the current North-Star/security ordering rather than assumed. Likely remaining prerequisites include trusted credential/enrollment-secret lifecycle, local IPC endpoint ownership/authentication and workspace attestation before any live adapter exposure. No listener or vendor-specific runtime should be wired merely because B3 cryptographic source is accepted.
