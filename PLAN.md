# mcp-ide-bridge — Implementation Plan

Status: EXECUTED. This plan was written after validation (Phases 0–3) and before production code.
Date: 2026-07-27. Environment: WSL2 Ubuntu 24.04 (`Wolf`), Docker 29.6.2, Compose v5.3.1, Node 24.15.0.

## 1. Purpose

A standalone Docker Compose deployment that exposes a remote MCP (Model Context Protocol)
server letting approved MCP clients (Claude browser, ChatGPT browser, VS Code, Kiro) perform
IDE-style automation (files, terminal, git, processes) **inside explicitly authorized Docker
target containers only**. It never grants host access and never modifies existing project stacks.

## 2. Validated compatibility facts (drive the design)

| Fact | Source | Checked |
|---|---|---|
| Current stable MCP spec revision: **2025-11-25**; Streamable HTTP is the remote transport; HTTP+SSE deprecated | modelcontextprotocol.io spec / blog.modelcontextprotocol.io | 2026-07-27 |
| Official TS SDK `@modelcontextprotocol/sdk` latest = **1.30.0** | npm registry | 2026-07-27 |
| Claude custom connectors connect **from Anthropic's cloud** → public HTTPS required for browser use; auth = OAuth 2.1 (DCR supported) or beta static request headers; Pro/Max/Team/Enterprise | support.claude.com articles 11175166, 11503834 | 2026-07-27 |
| ChatGPT Developer-Mode connectors: public HTTPS; **OAuth** (or no-auth, rejected); Plus/Pro/Business+ | developers.openai.com/api/docs/mcp, help.openai.com article 12584461 | 2026-07-27 |
| VS Code: `.vscode/mcp.json` / user `mcp.json`, `"type":"http"`, `url`, headers + `inputs` for secrets | code.visualstudio.com/docs/copilot/customization/mcp-servers | 2026-07-27 |
| Kiro: `~/.kiro/settings/mcp.json` or workspace `.kiro/settings/mcp.json`, remote `url` + `headers`, streamable-http | kiro.dev/docs/mcp/configuration | 2026-07-27 |

Full citations: `docs/COMPATIBILITY.md`.

## 3. Architecture (Option B — split security domains)

```
MCP clients (Claude / ChatGPT / VS Code / Kiro)
        │  Streamable HTTP  (+ Bearer key or OAuth token)
        ▼
┌────────────────────────────────────────────┐  container: bridge-gateway
│ GATEWAY  (public-facing, NO docker.sock)   │  networks: edge (127.0.0.1:8787 publish)
│  MCP server (official SDK, /mcp)           │            bridge-internal
│  Auth: per-client API keys (sha256 at rest)│  read-only rootfs, non-root, cap_drop ALL
│  OAuth 2.1 façade (PKCE+DCR) → same keys   │
│  Scopes, rate limits, audit log            │
└───────────────┬────────────────────────────┘
                │ private HTTP + shared internal token
                ▼            (network: bridge-internal, internal: true)
┌────────────────────────────────────────────┐  container: bridge-executor
│ EXECUTOR (private, holds /var/run/docker.sock, never published)
│  Narrow API: resolve/list targets, exec argv, exec shell,
│  archive read/write. Independently re-enforces:
│  target allowlist, workspace confinement, timeouts, output caps.
└───────────────┬────────────────────────────┘
                ▼ Docker Engine API (unix socket)
        authorized target containers only
```

Privilege boundary rationale: only the executor mounts the socket; it is on an
`internal: true` network with no published ports. Its API cannot express "arbitrary Docker
call" — it can only act on targets present in its own config/discovery and only within their
canonicalized workspace. A compromised gateway therefore cannot create containers, mount host
paths, or touch unconfigured containers.

## 4. Repository tree

```
mcp-ide-bridge/
├── README.md  PLAN.md  compose.yaml  Dockerfile  .gitignore  .dockerignore  .env.example
├── package.json  tsconfig.json  vitest.config.ts
├── src/
│   ├── shared/       types.ts errors.ts pathcheck.ts redact.ts
│   ├── executor/     index.ts docker.ts targets.ts execops.ts fsops.ts
│   └── gateway/      index.ts mcp.ts executorClient.ts audit.ts ratelimit.ts config.ts
│                     auth/apikeys.ts auth/oauth.ts tools/*.ts (via mcp.ts registry)
├── config/           bridge.example.yaml  clients.example.yaml   (live: bridge.yaml/clients.yaml, gitignored)
├── scripts/          gen-client-key.mjs revoke-client.mjs validate-config.mjs mcp-check.sh
├── tests/            unit/*.test.ts  integration/*.test.ts  integration/run.sh
├── test-target/      compose.yaml Dockerfile      (disposable bridge-owned test target + decoy)
└── docs/             ARCHITECTURE.md SECURITY.md COMPATIBILITY.md CLIENT_SETUP.md
                      TARGETS.md OPERATIONS.md TEST_RESULTS.md
```

