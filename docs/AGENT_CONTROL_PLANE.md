# Agent Control Plane — Contract Specification (A1) + Implementation Complete (A6)

**Status:** Phase A6 complete — all nine Agent Control Plane tools now registered and operational. Sandboxed Kiro execution with workspace write (A5), guarded apply/discard (A6), and retained-resource lifecycle (A6) are implemented and verified.
**Live MCP surface:** 23 operational tools — the original 14 plus all nine Agent Control Plane tools (`agents_list`, `agent_projects`, `agent_dispatch`, `agent_status`, `agent_result`, `agent_cancel`, `agent_diff`, `agent_apply`, `agent_discard`).
**Authority:** this document is the code-adjacent specification; the Master PRD (`MCP_IDE_BRIDGE_MASTER_PRD.md`) is the product authority. Where this document summarizes the PRD, the PRD wins; where it records exact code contracts, the code + tests are the evidence.

---

## 0. Phase A2 — durable job engine (historical A2 record)

This section records the orchestration layer **as delivered in A2**. It remains accurate for the
job engine, persistence, recovery, and concurrency semantics, all of which are still live. The
execution path described here — the deterministic fake backend — was superseded by the real Kiro
ACP backend in A4/A5; the fake backend now serves only non-`kiro` backends. See §11 for current
phase status.

The asynchronous orchestration layer is implemented and deployed:

```text
MCP request -> Gateway (auth + A1 authorization matrix + strict schemas + audit)
            -> private Executor API (internal-token, re-validates trusted config + job ownership)
            -> durable SQLite job engine (node:sqlite, executor-owned /jobs volume)
            -> deterministic fake backend (no shell/Docker/network/AI)
            -> persistent state + concise result -> MCP status/result
```

- **SQLite binding:** the **built-in `node:sqlite`** (`DatabaseSync`) on Node 24.15.0 — WAL mode,
  prepared statements, `BEGIN IMMEDIATE` transactions, synchronous single-writer semantics. **No new
  npm dependency** was added.
- **Persistence:** executor-owned Docker volume `mcp-bridge-jobs` mounted at `/jobs` (`0700`,
  `node`), DB at `/jobs/agents.db`, `PRAGMA user_version = 1`. Separate trust domain from the
  gateway OAuth `/data` volume; never mounted into the gateway or any target.
- **`agent_dispatch`** validates authorization, then returns a `jobId` immediately (no long-held MCP
  request). The bounded raw prompt is stored only in the executor DB (needed so queued jobs survive
  the request and restarts); it is never logged, never returned by `agent_status`, and not returned
  by `agent_result`. `promptHash` is always stored.
- **State machine:** the shared A1 validator drives every transition; each transition is an atomic
  compare-and-set (`UPDATE ... WHERE status = expected`). Normal fake path:
  `QUEUED → PREPARING → RUNNING → VALIDATING → COMPLETED`. A2 never reaches `APPLIED`/`DISCARDED`.
- **Writer classification** comes from the trusted profile contract (`workspaceAccess:
  sandbox-write` ⇒ writer; `implement` only in v1) — never from prompt text.
- **Concurrency:** persisted, restart-safe. A2 executes jobs serially (one active job globally);
  writer admission additionally enforces ≤1 active writer globally and ≤1 per project inside the
  same `BEGIN IMMEDIATE` claim transaction, so a restart can never double-admit. Excess jobs **wait
  in QUEUED**, they are not rejected.
- **Startup recovery:** on executor boot, any job found `PREPARING`/`RUNNING`/`VALIDATING` (no
  attachable runner exists in A2) fails closed to `FAILED_INFRASTRUCTURE` with reason
  `executor restarted during active fake execution`; `QUEUED` jobs remain eligible. Graceful SIGTERM
  shutdown fails active work closed the same way.
- **Cancellation** (`agent_cancel`): authorize + verify ownership → CAS to `CANCELLED` → cooperative
  `AbortSignal` aborts active fake work → writer authority released. No Docker kill (no runner).
- **Failure taxonomy in use:** `FAILED_AGENT` (deterministic backend failure), `FAILED_TIMEOUT`
  (exceeds trusted `maxRuntimeMs`), `FAILED_INFRASTRUCTURE` (restart/shutdown), `CANCELLED`, plus
  dispatch-time `UNKNOWN_PROJECT`/`FORBIDDEN_BACKEND`/`FORBIDDEN_PROFILE` before any job persists.
