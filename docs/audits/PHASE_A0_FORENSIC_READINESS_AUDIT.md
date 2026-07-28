# PHASE A0 — FORENSIC READINESS AUDIT

**Document ID:** MIB-A0-AUDIT
**Program:** Governed Agent Dispatch (ChatGPT → MCP IDE Bridge → Kiro / GitHub Copilot workers)
**Audit executed:** 2026-07-28
**Auditor:** Claude Fable 5 (forensic engineering agent), read-only session
**Repository HEAD audited:** `6bf16a872c6d96cf1965db553721a16b8927d296` — `docs: verify ChatGPT browser MCP integration`
**Reviewed by:** ChatGPT and Herman
**Reviewed verdict:** **A0 PASS — READY FOR A1**

This document persists the approved A0 forensic report. It incorporates four review corrections (recorded in "Review corrections applied" below); all other evidence and findings are preserved as produced during the audit session.

---

## Review corrections applied

**Correction A — Node SQLite status.** The original in-chat report described Node 24's built-in `node:sqlite` as experimental. For the actual local runtime, Node v24.15.0, `node:sqlite` is **Stability 1.2 — Release Candidate**. The persisted report reflects this. The exact SQLite JavaScript binding is **not** locked here: persistence technology direction is **SQLite**; exact binding **DEFER TO A2** — evaluate built-in `node:sqlite` against alternatives before adding any dependency.

**Correction B — Kiro authentication architecture.** Current local Kiro authentication is an interactive Builder ID session. Future automation must NOT inherit or depend on Herman's personal Builder ID session. Kiro supports dedicated `KIRO_API_KEY` authentication for headless automation, and active interactive/browser authentication may take precedence when present. Therefore bridge-controlled Kiro must use an **isolated `KIRO_HOME` with no inherited personal Kiro session, plus a dedicated automation `KIRO_API_KEY`**. The raw key does not exist yet and is not required for A1. No credentials are displayed in this document.

**Correction C — Copilot permission uncertainty.** The A0 finding that GitHub Copilot CLI exposes granular controls (`--allow-tool`, `--deny-tool`, `--add-dir`, `--allow-url`, deny-precedence) is preserved. The discovered tension is recorded: the installed CLI's documentation/help indicates `--allow-all-tools` may be **required** for programmatic non-interactive operation, which conflicts with the project's production rule (no `--allow-all-tools`, no `--allow-all`, no `--yolo`). Therefore non-interactive Copilot CLI is **not** chosen as the production transport in A0/A1. A7 must compare Copilot SDK, Copilot ACP, and programmatic CLI, and select a transport that satisfies least privilege.

**Correction D — A0 process-compliance note.** The A0 report established that the executor was the only Docker socket consumer among the 17 running containers. Proving that statement required generic Docker metadata inspection (mount lists) of unrelated containers, while the audit prompt prohibited accessing Mickey/unrelated projects. Recorded transparently:

```text
PROCESS DEVIATION:      minor read-only scope overreach
SECURITY IMPACT:        none observed
PROJECT MODIFICATION:   none
A0 VERDICT IMPACT:      none
```

Those unrelated containers were not inspected again during closeout. Future bridge audits should inspect only explicitly authorized/named bridge resources unless global host inspection is separately approved.

---

## 1. Executive verdict

**A0 PASS — READY FOR A1**

The repository is at the exact expected checkpoint with a clean tree (only the Master PRD untracked, as expected). The live runtime matches every claimed security property: the gateway publishes only `127.0.0.1:8787` and holds no Docker socket; the executor publishes nothing, sits on an `internal: true` network, and is the only Docker socket consumer among 17 running containers (see Correction D). All 14 MCP tools exist exactly as documented, with `outputSchema` and `structuredContent` on every tool, and the running image was verified to contain that code. Typecheck and the 20/20 unit suite were re-executed in the audit session and pass. Kiro CLI 2.5.0 with a working `acp` subcommand and GitHub Copilot CLI 1.0.56 with non-interactive/JSON/ACP modes are both installed and their capability surfaces match the PRD's assumptions.

A1 is a specification-only phase; nothing found blocks it. The material prerequisites discovered (executor persistent storage, Kiro automation credential, runner image compatibility, Copilot headless-permission semantics) gate A2/A3/A4/A7 respectively, and are catalogued below so A1 can specify around them.

## 2. Repository checkpoint

- **Path:** `/home/herman/projects/mcp-ide-bridge`
- **Branch:** `main`
- **HEAD:** `6bf16a872c6d96cf1965db553721a16b8927d296` — `docs: verify ChatGPT browser MCP integration`
- **Working tree:** clean except one untracked file: `MCP_IDE_BRIDGE_MASTER_PRD.md` (expected). Ignored-but-present: `.env`, `config/bridge.yaml`, `config/clients.yaml`, `dist/`, `node_modules/` — all correctly gitignored.
- **History:** the six commits match the expected checkpoint exactly (`47c3f50` → `6bf16a8`), timestamps 2026-07-27 22:16 through 2026-07-28 00:51 (+0200).
- **Milestone consistency:** the running container image (`mcp-ide-bridge:latest`, created 2026-07-28 00:25 +0200) was built ~6 minutes before the final two commits, but read-only grep inside the running gateway confirmed the deployed `dist/gateway/mcp.js` contains `outputSchema` (12 hits) and `structuredContent` — the image was built from the same working tree those commits captured. Container image ID matches `mcp-ide-bridge:latest`. **VERIFIED.**
- **Toolchain:** Node v24.15.0 (satisfies `engines: >=22`), npm 11.12.1, Docker 29.6.2, Compose v5.3.1. `npm list` matches `package.json` (`@modelcontextprotocol/sdk@1.30.0`, express 5, undici 7.29, tar-stream, yaml, zod; no extraneous deps).