## 5. Technology choices

| Dependency | Version | Purpose | Why |
|---|---|---|---|
| @modelcontextprotocol/sdk | 1.30.0 (pinned) | MCP server + Streamable HTTP transport | Official SDK, current |
| express | ^5 | HTTP host for SDK transport + OAuth endpoints | SDK's documented integration |
| zod | ^3.25 | Tool input schemas | SDK peer mechanism |
| undici | ^7 | HTTP client for Docker unix socket + gateway→executor | Supports `socketPath`; std-lib fetch does not |
| tar-stream | ^3 | Build/parse tars for Docker archive API | Binary-safe file IO without target shell quoting |
| yaml | ^2 | Config parsing | Minimal, standard |
| typescript / vitest / tsx | dev only | build & tests | — |

No database, no Redis, no framework beyond the above. Node 24 (matches host; container uses node:24-alpine).

## 6. Security model

- **Principals** (`config/clients.yaml`): `id`, `name`, `keyHash` (sha256 of API key), `scopes[]`,
  `targets[]` (explicit ids; `"*"` = all *configured* targets, never all containers), `enabled`,
  optional `rateLimit` (req/min). One principal per client (claude-browser, chatgpt-browser, vscode, kiro).
- **Keys**: `mcpb_<client>_<32B base64url>`; only hashes at rest; generation/revocation/rotation via scripts;
  redacted from logs. Repo holds placeholders only.
