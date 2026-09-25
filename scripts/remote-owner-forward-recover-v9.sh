#!/usr/bin/env bash
# scripts/remote-owner-forward-recover-v9.sh
#
# SH-06 CURRENT v9 INCIDENT — BOUNDED FORWARD RECOVERY
#
# PURPOSE
# -------
# Explicit, separately governed recovery entry point for the degraded 9/9/7
# incident state.  Standard deployment (the standard deployment script) is
# correctly and permanently blocked for this matrix because the legacy rollback
# executor (a7a61c1, schema-7) cannot open the v9 database.  This script is the
# ONLY authorised path to return the stack to a healthy state.
#
# WHAT THIS SCRIPT DOES
# ---------------------
# 1.  Mechanically verifies the exact expected incident preconditions.
#     Aborts before any mutation if state materially differs.
# 2.  Takes a transactionally consistent v9 DB snapshot (read-only source mount).
# 3.  Calls the single authoritative TypeScript evaluator via its machine-readable
#     CLI.  Admission is DENIED unless BOTH primary and fallback support schema >= 9.
# 4.  Stages services in strict dependency order:
#       docker-authority → executor → gateway → GitHub (if applicable)
# 5.  Runs product smoke and infra-acceptance gates before committing config.
# 6.  Atomically persists the final .env only after all gates pass.
# 7.  On any failure applies deterministic cleanup appropriate to the phase.
#
# ABSOLUTE LIVE-RUNTIME LOCK (enforced below)
# -------------------------------------------
# This script MUST NOT:
#   - start/stop live containers of other projects
#   - modify mcp-bridge-jobs or quarangate-data contents directly
#   - create/persist DOCKER_AUTHORITY_TOKEN before the token transaction section
#   - print any token or secret value
#   - pull images from any registry
#   - deploy or promote canonical refs
#   - call or reference the standard deployment path
#
# USAGE
#   QUARANGATE_RUNTIME_ROOT=<path>  \
#   QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE=<tag-or-id>   \
#   QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE=<tag-or-id>  \
#   ./scripts/remote-owner-forward-recover-v9.sh
#
# All three env vars are mandatory.  No schema-check override flags exist.
#
# EXIT CODES
#   0  RECOVERY_ACCEPTED — all gates passed, .env committed
#   1  failure at some named recovery state (printed to stderr)
#   2  precondition or usage error — no mutation occurred

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

fail() {
  printf 'FORWARD_RECOVERY=FAIL state=%s reason=%s\n' "${RECOVERY_STATE:-UNKNOWN}" "$*" >&2
  exit 1
}

prefail() {
  # Used before any mutation — exits with code 2 (precondition failure)
  printf 'FORWARD_RECOVERY=ABORT_PRECONDITION reason=%s\n' "$*" >&2
  exit 2
}

log() { printf '[forward-recovery] %s\n' "$*"; }

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

probe_image_schema() {
  local image_id="$1"
  docker run --rm --pull never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --entrypoint node \
    --mount "type=bind,src=$REPO_ROOT/scripts/sh06-image-schema-probe.mjs,dst=/probe.mjs,readonly" \
    "$image_id" /probe.mjs
}

service_ids() {
  docker ps -a \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" \
    --format '{{.ID}}'
}