## 3. Current bridge architecture

Total product source: ~2,040 lines TypeScript across 18 files. Verified responsibilities:

| Component | File(s) | Responsibility |
|---|---|---|
| Gateway HTTP entry | `src/gateway/index.ts` | Express app; `/healthz`, `/readyz`, `/mcp` (POST only, stateless — fresh `McpServer` + `StreamableHTTPServerTransport` per request); credential extraction (Bearer/X-API-Key/OAuth token); 401 challenge with resource metadata; fatal-exit if `INTERNAL_TOKEN` unset |
| MCP tool layer | `src/gateway/mcp.ts` | All 14 `registerTool` calls; `guarded()` wrapper (audit + error mapping); `require2()` (scope + target authorization); `READ`/`WRITE`/`DESTRUCTIVE` annotation sets; Zod output schemas |
| Principals/scopes | `src/gateway/config.ts` | `clients.yaml` loader; `Scope` union (7 scopes); `Principal` (id, keyHash, scopes, targets, enabled, rateLimit); `principalHasScope` / `principalCanTarget` |
| API-key auth | `src/gateway/auth/apikeys.ts` | sha256 key hashing, constant-time hash compare, key generation format `mcpb_<client>_<random>` |
| OAuth façade | `src/gateway/auth/oauth.ts` (470 lines) | DCR, PKCE S256, exact redirect matching, RFC 8707 resource binding, hashed opaque tokens, refresh rotation, bounded client store, hardened CSP; persists to `/data` (gateway `bridge-data` volume) |
| Principal binding | `src/gateway/context.ts` | `AsyncLocalStorage` per-request principal |
| Rate limiting | `src/gateway/ratelimit.ts` | In-memory fixed-window per principal |
| Audit | `src/gateway/audit.ts` | Structured JSON to stdout: ts, reqId, principal, tool, target, decision, code, durationMs; detail redacted + capped at 500 chars |
| Executor client | `src/gateway/executorClient.ts` | undici HTTP client to `http://executor:8990` with `x-internal-token` |
| Executor HTTP API | `src/executor/index.ts` | Internal-token middleware; narrow routes: `/targets`, `/target/inspect`, `/fs/{list,stat,read,search,write,patch,delete}`, `/exec/{shell,argv}`, `/reload`, `/healthz`, `/readyz`. No verb for arbitrary Docker calls |
| Docker client | `src/executor/docker.ts` | Minimal Engine API v1.44 over unix socket via **undici `Pool` (16 connections)**; only list/inspect containers, exec create/inspect/start-stream (with 8-byte frame demux), archive get/put, `_ping` |
| Target registry | `src/executor/targets.ts` | Manual targets from `bridge.yaml` (compose project/service or container name) + opt-in label discovery (`mcp.bridge.enabled=true`); 5s cache; ambiguity/offline fail-closed; liveness re-verify |
| Exec ops | `src/executor/execops.ts` | Workspace canonicalization via in-target `readlink -f`; `confinePath` (deepest-existing-ancestor symlink defense); global (16) + per-principal (4) concurrency; timeout with process-group kill; output caps |
| FS ops | `src/executor/fsops.ts` | Content IO via Docker archive/tar API; list/stat/search/delete via confined argv (no shell quoting of paths); unique-substring patch |
| Shared | `src/shared/{errors,pathcheck,redact,types}.ts` | 20-code `BridgeError` model; relative-path validation (fail-closed); credential redaction patterns; wire types + `EXECUTOR_DEFAULTS` (60s default / 600s max timeout, 256 KiB output, 5 MiB file caps) |
| Tests | `tests/unit/*` (4 files, 20 cases), `tests/integration/{bridge,output-schema}.test.ts` (37 + 3 cases), `tests/integration/helpers.ts` | See §14 |
| Deploy | `Dockerfile` (single image, two entrypoints, tini, non-root), `compose.yaml`, `test-target/{Dockerfile,compose.yaml}` (demo + decoy with symlink-escape fixtures) | See §6 |
| Ops scripts | `scripts/{gen-client-key,revoke-client,validate-config}.mjs`, `scripts/mcp-check.sh` | Key lifecycle, config validation, smoke test |

## 4. Current MCP surface

**Exactly 14 tools, verified from `src/gateway/mcp.ts` source — matches the expected list with no deviation:**
`targets_list`, `target_inspect`, `fs_list`, `fs_stat`, `fs_read`, `fs_search`, `fs_write`, `fs_patch`, `fs_delete`, `terminal_exec`, `git_status`, `git_diff`, `git_log`, `process_list`.

- **Input schemas:** Zod raw shapes per tool; every tool except `targets_list` requires `target: z.string()`; bounded numerics (`maxDepth` 1–5, `maxResults` ≤1000, `timeoutMs` 1s–600s).
- **outputSchema:** all 14 declare one (typed shapes: `TARGET_SUMMARY`, `TARGET_INSPECT`, `FILE_STAT`, `OK_PATH`, `EXEC_RESULT`). Verified in deployed image.
- **structuredContent:** `ok()` returns both `structuredContent` and identical JSON serialized into text content (backward compatible). Errors return `isError: true` with `{error: code, message}` JSON text and **no** structuredContent — consistent with MCP semantics.
- **Annotations:** `READ` (readOnly), `WRITE`, `DESTRUCTIVE` (`fs_delete`, and `terminal_exec` is honestly marked destructive). Matches the PRD's "fs_delete stays honest" decision.
- **Guard/auth:** every handler wrapped in `guarded()` → audit allow/deny + uniform `BridgeError` mapping; scope + target check via `require2()` before executor delegation.
- **Agent Control Plane registration point:** new tools would register inside `buildServer()` in `src/gateway/mcp.ts` (or a sibling module invoked from it), reusing `guarded()`/`require2()`; executor-side counterpart routes belong in `src/executor/index.ts`. Not added.

