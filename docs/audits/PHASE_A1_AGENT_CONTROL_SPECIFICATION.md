# PHASE A1 — AGENT CONTROL PLANE CONTRACT & ENFORCEMENT SCAFFOLDING

**Document ID:** MIB-A1-AUDIT
**Program:** Governed Agent Dispatch (ChatGPT → MCP IDE Bridge → Kiro / GitHub Copilot workers)
**Phase executed:** 2026-07-28
**Implementer:** Claude Fable 5 (senior implementation engineer session)
**Starting HEAD:** `f179ba19a8beed412d51202691675e9539595bd0` — `docs: close agent dispatch phase A0`
**Implementation commit:** `c3cd057a5bfa9e61dc9f6d448db5e5647c7a1a73` — `feat: define agent control plane contracts`
**Verdict:** **A1 COMPLETE — PASS. READY FOR A2.**

---

## 1. Objective

Convert the approved Agent Dispatch architecture into strongly typed contracts, validated trusted
configuration, authorization primitives, job-lifecycle rules, strict MCP schemas, security
invariants, tests and documentation — **without activating Agent Dispatch**. A1 builds the bones;
A2 builds the asynchronous job engine and deterministic fake backend.

## 2. Files changed (implementation commit `c3cd057`)

**Added:**

```text
src/shared/agents.ts                        shared contracts + pure job state machine
src/gateway/agentAuthz.ts                   pure authorization matrix helpers
src/gateway/agentSchemas.ts                 strict Zod contracts for 9 planned tools (not registered)
src/executor/agentConfig.ts                 trusted config parser/validator (not loaded at startup)
config/agents.example.yaml                  EXAMPLE ONLY trusted registry (neutral paths)
docs/AGENT_CONTROL_PLANE.md                 code-adjacent A1 contract specification
tests/unit/agent-statemachine.test.ts       10 tests
tests/unit/agent-authz.test.ts              18 tests
tests/unit/agent-config.test.ts             13 tests
tests/unit/agent-schemas.test.ts            12 tests
```

**Modified:**

```text
src/gateway/config.ts                       Scope union 7 -> 11; principal agent grants (deny-by-default)
src/shared/errors.ts                        + INVALID_JOB_TRANSITION error code
scripts/validate-config.mjs                 new scopes, grant checks, optional agents-config validation
config/clients.example.yaml                 labeled example agent clients (high-privilege example disabled)
docs/ARCHITECTURE.md                        Agent Control Plane (specification-only) section
docs/SECURITY.md                            agent scopes + contract security properties section
```

## 3. Contracts introduced

- **IDs:** `AgentBackendId` (`kiro`, `copilot`), `AgentProfileId` (`audit`, `plan`, `implement`,
  `review`), `ResourcePolicyId` (`economy`, `standard`, `deep`), `AgentProjectId`
  (grammar `^[a-z0-9][a-z0-9_-]{0,63}$`), `AgentJobId` (`^job_[0-9a-f]{32}$`).
- **Records:** `AgentJob`, `AgentResult`, `AgentDiff`, `AgentUsage` (supports
  `usageAvailable: false`; no fabricated metrics, no invented dollar cost), `AgentEvidenceRef`,
  `AgentResourceTelemetry`, `AgentResourceLimits`/`AgentResourcePolicy`, `AgentProfilePolicy`.
- **Bounds:** `MAX_AGENT_PROMPT_CHARS = 32768`; diff chunk ≤ 256 KiB; summary ≤ 16384 chars;
  changed files ≤ 1000 workspace-relative paths.
- **Writer policy v1:** `AGENT_WRITER_POLICY_V1` = 1 global writer / 1 writer per project;
  `implement` is the only writer profile.

## 4. Job state machine

Pure validator (`canTransitionAgentJob`/`assertAgentJobTransition`, invalid ⇒
`BridgeError('INVALID_JOB_TRANSITION', 409)`), full-matrix unit-tested:

