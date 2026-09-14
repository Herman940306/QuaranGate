# P3 Post-A8 Reconciliation

Date: 2026-09-14

## Scope

This record reconciles the immutable P3 core, the independently developed MCP connector incident work, and the final connector-adjacent P3 source gap before any further live deployment.

It does not claim live provider acceptance, connector stability, or production soak acceptance.

## Authoritative Linear Source Chain

The sole forward source line is `integrate/quarangate-forward`.

Linear ancestry before this reconciliation:

1. A8 forward integration: `5d375bd93ec62f714f9f65ed52088d4815ba2e7d`
2. P3 core: `fa13327a0fc9380cabf05c593e69d4aaeba102e2`
3. Connector telemetry integration: `6bbfdab40f36b678366954c099b255db43758d9f`
4. Public Funnel diagnostics: `3d4dbb3a3df40b3d292e025cbe9beedbf09b5fb2`
5. Connector integration evidence: `2eb23958ff5c224cb044680acd8a07e534b21b90`

The connector commits are descendants of the immutable P3 core. They do not replace or bypass it.

## Connector Incident Reconciliation

Current incident classification remains:

`ROOT_CAUSE_PARTIALLY_VERIFIED`

Verified local failure mechanism:

- QuaranGate deployment recreates the sole gateway container serving `/mcp`.
- Tailscale Funnel remains available while `127.0.0.1:8787` temporarily has no gateway listener.
- Historical tailscaled evidence captured backend connection refusals and an earlier reverse-proxy body-copy EOF during deployment windows.

Still open:

- the reproduced ChatGPT connector/account HTTP 400 cannot yet be classified as no-ingress, OAuth ingress, MCP ingress, or external connector handling;
- no live authenticated production soak has been run against the connector telemetry candidate;
- no permanent deployment/control-plane decoupling has been implemented.

The integrated incident source adds only bounded observability and diagnostics. It does not weaken refresh-token rotation, authentication, Funnel, TLS, firewall, credential, or owner-host boundaries.

## P3 Retry Guidance Reconciliation

The P3 core already implemented and bounded provider `retryAfterMs` inside the executor, including a frozen maximum of 15 minutes. Source inspection after connector integration found one remaining contract gap:

- executor error JSON contained bounded `retryAfterMs`;
- `src/gateway/executorClient.ts` reconstructed `BridgeError` without that field;
- `src/gateway/agentTools.ts` returned only `error` and `message` for agent-tool failures.

This reconciliation closes that source gap without changing provider admission logic:

- `executorClient` accepts only a positive safe-integer `retryAfterMs`, clamps it again to `MAX_PROVIDER_RETRY_AFTER_MS`, and otherwise omits it;
- `agentGuarded()` includes the already-sanitized `retryAfterMs` only when present;
- audit metadata is unchanged and does not include retry metadata, prompts, headers, credentials, or provider payloads.

A real loopback executor HTTP wiring test proves:

- valid `7000` ms survives executor -> gateway client -> MCP agent-tool error;
- an oversized value is clamped to the frozen 15-minute maximum;
- negative, zero, string, and null values are omitted.

## Capability Status Decision

No capability-status promotion is authorized by this source reconciliation.

The following existing runtime declarations remain deliberately unchanged until live evidence exists:

- `sessionContinuity: NOT_QUALIFIED`
- `providerAdmissionControl: DEFERRED`

Kiro and Copilot live-provider qualification remains deferred by owner decision while the required external subscriptions/entitlements are inactive. This is an external qualification deferral, not a source failure and not a PASS.

## Validation

Fresh validation on the forward worktree after retry-guidance implementation:

- focused retry propagation wiring: `6 / 6 PASS`;
- full unit suite: `2254 / 2254 PASS` across `66 / 66` files;
- TypeScript typecheck: `PASS`;
- build: `PASS`;
- runnable non-Docker integration: `12 / 12 PASS`;
- `bash -n scripts/diagnose-mcp-connector.sh`: `PASS`;
- `node --check scripts/mcp-soak.mjs`: `PASS`;
- `git diff --check`: `PASS`.

ShellCheck is not installed on the current `projects-work` execution surface, so no new ShellCheck result is claimed here. The connector implementation lane previously reported ShellCheck PASS for its immutable source candidate.

## Deployment State

Current live QuaranGate runtime remains exact A8 revision:

`5d375bd93ec62f714f9f65ed52088d4815ba2e7d`

Durable owner-host deployment job:

`ohj_93ea547d191b88dbc94b0cde782d9749`

completed `SUCCEEDED / exit 0` for that exact revision.

Neither P3 core nor the connector telemetry/retry-guidance descendant is deployed by this reconciliation.

The isolated incident-branch recommendation to deploy `250ec6da41799346820559669c608e9e867a9b17` alone is not adopted as the default continuation because it would intentionally diverge runtime from the authoritative single forward source line and would require another deployment to qualify P3. The preferred path is one independently reviewed forward descendant and one bounded deployment.

## Required Next Gates

Before deployment:

1. freeze the exact reconciled forward descendant;
2. perform an independent read-only review of that immutable candidate;
3. reconcile project-control truth to the reviewed descendant;
4. authorize exactly one bounded owner-host deployment.

After deployment, without weakening auth or provider controls:

1. prove exact build/runtime revision and startup identity;
2. repeat local and public Funnel TLS/H1/H2 controls;
3. run the production authenticated MCP soak with at least 500 requests and a 30-minute observation window;
4. run the bounded workload/concurrency matrix;
5. correlate a fresh ChatGPT connector failure, if reproduced, against sanitized HTTP/OAuth/MCP telemetry at the same timestamp;
6. classify connector stability only from that evidence.

Live Kiro/Copilot provider calls are not required to complete the connector/runtime observability gate and remain externally deferred until subscription/entitlement is available.

## Current Classification

- P3 source reconciliation: `CANDIDATE / VALIDATED / PENDING_INDEPENDENT_REVIEW`
- P3 live qualification: `OPEN`
- connector source observability: `VALIDATED`
- connector runtime observability: `NOT_DEPLOYED`
- connector stability: `UNVERIFIED / OPEN`
- Kiro live-provider qualification: `DEFERRED_EXTERNAL_SUBSCRIPTION`
- Copilot live-provider qualification: `DEFERRED_EXTERNAL_SUBSCRIPTION`
- deployment performed by this batch: `NO`