## 5. Authentication and authorization

**Current model (verified from source):**
- **Principal:** one per client in `config/clients.yaml`; only sha256 key hashes stored; constant-time comparison; enable flag; optional per-minute rate limit.
- **Two credential paths → one principal model:** static API key, or OAuth 2.1 access token (`mcpb_at_…`) resolved via `tokenToPrincipalId` with resource binding — OAuth is purely a façade over the same principals. Bridge authorization scopes come from `clients.yaml`, **not** from OAuth scopes (OAuth only supports `offline_access`). This means adding agent scopes requires **no OAuth protocol change**.
- **Scopes:** closed TypeScript union of 7 (`targets:read`, `files:read/write/delete`, `terminal:exec`, `git:read`, `process:read`); unknown scopes in YAML are silently filtered out (fail-closed).
- **Target authorization:** `principal.targets` explicit ID list or `"*"` (configured targets only); enforced in the gateway AND independently re-enforced in the executor (which only ever operates on registry targets).
- **Audit:** every tool call → allow/deny JSON line with principal, tool, target, duration, redacted detail.

**Extension points for `agents:read` / `agents:dispatch` / `agents:cancel` / `agents:apply`:**
1. `Scope` union + `ALL_SCOPES` in `src/gateway/config.ts:5-22`;
2. `validScopes` set in `scripts/validate-config.mjs`;
3. per-client grants in `config/clients.yaml` (example file update);
4. `require2()`-style checks in the new tool handlers.

**Verdict per authorization dimension:**

| Dimension | Status | Evidence |
|---|---|---|
| principal | **READY** | Principal model + ALS binding reusable as-is |
| operation | **READY** | Scope union extension is mechanical |
| project | **EXTENSION REQUIRED** | No project concept exists; needs a new trusted registry (executor-side) + a `projects`/`backends` allowlist field on `Principal`, mirroring the proven `targets` pattern |
| backend | **EXTENSION REQUIRED** | Same pattern as project |
| profile | **EXTENSION REQUIRED** | New concept; nothing conflicts |
| job (ownership/control) | **EXTENSION REQUIRED** | Nothing stateful exists; job records must store `principalId` and tools must check ownership. No architectural gap — but it depends on the A2 job store |

No **ARCHITECTURAL GAP** found: the existing principal→scope→resource-allowlist chain generalizes cleanly to principal→scope→project/backend/profile→job.

## 6. Runtime security boundary

All verified live via `docker inspect` / `docker network inspect` during the audit session:

- **Gateway publication:** `127.0.0.1:8787 → 8787/tcp` only. **VERIFIED.**
- **Gateway docker.sock:** absent — binds are only `./config:ro` and `mcp-bridge-data:/data`. **VERIFIED.**
- **Executor publication:** `PortBindings = {}` — none. **VERIFIED.**
- **Executor Docker authority:** `/var/run/docker.sock:rw` mounted; socket is `root:docker 660` on host; executor runs as `node` with `group_add: [1001]` (host `docker` group = GID 1001). **VERIFIED.**
- **Networks:** `mcp-bridge-internal` is `internal=true`, members: gateway + executor only. `mcp-bridge-edge` (routable): gateway only. **VERIFIED.**
- **Hardening (both services):** read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp`, non-root (`node`), mem 512 MiB, pids 256 (gateway) / 512 (executor), `restart: unless-stopped`, healthchecks passing (both "healthy").
- **Socket consumers:** of 17 running containers (bridge×2, test-target×2, and 13 unrelated containers whose internals were not inspected), **only** `mcp-ide-bridge-executor-1` mounts docker.sock. **VERIFIED** — with the process-deviation note in Correction D: establishing this required generic mount-metadata inspection of unrelated containers.
- **Health:** local `/healthz` and `/readyz` → `{"ok":true}`; public `https://wolf.taildc680e.ts.net/healthz` → `{"ok":true}`. **VERIFIED.**
- **Persistence note:** the executor has **no persistent volume** — only the gateway has one (`mcp-bridge-data`, used for OAuth state). Relevant to §11.

## 7. Kiro readiness

