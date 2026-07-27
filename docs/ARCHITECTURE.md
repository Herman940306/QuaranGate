# Architecture

## Two security domains

The system is split into two containers with different privilege levels connected by a private,
non-routable Docker network (`mcp-bridge-internal`, `internal: true`).

```
                     Plane A (client → bridge)          Plane B (bridge → docker)
┌───────────────┐   Streamable HTTP  ┌───────────────┐  shared token   ┌────────────────┐  docker.sock  ┌──────────────┐
│  MCP clients  │ ─────────────────▶ │    gateway     │ ──────────────▶ │   executor      │ ────────────▶ │ target        │
│ Claude/GPT/   │  Bearer key /      │ public-facing  │  internal net   │ private, no      │  Engine API   │ containers    │
│ VS Code/Kiro  │  OAuth token       │ NO docker.sock │                 │ published ports  │               │ (authorized)  │
└───────────────┘                    └───────────────┘                 └────────────────┘               └──────────────┘
       edge net (127.0.0.1:8787)            edge + internal                internal only
```

### gateway (public-facing)
- Hosts the MCP server (`@modelcontextprotocol/sdk` 1.30.0) over **Streamable HTTP** at `/mcp`.
- Authenticates every request (per-client API key via `Authorization: Bearer` or `X-API-Key`,
  or an OAuth 2.1 bearer token) → resolves a **principal**.
- Enforces **scopes** and **target authorization** before any tool runs.
- Rate-limits, audits (structured JSON, redacted), and delegates the actual work to the executor.
- Holds **no Docker socket** and mounts **no host directories** (only its read-only config and a
  small data volume for OAuth tokens).
- Runs stateless: a fresh MCP server instance per request, with the principal bound via
  `AsyncLocalStorage`, so two clients can never observe or influence each other's state.

### executor (private)
- The **only** component with `/var/run/docker.sock` (added via `group_add: DOCKER_GID`, non-root).
- Sits on the `internal` network with **no published ports** — unreachable from the host or LAN.
- Authenticated by a shared `INTERNAL_TOKEN`.
- Exposes a **narrow** HTTP API (`/targets`, `/fs/*`, `/exec/*`) that can only act on targets in
  its own config/discovery and only inside their canonicalized workspace. The API has no verb for
  "arbitrary Docker call", "create container", "mount host path", or "run on host".
- Re-enforces target allowlisting and workspace confinement **independently** of the gateway, so a
  compromised gateway still cannot escape.

## Request flow (e.g. `fs_write`)

1. Client → `POST /mcp` with Bearer key. Gateway authenticates → principal `vscode`.
2. Gateway checks `files:write` scope and that `vscode` may use target `demo`.
3. Gateway → executor `POST /fs/write {targetId, path, contentBase64}` with internal token.
4. Executor resolves `demo` → single running container by Compose project+service labels
   (fail closed on unknown/ambiguous/offline).
5. Executor canonicalizes the workspace and the target path in-container (`readlink -f`), rejects
   anything resolving outside the workspace (defeats symlink escape).
6. Executor writes via the Docker **archive (tar) API** — binary-safe, no shell quoting.
7. Structured audit entry emitted (principal, tool, target, decision, duration; secrets redacted).

## Tool contracts

| Tool | Class | Scope | Inputs | Side effects |
|---|---|---|---|---|
| `targets_list` | READ | `targets:read` | — | none |
| `target_inspect` | READ | `targets:read` | target | none |
| `fs_list` | READ | `files:read` | target, path, maxDepth? | none |
| `fs_stat` | READ | `files:read` | target, path | none |
| `fs_read` | READ | `files:read` | target, path | none |
| `fs_search` | READ | `files:read` | target, query, path?, maxResults? | none (fixed-string grep) |
| `fs_write` | WRITE | `files:write` | target, path, content | creates/overwrites a file |
| `fs_patch` | WRITE | `files:write` | target, path, oldText, newText | replaces a unique substring |
| `fs_delete` | DESTRUCTIVE | `files:delete` | target, path, recursive | deletes file/dir |
| `terminal_exec` | DESTRUCTIVE (hint) | `terminal:exec` | target, command, cwd?, timeoutMs? | runs `sh -c` in target |
| `git_status`/`git_diff`/`git_log` | READ | `git:read` | target | none (fixed argv) |
| `process_list` | READ | `process:read` | target | none |

Classes map to MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) so clients
can surface confirmation prompts for write/destructive actions. All 14 tools also advertise an
object `outputSchema`. Successful calls return the typed value in `structuredContent` and preserve
the same object as JSON text in `content` for backward compatibility. Live integration coverage
verifies schema discovery for all 14 tools and equality between `structuredContent` and the legacy
JSON representation on successful calls.

## Target model

- **Manual** (`config/bridge.yaml`): stable identity = `composeProject` + `composeService` (or a
  fixed `containerName`) + an absolute in-container `workspace`. Resolved to a live container id at
  request time (5 s cache). This survives `docker compose up --force-recreate` — verified.
- **Auto-discovery (opt-in)**: running containers labeled `mcp.bridge.enabled=true` with
  `mcp.bridge.workspace=<abs path>`. Discovery **identifies**; it never **authorizes**.
- **Fail closed:** unknown → `UNKNOWN_TARGET`; ≥2 running matches → `AMBIGUOUS_TARGET`; stopped →
  `TARGET_OFFLINE`; shell-less/distroless target → `TARGET_UNSUPPORTED`.

Minimum target assumptions: `/bin/sh` plus `readlink -f` or `realpath` (GNU coreutils or busybox
both qualify). `git` is needed only for the git tools.

## Filesystem confinement

`shared/pathcheck.ts` rejects absolute paths, drive letters, backslashes, null bytes and any `..`
traversal — in the gateway **and** the executor. The executor then canonicalizes the path (or its
nearest existing ancestor, for new files) inside the target and requires the result to remain under
the canonical workspace root, which defeats symlink and nested-symlink escapes. Content IO uses the
tar archive API and all other ops use argv-array `docker exec` (no shell), so there is no command
injection surface on paths.

## Terminal model

`terminal_exec` is the single deliberate shell entrypoint. The command runs as
`/bin/sh -lc <command>` inside the target with `WorkingDir` confined to the workspace, bounded by a
timeout (default 60 s, max 600 s), an output cap (256 KiB), and per-principal (4) / global (16)
concurrency limits. On timeout the executor makes a best-effort process-group kill (Docker exposes
no exec-kill API). There is no host shell: the gateway has no socket and no host mounts, and the
executor API has no "run on host" verb.
