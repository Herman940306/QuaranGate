#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

printf '%s\n' '=== GITHUB CONTROL CANDIDATE VALIDATION ==='
printf 'HEAD='; git rev-parse HEAD
printf 'BRANCH='; git branch --show-current

printf '%s\n' '=== STATIC ==='
git diff --check
bash -n \
  scripts/remote-owner-start.sh \
  scripts/remote-owner-health.sh \
  scripts/remote-owner-infra-acceptance.sh \
  scripts/remote-owner-deploy-candidate.sh \
  scripts/github-control-candidate-validate.sh
printf '%s\n' 'STATIC=PASS'

printf '%s\n' '=== TYPECHECK ==='
npm run typecheck

printf '%s\n' '=== FOCUSED UNIT ==='
npx vitest run \
  tests/unit/github-control.test.ts \
  tests/unit/github-surface.test.ts \
  tests/unit/a4-egress-proxy.test.ts \
  tests/unit/auth.test.ts \
  tests/unit/validate-config-script.test.ts \
  --reporter=dot

printf '%s\n' '=== FULL UNIT ==='
npm test

printf '%s\n' '=== BUILD ==='
npm run build

printf '%s\n' '=== GITHUB OVERLAY COMPOSE PARSE ==='
INTERNAL_TOKEN=validation-only \
GATEWAY_IMAGE=quarangate:gateway-validation \
EXECUTOR_IMAGE=quarangate:executor-validation \
GITHUB_APP_CLIENT_ID=Iv1234567890abcdef \
GITHUB_GIT_HELPER_IMAGE=quarangate:git-helper-validation \
  docker compose -p quarangate-github-validation -f compose.yaml -f compose.github.yaml config --quiet
printf '%s\n' 'GITHUB_COMPOSE=PASS'

printf '%s\n' '=== LIVE CONFIG PARSE WITH CANDIDATE VALIDATOR ==='
MAIN_ROOT="$ROOT"
if [[ ! -f "$MAIN_ROOT/config/clients.yaml" && -f "$ROOT/../../config/clients.yaml" ]]; then
  MAIN_ROOT="$(cd "$ROOT/../.." && pwd)"
fi
if [[ -f "$MAIN_ROOT/config/clients.yaml" && -f "$MAIN_ROOT/config/bridge.yaml" ]]; then
  CLIENTS_CONFIG="$MAIN_ROOT/config/clients.yaml" \
  BRIDGE_CONFIG="$MAIN_ROOT/config/bridge.yaml" \
  AGENTS_CONFIG="$MAIN_ROOT/config/agents.yaml" \
    node scripts/validate-config.mjs

  printf '%s\n' '=== TRUSTED-ACCOUNT GITHUB EXAMPLE CONFIG ==='
  CLIENTS_CONFIG="$MAIN_ROOT/config/clients.yaml" \
  BRIDGE_CONFIG="$MAIN_ROOT/config/bridge.yaml" \
  AGENTS_CONFIG="$MAIN_ROOT/config/agents.yaml" \
  GITHUB_CONFIG="$ROOT/config/github.example.yaml" \
    node scripts/validate-config.mjs
else
  printf '%s\n' 'LIVE_CONFIG_VALIDATION=SKIP missing live config'
fi

printf '%s\n' 'GITHUB_CONTROL_CANDIDATE_VALIDATION=PASS'
