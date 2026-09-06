#!/usr/bin/env bash
# scripts/workstation-doctor.sh — H1-3: Read-only stale bind detection.
#
# PURPOSE:
#   Detect the exact stale bind conditions that have been reproduced in
#   production without modifying any state. This script is READ-ONLY.
#   It does NOT restart, recreate, or modify any container, volume, config,
#   or network. Recovery is the separate scripts/remote-owner-recover.sh.
#
# USAGE:
#   ./scripts/workstation-doctor.sh [--json]
#
#   --json    Emit a single JSON object to stdout (machine-readable).
#             Default: human-readable table to stdout.
#
# CHECKS:
#   DOCKER_API             Host Docker API reachable
#   HOST_DOCKER_SOCKET     Host /var/run/docker.sock is a Unix socket
#   EXECUTOR_DOCKER_SOCKET Executor-mounted socket is a Unix socket
#   GATEWAY_CONFIG_BIND    Gateway /config mount has expected config files
#   PROJECTS_WORK_BIND     Project workspace mounts are non-empty
#   GATEWAY_READY          Gateway /readyz returns 200
#   EXECUTOR_READY         Executor /readyz returns 200
#   OLLAMA_READY           Ollama endpoint reachable (if configured)
#   TAILSCALE              Tailscale up (if configured)
#
# EXIT CODES:
#   0  all required checks PASS
#   1  one or more required checks FAIL
#   2  usage error

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
JSON_OUT=false
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=true ;;
    -h|--help)
      sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Locate repository root
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# Resolve live runtime root (candidate worktrees link to a parent runtime root).
RUNTIME_ROOT="$REPO_ROOT"
if [[ ! -f "$RUNTIME_ROOT/config/clients.yaml" && -f "$REPO_ROOT/../../config/clients.yaml" ]]; then
  RUNTIME_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Check result accumulator
# ---------------------------------------------------------------------------
declare -A CHECK_RESULT   # CHECK_RESULT[name]=PASS|FAIL|SKIP|WARN
declare -A CHECK_DETAIL   # CHECK_DETAIL[name]=<human message>
OVERALL_STATUS=PASS

record() {
  local name="$1" status="$2" detail="${3:-}"
  CHECK_RESULT["$name"]="$status"
  CHECK_DETAIL["$name"]="$detail"
  if [[ "$status" == "FAIL" ]]; then
    OVERALL_STATUS=FAIL
  fi
}

