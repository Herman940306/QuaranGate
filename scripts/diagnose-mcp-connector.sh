#!/usr/bin/env bash
# Read-only, metadata-only QuaranGate MCP connector diagnostics.
# This script never reads container environments, credential files, request
# bodies, tool arguments, cookies, Authorization headers, or token values.

set -u
set -o pipefail

PUBLIC_BASE="${MCP_PUBLIC_BASE:-https://wolf.taildc680e.ts.net}"
PUBLIC_HOST="${MCP_PUBLIC_HOST:-wolf.taildc680e.ts.net}"
LOCAL_BASE="${MCP_LOCAL_BASE:-http://127.0.0.1:8787}"
SOURCE_ROOT="${QUARANGATE_SOURCE:-/home/herman/projects/QuaranGate-u1-full}"
DOCKER_SINCE="${MCP_DIAG_DOCKER_SINCE:-15m}"
JOURNAL_SINCE="${MCP_DIAG_JOURNAL_SINCE:-15 minutes ago}"

section() {
  printf '\n[%s]\n' "$1"
}

try() {
  local label="$1"
  shift
  printf '%s\n' "$label"
  if ! "$@" 2>&1; then
    printf 'UNVERIFIED / OPEN: command failed: %s\n' "$label"
  fi
}

section "identity"
try "utc" date -u --iso-8601=seconds
try "local" date --iso-8601=seconds
try "hostname" hostname
try "kernel" uname -a
try "uptime" uptime
try "memory" free -h
try "disk" df -h / /tmp
try "inodes" df -i / /tmp

section "source"
if [[ -d "$SOURCE_ROOT/.git" || -f "$SOURCE_ROOT/.git" ]]; then
  try "branch" git -C "$SOURCE_ROOT" branch --show-current
  try "head" git -C "$SOURCE_ROOT" rev-parse HEAD
  try "status" git -C "$SOURCE_ROOT" status --short
  try "staging" git -C "$SOURCE_ROOT" diff --cached --name-status
else
  printf 'UNVERIFIED / OPEN: source root unavailable: %s\n' "$SOURCE_ROOT"
fi

section "network"
try "addresses" ip -brief addr
try "routes" ip route
try "dns_ipv4" getent ahostsv4 "$PUBLIC_HOST"
try "dns_ipv6" getent ahostsv6 "$PUBLIC_HOST"
try "listeners" ss -ltnp
try "socket_summary" ss -s

section "tailscale"
if command -v tailscale >/dev/null 2>&1; then
  try "version" tailscale version
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "sanitized_status"
    tailscale status --json 2>/dev/null \
      | jq '{BackendState,Self:(.Self | {HostName,TailscaleIPs,Online,Active})}' \
      || printf '%s\n' 'UNVERIFIED / OPEN: sanitized Tailscale status unavailable'
  else
    printf '%s\n' 'UNVERIFIED / OPEN: jq unavailable; raw Tailscale status intentionally omitted'
  fi
  try "serve_status" tailscale serve status
  try "funnel_status" tailscale funnel status
else
  printf '%s\n' 'UNVERIFIED / OPEN: tailscale CLI unavailable'
fi

section "public_funnel_relays"
public_dns_json="$(curl --fail --silent --show-error --max-time 10 \
  -H 'accept: application/dns-json' \
  "https://cloudflare-dns.com/dns-query?name=${PUBLIC_HOST}&type=A" 2>/dev/null || true)"
