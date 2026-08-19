# Security model & threat model

## Privilege boundary — the core claim

Access to `/var/run/docker.sock` is root-equivalent on the host. The **public-facing gateway never
has it.** The socket lives only in the **executor**, which:

- is on an `internal: true` Docker network with **no published ports** (verified unreachable from
  host and LAN),
- is authenticated by a shared `INTERNAL_TOKEN`,
- runs **non-root** with the docker group added only for socket access,
- exposes a **narrow API** that can only operate on configured/discovered targets within their
  canonical workspace — it has no verb to make arbitrary Docker calls, create containers, mount host
  paths, or execute on the host.

Therefore a compromised gateway, a stolen client key, or a malicious MCP client is bounded to: the
tools, scopes, and target workspaces that the mapped principal is authorized for. It cannot reach
the host, unrelated containers, or the raw Docker API.

## Client identity

One principal per client (`config/clients.yaml`), each with an independent API key (only the
sha256 hash is stored), independent scopes, an explicit target allowlist, an enable flag, and an
optional rate limit. Keys are generated (`npm run gen-key`), revoked/disabled (`npm run revoke-key`),
and rotated (regenerate + replace hash) independently. Browser clients that require OAuth get an
OAuth 2.1 bearer that maps to the **same** principal (see below).

## OAuth façade

The smallest standards-compatible surface to satisfy Claude/ChatGPT browser OAuth requirements:
Protected-Resource + Authorization-Server metadata, JSON Dynamic Client Registration (public
clients), `/authorize` (the user pastes their bridge API key = the login), and `/token` (auth code +
**PKCE S256** → opaque bearer, 1 h; rotating refresh token, 30 d). Registered redirect URIs are
validated exactly, authorization and token requests are bound to the MCP resource (RFC 8707),
authorization codes are single-use, and refresh tokens rotate on use. OAuth state is stored hashed
on the bridge data volume. The volume root is private to the non-root gateway (`0700`, `node:node`)
and OAuth state files are created `0600`. The bearer maps to the same per-client principal as the
static key, so authorization is identical regardless of auth method. Browser auth is never anonymous.
The authorization page uses a restrictive CSP; `form-action` permits only `self` plus the origin of
the already-validated registered redirect URI. This is required for real browser OAuth redirects
without opening form submission to arbitrary origins.

## Client-side action safety

MCP annotations remain truthful even when a browser client applies a stricter policy. In live ChatGPT
verification on 2026-07-28, `fs_delete` was discovered as WRITE / DESTRUCTIVE but ChatGPT blocked the
invocation before any MCP request reached the gateway. The bridge must not weaken or disguise the
destructive annotation, nor use `terminal_exec` as a bypass for a client-side safety decision. Server
authorization and integration tests continue to verify the underlying `files:delete` capability for
clients that are permitted to invoke it.

## Agent Control Plane (Phase A6 — implementation complete)

All nine of the Agent Control Plane tools are now operational (`agents_list`, `agent_projects`, `agent_dispatch`, `agent_status`, `agent_result`, `agent_cancel`, `agent_diff`, `agent_apply`, `agent_discard`), executed by a real **Kiro ACP backend** through isolated sandboxed runners with bounded resource limits and fail-closed security controls.

A6-specific security properties (unit- and integration-tested):

- **Authorization before work.** `agent_dispatch` runs the full grant matrix (scope + project +
  backend + profile) in the gateway *before* any executor call, and the executor independently
  re-validates project/backend/profile/resource-policy against trusted `config/agents.yaml`
  (defense in depth). An unauthenticated or unauthorized request never persists a job.
- **Job ownership** is enforced for status/result/cancel/diff/apply/discard in both the gateway
  (pure A1 matrix) and the executor (by `principalId` on the persisted row). No cross-principal
  override exists.
- **Sandboxed execution.** Real Kiro ACP backend executes inside ephemeral runners (non-root,
  non-privileged, CapDrop=ALL, no-new-privileges, read-only rootfs, NetworkMode=backend-only, no
  host binds, no docker.sock) with exact-integer resource limits (CPU/memory/PIDs/runtime/output).
  Workspace is a Docker-managed volume snapshot, never a raw host bind to the real project.
