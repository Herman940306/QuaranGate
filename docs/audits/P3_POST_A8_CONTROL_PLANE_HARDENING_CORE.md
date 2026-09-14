# P3 Post-A8 Control-Plane Hardening — Core Candidate

Date: 2026-09-14
Forward branch: `integrate/quarangate-forward`
Candidate parent: `5d375bd93ec62f714f9f65ed52088d4815ba2e7d`
Status: `READY_FOR_FREEZE` only after the final regression gate below is rerun on these exact bytes.

## Scope boundary

This candidate is the non-connector P3 core hardening batch on the single forward line. It intentionally does **not** modify Tailscale, MCP connector/listener configuration, connector diagnostics, or the gateway connector work being investigated independently by the IDE agent.

P3 overall is **not** declared closed by this document. Two connector-adjacent follow-ups remain deferred for reconciliation after the IDE agent returns:

1. propagate bounded provider `retryAfterMs` through any gateway/client contract that should surface it externally;
2. reconcile and, if supported by the accepted connector/gateway contract, promote runtime capability telemetry that still reports `sessionContinuity: NOT_QUALIFIED` and `providerAdmissionControl: DEFERRED`.

Those status strings are intentionally left unchanged here rather than claiming qualification that has not yet been reconciled end-to-end.

## Implemented controls

### Production backend truth / no fake fallback

Production now supplies `AgentJobEngine` with the exact set of real backend adapters wired at executor startup. An enabled backend is not reported available unless its real adapter is wired. Explicit provider dispatch fails closed when that runtime adapter is absent, and a null production factory result cannot silently instantiate `FakeAgentBackend`.

The historical fake backend remains available only through the intentional unit-test/fake-only seam where no production runtime-availability set is supplied.

### Credential lifecycle

Kiro credential material is no longer cached for the executor process lifetime. Each use revalidates credential-file metadata and rereads the file, so rotation or revocation is observed without requiring an executor restart.

### Durable bounded queue

`MAX_AGENT_QUEUED_JOBS = 64` is a product constant, not caller input. Admission is enforced under SQLite `BEGIN IMMEDIATE` for both ordinary dispatch and resume dispatch so concurrent callers cannot exceed the bound or bypass it through session reservation.

### Structured provider throttling

ACP provider throttling is recognized only from structured 429 evidence (`error.code`, `data.status`, `data.statusCode`, or `data.httpStatus`). Arbitrary prose is not interpreted as a rate limit.

Bounded provider retry metadata is accepted from structured `retryAfterMs` / `retry_after_ms` or seconds variants and clamped to the product maximum. `BridgeError` can carry the sanitized bounded `retryAfterMs` internally and in executor error JSON.

### Provider admission, backoff, cooldown and circuit state

Schema v7 adds `agent_provider_state`, containing only sanitized admission metadata:

- backend identifier;
- consecutive failure count;
- last failure timestamp/code;
- last success timestamp;
- cooldown-until timestamp;
- circuit state;
- update timestamp.

It stores no prompt, credential, provider response body, transcript, or arbitrary provider payload.

Frozen P3 core policy constants:

- base backoff: 5 seconds;
- maximum exponential backoff: 120 seconds;
- maximum jitter fraction: 20%;
- circuit opens after 3 consecutive provider failures;
- open-circuit minimum window: 5 minutes;
- provider Retry-After clamp: 15 minutes.

Admission is checked before queue insertion and again immediately before real provider construction, preventing already-queued work from bypassing a cooldown opened by earlier work. Successful real-provider completion resets durable provider failure/cooldown state. Structured throttling persists provider state before the job is terminalized.

A provider throttle that arrives after the job has entered `RUNNING` remains a job-level infrastructure failure because the frozen job state machine does not permit `RUNNING -> FAILED_PRECONDITION`; the separate durable provider admission record preserves the rate-limit cause and cooldown authority.

### Raw-prompt minimization

Mechanical source review found raw `job.prompt` is consumed for provider execution only while work is restartable/active. Result, review, apply, discard, evidence, and public status/result paths do not require it after execution becomes terminal.

P3 therefore uses a stronger lifecycle rule than an invented wall-clock TTL:

- raw prompt is retained only while status is `QUEUED`, `PREPARING`, `RUNNING`, or `VALIDATING`;
- terminal completion, failure, or cancellation purges the raw prompt body immediately;
- final `APPLIED` / `DISCARDED` transitions also enforce an empty prompt body;
- `prompt_hash` remains durable audit identity.

The v6 -> v7 migration also scrubs historical non-active prompt bodies while preserving restartable active/queued prompt bodies.

### Migration fail-closed boundary

A database stamped v6 is shape-validated **before** any v7 mutation. A malformed v6 database is rejected before creation of `agent_provider_state`, raw-prompt scrubbing, or version restamping. A database already stamped v7 must prove the complete v7 shape; it is not silently repaired.

### Startup / recovery ordering

`AgentJobEngine.recover()` now reconciles durable job/session state without starting queued provider work. Recovered queued work is kicked only after startup reconciliation has completed and the executor listening socket has successfully bound. If startup reconciliation or bind fails, queued provider work is not restarted.

## Mechanical validation on the dirty candidate

Returned evidence before this document was added:

- focused P3 prompt/migration/A8/engine/store matrix: **201/201 PASS**;
- full unit suite: **2241/2241 PASS across 62/62 files**;
- non-Docker retained-evidence lifecycle integration: **12/12 PASS**;
- TypeScript typecheck: **PASS**;
- build: **PASS**;
- `git diff --check`: **PASS**.

Earlier focused gates also returned:

- ACP throttle protocol: **22/22 PASS**;
- provider store/engine/ACP matrix: **107/107 PASS**;
- migration + A8 continuity matrix: **113/113 PASS**;
- startup-order + job-engine matrix: **56/56 PASS**;
- broader agent/A8/Ollama/startup matrix: **406/406 PASS**.

## Integration classification

`npm run test:integration` is **BLOCKED_ENVIRONMENT** on the `projects-work` worker and must not be reported as PASS.

Returned blockers were mechanical:

- Docker CLI absent (`spawnSync docker ENOENT`);
- Docker socket absent (`ENOENT /var/run/docker.sock`);
- `KEYS_ENV` absent for live-service integration helpers.

The deterministic non-Docker integration file that was runnable after the schema-v7 update passed **12/12**. No Docker/host authority was broadened merely to force the blocked integration suite to run.

## Coordination / non-overlap proof intent

This batch intentionally avoids connector/Tailscale/MCP-incident files. Before freeze, the exact dirty path set must be rechecked. Any unexpected connector-related path appearing in the forward worktree is a stop condition pending owner/IDE-agent reconciliation.

## Acceptance boundary

This document can support freezing **P3 core** on the existing forward branch only after the final exact-byte regression and candidate identity checks succeed. It does not authorize declaring P3 globally `CLOSED`, does not authorize connector changes, and does not convert the environment-blocked live integration suite into a pass.
