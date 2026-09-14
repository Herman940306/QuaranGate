# MCP Connector Reproduction Matrix

## Current Matrix

| Class | Test | Result | Evidence boundary |
| --- | --- | --- | --- |
| A tiny | One unique `echo` via ChatGPT | PASS | ACCEPTED EVIDENCE; Wolf tool audit near the window, exact request binding unavailable |
| A tiny | Five external probes with five-second operator gaps | 4 PASS / 1 FAIL | ACCEPTED EVIDENCE; fifth failed at connector/account layer before command execution; exact seconds unavailable |
| B moderate | Small grep/status/test | UNVERIFIED / OPEN | Not run as controlled incident matrix |
| C long | 30/60/90/120 s | UNVERIFIED / OPEN | Not run |
| D response size | small/medium/near bound | UNVERIFIED / OPEN | Global and connector response bounds not yet established |
| E concurrency | 1/2/4 | UNVERIFIED / OPEN | Not run |
| F protocol | unauthenticated/readiness HTTP/1.1 | PASS | Public readiness 200 and expected GET `/mcp` 405 |
| F protocol | unauthenticated/readiness HTTP/2 | PASS | Public readiness 200 and expected GET `/mcp` 405 |
| F protocol | authenticated MCP POST over H1/H2 | UNVERIFIED / OPEN | Requires safe credential-file client and accepted test authority |
| G route | local loopback | PASS | `/readyz` 200 at recorded controls |
| G route | Tailscale HTTPS FQDN | PASS at controls; deployment failures observed | HTTP/TLS controls plus tailscaled errors |
| G route | ChatGPT connector | FAIL intermittently | 4/5 reproduced sequence |
| Auth replay | Duplicate redemption of one synthetic refresh token | One 200 rotation / one categorized 400 | VERIFIED NOW in a local real-handler test; proves server behavior only, not that ChatGPT duplicated the incident refresh |

## Hypothesis Register