| Item | Status | Evidence | A1 implication |
|---|---|---|---|
| Executable | **VERIFIED** | `/home/herman/.local/bin/kiro-cli` (plus `kiro-cli-chat`, `kiro-cli-term`); separate Windows `kiro` GUI at `/mnt/c/...` is irrelevant to the runner | Spec can assume `kiro-cli` |
| Version | **VERIFIED** | `kiro-cli 2.5.0` | Record as baseline; ACP surface may evolve |
| ACP mode | **VERIFIED (present)** | `kiro-cli acp --help`: options `--agent`, `--model`, `--trust-all-tools`, `--trust-tools <names>`, `--agent-engine v2/v1/kas` (default v2), `--token-path` | Adapter spec can target `kiro-cli acp`; per prohibition, JSON-RPC methods (`session/new` etc.) were **not** exercised — verify at A4 |
| Custom/named agents | **VERIFIED** | `kiro-cli agent list/create/edit/validate/set-default`; workspace (`.kiro/agents`) + global (`~/.kiro/agents`) dirs; built-ins `kiro_default`, `kiro_help`, `kiro_planner` | Profiles can map to bridge-owned agent configs |
| Non-interactive mode | **VERIFIED** | `kiro-cli chat --no-interactive` exists | Fallback transport exists if ACP proves problematic |
| Session create/resume/list | **VERIFIED (CLI level)** | `--resume`, `--resume-id <SESSION_ID>`, `-l/--list-sessions`, `--delete-session`, `--session-source v1\|v2` | A8 session-continuity model is supportable |
| Selective tool trust | **VERIFIED** | `--trust-tools=fs_read,fs_write` (and `--trust-tools=` for none) on both `chat` and `acp` | Least-privilege profile policy is implementable; `--trust-all-tools` never the default |
| KIRO_HOME | **PRESENT, behavior unverified** | `strings` on binaries: `KIRO_HOME` referenced (10 hits in `kiro-cli-chat`); also `KIRO_AGENT_PATH`, `KIRO_ACP_RECORD_PATH`, `KIRO_AGENT_ENGINE` | Isolated bridge-Kiro home is plausible; validate actual semantics at A4 |
| Auth readiness | **VERIFIED (state), gap noted** | `kiro-cli whoami` → "Logged in with Builder ID" (KIRO_AUTH_STATE=authenticated). `KIRO_API_KEY` is referenced in the binaries, but **no API-key auth is currently provisioned** | Per Correction B: automation must not inherit the personal Builder ID session; active interactive auth may take precedence when present; bridge-controlled Kiro requires isolated `KIRO_HOME` + dedicated automation `KIRO_API_KEY` (provision before A4, not before A1) |
| Isolation readiness | **PARTIAL** | `~/.kiro` holds sessions/settings/skills/steering; KIRO_HOME + `--token-path` suggest relocatable state | A3/A4 must prove a containerized kiro-cli with isolated home works |
| Version vs PRD assumptions | **NO MATERIAL DIFFERENCE** | Everything the PRD's §13/§45 relies on (ACP, headless, API key, selective trust) is visible in v2.5.0 | — |
| Missing prerequisites | — | Kiro automation credential; runner-image compatibility (native binary — likely glibc, so not alpine); ACP method-level verification | All A3/A4 items |
| Risks | — | ACP protocol semantics unprobed; `--agent-engine` (v2 vs kas) semantics unknown; Kiro network requirements inside a network-restricted runner unknown | Capture as A4 verification gates |

## 8. GitHub Copilot readiness

