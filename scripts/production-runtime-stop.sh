#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
ENV_FILE="$ROOT/.env"
PROJECTS_COMPOSE="$ROOT/config/projects.compose.yaml"
CORE_COMPOSE="$ROOT/compose.yaml"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || { echo 'PRODUCTION_RUNTIME_STOP=FAIL reason=runtime-env-missing' >&2; exit 1; }
# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
export QG_RUNTIME_UID="$(id -u)"
export QG_RUNTIME_GID="$(id -g)"
core_args=(docker compose --env-file "$ENV_FILE" -p quarangate -f "$CORE_COMPOSE")
projects_args=(docker compose --env-file "$ENV_FILE" -p quarangate-projects -f "$PROJECTS_COMPOSE")
"${core_args[@]}" down --remove-orphans
"${projects_args[@]}" down --remove-orphans
printf 'PRODUCTION_RUNTIME_STOP=PASS\n'
