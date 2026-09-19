#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() { printf 'REMOTE_OWNER_DEPLOY=FAIL reason=%s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'docker CLI missing'
command -v git >/dev/null 2>&1 || fail 'git missing'
command -v python3 >/dev/null 2>&1 || fail 'python3 missing'
docker info >/dev/null 2>&1 || fail 'Docker Engine unavailable'

REV="$(git rev-parse HEAD)"
BRANCH="$(git branch --show-current)"
[[ -n "$REV" && -n "$BRANCH" ]] || fail 'candidate Git identity unavailable'
[[ -z "$(git status --porcelain)" ]] || fail 'candidate worktree is not clean'

# Candidate linked worktree normally sits at <main>/.quarangate-worktrees/<name>.
# After promotion this same script may run from main, where .env is local.
MAIN_ROOT="$REPO_ROOT"
if [[ ! -f "$MAIN_ROOT/.env" && -f "$REPO_ROOT/../../.env" ]]; then
  MAIN_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
fi
RUNTIME_ENV="${QUARANGATE_RUNTIME_ENV:-$MAIN_ROOT/.env}"
[[ -f "$RUNTIME_ENV" ]] || fail 'runtime .env not found'
[[ -f "$MAIN_ROOT/config/clients.yaml" ]] || fail 'runtime clients.yaml not found'
[[ -f "$MAIN_ROOT/config/bridge.yaml" ]] || fail 'runtime bridge.yaml not found'
[[ -f "$MAIN_ROOT/compose.yaml" ]] || fail 'runtime compose.yaml not found'

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

github_expected=0
if [[ -f "$MAIN_ROOT/config/github.yaml" ]]; then github_expected=1; fi
if docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=github-broker --format '{{.ID}}' | grep -q .; then github_expected=1; fi
if docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=github-egress-proxy --format '{{.ID}}' | grep -q .; then github_expected=1; fi
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
  GENERATED_DOCKER_AUTHORITY_TOKEN=0
else
  [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 0 ]] || fail 'existing Docker-authority requires a persisted DOCKER_AUTHORITY_TOKEN for exact rollback'
  DOCKER_AUTHORITY_TOKEN_VALUE="$(python3 - <<'PYTOKEN'