- **Defense in depth:** the executor independently re-validates project/backend/profile/resource
  policy against trusted `config/agents.yaml` and re-enforces job ownership — gateway checks are
  never assumed sufficient.
- **Resource policy:** the selected policy is persisted; the fake backend honors `maxRuntimeMs`.
  A2 does not simulate CPU/RAM/PID limits (A3 runner concern) and fabricates no usage — results
  carry `usage: { usageAvailable: false }` and `changedFiles: []`.

Modules: `src/executor/agents/{jobStore,jobEngine,fakeBackend,routes}.ts`,
`src/gateway/agentTools.ts`, executor client extensions in `src/gateway/executorClient.ts`. The
subsystem is **optional**: without `config/agents.yaml` the executor logs "not configured" and the
agent routes fail closed with `AGENTS_UNAVAILABLE` — the bridge runs exactly as before.

**A2 boundary (not done here):** no real Kiro/Copilot, no runner container, no sandbox staging, no
machine diff, no apply/discard, no Docker Engine capability expansion. Those are A3–A7.

---

## 1. Architecture

Future north star (implemented across A2–A9, **not** in A1):

```text
ChatGPT
   |
   v
Gateway            MCP protocol + authentication + authorization + schemas
   |
   v
Executor           trusted project registry + job engine + persistence + runner lifecycle
   |
   v
Agent runner       Kiro / Copilot
   |
   v
Isolated sandbox
```

A1 delivers the bones only:

| Area | Module | Runtime wiring in A1 |
|---|---|---|
| Shared contracts + job state machine | `src/shared/agents.ts` | none |
| Agent scopes + principal grants | `src/gateway/config.ts` | scopes parse; grants default to deny |
| Pure authorization helpers | `src/gateway/agentAuthz.ts` | none (A2 wires into tools) |
| MCP tool contract schemas (9 tools) | `src/gateway/agentSchemas.ts` | **not registered** with `buildServer()` |
| Trusted config parser/validator | `src/executor/agentConfig.ts` | **not loaded** at startup |
| Example trusted config | `config/agents.example.yaml` | example only; `agents.yaml` optional and absent |

## 2. MCP tools (all nine now registered)

```text
agents_list      agent_projects
agent_dispatch   agent_status   agent_result   agent_diff   agent_cancel
agent_apply      agent_discard
```

All nine Agent Control Plane tools are now registered and operational.

All nine input/output contracts are strict Zod objects in `src/gateway/agentSchemas.ts`:

- **Unknown properties are rejected.** Callers cannot smuggle `hostPath`, `cwd`, `image`,
  `runnerImage`, `mounts`, `volumes`, `privileged`, `networkMode`, `dockerSocket`, or anything else
  (unit-tested per field per tool).
- **Bounded everywhere.** Prompt ≤ 32,768 chars (`MAX_AGENT_PROMPT_CHARS`, matching the existing
  32 KiB command-cap magnitude); diff chunks ≤ 256 KiB (matching the exec output cap); summary
  ≤ 16,384 chars; changed-file list ≤ 1000 workspace-relative paths.
- **Logical IDs only.** `project` is a registry ID (`^[a-z0-9][a-z0-9_-]{0,63}$` — the proven
  target-ID grammar); `jobId` is `job_` + 32 hex chars; backends/profiles/policies are closed enums.
- **No transcript dumps.** `agent_result` returns a concise summary plus `AgentEvidenceRef`
  hashes/sizes; `agent_diff` returns bounded chunks with a full-diff hash, truncation flag and
  opaque cursor. There is no unbounded raw field anywhere.
- **`agent_apply` takes no patch text.** Apply operates on stored, verified job evidence only.
- **`agent_projects` never emits `hostPath`** (strict output schema, unit-tested).
- `sessionPolicy: new | resume` is representable for A8; A2 must reject `resume` explicitly.

Note on registration (A2): the MCP SDK's `registerTool` takes raw shapes; when A2 registers these
tools it must preserve strict semantics (reject-unknown), not downgrade to Zod's default stripping.

## 3. Scopes and authorization matrix

Four new scopes extend the closed `Scope` union (now 11):

```text
agents:read   agents:dispatch   agents:cancel   agents:apply
```

Matrix (implemented in `authorizeAgentTool()`, `src/gateway/agentAuthz.ts`):

