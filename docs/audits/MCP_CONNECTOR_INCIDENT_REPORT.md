# MCP Connector Incident Report

## Executive Summary

Status: `ROOT_CAUSE_PARTIALLY_VERIFIED`.

Two locally controlled availability failures are mechanically proven:

1. QuaranGate deployments recreate the same gateway container that serves the
   ChatGPT MCP endpoint. During the A8 deployment, Tailscale Funnel received
   requests while `127.0.0.1:8787` was unavailable and logged connection
   refusals at `2026-09-14T06:04:29+02:00` and `06:04:31+02:00`.
2. During the earlier P1 deployment job, Funnel logged
   `ReverseProxy read error during body copy: unexpected EOF` at
   `2026-09-14T04:35:05+02:00`. The job ran from `04:33:10` to `04:35:59`
   SAST. The event proves a truncated backend response in that deployment
   window, but retained evidence does not identify the exact old gateway
   process transition.

A separate intermittent ChatGPT account/connector failure was reproduced:
four of five tiny connector calls passed, then the fifth failed before command
execution with HTTP 400 and `We couldn't connect your account. Please try
again.` The transcript provides only `~06:26 SAST`; exact seconds are
unavailable. Existing Wolf logging records tool completions and MCP auth/transport
errors, but not every HTTP or OAuth request. Therefore this reproduced 400
cannot yet be classified as `NO_INGRESS`, an unlogged local OAuth 400, or another
pre-tool connector failure.

No permanent root-cause claim is made for the intermittent 400. A metadata-only
arrival logger is implemented and source-tested in an isolated incident
worktree, but is not deployed. No runtime, Tailscale, firewall, credential, or
connector setting has been changed.

## Timeline

All times are SAST (`UTC+02:00`) unless explicitly suffixed `Z`.

| Time | Evidence | Status |
| --- | --- | --- |
| 2026-09-12 21:10:12 | `tailscaled.service` entered active/running; `NRestarts=0` at inspection | VERIFIED NOW |
| 2026-09-14 04:33:10–04:35:59 | Owner-host P1 deployment `ohj_88ecf6f6b1eede301d9011b31779029c`, `SUCCEEDED`, exit 0 | VERIFIED NOW |
| 2026-09-14 04:35:05 | Funnel `ReverseProxy read error during body copy: unexpected EOF` | VERIFIED NOW |
| 2026-09-14 06:02:05–06:04:53 | Owner-host A8 deployment `ohj_93ea547d191b88dbc94b0cde782d9749`, `SUCCEEDED`, exit 0 | VERIFIED NOW |
| 2026-09-14 06:04:29, 06:04:31 | Funnel could not dial `127.0.0.1:8787`: connection refused | VERIFIED NOW |
| 2026-09-14 06:04:34 | Current gateway container started | VERIFIED NOW |
| approximately 2026-09-14 06:26 | Five external tiny probes: four PASS, fifth ChatGPT account/connector HTTP 400 before command execution; exact seconds unavailable | ACCEPTED EVIDENCE |
| 2026-09-14 06:31:22 | Local readiness 200; public HTTP/1.1 and HTTP/2 readiness 200; TLS verification 0; gateway healthy, restart 0, no OOM; no matching Tailscale proxy error | VERIFIED NOW, but later than approximate failure time |
| 2026-09-14 06:52 | Final full unit suite, including telemetry, OAuth outcome and soak-client tests: 65 files / 2,230 tests PASS | VERIFIED NOW |
| 2026-09-14 06:45 | Diagnostic script completed against Wolf; local/public controls remained healthy | VERIFIED NOW |

## Known Facts

- Control worktree: `control/project-closure` at
  `39426de4163b0a630859838fd5533e2039e75d7b`; staging empty; reserved owner
  handoff remains untracked and unchanged at its expected SHA-256.
- Forward worktree initially matched `integrate/quarangate-forward` at
  `5d375bd93ec62f714f9f65ed52088d4815ba2e7d`, then acquired unrelated owner
  changes during this investigation. Those changes were not inspected or
  modified.
- Incident worktree: `/home/herman/projects/QuaranGate-mcp-connector-incident`,
  branch `incident/mcp-connector-reliability`, base `5d375bd...`.
- Tailscale `1.102.2`; Wolf Tailscale IPv4 `100.79.53.72`.
- Funnel is enabled at `https://wolf.taildc680e.ts.net` and proxies `/` to
  `http://127.0.0.1:8787`.