# ---------------------------------------------------------------------------
# Helper: exec inside a running container and return stdout (bounded)
# ---------------------------------------------------------------------------
container_exec_bounded() {
  local container="$1"
  shift
  docker exec --no-tty "$container" "$@" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# CHECK: DOCKER_API — host Docker API reachable
# ---------------------------------------------------------------------------
if docker info >/dev/null 2>&1; then
  record DOCKER_API PASS "Host Docker API reachable"
else
  record DOCKER_API FAIL "Host Docker API unreachable — docker info failed"
fi

# ---------------------------------------------------------------------------
# CHECK: HOST_DOCKER_SOCKET — host socket is a Unix socket
# ---------------------------------------------------------------------------
HOST_SOCK="/var/run/docker.sock"
if [[ ! -e "$HOST_SOCK" ]]; then
  record HOST_DOCKER_SOCKET FAIL "Host socket $HOST_SOCK does not exist"
elif [[ -S "$HOST_SOCK" ]]; then
  record HOST_DOCKER_SOCKET PASS "Host $HOST_SOCK is a Unix socket"
else
  FILE_TYPE="$(stat -c '%F' "$HOST_SOCK" 2>/dev/null || echo 'unknown')"
  record HOST_DOCKER_SOCKET FAIL "Host $HOST_SOCK is a $FILE_TYPE, not a Unix socket"
fi

# ---------------------------------------------------------------------------
# CHECK: EXECUTOR_DOCKER_SOCKET — socket inside executor container is a socket
# ---------------------------------------------------------------------------
EXECUTOR_CONTAINER="$(docker ps --filter 'label=com.docker.compose.service=executor' \
  --filter 'label=com.docker.compose.project=quarangate' \
  --format '{{.ID}}' 2>/dev/null | head -1)"

if [[ -z "$EXECUTOR_CONTAINER" ]]; then
  record EXECUTOR_DOCKER_SOCKET FAIL "Executor container not running (compose project=quarangate, service=executor)"
else
  # Use stat inside the container to check the socket type without needing
  # exec privileges — stat is available in alpine/debian images.
  SOCK_TYPE="$(container_exec_bounded "$EXECUTOR_CONTAINER" stat -c '%F' /var/run/docker.sock 2>/dev/null || echo '')"
  if [[ -z "$SOCK_TYPE" ]]; then
    record EXECUTOR_DOCKER_SOCKET FAIL "Cannot stat /var/run/docker.sock inside executor container"
  elif [[ "$SOCK_TYPE" == "socket" ]]; then
    record EXECUTOR_DOCKER_SOCKET PASS "Executor /var/run/docker.sock is a socket"
  else
    record EXECUTOR_DOCKER_SOCKET FAIL "Executor /var/run/docker.sock is '$SOCK_TYPE', not a socket — STALE BIND"
  fi
fi

# ---------------------------------------------------------------------------
# CHECK: GATEWAY_CONFIG_BIND — gateway /config has expected files
# ---------------------------------------------------------------------------
GATEWAY_CONTAINER="$(docker ps --filter 'label=com.docker.compose.service=gateway' \
  --filter 'label=com.docker.compose.project=quarangate' \
  --format '{{.ID}}' 2>/dev/null | head -1)"

if [[ -z "$GATEWAY_CONTAINER" ]]; then
  record GATEWAY_CONFIG_BIND FAIL "Gateway container not running"
else
  # Check presence of required config files inside the container.
  CLIENTS_OK="$(container_exec_bounded "$GATEWAY_CONTAINER" test -f /config/clients.yaml && echo ok || echo missing)"
  BRIDGE_OK="$(container_exec_bounded  "$GATEWAY_CONTAINER" test -f /config/bridge.yaml  && echo ok || echo missing)"
  if [[ "$CLIENTS_OK" == "ok" && "$BRIDGE_OK" == "ok" ]]; then
    # Content integrity: compare a hash of the host file against what's mounted.
    HOST_CLIENTS="$RUNTIME_ROOT/config/clients.yaml"
    HOST_BRIDGE="$RUNTIME_ROOT/config/bridge.yaml"
    HASH_OK=true
    if [[ -f "$HOST_CLIENTS" ]]; then
      HOST_HASH="$(sha256sum "$HOST_CLIENTS" 2>/dev/null | awk '{print $1}')"
      CONT_HASH="$(container_exec_bounded "$GATEWAY_CONTAINER" sha256sum /config/clients.yaml 2>/dev/null | awk '{print $1}')"
      if [[ -n "$HOST_HASH" && -n "$CONT_HASH" && "$HOST_HASH" != "$CONT_HASH" ]]; then
        HASH_OK=false
        record GATEWAY_CONFIG_BIND FAIL "Gateway /config/clients.yaml content differs from host source (stale bind)"
      fi
    fi
    if [[ "$HASH_OK" == "true" ]]; then
      record GATEWAY_CONFIG_BIND PASS "Gateway /config has clients.yaml and bridge.yaml (hashes match)"
    fi
  else
    MISSING=""
    [[ "$CLIENTS_OK" != "ok" ]] && MISSING="${MISSING}clients.yaml "
    [[ "$BRIDGE_OK"  != "ok" ]] && MISSING="${MISSING}bridge.yaml"
    record GATEWAY_CONFIG_BIND FAIL "Gateway /config missing: ${MISSING}(stale or empty bind)"
  fi
fi

# ---------------------------------------------------------------------------
# CHECK: PROJECTS_WORK_BIND — project workspace mounts are non-empty
# ---------------------------------------------------------------------------
# Find all running containers whose compose service name contains "work" or
# whose compose project mounts a /workspace path. We look for containers
# sharing the quarangate compose project that expose a /workspace path.
WORK_CONTAINERS="$(docker ps \
  --filter 'label=com.docker.compose.project=quarangate' \
  --format '{{.ID}} {{.Names}}' 2>/dev/null \
  | grep -i 'work\|target\|project' || true)"

if [[ -z "$WORK_CONTAINERS" ]]; then
  record PROJECTS_WORK_BIND SKIP "No work/project containers found in quarangate compose project"
else
  WORK_FAIL=false
  WORK_DETAIL=""
  while IFS= read -r line; do
    CID="$(echo "$line" | awk '{print $1}')"
    CNAME="$(echo "$line" | awk '{print $2}')"
    WS_COUNT="$(container_exec_bounded "$CID" sh -c 'ls /workspace 2>/dev/null | wc -l' 2>/dev/null | tr -d '[:space:]' || echo '')"
    if [[ -z "$WS_COUNT" ]]; then
      WORK_DETAIL="${WORK_DETAIL}${CNAME}: /workspace not accessible; "
      WORK_FAIL=true
    elif [[ "$WS_COUNT" -eq 0 ]]; then
      WORK_DETAIL="${WORK_DETAIL}${CNAME}: /workspace unexpectedly empty; "
      WORK_FAIL=true
    else
      WORK_DETAIL="${WORK_DETAIL}${CNAME}: /workspace has ${WS_COUNT} entries OK; "
    fi
  done <<< "$WORK_CONTAINERS"

  if [[ "$WORK_FAIL" == "true" ]]; then
    record PROJECTS_WORK_BIND FAIL "${WORK_DETAIL%%; }"
  else
    record PROJECTS_WORK_BIND PASS "${WORK_DETAIL%%; }"
  fi
fi

# ---------------------------------------------------------------------------
# CHECK: GATEWAY_READY — gateway /readyz returns 200
# ---------------------------------------------------------------------------
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8787}"
GATEWAY_HTTP_STATUS="$(curl -sf -o /dev/null -w '%{http_code}' \
  --max-time 5 "${GATEWAY_URL}/readyz" 2>/dev/null || echo '000')"