- **Guarded apply policy.** `agent_apply` enforces agents:apply scope, job ownership, project grant,
  COMPLETED status prerequisite, unapplied disposition, base-state verification (stale HEAD refusal),
  guarded-path validation (project-configurable forbidden/protected paths), one-time apply, and
  fail-closed patch validation. Apply uses a dedicated short-lived applier container, never reusing
  the unrestricted agent runner.
- **Governed discard.** `agent_discard` enforces agents:dispatch scope, job ownership, disposition
  rules (no double-disposition, no active/UNCERTAIN apply attempt interference), leaves live source
  unchanged, and removes sandbox according to retained-resource lifecycle policy.
- **Retained-resource lifecycle.** Automatic evidence expiry for APPLIED/DISCARDED jobs with published
  artifacts (Lane A: durable retention snapshot, fail-closed eligibility proofs, atomic
  AVAILABLE → EXPIRED transition); incomplete-evidence classification/reporting for failed/orphaned
  evidence (Lane B: IDENTIFY + CLASSIFY + REPORT + RETAIN, no automatic deletion); startup-only
  collection (awaited synchronous execution before service availability, no concurrent agent operations
  during collection); metadata retention (job rows, apply attempts, apply journal, project quarantine
  state retained indefinitely, only physical evidence bytes expire).
- **No caller-controlled execution.** Caller supplies logical project/backend/profile IDs only —
  never host paths, runner images, Docker options, or execution configuration.
- **Prompt confidentiality.** The bounded raw prompt lives only in the executor SQLite store; it is
  never audited, never logged, never returned by status, and not returned by result. Only
  `promptHash` is logged/audited. Provider credentials are injected at runner startup, never stored
  in job metadata.
- **Storage isolation.** The job DB is on an executor-owned volume (`mcp-bridge-jobs`, `0700`,
  `node`), a separate trust domain from the gateway OAuth `/data` volume; it is never mounted into
  the gateway or any target. Restart fails active jobs closed to `FAILED_INFRASTRUCTURE` (never
  silently resurrected) and cannot double-admit writers.
- **Boundary unchanged.** Gateway still holds no docker.sock and binds loopback only; the executor
  is still unpublished; agent runners receive no docker.sock, no arbitrary host binds, no privileged
  mode.

Scopes in the closed model: `agents:read`, `agents:dispatch`, `agents:cancel`, `agents:apply`.
Security properties fixed by the A1 contract (unit-tested):

- **Deny by default.** Agent access requires both an `agents:*` scope and explicit
  `projects`/`agentBackends`/`agentProfiles` grants on the principal; absent fields mean deny.
  Existing clients keep working with zero agent privileges.
- **Target permission never implies agent/project permission.**
- **Public schemas are strict**: caller-supplied `hostPath`, `runnerImage`, `mounts`,
  `privileged`, `networkMode`, `dockerSocket` and any unknown property are rejected; prompts are
  size-bounded; callers address logical project ids only. Trusted host paths live exclusively in
  executor-owned configuration (`config/agents.yaml`, example-only in A1).
- **Job ownership is exact** — no cross-principal admin override in v1; `agent_apply` additionally
  requires the project grant, and takes no caller patch text.
- **`COMPLETED` ≠ `APPLIED`**: applying sandbox work to a real project is a separate, one-time,
  explicitly authorized transition; final dispositions and failures are immutable.
- Runner egress policy values are `deny`/`backend-only` only; Tailscale
  (`serve`/`funnel`/ACLs) is host infrastructure permanently outside the agent capability plane.

See `docs/AGENT_CONTROL_PLANE.md` for the complete specification.

## Threat model