wait_service_ready() {
  local project="$1" service="$2" timeout_seconds="$3"
  local elapsed=0 cid='' rt='' ht=''
  while (( elapsed < timeout_seconds )); do
    mapfile -t ids < <(service_ids "$project" "$service")
    if [[ ${#ids[@]} -gt 1 ]]; then
      printf 'READINESS_GATE=FAIL service=%s classification=AMBIGUOUS\n' "$service" >&2
      return 1
    fi
    cid="${ids[0]:-}"
    if [[ -n "$cid" ]]; then
      rt="$(docker inspect "$cid" --format '{{.State.Status}}' 2>/dev/null || true)"
      ht="$(docker inspect "$cid" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
      if [[ "$rt" == running && ( "$ht" == healthy || "$ht" == none ) ]]; then
        printf 'READINESS_GATE=PASS service=%s state=%s health=%s\n' "$service" "$rt" "$ht"
        return 0
      fi
      if [[ "$rt" == exited || "$rt" == dead || "$rt" == removing ]]; then
        printf 'READINESS_GATE=FAIL service=%s classification=EXITED state=%s\n' "$service" "$rt" >&2
        return 1
      fi
      if [[ "$ht" == unhealthy ]]; then
        printf 'READINESS_GATE=FAIL service=%s classification=UNHEALTHY\n' "$service" >&2
        return 1
      fi
    fi
    sleep 2; elapsed=$((elapsed + 2))
  done
  printf 'READINESS_GATE=FAIL service=%s classification=TIMEOUT timeout=%s\n' "$service" "$timeout_seconds" >&2
  return 1
}


# ---------------------------------------------------------------------------
# SECTION 1 — Mandatory inputs
# ---------------------------------------------------------------------------

RECOVERY_STATE='PRECONDITION_CHECK'

[[ -n "${QUARANGATE_RUNTIME_ROOT:-}" ]]                   || prefail 'QUARANGATE_RUNTIME_ROOT is required'
[[ -n "${QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE:-}" ]] || prefail 'QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE is required'
[[ -n "${QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE:-}" ]] || prefail 'QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE is required'

command -v git    >/dev/null 2>&1 || prefail 'git missing'
command -v docker >/dev/null 2>&1 || prefail 'docker CLI missing'
command -v python3 >/dev/null 2>&1 || prefail 'python3 missing'
command -v node   >/dev/null 2>&1 || prefail 'node missing'

docker info >/dev/null 2>&1 || prefail 'Docker Engine unavailable'

# Verify candidate worktree is clean
REV="$(git rev-parse HEAD)"
BRANCH="$(git branch --show-current)"
[[ -n "$REV" && -n "$BRANCH" ]] || prefail 'candidate Git identity unavailable'
[[ -z "$(git status --porcelain)" ]] || prefail 'candidate worktree is not clean'

log "=== SH-06 CURRENT v9 INCIDENT — FORWARD RECOVERY ==="
log "Candidate rev=$REV branch=$BRANCH"

# ---------------------------------------------------------------------------
# SECTION 2 — Runtime root resolution
# ---------------------------------------------------------------------------

canonical_dir() { (cd "$1" 2>/dev/null && pwd -P); }

runtime_root_complete() {
  local r="$1"
  [[ -d "$r" && -f "$r/.env" && -f "$r/config/clients.yaml" && -f "$r/config/bridge.yaml" && -f "$r/compose.yaml" ]]
}

MAIN_ROOT="$(canonical_dir "$QUARANGATE_RUNTIME_ROOT")" || prefail 'QUARANGATE_RUNTIME_ROOT is not a real directory'
runtime_root_complete "$MAIN_ROOT" || prefail 'runtime root is incomplete (missing .env, config/clients.yaml, config/bridge.yaml, or compose.yaml)'

RUNTIME_ENV="$MAIN_ROOT/.env"
[[ -f "$RUNTIME_ENV" ]] || prefail 'runtime .env not found'

log "MAIN_ROOT=$MAIN_ROOT"

# ---------------------------------------------------------------------------
# SECTION 3 — Resolve and lock candidate/fallback image IDs
# ---------------------------------------------------------------------------

PRIMARY_IMAGE_REF="$QUARANGATE_FORWARD_RECOVERY_PRIMARY_IMAGE"
FALLBACK_IMAGE_REF="$QUARANGATE_FORWARD_RECOVERY_FALLBACK_IMAGE"
EXPECTED_PRIMARY_IMAGE_ID='sha256:2fe86e44ecc8bb85c1747ede467c92d865c35d503fe54f167deb2802fbd298fc'
EXPECTED_FALLBACK_IMAGE_ID='sha256:720172e5c189398bd91e33e5fac1897f9e98f260d00a86a3d6e24656f55bd9f7'
EXPECTED_LEGACY_IMAGE_ID='sha256:8457dcea1a00253fb6b09183d9bc21b2d50f6aef0e81e1845cebc3f7854bdfa0'
EXPECTED_PRIMARY_REV='42d226803bfbc073f10570ed7f8579d3f19baa2f'
EXPECTED_FALLBACK_REV='bd1a8a3f732b55515bca5e452140de132f3fb6d3'
EXPECTED_LEGACY_REV='a7a61c1ef1949180dd544f557999ebc328800321'

# Resolve to immutable image IDs immediately — never allow tag drift during operation
PRIMARY_IMAGE_ID="$(docker image inspect "$PRIMARY_IMAGE_REF" --format '{{.Id}}' 2>/dev/null)" \
  || prefail "primary image not found locally: $PRIMARY_IMAGE_REF"
FALLBACK_IMAGE_ID="$(docker image inspect "$FALLBACK_IMAGE_REF" --format '{{.Id}}' 2>/dev/null)" \
  || prefail "fallback image not found locally: $FALLBACK_IMAGE_REF"

[[ "$PRIMARY_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]  || prefail "primary image ID is invalid: $PRIMARY_IMAGE_ID"
[[ "$FALLBACK_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || prefail "fallback image ID is invalid: $FALLBACK_IMAGE_ID"
[[ "$PRIMARY_IMAGE_ID" == "$EXPECTED_PRIMARY_IMAGE_ID" ]] \
  || prefail "PRIMARY_IMAGE_ID_MISMATCH: expected=$EXPECTED_PRIMARY_IMAGE_ID actual=$PRIMARY_IMAGE_ID"
[[ "$FALLBACK_IMAGE_ID" == "$EXPECTED_FALLBACK_IMAGE_ID" ]] \
  || prefail "FALLBACK_IMAGE_ID_MISMATCH: expected=$EXPECTED_FALLBACK_IMAGE_ID actual=$FALLBACK_IMAGE_ID"

# Verify OCI revision labels
PRIMARY_REV="$(docker image inspect "$PRIMARY_IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" \
  || prefail 'primary image revision label unavailable'
FALLBACK_REV="$(docker image inspect "$FALLBACK_IMAGE_ID" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" \
  || prefail 'fallback image revision label unavailable'
[[ -n "$PRIMARY_REV" ]]  || prefail 'primary image has no org.opencontainers.image.revision label'
[[ -n "$FALLBACK_REV" ]] || prefail 'fallback image has no org.opencontainers.image.revision label'

[[ "$PRIMARY_REV" == "$EXPECTED_PRIMARY_REV" ]] \
  || prefail "PRIMARY_REVISION_MISMATCH: expected=$EXPECTED_PRIMARY_REV actual=$PRIMARY_REV"
[[ "$FALLBACK_REV" == "$EXPECTED_FALLBACK_REV" ]] \
  || prefail "FALLBACK_REVISION_MISMATCH: expected=$EXPECTED_FALLBACK_REV actual=$FALLBACK_REV"

log "PRIMARY  image_id=$PRIMARY_IMAGE_ID rev=$PRIMARY_REV"
log "FALLBACK image_id=$FALLBACK_IMAGE_ID rev=$FALLBACK_REV"

# No registry pulls permitted
printf '%s\n' "$PRIMARY_IMAGE_REF" "$FALLBACK_IMAGE_REF" | grep -Eq '^sha256:[0-9a-f]{64}$|^[^/]+:[^@]+$' || true
# Both images are already confirmed local above — no pull will occur


# ---------------------------------------------------------------------------
# SECTION 4 — INCIDENT PRECONDITION CONTRACT (Section 6 of spec)
# Abort before mutation if current state materially differs from expected.
# ---------------------------------------------------------------------------

log "=== INCIDENT PRECONDITION CONTRACT ==="

# 4a. Probe schema support from all three image classes
log "Probing schema support from exact local images..."

PRIMARY_SUPPORTED_SCHEMA="$(probe_image_schema "$PRIMARY_IMAGE_ID")" \
  || prefail 'primary image schema probe failed'
FALLBACK_SUPPORTED_SCHEMA="$(probe_image_schema "$FALLBACK_IMAGE_ID")" \
  || prefail 'fallback image schema probe failed'

# Discover the legacy executor image from the currently running container
mapfile -t live_executor_ids < <(service_ids quarangate executor)
[[ ${#live_executor_ids[@]} -eq 1 ]] \
  || prefail "expected exactly 1 legacy executor container, found ${#live_executor_ids[@]}"
LEGACY_EXECUTOR_CID="${live_executor_ids[0]}"
LEGACY_EXECUTOR_IMAGE_ID="$(docker inspect "$LEGACY_EXECUTOR_CID" --format '{{.Image}}')" \
  || prefail 'cannot read legacy executor image ID'
[[ "$LEGACY_EXECUTOR_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || prefail "legacy executor image ID is invalid: $LEGACY_EXECUTOR_IMAGE_ID"
[[ "$LEGACY_EXECUTOR_IMAGE_ID" == "$EXPECTED_LEGACY_IMAGE_ID" ]] \
  || prefail "LEGACY_IMAGE_ID_MISMATCH: expected=$EXPECTED_LEGACY_IMAGE_ID actual=$LEGACY_EXECUTOR_IMAGE_ID"
LEGACY_EXECUTOR_REV="$(docker inspect "$LEGACY_EXECUTOR_CID" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" || true

LEGACY_SUPPORTED_SCHEMA="$(probe_image_schema "$LEGACY_EXECUTOR_IMAGE_ID")" \
  || prefail 'legacy executor image schema probe failed'

log "LEGACY_EXECUTOR_IMAGE_ID=$LEGACY_EXECUTOR_IMAGE_ID rev=${LEGACY_EXECUTOR_REV:-unknown} schema=$LEGACY_SUPPORTED_SCHEMA"
log "PRIMARY_SUPPORTED_SCHEMA=$PRIMARY_SUPPORTED_SCHEMA"
log "FALLBACK_SUPPORTED_SCHEMA=$FALLBACK_SUPPORTED_SCHEMA"

# 4b. Verify expected incident state: legacy schema must be < 9
[[ "$LEGACY_SUPPORTED_SCHEMA" -lt 9 ]] \
  || prefail "INCIDENT_STATE_MISMATCH: legacy executor supports schema $LEGACY_SUPPORTED_SCHEMA (expected <9); re-verify incident before recovery"

# 4c. The legacy executor must be the exact accepted degraded incident revision.
[[ "$LEGACY_EXECUTOR_REV" == "$EXPECTED_LEGACY_REV" ]] \
  || prefail "LEGACY_REVISION_MISMATCH: expected=$EXPECTED_LEGACY_REV actual=${LEGACY_EXECUTOR_REV:-missing}"
LEGACY_STATE="$(docker inspect "$LEGACY_EXECUTOR_CID" --format '{{.State.Status}}')" || true
[[ "$LEGACY_STATE" == restarting || "$LEGACY_STATE" == exited ]] \
  || prefail "INCIDENT_STATE_MISMATCH: legacy executor state=$LEGACY_STATE (expected restarting or exited)"

# 4d. Gateway must be the same image as the legacy executor (same build artifact)
mapfile -t live_gateway_ids < <(service_ids quarangate gateway)
[[ ${#live_gateway_ids[@]} -eq 1 ]] \
  || prefail "expected exactly 1 gateway container, found ${#live_gateway_ids[@]}"
LIVE_GATEWAY_CID="${live_gateway_ids[0]}"
LIVE_GATEWAY_IMAGE_ID="$(docker inspect "$LIVE_GATEWAY_CID" --format '{{.Image}}')" \
  || prefail 'cannot read live gateway image ID'
[[ "$LIVE_GATEWAY_IMAGE_ID" == "$LEGACY_EXECUTOR_IMAGE_ID" ]] \
  || prefail "INCIDENT_STATE_MISMATCH: gateway and executor use different image IDs"
LIVE_GATEWAY_HEALTH="$(docker inspect "$LIVE_GATEWAY_CID" \
  --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" || true
log "LIVE_GATEWAY_HEALTH=$LIVE_GATEWAY_HEALTH (expected unhealthy)"
[[ "$LIVE_GATEWAY_HEALTH" == unhealthy ]] \
  || prefail "INCIDENT_STATE_MISMATCH: gateway health=$LIVE_GATEWAY_HEALTH (expected unhealthy)"

# 4e. docker-authority must be absent
mapfile -t authority_ids < <(service_ids quarangate docker-authority)
[[ ${#authority_ids[@]} -eq 0 ]] \
  || prefail "INCIDENT_STATE_MISMATCH: docker-authority container present (expected absent)"

# 4f. GitHub broker and proxy must be absent (failed-rollback baseline)
mapfile -t old_broker_ids  < <(service_ids quarangate github-broker)
mapfile -t old_proxy_ids   < <(service_ids quarangate github-egress-proxy)
[[ ${#old_broker_ids[@]}  -le 1 ]] || prefail 'ambiguous GitHub broker baseline'
[[ ${#old_proxy_ids[@]}   -le 1 ]] || prefail 'ambiguous GitHub proxy baseline'
[[ ${#old_broker_ids[@]}  -eq ${#old_proxy_ids[@]} ]] || prefail 'incomplete GitHub service baseline'
GITHUB_BASELINE_PRESENT=${#old_broker_ids[@]}   # 0 = absent (expected), 1 = unexpectedly present
[[ "$GITHUB_BASELINE_PRESENT" -eq 0 ]] \
  || prefail "INCIDENT_STATE_MISMATCH: GitHub services present (expected absent after failed rollback)"
log "GITHUB_BASELINE=ABSENT (expected)"

# 4g. Verify required networks exist
docker network inspect quarangate-github-control >/dev/null 2>&1 \
  || prefail 'quarangate-github-control network absent (required for GitHub recovery)'
docker network inspect quarangate-github-egress >/dev/null 2>&1 \
  || prefail 'quarangate-github-egress network absent (required for GitHub recovery)'
docker network inspect quarangate-internal >/dev/null 2>&1 \
  || prefail 'quarangate-internal network absent'
docker network inspect quarangate-edge >/dev/null 2>&1 \
  || prefail 'quarangate-edge network absent'
log "REQUIRED_NETWORKS=PRESENT"

# 4h. mcp-bridge-jobs volume must exist (required for DB snapshot)
docker volume inspect mcp-bridge-jobs >/dev/null 2>&1 \
  || prefail 'mcp-bridge-jobs volume absent (required for v9 snapshot)'

# 4i. Ollama and projects-work presence — capture identities for later verification
mapfile -t ollama_ids < <(service_ids quarangate ollama 2>/dev/null || true)
OLLAMA_IMAGE_ID=''
if [[ ${#ollama_ids[@]} -eq 1 ]]; then
  OLLAMA_IMAGE_ID="$(docker inspect "${ollama_ids[0]}" --format '{{.Image}}')" || true
  log "OLLAMA_IMAGE_ID=$OLLAMA_IMAGE_ID"
fi
mapfile -t pw_ids < <(docker ps -a --filter label=com.docker.compose.project=projects-work \
  --filter label=com.docker.compose.service=work --format '{{.ID}}' 2>/dev/null || true)
PROJECTS_WORK_IMAGE_ID=''
if [[ ${#pw_ids[@]} -eq 1 ]]; then
  PROJECTS_WORK_IMAGE_ID="$(docker inspect "${pw_ids[0]}" --format '{{.Image}}')" || true
  log "PROJECTS_WORK_IMAGE_ID=$PROJECTS_WORK_IMAGE_ID"
fi

# 4j. Capture runtime .env hash for later verification that we haven't drifted
RUNTIME_ENV_BASELINE_SHA256="$(sha256sum "$RUNTIME_ENV" | cut -d' ' -f1)"
log "RUNTIME_ENV_SHA256=$RUNTIME_ENV_BASELINE_SHA256"

# 4k. Fallback must not be the same image as the legacy executor
[[ "$FALLBACK_IMAGE_ID" != "$LEGACY_EXECUTOR_IMAGE_ID" ]] \
  || prefail 'FALLBACK_IS_LEGACY_EXECUTOR: fallback image is the crash-looping legacy executor — hard denied'

printf 'INCIDENT_VERIFIED state=EXECUTOR_RESTARTING legacy_schema=%s primary_schema=%s fallback_schema=%s github=ABSENT docker_authority=ABSENT\n' \
  "$LEGACY_SUPPORTED_SCHEMA" "$PRIMARY_SUPPORTED_SCHEMA" "$FALLBACK_SUPPORTED_SCHEMA"

RECOVERY_STATE='INCIDENT_VERIFIED'
log "RECOVERY_STATE=$RECOVERY_STATE"


# ---------------------------------------------------------------------------
# SECTION 5 — v9 DATABASE SAFETY SNAPSHOT (Section 9 of spec)
# Source mounted read-only. Network disabled. Private 0700 dir, 0600 files.
# ---------------------------------------------------------------------------

log "=== V9 DATABASE SAFETY SNAPSHOT ==="

snapshot_parent_root="$(mktemp -d)"
chmod 0700 "$snapshot_parent_root"
snapshot_dir="$snapshot_parent_root/sh06-fwd-${REV:0:12}-$$"
mkdir -m 0700 "$snapshot_dir"

snapshot_path="$snapshot_dir/agents.db"
snapshot_manifest="$snapshot_dir/manifest.json"
SNAPSHOT_SCHEMA=''
SNAPSHOT_SHA256=''
SNAPSHOT_SIZE_BYTES=''

snapshot_result="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 1000:1000 \
  --mount type=volume,src=mcp-bridge-jobs,dst=/source,readonly \
  --mount "type=bind,src=$snapshot_dir,dst=/snapshot" \
  "$PRIMARY_IMAGE_ID" node /app/dist/operations/sh06JobDbRecovery.js \
  snapshot /source/agents.db /snapshot/agents.db /snapshot/manifest.json)" \
  || fail 'v9 snapshot creation failed'

[[ -f "$snapshot_path" && -f "$snapshot_manifest" ]] || fail 'v9 snapshot output files missing'

printf '%s' "$snapshot_result" | python3 -c \
  'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="SNAPSHOT_VERIFIED" and d.get("integrityCheck")=="ok"' \
  || fail 'v9 snapshot creation proof is invalid'

# Independent verification pass
snapshot_verify_result="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 1000:1000 \
  --mount "type=bind,src=$snapshot_dir,dst=/snapshot,readonly" \
  "$PRIMARY_IMAGE_ID" node /app/dist/operations/sh06JobDbRecovery.js \
  verify /snapshot/agents.db /snapshot/manifest.json)" \
  || fail 'v9 snapshot verification failed'

SNAPSHOT_SCHEMA="$(printf '%s' "$snapshot_verify_result" | python3 -c \
  'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="SNAPSHOT_VERIFIED"; v=d.get("userVersion"); assert isinstance(v,int) and v>=0; print(v)')" \
  || fail 'snapshot schema evidence is invalid'
SNAPSHOT_SHA256="$(printf '%s' "$snapshot_verify_result" | python3 -c \
  'import json,re,sys; v=json.load(sys.stdin).get("sha256",""); assert re.fullmatch(r"[0-9a-f]{64}",v); print(v)')" \
  || fail 'snapshot digest evidence is invalid'
SNAPSHOT_SIZE_BYTES="$(printf '%s' "$snapshot_verify_result" | python3 -c \
  'import json,sys; v=json.load(sys.stdin).get("sizeBytes"); assert isinstance(v,int) and v>0; print(v)')" \
  || fail 'snapshot size evidence is invalid'
# Critical: snapshot must be schema 9
[[ "$SNAPSHOT_SCHEMA" == 9 ]] \
  || fail "V9_SNAPSHOT_SCHEMA_MISMATCH: snapshot schema=$SNAPSHOT_SCHEMA expected=9"

RECOVERY_STATE='V9_SNAPSHOT_VERIFIED'
log "RECOVERY_STATE=$RECOVERY_STATE SNAPSHOT_SCHEMA=$SNAPSHOT_SCHEMA SHA256=<redacted> SIZE=$SNAPSHOT_SIZE_BYTES"
printf 'V9_SNAPSHOT_CREATED=YES V9_SNAPSHOT_VERIFIED=YES SNAPSHOT_SCHEMA=%s SNAPSHOT_SIZE_BYTES=%s SNAPSHOT_CONTENT_EXPOSED=NO\n' \
  "$SNAPSHOT_SCHEMA" "$SNAPSHOT_SIZE_BYTES"
printf 'SNAPSHOT_IDENTITY_SHA256=%s\n' "$SNAPSHOT_SHA256"

# ---------------------------------------------------------------------------
# SECTION 6 — RECOVERY ADMISSION EVALUATOR (Section 7 of spec)
# Single authoritative TypeScript decision — no shell-duplicated logic.
# ---------------------------------------------------------------------------

log "=== RECOVERY ADMISSION GATE ==="

# Build the TypeScript evaluator if needed
EVALUATOR_JS="$REPO_ROOT/dist/operations/sh06ForwardRecovery.js"
if [[ ! -f "$EVALUATOR_JS" ]]; then
  log "Building TypeScript evaluator..."
  (cd "$REPO_ROOT" && node_modules/.bin/tsc -p tsconfig.json) \
    || fail 'TypeScript build failed — cannot evaluate admission'
fi

ADMISSION_JSON="$(node "$EVALUATOR_JS" evaluate \
  "$(python3 -c "import json; print(json.dumps({
    'currentSchema': $SNAPSHOT_SCHEMA,
    'primarySupportedSchema': $PRIMARY_SUPPORTED_SCHEMA,
    'fallbackSupportedSchema': $FALLBACK_SUPPORTED_SCHEMA,
    'legacySupportedSchema': $LEGACY_SUPPORTED_SCHEMA,
    'snapshotCreated': True,
    'snapshotVerified': True,
    'snapshotSchema': $SNAPSHOT_SCHEMA,
  }))")" 2>/dev/null)" \
  || fail "RECOVERY_ADMISSION_DENIED: evaluator returned non-zero — check fallback schema compatibility"

# Validate the admission JSON
ADMISSION_VERDICT="$(printf '%s' "$ADMISSION_JSON" | python3 -c \
  'import json,sys; d=json.load(sys.stdin); assert d.get("verdict") in ("ALLOW","DENY"); print(d["verdict"])')" \
  || fail 'admission evaluator output is invalid JSON or missing verdict'

ADMISSION_REASON="$(printf '%s' "$ADMISSION_JSON" | python3 -c \
  'import json,sys; print(json.load(sys.stdin).get("reason","UNKNOWN"))')" || true

FALLBACK_QUALIFIED="$(printf '%s' "$ADMISSION_JSON" | python3 -c \
  'import json,sys; print(str(json.load(sys.stdin).get("fallbackQualified","false")).lower())')" || true

[[ "$ADMISSION_VERDICT" == ALLOW ]] \
  || fail "RECOVERY_ADMISSION_DENIED reason=$ADMISSION_REASON — forward recovery blocked by evaluator"

log "RECOVERY_ADMISSION=ALLOW reason=$ADMISSION_REASON fallback_qualified=$FALLBACK_QUALIFIED"
printf 'RECOVERY_ADMISSION=ALLOW reason=%s current_schema=%s primary_schema=%s fallback_schema=%s\n' \
  "$ADMISSION_REASON" "$SNAPSHOT_SCHEMA" "$PRIMARY_SUPPORTED_SCHEMA" "$FALLBACK_SUPPORTED_SCHEMA"

# ---------------------------------------------------------------------------
# SECTION 7 — TOKEN TRANSACTION (Section 11 of spec)
# Generate DOCKER_AUTHORITY_TOKEN in memory. Never printed. Distinct from INTERNAL_TOKEN.
# ---------------------------------------------------------------------------

log "=== TOKEN TRANSACTION ==="

INTERNAL_TOKEN_VALUE="$(read_runtime_value INTERNAL_TOKEN)" \
  || fail 'runtime .env must contain exactly one non-empty INTERNAL_TOKEN'

# Generate a fresh operation-local authority token (never persisted until acceptance gates pass)
DOCKER_AUTHORITY_TOKEN_VALUE="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
[[ -n "$DOCKER_AUTHORITY_TOKEN_VALUE" ]] || fail 'could not generate DOCKER_AUTHORITY_TOKEN'
[[ "$DOCKER_AUTHORITY_TOKEN_VALUE" != "$INTERNAL_TOKEN_VALUE" ]] \
  || fail 'generated authority token must be distinct from INTERNAL_TOKEN'

# Export for docker compose env substitution — value never echoed
export DOCKER_AUTHORITY_TOKEN="$DOCKER_AUTHORITY_TOKEN_VALUE"

RECOVERY_STATE='RECOVERY_TOKEN_PREPARED_IN_MEMORY'
log "RECOVERY_STATE=$RECOVERY_STATE"

# ---------------------------------------------------------------------------
# SECTION 8 — ROLLBACK / CLEANUP TRAP
# Installed BEFORE any mutation. Arms env backup before mktemp.
# ---------------------------------------------------------------------------

env_backup=''
env_backup_sha256=''
env_updated=0
runtime_mutated=0
persistent_state_may_have_mutated=0
github_services_created=0

# Tag variants for the recovery images
NEW_GATEWAY_IMAGE="quarangate:gateway-${REV}"
NEW_DOCKER_AUTHORITY_IMAGE="quarangate:docker-authority-${REV}"
NEW_EXECUTOR_IMAGE="quarangate:executor-${REV}"
FALLBACK_GATEWAY_IMAGE="quarangate:gateway-fallback-${FALLBACK_REV}"
FALLBACK_DOCKER_AUTHORITY_IMAGE="quarangate:docker-authority-fallback-${FALLBACK_REV}"
FALLBACK_EXECUTOR_IMAGE="quarangate:executor-fallback-${FALLBACK_REV}"

persist_runtime_config() {
  local gateway_image="$1" gateway_id="$2"
  local authority_image="$3" authority_id="$4"
  local executor_image="$5" executor_id="$6"
  local fallback_image="$7" fallback_id="$8"
  DOCKER_AUTHORITY_TOKEN="$DOCKER_AUTHORITY_TOKEN_VALUE" \
  FINAL_OLLAMA_IMAGE="${FINAL_OLLAMA_IMAGE:-}" \
  python3 - "$RUNTIME_ENV" \
    "$gateway_image" "$gateway_id" \
    "$authority_image" "$authority_id" \
    "$executor_image" "$executor_id" \
    "$fallback_image" "$fallback_id" <<'PYCONFIG'
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
    'FORWARD_RECOVERY_FALLBACK_IMAGE': sys.argv[8],
    'FORWARD_RECOVERY_FALLBACK_IMAGE_ID': sys.argv[9],
    'DOCKER_AUTHORITY_TOKEN': os.environ['DOCKER_AUTHORITY_TOKEN'],
}
if os.environ.get('FINAL_OLLAMA_IMAGE'):
    updates['OLLAMA_IMAGE'] = os.environ['FINAL_OLLAMA_IMAGE']
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
fd, tmp = tempfile.mkstemp(prefix='.qg-recovery-env-', dir=str(path.parent))
try:
    with os.fdopen(fd, 'w') as f:
        f.writelines(lines)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PYCONFIG
  env_updated=1
}

verify_runtime_config() {
  local gateway_image="$1" gateway_id="$2"
  local authority_image="$3" authority_id="$4"
  local executor_image="$5" executor_id="$6"
  local fallback_image="$7" fallback_id="$8"
  DOCKER_AUTHORITY_TOKEN="$DOCKER_AUTHORITY_TOKEN_VALUE" \
  python3 - "$RUNTIME_ENV" \
    "$gateway_image" "$gateway_id" \
    "$authority_image" "$authority_id" \
    "$executor_image" "$executor_id" \
    "$fallback_image" "$fallback_id" <<'PYVERIFYCONFIG'
import os, sys
from pathlib import Path
path = Path(sys.argv[1])
expected = {
    'GATEWAY_IMAGE': sys.argv[2],
    'GATEWAY_IMAGE_ID': sys.argv[3],
    'DOCKER_AUTHORITY_IMAGE': sys.argv[4],
    'DOCKER_AUTHORITY_IMAGE_ID': sys.argv[5],
    'EXECUTOR_IMAGE': sys.argv[6],
    'EXECUTOR_IMAGE_ID': sys.argv[7],
    'FORWARD_RECOVERY_FALLBACK_IMAGE': sys.argv[8],
    'FORWARD_RECOVERY_FALLBACK_IMAGE_ID': sys.argv[9],
    'DOCKER_AUTHORITY_TOKEN': os.environ['DOCKER_AUTHORITY_TOKEN'],
}
found = {}
for raw in path.read_text().splitlines():
    if '=' not in raw or raw.lstrip().startswith('#'):
        continue
    key, value = raw.split('=', 1)
    if key in expected:
        if key in found:
            raise SystemExit(f'duplicate persisted {key}')
        found[key] = value
for key, value in expected.items():
    if found.get(key) != value:
        raise SystemExit(f'persisted {key} mismatch')
PYVERIFYCONFIG
}

rollback() {
  local rc=$?
  local fallback_ready=NO
  trap - EXIT
  if [[ $rc -ne 0 ]]; then
    printf '=== FORWARD RECOVERY ROLLBACK state=%s ===\n' "$RECOVERY_STATE" >&2
    ROLLBACK_IMAGE_STATE=NO
    ROLLBACK_PERSISTENT_STATE=NO
    ROLLBACK_CONFIG_STATE=NO
    ROLLBACK_GITHUB_STATE=NO
    ROLLBACK_NETWORK_STATE=YES   # networks were pre-existing; we never remove them

    # Config rollback — restore .env bytes if we updated them
    if [[ "$env_updated" == 1 && -n "$env_backup" && -f "$env_backup" ]]; then
      if cp "$env_backup" "$RUNTIME_ENV" && \
         [[ "$(sha256sum "$RUNTIME_ENV" | cut -d' ' -f1)" == "$env_backup_sha256" ]]; then
        ROLLBACK_CONFIG_STATE=YES
        log "ROLLBACK config restored from backup"
      else
        log "ROLLBACK config restore FAILED" >&2
      fi
    else
      ROLLBACK_CONFIG_STATE=YES  # env never updated; baseline is intact
    fi

    if [[ "$runtime_mutated" == 1 ]]; then
      # Stop any recovery-created services (authority, executor, gateway)
      local candidate_services=(docker-authority executor gateway)
      local QG_RB=(docker compose --project-directory "$MAIN_ROOT" --env-file "$RUNTIME_ENV" -p quarangate "${QG_FILES[@]}")

      "${QG_RB[@]}" stop "${candidate_services[@]}" >/dev/null 2>&1 || true

      # Persistent state: if executor was ever started, restore from v9 snapshot
      if [[ "$persistent_state_may_have_mutated" == 1 && -f "$snapshot_path" && -f "$snapshot_manifest" ]]; then
        # Restore via the same immutable image used for snapshot — networkless
        restore_result="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
          --security-opt no-new-privileges:true --user 1000:1000 \
          --mount type=volume,src=mcp-bridge-jobs,dst=/jobs \
          --mount "type=bind,src=$snapshot_dir,dst=/snapshot,readonly" \
          "$PRIMARY_IMAGE_ID" node /app/dist/operations/sh06JobDbRecovery.js \
          restore /snapshot/agents.db /snapshot/manifest.json /jobs/agents.db 2>&1)" || true
        if printf '%s' "$restore_result" | grep -q 'PERSISTENT_STATE_RESTORED'; then
          ROLLBACK_PERSISTENT_STATE=YES
          log "ROLLBACK persistent state restored from v9 snapshot"
        else
          log "ROLLBACK persistent state restore FAILED — manual intervention required" >&2
          printf 'CRITICAL: persistent state restore failed after post-executor failure\n' >&2
          printf 'CRITICAL_INVARIANT: DO NOT START LEGACY v7 EXECUTOR — db may be v9\n' >&2
        fi
      else
        ROLLBACK_PERSISTENT_STATE=YES  # executor never started; no mutation possible
      fi

      # Remove only recovery-created GitHub services (baseline was ABSENT)
      # Baseline was ABSENT; remove only recovery-created services (REMOVE_CANDIDATE_CREATED path)
      if [[ "$github_services_created" == 1 ]]; then
        mapfile -t rb_broker_ids < <(service_ids quarangate github-broker)
        mapfile -t rb_proxy_ids  < <(service_ids quarangate github-egress-proxy)
        for cid in "${rb_broker_ids[@]}" "${rb_proxy_ids[@]}"; do
          docker stop "$cid" >/dev/null 2>&1 || true
          docker rm   "$cid" >/dev/null 2>&1 || true
        done
        ROLLBACK_GITHUB_STATE=YES
        log "ROLLBACK removed recovery-created GitHub services"
      else
        ROLLBACK_GITHUB_STATE=YES  # nothing created
      fi

      # Never resume the legacy v7 baseline against schema-v9 state. Only the
      # exact admitted R2 image may become the recovery fallback.
      if [[ "$ROLLBACK_PERSISTENT_STATE" == YES && "$ROLLBACK_CONFIG_STATE" == YES ]]; then
        ROLLBACK_CONFIG_STATE=NO
        export GATEWAY_IMAGE="$FALLBACK_GATEWAY_IMAGE"
        export DOCKER_AUTHORITY_IMAGE="$FALLBACK_DOCKER_AUTHORITY_IMAGE"
        export EXECUTOR_IMAGE="$FALLBACK_EXECUTOR_IMAGE"

        if "${QG_RB[@]}" up -d --no-deps --no-build --pull never docker-authority \
          && wait_service_ready quarangate docker-authority 60 \
          && "${QG_RB[@]}" up -d --no-deps --no-build --pull never executor \
          && wait_service_ready quarangate executor 120 \
          && "${QG_RB[@]}" up -d --no-deps --no-build --pull never gateway \
          && wait_service_ready quarangate gateway 60; then
          mapfile -t rb_authority_ids < <(service_ids quarangate docker-authority)
          mapfile -t rb_executor_ids < <(service_ids quarangate executor)
          mapfile -t rb_gateway_ids < <(service_ids quarangate gateway)
          if [[ ${#rb_authority_ids[@]} -eq 1 && ${#rb_executor_ids[@]} -eq 1 && ${#rb_gateway_ids[@]} -eq 1 \
             && "$(docker inspect "${rb_authority_ids[0]}" --format '{{.Image}}')" == "$FALLBACK_IMAGE_ID" \
             && "$(docker inspect "${rb_executor_ids[0]}" --format '{{.Image}}')" == "$FALLBACK_IMAGE_ID" \
             && "$(docker inspect "${rb_gateway_ids[0]}" --format '{{.Image}}')" == "$FALLBACK_IMAGE_ID" ]]; then
            fallback_db_proof="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
              --security-opt no-new-privileges:true --user 1000:1000 \
              --mount type=volume,src=mcp-bridge-jobs,dst=/source,readonly \
              --mount "type=bind,src=$snapshot_dir,dst=/snapshot" \
              "$FALLBACK_IMAGE_ID" node /app/dist/operations/sh06JobDbRecovery.js \
              snapshot /source/agents.db /snapshot/agents.db.fallback /snapshot/manifest.fallback.json \
              2>/dev/null)" || true
            if printf '%s' "$fallback_db_proof" | python3 -c \
              'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="SNAPSHOT_VERIFIED" and d.get("userVersion")==9 and d.get("integrityCheck")=="ok" and d.get("foreignKeyViolations")==0' \
              && persist_runtime_config \
                "$FALLBACK_GATEWAY_IMAGE" "$FALLBACK_IMAGE_ID" \
                "$FALLBACK_DOCKER_AUTHORITY_IMAGE" "$FALLBACK_IMAGE_ID" \
                "$FALLBACK_EXECUTOR_IMAGE" "$FALLBACK_IMAGE_ID" \
                "$FALLBACK_EXECUTOR_IMAGE" "$FALLBACK_IMAGE_ID" \
              && verify_runtime_config \
                "$FALLBACK_GATEWAY_IMAGE" "$FALLBACK_IMAGE_ID" \
                "$FALLBACK_DOCKER_AUTHORITY_IMAGE" "$FALLBACK_IMAGE_ID" \
                "$FALLBACK_EXECUTOR_IMAGE" "$FALLBACK_IMAGE_ID" \
                "$FALLBACK_EXECUTOR_IMAGE" "$FALLBACK_IMAGE_ID"; then
              fallback_ready=YES
              ROLLBACK_IMAGE_STATE=YES
              ROLLBACK_CONFIG_STATE=YES
              RECOVERY_STATE='R2_FALLBACK_READY'
            fi
            rm -f "$snapshot_dir/agents.db.fallback" "$snapshot_dir/manifest.fallback.json" 2>/dev/null || true
          fi
        fi
      fi

      if [[ "$fallback_ready" != YES ]]; then
        "${QG_RB[@]}" stop docker-authority executor gateway >/dev/null 2>&1 || true
      fi
    else
      # No mutation reached; baseline is preserved
      ROLLBACK_IMAGE_STATE=YES
      ROLLBACK_PERSISTENT_STATE=YES
    fi

    # HARD INVARIANT: never attempt to start legacy executor
    printf 'LEGACY_EXECUTOR_START_ATTEMPTED=NO\n'
    printf 'ROLLBACK_IMAGE_STATE=%s ROLLBACK_PERSISTENT_STATE=%s ROLLBACK_CONFIG_STATE=%s ROLLBACK_GITHUB_STATE=%s ROLLBACK_NETWORK_STATE=%s\n' \
      "$ROLLBACK_IMAGE_STATE" "$ROLLBACK_PERSISTENT_STATE" "$ROLLBACK_CONFIG_STATE" \
      "$ROLLBACK_GITHUB_STATE" "$ROLLBACK_NETWORK_STATE" >&2

    if [[ "$runtime_mutated" == 1 && "$fallback_ready" != YES ]]; then
      printf 'FORWARD_RECOVERY_FAILED=CRITICAL_FORWARD_RECOVERY_FAILED state=%s\n' "$RECOVERY_STATE" >&2
      printf 'CRITICAL_INVARIANT: DO NOT START LEGACY v7 EXECUTOR — db is schema v9\n' >&2
    elif [[ "$fallback_ready" == YES ]]; then
      printf 'FORWARD_RECOVERY=PASS_R2_FALLBACK\n'
      printf 'R2_FALLBACK_READY=YES FALLBACK_IMAGE_ID=%s DB_SCHEMA_FINAL=9\n' "$FALLBACK_IMAGE_ID"
    fi
  fi

  # Always clean up secret material and temp files
  unset DOCKER_AUTHORITY_TOKEN
  unset DOCKER_AUTHORITY_TOKEN_VALUE
  unset INTERNAL_TOKEN_VALUE
  [[ -z "$env_backup" ]] || rm -f "$env_backup"
  rm -rf "$snapshot_parent_root" 2>/dev/null || true
  if [[ "$fallback_ready" == YES ]]; then
    exit 0
  fi
  exit "$rc"
}

# ARM THE TRAP before creating any secret temp material
trap rollback EXIT

# Create .env backup immediately after trap is armed
env_backup="$(mktemp)"
chmod 0600 "$env_backup"
cp "$RUNTIME_ENV" "$env_backup"
env_backup_sha256="$(sha256sum "$env_backup" | cut -d' ' -f1)"
log "env backup armed (sha256 recorded, value not printed)"


# ---------------------------------------------------------------------------
# SECTION 9 — IMAGE TAGGING
# Tag the immutable IDs to the recovery service names before compose up.
# ---------------------------------------------------------------------------

log "=== IMAGE TAGGING ==="

docker tag "$PRIMARY_IMAGE_ID"  "$NEW_GATEWAY_IMAGE"
docker tag "$PRIMARY_IMAGE_ID"  "$NEW_DOCKER_AUTHORITY_IMAGE"
docker tag "$PRIMARY_IMAGE_ID"  "$NEW_EXECUTOR_IMAGE"
docker tag "$FALLBACK_IMAGE_ID" "$FALLBACK_GATEWAY_IMAGE"
docker tag "$FALLBACK_IMAGE_ID" "$FALLBACK_DOCKER_AUTHORITY_IMAGE"
docker tag "$FALLBACK_IMAGE_ID" "$FALLBACK_EXECUTOR_IMAGE"

# Re-confirm image IDs after tagging (guard against race with another process)
assert_image_binding() {
  local tag="$1" expected_id="$2"
  local actual_id
  actual_id="$(docker image inspect "$tag" --format '{{.Id}}')"
  [[ "$actual_id" == "$expected_id" ]] \
    || fail "image tag retargeted between tagging and deployment: $tag expected=$expected_id actual=$actual_id"
}
assert_image_binding "$NEW_GATEWAY_IMAGE"           "$PRIMARY_IMAGE_ID"
assert_image_binding "$NEW_DOCKER_AUTHORITY_IMAGE"  "$PRIMARY_IMAGE_ID"
assert_image_binding "$NEW_EXECUTOR_IMAGE"          "$PRIMARY_IMAGE_ID"
assert_image_binding "$FALLBACK_GATEWAY_IMAGE"      "$FALLBACK_IMAGE_ID"
assert_image_binding "$FALLBACK_DOCKER_AUTHORITY_IMAGE" "$FALLBACK_IMAGE_ID"
assert_image_binding "$FALLBACK_EXECUTOR_IMAGE"     "$FALLBACK_IMAGE_ID"

log "IMAGE_BINDINGS_CONFIRMED primary=$PRIMARY_IMAGE_ID fallback=$FALLBACK_IMAGE_ID"

# ---------------------------------------------------------------------------
# SECTION 10 — COMPOSE CONFIGURATION
# ---------------------------------------------------------------------------

export GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE"
export DOCKER_AUTHORITY_IMAGE="$NEW_DOCKER_AUTHORITY_IMAGE"
export EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE"
export PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/projects}"
[[ -d "$PROJECTS_ROOT" ]] || fail "projects root missing: $PROJECTS_ROOT"

QG_FILES=(-f "$REPO_ROOT/compose.yaml")
ollama_expected=0
if grep -q '^OLLAMA_MODEL_QUALIFIER=' "$RUNTIME_ENV"; then ollama_expected=1; fi
if docker ps -a --filter label=com.docker.compose.project=quarangate \
     --filter label=com.docker.compose.service=ollama --format '{{.ID}}' | grep -q .; then
  ollama_expected=1
fi
if [[ "$ollama_expected" == 1 ]]; then
  [[ -f "$REPO_ROOT/compose.ollama.yaml" ]] || fail 'O1 configured but compose.ollama.yaml missing'
  QG_FILES+=(-f "$REPO_ROOT/compose.ollama.yaml")
  RUNTIME_OLLAMA_IMAGE="$(read_runtime_value OLLAMA_IMAGE)" \
    || fail 'O1 runtime requires exactly one non-empty OLLAMA_IMAGE'
  export OLLAMA_IMAGE="$RUNTIME_OLLAMA_IMAGE"
fi

github_expected=0
if [[ -f "$MAIN_ROOT/config/github.yaml" ]]; then github_expected=1; fi
if [[ "$github_expected" == 1 ]]; then
  [[ -f "$REPO_ROOT/compose.github.yaml" ]] || fail 'GitHub configured but compose.github.yaml missing in candidate'
  QG_FILES+=(-f "$REPO_ROOT/compose.github.yaml")
fi

QG=(docker compose --project-directory "$MAIN_ROOT" --env-file "$RUNTIME_ENV" -p quarangate "${QG_FILES[@]}")
# ---------------------------------------------------------------------------
# SECTION 11 — STAGED SERVICE RECOVERY (Sections 12 of spec)
# Strict dependency order: docker-authority → executor → gateway → GitHub
# ---------------------------------------------------------------------------

log "=== STAGED SERVICE RECOVERY ==="
runtime_mutated=1   # Set before first compose up so rollback knows to clean up

# --- Stage 1: docker-authority ---
log "Stage 1: starting docker-authority..."
"${QG[@]}" up -d --no-deps --no-build --pull never docker-authority \
  || fail 'docker-authority startup failed'
wait_service_ready quarangate docker-authority 60 \
  || fail 'docker-authority did not become ready within 60s'

RECOVERY_STATE='DOCKER_AUTHORITY_READY'
log "RECOVERY_STATE=$RECOVERY_STATE"
printf 'DOCKER_AUTHORITY_STARTED=YES DOCKER_AUTHORITY_READY=YES\n'

# --- Stage 2: executor ---
log "Stage 2: starting executor..."
persistent_state_may_have_mutated=1  # executor can write to mcp-bridge-jobs
"${QG[@]}" up -d --no-deps --no-build --pull never executor \
  || fail 'executor startup failed'
wait_service_ready quarangate executor 120 \
  || fail 'executor did not become ready within 120s'

RECOVERY_STATE='EXECUTOR_READY'
log "RECOVERY_STATE=$RECOVERY_STATE"
printf 'EXECUTOR_STARTED=YES EXECUTOR_READY=YES\n'

# Confirm DB schema unchanged after executor startup (must still be 9)
POST_EXECUTOR_SCHEMA="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 1000:1000 \
  --mount type=volume,src=mcp-bridge-jobs,dst=/source,readonly \
  --mount "type=bind,src=$snapshot_dir,dst=/snapshot" \
  "$PRIMARY_IMAGE_ID" node /app/dist/operations/sh06JobDbRecovery.js \
  snapshot /source/agents.db /snapshot/agents.db.post /snapshot/manifest.post.json \
  2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("userVersion","?"))')" \
  2>/dev/null || POST_EXECUTOR_SCHEMA="probe_failed"
rm -f "$snapshot_dir/agents.db.post" "$snapshot_dir/manifest.post.json" 2>/dev/null || true
if [[ "$POST_EXECUTOR_SCHEMA" == "probe_failed" ]]; then
  fail 'SCHEMA_MUTATION_DETECTED: post-executor schema proof unavailable'
elif [[ "$POST_EXECUTOR_SCHEMA" != 9 ]]; then
  fail "SCHEMA_MUTATION_DETECTED: DB schema changed to $POST_EXECUTOR_SCHEMA after executor startup (was 9)"
fi
log "POST_EXECUTOR_SCHEMA=${POST_EXECUTOR_SCHEMA:-9}"

# --- Stage 3: gateway ---
log "Stage 3: starting gateway..."
"${QG[@]}" up -d --no-deps --no-build --pull never gateway \
  || fail 'gateway startup failed'
wait_service_ready quarangate gateway 60 \
  || fail 'gateway did not become ready within 60s'

RECOVERY_STATE='GATEWAY_READY'
log "RECOVERY_STATE=$RECOVERY_STATE"
printf 'GATEWAY_STARTED=YES GATEWAY_READY=YES\n'

# --- Stage 4: GitHub services (if applicable) ---
if [[ "$github_expected" == 1 ]]; then
  log "Stage 4: starting GitHub egress proxy..."
  # Arm cleanup before the first create attempt: Compose may create a
  # container and still return failure or fail readiness afterward.
  github_services_created=1
  "${QG[@]}" up -d --no-deps --no-build --pull never github-egress-proxy \
    || fail 'github-egress-proxy startup failed'
  wait_service_ready quarangate github-egress-proxy 60 \
    || fail 'github-egress-proxy did not become ready within 60s'
  RECOVERY_STATE='GITHUB_EGRESS_READY'
  log "RECOVERY_STATE=$RECOVERY_STATE"

  log "Stage 4b: starting GitHub broker..."
  "${QG[@]}" up -d --no-deps --no-build --pull never github-broker \
    || fail 'github-broker startup failed'
  wait_service_ready quarangate github-broker 60 \
    || fail 'github-broker did not become ready within 60s'
  RECOVERY_STATE='GITHUB_BROKER_READY'
  log "RECOVERY_STATE=$RECOVERY_STATE"
  printf 'GITHUB_EGRESS_READY=YES GITHUB_BROKER_READY=YES\n'
else
  log "Stage 4: GitHub not configured — skipping"
  printf 'GITHUB_RECOVERY=SKIPPED_NOT_CONFIGURED\n'
fi


# ---------------------------------------------------------------------------
# SECTION 12 — PRODUCT SMOKE (Section 17 of spec)
# ---------------------------------------------------------------------------

log "=== PRODUCT SMOKE ==="

# 12a. Verify live image identities match exactly what was started
assert_live_image() {
  local service="$1" expected_id="$2"
  mapfile -t ids < <(service_ids quarangate "$service")
  [[ ${#ids[@]} -eq 1 ]] || fail "expected exactly one $service container, found ${#ids[@]}"
  local live_id
  live_id="$(docker inspect "${ids[0]}" --format '{{.Image}}')"
  [[ "$live_id" == "$expected_id" ]] \
    || fail "live image identity mismatch for $service: expected=$expected_id actual=$live_id"
}
assert_live_image docker-authority "$PRIMARY_IMAGE_ID"
assert_live_image executor          "$PRIMARY_IMAGE_ID"
assert_live_image gateway           "$PRIMARY_IMAGE_ID"
log "LIVE_IMAGE_IDENTITIES=VERIFIED"

# 12b. Raw Docker socket authority — only docker-authority may hold it
authority_cid="$(service_ids quarangate docker-authority | head -1)"
executor_cid="$(service_ids quarangate executor | head -1)"
gateway_cid="$(service_ids quarangate gateway | head -1)"
[[ -n "$authority_cid" && -n "$executor_cid" && -n "$gateway_cid" ]] \
  || fail 'could not resolve all primary service container IDs'

authority_mounts="$(docker inspect "$authority_cid" --format '{{json .Mounts}}')"
executor_mounts="$(docker inspect "$executor_cid"   --format '{{json .Mounts}}')"
gateway_mounts="$(docker inspect  "$gateway_cid"    --format '{{json .Mounts}}')"

printf '%s\n' "$authority_mounts" | grep -q '/var/run/docker.sock' \
  || fail 'SOCKET_AUTHORITY: docker-authority is missing Docker socket'
printf '%s\n' "$executor_mounts"  | grep -q '/var/run/docker.sock' \
  && fail 'SOCKET_AUTHORITY: executor has raw Docker socket — hard denied'
printf '%s\n' "$gateway_mounts"   | grep -q '/var/run/docker.sock' \
  && fail 'SOCKET_AUTHORITY: gateway has raw Docker socket — hard denied'

# docker-authority must not be published on any host port
authority_ports="$(docker inspect "$authority_cid" --format '{{json .HostConfig.PortBindings}}')"
[[ "$authority_ports" == 'null' || "$authority_ports" == '{}' ]] \
  || fail 'SOCKET_AUTHORITY: docker-authority unexpectedly publishes host ports'
log "SOCKET_AUTHORITY=VERIFIED docker-authority sole holder"

# 12c. Gateway loopback-only
gateway_ports="$(docker inspect "$gateway_cid" --format '{{json .HostConfig.PortBindings}}')"
printf '%s\n' "$gateway_ports" | grep -q '127.0.0.1' \
  || fail 'gateway is not loopback-bound'
printf '%s\n' "$gateway_ports" | grep -Eq '"HostIp":"(0\.0\.0\.0|::|)"' \
  && fail 'gateway has wildcard/public host binding'
log "GATEWAY_LOOPBACK=VERIFIED"

# 12d. Executor unpublished
executor_ports="$(docker inspect "$executor_cid" --format '{{json .HostConfig.PortBindings}}')"
[[ "$executor_ports" == 'null' || "$executor_ports" == '{}' ]] \
  || fail 'executor unexpectedly publishes host ports'
log "EXECUTOR_UNPUBLISHED=VERIFIED"

# 12e. DB schema must still be 9 after all services running
POST_GATEWAY_SCHEMA_VERIFY="$(docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 1000:1000 \
  --mount type=volume,src=mcp-bridge-jobs,dst=/source,readonly \
  --mount "type=bind,src=$snapshot_dir,dst=/snapshot" \
  "$PRIMARY_IMAGE_ID" node /app/dist/operations/sh06JobDbRecovery.js \
  snapshot /source/agents.db /snapshot/agents.db.final /snapshot/manifest.final.json \
  2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("userVersion","?"))')" \
  2>/dev/null || POST_GATEWAY_SCHEMA_VERIFY="probe_failed"
rm -f "$snapshot_dir/agents.db.final" "$snapshot_dir/manifest.final.json" 2>/dev/null || true

if [[ "$POST_GATEWAY_SCHEMA_VERIFY" == "probe_failed" ]]; then
  fail 'SCHEMA_MUTATION_DETECTED: post-gateway schema proof unavailable'
elif [[ "$POST_GATEWAY_SCHEMA_VERIFY" != 9 ]]; then
  fail "SCHEMA_MUTATION_DETECTED: DB schema=$POST_GATEWAY_SCHEMA_VERIFY after gateway startup (expected 9)"
fi
log "DB_SCHEMA_AFTER_GATEWAY=${POST_GATEWAY_SCHEMA_VERIFY:-9}"

# 12f. Ollama identity preserved
if [[ -n "$OLLAMA_IMAGE_ID" ]]; then
  mapfile -t live_ollama_ids < <(service_ids quarangate ollama)
  if [[ ${#live_ollama_ids[@]} -eq 1 ]]; then
    live_ollama_img="$(docker inspect "${live_ollama_ids[0]}" --format '{{.Image}}')"
    [[ "$live_ollama_img" == "$OLLAMA_IMAGE_ID" ]] \
      || fail "OLLAMA_IDENTITY_CHANGED: baseline=$OLLAMA_IMAGE_ID live=$live_ollama_img"
    log "OLLAMA_IDENTITY=PRESERVED"
  fi
fi

# 12g. projects-work identity preserved
if [[ -n "$PROJECTS_WORK_IMAGE_ID" ]]; then
  mapfile -t live_pw_ids < <(docker ps -a \
    --filter label=com.docker.compose.project=projects-work \
    --filter label=com.docker.compose.service=work --format '{{.ID}}' 2>/dev/null || true)
  if [[ ${#live_pw_ids[@]} -eq 1 ]]; then
    live_pw_img="$(docker inspect "${live_pw_ids[0]}" --format '{{.Image}}')"
    [[ "$live_pw_img" == "$PROJECTS_WORK_IMAGE_ID" ]] \
      || fail "PROJECTS_WORK_IDENTITY_CHANGED: baseline=$PROJECTS_WORK_IMAGE_ID live=$live_pw_img"
    log "PROJECTS_WORK_IDENTITY=PRESERVED"
  fi
fi

# 12h. GitHub topology (if expected)
if [[ "$github_expected" == 1 ]]; then
  mapfile -t live_broker_ids < <(service_ids quarangate github-broker)
  mapfile -t live_proxy_ids  < <(service_ids quarangate github-egress-proxy)
  [[ ${#live_broker_ids[@]} -eq 1 ]] || fail 'expected exactly one github-broker container'
  [[ ${#live_proxy_ids[@]}  -eq 1 ]] || fail 'expected exactly one github-egress-proxy container'
  broker_ports="$(docker inspect "${live_broker_ids[0]}" --format '{{json .HostConfig.PortBindings}}')"
  proxy_ports="$(docker inspect  "${live_proxy_ids[0]}"  --format '{{json .HostConfig.PortBindings}}')"
  [[ "$broker_ports" == 'null' || "$broker_ports" == '{}' ]] \
    || fail 'github-broker unexpectedly publishes host ports'
  [[ "$proxy_ports"  == 'null' || "$proxy_ports"  == '{}' ]] \
    || fail 'github-egress-proxy unexpectedly publishes host ports'
  log "GITHUB_TOPOLOGY=VERIFIED"
fi

# 12i. Console/MCP smoke — unauthenticated request must be denied
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8787}"
console_status="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 \
  "${GATEWAY_URL}/readyz" 2>/dev/null || echo '000')"
[[ "$console_status" == 200 ]] \
  || fail "CONSOLE_SMOKE_FAIL: gateway /readyz returned $console_status (expected 200)"
log "CONSOLE_READYZ=PASS HTTP_STATUS=$console_status"

# Unauthenticated MCP must be rejected
mcp_unauth_status="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  "${GATEWAY_URL}/mcp" 2>/dev/null || echo '000')"
[[ "$mcp_unauth_status" == 401 || "$mcp_unauth_status" == 403 ]] \
  || fail "NEGATIVE_AUTH_SMOKE_FAIL: unauthenticated MCP returned $mcp_unauth_status (expected 401 or 403)"
log "NEGATIVE_AUTH_SMOKE=PASS HTTP_STATUS=$mcp_unauth_status"

RECOVERY_STATE='PRODUCT_SMOKE_PASS'
log "RECOVERY_STATE=$RECOVERY_STATE"
printf 'PRODUCT_SMOKE_PASS=YES\n'

# 12j. Remote-owner infra-acceptance (reuse accepted R2 script)
GATEWAY_IMAGE="$NEW_GATEWAY_IMAGE" \
DOCKER_AUTHORITY_IMAGE="$NEW_DOCKER_AUTHORITY_IMAGE" \
EXECUTOR_IMAGE="$NEW_EXECUTOR_IMAGE" \
QUARANGATE_RUNTIME_ROOT="$MAIN_ROOT" \
QUARANGATE_RUNTIME_ENV="$RUNTIME_ENV" \
  "$REPO_ROOT/scripts/remote-owner-infra-acceptance.sh" \
  || fail 'remote-owner infra-acceptance FAILED'
log "INFRA_ACCEPTANCE=PASS"

# ---------------------------------------------------------------------------
# SECTION 13 — RUNTIME CONFIG COMMIT (Section 11 token persistence)
# Atomically persist final .env only after all gates pass.
# ---------------------------------------------------------------------------

log "=== RUNTIME CONFIG COMMIT ==="

# Resolve final Ollama image selector (tag or digest)
FINAL_OLLAMA_IMAGE=''
if [[ "$ollama_expected" == 1 ]]; then
  FINAL_OLLAMA_IMAGE="$RUNTIME_OLLAMA_IMAGE"
fi

persist_runtime_config \
  "$NEW_GATEWAY_IMAGE" "$PRIMARY_IMAGE_ID" \
  "$NEW_DOCKER_AUTHORITY_IMAGE" "$PRIMARY_IMAGE_ID" \
  "$NEW_EXECUTOR_IMAGE" "$PRIMARY_IMAGE_ID" \
  "$FALLBACK_EXECUTOR_IMAGE" "$FALLBACK_IMAGE_ID"
verify_runtime_config \
  "$NEW_GATEWAY_IMAGE" "$PRIMARY_IMAGE_ID" \
  "$NEW_DOCKER_AUTHORITY_IMAGE" "$PRIMARY_IMAGE_ID" \
  "$NEW_EXECUTOR_IMAGE" "$PRIMARY_IMAGE_ID" \
  "$FALLBACK_EXECUTOR_IMAGE" "$FALLBACK_IMAGE_ID"
log "RUNTIME_CONFIG_COMMITTED_AND_VERIFIED"

RECOVERY_STATE='RUNTIME_CONFIG_COMMITTED'
log "RECOVERY_STATE=$RECOVERY_STATE"

# Disarm rollback — success path
trap - EXIT

# Clean up secret material explicitly on success
unset DOCKER_AUTHORITY_TOKEN
unset DOCKER_AUTHORITY_TOKEN_VALUE
unset INTERNAL_TOKEN_VALUE
rm -f "$env_backup"
rm -rf "$snapshot_parent_root" 2>/dev/null || true

RECOVERY_STATE='RECOVERY_ACCEPTED'
log "RECOVERY_STATE=$RECOVERY_STATE"

printf 'FORWARD_RECOVERY=PASS\n'
printf 'RECOVERY_ACCEPTED=YES\n'
printf 'DEPLOYED_REV=%s\n' "$REV"
printf 'PRIMARY_IMAGE_ID=%s\n' "$PRIMARY_IMAGE_ID"
printf 'FALLBACK_IMAGE_ID=%s\n' "$FALLBACK_IMAGE_ID"
printf 'LEGACY_EXECUTOR_START_ATTEMPTED=NO\n'
printf 'LIVE_RUNTIME_MUTATED=YES_RECOVERY_SERVICES_ONLY\n'
printf 'DOCKER_AUTHORITY_TOKEN_PERSISTED=YES SECRET_OUTPUT=NO\n'
printf 'DB_SCHEMA_FINAL=9\n'
printf 'NEXT_SAFE_STEP=Independent read-only review of this recovery execution evidence\n'
