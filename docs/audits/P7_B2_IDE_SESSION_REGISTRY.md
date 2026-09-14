# P7 B2 — Trusted IDE Enrollment / Registry Foundation

Status: **SOURCE FOUNDATION / NOT A LIVE IDE ADAPTER**

## Scope

B2 adds a durable Plane-B-only registry beneath the accepted B1 common contract. It does not add a public MCP tool, HTTP/IPC listener, IDE extension change, provider/model call, credential/MAC transport, host-path input, persistent prompt/response body, Docker/network authority, or writer path.

The registry is a separate executor-owned SQLite database rather than an extension of the Agent Control Plane job/session tables. This preserves Agent Control Plane / IDE Session Control authority separation while reusing QuaranGate's proven SQLite, compare-and-set, schema-integrity and restart-recovery patterns.

## Durable authority model

`ide_enrollments` stores only trusted logical binding and least-authority state: opaque enrollment ID; principal; logical project/worktree IDs; IDE product and durable instance ID; workspace fingerprint and optional exact base revision; canonical read-only capabilities; ACTIVE/REVOKED state; monotonic current connection generation; bounded timestamps.

B2 permits any non-empty subset of `prompt`, `cancel`, `observe_response`, `request_review`, plus explicitly opted-in `read_bounded_editor_context`. `request_implementation` is rejected by B2 policy. No host path is stored or accepted.

`ide_sessions` stores opaque session ID, enrollment ID, monotonically increasing connection generation, lifecycle state, optional opaque controller-lease ID and timestamps. A partial unique index permits at most one live session per enrollment. Reconnect atomically marks the previous live generation STALE before creating the next generation. Session IDs are never reusable. Every lifecycle/authority lookup additionally proves that the session row generation equals the enrollment's durable `current_generation`; a historical row made live-looking by corruption is therefore denied rather than revived.

## Controller and restart boundary

Controller acquisition is CAS-gated from AVAILABLE and creates one random opaque controller lease. Lifecycle and authority operations require the exact principal/project/worktree/workspace/product/instance/session/generation binding; controller-backed authority additionally requires the exact current opaque lease.

B2 never creates a writer lease. `assertAuthority` always binds `writerLease=none`, and B2 enrollment rejects `request_implementation`. A later P7 batch must integrate QuaranGate's shared live-writer arbiter before IDE implementation authority can exist.

On restart, transport/controller liveness is never assumed. `recoverAfterRestart()` marks every previously live generation STALE and clears controller leases. It never reactivates a session; a companion must explicitly reconnect using a new session ID and monotonically higher generation.

## Persistence hardening

The dedicated DB uses `node:sqlite`, WAL, busy timeout, foreign keys, restrictive process umask and 0600 DB/sidecar modes. Both schema version and actual table/column/index shape are verified. Security-critical partial unique indexes are not trusted by name alone: B2 verifies UNIQUE/partial flags, exact indexed columns, and normalized SQL predicates. Future versions fail closed. A falsely stamped current schema or same-named weakened index fails closed without repair. An unstamped non-empty database is refused rather than silently adopted.

The registry stores no prompt, response, editor content, tool arguments, provider session, credential, secret, host path, arbitrary command, model name or provider endpoint.

## Evidence boundary / continuation

B2 validation includes deterministic corruption cases for weakened same-named index predicates and historical-generation resurrection attempts. B2 is not wired into executor startup and exposes no external route. Startup integration is intentionally deferred until this source foundation is independently accepted. Persistent append-only IDE audit, authenticated companion enrollment/MAC transport, trusted host/worktree attestation, adapter lifecycle and vendor-specific VS Code/Kiro/Cursor qualification remain later P7 gates.
