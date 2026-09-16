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

# Compose gives inherited shell variables higher precedence than --env-file.
# SH-06 persists both the service-specific local tag and the immutable Docker
# image ID. Recovery trusts neither ambient exports nor a tag by itself: all six
# keys must exist exactly once and every tag must still resolve to its persisted
# content ID before Compose is allowed to start anything.
for key in GATEWAY_IMAGE DOCKER_AUTHORITY_IMAGE EXECUTOR_IMAGE; do
  count="$(grep -c "^${key}=" "$RUNTIME_ENV" || true)"
  [[ "$count" == 1 ]] || fail "runtime .env must contain exactly one ${key}"
  value="$(sed -n "s/^${key}=//p" "$RUNTIME_ENV")"
  [[ -n "$value" ]] || fail "runtime .env ${key} is empty"
  [[ "$value" != *:latest ]] || fail "runtime .env ${key} must not use :latest"
  [[ "$value" != *[[:space:]]* ]] || fail "runtime .env ${key} contains whitespace"
  export "$key=$value"
done
for key in GATEWAY_IMAGE_ID DOCKER_AUTHORITY_IMAGE_ID EXECUTOR_IMAGE_ID; do
  count="$(grep -c "^${key}=" "$RUNTIME_ENV" || true)"
  [[ "$count" == 1 ]] || fail "runtime .env must contain exactly one ${key}"
  value="$(sed -n "s/^${key}=//p" "$RUNTIME_ENV")"
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "runtime .env ${key} is not an immutable Docker image ID"
  export "$key=$value"
done
for pair in GATEWAY_IMAGE:GATEWAY_IMAGE_ID DOCKER_AUTHORITY_IMAGE:DOCKER_AUTHORITY_IMAGE_ID EXECUTOR_IMAGE:EXECUTOR_IMAGE_ID; do
  ref_key="${pair%%:*}"; id_key="${pair#*:}"
  ref="${!ref_key}"; expected_id="${!id_key}"
  actual_id="$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null || true)"
  [[ "$actual_id" == "$expected_id" ]] || fail "runtime image tag-to-ID binding mismatch for ${ref_key}"
done
unset key count value pair ref_key id_key ref expected_id actual_id

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
  ollama_image_count="$(grep -c '^OLLAMA_IMAGE=' "$RUNTIME_ENV" || true)"
  [[ "$ollama_image_count" == 1 ]] || fail 'O1 runtime requires exactly one OLLAMA_IMAGE'
  ollama_image="$(sed -n 's/^OLLAMA_IMAGE=//p' "$RUNTIME_ENV")"
  [[ "$ollama_image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || fail 'OLLAMA_IMAGE must be digest-pinned with @sha256'
  QG_FILES+=(-f "$RUNTIME_ROOT/compose.ollama.yaml")
fi

# Preserve the optional A7 Copilot executor overlay whenever the trusted
# runtime env explicitly selects a Copilot runner image. This is executor-only;
# it creates no service, public port, or Docker authority.
copilot_expected=0
if grep -Eq '^AGENT_COPILOT_RUNNER_IMAGE=.+$' "$RUNTIME_ENV"; then copilot_expected=1; fi
if [[ "$copilot_expected" == 1 ]]; then
  copilot_overlay="$RUNTIME_ROOT/compose.copilot.yaml"
  if [[ ! -f "$copilot_overlay" && -f "$REPO_ROOT/compose.copilot.yaml" ]]; then copilot_overlay="$REPO_ROOT/compose.copilot.yaml"; fi
  [[ -f "$copilot_overlay" ]] || fail 'Copilot is configured but compose.copilot.yaml is missing'
  QG_FILES+=(-f "$copilot_overlay")
fi

# Preserve GitHub App control when its trusted registry exists or the broker
# already exists. Recovery never invents credentials, mappings, or egress.
github_expected=0
if [[ -f "$RUNTIME_ROOT/config/github.yaml" ]]; then github_expected=1; fi
if docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=github-broker --format '{{.ID}}' | grep -q .; then github_expected=1; fi
if docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=github-egress-proxy --format '{{.ID}}' | grep -q .; then github_expected=1; fi
if [[ "$github_expected" == 1 ]]; then
  github_overlay="$RUNTIME_ROOT/compose.github.yaml"
  if [[ ! -f "$github_overlay" && -f "$REPO_ROOT/compose.github.yaml" ]]; then github_overlay="$REPO_ROOT/compose.github.yaml"; fi
  [[ -f "$github_overlay" ]] || fail 'GitHub control is configured but compose.github.yaml is missing'
  QG_FILES+=(-f "$github_overlay")
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

# SH-06: prove Compose actually started the exact persisted primary artifacts.
for spec in \
  "gateway|$GATEWAY_IMAGE|$GATEWAY_IMAGE_ID" \
  "docker-authority|$DOCKER_AUTHORITY_IMAGE|$DOCKER_AUTHORITY_IMAGE_ID" \
  "executor|$EXECUTOR_IMAGE|$EXECUTOR_IMAGE_ID"; do
  service="${spec%%|*}"; rest="${spec#*|}"; expected_ref="${rest%%|*}"; expected_id="${rest#*|}"
  cid="$("${QG[@]}" ps -q "$service")"
  [[ -n "$cid" ]] || fail "${service} container missing after start"
  live_ref="$(docker inspect "$cid" --format '{{.Config.Image}}')"
  live_id="$(docker inspect "$cid" --format '{{.Image}}')"
  [[ "$live_ref" == "$expected_ref" && "$live_id" == "$expected_id" ]] || fail "${service} live image identity mismatch"
done
if [[ "$github_expected" == 1 ]]; then
  for service in github-broker github-egress-proxy; do
    cid="$("${QG[@]}" ps -q "$service")"
    [[ -n "$cid" ]] || fail "${service} container missing after start"
    live_ref="$(docker inspect "$cid" --format '{{.Config.Image}}')"
    live_id="$(docker inspect "$cid" --format '{{.Image}}')"
    [[ "$live_ref" == "$GATEWAY_IMAGE" && "$live_id" == "$GATEWAY_IMAGE_ID" ]] || fail "${service} live image identity mismatch"
  done
fi
unset spec service rest expected_ref expected_id cid live_ref live_id

QUARANGATE_RUNTIME_ENV="$RUNTIME_ENV" "$REPO_ROOT/scripts/remote-owner-health.sh"
printf '%s\n' 'REMOTE_OWNER_START=PASS'
