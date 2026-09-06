#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

printf '%s\n' '=== REMOTE OWNER CANDIDATE VALIDATION ==='
printf 'HEAD='; git rev-parse HEAD
printf 'BRANCH='; git branch --show-current

printf '%s\n' '=== STATIC ==='
git diff --check
bash -n scripts/remote-owner-start.sh scripts/remote-owner-health.sh scripts/remote-owner-infra-acceptance.sh scripts/remote-owner-deploy-candidate.sh
printf '%s\n' 'STATIC=PASS'

printf '%s\n' '=== TYPECHECK ==='
npm run typecheck

printf '%s\n' '=== FOCUSED UNIT ==='
npx vitest run \
  tests/unit/target-control.test.ts \
  tests/unit/remote-owner-config.test.ts \
  tests/unit/auth.test.ts \
  tests/unit/validate-config-script.test.ts \
  --reporter=dot

printf '%s\n' '=== FULL UNIT ==='
npm test

printf '%s\n' '=== BUILD ==='
npm run build

printf '%s\n' '=== PROJECTS-WORK COMPOSE PARSE ==='
PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}" \
  docker compose -p projects-work -f projects-work-target/compose.yaml config --quiet
printf '%s\n' 'PROJECTS_WORK_COMPOSE=PASS'

printf '%s\n' '=== LIVE CONFIG PARSE WITH CANDIDATE VALIDATOR ==='
MAIN_ROOT="$(cd "$ROOT/../.." && pwd)"
if [[ -f "$MAIN_ROOT/config/clients.yaml" && -f "$MAIN_ROOT/config/bridge.yaml" ]]; then
  CLIENTS_CONFIG="$MAIN_ROOT/config/clients.yaml" \
  BRIDGE_CONFIG="$MAIN_ROOT/config/bridge.yaml" \
  AGENTS_CONFIG="$MAIN_ROOT/config/agents.yaml" \
    node scripts/validate-config.mjs
else
  printf '%s\n' 'LIVE_CONFIG_VALIDATION=SKIP missing parent live config'
fi

printf '%s\n' 'REMOTE_OWNER_CANDIDATE_VALIDATION=PASS'