- Wolf-local DNS resolves the hostname to `100.79.53.72`; Cloudflare and Google
  public DNS instead returned Funnel relays `176.58.90.46`, `.63`, and `.145`.
  Verified relay-pinned H1/H2 readiness passed through all three at `06:53`
  SAST. It is a current external-relay control, not failure-time proof.
- The current gateway is `quarangate-gateway-1`, image
  `quarangate:gateway-5d375bd...`, image ID `sha256:4af9b6...`, healthy,
  restart count 0, OOM false, 512 MiB memory limit, 256 PID limit.
- The gateway is Node `v24.18.0`, Express `5.2.1`, MCP TypeScript SDK `1.30.0`.
- `/mcp` accepts POST with an 8 MiB JSON-parser limit. GET returns the expected
  stateless 405.
- OAuth is implemented locally: DCR, Authorization Code + PKCE S256, rotating
  refresh tokens, exact resource binding, one-hour access tokens and 30-day
  refresh tokens. Token values/hashes were not printed.
- At `06:31:42`, aggregate token metadata contained no expired access or
  refresh token. This is not time-correlated to the approximate `06:26` failure.
- Current gateway snapshot: about 51 MiB of 512 MiB, 12 PIDs; Node process 20
  FDs with a soft/hard limit of 1,048,576. No snapshot evidence of resource
  saturation.
- Certificate verification succeeds; leaf SAN is
  `wolf.taildc680e.ts.net`, valid 2026-07-27 through 2026-10-25.

## Request Path

See `MCP_CONNECTOR_REQUEST_PATH.md`.

## Observability

Deployed behavior before remediation:

- logs completed/denied tool decisions with UTC timestamp, request ID,
  principal, tool, decision, code and duration;
- logs MCP authentication and transport errors;
- does not log every HTTP arrival;
- does not log OAuth request status;
- does not share an HTTP-arrival request ID with tool audit.

Candidate behavior, not deployed:

- logs start and complete/aborted events for only known MCP/OAuth paths;
- records timestamp, method, safe path label, HTTP version, server-generated
  request/connection IDs, response status/duration, PID, process start and build
  revision;
- records only fixed server-defined OAuth failure categories, allowing an
  `invalid_grant` to be separated into code loss/binding, refresh expiry,
  missing/replayed refresh credential, client mismatch or resource mismatch;
- shares the HTTP request ID with MCP tool audit;
- emits `X-QuaranGate-Request-Id` for client-side correlation;
- never records headers, cookies, query strings, bodies, arguments, output,
  tokens, credentials, caller-provided request IDs, or raw peer addresses.

## Reproduction

See `MCP_CONNECTOR_REPRO_MATRIX.md`.

## Hypotheses

See `MCP_CONNECTOR_REPRO_MATRIX.md`. H19 (deployment/control-path coupling) is
verified. H13/H14/H18 remain open for the reproduced account-layer failure.

## Root Cause

`ROOT_CAUSE_PARTIALLY_VERIFIED`.

Verified local mechanism: the deployment script runs Compose `up -d` for the
gateway and executor. A gateway image change recreates the sole process bound to
the fixed Funnel backend. Funnel remains live and returns upstream failures
during the gap. This explains failures in deployment windows.

Unresolved mechanism: the intermittent ChatGPT HTTP 400 before tool execution.
The exact failed timestamp and HTTP/OAuth ingress records do not exist, so the
failing layer cannot yet be identified without inventing evidence.

## Fix

No runtime fix is deployed.

Implemented candidate prerequisite: safe request-arrival telemetry plus reusable
read-only diagnostics and an authenticated MCP initialize soak client. A design
for removing deployment downtime is intentionally deferred until its service
provenance, rollback and zero-downtime boundary are reviewed; a restart is not
being mislabeled as a fix.

## Security Impact

- No authentication, TLS, Tailscale ACL/Funnel scope, firewall, Docker
  authority, worker permission or secret changed.
- The logger uses only server-generated identifiers and an allowlist of safe
  path labels.
- Tests send synthetic secrets through Authorization, Cookie, query, JSON and
  refresh-token form inputs and prove those values do not enter telemetry.
- The soak client reads a mode-0600 bearer file and never prints or places the
  token in argv.

## Validation

See `MCP_CONNECTOR_FIX_VALIDATION.md`.

## Remaining External Dependencies

- A fresh failed ChatGPT connector call after telemetry deployment.
- Exact T0/T4 from the external client if the UI exposes them; otherwise use
  server request ID/status and a tightly bounded operator observation window.
