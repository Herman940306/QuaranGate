# FE1 preflight handoff — contract blocked

Status: **STOPPED BEFORE IMPLEMENTATION**. No FE1 candidate or acceptance claim.

## Identity and authority

- Worktree: `/home/herman/projects/QuaranGate-product-fe1-gpt`
- Branch: `feature/qg-product-fe1-existing-backend-gpt`
- HEAD/common base: `5fc68fe23918dfca764a3b5e6de8eb73ede2167c`
- Tree: `3a490302868c035460fe730f19cce30ca647243b`
- Initial working tree clean; staging empty. Owner prompt A-005 assigns Agent A sole writer.
- Current prompt establishes F1 acceptance and FE1 scope; historical F1/BE0 candidate handoffs are reference material.
- Preflight used root/frontend AGENTS instructions and current source. No live endpoint, credentials, or running service was inspected.

## Required orchestrator / Agent B contracts

### CR-001: same-origin operational transport

The gateway owns authenticated `POST /mcp` in `src/gateway/index.ts`. Existing Console is mounted at `/console` by `src/gateway/consoleWeb.ts`, on that gateway origin. The separate Next product frontend has no MCP route, rewrite, or checked-in shared-origin ingress arrangement: `frontend/next.config.ts` defines headers only; `frontend/src/proxy.ts` handles the development design route only; no app route handlers exist at this base.

Request: establish and document how product-origin `POST /mcp` reaches the existing gateway. Orchestrator/Agent B must supply the owned routing change or a verified same-origin hosting contract before FE1 integration. Preserve JSON-RPC IDs, JSON/SSE response semantics, HTTP authentication/denial status, `X-QuaranGate-Request-Id`, cancellation behavior, and the gateway's canonical principal checks. Do not add arbitrary upstream URL selection or a product-role authority shortcut. Authentication for the transitional adapter must remain explicit and memory-scoped; product identity/principal mapping acceptance remains a production-promotion gate.

This request does not authorize a config, server, ingress, deployment, or backend change by Agent A.

### CR-002: bounded current-job discovery or explicitly reduced Jobs scope

All nine current ACP tools were inspected. `agent_status` requires a known `jobId`; `agent_projects` lists projects and `agents_list` lists backends. There is no public current-job list. Control Center `providers`/`statistics` expose active/queued counters, not job identities/status rows; those counters must not be presented as principal-owned job records. Audit activity is bounded in-memory telemetry and is not a durable job inventory.

Request: either explicitly authorize a known-job-ID lookup-only Jobs page (with discovery marked unavailable), or assign the backend owner a bounded principal-owned job metadata list contract. If a list is chosen, define scope, ownership/project filtering, pagination/limit, ordering, freshness, safe fields, and error/result semantics; omit prompts, credentials, raw provider output, host paths, and artifact contents. Do not add dispatch or mutation authority. Agent A will not invent or implement this API.

## Existing contracts verified for later reuse

| Surface | Current source contract | FE1 implication |
|---|---|---|
| Targets | `targets_list({})`, `target_inspect({target})` in `src/gateway/mcp.ts`; `targets:read` and explicit target grants | List exposes running state; optional inspected health must remain unknown when absent. List has no caller pagination/limit; frontend can cap displayed rows but must disclose that it does not bound upstream enumeration. |
| Direct operations | Target logs/start/stop/restart; filesystem list/stat/read/search/write/patch/delete; terminal execution; Git status/diff/log; process list, registered in `src/gateway/mcp.ts` | Existing scope/target checks and executor confinement remain authoritative; these capabilities must not be rebuilt. |
| ACP | Nine tools in `src/gateway/agentTools.ts`, schemas in `src/gateway/agentSchemas.ts`, lifecycle in `src/shared/agents.ts` | Known-job status/result/diff and separate guarded apply/cancel/discard exist. COMPLETED is reviewable evidence, not APPLIED. Scope possession is not proof that runtime action preconditions pass. |
| Git | `git_status`, `git_diff`, `git_log`, target argument; `git:read` plus target grant | Returns execution envelope including exit code, timeout/truncation and stdout/stderr; HTTP success alone is not Git success. |
| GitHub | 17 tools in `src/gateway/githubTools.ts`; bounded read parameters and independent account/project grants | Discovery/read do not confer write/review authority; merge, force push and arbitrary remote APIs remain absent. |
| Control Center | `control_center_query({view, limit?, sinceMs?, ...})`, limit 1–200; requires `targets:read`; `generatedAt` and metadata data object | Summary, authority, topology, providers, capabilities and recovery can support truthful summaries after CR-001. UNKNOWN, deferred and not implemented states must remain explicit. |
| Authentication | Gateway accepts existing Bearer or X-API-Key, resolves enabled Principal; OAuth maps to the same authority model | Product roles grant no operational access. No session/URL/storage credential persistence. No credential used in preflight. |
| Errors/correlation | Auth failures use HTTP JSON-RPC errors; tool failures use `isError` and JSON text `{error,message}`; success uses structuredContent plus JSON text; request header `X-QuaranGate-Request-Id` | Future purpose-specific adapter must validate envelopes/IDs, map denial and unavailable states, retain safe correlation, and avoid raw stack/error copy and secret logging. |

## Implementation, checks, and governance

No client, UI, route, fixture, or test was created. F1 shell/design and existing Console are untouched. New frontend source files therefore need no README inventory entries in this stop handoff.

Only this FE1 handoff and its adjacent preflight evidence manifest are created. Manifest records source hashes, static assertions and identity. Documentation JSON parsing and `git diff --check` are the applicable checks. Frontend typecheck/lint/unit/build/E2E/production smoke/audit/premium UI/axe/responsive/secret-scanner gates were not run: implementation stopped at the explicit contract boundary. No root Vitest run, live qualification, or production claim.

No Agent B/shared/backend/runtime/product-platform/canonical path changed. No stage, commit, push, merge, deploy, listener, credential access, or infrastructure mutation. No immutable FE1 candidate is frozen, so no acceptance review is requested. Resume only after orchestrator resolves the contract requests and confirms the resulting FE1 scope.
