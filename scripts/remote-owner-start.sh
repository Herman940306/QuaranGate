#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() { printf 'REMOTE_OWNER_START=FAIL reason=%s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'docker CLI missing'

# Docker Desktop/WSL can take time to become ready after Windows logon.
ready=0
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[[ "$ready" == 1 ]] || fail 'Docker Engine not ready after 120 seconds'

export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}"
[[ -d "$PROJECTS_ROOT" ]] || fail "projects root missing: $PROJECTS_ROOT"

# Never pull or build during unattended recovery. Every required artifact must
# already be present locally; absence is a fail-closed condition.
docker image inspect "${PROJECTS_WORK_IMAGE:-assistant-environment-work:latest}" >/dev/null 2>&1 \
  || fail 'projects-work image missing locally'

printf '%s\n' '=== START QUARANGATE ==='
docker compose -p quarangate -f compose.yaml up -d --no-build --pull never

printf '%s\n' '=== START PROJECTS WORK ==='
docker compose -p projects-work -f projects-work-target/compose.yaml up -d --no-build --pull never

printf '%s\n' '=== WAIT FOR GATEWAY ==='
healthy=0
for _ in $(seq 1 60); do
  state="$(docker inspect quarangate-gateway-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  if [[ "$state" == healthy ]]; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || fail 'gateway did not become healthy after 120 seconds'

"$REPO_ROOT/scripts/remote-owner-health.sh"
printf '%s\n' 'REMOTE_OWNER_START=PASS'
