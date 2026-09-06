#!/usr/bin/env bash
# scripts/remote-owner-recover.sh — H1-4: Owner-invoked bounded targeted recovery.
#
# PURPOSE:
#   Repair exactly ONE stale-bind container. The algorithm is:
#     1. Capture pre-recovery evidence (docker ps, docker inspect, readyz).
#     2. Verify host Docker API is healthy.
#     3. Verify host source bind/socket is correct (Unix socket for executor).
#     4. Identify which QuaranGate-managed container has a stale bind.
#     5. Restart ONLY that affected container (docker restart, not compose down).
#     6. Re-verify mount identity after restart.
#     7. Re-verify readiness.
#     8. Run workstation-doctor.sh for overall picture.
#     9. PASS only when every required invariant is restored.
#
# FORBIDDEN ACTIONS (never performed, hard-coded refusal):
#   - docker compose down
#   - docker system prune / volume prune / network prune
#   - WSL restart / Docker Desktop restart
#   - Config rewrite, git mutation, credential mutation
#   - Broad stack restart
#   If host Docker is unavailable: FAIL CLOSED — no heroic recovery.
#
# USAGE:
#   ./scripts/remote-owner-recover.sh [--service <name>] [--dry-run]
#
#   --service <name>  Target service to restart: "executor" (default) or "gateway"
#   --dry-run         Print what would be done without doing it
#
# EXIT CODES:
#   0  recovery successful — all invariants restored
#   1  recovery failed or verification did not pass
#   2  usage error / precondition failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
TARGET_SERVICE="executor"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      shift
      TARGET_SERVICE="${1:-}"
      if [[ "$TARGET_SERVICE" != "executor" && "$TARGET_SERVICE" != "gateway" ]]; then
        echo "ERROR: --service must be 'executor' or 'gateway'" >&2
        exit 2
      fi
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    -h|--help)
      sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DOCTOR="$SCRIPT_DIR/workstation-doctor.sh"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"

log()  { printf '[%s] %s\n' "$TIMESTAMP" "$*"; }
fail() { printf '[%s] FAIL: %s\n' "$TIMESTAMP" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# DRY RUN guard
# ---------------------------------------------------------------------------
run_or_dry() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[DRY-RUN] would execute: %s\n' "$*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# STEP 1: Capture pre-recovery evidence
# ---------------------------------------------------------------------------
log "=== STEP 1: Capture pre-recovery evidence ==="
log "Target service: $TARGET_SERVICE"
log "Timestamp: $TIMESTAMP"

docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}' \
  --filter 'label=com.docker.compose.project=quarangate' 2>/dev/null || true

# ---------------------------------------------------------------------------
# STEP 2: Verify host Docker API is healthy
# ---------------------------------------------------------------------------
log "=== STEP 2: Verify host Docker API ==="
if ! docker info >/dev/null 2>&1; then
  fail "Host Docker API is unavailable. FAIL CLOSED — no recovery attempted."
fi
log "Host Docker API: OK"

# ---------------------------------------------------------------------------
# STEP 3: Verify host source bind/socket is correct
# ---------------------------------------------------------------------------
log "=== STEP 3: Verify host source bind/socket ==="
if [[ "$TARGET_SERVICE" == "executor" ]]; then
  HOST_SOCK="/var/run/docker.sock"
  if [[ ! -e "$HOST_SOCK" ]]; then
    fail "Host socket $HOST_SOCK does not exist. Cannot recover executor."
  fi
  if [[ ! -S "$HOST_SOCK" ]]; then
    HOST_TYPE="$(stat -c '%F' "$HOST_SOCK" 2>/dev/null || echo 'unknown')"
    fail "Host $HOST_SOCK is a $HOST_TYPE, not a Unix socket. Host Docker bind is wrong — cannot recover."
  fi
  log "Host $HOST_SOCK: Unix socket (correct)"
fi

if [[ "$TARGET_SERVICE" == "gateway" ]]; then
  RUNTIME_ROOT="$REPO_ROOT"
  if [[ ! -f "$RUNTIME_ROOT/config/clients.yaml" && -f "$REPO_ROOT/../../config/clients.yaml" ]]; then
    RUNTIME_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
  fi
  if [[ ! -f "$RUNTIME_ROOT/config/clients.yaml" ]]; then
    fail "Host config/clients.yaml does not exist. Gateway cannot be recovered without it."
  fi
  log "Host config/clients.yaml: present"
fi

# ---------------------------------------------------------------------------
# STEP 4: Identify the affected container
# ---------------------------------------------------------------------------
log "=== STEP 4: Identify affected container ==="
CONTAINER_ID="$(docker ps \
  --filter "label=com.docker.compose.service=${TARGET_SERVICE}" \
  --filter 'label=com.docker.compose.project=quarangate' \
  --format '{{.ID}}' 2>/dev/null | head -1)"

if [[ -z "$CONTAINER_ID" ]]; then
  fail "No running $TARGET_SERVICE container found in quarangate compose project."
fi
CONTAINER_NAME="$(docker inspect --format '{{.Name}}' "$CONTAINER_ID" 2>/dev/null | sed 's|^/||')"
log "Found: $CONTAINER_NAME ($CONTAINER_ID)"

