# MCP Connector Request Path

## Verified Path

```text
ChatGPT connector runtime (external; implementation not visible)
  -> public DNS returns Tailscale Funnel relay addresses
  -> HTTPS :443, HTTP/1.1 or HTTP/2, TLS 1.3 accepted
Tailscale Funnel public relay (three A records observed)
  -> encrypted proxy to Wolf; relay does not terminate client TLS
Tailscale Funnel in tailscaled 1.102.2 on WSL host Wolf
  -> TLS terminates in tailscaled
  -> configured cleartext HTTP proxy target http://127.0.0.1:8787
Docker-published loopback socket 127.0.0.1:8787
  -> container port 8787/tcp
quarangate-gateway-1, Node 24.18.0 / Express 5.2.1
  -> OAuth or static-key authentication
  -> per-principal rate limit and authorization
  -> stateless MCP Streamable HTTP transport, SDK 1.30.0
  -> QuaranGate tool dispatcher
  -> HTTP over quarangate-internal to executor:8990
quarangate-executor-1
  -> trusted target resolution and bounded authorized operation
  -> projects-work or another explicitly configured target
```

## Hop Inventory

| Hop | Owner | Protocol / address | TLS | Auth | Timeout / keepalive | Restart / dependency | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ChatGPT connector to Wolf | OpenAI connector platform | HTTPS `wolf.taildc680e.ts.net:443`; source port external/ephemeral | Client-to-tailscaled; verified TLS 1.3 and trusted leaf | OAuth bearer expected after discovery | External retry/timeout/keepalive limits not visible locally | External platform/session/account binding | UNVERIFIED / OPEN |
| Public DNS / Funnel relay | Tailscale | Public A records `176.58.90.46`, `176.58.90.63`, `176.58.90.145` at 2026-09-14; encrypted relay to Wolf | Relay preserves end-to-end client TLS to tailscaled | None at relay | Non-configurable Funnel bandwidth limits documented; request timeout/retry not documented in inspected material | External Tailscale relay service | VERIFIED NOW for current DNS and H1/H2 readiness; failure-time state unavailable |
| Funnel listener | `tailscaled.service`, PID lineage owned by systemd | Tailscale Funnel on Wolf Tailscale IPs, TCP 443; HTTP/1.1 and HTTP/2 accepted | Terminates here; ALPN h2 verified | Forwards HTTP to app; application auth remains gateway-owned | Funnel proxy limits/retries not exposed by inspected CLI status | tailscaled active since 2026-09-12 21:10, NRestarts=0; depends on WSL/Windows network | VERIFIED NOW except undocumented limits |
| Funnel backend | tailscaled reverse proxy | `http://127.0.0.1:8787` | None on loopback hop | No separate proxy auth | Backend HTTP version/retry policy not yet captured | Fixed loopback port; not an ephemeral container IP | VERIFIED NOW except backend transport limits |
| Docker publication | Docker Desktop / Compose | host `127.0.0.1:8787` to container `8787/tcp` | None | None | Docker forwarding limits not configured in Compose | Exists only while gateway container is running | VERIFIED NOW |
| MCP gateway | `quarangate-gateway-1` | Node HTTP on `0.0.0.0:8787` inside container | None; protected by loopback publication | Static API key or local OAuth access token mapped to principal | Node defaults: request 300 s, headers 60 s, keepalive 5 s + 1 s buffer, socket timeout 0, unlimited requests/socket; JSON `/mcp` body 8 MiB | `unless-stopped`; 512 MiB, 256 PIDs; recreated by deployments | VERIFIED NOW |
| OAuth facade | gateway | well-known metadata, `/oauth/register`, `/oauth/authorize`, `/oauth/token` | Inherits Funnel TLS | DCR + code/PKCE; public token endpoint; local API key at consent | Register body 64 KiB; authorize/token body 16 KiB; code 5 min; access 1 h; refresh 30 d; DCR 90 d | State on `quarangate-data`; authorization codes process-local | VERIFIED NOW |
| MCP transport | gateway | POST `/mcp`, stateless Streamable HTTP | Inherits | Auth before MCP SDK handling | Fresh MCP server/transport per POST; global response bound not identified | Same process as public gateway | VERIFIED NOW / limits partly open |
| Gateway to executor | gateway/executor | `http://executor:8990` on internal Docker network | None; isolated internal network | `x-internal-token`, value not inspected | Undici defaults; no explicit call timeout in inspected client | Depends on executor and Docker network | VERIFIED NOW / timeout open |
| Executor | `quarangate-executor-1` | private port 8990, unpublished | None | Exact internal token plus repeated authorization | Operation-specific bounds | `unless-stopped`; 512 MiB, 512 PIDs; Docker authority confined here | VERIFIED NOW |

## Failure Classification From Telemetry

```text
No http_request_start at failed external time
  + local/public controls healthy
  => NO_INGRESS / candidate BLOCKED_EXTERNAL_CONNECTOR_PATH

http_request_start only; no terminal event; process/restart evidence
  => HTTP_INGRESS / server or lifecycle interruption

/oauth/token complete status 400 + fixed outcome category
  => local auth exchange reached Wolf; distinguish safe server branch without
     logging client ID, credential, verifier, request body or token

/mcp start + matching MCP audit reqId
  => MCP_HANDLED

/mcp complete 2xx + ChatGPT reports failure
  => MCP_RESPONDED but CLIENT_RECEIVED failed

Tailscale proxy error with no app start
  => TLS/HTTP ingress reached Funnel but backend was unavailable
```

Wolf-local DNS returns `100.79.53.72`, while Cloudflare and Google public DNS
returned the three Funnel relay addresses above. A normal curl from Wolf can
therefore take the tailnet-local path. Relay-pinned verified curls passed H1 and
H2 readiness on all three public addresses; these are stronger current controls
but still are not a historical test at the failed timestamp.

The deployed revision does not yet emit `http_request_*`; these rules become
mechanically usable only after the telemetry candidate is independently accepted
and deployed.
