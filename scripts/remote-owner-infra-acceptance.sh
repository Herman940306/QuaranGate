#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() { printf 'REMOTE_OWNER_INFRA_ACCEPTANCE=FAIL reason=%s\n' "$*" >&2; exit 1; }
pass() { printf '%s=PASS\n' "$1"; }

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

# Resolve service containers from trusted Compose identity, not guessed names.
gateway_id="$("${QG[@]}" ps -q gateway)"
executor_id="$("${QG[@]}" ps -q executor)"
projects_id="$("${PW[@]}" ps -q work)"
[[ -n "$gateway_id" ]] || fail 'gateway container missing'
[[ -n "$executor_id" ]] || fail 'executor container missing'
[[ -n "$projects_id" ]] || fail 'projects-work container missing'

# Gateway must stay loopback-published only.
ports="$(docker inspect "$gateway_id" --format '{{json .HostConfig.PortBindings}}')"
printf '%s\n' "$ports" | grep -q '127.0.0.1' || fail 'gateway is not loopback-bound'
if printf '%s\n' "$ports" | grep -Eq '"HostIp":"(0\.0\.0\.0|::|)"'; then
  fail 'gateway has wildcard/public host binding'
fi
pass GATEWAY_LOOPBACK_ONLY

# Executor must have no published host ports.
executor_ports="$(docker inspect "$executor_id" --format '{{json .HostConfig.PortBindings}}')"
[[ "$executor_ports" == 'null' || "$executor_ports" == '{}' ]] || fail 'executor unexpectedly publishes host ports'
pass EXECUTOR_UNPUBLISHED

# Docker socket authority belongs to the private executor, never gateway/work target.
executor_mounts="$(docker inspect "$executor_id" --format '{{json .Mounts}}')"
gateway_mounts="$(docker inspect "$gateway_id" --format '{{json .Mounts}}')"
projects_mounts="$(docker inspect "$projects_id" --format '{{json .Mounts}}')"
printf '%s\n' "$executor_mounts" | grep -q '/var/run/docker.sock' || fail 'executor Docker socket missing'
if printf '%s\n' "$gateway_mounts" | grep -q '/var/run/docker.sock'; then fail 'gateway has Docker socket'; fi
if printf '%s\n' "$projects_mounts" | grep -q '/var/run/docker.sock'; then fail 'projects-work has Docker socket'; fi
pass EXECUTOR_ONLY_DOCKER_SOCKET

# Umbrella host bind must be exactly the approved projects root -> /workspace RW.
mount_line="$(docker inspect "$projects_id" --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}|{{.Destination}}|{{.RW}}{{end}}{{end}}')"
[[ "$mount_line" == "$PROJECTS_ROOT|/workspace|true" ]] || fail "unexpected projects-work bind: $mount_line"
pass PROJECTS_ROOT_RW_BOUNDARY

# If O1 is configured, prove the overlay is still represented in the live stack
# rather than silently dropping the inference service during remote recovery.
if [[ "$ollama_expected" == 1 ]]; then
  ollama_id="$("${QG[@]}" ps -q ollama)"
  [[ -n "$ollama_id" ]] || fail 'configured O1 Ollama service missing'
  ollama_running="$(docker inspect "$ollama_id" --format '{{.State.Running}}')"
  [[ "$ollama_running" == true ]] || fail 'configured O1 Ollama service is not running'
  pass O1_COMPOSITION_PRESERVED
fi

curl -fsS "http://127.0.0.1:${BRIDGE_PORT:-8787}/readyz" >/dev/null || fail 'gateway readiness failed'
pass LOCAL_GATEWAY_READY

printf '%s\n' 'REMOTE_OWNER_INFRA_ACCEPTANCE=PASS'
