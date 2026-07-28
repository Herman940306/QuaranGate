# PHASE A2 — DURABLE JOB ENGINE + DETERMINISTIC FAKE BACKEND

**Document ID:** MIB-A2-AUDIT
**Program:** Governed Agent Dispatch (ChatGPT → MCP IDE Bridge → Kiro / GitHub Copilot workers)
**Phase executed:** 2026-07-28
**Implementer:** Claude (senior implementation engineer session)
**Starting HEAD:** `f70d49474167188eaf519fe93cc53777b091cbab` — `docs: close agent dispatch phase A1`
**Implementation commit:** `bd1137c138598ddc88e57e6be4edcdc0a413ca62` — `feat: add durable agent job engine`
**Verdict:** **A2 COMPLETE — PASS. READY FOR A3.**

---

## 1. Objective

Build and prove the durable asynchronous orchestration layer behind Agent Dispatch: an authorized
MCP client can `agents_list`, `agent_projects`, `agent_dispatch`, `agent_status`, `agent_result`,
`agent_cancel` against a deterministic **fake** backend, with executor-owned persistence, quick
dispatch (no long-held MCP request), and restart-safe job state — without any real agent, runner
container, sandbox, diff, or apply.

## 2. SQLite binding decision

**Selected: the built-in `node:sqlite` (`DatabaseSync`) on Node 24.15.0. No new npm dependency.**

Evaluated against the A1/A0 criteria and confirmed suitable in-session:

```text
synchronous/transactional single-writer local workload   suitable (DatabaseSync is sync)
WAL support                                               PRAGMA journal_mode=WAL verified
prepared statements                                       db.prepare(...).run/get/all verified
transactions                                              BEGIN IMMEDIATE / COMMIT / ROLLBACK verified
compare-and-set (atomic transitions)                      UPDATE ... WHERE status = expected; .changes verified
TypeScript/build compatibility                            typecheck + build PASS
no unsupported runtime flags                              runs without --experimental flags on v24.15.0
runtime in the alpine runner image                        verified live: node:sqlite query inside the executor container
```