- If a failure has no matching HTTP start while local/Tailscale controls pass,
  OpenAI connector/platform support becomes the remaining owner.

## Rollback Plan

Candidate source rollback before integration: remove the isolated incident
worktree/branch only after preserving its evidence or revert its future commit.

Future deployed rollback: redeploy the exact prior gateway/executor image tags
captured by the existing failure-atomic owner-host deployment mechanism. Do not
change Funnel, TLS, credentials or ACLs as rollback.

## Continuous Handoff

### BATCH_ID: MCP-INCIDENT-R0-DISCOVERY

- OBJECTIVE: Identify endpoint owner/path/restarts and determine whether current
  telemetry can classify a failed connector call.
- PRE_STATE: Control HEAD `39426de...`; forward HEAD `5d375bd...`; staging empty;
  only expected `node_modules` initially untracked.
- COMMANDS: Read-only Git identity/status; host/network/Tailscale/Compose/source
  inspection; sanitized Docker/tailscaled/kernel logs; local/public HTTP/TLS
  probes; sanitized OAuth aggregate metadata.
- OBSERVATIONS: Exact path and container identified; deployment refusals and one
  deployment-window EOF found; current resource/TLS/HTTP controls healthy;
  deployed HTTP/OAuth arrival logging insufficient.
- EVIDENCE: Exact timestamps and identities above.
- HYPOTHESIS: More than one failure class exists; deployment coupling is local;
  account-layer 400 may be local OAuth or external connector pre-ingress.
- RESULT: `ROOT_CAUSE_PARTIALLY_VERIFIED`.
- MUTATIONS: None.
- SECURITY_IMPACT: None.
- NEXT: Add safe telemetry in an isolated worktree, source-validate, then seek a
  separately controlled deployment/connector correlation gate.

### BATCH_ID: MCP-INCIDENT-R1-OBSERVABILITY-CANDIDATE

- OBJECTIVE: Create the minimum telemetry needed for the decisive timestamp
  correlation.
- PRE_STATE: Incident branch absent; forward worktree acquired concurrent owner
  changes and was preserved.
- COMMANDS: Created isolated worktree at immutable `5d375bd...`; added telemetry
  module/test and diagnostic/soak scripts; ran focused tests and typecheck.
- OBSERVATIONS: Telemetry and readiness tests pass; no runtime deployment yet.
- EVIDENCE: `3/3` telemetry tests, `22/22` readiness tests, typecheck PASS.
- HYPOTHESIS: The next connector 400 can be separated into no ingress, OAuth
  failure, MCP failure or client-receive failure from sanitized metadata.
- RESULT: `VERIFIED NOW` at source-test scope only.
- MUTATIONS: Incident worktree/branch and candidate files only.
- SECURITY_IMPACT: No secret logging; negative leakage tests PASS.
- NEXT: Validate scripts/full suite, review and commit immutable candidate before
  any separately authorized deployment.

### BATCH_ID: MCP-INCIDENT-R2-CANDIDATE-VALIDATION

- OBJECTIVE: Verify the complete source candidate and reusable diagnostics before
  any runtime mutation.
- PRE_STATE: Runtime remained on gateway/executor image `5d375bd...`; incident
  source remained isolated; forward worktree contained unrelated owner changes.
- COMMANDS: Full unit suite; typecheck; build; `git diff --check`; Bash syntax;
  ShellCheck for the shell diagnostic; Node syntax and local fake-server tests
  for the soak client; one end-to-end read-only diagnostic snapshot.
- OBSERVATIONS: All source checks passed. The diagnostic reported the exact
  Funnel/backend/container identity and healthy H1/H2/TLS controls without
  emitting credential values. The soak client rejects missing or overly broad
  credential-file permissions.
- EVIDENCE: 65 test files / 2,230 tests PASS; typecheck PASS; build PASS;
  corrected script checks PASS; diagnostic exit 0 at `06:45 SAST`.
- HYPOTHESIS: Metadata-only logging can close the current ingress-evidence gap
  without widening authority or exposing request content.
- RESULT: VERIFIED NOW at source/test scope only; runtime classification remains
  UNVERIFIED / OPEN.
- MUTATIONS: Candidate files in the incident worktree and temporary test files
  only; no production runtime or network mutation.
- SECURITY_IMPACT: Synthetic bearer values were absent from stdout/stderr;
  diagnostic output was metadata-only.
- NEXT: Complete exact patch review and freeze an immutable candidate before a
  governed deployment/correlation decision.