```text
QUEUED -> PREPARING -> RUNNING -> VALIDATING -> COMPLETED -> APPLIED | DISCARDED
FAILED_PRECONDITION  from QUEUED, PREPARING
FAILED_POLICY        from any active
FAILED_AGENT         from RUNNING, VALIDATING
FAILED_TIMEOUT       from PREPARING, RUNNING, VALIDATING
FAILED_INFRASTRUCTURE, CANCELLED from any active
```

All failures and both dispositions are terminal (retry = new job). `COMPLETED ≠ APPLIED`.

## 5. Scope changes

`Scope` union extended from 7 to 11: `agents:read`, `agents:dispatch`, `agents:cancel`,
`agents:apply` — updated consistently in `src/gateway/config.ts` (`Scope` + `ALL_SCOPES`),
`scripts/validate-config.mjs`, and `config/clients.example.yaml`. Unknown scopes remain silently
filtered (fail-closed). Existing principals receive **zero** agent privileges (tested).

## 6. Authorization matrix (implemented + tested, wired in A2)

| Tool | Scope | Plus |
|---|---|---|
| `agents_list`, `agent_projects` | `agents:read` | grant-filtered results |
| `agent_status`, `agent_result`, `agent_diff` | `agents:read` | job ownership |
| `agent_dispatch` | `agents:dispatch` | project + backend + profile grants |
| `agent_cancel` | `agents:cancel` | job ownership |
| `agent_apply` | `agents:apply` | job ownership + project grant |
| `agent_discard` | `agents:dispatch` | job ownership |

No cross-principal administrative override exists. Target permission ⇏ agent permission (tested).
Principal grants: `projects` / `agentBackends` / `agentProfiles`; absent = deny; `"*"` = whole
trusted registry only.

## 7. Trusted configuration schema

`src/executor/agentConfig.ts` (strict Zod + cross-reference validation; not wired to startup):
sections `backends` (no transport field — A7 decision protected), `projects` (id grammar, absolute
`hostPath`, `gitRequired`, allowlists, `guardedPaths`), `profiles` (enforcement policy;
`sandbox-write` rejected on non-writer profiles), `resourcePolicies` (integer units: millicores,
bytes, ms, pids; `maxProviderCredits` optional and provider-specific). Rejects unknown keys,
duplicates, dangling references, relative host paths, out-of-bounds limits. Example:
`config/agents.example.yaml` (neutral `/srv/projects/...` paths; no live `agents.yaml` exists).

## 8. Tool contract schemas (definitions only)

Nine strict contracts in `src/gateway/agentSchemas.ts`: `agents_list`, `agent_projects`,
`agent_dispatch`, `agent_status`, `agent_result`, `agent_diff`, `agent_cancel`, `agent_apply`,
`agent_discard`. All inputs/outputs `.strict()`; injection of `hostPath`, `cwd`, `image`,
`runnerImage`, `mounts`, `volumes`, `privileged`, `networkMode`, `dockerSocket` is rejected per
tool per field (tested). `agent_apply` accepts no patch text. `agent_projects` output cannot carry
`hostPath`. `agent_diff` is chunked/hashed/cursor-bounded. `sessionPolicy: new|resume` is
representable; A2 must reject `resume` explicitly.

## 9. Network-plane invariants

Recorded in contracts and docs: PUBLIC control plane (Funnel → gateway), PRIVATE operations plane
(future tailnet-only), AGENT data plane (runner → controlled backend egress). `NetworkPolicy` is
`deny | backend-only` only — `unrestricted` does not exist. Agent Dispatch may never run
`tailscale serve`/`funnel` or change tailnet policy. A1 changed no Tailscale, Docker, or compose
state.

## 10. Validation evidence (newly executed for A1)

```text
git diff --check      PASS (clean)
npm run typecheck     PASS
npm test (unit)       73 / 73 PASS  (20 pre-existing + 53 new)
npm run build         PASS
validate-config       PASS (live clients.yaml 6 clients + bridge.yaml; agents.yaml correctly optional/absent)
validate-config with AGENTS_CONFIG=config/agents.example.yaml   PASS
secret scan of changed content                                  PASS (no keys/tokens/private paths)
```

