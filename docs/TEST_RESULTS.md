# Test results

This document records **point-in-time verification evidence**. Each section states when it was
executed and what the baseline was at that moment. Older milestone counts are retained as
historical truth and are *not* the current baseline — read §"Current verified baseline" first.

## Current verified baseline

Executed at commit `67146a4` (`fix: harden gateway readiness and image provenance`).

| Suite | Result |
|---|---|
| Unit (`npm test`) | **1420 / 1420 passed**, 35 test files |
| TypeScript typecheck (`npm run typecheck`) | PASS |
| Integration, live stack (`npm run test:integration`) | Not re-run at this commit — requires an authorized Docker stack |

The unit suite needs no Docker. The integration suites (`tests/integration/`) require the live
stack plus generated client keys, and the A4/A5/A6 Docker suites additionally require the runner
images and provider credentials; they are run only under explicit runtime authorization.

Historical milestone counts recorded below (20/20 unit, 37/37 and 40/40 integration, 14-tool
surface, 1398/1398 unit at A6 closeout) were correct when recorded and are preserved as evidence.

---

## Historical milestone — initial bridge verification (2026-07-27)

Executed 2026-07-27 on WSL2 Ubuntu 24.04 (`Wolf`), Docker 29.6.2, Compose v5.3.1, Node 24.15.0,
`@modelcontextprotocol/sdk` 1.30.0, MCP Inspector CLI (latest). Protocol version negotiated:
**2025-11-25**. The MCP surface was 14 tools at this milestone; it is 23 today.

## Summary (2026-07-27 milestone)

| Suite | Result |
|---|---|
| Unit (`npm test`) | **20 / 20 passed** |
| Integration, live stack (`npm run test:integration`) | **37 / 37 passed** |
| MCP Inspector CLI protocol validation | tools/list (14 tools) + tools/call verified |
| Adversarial security checks | 12 / 12 as expected |

## Unit tests (`tests/unit`, 20 at the 2026-07-27 milestone)

- `pathcheck` (7): relative-path acceptance; `..` traversal rejected; absolute/drive-letter
  rejected; null-byte/backslash rejected; normalized traversal rejected; `joinWorkspace`;
  `isInside` containment (incl. `/workspace-evil` not inside `/workspace`).
- `auth` (7): stable hashing; valid key accepted; missing → `UNAUTHENTICATED`; invalid →
  `INVALID_CREDENTIAL`; disabled → `CLIENT_DISABLED`; independent client identities; scope/target
  checks.
- `redact` (4): bridge keys, bearer headers, key=value secrets redacted; ordinary text intact.
- `ratelimit` (2): blocks beyond limit; unlimited when unset.

## Integration tests (`tests/integration/bridge.test.ts`, 37, against the running stack)

Run via the official MCP SDK client over Streamable HTTP.

- **Authentication (5):** missing/malformed/invalid → 401; valid → 200; `X-API-Key` accepted.
- **OAuth 2.1 façade (3):** JSON Dynamic Client Registration works and rejects unsafe redirects;
  authorization requires exact registered redirect URIs and the MCP resource; Authorization Code +
  PKCE completes end-to-end and the resulting resource-bound token authenticates to `/mcp`.
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


## OAuth hardening verification (post-build)

After the original local-verification baseline, the OAuth façade was hardened and re-tested on the
same local Docker stack:

- `npm run typecheck` — **PASS**.
- Unit tests — **20 / 20 passed**.
- Live integration tests — **37 / 37 passed** (the original 34 tests remained green plus 3 OAuth
  regression tests).
- Independent adversarial OAuth probe — **PASS**: unsafe redirect rejection, exact redirect binding,
  mandatory RFC 8707 resource binding, PKCE failure rejection, single-use authorization codes,
  resource-bound access-token use, refresh-client/resource binding, refresh rotation, and replay
  rejection.
- Gateway runtime — non-root `uid=1000(node)`; `/data` mode `0700`, owned by `node`; OAuth state files
  mode `0600`; no matching `EACCES`, unhandled, fatal, or generic runtime errors after verification.

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

## Claude browser external verification

Completed 2026-07-27 against the real Claude web client through the approved Tailscale Funnel:

- Public endpoint: `https://wolf.taildc680e.ts.net/mcp`.
- Public `healthz` / `readyz`: **PASS** repeatedly.
- OAuth Protected Resource + Authorization Server metadata: **PASS**.
- Anonymous public MCP initialize: **401 fail-closed PASS**.
- Dynamic Client Registration + browser Authorization Code / PKCE flow: **PASS**.
- Browser CSP redirect compatibility: **PASS** with `form-action` restricted to `self` plus the
  validated redirect origin.
- Principal identity: all host config, running gateway config, OAuth token state, and audit logs
  agreed on `claude-browser`.
- Real Claude tool calls against authorized target `demo`: `targets_list`, `fs_read`, `git_status`,
  `terminal_exec`, `fs_write`, read-back, and `fs_delete` — **PASS**.
- Controlled write artifact `gen/claude-browser-e2e.txt` was deleted and independently confirmed
  absent afterward.
- Gateway audit records attributed each operation to `claude-browser` with `decision=allow`.
- Post-Claude regression at that milestone: typecheck **PASS**, unit **20/20**, live integration
  **37/37**. The later structured-output upgrade increased the integration baseline to **40/40**.
- Security invariants after exposure: gateway still loopback-bound, gateway Docker socket absent,
  executor published ports `{}`.

**Claude browser status: EXTERNALLY VERIFIED.**

## ChatGPT browser external verification

Completed 2026-07-28 against the real ChatGPT web plugin/developer-mode client through the same
approved Tailscale Funnel:

- Public endpoint: `https://wolf.taildc680e.ts.net/mcp`.
- OAuth discovery, Dynamic Client Registration, browser authorization, and token exchange: **PASS**.
- ChatGPT imported the MCP action surface and displayed tool annotations and schemas.
- Structured-output upgrade: all **14/14** tools advertise an object `outputSchema`; successful tool
  calls return `structuredContent` while preserving legacy JSON text. The ChatGPT
  `OUTPUT SCHEMA RECOMMENDED` warning disappeared after refreshing actions.
- Real ChatGPT calls against authorized target `demo`: `targets_list`, `fs_read`, `git_status`,
  `terminal_exec`, `fs_write`, and read-back — **PASS**.
- Gateway audit records attributed successful calls to principal `chatgpt-browser`.
- `fs_delete` was discovered as WRITE / DESTRUCTIVE, but the real ChatGPT client blocked the
  invocation before it reached the gateway. The bridge's delete behavior remains independently
  covered by the live integration suite. No attempt was made to bypass that client-side safety check.
- The known ChatGPT test artifact was removed out-of-band only after verifying its exact marker
  content, then confirmed absent.
- Final post-ChatGPT regression: typecheck **PASS**, unit **20/20**, live integration **40/40**.
- Security invariants after both browser validations: public health/readiness **PASS**, gateway
  Docker socket absent, executor published ports `{}`.

**ChatGPT browser status: EXTERNALLY VERIFIED WITH CLIENT-SIDE PERMANENT-DELETE RESTRICTION.**

## Current external-client status

- **Claude browser:** externally verified for discovery, read, Git, terminal, write/read-back, and
  permanent delete against the disposable `demo` target.
- **ChatGPT browser:** externally verified for discovery, read, Git, terminal, and write/read-back;
  permanent delete is server-verified but was blocked by the tested ChatGPT client before invocation.
- Product UI, entitlement, and safety behavior are time-sensitive and should be revalidated before a
  different production deployment.