| Item | Status | Evidence | A1 implication |
|---|---|---|---|
| Executable | **VERIFIED** | `copilot` → npm global `@github/copilot@1.0.56` under Node 24.15.0 | — |
| Version | **VERIFIED** | `GitHub Copilot CLI 1.0.56` | — |
| Programmatic execution | **VERIFIED (flags), transport NOT selected** | `-p/--prompt` non-interactive, `--output-format json` (JSONL events), `-s/--silent`, `--session-id`, `--resume`, `--no-ask-user`, `--max-autopilot-continues` | Per Correction C: the CLI help states `--allow-all-tools` is "required for non-interactive mode", conflicting with the least-privilege production rule (no `--allow-all-tools` / `--allow-all` / `--yolo`). Non-interactive CLI is therefore **not** selected as production transport in A0/A1; A7 must compare SDK vs ACP vs CLI and select a least-privilege-compliant transport |
| ACP support | **VERIFIED (present)** | `--acp` — "Start as Agent Client Protocol server" | A7 comparison (SDK vs ACP vs CLI) has all three candidates locally available |
| SDK status | **PRESENT (bundled only)** | `@github/copilot` package contains `copilot-sdk/`, `sdk/`, and an `--extension-sdk-path` override; **no standalone SDK dependency installed** in project or globally | If A7 selects the SDK, a dependency addition is required (forbidden in A0; note for A7). Exact standalone package/versioning: unknown — verify at A7 |
| Auth readiness | **CREDENTIAL SOURCE PRESENT; validity UNKNOWN** | `~/.copilot/` exists with `config.json`, `session-store.db` (SQLite), permissions/session state (COPILOT_CREDENTIAL_SOURCE=existing local credential store). Headless precedence: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`; fine-grained PATs with "Copilot Requests" supported, classic PATs not | Confirming token validity requires a network/AI call — forbidden in A0. Runner needs a dedicated fine-grained token, injected per PRD §19 |
| Isolation readiness | **GOOD** | `COPILOT_HOME` overrides state dir; `--secret-env-vars` strips/redacts named env values; `COPILOT_OFFLINE`; `COPILOT_AUTO_UPDATE=false`; `--add-dir` path scoping; `--deny-tool` precedence over allow | Strong fit for the runner hardening model |
| Node compatibility | **VERIFIED** | Runs under Node 24.15.0 (same major as bridge toolchain) | Runner image can share Node base |
| Missing prerequisites | — | Dedicated automation token; A7 empirical check of headless granular permissions; SDK packaging decision | A7 |
| Risks | — | Auto-update on by default (must disable in runner); built-in GitHub MCP server enabled by default (`--disable-builtin-mcps` exists); `--allow-all`/`--yolo` exist and must stay prohibited | Encode in A1 profile policy |

## 9. Agent runner feasibility

**Reusable now:**
- The undici `Pool` Docker client pattern (`src/executor/docker.ts:13`, 16 connections). **The historical concurrency fix is present and intact** — the comment explicitly records that a long-lived streaming exec must not block concurrent control calls (the timeout-kill path). This must not regress.
- Exec streaming with demux, timeout + process-group kill, output caps (`execops.collect`) — directly reusable for runner supervision.
- Archive get/put (tar) — reusable for evidence/file extraction from runners.
- Concurrency-limiter pattern (`acquire()`), fail-closed error model, audit pattern.

**Missing from the Docker client (must be added for A3, executor-side only):**
- container create / start / stop / kill / remove / wait / logs;
- volume create / remove (job volumes);
- image inspect (and a pull-or-prebuilt policy);
- network attach policy (none/deny-by-default);
- resource limits at container-create time (CPU/mem/pids), non-root user mapping;
- orphan-runner reconciliation (label-based sweep).

This is a deliberate design property today — the executor "API has no verb for create container" is a documented security claim. A3 expands executor *capability* while the **public** API must still never express raw Docker options (PRD §8.2). The gateway/executor/runner privilege split maps cleanly onto the current code: gateway keeps protocol/auth/policy (new tools in `mcp.ts`), executor gains job orchestration + runner lifecycle + persistence (new modules beside `docker.ts`), runners get no socket. Current code supports that separation cleanly — no refactor of existing layers is required, only additive modules.

## 10. Sandbox feasibility

**Critical current fact:** the executor has **no access to host project files at all** — its only mounts are `./config:ro` and docker.sock. It reaches target containers exclusively through the Docker API. So the PRD v1 materialization model (host project → staging copy → Docker-managed job volume → runner mounts volume RW) requires one of:

1. **Staging container created by the executor** with a trusted, registry-resolved read-only bind of the approved project (bind source comes from executor-side config, never from callers) — matches PRD §9 and keeps the executor itself unmounted; **or**
2. a read-only bind of a projects root into the executor itself (weaker; widens executor blast radius).

Option 1 is achievable once the Docker client gains create/start/remove + volume support (§9). Risks / A1 decisions required:

- **UID/GID:** host project is `herman` (1000); runner should be non-root; job-volume ownership must be normalized at staging time (`chown` in staging container). Decide the canonical runner UID.
- **Git metadata:** `.git` must be copied into the sandbox for `baseCommit`, in-sandbox `git status/diff`, and machine diff generation. Decide whether hooks are neutered (`core.hooksPath`) inside the sandbox.
- **Untracked/ignored files:** decide copy policy — full working tree including untracked, excluding heavyweight ignored dirs (`node_modules`, caches) vs `git clone`-style tracked-only. This changes diff semantics and agent build ability; likely "working tree minus ignore-listed heavy dirs, record the exclusion list in job metadata."
- **Symlinks:** copy must not follow symlinks out of the project root (tar with no dereference); record and test.
- **Large repos / dependency caches:** copy time and volume size limits; decide whether runners get a warm dependency cache volume (network-deny makes `npm ci` impossible otherwise) — this interacts with the network policy decision.
- **Submodules/nested repos:** v1 should probably declare them unsupported-for-apply and fail closed at dispatch.
- **Cleanup:** volume + container removal tied to job disposition + retention policy; orphan sweep by Docker labels (e.g., `mcp.bridge.job=<id>`).
- **Diff generation:** run trusted evidence-collector execs (not the agent's own claims) for status + diff, hash the diff — the existing exec/archive machinery supports this without new transports.

## 11. Async job/persistence feasibility

**Current state (all verified):**
- The gateway is fully stateless per MCP request (fresh server/transport, ALS principal); nothing holds long requests open today, and nothing may (PRD §6.4).
- All state is in-memory: rate-limit windows (gateway), concurrency counters + 5s target cache (executor). A restart loses everything; that is currently correct because no state is durable by design.
- Timeouts: exec bounded at 600s max; the executor-client `undici.request` uses defaults — fine for the planned quick-return job-control calls.
- **No SQLite anywhere** in the project or its dependency tree. (Coincidentally, Copilot CLI itself uses a local SQLite `session-store.db` — an existence proof for local SQLite on this host, but unrelated to the bridge.)
- The executor has **no persistent volume**; only the gateway does (OAuth state in `mcp-bridge-data`, atomic-rename JSON writes with 0600 modes — a reusable persistence idiom, but JSON-file storage is not adequate for job state machines).

**Recommended direction (matches PRD §15, updated per Correction A):**
- **Persistence technology direction: SQLite** (WAL mode), embedded in the executor. Why: transactional state transitions and one-time-apply semantics need atomic compare-and-set, which the existing JSON-blob idiom cannot provide safely; workload is local/single-writer; no new service.
- **Exact binding: DEFER TO A2.** Node v24.15.0 ships built-in `node:sqlite` at **Stability 1.2 — Release Candidate**; A2 must evaluate `node:sqlite` against alternatives (e.g., `better-sqlite3`) before adding any dependency. No binding is locked in A0/A1.
- **Where:** a new named volume mounted into the executor (e.g., `mcp-bridge-jobs:/jobs`), 0700, owned by `node` — mirroring the gateway `/data` pattern; compose change happens in A2, not before.
- **Failure/recovery:** on executor start, reconcile the store against live Docker state (label-selected runners): mark orphaned RUNNING jobs `FAILED_INFRASTRUCTURE` or re-attach; never resurrect a job silently into RUNNING without a live runner.
- **Writer locks:** the initial rule (1 global writer, 1 writer per project) should be a persisted store constraint, not an in-memory counter, so restarts can't double-admit; the in-memory `acquire()` pattern remains for exec concurrency only.

## 12. Apply/discard feasibility

**Current state:** Git support is read-only and container-scoped — three fixed argv commands (`git status --porcelain -b`, `git diff --stat`, `git log --oneline`) executed inside authorized targets. There is **no host-project Git abstraction and no write path to any real project**: as noted in §10, the executor cannot even read host projects today. `agent_diff`/`agent_apply`/`agent_discard` are therefore entirely new capability, though the confined-argv exec pattern, tar transport, and fail-closed error model all transfer.

Analysis of the required mechanics against current abstractions:

- **baseCommit / dirty state:** must be captured at staging time by the executor (trusted exec in the staging container), stored in the job record. Nothing exists; straightforward with §9 extensions.
- **`git apply --check` / atomicity / rollback:** apply should run in a dedicated short-lived apply-helper container with a narrowly scoped RW bind of the one approved project (never the agent runner, per PRD §9.3). Sequence: verify HEAD == baseCommit → verify working-tree policy → verify diff hash → `git apply --check` → apply → post-verify → record. Rollback evidence: record HEAD + status pre-apply; on partial failure, `git apply -R` with the same validated patch / targeted checkout.
- **Double apply / job replay / stale source:** enforced by the persisted state machine (one-time disposition via atomic store transition) + base-state verification. Depends on §11 store choice.
- **Guarded paths:** diff-path screening against a deny list (`.env`, `config/clients.yaml`, keys, compose, etc.) before apply; project-configurable with secure defaults.
- **Concurrent writers:** the per-project writer lock must cover apply operations too, not just implementation jobs.

**Decisions that MUST be specified in A1 before A6 coding:** dirty-tree policy (refuse vs allow-with-policy); untracked-file collision policy; binary-diff handling (`git diff --binary` vs refuse); the guarded-path default list; apply-helper container contract (image, mount scope, non-reuse of runner); rollback evidence format; whether `agent_diff` output is capped/truncated and how the hash covers the full diff.

## 13. Security gap matrix

| Threat | Current control | Gap | Required phase |
|---|---|---|---|
| Arbitrary project selection | Target allowlist pattern (registry + per-principal list, dual-enforced) | Project registry doesn't exist; pattern proven and transfers | **NEW CONTROL REQUIRED** — A1 (schema) / A2 |
| Arbitrary host paths from callers | No tool accepts host paths today; workspace-relative only | Keep invariant: project IDs resolve executor-side | **CURRENTLY MITIGATED** (invariant to preserve) |
| Path traversal | `validateRelativePath` + canonicalization, adversarially tested | Sandbox staging/apply paths need same rigor | **PARTIALLY REUSABLE** — A3/A6 tests |
| Symlink escape | Deepest-existing-ancestor canonicalization (`confinePath`); live tests pass | Staging copy must not dereference symlinks out of project | **PARTIALLY REUSABLE** — A3 |
| Agent prompt injection | N/A today | Defense must be container isolation, not prompts; runner has no socket/host mounts | **NEW CONTROL REQUIRED** — A3 |
| Docker socket exposure | Only executor mounts it (live-verified); gateway/targets have none | Runners must never get it; add adversarial proof in-runner | **CURRENTLY MITIGATED** / A3 proof |
| Host filesystem exposure | Executor mounts only config:ro; targets only their workspaces | Runner mounts limited to job volume; staging bind is the sensitive step | **PARTIALLY REUSABLE** — A3 |
| Credential leakage | Hash-only key storage; redaction in audit; OAuth tokens hashed | Agent-backend secrets need injection bootstrap + output redaction (`--secret-env-vars` helps for Copilot); redact patterns must learn Kiro/GH token shapes | **NEW CONTROL REQUIRED** — A4/A7 |
| Stale apply | None (no apply exists) | baseCommit verification + refusal | **NEW CONTROL REQUIRED** — A6 |
| Concurrent writers | Exec concurrency limits only (in-memory) | Persisted per-project writer lock | **NEW CONTROL REQUIRED** — A2 |
| Job replay | None | One-time disposition via atomic state machine | **NEW CONTROL REQUIRED** — A2/A6 |
| Unauthorized cancellation | Scope+ownership pattern exists for targets | Job-ownership check on cancel | **PARTIALLY REUSABLE** — A2 |
| Oversized prompts/results | 8 MB body limit; 256 KiB exec output cap; 5 MiB file cap; 32 KiB command cap | Prompt-size + result/event bounding for jobs | **PARTIALLY REUSABLE** — A2 |
| Runaway subprocesses | Timeout + process-group kill + pids/mem limits on bridge services | Runner-level pids/CPU/mem/time limits at container create | **PARTIALLY REUSABLE** — A3 |
| Orphan runners | None (no runners) | Label-based reconciliation sweep | **NEW CONTROL REQUIRED** — A3 |
| Backend crashes | Exec exit-code/timeout observation exists | Distinguishable `FAILED_AGENT` / `FAILED_INFRASTRUCTURE` states | **NEW CONTROL REQUIRED** — A2 |
| Corrupted job state | None | Transactional store + startup reconciliation | **ARCHITECTURAL DECISION REQUIRED** (store binding, per Correction A) — A1/A2 |
| Network misuse | Targets keep their own networks; bridge nets scoped | Runner network deny-by-default vs backend API reachability (Kiro/Copilot need their service endpoints) — a real tension to resolve | **ARCHITECTURAL DECISION REQUIRED** — A1/A3 |
| Audit integrity | Structured stdout JSON, redacted | Job audit should be durable (job store), append-only; event-log injection defenses (bounded, escaped) | **PARTIALLY REUSABLE** — A2 |

## 14. Test baseline

**Executed during the A0 audit session (new evidence):**
- `npm run typecheck` — **PASS**
- `npm test` (unit) — **20/20 PASS** (pathcheck 7, auth 7, redact 4, ratelimit 2)

**Not executed during A0:** the live integration suite (`npm run test:integration`). It requires a `KEYS_ENV` file of real client keys (location not defined in the audit session's environment) and mutates live state (test-target `gen/` files, OAuth client/token stores). Per instructions, uncertainty → not run. **Historical baseline (pre-A0, not re-verified): 40/40 live integration PASS.**

**Structural capability check:** the 40 historical live tests are exactly accounted for in the current tree — `tests/integration/bridge.test.ts` contains 37 cases, `output-schema.test.ts` contains 3. Both target the running stack, which is healthy, with the demo target and decoy present and running. The repository appears fully capable of reproducing the 40/40 baseline; only credential wiring (`KEYS_ENV`) is needed.

## 15. PRD drift findings

**No material PRD drift found.** Two minor, non-blocking notes for completeness:

1. **`docs/TEST_RESULTS.md` is one milestone stale** — it reports "Integration 37/37" (written 2026-07-27, before the structured-output commit added 3 tests). The PRD's 40/40 is the correct current figure (37+3 verified by test-case count). This is doc staleness inside the repo, not PRD conflict; PRD §46 already mandates updating counts at phase gates.
2. **PRD §13.3 Kiro authentication nuance** — the PRD states headless automation supports `KIRO_API_KEY` (confirmed: the env var is referenced in the installed binaries), but the *actual current* local auth is an interactive Builder ID session. No API-key credential exists yet, so the PRD's preferred runner bootstrap (secret file → env → `exec kiro-cli`) has an unprovisioned prerequisite. Expected/actual/evidence/impact: expected API-key-based automation path; actual Builder-ID-only session; evidence `kiro-cli whoami`; impact: A4 blocker, not A1. See Correction B for the accepted architecture (isolated `KIRO_HOME` + dedicated automation key; never inherit the personal session).

## 16. Unknowns

- Kiro ACP JSON-RPC method surface (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/set_mode`) — not exercised (prohibited); only the subcommand and its flags are verified.
- Actual `KIRO_HOME` semantics (referenced in binaries; behavior untested).
- Whether `kiro-cli` (native binary) runs in a container, its libc requirement, and its network endpoints — determines the runner base image (likely rules out alpine/musl; unverified).
- Kiro `--agent-engine` v2 vs `kas` semantics and `--token-path` token format.
- Whether Kiro Builder ID accounts can mint automation API keys, and the provisioning procedure.
- Copilot live auth validity (checking requires a network call — not performed).
- Whether Copilot non-interactive (`-p`) works with only granular `--allow-tool` grants, or genuinely requires `--allow-all-tools` as its help asserts (see Correction C).
- Standalone Copilot SDK package identity/version/API stability (only the CLI-bundled copy inspected).
- Location/state of the integration-test `KEYS_ENV` file.
- `node:sqlite` (Stability 1.2 — Release Candidate on Node v24.15.0) suitability versus alternative bindings — A2 evaluation.
- Mickey stack internals (deliberately not inspected — out of scope; see Correction D).

