#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() { printf 'REMOTE_OWNER_HEALTH=FAIL reason=%s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'docker CLI missing'
docker info >/dev/null 2>&1 || fail 'Docker Engine unavailable'
export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}"
[[ -d "$PROJECTS_ROOT" ]] || fail "projects root missing: $PROJECTS_ROOT"

RUNTIME_ENV="${QUARANGATE_RUNTIME_ENV:-$REPO_ROOT/.env}"
if [[ ! -f "$RUNTIME_ENV" && -f "$REPO_ROOT/../../.env" ]]; then
  RUNTIME_ENV="$REPO_ROOT/../../.env"
fi
[[ -f "$RUNTIME_ENV" ]] || fail 'runtime .env not found'

# A linked candidate worktree does not carry ignored runtime config files.
# Resolve the real operator runtime root separately so Compose always mounts
# the live config/ directory rather than the candidate's tracked-only config.
RUNTIME_ROOT="$REPO_ROOT"
if [[ ! -f "$RUNTIME_ROOT/config/clients.yaml" && -f "$REPO_ROOT/../../config/clients.yaml" ]]; then
  RUNTIME_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
fi
[[ -f "$RUNTIME_ROOT/config/clients.yaml" ]] || fail 'runtime clients.yaml not found'
[[ -f "$RUNTIME_ROOT/config/bridge.yaml" ]] || fail 'runtime bridge.yaml not found'
[[ -f "$RUNTIME_ROOT/compose.yaml" ]] || fail 'runtime compose.yaml not found'

QG_FILES=(-f "$RUNTIME_ROOT/compose.yaml")
ollama_expected=0
if grep -q '^OLLAMA_MODEL_QUALIFIER=' "$RUNTIME_ENV"; then ollama_expected=1; fi
if docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=ollama --format '{{.ID}}' | grep -q .; then ollama_expected=1; fi
if [[ "$ollama_expected" == 1 ]]; then
  [[ -f "$RUNTIME_ROOT/compose.ollama.yaml" ]] || fail 'O1 is configured but compose.ollama.yaml is missing'
  QG_FILES+=(-f "$RUNTIME_ROOT/compose.ollama.yaml")
fi

QG=(docker compose --env-file "$RUNTIME_ENV" -p quarangate "${QG_FILES[@]}")
PW=(docker compose --env-file "$RUNTIME_ENV" -p projects-work -f "$REPO_ROOT/projects-work-target/compose.yaml")

printf '%s\n' '=== QUARANGATE ==='
gateway_id="$("${QG[@]}" ps -q gateway)"
executor_id="$("${QG[@]}" ps -q executor)"
projects_id="$("${PW[@]}" ps -q work)"
[[ -n "$gateway_id" ]] || fail 'gateway missing'
[[ -n "$executor_id" ]] || fail 'executor missing'
[[ -n "$projects_id" ]] || fail 'projects-work missing'
docker inspect "$gateway_id" --format 'GATEWAY_RUNNING={{.State.Running}} GATEWAY_HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} IMAGE={{.Config.Image}}'
docker inspect "$executor_id" --format 'EXECUTOR_RUNNING={{.State.Running}} EXECUTOR_HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} IMAGE={{.Config.Image}}'
if [[ "$ollama_expected" == 1 ]]; then
  ollama_id="$("${QG[@]}" ps -q ollama)"
  [[ -n "$ollama_id" ]] || fail 'configured O1 Ollama service missing'
  docker inspect "$ollama_id" --format 'OLLAMA_RUNNING={{.State.Running}} OLLAMA_HEALTH={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} IMAGE={{.Config.Image}}'
fi

printf '%s\n' '=== PROJECTS WORK ==='
docker inspect "$projects_id" --format 'PROJECTS_WORK_RUNNING={{.State.Running}} IMAGE={{.Config.Image}}'
if docker inspect "$projects_id" --format '{{json .Mounts}}' | grep -q '/var/run/docker.sock'; then
  fail 'projects-work unexpectedly has Docker socket'
fi
printf '%s\n' 'PROJECTS_WORK_DOCKER_SOCKET=ABSENT'

printf '%s\n' '=== LOCAL GATEWAY ==='
curl -fsS "http://127.0.0.1:${BRIDGE_PORT:-8787}/readyz" >/dev/null || fail 'gateway readiness failed'
printf '%s\n' 'LOCAL_GATEWAY_READY=PASS'

printf '%s\n' '=== REMOTE INGRESS ==='
if command -v tailscale >/dev/null 2>&1; then
  if tailscale funnel status 2>/dev/null | grep -q '127.0.0.1:8787'; then
    printf '%s\n' 'TAILSCALE_FUNNEL_TO_GATEWAY=PASS'
  else
    printf '%s\n' 'TAILSCALE_FUNNEL_TO_GATEWAY=NOT_CONFIRMED'
  fi
else
  printf '%s\n' 'TAILSCALE_CLI=NOT_PRESENT_IN_THIS_WSL_CONTEXT'
fi

printf '%s\n' 'REMOTE_OWNER_HEALTH=PASS'