import secrets
print(secrets.token_urlsafe(32))
PYTOKEN
  )"
  [[ -n "$DOCKER_AUTHORITY_TOKEN_VALUE" ]] || fail 'could not generate Docker-authority token'
  GENERATED_DOCKER_AUTHORITY_TOKEN=1
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
DEPLOY_SERVICES=(docker-authority gateway executor)
if [[ "$github_expected" == 1 ]]; then DEPLOY_SERVICES+=(github-egress-proxy github-broker); fi
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
OLD_GITHUB_PRESENT=0
OLD_GITHUB_IMAGE=''
OLD_GITHUB_IMAGE_ID=''
OLD_GITHUB_PROXY_IMAGE=''
OLD_GITHUB_PROXY_IMAGE_ID=''
if [[ "$github_expected" == 1 ]]; then
  old_github_id="$("${QG[@]}" ps -q github-broker 2>/dev/null || true)"
  old_github_proxy_id="$("${QG[@]}" ps -q github-egress-proxy 2>/dev/null || true)"
  if [[ -n "$old_github_id" || -n "$old_github_proxy_id" ]]; then
    [[ -n "$old_github_id" && -n "$old_github_proxy_id" ]] || fail 'incomplete predeploy GitHub control baseline'
    OLD_GITHUB_PRESENT=1
    OLD_GITHUB_IMAGE="$(docker inspect "$old_github_id" --format '{{.Config.Image}}')"
    OLD_GITHUB_IMAGE_ID="$(docker inspect "$old_github_id" --format '{{.Image}}')"
    OLD_GITHUB_PROXY_IMAGE="$(docker inspect "$old_github_proxy_id" --format '{{.Config.Image}}')"
    OLD_GITHUB_PROXY_IMAGE_ID="$(docker inspect "$old_github_proxy_id" --format '{{.Image}}')"
    [[ "$OLD_GITHUB_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ && "$OLD_GITHUB_PROXY_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'could not capture immutable GitHub rollback image IDs'
  fi
fi
printf 'OLD_GATEWAY_IMAGE=%s\nOLD_DOCKER_AUTHORITY_PRESENT=%s\nOLD_DOCKER_AUTHORITY_IMAGE=%s\nOLD_EXECUTOR_IMAGE=%s\nOLD_GITHUB_PRESENT=%s\n' "$OLD_GATEWAY_IMAGE" "$OLD_DOCKER_AUTHORITY_PRESENT" "$OLD_DOCKER_AUTHORITY_IMAGE" "$OLD_EXECUTOR_IMAGE" "$OLD_GITHUB_PRESENT"

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
  receipt_core_id="$(python3 - "$RELEASE_RECEIPT" "$REV" "$(git rev-parse HEAD^{tree})"     "$NEW_GATEWAY_IMAGE" "$NEW_DOCKER_AUTHORITY_IMAGE" "$NEW_EXECUTOR_IMAGE" <<'PYRECEIPT'
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
printf 'NEW_SHARED_IMAGE_ID=%s\n' "$new_gateway_id"

# Preserve the ignored runtime env byte-for-byte for rollback without printing
# its contents. The temporary copy is mode 0600 and deleted on every exit path.
env_backup="$(mktemp)"
chmod 0600 "$env_backup"
cp "$RUNTIME_ENV" "$env_backup"
mutated=0
env_updated=0

rollback() {
  rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 ]]; then
    printf '%s\n' '=== DEPLOY ROLLBACK ===' >&2
    rollback_ok=1
    if [[ "$env_updated" == 1 ]]; then
      cp "$env_backup" "$RUNTIME_ENV" || rollback_ok=0
    fi
    if [[ "$mutated" == 1 ]]; then
      # Remove forward-only services that were absent in the predeploy topology
      # before restoring the legacy Compose graph.
      if [[ "$github_expected" == 1 && "$OLD_GITHUB_PRESENT" == 0 ]]; then
        "${QG[@]}" rm -sf github-broker github-egress-proxy >/dev/null 2>&1 || rollback_ok=0
      fi
      if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 0 ]]; then
        "${QG[@]}" rm -sf docker-authority >/dev/null 2>&1 || rollback_ok=0
      fi

      rollback_services=(gateway executor)
      if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 ]]; then rollback_services=(docker-authority "${rollback_services[@]}"); fi
      if [[ "$OLD_GITHUB_PRESENT" == 1 ]]; then rollback_services+=(github-egress-proxy github-broker); fi

      if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 ]]; then
        if ! GATEWAY_IMAGE="$OLD_GATEWAY_IMAGE" DOCKER_AUTHORITY_IMAGE="$OLD_DOCKER_AUTHORITY_IMAGE" EXECUTOR_IMAGE="$OLD_EXECUTOR_IMAGE" \
          "${BASE_QG[@]}" up -d --no-deps --force-recreate --no-build --pull never "${rollback_services[@]}" >/dev/null 2>&1; then
          rollback_ok=0
        fi
      else
        if ! GATEWAY_IMAGE="$OLD_GATEWAY_IMAGE" EXECUTOR_IMAGE="$OLD_EXECUTOR_IMAGE" \
          "${BASE_QG[@]}" up -d --no-deps --force-recreate --no-build --pull never "${rollback_services[@]}" >/dev/null 2>&1; then
          rollback_ok=0
        fi
      fi

      if [[ "$OLD_GITHUB_PRESENT" == 0 ]]; then
        for net in quarangate-github-control quarangate-github-egress; do
          if docker network inspect "$net" >/dev/null 2>&1; then
            docker network rm "$net" >/dev/null 2>&1 || rollback_ok=0
          fi
        done
      fi

      rollback_gateway_id="$("${BASE_QG[@]}" ps -q gateway 2>/dev/null || true)"
      rollback_executor_id="$("${BASE_QG[@]}" ps -q executor 2>/dev/null || true)"
      if [[ -z "$rollback_gateway_id" || -z "$rollback_executor_id" ]]; then
        rollback_ok=0
      else
        rollback_healthy=0
        for _ in $(seq 1 60); do
          rollback_state="$(docker inspect "$rollback_gateway_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
          if [[ "$rollback_state" == healthy ]]; then rollback_healthy=1; break; fi
          sleep 2
        done
        [[ "$rollback_healthy" == 1 ]] || rollback_ok=0
        rollback_gateway_image="$(docker inspect "$rollback_gateway_id" --format '{{.Config.Image}}' 2>/dev/null || true)"
        rollback_executor_image="$(docker inspect "$rollback_executor_id" --format '{{.Config.Image}}' 2>/dev/null || true)"
        rollback_gateway_image_id="$(docker inspect "$rollback_gateway_id" --format '{{.Image}}' 2>/dev/null || true)"
        rollback_executor_image_id="$(docker inspect "$rollback_executor_id" --format '{{.Image}}' 2>/dev/null || true)"
        [[ "$rollback_gateway_image" == "$OLD_GATEWAY_IMAGE" && "$rollback_gateway_image_id" == "$OLD_GATEWAY_IMAGE_ID" ]] || rollback_ok=0
        [[ "$rollback_executor_image" == "$OLD_EXECUTOR_IMAGE" && "$rollback_executor_image_id" == "$OLD_EXECUTOR_IMAGE_ID" ]] || rollback_ok=0
      fi

      rollback_authority_id="$(docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=docker-authority --format '{{.ID}}')"
      if [[ "$OLD_DOCKER_AUTHORITY_PRESENT" == 1 ]]; then
        if [[ -z "$rollback_authority_id" ]]; then
          rollback_ok=0
        else
          rollback_authority_image="$(docker inspect "$rollback_authority_id" --format '{{.Config.Image}}' 2>/dev/null || true)"
          rollback_authority_image_id="$(docker inspect "$rollback_authority_id" --format '{{.Image}}' 2>/dev/null || true)"
          [[ "$rollback_authority_image" == "$OLD_DOCKER_AUTHORITY_IMAGE" && "$rollback_authority_image_id" == "$OLD_DOCKER_AUTHORITY_IMAGE_ID" ]] || rollback_ok=0
        fi
      elif [[ -n "$rollback_authority_id" ]]; then
        rollback_ok=0
      fi

      if [[ "$OLD_GITHUB_PRESENT" == 1 ]]; then
        rollback_github_id="$("${BASE_QG[@]}" ps -q github-broker 2>/dev/null || true)"
        rollback_github_proxy_id="$("${BASE_QG[@]}" ps -q github-egress-proxy 2>/dev/null || true)"
        if [[ -z "$rollback_github_id" || -z "$rollback_github_proxy_id" ]]; then
          rollback_ok=0
        else
          rollback_github_image="$(docker inspect "$rollback_github_id" --format '{{.Config.Image}}' 2>/dev/null || true)"
          rollback_github_health="$(docker inspect "$rollback_github_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
          rollback_github_image_id="$(docker inspect "$rollback_github_id" --format '{{.Image}}' 2>/dev/null || true)"
          rollback_github_proxy_image="$(docker inspect "$rollback_github_proxy_id" --format '{{.Config.Image}}' 2>/dev/null || true)"
          rollback_github_proxy_image_id="$(docker inspect "$rollback_github_proxy_id" --format '{{.Image}}' 2>/dev/null || true)"
          rollback_github_proxy_health="$(docker inspect "$rollback_github_proxy_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
          [[ "$rollback_github_image" == "$OLD_GITHUB_IMAGE" && "$rollback_github_image_id" == "$OLD_GITHUB_IMAGE_ID" ]] || rollback_ok=0
          [[ "$rollback_github_proxy_image" == "$OLD_GITHUB_PROXY_IMAGE" && "$rollback_github_proxy_image_id" == "$OLD_GITHUB_PROXY_IMAGE_ID" ]] || rollback_ok=0
          [[ "$rollback_github_health" == healthy ]] || rollback_ok=0
          [[ "$rollback_github_proxy_health" == healthy ]] || rollback_ok=0
        fi
      elif docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=github-broker --format '{{.ID}}' | grep -q . || \
           docker ps -a --filter label=com.docker.compose.project=quarangate --filter label=com.docker.compose.service=github-egress-proxy --format '{{.ID}}' | grep -q . || \
           docker network inspect quarangate-github-control >/dev/null 2>&1 || \
           docker network inspect quarangate-github-egress >/dev/null 2>&1; then
        rollback_ok=0
      fi
    fi

    if [[ "$rollback_ok" == 1 ]]; then
      printf '%s\n' 'REMOTE_OWNER_ROLLBACK=PASS' >&2
    else
      printf '%s\n' 'REMOTE_OWNER_ROLLBACK=FAIL' >&2
    fi
    printf 'REMOTE_OWNER_DEPLOY=FAIL rollback_attempted=%s\n' "$mutated" >&2
  fi
  rm -f "$env_backup"
  exit "$rc"
}
trap rollback EXIT