**Historical evidence NOT rerun:** live integration suite — historical baseline **40/40 PASS**
(pre-A0). A1 registers no MCP tools and alters no runtime orchestration, so live-stack integration
was not required for this specification-only phase. The live Docker stack was not restarted,
rebuilt, or modified.

## 11. No-agent-runtime proof

Verified from source at the implementation commit:

```text
CURRENT_OPERATIONAL_MCP_TOOLS = 14   (11 direct registerTool calls + gitTool helper × 3 in src/gateway/mcp.ts)
AGENT_OPERATIONAL_MCP_TOOLS   = 0    (zero registerTool references in any new module)
Executor agent routes         = none (no 'agent' reference in src/executor/index.ts)
Dockerfile / compose.yaml / test-target / networks / volumes / ports = untouched
Dependencies                  = unchanged (no SQLite, no SDKs, no queue/database libraries)
Kiro / Copilot processes      = never started
```

## 12. Known deferred decisions

- **A2:** SQLite binding selection (`node:sqlite` vs alternatives); executor persistent job volume;
  job engine + deterministic fake backend; first tool registration (strict-semantics preservation
  when adapting `.strict()` contracts to SDK raw shapes); explicit rejection of
  `sessionPolicy: resume`; persisted writer-lock enforcement.
- **A3:** Docker client expansion (create/volumes/limits); sandbox staging/copy policy details;
  runner egress resolution; telemetry collection; orphan reconciliation.
- **A4:** Kiro ACP adapter; `KIRO_HOME` isolation proof; `KIRO_API_KEY` provisioning; concrete
  model pinning for `modelClass`.
- **A6:** apply transaction mechanics; guarded-path enforcement; dirty-tree/binary-diff policy.
- **A7:** Copilot transport comparison (SDK vs ACP vs programmatic CLI) under mandatory least
  privilege.

## 13. A2 entry conditions

1. Repository at the A1 closeout commit, clean tree.
2. Contracts in this phase are the binding interface: A2 implements against
   `src/shared/agents.ts`, `src/gateway/agentAuthz.ts`, `src/gateway/agentSchemas.ts`,
   `src/executor/agentConfig.ts` without weakening any strict/deny-by-default property.
3. Persistence decision executed A2-side (SQLite binding evaluation) with an executor-owned volume
   (first compose change of the program).
4. Fake backend must exercise the full state machine including every failure code and both
   dispositions.

## 14. Secret safety

No credentials, key hashes of real clients, tokens, `.env` content, or Herman-specific host paths
appear in any changed file (scanned before commit). Example configs use placeholder hashes and
neutral `/srv/projects/...` paths. No live config file was created or committed.

## 15. Deviations

1. **`INVALID_JOB_TRANSITION` added to `BridgeErrorCode`** — a minimal error-model extension so the
   state machine throws typed, fail-closed errors consistent with the existing model. Additive;
   no existing code path emits it yet.
2. **`estimatedCost` deliberately omitted** from `AgentUsage`: §21 forbids fabricated economics and
   provider credits are not comparable across backends; the honest representation is
   provider-unit credits + `usageAvailable`.
3. None otherwise: no new dependencies, no Docker/compose changes, no tool registration, no
   Tailscale changes, no agent execution.

## 16. A0 hash reconciliation

The A0 closeout introduced a self-referential hash problem (a commit cannot contain its own final
SHA). Recorded here and in the Master PRD tracker: the **actual final A0 closeout commit is
`f179ba19a8beed412d51202691675e9539595bd0`** (`docs: close agent dispatch phase A0`), superseding
the pre-amend `e59703a` reference. Maintenance rule adopted (PRD §46): a commit must never be
required to contain its own final SHA; phase evidence hashes are recorded by the subsequent
documentation closeout commit or a later checkpoint.