`better-sqlite3`/`sqlite3` were **not** installed. STOP condition ("new npm DB dependency
necessary") did not trigger.

## 3. Files changed (implementation commit `bd1137c`)

**Added:**

```text
src/executor/agents/jobStore.ts       durable SQLite store + atomic transitions + admission + recovery
src/executor/agents/fakeBackend.ts     deterministic, abort-aware fake backend
src/executor/agents/jobEngine.ts       executor-owned engine (validate/execute/cancel/recover/shutdown)
src/executor/agents/routes.ts          narrow internal agent HTTP routes
src/gateway/agentTools.ts              six activated MCP tools (A1 schemas + A1 authz matrix)
tests/unit/agent-jobstore.test.ts      14 tests
tests/unit/agent-jobengine.test.ts     24 tests (dispatch/lifecycle/cancel/ownership/recovery/log-safety)
tests/integration/agents.test.ts       13 live tests (six tools, surface, ownership, strict schemas)
tests/integration/a2-regress.test.ts   existing-14-tools regression through a dedicated principal
tests/integration/a2-persistence.test.ts  live durability + startup recovery (executor restart)
```

**Modified:**

```text
src/executor/index.ts          optional agent subsystem wiring + graceful shutdown
src/gateway/executorClient.ts  semantic agent client methods + wire types
src/gateway/mcp.ts             registerAgentTools(server) inside buildServer()
src/shared/errors.ts           agent error codes (AGENTS_UNAVAILABLE, UNKNOWN_JOB, UNKNOWN_PROJECT,
                               FORBIDDEN_PROJECT/BACKEND/PROFILE/JOB)
compose.yaml                   executor-owned mcp-bridge-jobs volume + AGENTS_CONFIG/JOBS_DB env
Dockerfile                     create/own /jobs (0700, node)
docs/AGENT_CONTROL_PLANE.md    Section 0 (A2 engine), boundary + tool-status updates
docs/ARCHITECTURE.md           Agent Control Plane (A2) section
docs/SECURITY.md               A2 security properties section
.gitignore                     config/agents.yaml (live runtime config, never committed)
```

## 4. Job DB

```text
container path:   /jobs/agents.db  (WAL: agents.db-wal / agents.db-shm)
Docker volume:    mcp-bridge-jobs  (executor-owned, 0700, node; NOT mounted to gateway or targets)
schema version:   1  (PRAGMA user_version)
```

Persisted per job: jobId, principalId, backend, project, profile, resourcePolicy, status,
failureCode/failureReason, createdAt/startedAt/completedAt, promptHash, bounded raw prompt (executor
only), summary, exitCode, backendSessionId (nullable, A8-ready), sessionPolicy, writer flag.

## 5. State machine + transactional transitions

All transitions go through the shared A1 validator (`assertAgentJobTransition`) and are atomic
compare-and-set (`UPDATE ... WHERE job_id = ? AND status = ?`); a raced/superseded transition
returns `false` rather than corrupting state. Normal fake path
`QUEUED → PREPARING → RUNNING → VALIDATING → COMPLETED`. A2 never reaches `APPLIED`/`DISCARDED`.
Failure taxonomy exercised: `FAILED_AGENT`, `FAILED_TIMEOUT`, `FAILED_INFRASTRUCTURE`, `CANCELLED`,
plus pre-persist dispatch rejections (`UNKNOWN_PROJECT`/`FORBIDDEN_BACKEND`/`FORBIDDEN_PROFILE`).

## 6. Concurrency + recovery

- Serial execution in A2 (one active job globally); writer admission additionally enforces ≤1
  active writer globally and ≤1 per project, all inside one `BEGIN IMMEDIATE` claim transaction —
  persisted, restart-safe, cannot double-admit. Excess work **waits in QUEUED**, not rejected.
- Writer classification is derived from the trusted profile contract (`workspaceAccess:
  sandbox-write` ⇒ writer; `implement` only in v1), never from prompt text.
- Startup recovery: active jobs (`PREPARING`/`RUNNING`/`VALIDATING`) → `FAILED_INFRASTRUCTURE`
  (reason `executor restarted during active fake execution`); `QUEUED` kept eligible; graceful
  SIGTERM shutdown fails active work closed identically. Proven live by restarting the executor.

## 7. Six activated tools + authorization

`agents_list`/`agent_projects` (`agents:read`); `agent_dispatch` (`agents:dispatch` + project +
backend + profile grants); `agent_status`/`agent_result` (`agents:read` + ownership); `agent_cancel`
(`agents:cancel` + ownership). Gateway enforces the pure A1 matrix before any executor work; the
executor independently re-validates trusted config and re-checks ownership by persisted
`principalId`. No cross-principal override. `agent_diff`/`agent_apply`/`agent_discard` remain
**unregistered** (verified from source and via live `tools/list`).

## 8. Fake backend honesty

No shell/Docker/HTTP/AI/Kiro/Copilot; reads/modifies no project source. Deterministic result:
`"Fake backend completed successfully ... No files were changed; no provider was invoked."`,
`changedFiles: []`, `usage: { usageAvailable: false }`. Failure/delay variation is injected only via
a test seam (`backendOptions`) — never a caller-controlled MCP field.

## 9. Prompt / log safety

Bounded raw prompt stored only in the executor DB (needed so queued jobs survive the request and
restarts); never logged, never audited, never returned by `agent_status`, not returned by
`agent_result`; `promptHash` always stored. Unit-tested that engine log lines never contain the
prompt. No provider credentials exist in A2; none are stored.

## 10. Validation evidence (executed this phase)

```text
git diff --check      PASS
npm run typecheck     PASS
npm test (unit)       109 / 109 PASS   (75 pre-A2 + 34 new)
npm run build         PASS
validate-config       PASS (clients 9, bridge 1 target, agents 1 project / 2 backends)
```

Live integration (deployed stack; dedicated local test principals only — no browser principal was
granted agent scopes; no real key printed):

```text
tests/integration/agents.test.ts        13 / 13 PASS
tests/integration/a2-regress.test.ts     1 / 1  PASS  (all 14 original tools operate; 20 listed)
tests/integration/a2-persistence.test.ts 1 / 1  PASS  (durability + startup recovery via restart)
```

Historical/pre-A2 live integration (`bridge.test.ts` 37 + `output-schema.test.ts` 3 = 40) was **not
rerun as a whole**: its `vscode`/`readonly`/`forbidden` fixtures' keys are managed outside this
session, and rotating pre-existing principals' credentials was declined (correctly, to avoid
disrupting any real client). Instead, existing-tool behavior was re-proven live through a dedicated
additive full-scope test principal (`a2-regress.test.ts`), and `output-schema.test.ts` was updated
to the new count of 20 (equivalently asserted live by `agents.test.ts`).