printf '%s\n' '=== CONTROLLED DEPLOY ==='
mutated=1
GIT_REVISION="$REV" GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE" DOCKER_AUTHORITY_IMAGE="$NEW_DOCKER_AUTHORITY_IMAGE" EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE" \
  "${QG[@]}" up -d --no-build --pull never "${DEPLOY_SERVICES[@]}"
"${PW[@]}" up -d --no-build --pull never

printf '%s\n' '=== WAIT FOR GATEWAY ==='
gateway_id="$("${QG[@]}" ps -q gateway)"
healthy=0
for _ in $(seq 1 60); do
  state="$(docker inspect "$gateway_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  if [[ "$state" == healthy ]]; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || fail 'candidate gateway did not become healthy after 120 seconds'

if [[ "$github_expected" == 1 ]]; then
  github_id="$("${QG[@]}" ps -q github-broker)"
  github_proxy_id="$("${QG[@]}" ps -q github-egress-proxy)"
  [[ -n "$github_id" ]] || fail 'candidate GitHub broker missing after deploy'
  [[ -n "$github_proxy_id" ]] || fail 'candidate GitHub egress proxy missing after deploy'
  github_healthy=0
  github_proxy_healthy=0
  for _ in $(seq 1 60); do
    github_state="$(docker inspect "$github_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    github_proxy_state="$(docker inspect "$github_proxy_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    [[ "$github_state" == healthy ]] && github_healthy=1
    [[ "$github_proxy_state" == healthy ]] && github_proxy_healthy=1
    if [[ "$github_healthy" == 1 && "$github_proxy_healthy" == 1 ]]; then break; fi
    sleep 2
  done
  [[ "$github_healthy" == 1 ]] || fail 'candidate GitHub broker did not become healthy after 120 seconds'
  [[ "$github_proxy_healthy" == 1 ]] || fail 'candidate GitHub egress proxy did not become healthy after 120 seconds'