| ID | Evidence for | Evidence against | Test | Result | Verdict |
| --- | --- | --- | --- | --- | --- |
| H1 MCP process crashes/restarts | Deployment recreates gateway | Current container restart 0, OOM false, healthy; historical old container state not retained | Correlate process-start/restart identity with next failure | UNVERIFIED / OPEN | No spontaneous crash proven |
| H2 Funnel targets ephemeral container IP | None | Funnel target is fixed `127.0.0.1:8787`; Docker owns publication | `tailscale funnel status`, Docker port inspect | VERIFIED NOW | H2 not present |
| H3 Funnel loses backend connectivity | Two connection refusals and one unexpected EOF | Refusals coincide with gateway deployment gap | Correlate proxy journal to external failure | VERIFIED NOW for deployments; otherwise OPEN | Partial local cause |
| H4 tailscaled restarts/route changes | Tailnet DNS health warnings exist | `NRestarts=0`, active since boot; no restart in observed failures | Service/journal correlation | VERIFIED NOW for inspected window | Restart theory unsupported |
| H5 WSL networking resets | WSL2 host; clock/DNS churn visible | Successful connector calls occur throughout recurring clock events | Windows/WSL event correlation at exact failure | UNVERIFIED / OPEN | Not proven |
| H6 HTTP/2 differs from HTTP/1.1 | Connector may negotiate either | Both public readiness and GET `/mcp` controls pass | Authenticated MCP POST H1/H2 soak | UNVERIFIED / OPEN | Health-only parity proven |
| H7 keepalive/request/header timeout mismatch | Node keepalive 5 s may interact with clients | Tiny failures and successes do not map to timeout; no timeout log | Arrival/aborted telemetry plus duration matrix | UNVERIFIED / OPEN | No tuning authorized |
| H8 upstream long-operation timeout | Some reported failures were long/output-heavy | Tiny calls also fail; durable jobs outlive disconnects | 30/60/90/120 s matrix | UNVERIFIED / OPEN | Not sufficient alone |
| H9 response-size limit | Output-heavy operations reportedly failed | Tiny calls also fail | Establish bounds; bounded size matrix | UNVERIFIED / OPEN | Not sufficient alone |
| H10 concurrency/backlog/FD exhaustion | Multiple ChatGPT calls may overlap | Snapshot: 20 FDs of 1,048,576; low CPU/memory/PIDs; no socket saturation | Metrics during failure and 1/2/4 soak | VERIFIED NOW only for snapshot | Saturation not evidenced |
| H11 uncaught exception/rejection | Unexpected EOF could follow process loss | Current process stable/restart 0; no current uncaught log | Start/abort/restart correlation | UNVERIFIED / OPEN | Not proven |
| H12 Docker pressure affects control path | Deployments/builds use Docker and gateway is a container | Resource snapshot low after deployment | Monitor Docker events/stats during controlled work | UNVERIFIED / OPEN | Not proven beyond recreation |
| H13 connector/account authorization loses binding | Reproduced explicit account 400; local OAuth has process-local authorization codes and immediate single-use refresh rotation; duplicate synthetic redemption mechanically gives one 200 and one `oauth_refresh_token_missing` 400 | At 06:31 aggregate tokens were unexpired, but not time-correlated to ~06:26; current gateway did not restart near the approximate time; no proof ChatGPT duplicated a refresh | Log OAuth path/status and fixed server outcome only; correlate next external failure; do not log tokens | VERIFIED NOW for server replay behavior; incident causation UNVERIFIED / OPEN | Leading open hypotheses include lost/replayed refresh, but no cause proven |
| H14 failed requests never reach Wolf | Fifth command did not execute and has no identified tool audit | OAuth/HTTP arrival was not logged, so absence at tool layer is insufficient | Deploy safe arrival logger; repeat until failure | UNVERIFIED / OPEN | Decisive open hypothesis |
| H15 certificate trust/chain issue | Could produce connection error | Normal verification succeeds; SAN/CN exact; TLS 1.3; valid dates | Repeat verified TLS checks during failure | VERIFIED NOW for controls | No current cert defect |
| H16 DNS instability | tailscaled reports WSL resolver warnings/timeouts | Wolf name resolves to `100.79.53.72`; Funnel backend is literal loopback; external client DNS is separate | Exact failure-time external/host resolution | UNVERIFIED / OPEN | Local warning not root cause proof |
| H17 clock skew affects TLS/auth | systemd-resolved reports clock changes every ~30 s | NTP synchronized, offset ~53 ms; many connector successes during same recurring events | Exact failure-time clock/NTP comparison | VERIFIED NOW for current snapshot | Material skew not evidenced |
| H18 external connector runtime unstable | Cross-conversation symptom; account-layer 400 before tool | No-ingress proof absent | Failed call with no HTTP start and healthy controls | UNVERIFIED / OPEN | Do not classify external yet |
| H19 deployment recreates MCP control endpoint | Compose deploy includes gateway/executor; exact Funnel refusals during A8 | None for deployment window | Job/container/Funnel timestamp correlation | VERIFIED NOW | Local cause verified |
| H20 multiple issues exist | Deployment failures and a distinct account-layer 400 are different categories | The 400 failing layer remains unknown | Preserve separate timelines and correlation IDs | VERIFIED NOW as error-class distinction | Multiple mechanisms possible, not all roots verified |

## Next Controlled External Sequence

Only after arrival telemetry is deployed:

1. Record server UTC and container identity.
2. Start sanitized log follow for `http_request_*`, matching MCP audit and
   tailscaled proxy errors.
3. Herman invokes one unique tiny tool call at a time.
4. For every attempt record T0/T4 from the best available client display and
   T2/T3 from Wolf request ID events.
5. Stop at the first connector failure; immediately run local and public H1/H2
   readiness controls and capture restart/OOM state.
6. Classify only from the exact request ID/window.