if [[ -n "$public_dns_json" ]] && command -v jq >/dev/null 2>&1; then
  printf '%s\n' "cloudflare_public_dns"
  jq '{Status,Answer:[.Answer[]? | select(.type == 1) | {type,data,TTL}]}' <<<"$public_dns_json" \
    || printf '%s\n' 'UNVERIFIED / OPEN: public DNS response was not valid JSON'
  mapfile -t public_relays < <(jq -r '.Answer[]? | select(.type == 1) | .data' <<<"$public_dns_json" | sort -u)
  if [[ ${#public_relays[@]} -eq 0 ]]; then
    printf '%s\n' 'UNVERIFIED / OPEN: public DNS returned no Funnel relay A records'
  fi
  for relay in "${public_relays[@]}"; do
    if [[ ! "$relay" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf 'UNVERIFIED / OPEN: ignored non-IPv4 public DNS answer\n'
      continue
    fi
    try "relay=$relay http1_ready" curl --noproxy '*' --fail --silent --show-error --max-time 15 \
      --http1.1 --resolve "$PUBLIC_HOST:443:$relay" -o /dev/null \
      -w 'http=%{http_code} version=%{http_version} remote=%{remote_ip} verify=%{ssl_verify_result} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n' \
      "$PUBLIC_BASE/readyz"
    try "relay=$relay http2_ready" curl --noproxy '*' --fail --silent --show-error --max-time 15 \
      --http2 --resolve "$PUBLIC_HOST:443:$relay" -o /dev/null \
      -w 'http=%{http_code} version=%{http_version} remote=%{remote_ip} verify=%{ssl_verify_result} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n' \
      "$PUBLIC_BASE/readyz"
  done
else
  printf '%s\n' 'UNVERIFIED / OPEN: public DNS relay discovery unavailable'
fi

section "docker_gateway_executor"
if command -v docker >/dev/null 2>&1; then
  try "containers" docker ps --no-trunc \
    --filter label=com.docker.compose.project=quarangate \
    --format '{{.ID}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.Names}}'

  gateway_id="$(docker ps -q \
    --filter label=com.docker.compose.project=quarangate \
    --filter label=com.docker.compose.service=gateway 2>/dev/null | head -n 1)"
  executor_id="$(docker ps -q \
    --filter label=com.docker.compose.project=quarangate \
    --filter label=com.docker.compose.service=executor 2>/dev/null | head -n 1)"

  for container_id in "$gateway_id" "$executor_id"; do
    [[ -n "$container_id" ]] || continue
    # The single quotes are intentional: these are Docker Go-template fields,
    # not shell variables.
    # shellcheck disable=SC2016
    try "container_identity=$container_id" docker inspect "$container_id" --format \
      'id={{.Id}} image_id={{.Image}} image={{.Config.Image}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} pid={{.State.Pid}} restart_policy={{.HostConfig.RestartPolicy.Name}} memory={{.HostConfig.Memory}} pids_limit={{.HostConfig.PidsLimit}} ports={{json .NetworkSettings.Ports}} networks={{range $name, $net := .NetworkSettings.Networks}}{{$name}}:{{$net.IPAddress}};{{end}} mounts={{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}}:rw={{.RW}};{{end}}'
  done

  if [[ -n "$gateway_id" && -n "$executor_id" ]]; then
    try "resource_snapshot" docker stats --no-stream --format \
      '{{.Container}}|{{.Name}}|cpu={{.CPUPerc}}|mem={{.MemUsage}}|mem_pct={{.MemPerc}}|net={{.NetIO}}|block={{.BlockIO}}|pids={{.PIDs}}' \
      "$gateway_id" "$executor_id"
  fi
else
  printf '%s\n' 'UNVERIFIED / OPEN: docker CLI unavailable'
  gateway_id=""
fi

section "http_tls"
try "local_health" curl --fail --silent --show-error --max-time 10 -o /dev/null \
  -w 'http=%{http_code} version=%{http_version} connect=%{time_connect} total=%{time_total}\n' \
  "$LOCAL_BASE/healthz"
try "local_ready" curl --fail --silent --show-error --max-time 10 -o /dev/null \
  -w 'http=%{http_code} version=%{http_version} connect=%{time_connect} total=%{time_total}\n' \
  "$LOCAL_BASE/readyz"
try "public_http1_ready" curl --fail --silent --show-error --max-time 15 --http1.1 -o /dev/null \
  -w 'http=%{http_code} version=%{http_version} remote=%{remote_ip} verify=%{ssl_verify_result} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n' \
  "$PUBLIC_BASE/readyz"
try "public_http2_ready" curl --fail --silent --show-error --max-time 15 --http2 -o /dev/null \
  -w 'http=%{http_code} version=%{http_version} remote=%{remote_ip} verify=%{ssl_verify_result} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n' \
  "$PUBLIC_BASE/readyz"
try "public_http1_mcp_get_expected_405" curl --silent --show-error --max-time 15 --http1.1 -o /dev/null \
  -w 'http=%{http_code} version=%{http_version} remote=%{remote_ip} verify=%{ssl_verify_result} total=%{time_total}\n' \
  "$PUBLIC_BASE/mcp"
try "public_http2_mcp_get_expected_405" curl --silent --show-error --max-time 15 --http2 -o /dev/null \
  -w 'http=%{http_code} version=%{http_version} remote=%{remote_ip} verify=%{ssl_verify_result} total=%{time_total}\n' \
  "$PUBLIC_BASE/mcp"
printf '%s\n' "leaf_certificate"
openssl s_client -connect "$PUBLIC_HOST:443" -servername "$PUBLIC_HOST" \
  -verify_return_error -showcerts </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName -fingerprint -sha256 \
  || printf '%s\n' 'UNVERIFIED / OPEN: certificate inspection failed'

section "oauth_discovery"
if command -v jq >/dev/null 2>&1; then
  curl --fail --silent --show-error --max-time 15 \
    "$PUBLIC_BASE/.well-known/oauth-protected-resource/mcp" \
    | jq '{resource,authorization_servers}' \
    || printf '%s\n' 'UNVERIFIED / OPEN: protected-resource metadata unavailable'
  curl --fail --silent --show-error --max-time 15 \
    "$PUBLIC_BASE/.well-known/oauth-authorization-server" \
    | jq '{issuer,authorization_endpoint,token_endpoint,registration_endpoint,response_types_supported,grant_types_supported,code_challenge_methods_supported,token_endpoint_auth_methods_supported,scopes_supported}' \
    || printf '%s\n' 'UNVERIFIED / OPEN: authorization-server metadata unavailable'
else
  printf '%s\n' 'UNVERIFIED / OPEN: jq unavailable; discovery bodies intentionally omitted'
fi

section "sanitized_recent_events"
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u tailscaled --since "$JOURNAL_SINCE" --no-pager -o short-iso 2>/dev/null \
    | grep -E -i 'proxy error|ReverseProxy|funnel|serve|TLS|connection refused|unexpected EOF' \
    || true
  journalctl -k --since "$JOURNAL_SINCE" --no-pager -o short-iso 2>/dev/null \
    | grep -E -i 'OOM|out of memory|killed process|segfault|nf_conntrack' \
    || true
fi
if [[ -n "${gateway_id:-}" ]]; then
  if command -v jq >/dev/null 2>&1; then
    docker logs --since "$DOCKER_SINCE" "$gateway_id" 2>&1 \
      | jq -Rrc 'fromjson? | {ts,event,requestId,connectionId,method,path,httpVersion,serverPid,processStartedAt,buildRevision,status,durationMs,reqId,principal,tool,decision,code,level,msg,port,publicUrl,pid,nodeVersion}' \
      || true
  else
    printf '%s\n' 'UNVERIFIED / OPEN: jq unavailable; raw gateway logs intentionally omitted'
  fi
fi

section "verdict_boundary"
printf '%s\n' 'This snapshot proves only the checks printed above.'
printf '%s\n' 'A healthy curl does not prove ChatGPT connector health.'
printf '%s\n' 'A failed ChatGPT call requires same-window HTTP/MCP telemetry correlation.'