fi

# Verify exact deployed images before persisting the new runtime selection.
gateway_image_live="$(docker inspect "$gateway_id" --format '{{.Config.Image}}')"
gateway_image_id_live="$(docker inspect "$gateway_id" --format '{{.Image}}')"
authority_id="$("${QG[@]}" ps -q docker-authority)"
executor_id="$("${QG[@]}" ps -q executor)"
authority_image_live="$(docker inspect "$authority_id" --format '{{.Config.Image}}')"
authority_image_id_live="$(docker inspect "$authority_id" --format '{{.Image}}')"
executor_image_live="$(docker inspect "$executor_id" --format '{{.Config.Image}}')"
executor_image_id_live="$(docker inspect "$executor_id" --format '{{.Image}}')"
[[ "$gateway_image_live" == "$NEW_GATEWAY_IMAGE" && "$gateway_image_id_live" == "$new_gateway_id" ]] || fail "gateway live image identity mismatch"
[[ "$authority_image_live" == "$NEW_DOCKER_AUTHORITY_IMAGE" && "$authority_image_id_live" == "$new_authority_id" ]] || fail "Docker-authority live image identity mismatch"
[[ "$executor_image_live" == "$NEW_EXECUTOR_IMAGE" && "$executor_image_id_live" == "$new_executor_id" ]] || fail "executor live image identity mismatch"
if [[ "$github_expected" == 1 ]]; then
  github_image_live="$(docker inspect "$github_id" --format '{{.Config.Image}}')"
  github_image_id_live="$(docker inspect "$github_id" --format '{{.Image}}')"
  github_proxy_image_live="$(docker inspect "$github_proxy_id" --format '{{.Config.Image}}')"
  github_proxy_image_id_live="$(docker inspect "$github_proxy_id" --format '{{.Image}}')"
  [[ "$github_image_live" == "$NEW_GATEWAY_IMAGE" && "$github_image_id_live" == "$new_gateway_id" ]] || fail "GitHub broker live image identity mismatch"
  [[ "$github_proxy_image_live" == "$NEW_GATEWAY_IMAGE" && "$github_proxy_image_id_live" == "$new_gateway_id" ]] || fail "GitHub egress proxy live image identity mismatch"
fi

GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE" DOCKER_AUTHORITY_IMAGE="$NEW_DOCKER_AUTHORITY_IMAGE" EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE" QUARANGATE_RUNTIME_ENV="$RUNTIME_ENV" "$REPO_ROOT/scripts/remote-owner-infra-acceptance.sh"

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