## 11. Deployment + boundary (post-deploy, live)

```text
gateway docker.sock:   ABSENT (mounts: /config, /data only)
gateway bind:          127.0.0.1:8787
executor ports:        {}
executor volumes:      docker.sock, /config, mcp-bridge-jobs -> /jobs
gateway jobs volume:   ABSENT
internal network:      internal=true
job DB:                /jobs/agents.db present, schema 1, jobs persisted (live-queried in-container)
healthz/readyz:        {"ok":true} / {"ok":true}
```

Rollback evidence recorded before deploy: previous image tagged `mcp-ide-bridge:pre-a2`
(`sha256:33cffae60ac0...`). Build + `docker compose -p mcp-ide-bridge up -d` were project-scoped;
no unrelated Docker project was touched. No Tailscale change.

## 12. No-runtime-expansion proof

```text
Kiro invoked:                 NO
Copilot invoked:              NO
runner containers created:    NO
sandbox staging:              NONE
machine diff / apply / discard: NONE
Docker Engine capability added: NONE (executor Docker client unchanged)
new npm dependency:           NONE
```

## 13. Deferred

- **A3:** runner sandbox; Docker client expansion (container/volume create, resource limits at
  create); project snapshot/staging materialization; runner egress (`backend-only`) resolution;
  real CPU/RAM/PID/telemetry collection; orphan reconciliation.
- **A4:** Kiro ACP backend; isolated `KIRO_HOME`; `KIRO_API_KEY`; concrete model pinning for
  `modelClass`; real result/diff derivation.
- **A6:** `agent_diff` (machine-derived), `agent_apply`, `agent_discard`; base-state verification;
  guarded-path enforcement; one-time disposition to `APPLIED`/`DISCARDED`.
- **A7:** Copilot transport (SDK vs ACP vs CLI) under mandatory least privilege; dedicated Copilot
  credential.
- **A8:** `sessionPolicy: resume` (currently rejected explicitly at dispatch).

## 14. A3 entry conditions

1. Repository at the A2 closeout commit, clean tree, stack healthy.
2. A2 contracts and the durable engine are the substrate: A3 adds the runner sandbox and expands the
   executor Docker client without changing the public MCP contract or weakening any
   strict/deny-by-default/ownership property.
3. The fake backend remains for deterministic tests; the real Kiro backend arrives in A4, not A3.

## 15. Deviations

1. Added agent error codes to `BridgeErrorCode` (`AGENTS_UNAVAILABLE`, `UNKNOWN_JOB`,
   `UNKNOWN_PROJECT`, `FORBIDDEN_PROJECT/BACKEND/PROFILE/JOB`) — additive, typed, fail-closed.
2. Global serial execution in A2 (one active job) is stricter than the writer-only rule; the writer
   locks are still enforced explicitly so later phases can relax global serialization without losing
   them. Documented.
3. Live full 40-test historical suite not rerun as-is (see §10); equivalently covered.
4. Added a dedicated additive full-scope local test principal (`itest-full`) and two agent test
   principals (`itest-agent-owner`, `itest-agent-other`) in the gitignored live `config/clients.yaml`
   for A2 integration; no browser principal received agent scopes; no raw key was printed.