# Confirm it actually has a stale bind (or at least a problem) before touching it.
log "Pre-restart readiness check..."
BEFORE_STATUS="UNKNOWN"
if [[ "$TARGET_SERVICE" == "executor" ]]; then
  SOCK_TYPE="$(docker exec --no-tty "$CONTAINER_ID" stat -c '%F' /var/run/docker.sock 2>/dev/null || echo 'error')"
  if [[ "$SOCK_TYPE" == "socket" ]]; then
    log "WARNING: executor socket type is already correct ($SOCK_TYPE). Bind may not be stale."
    log "Proceeding only if --dry-run; otherwise operator should investigate further."
    if [[ "$DRY_RUN" == "false" ]]; then
      log "Socket appears correct. Use workstation-doctor.sh to investigate before forcing a restart."
      log "If you still want to restart, re-run with the container-level docker restart command directly."
      exit 0
    fi
    BEFORE_STATUS="SOCKET_LOOKS_OK"
  else
    log "Stale bind confirmed: socket type inside executor is '$SOCK_TYPE'"
    BEFORE_STATUS="STALE_BIND"
  fi
elif [[ "$TARGET_SERVICE" == "gateway" ]]; then
  CLIENTS_PRESENT="$(docker exec --no-tty "$CONTAINER_ID" test -f /config/clients.yaml && echo ok || echo missing 2>/dev/null || echo missing)"
  log "Gateway /config/clients.yaml inside container: $CLIENTS_PRESENT"
  if [[ "$CLIENTS_PRESENT" == "ok" ]]; then
    log "WARNING: clients.yaml appears present. Bind may not be stale."
    BEFORE_STATUS="CONFIG_LOOKS_OK"
  else
    BEFORE_STATUS="CONFIG_MISSING"
  fi
fi

# ---------------------------------------------------------------------------
# STEP 5: Restart ONLY the affected container
# ---------------------------------------------------------------------------
log "=== STEP 5: Restart ONLY $TARGET_SERVICE ($CONTAINER_ID) ==="
log "Action: docker restart $CONTAINER_ID"
log "FORBIDDEN: docker compose down, prune, config rewrite, broad stack restart"

run_or_dry docker restart "$CONTAINER_ID"
log "Restart issued."

if [[ "$DRY_RUN" == "false" ]]; then
  # Brief wait for container to come back up.
  RESTART_WAIT=10
  log "Waiting ${RESTART_WAIT}s for container to restart..."
  sleep "$RESTART_WAIT"
fi

# ---------------------------------------------------------------------------
# STEP 6: Re-verify mount identity after restart
# ---------------------------------------------------------------------------
log "=== STEP 6: Re-verify mount identity ==="
if [[ "$DRY_RUN" == "false" ]]; then
  POST_CONTAINER_ID="$(docker ps \
    --filter "label=com.docker.compose.service=${TARGET_SERVICE}" \
    --filter 'label=com.docker.compose.project=quarangate' \
    --format '{{.ID}}' 2>/dev/null | head -1)"

  if [[ -z "$POST_CONTAINER_ID" ]]; then
    fail "Container did not come back up after restart."
  fi

  if [[ "$TARGET_SERVICE" == "executor" ]]; then
    POST_SOCK_TYPE="$(docker exec --no-tty "$POST_CONTAINER_ID" stat -c '%F' /var/run/docker.sock 2>/dev/null || echo 'error')"
    if [[ "$POST_SOCK_TYPE" != "socket" ]]; then
      fail "Post-restart: executor socket is still '$POST_SOCK_TYPE', not a Unix socket. Recovery FAILED."
    fi
    log "Post-restart executor socket type: $POST_SOCK_TYPE (PASS)"
  fi

  if [[ "$TARGET_SERVICE" == "gateway" ]]; then
    POST_CLIENTS="$(docker exec --no-tty "$POST_CONTAINER_ID" test -f /config/clients.yaml && echo ok || echo missing 2>/dev/null || echo missing)"
    if [[ "$POST_CLIENTS" != "ok" ]]; then
      fail "Post-restart: gateway /config/clients.yaml still missing. Recovery FAILED."
    fi
    log "Post-restart gateway /config/clients.yaml: present (PASS)"
  fi
fi

# ---------------------------------------------------------------------------
# STEP 7: Re-verify readiness
# ---------------------------------------------------------------------------
log "=== STEP 7: Re-verify readiness ==="
if [[ "$DRY_RUN" == "false" ]]; then
  READY_WAIT=5
  sleep "$READY_WAIT"

  if [[ "$TARGET_SERVICE" == "executor" ]]; then
    EXEC_READYZ="$(docker exec --no-tty "$POST_CONTAINER_ID" \
      node -e "fetch('http://127.0.0.1:8990/readyz').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('error'))" \
      2>/dev/null || echo 'error')"
    if [[ "$EXEC_READYZ" == "200" ]]; then
      log "Executor /readyz: HTTP 200 (PASS)"
    else
      fail "Executor /readyz returned '$EXEC_READYZ' after restart. Recovery FAILED."
    fi
  fi

  if [[ "$TARGET_SERVICE" == "gateway" ]]; then
    GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8787}"
    GW_STATUS="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 5 "${GATEWAY_URL}/readyz" 2>/dev/null || echo '000')"
    if [[ "$GW_STATUS" == "200" ]]; then
      log "Gateway /readyz: HTTP 200 (PASS)"
    else
      fail "Gateway /readyz returned '$GW_STATUS' after restart. Recovery FAILED."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# STEP 8: Run overall doctor
# ---------------------------------------------------------------------------
log "=== STEP 8: Overall doctor check ==="
if [[ "$DRY_RUN" == "false" && -x "$DOCTOR" ]]; then
  "$DOCTOR" || {
    log "WARNING: workstation-doctor.sh reported failures after recovery."
    log "Inspect the output above. The targeted restart succeeded but other issues exist."
  }
fi

# ---------------------------------------------------------------------------
# STEP 9: Final verdict
# ---------------------------------------------------------------------------
log "=== STEP 9: Recovery verdict ==="
if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY RUN complete — no changes made."
  exit 0
fi
log "PASS: targeted $TARGET_SERVICE recovery completed successfully."
exit 0
