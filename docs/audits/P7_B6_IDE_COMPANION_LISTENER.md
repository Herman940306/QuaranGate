# P7 B6 — Authenticated Local IDE Companion Listener / Connection Lifecycle

## Scope

P7 B6 adds a source-only local AF_UNIX listener and authenticated connection handshake. It establishes only runtime identity, workspace identity and Plane-B connection availability. It does not execute prompts, tools, providers, models or mutations; it adds no public MCP/HTTP route, persistent IDE-operation audit, shared writer arbitration, writer lease or vendor-live production claim.

## Why B6 has a separate handshake MAC

Accepted B3 operation admission deliberately requires an acquired controller lease and an enrolled capability. A connection handshake occurs before a session is AVAILABLE or controlled. Reusing an operation capability merely to bootstrap the transport would weaken the B1/B3 lifecycle contract.

B6 therefore uses a separate domain-separated HMAC-SHA-256 pre-controller handshake with the current B4 32-byte runtime secret. The handshake binds enrollment, IDE instance, runtime instance, adapter ID/version, session ID, proposed connection generation, client nonce, fresh server challenge, issued/expiry times and the exact SHA-256 of the canonical B5 workspace-attestation bytes. It grants no controller, capability or writer authority.

## No unauthenticated state mutation

`hello` is canonical/bounded evidence only. The server reads the durable enrollment generation and returns a fresh 256-bit server challenge plus the proposed next generation; it does not create or stale a session.

Only after exact challenge binding, time validation and HMAC verification does B6 invoke `openSessionIfCurrent`. That Plane-B CAS requires the durable enrollment generation still equal the generation observed when the challenge was issued. A late authenticated challenge therefore cannot stale or replace a newer authenticated connection.

## Workspace promotion ordering

After authenticated session creation in CONNECTED state, B6 runs the accepted B5 verifier over the exact attested bytes. Only an exact trusted-enrollment/runtime/session/workspace match may transition CONNECTED -> AVAILABLE. A valid-MAC but invalid workspace opens no authority; the connection closes and the newly opened session is durably reconciled to DISCONNECTED.

## Runtime secret lifecycle

Listener startup first proves the B4 credential is currently ACTIVE and zeroes the temporary secret buffer. Every attestation then re-reads the current credential again and zeroes that temporary buffer. Rotation between challenge and response therefore invalidates an old signed response before Plane-B session mutation. A revoked runtime refuses listener startup.

## Local endpoint confinement

- Unix-domain sockets only; Windows/TCP/network listeners are not supported by B6.
- Bind path is exactly the trusted B4-derived `companion.sock` path.
- Any pre-existing path causes startup refusal; B6 never unlinks it.
- After successful bind B4 verifies Unix-socket type, current UID and exact `0600` mode.
- Cleanup tracks whether this exact listener created the endpoint. `stop()` cannot unlink a same-UID socket that predated the listener.
- The same-UID hostile-process residual from B4 remains explicitly unqualified.

## Bounded connection protocol

- maximum active connections: 16;
- handshake timeout: 20 seconds;
- handshake frame bound: 32 KiB;
- output queue bound: 64 KiB;
- newline framing with no pipelined/multiple frames;
- one `hello`, then one `attest`, then READY with no further B6 client frames;
- exact canonical JSON and fatal UTF-8 for handshake frames;
- 32-byte canonical base64url client nonce and server challenge;
- maximum handshake validity: 15 seconds, with 5-second future clock-skew allowance.

## Disconnect / reconnect / restart semantics

A READY socket close durably marks its current session DISCONNECTED. An authenticated reconnect advances the generation, stales the prior live generation and then makes only the new generation AVAILABLE. Old socket-close handling checks exact generation/terminal state and cannot damage the replacement.

Controlled listener shutdown reconciles tracked sessions synchronously before destroying sockets, fixing a pre-freeze race where shutdown could otherwise return before asynchronous `close` handlers persisted DISCONNECTED. Restart recovery never revives terminal state.

## Adversarial evidence

Real Unix-socket tests prove:

- exact socket path/type/0600 mode;
- valid authenticated workspace promotion;
- hello-only and invalid-MAC zero mutation;
- runtime-secret rotation invalidates challenged response;
- invalid B5 evidence becomes DISCONNECTED, never AVAILABLE;
- stale challenge CAS cannot stale the winner;
- reconnect stales old generation without old-close damage;
- ready close -> DISCONNECTED;
- pre-existing regular file remains untouched;
- pre-existing same-UID Unix socket remains untouched even after failed start + stop;
- oversized and multiple frames fail closed;
- extra post-READY client frames fail closed;
- exact 16-connection capacity;
- controlled stop disconnects and removes only owned endpoint;
- revoked runtime refuses bind;
- expired challenge causes zero Plane-B mutation.

Direct registry tests separately pin `openSessionIfCurrent` success and stale-generation non-mutation.

## Pre-freeze defects found and corrected

1. Listener test clients initially created a 16-second lifetime against a 15-second maximum; the time guard correctly rejected them. Test construction was corrected without changing policy.
2. Controlled shutdown originally depended on asynchronous socket `close` event ordering. This was a real source race: a shutdown could return while Plane-B still appeared live. B6 now reconciles durable disconnect synchronously before socket destruction.
3. Cleanup originally could remove a pre-existing same-UID Unix socket if `stop()` followed a failed start. B6 now tracks endpoint ownership and removes only an endpoint created by this listener.

## Validation before full-root freeze

- P7 B1-B6 focused regression: **140/140 PASS across 10 files**.
- B6 handshake + listener + direct CAS subset: **60/60 PASS**.
- TypeScript typecheck: PASS.
- `git diff --check`: PASS.
- Source graph: no B6 listener/handshake import from executor startup, gateway or public tool catalog.

Final candidate receipts:

- Full root unit suite: **2398/2398 PASS across 76/76 files**.
- TypeScript typecheck: PASS.
- Build: PASS.
- `git diff --check`: PASS.
- Console catalog: **4/4 PASS**; public MCP tool surface remains unchanged.
- P7 B1-B6 focused regression remains **140/140 PASS across 10 files**.

## Explicit non-claims

B6 is not executor startup integration and is not a deployed/live IDE adapter. It does not prove vendor-adapter OS fact collection, peer process/binary authenticity, operation streaming/cancellation, persistent operation audit, shared live-writer arbitration, IDE-host egress behavior, or any vendor production compatibility. Those remain later P7 gates.