| # | Threat | Impact | Mitigation | Residual risk |
|---|---|---|---|---|
| 1 | Stolen client credential | Actions as that principal | Per-client keys, scopes, target allowlist, rate limit, audit; revoke/rotate | Bounded to that principal's targets until revoked |
| 2 | Compromised MCP client | Same as stolen key | Same as #1; destructive-action annotations prompt in clients | Same |
| 3 | Prompt injection in repo content | Client tricked into calling tools | Bridge authorizes by principal/scope/target regardless of prompt; no tool can widen its own scope | Client-side; bridge stays confined |
| 4 | Malicious source file | — | Files are data; reads/writes confined; no path escape | Low |
| 5 | Malformed MCP input | Crash/DoS | Zod schemas, typed errors, body size limits, fail closed | Low |
| 6 | Command injection (paths) | Escape workspace | Non-terminal ops use argv `docker exec`; paths passed as positional args; tar for content | Low |
| 7 | Path traversal | Read/write outside workspace | `pathcheck` rejects `..`/absolute in gateway+executor | Low |
| 8 | Symlink / nested-symlink escape | Read/write outside workspace | In-target canonicalization of path/ancestor must stay under canonical workspace | Narrow TOCTOU window (below) |
| 9 | Target-selection confusion | Act on wrong/forbidden target | Every call carries an explicit target; per-request principal via ALS; no shared mutable target | Low |
| 10 | Concurrent client interference | Cross-client leakage | Stateless server per request; ALS-bound principal; per-principal concurrency | Low |
| 11 | Unrestricted Docker socket compromise | Host takeover | Socket only in private executor; no ingress; narrow API | Executor RCE / daemon 0-day (below) |
| 12 | Compromised executor | Full Docker control | No ingress, internal net, token auth, non-root, read-only fs, cap_drop ALL | High **if** achieved — primary residual risk |
| 13 | Access to unrelated container | Data exfil | Only configured/labeled targets resolvable; decoy denied even with internal token (verified) | Low |
| 14 | Host filesystem exposure | Host data exfil | No host mounts in gateway; executor mounts only the socket; verified no `/home`, `/mnt/c` | Low |
| 15 | Secret leakage in logs | Credential exposure | Redaction patterns; no key/token/body logging; verified logs clean | Command args may still contain secrets (redacted best-effort) |
| 16 | Excessive terminal output | Memory DoS | 256 KiB output cap, truncation flag | Low |
| 17 | Hanging processes | Resource exhaustion | Timeout + best-effort process-group kill | Orphaned in-target processes possible (below) |
| 18 | Resource exhaustion | DoS | Concurrency limits, mem/pids limits, rate limits, body caps | Low |
| 19 | Auth replay / brute force | Credential guessing | 256-bit keys, constant-time-ish compare, rate limit, PKCE for OAuth | No lockout counter (rate limit only) |
| 20 | Remote public ingress attack | Internet exposure | Loopback-only by default; ingress requires explicit user action (STOP condition) | Entirely dependent on how the operator exposes it |

## Residual risks (explicit)

- **Executor holds the Docker socket.** An RCE in the executor, or a Docker daemon/kernel 0-day,
  would be high impact. Mitigated by no ingress, internal-only network, argv-only API, non-root,
  read-only rootfs, `cap_drop: ALL`, `no-new-privileges`. This is inherent to the feature and cannot
  be fully eliminated.
- **Authorized principal power.** A valid key (or its OAuth token) can do anything its scopes allow
  inside its target workspaces — including `terminal_exec`. This is the intended capability.
- **Symlink TOCTOU.** Canonicalization happens immediately before the operation, but a sufficiently
  fast in-target attacker who already controls the workspace could in principle swap a symlink
  between check and use. Narrowed, not eliminated. An attacker with write access to the workspace
  already has that workspace.
- **Timeout kill is best-effort.** Docker has no exec-kill API; the executor kills the exec's
  process group, but a detached/backgrounded child may survive until the container stops.
- **Command-argument secrets.** Redaction is pattern-based; unusual secret formats in a
  `terminal_exec` command could still reach logs. Tune patterns in `src/shared/redact.ts`.

## Container hardening (as deployed)

Both services: `no-new-privileges`, `cap_drop: ALL`, `read_only` rootfs + tmpfs `/tmp`, mem/pids
limits, healthchecks, clean SIGTERM shutdown via tini. No `--privileged`, no host network, no broad
host mounts. Networks and volume are bridge-owned (`mcp-bridge-*`). The gateway remains non-root
(`uid=1000(node)`) and its persistent `/data` directory is owned by that user with mode `0700`;
OAuth state files are mode `0600`.
