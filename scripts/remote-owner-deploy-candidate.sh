#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() { printf 'REMOTE_OWNER_DEPLOY=FAIL reason=%s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail 'git missing'
command -v python3 >/dev/null 2>&1 || fail 'python3 missing'

REV="$(git rev-parse HEAD)"
BRANCH="$(git branch --show-current)"
[[ -n "$REV" && -n "$BRANCH" ]] || fail 'candidate Git identity unavailable'
[[ -z "$(git status --porcelain)" ]] || fail 'candidate worktree is not clean'

runtime_root_complete() {
  local root="$1"
  [[ -d "$root" && -f "$root/.env" && -f "$root/config/clients.yaml" && -f "$root/config/bridge.yaml" && -f "$root/compose.yaml" ]]
}

canonical_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

# Resolve the operator runtime independently of candidate-worktree layout.
# Priority is explicit trusted root, explicit runtime-env parent, then exact
# candidate root, then the Git common-dir parent used by linked worktrees.
# Isolated host clones must supply QUARANGATE_RUNTIME_ROOT or
# QUARANGATE_RUNTIME_ENV rather than guessing an operator path.
MAIN_ROOT=''
if [[ -n "${QUARANGATE_RUNTIME_ROOT:-}" ]]; then
  MAIN_ROOT="$(canonical_dir "$QUARANGATE_RUNTIME_ROOT")" || fail 'explicit runtime root is not a real directory'
  runtime_root_complete "$MAIN_ROOT" || fail 'explicit runtime root is incomplete'
elif [[ -n "${QUARANGATE_RUNTIME_ENV:-}" ]]; then
  [[ -f "$QUARANGATE_RUNTIME_ENV" ]] || fail 'explicit runtime .env not found'
  MAIN_ROOT="$(canonical_dir "$(dirname "$QUARANGATE_RUNTIME_ENV")")" || fail 'explicit runtime .env parent is not a real directory'
  runtime_root_complete "$MAIN_ROOT" || fail 'runtime root derived from explicit .env is incomplete'
elif runtime_root_complete "$REPO_ROOT"; then
  MAIN_ROOT="$REPO_ROOT"
else
  git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  git_common_parent=''
  if [[ -n "$git_common_dir" && "$(basename "$git_common_dir")" == '.git' ]]; then
    git_common_parent="$(canonical_dir "$(dirname "$git_common_dir")" || true)"
  fi
  [[ -n "$git_common_parent" && "$git_common_parent" != "$REPO_ROOT" ]] || fail 'operator runtime root cannot be derived from candidate Git topology'
  runtime_root_complete "$git_common_parent" || fail 'Git common-dir parent is not a complete operator runtime root'
  MAIN_ROOT="$git_common_parent"
fi
RUNTIME_ENV="${QUARANGATE_RUNTIME_ENV:-$MAIN_ROOT/.env}"
[[ -f "$RUNTIME_ENV" ]] || fail 'runtime .env not found'

if [[ "${1:-}" == '--resolve-runtime-root-only' ]]; then
  printf 'MAIN_ROOT=%s\nRUNTIME_ENV=%s\n' "$MAIN_ROOT" "$RUNTIME_ENV"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail 'docker CLI missing'
docker info >/dev/null 2>&1 || fail 'Docker Engine unavailable'

export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}"
[[ -d "$PROJECTS_ROOT" ]] || fail "projects root missing: $PROJECTS_ROOT"

# Preserve the current O1 overlay whenever it is configured or already exists.
QG_FILES=(-f "$MAIN_ROOT/compose.yaml")
ollama_expected=0
if grep -q '^OLLAMA_MODEL_QUALIFIER=' "$RUNTIME_ENV"; then ollama_expected=1; fi
if docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=ollama --format '{{.ID}}' | grep -q .; then ollama_expected=1; fi
if [[ "$ollama_expected" == 1 ]]; then
  [[ -f "$MAIN_ROOT/compose.ollama.yaml" ]] || fail 'O1 is configured but compose.ollama.yaml is missing'
  QG_FILES+=(-f "$MAIN_ROOT/compose.ollama.yaml")
fi
# The candidate topology comes from the candidate worktree while relative
# operator binds (./config, secrets) are resolved against MAIN_ROOT. Rollback
# keeps the exact predeploy operator topology from MAIN_ROOT instead.
BASE_QG_FILES=(-f "$MAIN_ROOT/compose.yaml")
QG_FILES=(-f "$REPO_ROOT/compose.yaml")
if [[ "$ollama_expected" == 1 ]]; then
  BASE_QG_FILES+=(-f "$MAIN_ROOT/compose.ollama.yaml")
  [[ -f "$REPO_ROOT/compose.ollama.yaml" ]] || fail 'O1 is configured but candidate compose.ollama.yaml is missing'
  QG_FILES+=(-f "$REPO_ROOT/compose.ollama.yaml")
fi

# A7 Copilot is executor-only. If runtime configuration already enables it,
# rollback retains the MAIN_ROOT overlay while candidate deployment validates
# and uses the candidate overlay.
copilot_expected=0
if grep -Eq '^AGENT_COPILOT_RUNNER_IMAGE=.+$' "$RUNTIME_ENV"; then copilot_expected=1; fi
if [[ "$copilot_expected" == 1 ]]; then
  [[ -f "$MAIN_ROOT/compose.copilot.yaml" ]] || fail 'Copilot is configured but runtime compose.copilot.yaml is missing'
  [[ -f "$REPO_ROOT/compose.copilot.yaml" ]] || fail 'Copilot is configured but candidate compose.copilot.yaml is missing'
  BASE_QG_FILES+=(-f "$MAIN_ROOT/compose.copilot.yaml")
  QG_FILES+=(-f "$REPO_ROOT/compose.copilot.yaml")
fi