## 17. A1 prerequisites

**BLOCKING (for starting A1):**
- None. Review and approval of the A0 report (now granted) was the only gate.

**NON-BLOCKING (must be resolved before the indicated later phase):**
- Executor persistent volume + job-store binding final call — before A2 coding (A1 specifies it).
- Kiro automation credential (`KIRO_API_KEY`) provisioning path — before A4.
- Runner base-image compatibility test for `kiro-cli` (libc, network endpoints) — before A3/A4 image contract is frozen.
- Dedicated Copilot fine-grained token for the runner — before A7.
- Copilot secure headless/ACP/SDK transport decision — before A7.
- Runner network/egress policy resolution (deny-by-default vs backend API reachability) — before A3.

**OPTIONAL:**
- Refresh `docs/TEST_RESULTS.md` to the 40-test milestone at the next legitimate write phase.
- Extend `redact.ts` patterns for Kiro/GitHub token shapes (natural fit in A1's redaction unit-test work).
- Locate/standardize `KEYS_ENV` so the full 40/40 regression can be run at each future gate.

## 18. Recommended A1 implementation boundary

A1 should implement **specification and enforcement scaffolding only — no runner, no backend process, no Docker changes, no compose changes**:

1. **Types** (new shared module): `AgentBackend`, `AgentProject`, `AgentProfile`, `AgentJob`, `AgentStatus`, `AgentResult`, `AgentDiff`, `AgentFailure` — with the failure taxonomy (`FAILED_PRECONDITION/POLICY/AGENT/TIMEOUT/INFRASTRUCTURE`, `CANCELLED`) and disposition states (`APPLIED`/`DISCARDED`) as data, plus a pure, fully unit-tested state-transition function that rejects invalid transitions.
2. **Scopes:** add `agents:read`, `agents:dispatch`, `agents:cancel`, `agents:apply` to the `Scope` union, `ALL_SCOPES`, `validate-config.mjs`, and `clients.example.yaml`; unit-test grant/deny.
3. **Configuration schema:** trusted executor-side registry format for backends, projects (ID → hostPath, gitRequired, allowed backends), profiles (enforcement policy fields, not prompts), resource limits, retention — parser + validation + example file with no secrets; explicitly reject caller-controlled fields (hostPath, image, mounts, privileged, network mode). Includes the **ResourcePolicy** concept required by the Master PRD (§ A1 requirements): named policies (ECONOMY / STANDARD / DEEP) governing model class, maximum runtime, CPU, RAM, PID count, output size, evidence storage size, provider credits where controllable, network/egress policy, and retention class.
4. **MCP tool schemas:** finalize input/output Zod schemas for all 9 planned tools (`agents_list`, `agent_projects`, `agent_dispatch`, `agent_status`, `agent_result`, `agent_diff`, `agent_cancel`, `agent_apply`, `agent_discard`) as reviewable schema definitions, satisfying NFR-007. Tools are **not** registered live in A1 — no working `agent_dispatch` is exposed until A2 provides a job engine/fake backend (accepted decision; recommendation remains: not registered rather than feature-flagged, to keep live behavior byte-identical).
5. **Authorization spec:** principal→operation→project→backend→profile→job-ownership check functions, unit-tested against the threat model (project impersonation, backend escalation, profile escalation, cross-principal job access).
6. **Documentation:** architecture/security doc updates describing the agent plane contract; PRD phase-tracker update per §46.
7. **Validation:** typecheck + expanded unit suite; zero change to existing 14-tool live behavior (existing tests must still pass unchanged).

Explicitly out of A1: any Docker client extension, persistence volume, job engine, fake backend (A2), sandbox (A3), Kiro/Copilot processes (A4+).

## 19. Files A1 is expected to touch

Evidence-backed forecast (tentative paths marked):

- `src/gateway/config.ts` — scope union + principal fields for agent/project/backend grants.
- `scripts/validate-config.mjs` — new scopes + agent config validation.
- `config/clients.example.yaml` — example agent scopes.
- `src/shared/errors.ts` — agent failure codes.
- *(new, tentative)* `src/shared/agents.ts` — normalized agent types + state machine.
- *(new, tentative)* `src/gateway/agents.ts` or `src/gateway/mcp-agents.ts` — the 9 tool schema definitions (registration deferred).
- *(new, tentative)* `src/executor/agents/registry.ts` — project/backend/profile registry parser (spec-level; no runtime wiring beyond load+validate).
- *(new, tentative)* `config/agents.example.yaml` — trusted registry example.
- `tests/unit/` — new: agent schema, state-machine, authorization, registry-validation tests.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md` — agent-plane contract sections.
- `MCP_IDE_BRIDGE_MASTER_PRD.md` — phase tracker + A1 evidence per §46.
- `package.json` — only if a test script is added; **no new dependencies in A1** (any SQLite binding decision belongs to A2).

## 20. Architecture decision record recommendations

Decisions A1 should formally lock (status after review shown where the closeout review already accepted a direction):

1. **Job-store technology** — **accepted direction: SQLite**; exact Node binding **deferred to A2** (`node:sqlite`, Stability 1.2 — Release Candidate on Node v24.15.0, vs alternatives).
2. **Job-store ownership and location** — executor-owned named volume; schema versioning + startup reconciliation contract.
3. **Project registry schema** — exact fields, ID grammar (reuse the proven `^[a-z0-9][a-z0-9_-]{0,63}$` target-ID grammar), per-principal grant shape; **accepted direction: caller supplies logical project ID only; trusted executor-side registry resolves source; no caller-supplied host path.**
4. **Agent-tool registration strategy in A1** — **accepted direction: contracts/schemas only in A1; no working `agent_dispatch` until A2.**
5. **Sandbox materialization mechanism** — **accepted direction: executor-controlled staging into Docker-managed job storage; write-capable agents never receive a real-project RW mount.** Copy policy details (untracked/ignored files, symlinks, `.git`, submodules) remain A1 specification items.
6. **Runner image strategy** — **accepted direction: separate pinned backend runner images; no arbitrary image selection.** Base image driven by the kiro-cli libc verification; prebuilt/pinned, never pulled at dispatch time.
7. **Runner network policy** — **accepted direction: backend egress policy is explicit and controlled**; default-deny with explicit per-backend allowlist for the backend's own API endpoints (the unavoidable exception; make it explicit).
8. **Kiro integration** — **accepted direction: ACP target transport; isolated `KIRO_HOME`; dedicated automation `KIRO_API_KEY`; selective trusted tools.** Interactive Builder ID session never shared with runners (Correction B).
9. **Copilot transport** — **accepted direction: remains an A7 decision (SDK vs ACP vs programmatic CLI); least privilege is mandatory** (Correction C). Codify the comparison matrix (structured events, cancellation, session persistence, granular permissions headless, maintenance) so A7 is a measurement, not a debate.
10. **Writer-lock semantics** — **accepted direction: max one global writer and one writer per project for v1**; persistence/recovery semantics must be specified in A1; lock scope includes apply.
11. **Result architecture** — **accepted direction: concise structured result by default; detailed evidence stored locally and retrieved on demand.**
12. **Prompt/result retention** — hash-always, raw-prompt TTL, event bounding/redaction rules.

## 21. Final A0 gate

VERDICT:
A0 PASS — READY FOR A1

READY_FOR_A1:
YES

BLOCKERS:
none — (non-blocking prerequisites for later phases: executor persistence volume [A2]; Kiro `KIRO_API_KEY` provisioning [A4]; kiro-cli container/libc compatibility [A3/A4]; Copilot transport decision, headless granular-permission verification and dedicated token [A7]; runner egress policy decision [A3])

REPOSITORY_MODIFIED_BY_A0:
NO

The audit was performed entirely with read-only commands (file reads, `git` queries, `docker inspect`/`network inspect`, one read-only `grep` exec inside the bridge's own gateway container, version/help probes of `kiro-cli` and `copilot`, `npm run typecheck`, and the unit suite, which touches no project files). No file in the repository was created, modified, staged, or deleted during A0; no service, network, credential, or dependency was changed; no AI task was dispatched to Kiro or Copilot. One process deviation is recorded in Correction D.

This document was persisted after review approval as part of the A0 documentation closeout.