| Tool | Scope | Additional requirements |
|---|---|---|
| `agents_list` | `agents:read` | results filtered to own grants |
| `agent_projects` | `agents:read` | results filtered to own grants |
| `agent_status` | `agents:read` | job ownership |
| `agent_result` | `agents:read` | job ownership |
| `agent_diff` | `agents:read` | job ownership |
| `agent_dispatch` | `agents:dispatch` | project grant + backend grant + profile grant |
| `agent_cancel` | `agents:cancel` | job ownership |
| `agent_apply` | `agents:apply` | job ownership + project grant (job's project) |
| `agent_discard` | `agents:dispatch` | job ownership |

Rules:

- **Deny by default.** Missing scope, missing grant, missing job ref, or foreign job ⇒ deny.
- **Job ownership is exact principal identity.** There is **no cross-principal administrative
  override** in v1.
- **Target permission never implies agent permission** (unit-tested: a full-target principal gets
  zero agent access).
- Permissions are never inferred from prompt text or session history.

## 4. Principal agent grants

`Principal` gains three optional allowlists in `config/clients.yaml`:

```yaml
projects: ["example-project"]   # logical agent project ids
agentBackends: ["kiro"]
agentProfiles: [audit, plan]
```

- Absent/empty ⇒ **deny** (backward compatible: every pre-A1 client parses unchanged and has zero
  agent privileges).
- `"*"` means **every entry of the trusted configured registry** — never arbitrary host
  paths/backends. This mirrors the proven `targets: ["*"]` semantics.

## 5. Job state machine

Implemented as a pure transition validator in `src/shared/agents.ts`
(`canTransitionAgentJob` / `assertAgentJobTransition`, full-matrix unit tests):

```text
QUEUED -> PREPARING -> RUNNING -> VALIDATING -> COMPLETED -> APPLIED
                                                        \-> DISCARDED
```

Failure/termination statuses (each terminal, never collapsed into a generic ERROR):

```text
FAILED_PRECONDITION   (from QUEUED, PREPARING)
FAILED_POLICY         (from any active state)
FAILED_AGENT          (from RUNNING, VALIDATING)
FAILED_TIMEOUT        (from PREPARING, RUNNING, VALIDATING)
FAILED_INFRASTRUCTURE (from any active state)
CANCELLED             (from any active state)
```

Invariants:

- **`COMPLETED` ≠ `APPLIED`.** Completion means evidence exists; application is a separate,
  explicitly authorized one-time transition.
- `APPLIED` and `DISCARDED` are immutable final dispositions.
- Failure statuses never resume. **A retry is a new job**, never mutation of historical truth.
- Invalid transitions throw `BridgeError('INVALID_JOB_TRANSITION', …, 409)`.

The failure taxonomy later determines retryability and operator action; A2+ must preserve the
distinctions.

## 6. Trusted configuration model (`config/agents.example.yaml`)

Executor-owned, example-only in A1 (`config/agents.yaml` is optional, absent, and never required
for startup). Parsed/validated by `src/executor/agentConfig.ts` (strict: unknown keys, duplicate
IDs, dangling references, bad limits all rejected). Four sections:

**Project registry** — `id` (strict grammar), `hostPath` (**absolute**, trusted, never accepted
via MCP, never resolved/mounted in A1), `gitRequired`, allowed `backends`, allowed `profiles`,
`guardedPaths` (future apply-policy deny list).

**Backends** — `kiro`, `copilot`: `enabled`, supported `profiles`, `defaultResourcePolicy`.
Deliberately **no `transport` field**: the Copilot transport (SDK vs ACP vs programmatic CLI) is an
A7 decision and must not be fossilized in config. Runner images are pinned trusted configuration of
the adapter phase — never caller-supplied.

**Profiles** (enforcement policy, not prompt templates) — `audit`, `plan`, `implement`, `review`;
each specifies `workspaceAccess` (`read-only`/`sandbox-write`), `shellPolicy`
(`none`/`read-only`/`validation`), `gitPolicy` (`none`/`read`/`sandbox`), `networkPolicy`, and a
default resource policy. `sandbox-write` is reserved for writer profiles (`implement` only in v1) —
the validator rejects anything else. A1 specifies; A3+ enforce at the container/OS layer.

**Resource policies** — `economy`, `standard`, `deep`; deterministic integer units:

```text
modelClass            fast | standard | deep   (provider-neutral; adapters pin concrete models)
maxRuntimeMs          time budget
maxCpuMillicores      1000 = one CPU (no float ambiguity)
maxMemoryBytes / maxPids / maxOutputBytes / maxEvidenceBytes
maxProviderCredits    optional; provider-specific units — Kiro and Copilot credits are NOT
                      economically comparable and no dollar cost is derived from them
networkPolicy         deny | backend-only
retentionClass        ephemeral | short | audit
```

## 7. Writer policy (v1)

```text
maximum active global writer jobs      = 1
maximum active writer jobs per project = 1
```

Fixed in code as `AGENT_WRITER_POLICY_V1`; persisted, restart-safe enforcement begins A2. Writer
lock scope includes apply operations (A6).

## 8. Results, usage and evidence

- Default results are **concise structured summaries**; large evidence (transcript, logs, full
  diff) stays local and is retrieved on demand via bounded tools.
- `AgentUsage` supports `usageAvailable: false` as an honest first-class answer — metrics are
  **never fabricated** as zeros, and there is no invented `estimatedCost` field.
- `AgentResourceTelemetry` (runtime, peak CPU/memory, sandbox/evidence/output bytes, process count)
  is typed in A1; collection begins A3+.
- Retention is an explicit policy (`ephemeral`/`short`/`audit`); no irreversible cleanup behavior
  is hardcoded in A1.

## 9. Network-plane separation

Three planes, permanently distinct:

```text
PUBLIC CONTROL PLANE     Tailscale Funnel -> MCP Gateway
PRIVATE OPERATIONS PLANE future tailnet-only operations/admin path
AGENT DATA PLANE         runner -> controlled backend provider egress
```

Runner egress semantics in v1 are `deny` or `backend-only` — **`unrestricted` does not exist** as
an ordinary policy value. A3 resolves real backend egress.

**Invariant:** Agent Dispatch must never receive permission to run `tailscale serve`,
`tailscale funnel`, or tailnet policy changes as part of normal implementation work. Tailscale
remains host infrastructure outside the agent capability plane. A1 changes no Tailscale/Funnel/ACL
state.

## 10. Directions locked for later phases

- **Persistence (A2):** SQLite, executor-owned, persistent volume; exact Node binding deferred to
  A2 (no SQLite dependency or database exists in A1).
- **Sandbox (A3):** trusted source → executor-controlled staging → Docker-managed job storage →
  runner RW sandbox. A write-capable agent never receives the real project as an ordinary RW
  workspace.
- **Kiro (A4):** ACP transport; isolated `KIRO_HOME`; dedicated automation `KIRO_API_KEY`;
  selective trusted tools; no inherited personal Kiro state.
- **Copilot (A7):** transport decision deferred — compare SDK vs ACP vs programmatic CLI; least
  privilege mandatory; no dependency on `--allow-all-tools`/`--allow-all`/`--yolo` is encoded
  anywhere in A1.
- **Apply (A6):** applies stored verified evidence under base-state verification, guarded paths,
  one-time disposition.

## 11. Phase boundaries

| Phase | Adds | Status |
|---|---|---|
| A1 | contracts, scopes, grants, state machine, config schema, docs, tests | COMPLETE |
| A2 | durable SQLite job engine, deterministic fake backend, six activated tools, persistence, recovery, cancellation | COMPLETE |
| A3 | runner sandbox, Docker client expansion, resource enforcement, egress policy | COMPLETE |
| A4 | real Kiro ACP backend (read-only audit profile) | COMPLETE |
| A5 | sandboxed Kiro implementation profile (workspace write, validation execution) | COMPLETE |
| A6 | guarded agent_diff/agent_apply/agent_discard, retained-resource lifecycle | COMPLETE |
| A7 | GitHub Copilot backend | NOT STARTED |
| A8 | session continuity | NOT STARTED |
| A9 | production hardening + E2E | NOT STARTED |

## 12. Security invariants (unchanged and extended)

- Gateway: public boundary, auth/authz/rate-limit/audit, **no docker.sock**.
- Executor: private, no published ports, Docker authority.
- Agent runners (implemented in A3-A5): no docker.sock, no privileged mode, no arbitrary host
  filesystem, no caller-controlled Docker options.
- Public callers: logical IDs only — never host paths, runner images, volume sources, Docker
  networks, or privilege/capability flags.
- The original 14 MCP tools remain unchanged and compatible; all nine agent tools are live, for a
  current operational surface of **23**. (For historical reference: the live agent tool count was
  **0** in A1 and **6** in A2.)
- Secrets (API keys, `KIRO_API_KEY`, GitHub tokens, OAuth state) never appear in config examples,
  MCP results, or logs; only `agents.example.yaml` ships — never a live `agents.yaml`.
