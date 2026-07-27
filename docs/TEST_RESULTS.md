# Test results

Executed 2026-07-27 on WSL2 Ubuntu 24.04 (`Wolf`), Docker 29.6.2, Compose v5.3.1, Node 24.15.0,
`@modelcontextprotocol/sdk` 1.30.0, MCP Inspector CLI (latest). Protocol version negotiated:
**2025-11-25**.

## Summary

| Suite | Result |
|---|---|
| Unit (`npm test`) | **20 / 20 passed** |
| Integration, live stack (`npm run test:integration`) | **34 / 34 passed** |
| MCP Inspector CLI protocol validation | tools/list (14 tools) + tools/call verified |
| Adversarial security checks | 12 / 12 as expected |

## Unit tests (`tests/unit`, 20)

- `pathcheck` (7): relative-path acceptance; `..` traversal rejected; absolute/drive-letter
  rejected; null-byte/backslash rejected; normalized traversal rejected; `joinWorkspace`;
  `isInside` containment (incl. `/workspace-evil` not inside `/workspace`).
- `auth` (7): stable hashing; valid key accepted; missing → `UNAUTHENTICATED`; invalid →
  `INVALID_CREDENTIAL`; disabled → `CLIENT_DISABLED`; independent client identities; scope/target
  checks.
- `redact` (4): bridge keys, bearer headers, key=value secrets redacted; ordinary text intact.
- `ratelimit` (2): blocks beyond limit; unlimited when unset.

## Integration tests (`tests/integration/bridge.test.ts`, 34, against the running stack)

Run via the official MCP SDK client over Streamable HTTP.

- **Authentication (5):** missing/malformed/invalid → 401; valid → 200; `X-API-Key` accepted.
- **Protocol (4):** all 14 tools listed; unknown tool → error result; malformed args (missing
  `target`) → error result.
- **Targets/discovery (3):** manual `demo` listed; unlabeled `decoy` **not** listed; unknown target
  denied.
- **Authorization (3):** client with `targets: []` → `FORBIDDEN_TARGET`; read-only client write →
  `FORBIDDEN_SCOPE`; read-only client read succeeds.
- **Filesystem (7):** list/stat/read; write+read-back; patch unique; patch non-unique →
  `PATCH_FAILED`; search; delete.
- **Path confinement / isolation (5):** `../../etc/passwd` → `PATH_VIOLATION`; `/etc/passwd` →
  `PATH_VIOLATION`; symlink-to-file (`escape-passwd`→`/etc/passwd`) → `PATH_VIOLATION`;
  symlink-to-dir (`escape-dir`→`/secretzone`) → `PATH_VIOLATION`; secret outside workspace not
  found by search.
- **Terminal (6):** command runs in workspace; non-zero exit reported; **timeout enforced**
  (`sleep 30`, `timeoutMs=1500` → `timedOut:true` in ~1.7 s); output bounded (`truncated:true`);
  cwd escape (`cwd:"../.."`) → `PATH_VIOLATION`; runs in target (hostname ≠ host `Wolf`).
- **Git/processes (3):** `git_status`, `git_log` (shows `initial`), `process_list` (shows `sleep`).

### Notable fix during testing

A single undici `Client` (one connection) let a long-running `exec/start` stream block the
timeout-kill call behind it, so `terminal_exec` timeouts hung ~30 s. Switched the executor's Docker
client to an undici `Pool` (16 connections). Timeout now fires correctly (~1.7 s). Re-verified.

## MCP Inspector CLI (official protocol validation)

```
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp \
  --transport http --header "Authorization: Bearer <key>" --method tools/list
# → 14 tools: targets_list, target_inspect, fs_list, fs_stat, fs_read, fs_search,
#   fs_write, fs_patch, fs_delete, terminal_exec, git_status, git_diff, git_log, process_list

npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp \
  --transport http --header "Authorization: Bearer <key>" \
  --method tools/call --tool-name targets_list
# → {"targets":[{"id":"demo","source":"manual","running":true,"workspace":"/workspace",...}]}
```

## Adversarial security checks (Phase 12)

| # | Check | Result |
|---|---|---|
| 1 | Gateway container holds the Docker socket? | **No** — `/var/run/docker.sock` absent in gateway |
| 2 | Gateway reaches executor over internal net? | Yes (expected) — `/healthz` ok |
| 3 | Executor publishes any ports? | **No** — `Ports: {}` |
| 4 | Gateway runs as root? | **No** — `uid=1000(node)` |
| 5 | Gateway rootfs writable? | **No** — read-only confirmed |
| 6 | Executor reachable from host `:8990`? | **No** — connection refused/empty |
| 7 | Internal network egress-isolated? | Yes — `Internal: true` |
| 8 | Executor call without internal token? | **Rejected** — `UNAUTHENTICATED` |
| 9 | WSL home / Windows mounts visible in containers? | **No** — `/home/herman`, `/mnt/c` absent |
| 10 | Decoy container targetable even **with** internal token? | **No** — `UNKNOWN_TARGET` |
| 11 | Secrets (2 API keys + internal token) present in logs? | **No** — logs clean |
| 12 | Compose `--force-recreate` bypasses authz/confinement? | **No** — resolved by stable identity (new container id), traversal still `PATH_VIOLATION` |

## Reproduce

```bash
docker compose -f test-target/compose.yaml up -d --build
docker compose up -d --build
npm test
KEYS_ENV=<keys.env> npm run test:integration
API_KEY=<key> ./scripts/mcp-check.sh
```

## Not tested here (require external/user action)

- Live Claude browser connection and live ChatGPT browser connection — both need a public HTTPS URL
  and in-product OAuth/connector UI steps. Server-side OAuth 2.1 façade is implemented and the local
  endpoint is verified, but the browser round-trip itself was not exercised. See `docs/CLIENT_SETUP.md`.