if [[ "$GATEWAY_HTTP_STATUS" == "200" ]]; then
  record GATEWAY_READY PASS "Gateway /readyz returned HTTP 200"
elif [[ "$GATEWAY_HTTP_STATUS" == "000" ]]; then
  record GATEWAY_READY FAIL "Gateway /readyz unreachable (connection failed or timeout)"
else
  record GATEWAY_READY FAIL "Gateway /readyz returned HTTP $GATEWAY_HTTP_STATUS"
fi

# ---------------------------------------------------------------------------
# CHECK: EXECUTOR_READY — executor /readyz returns 200
# ---------------------------------------------------------------------------
# Executor is not published. Access via docker exec into the executor container.
if [[ -z "$EXECUTOR_CONTAINER" ]]; then
  record EXECUTOR_READY FAIL "Executor container not running (skipped readyz check)"
else
  EXEC_READYZ="$(container_exec_bounded "$EXECUTOR_CONTAINER" \
    node -e "fetch('http://127.0.0.1:8990/readyz').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('error'))" \
    2>/dev/null || echo 'error')"
  if [[ "$EXEC_READYZ" == "200" ]]; then
    record EXECUTOR_READY PASS "Executor /readyz returned HTTP 200"
  elif [[ "$EXEC_READYZ" == "503" ]]; then
    record EXECUTOR_READY FAIL "Executor /readyz returned 503 — Docker socket authority check failed"
  else
    record EXECUTOR_READY FAIL "Executor /readyz returned: $EXEC_READYZ"
  fi
fi

