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

# Runtime secrets and immutable image selections live in the ignored operator
# .env. During candidate qualification the script may run from a linked worktree,
# so fall back to the parent/main worktree's .env without copying or printing it.
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

# Preserve the currently configured O1 composition. If the trusted runtime env
# declares the Ollama backend OR an existing QuaranGate Ollama service exists,
# recovery must include compose.ollama.yaml rather than silently dropping O1.
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

# Unattended recovery must never resolve QuaranGate through a mutable :latest
# tag and must never pull/build. Every configured image has to exist locally.
mapfile -t qg_images < <("${QG[@]}" config --images | sort -u)
[[ ${#qg_images[@]} -ge 2 ]] || fail 'expected gateway and executor image selections'
for image in "${qg_images[@]}"; do
  [[ -n "$image" ]] || fail 'empty QuaranGate image selection'
  [[ "$image" != *:latest ]] || fail "mutable QuaranGate image refused: $image"
  docker image inspect "$image" >/dev/null 2>&1 || fail "required QuaranGate image missing locally: $image"
done

mapfile -t pw_images < <("${PW[@]}" config --images | sort -u)
[[ ${#pw_images[@]} -eq 1 ]] || fail 'expected one projects-work image selection'
for image in "${pw_images[@]}"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "projects-work image missing locally: $image"
done

printf '%s\n' '=== START QUARANGATE ==='
"${QG[@]}" up -d --no-build --pull never

printf '%s\n' '=== START PROJECTS WORK ==='
"${PW[@]}" up -d --no-build --pull never

printf '%s\n' '=== WAIT FOR GATEWAY ==='
gateway_id="$("${QG[@]}" ps -q gateway)"
[[ -n "$gateway_id" ]] || fail 'gateway container missing after start'
healthy=0
for _ in $(seq 1 60); do
  state="$(docker inspect "$gateway_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  if [[ "$state" == healthy ]]; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || fail 'gateway did not become healthy after 120 seconds'

QUARANGATE_RUNTIME_ENV="$RUNTIME_ENV" "$REPO_ROOT/scripts/remote-owner-health.sh"
printf '%s\n' 'REMOTE_OWNER_START=PASS'
