#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/quarangate"
LOG_FILE="$STATE_ROOT/remote-owner-autostart.log"

mkdir -p "$STATE_ROOT"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE" 2>/dev/null || true
exec >>"$LOG_FILE" 2>&1

printf '=== REMOTE OWNER AUTOSTART %s ===\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf 'USER=%s\n' "$(id -un)"
printf 'REPO_ROOT=%s\n' "$REPO_ROOT"

if "$REPO_ROOT/scripts/remote-owner-start.sh"; then
  printf '%s\n' 'REMOTE_OWNER_AUTOSTART=PASS'
else
  rc=$?
  printf 'REMOTE_OWNER_AUTOSTART=FAIL exit=%s\n' "$rc" >&2
  exit "$rc"
fi
