# MCP Connector Fix Validation

## Current Verdict

`ROOT_CAUSE_PARTIALLY_VERIFIED`.

No runtime fix is deployed. `CONNECTOR_STABILITY` and
`LOCAL_MCP_STABILITY` remain `UNVERIFIED / OPEN` for final acceptance.

## Candidate Source Validation

| Check | Result |
| --- | --- |
| `gateway-request-telemetry.test.ts` | VERIFIED NOW: 3/3 PASS |
| `gateway-readiness.test.ts` | VERIFIED NOW: 22/22 PASS |
| TypeScript `--noEmit` | VERIFIED NOW: PASS |
| Secret-negative telemetry assertions | VERIFIED NOW: Authorization, Cookie, query, JSON body and refresh-token form values absent |
| Build | VERIFIED NOW: PASS |
| Full unit suite | VERIFIED NOW: 65 files / 2,230 tests PASS |
| OAuth outcome integration | VERIFIED NOW: real `/oauth/token` invalid-grant branch emitted only a fixed category; duplicate synthetic refresh redemption produced one 200 and one categorized 400; synthetic request values absent |
| Soak-client tests | VERIFIED NOW: 2/2 PASS against a local protocol stub, including mode-0644 credential-file rejection and no bearer disclosure |
| Script syntax/runtime checks | VERIFIED NOW: Bash syntax, ShellCheck, Node syntax and end-to-end read-only diagnostic exit 0 |
| Independent review | UNVERIFIED / OPEN |
| Immutable commits | VERIFIED NOW: isolated `774622b...` / `250ec6d...`; authoritative `6bbfdab...` / `3d4dbb3...` |
| Deployment | UNVERIFIED / OPEN |

## Authoritative Integration Validation

- isolated candidate commits: `774622bcdbb0dd4ce7a70f25b37bd3b30a23e80d`
  and `250ec6da41799346820559669c608e9e867a9b17`;
- authoritative cherry-picks: `6bbfdab40f36b678366954c099b255db43758d9f`
  and `3d4dbb3a3df40b3d292e025cbe9beedbf09b5fb2`;
- integration parent: P3 `fa13327a0fc9380cabf05c593e69d4aaeba102e2`;
- path-overlap check: zero paths shared between P3 and the incident range;
- combined forward validation: 65/65 test files and 2,248/2,248 tests PASS,
  typecheck PASS, build PASS, Bash/Node/ShellCheck/diff checks PASS;
- tracked status and staging: empty; ordinary `node_modules` remains untracked.

This is source acceptance only. The live gateway still runs `5d375bd...`, so
request telemetry, runtime soak and connector stability remain UNVERIFIED / OPEN.

## Pre-Fix Runtime Controls

At `2026-09-14T04:22:42Z`:

- local `/healthz`: 200, HTTP/1.1;
- local `/readyz`: 200, HTTP/1.1;
- public `/healthz`: 200 under HTTP/1.1 and HTTP/2;
- public GET `/mcp`: expected 405 under HTTP/1.1 and HTTP/2;
- TLS verification: PASS, TLS 1.3, ALPN h2.

At `2026-09-14T04:31:22Z`, after the reproduced failure was reported:

- local `/readyz`: 200;
- public `/readyz`: 200 under HTTP/1.1 and HTTP/2;
- certificate verification result: 0;
- current gateway: running, healthy, restart 0, OOM false;
- tailscaled journal: no proxy error in the queried post-report window.

These controls do not prove the connector was healthy at the approximate
`06:26 SAST` failure time.

At `2026-09-14T04:53Z`, public DNS and relay-pinned controls established a path
not covered by Wolf-local MagicDNS:

- Cloudflare and Google public DNS both returned `176.58.90.46`,
  `176.58.90.63`, and `176.58.90.145`;
- each relay returned `/readyz` 200 under verified TLS with both HTTP/1.1 and
  HTTP/2;
- total latency was 1.26–1.29 seconds in this six-request snapshot.

This proves the public Funnel relay path was healthy then, not at the
approximate failure time and not specifically from the ChatGPT connector.

## Required Post-Deployment Validation

1. Confirm exact image/build revision and startup telemetry identity.
2. Repeat local and public TLS/H1/H2 controls.
3. Run at least 500 authenticated MCP initialize requests with zero unexplained
   failures, record p50/p95/max and duration.
4. Run tiny, moderate, 30/60/90/120-second, bounded response-size and 1/2/4
   concurrency classes.
5. Prove restart count, OOM, FD and socket stability.
6. Repeat external ChatGPT sequence across multiple minutes without reconnect.
7. Correlate any failure to Wolf `http_request_*`, MCP audit and Funnel logs.
8. Only then decide whether the remaining failure is local or
   `BLOCKED_EXTERNAL_CONNECTOR_PATH`.

## Soak Command

The candidate `scripts/mcp-soak.mjs` requires a caller-owned mode-0600 bearer
file and never prints the token:

```bash
MCP_BEARER_FILE=/path/to/mode-0600-token-file \
MCP_SOAK_URL=https://wolf.taildc680e.ts.net/mcp \
MCP_SOAK_ATTEMPTS=500 \
MCP_SOAK_CONCURRENCY=1 \
node scripts/mcp-soak.mjs
```

The token file path is operator input and must not be committed. A 30-minute
soak must set a bounded interval or repeat schedule whose final record includes
at least 500 attempts. No 30-minute soak is claimed yet.

## Rollback Validation

Before any live deployment, record the exact current gateway/executor image
names and IDs. If the candidate changes behavior adversely, use the existing
failure-atomic owner-host rollback to redeploy those exact immutable tags, then
re-run local readiness and Funnel checks. Do not alter auth, TLS or Funnel scope.