# GitHub baseline discovery must not depend on the candidate Compose graph. A
# candidate overlay can differ from the running topology and previously caused
# both pre-existing services to be misclassified as absent during rollback.
mapfile -t old_github_ids < <(docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=github-broker --format '{{.ID}}')
mapfile -t old_github_proxy_ids < <(docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=github-egress-proxy --format '{{.ID}}')
[[ ${#old_github_ids[@]} -le 1 ]] || fail 'ambiguous predeploy GitHub broker baseline'
[[ ${#old_github_proxy_ids[@]} -le 1 ]] || fail 'ambiguous predeploy GitHub egress proxy baseline'
[[ ${#old_github_ids[@]} -eq ${#old_github_proxy_ids[@]} ]] || fail 'incomplete predeploy GitHub control baseline'
OLD_GITHUB_PRESENT=${#old_github_ids[@]}
github_preexisting="$OLD_GITHUB_PRESENT"
github_expected=0
if [[ -f "$MAIN_ROOT/config/github.yaml" || "$OLD_GITHUB_PRESENT" == 1 ]]; then github_expected=1; fi
if [[ "$github_expected" == 1 ]]; then
  [[ -f "$REPO_ROOT/compose.github.yaml" ]] || fail 'candidate compose.github.yaml is missing'
  [[ -f "$MAIN_ROOT/config/github.yaml" ]] || fail 'GitHub control is active but runtime github.yaml is missing'
  github_rollback_overlay="$MAIN_ROOT/compose.github.yaml"
  if [[ ! -f "$github_rollback_overlay" ]]; then github_rollback_overlay="$REPO_ROOT/compose.github.yaml"; fi
  [[ -f "$github_rollback_overlay" ]] || fail 'GitHub control is active but no rollback compose.github.yaml is available'
  # Candidate deploy uses candidate overlay; rollback uses the runtime overlay
  # when present, otherwise the accepted candidate-overlay fallback.
  BASE_QG_FILES+=(-f "$github_rollback_overlay")
  QG_FILES+=(-f "$REPO_ROOT/compose.github.yaml")
fi

# Resolve the exact persisted primary image selections before constructing any
# Compose command. Ambient shell variables outrank --env-file, so export only
# values mechanically read from the trusted runtime file. The Docker-authority
# key did not exist before SH-06; for that one-time migration only, bind its
# baseline to the exact currently running broker image and persist the new
# service-specific selection after a successful deployment.
read_runtime_value() {
  local key="$1"
  python3 - "$RUNTIME_ENV" "$key" <<'PYENV'
import sys
from pathlib import Path
path, key = Path(sys.argv[1]), sys.argv[2]
values=[]
for raw in path.read_text().splitlines():
    if '=' not in raw or raw.lstrip().startswith('#'): continue
    k,v=raw.split('=',1)
    if k==key: values.append(v)
if len(values)!=1 or not values[0]: raise SystemExit(2)
print(values[0])
PYENV
}
BASE_GATEWAY_IMAGE="$(read_runtime_value GATEWAY_IMAGE)" || fail 'runtime .env must contain exactly one non-empty GATEWAY_IMAGE'
BASE_EXECUTOR_IMAGE="$(read_runtime_value EXECUTOR_IMAGE)" || fail 'runtime .env must contain exactly one non-empty EXECUTOR_IMAGE'

# First SH-06 migration may start from the older executor-socket topology where
# no Docker-authority service existed. Preserve that absence as rollback state;
# never invent an old authority image.
mapfile -t legacy_authority_ids < <(docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=docker-authority --format '{{.ID}}')
[[ ${#legacy_authority_ids[@]} -le 1 ]] || fail 'multiple historical Docker-authority containers found'
OLD_DOCKER_AUTHORITY_PRESENT=${#legacy_authority_ids[@]}
BASE_DOCKER_AUTHORITY_IMAGE=''
if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 ]]; then
  BASE_DOCKER_AUTHORITY_IMAGE="$(docker inspect "${legacy_authority_ids[0]}" --format '{{.Config.Image}}')"
  [[ -n "$BASE_DOCKER_AUTHORITY_IMAGE" ]] || fail 'legacy Docker-authority baseline image is empty'
  if persisted_authority="$(read_runtime_value DOCKER_AUTHORITY_IMAGE 2>/dev/null)"; then
    [[ "$persisted_authority" == "$BASE_DOCKER_AUTHORITY_IMAGE" ]] || fail 'persisted Docker-authority selector disagrees with live baseline'
  fi
elif read_runtime_value DOCKER_AUTHORITY_IMAGE >/dev/null 2>&1; then
  fail 'runtime .env selects Docker-authority but no historical authority container exists'
fi

RUNTIME_BUNDLE_PATH="$(read_runtime_value QUARANGATE_NPM_BUNDLE_PATH)" || fail 'runtime .env must contain exactly one non-empty QUARANGATE_NPM_BUNDLE_PATH'
BUNDLE_PATH="${QUARANGATE_DEPLOY_NPM_BUNDLE_PATH:-$RUNTIME_BUNDLE_PATH}"
[[ "$BUNDLE_PATH" == /* && -d "$BUNDLE_PATH" ]] || fail "candidate npm bundle directory missing or non-absolute: $BUNDLE_PATH"

INTERNAL_TOKEN_VALUE="$(read_runtime_value INTERNAL_TOKEN)" || fail 'runtime .env must contain exactly one non-empty INTERNAL_TOKEN'
if DOCKER_AUTHORITY_TOKEN_VALUE="$(read_runtime_value DOCKER_AUTHORITY_TOKEN 2>/dev/null)"; then
  :
else
  [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 0 ]] || fail 'existing Docker-authority requires a persisted DOCKER_AUTHORITY_TOKEN for exact rollback'
  DOCKER_AUTHORITY_TOKEN_VALUE="$(python3 - <<'PYTOKEN'
import secrets
print(secrets.token_urlsafe(32))
PYTOKEN
  )"
  [[ -n "$DOCKER_AUTHORITY_TOKEN_VALUE" ]] || fail 'could not generate Docker-authority token'
fi
[[ "$DOCKER_AUTHORITY_TOKEN_VALUE" != "$INTERNAL_TOKEN_VALUE" ]] || fail 'authority tokens must be distinct'
export DOCKER_AUTHORITY_TOKEN="$DOCKER_AUTHORITY_TOKEN_VALUE"

RUNTIME_OLLAMA_IMAGE=''
CANDIDATE_OLLAMA_IMAGE=''
if [[ "$ollama_expected" == 1 ]]; then
  RUNTIME_OLLAMA_IMAGE="$(read_runtime_value OLLAMA_IMAGE)" || fail 'O1 runtime requires exactly one non-empty OLLAMA_IMAGE'
  if [[ "$RUNTIME_OLLAMA_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
    CANDIDATE_OLLAMA_IMAGE="$RUNTIME_OLLAMA_IMAGE"
  else
    mapfile -t live_ollama_ids < <(docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=ollama --format '{{.ID}}')
    [[ ${#live_ollama_ids[@]} -eq 1 ]] || fail 'tag-to-digest O1 migration requires exactly one historical Ollama container'
    live_ollama_image_id="$(docker inspect "${live_ollama_ids[0]}" --format '{{.Image}}')"
    [[ "$live_ollama_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'historical Ollama image ID is invalid'
    mapfile -t live_ollama_digests < <(docker image inspect "$live_ollama_image_id" --format '{{range .RepoDigests}}{{println .}}{{end}}' | sed '/^$/d')
    [[ ${#live_ollama_digests[@]} -eq 1 ]] || fail 'historical Ollama image must expose exactly one repository digest'
    CANDIDATE_OLLAMA_IMAGE="${live_ollama_digests[0]}"
    [[ "$CANDIDATE_OLLAMA_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || fail 'derived Ollama repository digest is invalid'
    [[ "$(docker image inspect "$CANDIDATE_OLLAMA_IMAGE" --format '{{.Id}}')" == "$live_ollama_image_id" ]] || fail 'derived Ollama repository digest does not preserve image identity'
  fi
  export OLLAMA_IMAGE="$CANDIDATE_OLLAMA_IMAGE"
fi
if KIRO_KEY_FILE="$(read_runtime_value AGENT_KIRO_KEY_FILE 2>/dev/null)"; then
  :
else
  KIRO_KEY_FILE="$(AGENT_KIRO_KEY_FILE='' node "$REPO_ROOT/scripts/resolve-kiro-key-file.mjs")" || fail 'could not resolve Kiro API key host path'
fi
AGENT_KIRO_KEY_FILE="$KIRO_KEY_FILE" node "$REPO_ROOT/scripts/resolve-kiro-key-file.mjs" --verify >/dev/null \
  || fail 'Kiro API key host file metadata preflight failed'
export AGENT_KIRO_KEY_FILE="$KIRO_KEY_FILE"
export GATEWAY_IMAGE="$BASE_GATEWAY_IMAGE" EXECUTOR_IMAGE="$BASE_EXECUTOR_IMAGE"

# Candidate topology is parsed from candidate source, while --project-directory
# keeps relative live config/secret binds anchored to the operator runtime root.
QG=(docker compose --project-directory "$MAIN_ROOT" --env-file "$RUNTIME_ENV" -p quarangate "${QG_FILES[@]}")
if [[ "$ollama_expected" == 1 ]]; then
  BASE_QG=(env OLLAMA_IMAGE="$RUNTIME_OLLAMA_IMAGE" docker compose --project-directory "$MAIN_ROOT" --env-file "$RUNTIME_ENV" -p quarangate "${BASE_QG_FILES[@]}")
else
  BASE_QG=(docker compose --project-directory "$MAIN_ROOT" --env-file "$RUNTIME_ENV" -p quarangate "${BASE_QG_FILES[@]}")
fi
# Build from the candidate worktree, but deploy from MAIN_ROOT so ignored live
# config/ files are mounted from the operator runtime rather than disappearing.
PW=(docker compose --env-file "$RUNTIME_ENV" -p projects-work -f "$REPO_ROOT/projects-work-target/compose.yaml")

printf '%s\n' '=== PREDEPLOY BASELINE ==='
printf 'REV=%s\nBRANCH=%s\n' "$REV" "$BRANCH"
gateway_id="$("${BASE_QG[@]}" ps -q gateway)"
executor_id="$("${BASE_QG[@]}" ps -q executor)"
[[ -n "$gateway_id" ]] || fail 'current gateway container missing'
[[ -n "$executor_id" ]] || fail 'current executor container missing'
OLD_GATEWAY_IMAGE="$(docker inspect "$gateway_id" --format '{{.Config.Image}}')"
OLD_EXECUTOR_IMAGE="$(docker inspect "$executor_id" --format '{{.Config.Image}}')"
OLD_GATEWAY_IMAGE_ID="$(docker inspect "$gateway_id" --format '{{.Image}}')"
OLD_EXECUTOR_IMAGE_ID="$(docker inspect "$executor_id" --format '{{.Image}}')"
OLD_DOCKER_AUTHORITY_IMAGE=''
OLD_DOCKER_AUTHORITY_IMAGE_ID=''
if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 ]]; then
  authority_id="${legacy_authority_ids[0]}"
  OLD_DOCKER_AUTHORITY_IMAGE="$(docker inspect "$authority_id" --format '{{.Config.Image}}')"
  OLD_DOCKER_AUTHORITY_IMAGE_ID="$(docker inspect "$authority_id" --format '{{.Image}}')"
  [[ "$OLD_DOCKER_AUTHORITY_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'could not capture immutable Docker-authority rollback image ID'
fi
[[ "$OLD_GATEWAY_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ && "$OLD_EXECUTOR_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'could not capture immutable rollback image IDs'
OLD_GITHUB_IMAGE=''
OLD_GITHUB_IMAGE_ID=''
OLD_GITHUB_PROXY_IMAGE=''
OLD_GITHUB_PROXY_IMAGE_ID=''
OLD_GITHUB_HEALTH=''
OLD_GITHUB_PROXY_HEALTH=''
OLD_GITHUB_NETWORKS=''
OLD_GITHUB_PROXY_NETWORKS=''
OLD_GITHUB_CONTROL_NETWORK_PRESENT=0
OLD_GITHUB_CONTROL_NETWORK_ID=''
OLD_GITHUB_EGRESS_NETWORK_PRESENT=0
OLD_GITHUB_EGRESS_NETWORK_ID=''
if docker network inspect quarangate-github-control >/dev/null 2>&1; then
  OLD_GITHUB_CONTROL_NETWORK_PRESENT=1
  OLD_GITHUB_CONTROL_NETWORK_ID="$(docker network inspect quarangate-github-control --format '{{.Id}}')"
  [[ -n "$OLD_GITHUB_CONTROL_NETWORK_ID" ]] || fail 'could not capture predeploy GitHub control network identity'
fi
if docker network inspect quarangate-github-egress >/dev/null 2>&1; then
  OLD_GITHUB_EGRESS_NETWORK_PRESENT=1
  OLD_GITHUB_EGRESS_NETWORK_ID="$(docker network inspect quarangate-github-egress --format '{{.Id}}')"
  [[ -n "$OLD_GITHUB_EGRESS_NETWORK_ID" ]] || fail 'could not capture predeploy GitHub egress network identity'
fi
if [[ "$OLD_GITHUB_PRESENT" == 1 ]]; then
  old_github_id="${old_github_ids[0]}"
  old_github_proxy_id="${old_github_proxy_ids[0]}"
  OLD_GITHUB_IMAGE="$(docker inspect "$old_github_id" --format '{{.Config.Image}}')"
  OLD_GITHUB_IMAGE_ID="$(docker inspect "$old_github_id" --format '{{.Image}}')"
  OLD_GITHUB_HEALTH="$(docker inspect "$old_github_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
  OLD_GITHUB_NETWORKS="$(docker inspect "$old_github_id" --format '{{range $name, $network := .NetworkSettings.Networks}}{{$name}}={{$network.NetworkID}};{{end}}')"
  OLD_GITHUB_PROXY_IMAGE="$(docker inspect "$old_github_proxy_id" --format '{{.Config.Image}}')"
  OLD_GITHUB_PROXY_IMAGE_ID="$(docker inspect "$old_github_proxy_id" --format '{{.Image}}')"
  OLD_GITHUB_PROXY_HEALTH="$(docker inspect "$old_github_proxy_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
  OLD_GITHUB_PROXY_NETWORKS="$(docker inspect "$old_github_proxy_id" --format '{{range $name, $network := .NetworkSettings.Networks}}{{$name}}={{$network.NetworkID}};{{end}}')"
  [[ "$OLD_GITHUB_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ && "$OLD_GITHUB_PROXY_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'could not capture immutable GitHub rollback image IDs'
  [[ -n "$OLD_GITHUB_NETWORKS" && -n "$OLD_GITHUB_PROXY_NETWORKS" ]] || fail 'could not capture predeploy GitHub network identity'
fi
printf 'OLD_GATEWAY_IMAGE=%s\nOLD_DOCKER_AUTHORITY_PRESENT=%s\nOLD_DOCKER_AUTHORITY_IMAGE=%s\nOLD_EXECUTOR_IMAGE=%s\nOLD_GITHUB_PRESENT=%s\nOLD_GITHUB_HEALTH=%s\nOLD_GITHUB_PROXY_HEALTH=%s\nOLD_GITHUB_CONTROL_NETWORK_PRESENT=%s\nOLD_GITHUB_EGRESS_NETWORK_PRESENT=%s\n' "$OLD_GATEWAY_IMAGE" "$OLD_DOCKER_AUTHORITY_PRESENT" "$OLD_DOCKER_AUTHORITY_IMAGE" "$OLD_EXECUTOR_IMAGE" "$OLD_GITHUB_PRESENT" "${OLD_GITHUB_HEALTH:-absent}" "${OLD_GITHUB_PROXY_HEALTH:-absent}" "$OLD_GITHUB_CONTROL_NETWORK_PRESENT" "$OLD_GITHUB_EGRESS_NETWORK_PRESENT"

# Build through the governed local-base helper. It verifies the exact npm bundle,
# resolves the pinned Node base only from the local Docker image store through a
# private local OCI-layout build context, keeps RUN networking disabled, and fails closed if
# unexpected registry/auth evidence remains fatal; exact validated OCI client alias normalization is local-only evidence.
BASE_IMAGE='node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81'
docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || fail "local digest-pinned base image missing: $BASE_IMAGE"

NEW_GATEWAY_IMAGE="quarangate:gateway-$REV"
NEW_DOCKER_AUTHORITY_IMAGE="quarangate:docker-authority-$REV"
NEW_EXECUTOR_IMAGE="quarangate:executor-$REV"

printf '%s\n' '=== OFFLINE BUILD / EXACT RELEASE REUSE ==='
# Always bind the selected npm bundle to this exact candidate lock/descriptor,
# including deployments that reuse already-qualified release image tags.
node "$REPO_ROOT/scripts/npm-offline-bundle.mjs" verify \
  --bundle "$BUNDLE_PATH" \
  --lockfile "$REPO_ROOT/package-lock.json" \
  --descriptor "$REPO_ROOT/build/npm-dependencies.json" >/dev/null \
  || fail 'candidate npm bundle does not verify against exact source'

existing_release_refs=0
receipt_core_id=''
for image in "$NEW_GATEWAY_IMAGE" "$NEW_DOCKER_AUTHORITY_IMAGE" "$NEW_EXECUTOR_IMAGE"; do
  if docker image inspect "$image" >/dev/null 2>&1; then existing_release_refs=$((existing_release_refs + 1)); fi
done
if [[ "$existing_release_refs" == 0 ]]; then
  node "$REPO_ROOT/scripts/p10-offline-core-build.mjs" \
    --source-root "$REPO_ROOT" \
    --source-commit "$REV" \
    --bundle "$BUNDLE_PATH" \
    --output-image "$NEW_GATEWAY_IMAGE" || fail 'governed local-only candidate build failed'
  docker tag "$NEW_GATEWAY_IMAGE" "$NEW_DOCKER_AUTHORITY_IMAGE"
  docker tag "$NEW_GATEWAY_IMAGE" "$NEW_EXECUTOR_IMAGE"
elif [[ "$existing_release_refs" == 3 ]]; then
  RELEASE_RECEIPT="${QUARANGATE_DEPLOY_RELEASE_RECEIPT:-}"
  [[ "$RELEASE_RECEIPT" == /* && -f "$RELEASE_RECEIPT" ]] || fail 'existing release refs require absolute QUARANGATE_DEPLOY_RELEASE_RECEIPT'
  receipt_core_id="$(python3 - "$RELEASE_RECEIPT" "$REV" "$(git rev-parse 'HEAD^{tree}')"     "$NEW_GATEWAY_IMAGE" "$NEW_DOCKER_AUTHORITY_IMAGE" "$NEW_EXECUTOR_IMAGE" <<'PYRECEIPT'
import json, re, sys
path, rev, tree, gateway, authority, executor = sys.argv[1:]
doc = json.load(open(path))
if doc.get('status') != 'PASS': raise SystemExit('release receipt is not PASS')
source = doc.get('source') or {}
if source.get('commit') != rev or source.get('tree') != tree or source.get('clean') is not True:
    raise SystemExit('release receipt source binding mismatch')
images = doc.get('images') or {}
core = images.get('coreInput') or {}
core_id = core.get('id')
if not isinstance(core_id, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', core_id):
    raise SystemExit('release receipt core image ID invalid')
expected = {'gateway': gateway, 'docker-authority': authority, 'executor': executor}
seen = {}
for item in images.get('release') or []:
    component = item.get('component')
    if component in expected:
        if component in seen: raise SystemExit('duplicate release image component')
        if item.get('reference') != expected[component] or item.get('digest') != core_id:
            raise SystemExit('release image binding mismatch')
        seen[component] = True
if set(seen) != set(expected): raise SystemExit('release receipt lacks required core image roles')
print(core_id)
PYRECEIPT
  )" || fail 'existing release refs are not bound by the supplied exact release receipt'
  for image in "$NEW_GATEWAY_IMAGE" "$NEW_DOCKER_AUTHORITY_IMAGE" "$NEW_EXECUTOR_IMAGE"; do
    [[ "$(docker image inspect "$image" --format '{{.Id}}')" == "$receipt_core_id" ]] || fail "existing release ref digest mismatch: $image"
  done
  printf 'EXISTING_RELEASE_REFS=VERIFIED receipt=%s\n' "$RELEASE_RECEIPT"
else
  fail 'partial existing release ref set refused'
fi

for image in "$NEW_GATEWAY_IMAGE" "$NEW_DOCKER_AUTHORITY_IMAGE" "$NEW_EXECUTOR_IMAGE"; do
  actual_rev="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  actual_source="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')"
  [[ "$actual_rev" == "$REV" ]] || fail "image provenance mismatch for $image: $actual_rev"
  [[ "$actual_source" == 'https://github.com/Herman940306/QuaranGate' ]] || fail "image source provenance mismatch for $image"
done
new_gateway_id="$(docker image inspect "$NEW_GATEWAY_IMAGE" --format '{{.Id}}')"
new_authority_id="$(docker image inspect "$NEW_DOCKER_AUTHORITY_IMAGE" --format '{{.Id}}')"
new_executor_id="$(docker image inspect "$NEW_EXECUTOR_IMAGE" --format '{{.Id}}')"
[[ "$new_gateway_id" == "$new_authority_id" && "$new_gateway_id" == "$new_executor_id" ]] || fail 'gateway/docker-authority/executor shared-artifact identity mismatch'
if [[ -n "$receipt_core_id" ]]; then
  [[ "$new_gateway_id" == "$receipt_core_id" && "$new_authority_id" == "$receipt_core_id" && "$new_executor_id" == "$receipt_core_id" ]] \
    || fail 'existing release refs changed after receipt validation'
fi
assert_candidate_image_bindings() {
  local image expected_id actual_id
  for pair in \
    "$NEW_GATEWAY_IMAGE|$new_gateway_id" \
    "$NEW_DOCKER_AUTHORITY_IMAGE|$new_authority_id" \
    "$NEW_EXECUTOR_IMAGE|$new_executor_id"; do
    image="${pair%%|*}"; expected_id="${pair#*|}"
    actual_id="$(docker image inspect "$image" --format '{{.Id}}')"
    [[ "$actual_id" == "$expected_id" ]] || fail "candidate image tag retargeted before deployment selection: $image"
  done
  unset pair image expected_id actual_id
}
assert_candidate_image_bindings
printf 'NEW_SHARED_IMAGE_ID=%s\n' "$new_gateway_id"

# Derive schema support from the exact immutable image payloads. The probe is a
# read-only parser mounted into a networkless, pull-disabled container; neither
# candidate nor rollback support is accepted from caller input.
probe_image_schema() {
  local image_id="$1"
  docker run --rm --pull never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint node \
    --mount "type=bind,src=$REPO_ROOT/scripts/sh06-image-schema-probe.mjs,dst=/sh06-image-schema-probe.mjs,readonly" \
    "$image_id" /sh06-image-schema-probe.mjs
}
CANDIDATE_SUPPORTED_SCHEMA="$(probe_image_schema "$new_executor_id")" || fail 'candidate-supported job DB schema unavailable from exact image'
ROLLBACK_IMAGE_SUPPORTED_SCHEMA="$(probe_image_schema "$OLD_EXECUTOR_IMAGE_ID")" || fail 'rollback-supported job DB schema unavailable from exact image'
[[ "$CANDIDATE_SUPPORTED_SCHEMA" =~ ^[0-9]+$ && "$ROLLBACK_IMAGE_SUPPORTED_SCHEMA" =~ ^[0-9]+$ ]] || fail 'image schema evidence is invalid'

# Create a transactionally consistent rollback snapshot before any candidate
# service starts. The live volume is read-only to the helper; backup bytes stay
# in an owner-private operation directory and are never copied into release
# evidence. No registry or network access is possible.
docker volume inspect mcp-bridge-jobs >/dev/null 2>&1 || fail 'persistent mcp-bridge-jobs volume is unavailable'
rollback_state_root="$MAIN_ROOT/.quarangate-rollback"
if [[ ! -e "$rollback_state_root" ]]; then mkdir -m 0700 "$rollback_state_root"; fi
[[ -d "$rollback_state_root" && ! -L "$rollback_state_root" ]] || fail 'rollback-state root is unsafe'
[[ "$(stat -c '%a' "$rollback_state_root")" == 700 ]] || fail 'rollback-state root must have mode 0700'
snapshot_parent="$rollback_state_root/sh06"
if [[ ! -e "$snapshot_parent" ]]; then mkdir -m 0700 "$snapshot_parent"; fi
[[ -d "$snapshot_parent" && ! -L "$snapshot_parent" ]] || fail 'SH-06 rollback-state root is unsafe'
[[ "$(stat -c '%a' "$snapshot_parent")" == 700 ]] || fail 'SH-06 rollback-state root must have mode 0700'
operation_id="${REV:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
snapshot_dir="$snapshot_parent/$operation_id"
[[ ! -e "$snapshot_dir" ]] || fail 'operation-scoped snapshot destination already exists'
mkdir -m 0700 "$snapshot_dir"
snapshot_path="$snapshot_dir/agents.db"
snapshot_manifest="$snapshot_dir/manifest.json"
snapshot_created=0
snapshot_verified=0
snapshot_result="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 1000:1000 \
  --mount type=volume,src=mcp-bridge-jobs,dst=/source,readonly \
  --mount "type=bind,src=$snapshot_dir,dst=/snapshot" \
  "$new_executor_id" node /app/dist/operations/sh06JobDbRecovery.js \
  snapshot /source/agents.db /snapshot/agents.db /snapshot/manifest.json)" \
  || fail 'transactionally consistent job DB snapshot failed'
[[ -f "$snapshot_path" && -f "$snapshot_manifest" ]] || fail 'job DB snapshot outputs are missing'
printf '%s' "$snapshot_result" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="SNAPSHOT_VERIFIED" and d.get("integrityCheck")=="ok"' \
  || fail 'job DB snapshot creation proof is invalid'
snapshot_created=1
snapshot_verify_result="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 1000:1000 \
  --mount "type=bind,src=$snapshot_dir,dst=/snapshot,readonly" \
  "$new_executor_id" node /app/dist/operations/sh06JobDbRecovery.js \
  verify /snapshot/agents.db /snapshot/manifest.json)" \
  || fail 'job DB snapshot verification failed'
CURRENT_DB_SCHEMA="$(printf '%s' "$snapshot_verify_result" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="SNAPSHOT_VERIFIED"; v=d.get("userVersion"); assert isinstance(v,int) and v>=0; print(v)')" \
  || fail 'verified current job DB schema evidence is invalid'
SNAPSHOT_SHA256="$(printf '%s' "$snapshot_verify_result" | python3 -c 'import json,re,sys; v=json.load(sys.stdin).get("sha256",""); assert re.fullmatch(r"[0-9a-f]{64}",v); print(v)')" \
  || fail 'verified snapshot digest evidence is invalid'
SNAPSHOT_SIZE_BYTES="$(printf '%s' "$snapshot_verify_result" | python3 -c 'import json,sys; v=json.load(sys.stdin).get("sizeBytes"); assert isinstance(v,int) and v>0; print(v)')" \
  || fail 'verified snapshot size evidence is invalid'
snapshot_verified=1

# M9: confirm the snapshot captured exactly the pre-deploy schema.  The verify
# step reads userVersion from the snapshot manifest; it must equal the schema
# we just extracted from the same verify output (they are the same field, but
# an explicit cross-check future-proofs against any pre-snapshot inspection
# step that might diverge).
SNAPSHOT_SCHEMA="$(printf '%s' "$snapshot_verify_result" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="SNAPSHOT_VERIFIED"; v=d.get("userVersion"); assert isinstance(v,int) and v>=0; print(v)')" \
  || fail 'snapshot schema evidence is invalid'
[[ "$SNAPSHOT_SCHEMA" == "$CURRENT_DB_SCHEMA" ]] || fail 'snapshot schema differs from pre-deploy current schema (M9: interleaved migration)'

# Schema compatibility gate — evaluated in strict priority order.
# Rule A: candidate cannot open a database whose schema it does not support.
[[ "$CURRENT_DB_SCHEMA" -le "$CANDIDATE_SUPPORTED_SCHEMA" ]] || fail 'current job DB schema is newer than candidate support'

# Rule B (CRITICAL): if the current database schema exceeds the rollback
# executor's supported schema, standard deployment is unconditionally blocked
# regardless of whether a snapshot exists.  A v9 snapshot does not make a v7
# rollback binary capable of reading v9 — that binary will crash deterministically.
# This is the primary fix for the FAIL_REVIEW finding on the 9/9/7 incident matrix.
[[ "$CURRENT_DB_SCHEMA" -le "$ROLLBACK_IMAGE_SUPPORTED_SCHEMA" ]] \
  || fail 'ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE: standard deployment blocked — current DB schema exceeds rollback executor support'

# Rule C: when a migration would occur (candidate > rollback), the verified
# snapshot is the only restoration path.  Already enforced by the unconditional
# snapshot requirement below, but stated explicitly for clarity.
if [[ "$CANDIDATE_SUPPORTED_SCHEMA" -gt "$ROLLBACK_IMAGE_SUPPORTED_SCHEMA" ]]; then
  [[ "$snapshot_created" == 1 && "$snapshot_verified" == 1 ]] || fail 'candidate schema exceeds rollback support without verified snapshot'
fi
[[ "$snapshot_created" == 1 && "$snapshot_verified" == 1 ]] || fail 'verified persistent-state snapshot is mandatory before mutation'
printf 'SCHEMA_PREFLIGHT=PASS CURRENT_DB_SCHEMA=%s CANDIDATE_SUPPORTED_SCHEMA=%s ROLLBACK_IMAGE_SUPPORTED_SCHEMA=%s SNAPSHOT_SCHEMA=%s SNAPSHOT_CREATED=%s SNAPSHOT_VERIFIED=%s\n' \
  "$CURRENT_DB_SCHEMA" "$CANDIDATE_SUPPORTED_SCHEMA" "$ROLLBACK_IMAGE_SUPPORTED_SCHEMA" "$SNAPSHOT_SCHEMA" "$snapshot_created" "$snapshot_verified"
printf 'SNAPSHOT_IDENTITY_SHA256=%s SNAPSHOT_SIZE_BYTES=%s SNAPSHOT_CONTENT_EXPOSED=NO\n' "$SNAPSHOT_SHA256" "$SNAPSHOT_SIZE_BYTES"

# Initialise all mutable-state flags and the env-backup path BEFORE installing
# the EXIT trap so that the trap's cleanup is correct even if the process is
# interrupted between trap installation and the actual mktemp call.
# env_backup='' is safe: rm -f '' is a no-op, and the cp restore branch is
# only reached when env_updated==1, which is only set after the backup exists.
env_backup=''
env_backup_sha256=''
mutated=0
runtime_mutated=0
persistent_state_may_have_mutated=0
env_updated=0
docker_authority_preexisting="$OLD_DOCKER_AUTHORITY_PRESENT"

# Install the EXIT trap HERE — before any temporary secret material is created —
# so that every exit path after this point (success, failure, or signal) cleans
# up the .env backup.  Resolves the LOW finding from the independent review.
trap rollback EXIT

# Create the .env backup immediately after the trap is armed so the file never
# exists outside the trap's protection window.  Mode 0600 before the copy so
# the secret bytes are never world-readable even transiently.
env_backup="$(mktemp)"
chmod 0600 "$env_backup"
cp "$RUNTIME_ENV" "$env_backup"
env_backup_sha256="$(sha256sum "$env_backup" | cut -d' ' -f1)"

printf 'ROLLBACK_STATE snapshot_created=%s snapshot_verified=%s runtime_mutated=%s persistent_state_may_have_mutated=%s env_updated=%s github_preexisting=%s docker_authority_preexisting=%s\n' \
  "$snapshot_created" "$snapshot_verified" "$runtime_mutated" "$persistent_state_may_have_mutated" "$env_updated" "$github_preexisting" "$docker_authority_preexisting"

service_ids() {
  local project="$1" service="$2"
  docker ps -a --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service" --format '{{.ID}}'
}

safe_health_reason() {
  local container_id="$1"
  docker inspect "$container_id" --format '{{json .State.Health.Log}}' 2>/dev/null \
    | node "$REPO_ROOT/scripts/sh06-redact-diagnostic.mjs"
}

emit_service_diagnostics() {
  local project="$1" service="$2" container_id="$3"
  if [[ -z "$container_id" ]]; then
    printf 'CANDIDATE_DIAGNOSTIC service=%s state=MISSING health=unknown reason=container_not_found\n' "$service" >&2
    return
  fi
  local runtime_state health_state restart_count exit_code image_id build_revision reason
  runtime_state="$(docker inspect "$container_id" --format '{{.State.Status}}' 2>/dev/null || true)"
  health_state="$(docker inspect "$container_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  restart_count="$(docker inspect "$container_id" --format '{{.RestartCount}}' 2>/dev/null || true)"
  exit_code="$(docker inspect "$container_id" --format '{{.State.ExitCode}}' 2>/dev/null || true)"
  image_id="$(docker inspect "$container_id" --format '{{.Image}}' 2>/dev/null || true)"
  build_revision="$(docker inspect "$container_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  reason="$(safe_health_reason "$container_id" 2>/dev/null || printf '%s' 'health output unavailable')"
  printf 'CANDIDATE_DIAGNOSTIC service=%s project=%s state=%s health=%s restart_count=%s exit_code=%s build_revision=%s image_id=%s reason=%s\n' \
    "$service" "$project" "${runtime_state:-unknown}" "${health_state:-unknown}" "${restart_count:-unknown}" \
    "${exit_code:-unknown}" "${build_revision:-unknown}" "${image_id:-unknown}" "$reason" >&2
}

wait_service_ready() {
  local project="$1" service="$2" timeout_seconds="$3"
  local elapsed=0 container_id='' runtime_state='' health_state=''
  while (( elapsed < timeout_seconds )); do
    mapfile -t readiness_ids < <(service_ids "$project" "$service")
    if [[ ${#readiness_ids[@]} -gt 1 ]]; then
      printf 'READINESS_GATE=FAIL service=%s classification=AMBIGUOUS\n' "$service" >&2
      return 1
    fi
    container_id="${readiness_ids[0]:-}"
    if [[ -n "$container_id" ]]; then
      runtime_state="$(docker inspect "$container_id" --format '{{.State.Status}}' 2>/dev/null || true)"
      health_state="$(docker inspect "$container_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
      if [[ "$runtime_state" == running && ( "$health_state" == healthy || "$health_state" == none ) ]]; then
        printf 'READINESS_GATE=PASS service=%s state=%s health=%s\n' "$service" "$runtime_state" "$health_state"
        return 0
      fi
      if [[ "$runtime_state" == exited || "$runtime_state" == dead || "$runtime_state" == removing ]]; then
        emit_service_diagnostics "$project" "$service" "$container_id"
        printf 'READINESS_GATE=FAIL service=%s classification=EXITED\n' "$service" >&2
        return 1
      fi
      if [[ "$health_state" == unhealthy ]]; then
        emit_service_diagnostics "$project" "$service" "$container_id"
        printf 'READINESS_GATE=FAIL service=%s classification=UNHEALTHY\n' "$service" >&2
        return 1
      fi
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  emit_service_diagnostics "$project" "$service" "$container_id"
  printf 'READINESS_GATE=FAIL service=%s classification=STARTING timeout_seconds=%s\n' "$service" "$timeout_seconds" >&2
  return 1
}

rollback() {
  rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 ]]; then
    printf '%s\n' '=== DEPLOY ROLLBACK ===' >&2
    ROLLBACK_IMAGE_STATE=NO
    ROLLBACK_PERSISTENT_STATE=NO
    ROLLBACK_CONFIG_STATE=NO
    ROLLBACK_GITHUB_STATE=NO
    ROLLBACK_NETWORK_STATE=NO
    ROLLBACK_HEALTH_STATE=NO
    if [[ "$env_updated" == 1 ]]; then
      if cp "$env_backup" "$RUNTIME_ENV" && [[ "$(sha256sum "$RUNTIME_ENV" | cut -d' ' -f1)" == "$env_backup_sha256" ]]; then
        ROLLBACK_CONFIG_STATE=YES
      fi
    else
      ROLLBACK_CONFIG_STATE=YES
    fi
    if [[ "$runtime_mutated" == 1 ]]; then
      candidate_services=(gateway executor docker-authority)
      if [[ "$github_expected" == 1 ]]; then candidate_services+=(github-broker github-egress-proxy); fi
      candidate_quiesced=0
      if "${QG[@]}" stop "${candidate_services[@]}" >/dev/null 2>&1; then
        candidate_quiesced=1
        for candidate_service in "${candidate_services[@]}"; do
          mapfile -t stopped_ids < <(service_ids quarangate "$candidate_service")
          for stopped_id in "${stopped_ids[@]}"; do
            stopped_state="$(docker inspect "$stopped_id" --format '{{.State.Status}}' 2>/dev/null || true)"
            if [[ "$stopped_state" == running || "$stopped_state" == restarting || "$stopped_state" == paused ]]; then
              candidate_quiesced=0
            fi
          done
        done
      fi
      if [[ "$candidate_quiesced" == 1 ]]; then
        if [[ "$github_expected" == 1 && "$OLD_GITHUB_PRESENT" == 0 ]]; then
          "${QG[@]}" rm -sf github-broker github-egress-proxy >/dev/null 2>&1 || candidate_quiesced=0
        fi
        if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 0 ]]; then
          "${QG[@]}" rm -sf docker-authority >/dev/null 2>&1 || candidate_quiesced=0
        fi
      fi

      if [[ "$persistent_state_may_have_mutated" == 1 && "$candidate_quiesced" == 1 ]]; then
        if restore_result="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
          --security-opt no-new-privileges:true --user 1000:1000 \
          --mount "type=bind,src=$snapshot_dir,dst=/snapshot,readonly" \
          --mount type=volume,src=mcp-bridge-jobs,dst=/jobs \
          "$new_executor_id" node /app/dist/operations/sh06JobDbRecovery.js \
          restore /snapshot/agents.db /snapshot/manifest.json /jobs/agents.db 2>/dev/null)" && \
          printf '%s' "$restore_result" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="PERSISTENT_STATE_RESTORED" and d.get("integrityCheck")=="ok"' ; then
          ROLLBACK_PERSISTENT_STATE=YES
        else
          printf '%s\n' 'PERSISTENT_RESTORE_REASON=restore_or_verification_failed' >&2
        fi
      elif [[ "$persistent_state_may_have_mutated" == 0 && "$candidate_quiesced" == 1 ]]; then
        ROLLBACK_PERSISTENT_STATE=YES
      else
        printf '%s\n' 'PERSISTENT_RESTORE_REASON=candidate_services_not_proven_stopped' >&2
      fi

      # A failed persistent restore is a hard stop: never start the rollback
      # executor against a database that may have advanced beyond its support.
      if [[ "$ROLLBACK_PERSISTENT_STATE" == YES ]]; then
        rollback_services=(gateway executor)
        if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 ]]; then rollback_services=(docker-authority "${rollback_services[@]}"); fi
        if [[ "$OLD_GITHUB_PRESENT" == 1 ]]; then rollback_services+=(github-egress-proxy github-broker); fi
        if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 ]]; then
          GATEWAY_IMAGE="$OLD_GATEWAY_IMAGE" DOCKER_AUTHORITY_IMAGE="$OLD_DOCKER_AUTHORITY_IMAGE" EXECUTOR_IMAGE="$OLD_EXECUTOR_IMAGE" \
            "${BASE_QG[@]}" up -d --no-deps --force-recreate --no-build --pull never "${rollback_services[@]}" >/dev/null 2>&1 || true
        else
          GATEWAY_IMAGE="$OLD_GATEWAY_IMAGE" EXECUTOR_IMAGE="$OLD_EXECUTOR_IMAGE" \
            "${BASE_QG[@]}" up -d --no-deps --force-recreate --no-build --pull never "${rollback_services[@]}" >/dev/null 2>&1 || true
        fi

        mapfile -t rollback_gateway_ids < <(service_ids quarangate gateway)
        mapfile -t rollback_executor_ids < <(service_ids quarangate executor)
        mapfile -t rollback_authority_ids < <(service_ids quarangate docker-authority)
        if [[ ${#rollback_gateway_ids[@]} -eq 1 && ${#rollback_executor_ids[@]} -eq 1 ]]; then
          rollback_gateway_image="$(docker inspect "${rollback_gateway_ids[0]}" --format '{{.Config.Image}}' 2>/dev/null || true)"
          rollback_gateway_image_id="$(docker inspect "${rollback_gateway_ids[0]}" --format '{{.Image}}' 2>/dev/null || true)"
          rollback_executor_image="$(docker inspect "${rollback_executor_ids[0]}" --format '{{.Config.Image}}' 2>/dev/null || true)"
          rollback_executor_image_id="$(docker inspect "${rollback_executor_ids[0]}" --format '{{.Image}}' 2>/dev/null || true)"
          authority_image_restored=0
          if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 && ${#rollback_authority_ids[@]} -eq 1 ]]; then
            rollback_authority_image="$(docker inspect "${rollback_authority_ids[0]}" --format '{{.Config.Image}}' 2>/dev/null || true)"
            rollback_authority_image_id="$(docker inspect "${rollback_authority_ids[0]}" --format '{{.Image}}' 2>/dev/null || true)"
            [[ "$rollback_authority_image" == "$OLD_DOCKER_AUTHORITY_IMAGE" && "$rollback_authority_image_id" == "$OLD_DOCKER_AUTHORITY_IMAGE_ID" ]] && authority_image_restored=1
          elif [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 0 && ${#rollback_authority_ids[@]} -eq 0 ]]; then
            authority_image_restored=1
          fi
          if [[ "$rollback_gateway_image" == "$OLD_GATEWAY_IMAGE" && "$rollback_gateway_image_id" == "$OLD_GATEWAY_IMAGE_ID" && \
            "$rollback_executor_image" == "$OLD_EXECUTOR_IMAGE" && "$rollback_executor_image_id" == "$OLD_EXECUTOR_IMAGE_ID" && \
            "$authority_image_restored" == 1 ]]; then
            ROLLBACK_IMAGE_STATE=YES
          fi
        fi

        authority_health_restored=1
        if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 ]] && ! wait_service_ready quarangate docker-authority 120; then authority_health_restored=0; fi
        if [[ "$authority_health_restored" == 1 ]] && wait_service_ready quarangate executor 120 && wait_service_ready quarangate gateway 120; then
          ROLLBACK_HEALTH_STATE=YES
        fi
      fi

      mapfile -t rollback_github_ids < <(service_ids quarangate github-broker)
      mapfile -t rollback_github_proxy_ids < <(service_ids quarangate github-egress-proxy)
      if [[ "$OLD_GITHUB_PRESENT" == 1 && ${#rollback_github_ids[@]} -eq 1 && ${#rollback_github_proxy_ids[@]} -eq 1 ]]; then
        rollback_github_image="$(docker inspect "${rollback_github_ids[0]}" --format '{{.Config.Image}}' 2>/dev/null || true)"
        rollback_github_image_id="$(docker inspect "${rollback_github_ids[0]}" --format '{{.Image}}' 2>/dev/null || true)"
        rollback_github_networks="$(docker inspect "${rollback_github_ids[0]}" --format '{{range $name, $network := .NetworkSettings.Networks}}{{$name}}={{$network.NetworkID}};{{end}}' 2>/dev/null || true)"
        rollback_github_proxy_image="$(docker inspect "${rollback_github_proxy_ids[0]}" --format '{{.Config.Image}}' 2>/dev/null || true)"
        rollback_github_proxy_image_id="$(docker inspect "${rollback_github_proxy_ids[0]}" --format '{{.Image}}' 2>/dev/null || true)"
        rollback_github_proxy_networks="$(docker inspect "${rollback_github_proxy_ids[0]}" --format '{{range $name, $network := .NetworkSettings.Networks}}{{$name}}={{$network.NetworkID}};{{end}}' 2>/dev/null || true)"
        if [[ "$rollback_github_image" == "$OLD_GITHUB_IMAGE" && "$rollback_github_image_id" == "$OLD_GITHUB_IMAGE_ID" && \
          "$rollback_github_proxy_image" == "$OLD_GITHUB_PROXY_IMAGE" && "$rollback_github_proxy_image_id" == "$OLD_GITHUB_PROXY_IMAGE_ID" && \
          "$rollback_github_networks" == "$OLD_GITHUB_NETWORKS" && "$rollback_github_proxy_networks" == "$OLD_GITHUB_PROXY_NETWORKS" ]] && \
          wait_service_ready quarangate github-egress-proxy 120 && wait_service_ready quarangate github-broker 120; then
          ROLLBACK_GITHUB_STATE=YES
        fi
      elif [[ "$OLD_GITHUB_PRESENT" == 0 && ${#rollback_github_ids[@]} -eq 0 && ${#rollback_github_proxy_ids[@]} -eq 0 ]]; then
        ROLLBACK_GITHUB_STATE=YES
      fi

      if [[ "$OLD_GITHUB_CONTROL_NETWORK_PRESENT" == 0 ]] && docker network inspect quarangate-github-control >/dev/null 2>&1; then
        docker network rm quarangate-github-control >/dev/null 2>&1 || true
      fi
      if [[ "$OLD_GITHUB_EGRESS_NETWORK_PRESENT" == 0 ]] && docker network inspect quarangate-github-egress >/dev/null 2>&1; then
        docker network rm quarangate-github-egress >/dev/null 2>&1 || true
      fi
      rollback_github_control_network_id="$(docker network inspect quarangate-github-control --format '{{.Id}}' 2>/dev/null || true)"
      rollback_github_egress_network_id="$(docker network inspect quarangate-github-egress --format '{{.Id}}' 2>/dev/null || true)"
      control_network_restored=0
      egress_network_restored=0
      if [[ "$OLD_GITHUB_CONTROL_NETWORK_PRESENT" == 1 && "$rollback_github_control_network_id" == "$OLD_GITHUB_CONTROL_NETWORK_ID" ]] || \
        [[ "$OLD_GITHUB_CONTROL_NETWORK_PRESENT" == 0 && -z "$rollback_github_control_network_id" ]]; then control_network_restored=1; fi
      if [[ "$OLD_GITHUB_EGRESS_NETWORK_PRESENT" == 1 && "$rollback_github_egress_network_id" == "$OLD_GITHUB_EGRESS_NETWORK_ID" ]] || \
        [[ "$OLD_GITHUB_EGRESS_NETWORK_PRESENT" == 0 && -z "$rollback_github_egress_network_id" ]]; then egress_network_restored=1; fi
      if [[ "$control_network_restored" == 1 && "$egress_network_restored" == 1 ]]; then
        ROLLBACK_NETWORK_STATE=YES
      fi
    else
      ROLLBACK_IMAGE_STATE=YES
      ROLLBACK_PERSISTENT_STATE=YES
      ROLLBACK_GITHUB_STATE=YES
      ROLLBACK_NETWORK_STATE=YES
      ROLLBACK_HEALTH_STATE=YES
    fi

    printf 'ROLLBACK_IMAGE_STATE=%s\nROLLBACK_PERSISTENT_STATE=%s\nROLLBACK_CONFIG_STATE=%s\nROLLBACK_GITHUB_STATE=%s\nROLLBACK_NETWORK_STATE=%s\nROLLBACK_HEALTH_STATE=%s\n' \
      "$ROLLBACK_IMAGE_STATE" "$ROLLBACK_PERSISTENT_STATE" "$ROLLBACK_CONFIG_STATE" "$ROLLBACK_GITHUB_STATE" "$ROLLBACK_NETWORK_STATE" "$ROLLBACK_HEALTH_STATE" >&2
    if [[ "$ROLLBACK_IMAGE_STATE" == YES && "$ROLLBACK_PERSISTENT_STATE" == YES && "$ROLLBACK_CONFIG_STATE" == YES && \
      "$ROLLBACK_GITHUB_STATE" == YES && "$ROLLBACK_NETWORK_STATE" == YES && "$ROLLBACK_HEALTH_STATE" == YES ]]; then
      printf '%s\n' 'RUNTIME_IMAGE_STATE_RESTORED=YES' >&2
      printf '%s\n' 'PERSISTENT_STATE_RESTORED=YES' >&2
      printf '%s\n' 'REMOTE_OWNER_ROLLBACK=PASS' >&2
    else
      printf '%s\n' 'REMOTE_OWNER_ROLLBACK=FAIL' >&2
    fi
    printf 'REMOTE_OWNER_DEPLOY=FAIL rollback_attempted=%s\n' "$mutated" >&2
  fi
  rm -f "$env_backup"
  exit "$rc"
}

printf '%s\n' '=== CONTROLLED DEPLOY ==='
# Recheck the attested aliases, then select the immutable IDs for Compose so
# no tag retarget can alter the bytes that are actually started.
assert_candidate_image_bindings
export GATEWAY_IMAGE="$new_gateway_id" DOCKER_AUTHORITY_IMAGE="$new_authority_id" EXECUTOR_IMAGE="$new_executor_id"
mutated=1
runtime_mutated=1

printf '%s\n' '=== READINESS PHASE: DOCKER AUTHORITY ==='
GIT_REVISION="$REV" "${QG[@]}" up -d --no-deps --no-build --pull never docker-authority
wait_service_ready quarangate docker-authority 120 || fail 'candidate readiness failed at docker-authority gate'

printf '%s\n' '=== READINESS PHASE: EXECUTOR ==='
# The executor opens and may migrate the durable DB during startup. Arm the
# persistent-state rollback requirement before Compose can create the process.
persistent_state_may_have_mutated=1
GIT_REVISION="$REV" "${QG[@]}" up -d --no-deps --no-build --pull never executor
wait_service_ready quarangate executor 120 || fail 'candidate readiness failed at executor gate'

printf '%s\n' '=== READINESS PHASE: GATEWAY ==='
GIT_REVISION="$REV" "${QG[@]}" up -d --no-deps --no-build --pull never gateway
wait_service_ready quarangate gateway 120 || fail 'candidate readiness failed at gateway gate'

if [[ "$github_expected" == 1 ]]; then
  printf '%s\n' '=== READINESS PHASE: GITHUB EGRESS PROXY ==='
  GIT_REVISION="$REV" "${QG[@]}" up -d --no-deps --no-build --pull never github-egress-proxy
  wait_service_ready quarangate github-egress-proxy 120 || fail 'candidate readiness failed at GitHub egress proxy gate'
  printf '%s\n' '=== READINESS PHASE: GITHUB BROKER ==='
  GIT_REVISION="$REV" "${QG[@]}" up -d --no-deps --no-build --pull never github-broker
  wait_service_ready quarangate github-broker 120 || fail 'candidate readiness failed at GitHub broker gate'
fi

printf '%s\n' '=== READINESS PHASE: PROJECTS WORK ==='
"${PW[@]}" up -d --no-deps --no-build --pull never work
wait_service_ready projects-work work 120 || fail 'candidate readiness failed at projects-work gate'

mapfile -t gateway_ids < <(service_ids quarangate gateway)
mapfile -t authority_ids < <(service_ids quarangate docker-authority)
mapfile -t executor_ids < <(service_ids quarangate executor)
[[ ${#gateway_ids[@]} -eq 1 && ${#authority_ids[@]} -eq 1 && ${#executor_ids[@]} -eq 1 ]] || fail 'candidate primary-service cardinality changed after readiness'
gateway_id="${gateway_ids[0]}"
authority_id="${authority_ids[0]}"
executor_id="${executor_ids[0]}"
if [[ "$github_expected" == 1 ]]; then
  mapfile -t github_ids < <(service_ids quarangate github-broker)
  mapfile -t github_proxy_ids < <(service_ids quarangate github-egress-proxy)
  [[ ${#github_ids[@]} -eq 1 && ${#github_proxy_ids[@]} -eq 1 ]] || fail 'candidate GitHub-service cardinality changed after readiness'
  github_id="${github_ids[0]}"
  github_proxy_id="${github_proxy_ids[0]}"
fi

# Verify exact deployed images before persisting the new runtime selection.
gateway_image_live="$(docker inspect "$gateway_id" --format '{{.Config.Image}}')"
gateway_image_id_live="$(docker inspect "$gateway_id" --format '{{.Image}}')"
authority_image_live="$(docker inspect "$authority_id" --format '{{.Config.Image}}')"
authority_image_id_live="$(docker inspect "$authority_id" --format '{{.Image}}')"
executor_image_live="$(docker inspect "$executor_id" --format '{{.Config.Image}}')"
executor_image_id_live="$(docker inspect "$executor_id" --format '{{.Image}}')"
[[ "$gateway_image_live" == "$new_gateway_id" && "$gateway_image_id_live" == "$new_gateway_id" ]] || fail "gateway live image identity mismatch"
[[ "$authority_image_live" == "$new_authority_id" && "$authority_image_id_live" == "$new_authority_id" ]] || fail "Docker-authority live image identity mismatch"
[[ "$executor_image_live" == "$new_executor_id" && "$executor_image_id_live" == "$new_executor_id" ]] || fail "executor live image identity mismatch"
if [[ "$github_expected" == 1 ]]; then
  github_image_live="$(docker inspect "$github_id" --format '{{.Config.Image}}')"
  github_image_id_live="$(docker inspect "$github_id" --format '{{.Image}}')"
  github_proxy_image_live="$(docker inspect "$github_proxy_id" --format '{{.Config.Image}}')"
  github_proxy_image_id_live="$(docker inspect "$github_proxy_id" --format '{{.Image}}')"
  [[ "$github_image_live" == "$new_gateway_id" && "$github_image_id_live" == "$new_gateway_id" ]] || fail "GitHub broker live image identity mismatch"
  [[ "$github_proxy_image_live" == "$new_gateway_id" && "$github_proxy_image_id_live" == "$new_gateway_id" ]] || fail "GitHub egress proxy live image identity mismatch"
fi

GATEWAY_IMAGE="$new_gateway_id" DOCKER_AUTHORITY_IMAGE="$new_authority_id" EXECUTOR_IMAGE="$new_executor_id" QUARANGATE_RUNTIME_ROOT="$MAIN_ROOT" QUARANGATE_RUNTIME_ENV="$RUNTIME_ENV" "$REPO_ROOT/scripts/remote-owner-infra-acceptance.sh"

printf '%s\n' '=== PERSIST IMMUTABLE RUNTIME IMAGE IDENTITIES ==='
# Arm rollback before persistence starts so any failure during or immediately
# after atomic replacement restores the exact predeploy runtime env bytes.
env_updated=1
CANDIDATE_OLLAMA_IMAGE="$CANDIDATE_OLLAMA_IMAGE" DOCKER_AUTHORITY_TOKEN="$DOCKER_AUTHORITY_TOKEN_VALUE" python3 - "$RUNTIME_ENV" \
  "$NEW_GATEWAY_IMAGE" "$new_gateway_id" \
  "$NEW_DOCKER_AUTHORITY_IMAGE" "$new_authority_id" \
  "$NEW_EXECUTOR_IMAGE" "$new_executor_id" "$BUNDLE_PATH" <<'PY'
import os, re, stat, sys, tempfile
from pathlib import Path

path = Path(sys.argv[1])
updates = {
    'GATEWAY_IMAGE': sys.argv[2],
    'GATEWAY_IMAGE_ID': sys.argv[3],
    'DOCKER_AUTHORITY_IMAGE': sys.argv[4],
    'DOCKER_AUTHORITY_IMAGE_ID': sys.argv[5],
    'EXECUTOR_IMAGE': sys.argv[6],
    'EXECUTOR_IMAGE_ID': sys.argv[7],
    'QUARANGATE_NPM_BUNDLE_PATH': sys.argv[8],
    'DOCKER_AUTHORITY_TOKEN': os.environ['DOCKER_AUTHORITY_TOKEN'],
}
if os.environ.get('CANDIDATE_OLLAMA_IMAGE'):
    updates['OLLAMA_IMAGE'] = os.environ['CANDIDATE_OLLAMA_IMAGE']
lines = path.read_text().splitlines(keepends=True)
for key, value in updates.items():
    pat = re.compile(rf'^{re.escape(key)}=')
    matches = [i for i, line in enumerate(lines) if pat.match(line)]
    if len(matches) > 1:
        raise SystemExit(f'duplicate runtime key: {key}')
    if matches:
        i = matches[0]
        end = '\n' if lines[i].endswith('\n') else ''
        lines[i] = f'{key}={value}{end}'
    else:
        if lines and not lines[-1].endswith('\n'):
            lines[-1] += '\n'
        lines.append(f'{key}={value}\n')
mode = stat.S_IMODE(path.stat().st_mode)
fd, tmp_name = tempfile.mkstemp(prefix='.quarangate-env-', dir=str(path.parent))
try:
    with os.fdopen(fd, 'w') as f:
        f.writelines(lines)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp_name, mode)
    os.replace(tmp_name, path)
finally:
    if os.path.exists(tmp_name):
        os.unlink(tmp_name)
PY

# Verify the persisted file directly. Ambient exports must not be able to make a
# stale or incomplete runtime identity look accepted.
CANDIDATE_OLLAMA_IMAGE="$CANDIDATE_OLLAMA_IMAGE" DOCKER_AUTHORITY_TOKEN="$DOCKER_AUTHORITY_TOKEN_VALUE" python3 - "$RUNTIME_ENV" \
  "$NEW_GATEWAY_IMAGE" "$new_gateway_id" \
  "$NEW_DOCKER_AUTHORITY_IMAGE" "$new_authority_id" \
  "$NEW_EXECUTOR_IMAGE" "$new_executor_id" "$BUNDLE_PATH" <<'PYVERIFY'
import os, sys
from pathlib import Path

path = Path(sys.argv[1])
expected = {
    'GATEWAY_IMAGE': sys.argv[2], 'GATEWAY_IMAGE_ID': sys.argv[3],
    'DOCKER_AUTHORITY_IMAGE': sys.argv[4], 'DOCKER_AUTHORITY_IMAGE_ID': sys.argv[5],
    'EXECUTOR_IMAGE': sys.argv[6], 'EXECUTOR_IMAGE_ID': sys.argv[7],
    'QUARANGATE_NPM_BUNDLE_PATH': sys.argv[8],
    'DOCKER_AUTHORITY_TOKEN': os.environ['DOCKER_AUTHORITY_TOKEN'],
}
if os.environ.get('CANDIDATE_OLLAMA_IMAGE'):
    expected['OLLAMA_IMAGE'] = os.environ['CANDIDATE_OLLAMA_IMAGE']
found = {}
for raw in path.read_text().splitlines():
    if '=' not in raw or raw.lstrip().startswith('#'):
        continue
    key, value = raw.split('=', 1)
    if key in expected:
        if key in found: raise SystemExit(f'duplicate persisted {key}')
        found[key] = value
for key, value in expected.items():
    if found.get(key) != value:
        raise SystemExit(f'persisted {key} mismatch')
PYVERIFY

# Independently verify the Compose graph with the exact persisted service refs.
mapfile -t persisted_images < <(
  GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE" DOCKER_AUTHORITY_IMAGE="$NEW_DOCKER_AUTHORITY_IMAGE" EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE" \
    "${QG[@]}" config --images | sort -u
)
printf '%s\n' "${persisted_images[@]}" | grep -Fxq "$NEW_GATEWAY_IMAGE" || fail 'persisted gateway image selection missing'
printf '%s\n' "${persisted_images[@]}" | grep -Fxq "$NEW_DOCKER_AUTHORITY_IMAGE" || fail 'persisted Docker-authority image selection missing'
printf '%s\n' "${persisted_images[@]}" | grep -Fxq "$NEW_EXECUTOR_IMAGE" || fail 'persisted executor image selection missing'

# Re-read the persisted tag->ID binding from Docker after the atomic env update.
for pair in \
  "$NEW_GATEWAY_IMAGE|$new_gateway_id" \
  "$NEW_DOCKER_AUTHORITY_IMAGE|$new_authority_id" \
  "$NEW_EXECUTOR_IMAGE|$new_executor_id"; do
  image="${pair%%|*}"; expected_id="${pair#*|}"
  actual_id="$(docker image inspect "$image" --format '{{.Id}}')"
  [[ "$actual_id" == "$expected_id" ]] || fail "persisted image tag was retargeted before deployment commit: $image"
done
unset pair image expected_id actual_id

trap - EXIT
rm -f "$env_backup"
printf 'DEPLOYED_REV=%s\n' "$REV"
printf '%s\n' 'REMOTE_OWNER_DEPLOY=PASS'