- **Scopes**: `targets:read files:read files:write files:delete terminal:exec git:read process:read`.
- **OAuth façade** (for Claude/ChatGPT browser): same-origin AS. Endpoints:
  `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
  `/oauth/register` (DCR, public clients, PKCE required), `/oauth/authorize` (minimal HTML form where the
  user pastes their client API key = the login), `/oauth/token` (code+PKCE S256 → opaque bearer, 1h TTL;
  rotating refresh token 30d). Tokens map to the same principal as the key; stored hashed in `/data` volume.
  Not a dashboard; it is the smallest compatible auth façade.
- **Gateway→executor**: shared random token from `.env` (`INTERNAL_TOKEN`), network `internal: true`.
- **Fail closed** everywhere: unknown/ambiguous target, unknown scope, bad path ⇒ typed error, denied.

## 7. MCP tool surface (13 tools)

| Tool | Class | Scope | Notes |
|---|---|---|---|
| targets_list | READ | targets:read | only targets the principal may access |
| target_inspect | READ | targets:read | status, workspace, image; no env dump |
| fs_list / fs_stat / fs_read / fs_search | READ | files:read | workspace-relative paths only |
| fs_write | WRITE | files:write | create/overwrite via archive API |
| fs_patch | WRITE | files:write | exact oldText→newText replacement, deterministic errors |
| fs_delete | DESTRUCTIVE | files:delete | file or recursive dir; annotated destructive |
| terminal_exec | WRITE (declared destructiveHint) | terminal:exec | `sh -c` in target, cwd confined, timeout ≤600s, output cap |
| git_status / git_diff / git_log | READ | git:read | fixed argv wrappers |
| process_list | READ | process:read | `ps` in target |

Git writes happen via `terminal_exec` (terminal:exec scope) — no separate write wrappers needed.
Long-running/background process management is explicitly out of scope v1 (documented); every exec is
bounded by timeout with best-effort process-group cleanup.

## 8. Target model

- **Manual targets** (`config/bridge.yaml`): `id`, `composeProject`, `composeService`, `workspace`
  (absolute path *inside the container*). Stable identity = Compose project+service labels, resolved to a
  live container id at request time (5s cache). ≥2 running matches ⇒ `AMBIGUOUS_TARGET` (denied).
- **Auto-discovery (opt-in)**: running containers labeled `mcp.bridge.enabled=true`;
  workspace from `mcp.bridge.workspace` (required), display name from `mcp.bridge.name` or compose ids.
  Discovery ≠ authorization: a discovered target is still only usable by principals listing its id.
- Stopped target ⇒ `TARGET_OFFLINE`. Unconfigured/unlabeled containers are invisible and unreachable.
- Minimum target assumptions: `/bin/sh` + POSIX utils (`ls`,`stat`? no — see fsops) — precisely:
  `/bin/sh`, `readlink -f`/`realpath` (GNU coreutils or busybox both qualify). `git` only needed for git tools.
  Shell-less (distroless/scratch) targets are unsupported v1 and fail with a clear error.

## 9. Filesystem & confinement model

1. Path inputs are workspace-relative; reject absolute paths, `..` segments (after POSIX normalization),
   null bytes, and empty traversal tricks — checked in gateway *and* executor (`shared/pathcheck.ts`).
2. Workspace root is canonicalized in-target once per resolution (`readlink -f`).
3. Before each op the executor canonicalizes the deepest existing ancestor of the requested path in-target
   and requires it to remain under the canonical workspace ⇒ defeats symlink and nested-symlink escape.
4. Content IO uses Docker archive API (tar) — binary-safe, no shell quoting.
5. All non-terminal ops use argv-array `docker exec` (no shell) ⇒ no command injection surface.
6. `fs_search` = `grep -rn` argv with result cap; `fs_list` = `find -maxdepth` argv.

## 10. Terminal model

`terminal_exec(target, command, cwd?, timeoutMs?)`:
authenticated principal → scope check → target check → cwd canonicalized under workspace →
`docker exec` `["/bin/sh","-lc", command]` with WorkingDir=cwd → stream stdout/stderr demuxed,
truncated at `maxOutputBytes` (default 256 KiB) → deadline (default 60s, max 600s) → on timeout,
best-effort `kill -9` of the exec PID's process group + structured `COMMAND_TIMEOUT`.
Concurrency: per-principal (default 4) and global (default 16) semaphores. Host shell: does not exist —
gateway container has no docker socket and no host mounts; executor API has no "run on host" verb.

## 11. Ingress plan

Local first: gateway published on `127.0.0.1:8787` only. Remote-ingress-ready: `docs/OPERATIONS.md`
documents an inactive `ingress` path (Cloudflare Tunnel / Caddy / Tailscale templates) — **not enabled**;
enabling requires user approval (STOP condition). Browser clients therefore end at
`SERVER READY — EXTERNAL/BROWSER VALIDATION REQUIRES USER ACTION`.

## 12. Container hardening

Gateway: non-root (node), `read_only: true`, tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`,
mem/cpu limits, healthcheck `/healthz`, only mounts: config ro + `bridge-data` volume for token store.
Executor: non-root + `group_add: ${DOCKER_GID}`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`,
no published ports, mounts: docker.sock + config ro. Bridge-owned networks: `bridge-edge`, `bridge-internal (internal: true)`.

## 13. Testing strategy

- Unit (vitest): pathcheck (traversal/absolute/encoded), patch engine, key hashing/verification, config
  validation, redaction, rate limiter.
- Integration (vitest against live stack): spin `test-target/compose.yaml` (alpine+git target with label
  opt-in, plus unlabeled decoy container, plus sibling dir outside workspace); full auth matrix
  (missing/malformed/invalid/revoked/valid keys, per-client isolation), authorization matrix, discovery,
  fs CRUD+patch+search, traversal/symlink/absolute escape attempts, terminal success/failure/timeout/
  output-cap/cwd-escape/concurrency, git status/diff/log, protocol (initialize, tools/list, tools/call,
  malformed), isolation proofs (decoy denied, /etc unreachable, host fs unreachable).
- Protocol validation: MCP Inspector CLI against the running gateway.
- Adversarial pass (Phase 12) per threat list; results in `docs/TEST_RESULTS.md`.

## 14. Delivery stages & checkpoints

1. Scaffold + deps install → `tsc` clean. ✅ gate: build passes
2. Shared modules + unit tests → ✅ gate: unit green
3. Executor (docker client, targets, fsops, execops) → ✅ gate: manual smoke vs test target
4. Gateway (auth, MCP tools, audit, rate limit, OAuth façade) → ✅ gate: tsc + unit green
5. Dockerfile + compose + test-target stack → ✅ gate: `docker compose up` healthy
6. Integration suite → ✅ gate: all green
7. Inspector protocol validation → ✅ gate: initialize/tools/list/tools/call recorded
8. Adversarial security pass → ✅ gate: no actionable failure remains
9. Docs + final acceptance audit

## 15. Residual risks (summary — full list in docs/SECURITY.md)

- Executor holds the Docker socket: kernel/daemon 0-days or an executor RCE would be high impact.
  Mitigated by no ingress, internal network, argv-only API, non-root, read-only fs.
- A compromised gateway (or stolen key) can do anything the mapped principal can inside configured
  workspaces — inherent to the feature; mitigated by scopes, per-client keys, audit, rate limits.
- Timeout kill of in-target processes is best-effort (Docker exec has no kill API).
- TOCTOU between symlink canonicalization and operation is narrowed, not eliminated (documented).
- Commands passed to `terminal_exec` may contain secrets; audit redaction patterns applied, configurable.
