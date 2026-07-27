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
