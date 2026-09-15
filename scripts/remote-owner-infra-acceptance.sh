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

# Resolve service containers from trusted Compose identity, not guessed names.
gateway_id="$("${QG[@]}" ps -q gateway)"
executor_id="$("${QG[@]}" ps -q executor)"
projects_id="$("${PW[@]}" ps -q work)"
[[ -n "$gateway_id" ]] || fail 'gateway container missing'
[[ -n "$executor_id" ]] || fail 'executor container missing'
[[ -n "$projects_id" ]] || fail 'projects-work container missing'
github_id=''
github_proxy_id=''
if [[ "$github_expected" == 1 ]]; then
  github_id="$("${QG[@]}" ps -q github-broker)"
  github_proxy_id="$("${QG[@]}" ps -q github-egress-proxy)"
  [[ -n "$github_id" ]] || fail 'configured GitHub broker container missing'
  [[ -n "$github_proxy_id" ]] || fail 'configured GitHub egress proxy container missing'
fi

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

# Docker socket authority belongs to the private executor, never gateway/work/broker.
executor_mounts="$(docker inspect "$executor_id" --format '{{json .Mounts}}')"
gateway_mounts="$(docker inspect "$gateway_id" --format '{{json .Mounts}}')"
projects_mounts="$(docker inspect "$projects_id" --format '{{json .Mounts}}')"
printf '%s\n' "$executor_mounts" | grep -q '/var/run/docker.sock' || fail 'executor Docker socket missing'
if printf '%s\n' "$gateway_mounts" | grep -q '/var/run/docker.sock'; then fail 'gateway has Docker socket'; fi
if printf '%s\n' "$projects_mounts" | grep -q '/var/run/docker.sock'; then fail 'projects-work has Docker socket'; fi
if [[ "$github_expected" == 1 ]]; then
  github_mounts="$(docker inspect "$github_id" --format '{{json .Mounts}}')"
  github_ports="$(docker inspect "$github_id" --format '{{json .HostConfig.PortBindings}}')"
  github_running="$(docker inspect "$github_id" --format '{{.State.Running}}')"
  github_health="$(docker inspect "$github_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
  proxy_mounts="$(docker inspect "$github_proxy_id" --format '{{json .Mounts}}')"
  proxy_ports="$(docker inspect "$github_proxy_id" --format '{{json .HostConfig.PortBindings}}')"
  proxy_running="$(docker inspect "$github_proxy_id" --format '{{.State.Running}}')"
  proxy_health="$(docker inspect "$github_proxy_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
  [[ "$github_ports" == 'null' || "$github_ports" == '{}' ]] || fail 'GitHub broker unexpectedly publishes host ports'
  [[ "$proxy_ports" == 'null' || "$proxy_ports" == '{}' ]] || fail 'GitHub egress proxy unexpectedly publishes host ports'
  [[ "$github_running" == true ]] || fail 'GitHub broker is not running'
  [[ "$github_health" == healthy ]] || fail "GitHub broker is not healthy: $github_health"
  [[ "$proxy_running" == true ]] || fail 'GitHub egress proxy is not running'
  [[ "$proxy_health" == healthy ]] || fail "GitHub egress proxy is not healthy: $proxy_health"
  if printf '%s\n' "$github_mounts" | grep -q '/var/run/docker.sock'; then fail 'GitHub broker has Docker socket'; fi
  if printf '%s\n' "$proxy_mounts" | grep -q '/var/run/docker.sock'; then fail 'GitHub egress proxy has Docker socket'; fi

  # The broker intentionally receives exactly one non-secret host bind under the
  # repository tree: the live trusted GitHub registry, mounted read-only. Do not
  # reject that required file merely because PROJECTS_ROOT is its ancestor.
  # Instead, first prove the exact allowlisted bind, then reject every other
  # projects-root bind. This keeps the broker free of project/worktree access.
  github_config_mount="$(docker inspect "$github_id" --format '{{range .Mounts}}{{if eq .Destination "/config/github.yaml"}}{{.Source}}|{{.Destination}}|{{.RW}}{{end}}{{end}}')"
  expected_github_config_mount="$RUNTIME_ROOT/config/github.yaml|/config/github.yaml|false"
  [[ "$github_config_mount" == "$expected_github_config_mount" ]] || fail "GitHub broker trust-registry mount mismatch: $github_config_mount"

  github_mount_lines="$(docker inspect "$github_id" --format '{{range .Mounts}}{{printf "%s|%s|%t\n" .Source .Destination .RW}}{{end}}')"
  while IFS='|' read -r mount_source mount_destination mount_rw; do
    [[ -n "$mount_source" ]] || continue
    case "$mount_source" in
      "$PROJECTS_ROOT"|"$PROJECTS_ROOT"/*)
        [[ "$mount_source|$mount_destination|$mount_rw" == "$expected_github_config_mount" ]] || \
          fail "GitHub broker has unexpected projects-root mount: $mount_destination"
        ;;
    esac
  done <<< "$github_mount_lines"

  proxy_mount_lines="$(docker inspect "$github_proxy_id" --format '{{range .Mounts}}{{printf "%s|%s|%t\n" .Source .Destination .RW}}{{end}}')"
  while IFS='|' read -r mount_source mount_destination mount_rw; do
    [[ -n "$mount_source" ]] || continue
    case "$mount_source" in
      "$PROJECTS_ROOT"|"$PROJECTS_ROOT"/*) fail "GitHub egress proxy has projects-root mount: $mount_destination" ;;
    esac
  done <<< "$proxy_mount_lines"
  if printf '%s\n' "$executor_mounts" | grep -q 'github-app-private-key'; then fail 'executor unexpectedly receives GitHub App private key'; fi
  github_networks="$(docker inspect "$github_id" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  proxy_networks="$(docker inspect "$github_proxy_id" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  executor_networks="$(docker inspect "$executor_id" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  gateway_networks="$(docker inspect "$gateway_id" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  printf '%s\n' "$github_networks" | grep -qw 'quarangate-github-control' || fail 'GitHub broker missing private control network'
  [[ "$(printf '%s\n' "$github_networks" | wc -w | tr -d ' ')" == 1 ]] || fail 'GitHub broker has unexpected additional network attachment'
  if printf '%s\n' "$github_networks" | grep -qw 'quarangate-internal'; then fail 'GitHub broker must not join the general internal network'; fi
  if printf '%s\n' "$github_networks" | grep -qw 'quarangate-github-egress'; then fail 'GitHub broker has direct external egress'; fi
  if printf '%s\n' "$gateway_networks" | grep -qw 'quarangate-github-control'; then fail 'gateway must not join the private GitHub control network'; fi
  printf '%s\n' "$executor_networks" | grep -qw 'quarangate-github-control' || fail 'executor missing private GitHub control network'
  printf '%s\n' "$proxy_networks" | grep -qw 'quarangate-github-control' || fail 'GitHub egress proxy missing private control network'
  printf '%s\n' "$proxy_networks" | grep -qw 'quarangate-github-egress' || fail 'GitHub egress proxy missing dedicated external network'
  [[ "$(printf '%s\n' "$proxy_networks" | wc -w | tr -d ' ')" == 2 ]] || fail 'GitHub egress proxy has unexpected network attachment'
  proxy_exact_allowlist="$(docker inspect "$github_proxy_id" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^EGRESS_PROXY_EXACT_ALLOWLIST=' || true)"
  [[ "$proxy_exact_allowlist" == 'EGRESS_PROXY_EXACT_ALLOWLIST=api.github.com,github.com' ]] || fail 'GitHub egress proxy exact allowlist mismatch'
  pass GITHUB_BROKER_BOUNDARY
  pass GITHUB_EGRESS_PROXY_BOUNDARY
fi
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
