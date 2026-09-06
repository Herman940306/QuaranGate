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

QG=(docker compose --env-file "$RUNTIME_ENV" -p quarangate "${QG_FILES[@]}")
# Build from the candidate worktree, but deploy from MAIN_ROOT so ignored live
# config/ files are mounted from the operator runtime rather than disappearing.
BUILD_QG=(docker compose --env-file "$RUNTIME_ENV" -p quarangate-candidate-build -f "$REPO_ROOT/compose.yaml")
PW=(docker compose --env-file "$RUNTIME_ENV" -p projects-work -f "$REPO_ROOT/projects-work-target/compose.yaml")

printf '%s\n' '=== PREDEPLOY BASELINE ==='
printf 'REV=%s\nBRANCH=%s\n' "$REV" "$BRANCH"
gateway_id="$("${QG[@]}" ps -q gateway)"
executor_id="$("${QG[@]}" ps -q executor)"
[[ -n "$gateway_id" ]] || fail 'current gateway container missing'
[[ -n "$executor_id" ]] || fail 'current executor container missing'
OLD_GATEWAY_IMAGE="$(docker inspect "$gateway_id" --format '{{.Config.Image}}')"
OLD_EXECUTOR_IMAGE="$(docker inspect "$executor_id" --format '{{.Config.Image}}')"
[[ -n "$OLD_GATEWAY_IMAGE" && -n "$OLD_EXECUTOR_IMAGE" ]] || fail 'could not capture rollback images'
printf 'OLD_GATEWAY_IMAGE=%s\nOLD_EXECUTOR_IMAGE=%s\n' "$OLD_GATEWAY_IMAGE" "$OLD_EXECUTOR_IMAGE"

# The build is local/offline by construction: compose.yaml has build.pull=false
# and build.network=none; the Dockerfile consumes only the pre-provisioned npm
# bundle. Refuse to proceed if the pinned base image is not already local.
docker image inspect node:24-alpine >/dev/null 2>&1 || fail 'local node:24-alpine base image missing'

NEW_GATEWAY_IMAGE="quarangate:gateway-$REV"
NEW_EXECUTOR_IMAGE="quarangate:executor-$REV"

printf '%s\n' '=== OFFLINE BUILD ==='
GIT_REVISION="$REV" GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE" EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE" \
  "${BUILD_QG[@]}" build --no-cache gateway
# Gateway/executor intentionally use the same built artifact; tag the verified
# gateway artifact independently for the executor service.
docker tag "$NEW_GATEWAY_IMAGE" "$NEW_EXECUTOR_IMAGE"

for image in "$NEW_GATEWAY_IMAGE" "$NEW_EXECUTOR_IMAGE"; do
  actual_rev="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  [[ "$actual_rev" == "$REV" ]] || fail "image provenance mismatch for $image: $actual_rev"
done
new_gateway_id="$(docker image inspect "$NEW_GATEWAY_IMAGE" --format '{{.Id}}')"
new_executor_id="$(docker image inspect "$NEW_EXECUTOR_IMAGE" --format '{{.Id}}')"
[[ "$new_gateway_id" == "$new_executor_id" ]] || fail 'gateway/executor shared-artifact identity mismatch'
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
    if [[ "$env_updated" == 1 ]]; then
      cp "$env_backup" "$RUNTIME_ENV" || true
    fi
    if [[ "$mutated" == 1 ]]; then
      GATEWAY_IMAGE="$OLD_GATEWAY_IMAGE" EXECUTOR_IMAGE="$OLD_EXECUTOR_IMAGE" \
        "${QG[@]}" up -d --no-build --pull never gateway executor >/dev/null 2>&1 || true
    fi
    printf 'REMOTE_OWNER_DEPLOY=FAIL rollback_attempted=%s\n' "$mutated" >&2
  fi
  rm -f "$env_backup"
  exit "$rc"
}
trap rollback EXIT

printf '%s\n' '=== CONTROLLED DEPLOY ==='
mutated=1
GIT_REVISION="$REV" GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE" EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE" \
  "${QG[@]}" up -d --no-build --pull never gateway executor
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

# Verify exact deployed images before persisting the new runtime selection.
gateway_image_live="$(docker inspect "$gateway_id" --format '{{.Config.Image}}')"
executor_id="$("${QG[@]}" ps -q executor)"
executor_image_live="$(docker inspect "$executor_id" --format '{{.Config.Image}}')"
[[ "$gateway_image_live" == "$NEW_GATEWAY_IMAGE" ]] || fail "gateway live image mismatch: $gateway_image_live"
[[ "$executor_image_live" == "$NEW_EXECUTOR_IMAGE" ]] || fail "executor live image mismatch: $executor_image_live"

QUARANGATE_RUNTIME_ENV="$RUNTIME_ENV" "$REPO_ROOT/scripts/remote-owner-infra-acceptance.sh"

printf '%s\n' '=== PERSIST IMMUTABLE RUNTIME TAGS ==='
python3 - "$RUNTIME_ENV" "$NEW_GATEWAY_IMAGE" "$NEW_EXECUTOR_IMAGE" <<'PY'
import os, re, stat, sys, tempfile
from pathlib import Path

path = Path(sys.argv[1])
updates = {
    'GATEWAY_IMAGE': sys.argv[2],
    'EXECUTOR_IMAGE': sys.argv[3],
}
text = path.read_text()
lines = text.splitlines(keepends=True)
for key, value in updates.items():
    pat = re.compile(rf'^{re.escape(key)}=')
    replaced = False
    for i, line in enumerate(lines):
        if pat.match(line):
            end = '\n' if line.endswith('\n') else ''
            lines[i] = f'{key}={value}{end}'
            replaced = True
            break
    if not replaced:
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
env_updated=1

# Re-resolve through the persisted env; only image names are inspected.
mapfile -t persisted_images < <("${QG[@]}" config --images | sort -u)
printf '%s\n' "${persisted_images[@]}" | grep -Fxq "$NEW_GATEWAY_IMAGE" || fail 'persisted gateway image selection missing'
printf '%s\n' "${persisted_images[@]}" | grep -Fxq "$NEW_EXECUTOR_IMAGE" || fail 'persisted executor image selection missing'

trap - EXIT
rm -f "$env_backup"
printf 'DEPLOYED_REV=%s\n' "$REV"
printf '%s\n' 'REMOTE_OWNER_DEPLOY=PASS'