# ---------------------------------------------------------------------------
# CHECK: OLLAMA_READY — Ollama endpoint reachable (if configured)
# ---------------------------------------------------------------------------
OLLAMA_HOST="${OLLAMA_HOST:-}"
# Also check compose env for OLLAMA_HOST.
if [[ -z "$OLLAMA_HOST" && -f "$RUNTIME_ROOT/.env" ]]; then
  OLLAMA_HOST="$(grep -E '^OLLAMA_HOST=' "$RUNTIME_ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]' || true)"
fi

if [[ -z "$OLLAMA_HOST" ]]; then
  record OLLAMA_READY SKIP "OLLAMA_HOST not configured"
else
  OLLAMA_STATUS="$(curl -sf -o /dev/null -w '%{http_code}' \
    --max-time 5 "${OLLAMA_HOST}/api/tags" 2>/dev/null || echo '000')"
  if [[ "$OLLAMA_STATUS" == "200" ]]; then
    record OLLAMA_READY PASS "Ollama reachable at ${OLLAMA_HOST} (api/tags → 200)"
  elif [[ "$OLLAMA_STATUS" == "000" ]]; then
    record OLLAMA_READY FAIL "Ollama unreachable at ${OLLAMA_HOST} (connection failed)"
  else
    record OLLAMA_READY WARN "Ollama at ${OLLAMA_HOST} returned HTTP $OLLAMA_STATUS"
  fi
fi

# ---------------------------------------------------------------------------
# CHECK: TAILSCALE — Tailscale up (if configured)
# ---------------------------------------------------------------------------
if command -v tailscale >/dev/null 2>&1; then
  TS_STATUS="$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('up' if d.get('BackendState')=='Running' else 'down')" 2>/dev/null || echo 'unknown')"
  if [[ "$TS_STATUS" == "up" ]]; then
    record TAILSCALE PASS "Tailscale running"
  elif [[ "$TS_STATUS" == "down" ]]; then
    record TAILSCALE FAIL "Tailscale not running"
  else
    record TAILSCALE WARN "Tailscale status unknown (not required)"
  fi
else
  record TAILSCALE SKIP "Tailscale not installed"
fi

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
ORDERED_CHECKS=(
  DOCKER_API
  HOST_DOCKER_SOCKET
  EXECUTOR_DOCKER_SOCKET
  GATEWAY_CONFIG_BIND
  PROJECTS_WORK_BIND
  GATEWAY_READY
  EXECUTOR_READY
  OLLAMA_READY
  TAILSCALE
)

if [[ "$JSON_OUT" == "true" ]]; then
  # Machine-readable JSON.
  FIRST=true
  printf '{\n  "overall": "%s",\n  "checks": {\n' "$OVERALL_STATUS"
  for chk in "${ORDERED_CHECKS[@]}"; do
    STATUS="${CHECK_RESULT[$chk]:-SKIP}"
    DETAIL="${CHECK_DETAIL[$chk]:-}"
    # Escape double quotes in detail.
    DETAIL_ESC="${DETAIL//\"/\\\"}"
    if [[ "$FIRST" == "true" ]]; then FIRST=false; else printf ',\n'; fi
    printf '    "%s": { "status": "%s", "detail": "%s" }' "$chk" "$STATUS" "$DETAIL_ESC"
  done
  printf '\n  }\n}\n'
else
  # Human-readable table.
  printf '\n%-36s %-8s %s\n' "CHECK" "STATUS" "DETAIL"
  printf '%s\n' "$(printf '%0.s-' {1..80})"
  for chk in "${ORDERED_CHECKS[@]}"; do
    STATUS="${CHECK_RESULT[$chk]:-SKIP}"
    DETAIL="${CHECK_DETAIL[$chk]:-}"
    printf '%-36s %-8s %s\n' "$chk" "$STATUS" "$DETAIL"
  done
  printf '\n'
  printf 'OVERALL: %s\n\n' "$OVERALL_STATUS"
fi

[[ "$OVERALL_STATUS" == "PASS" ]] && exit 0 || exit 1
