#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() { printf 'REMOTE_OWNER_HEALTH=FAIL reason=%s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'docker CLI missing'
docker info >/dev/null 2>&1 || fail 'Docker Engine unavailable'
export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}"
[[ -d "$PROJECTS_ROOT" ]] || fail "projects root missing: $PROJECTS_ROOT"

printf '%s\n' '=== QUARANGATE ==='
gateway_id="$(docker compose -p quarangate -f compose.yaml ps -q gateway)"
executor_id="$(docker compose -p quarangate -f compose.yaml ps -q executor)"
projects_id="$(docker compose -p projects-work -f projects-work-target/compose.yaml ps -q work)"
[[ -n "$gateway_id" ]] || fail 'gateway missing'
[[ -n "$executor_id" ]] || fail 'executor missing'
[[ -n "$projects_id" ]] || fail 'projects-work missing'
docker inspect "$gateway_id" --format 'GATEWAY_RUNNING={{.State.Running}} GATEWAY_HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
docker inspect "$executor_id" --format 'EXECUTOR_RUNNING={{.State.Running}} EXECUTOR_HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'

printf '%s\n' '=== PROJECTS WORK ==='
docker inspect "$projects_id" --format 'PROJECTS_WORK_RUNNING={{.State.Running}} IMAGE={{.Config.Image}}'
# Negative proof: the umbrella target itself must never receive Docker authority.
if docker inspect "$projects_id" --format '{{json .Mounts}}' | grep -q '/var/run/docker.sock'; then
  fail 'projects-work unexpectedly has Docker socket'
fi
printf '%s\n' 'PROJECTS_WORK_DOCKER_SOCKET=ABSENT'

printf '%s\n' '=== LOCAL GATEWAY ==='
curl -fsS http://127.0.0.1:${BRIDGE_PORT:-8787}/readyz >/dev/null || fail 'gateway readiness failed'
printf '%s\n' 'LOCAL_GATEWAY_READY=PASS'

printf '%s\n' '=== REMOTE INGRESS ==='
if command -v tailscale >/dev/null 2>&1; then
  # Read-only status check. Ingress mutation remains a separate owner/host action.
  if tailscale funnel status 2>/dev/null | grep -q '127.0.0.1:8787'; then
    printf '%s\n' 'TAILSCALE_FUNNEL_TO_GATEWAY=PASS'
  else
    printf '%s\n' 'TAILSCALE_FUNNEL_TO_GATEWAY=NOT_CONFIRMED'
  fi
else
  printf '%s\n' 'TAILSCALE_CLI=NOT_PRESENT_IN_THIS_WSL_CONTEXT'
fi

printf '%s\n' 'REMOTE_OWNER_HEALTH=PASS'
