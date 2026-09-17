# QuaranGate Operations

This document is the operator runbook for QuaranGate. It focuses on actions that change or validate the running system: configuration, builds, deployment, health, credentials, target checks, evidence, ingress, recovery and troubleshooting.

QuaranGate is intentionally conservative about operational authority. A successful source build is not a deployment. A successful agent job is not an apply. A running process is not necessarily ready. Those distinctions are part of the product, not ceremony around it.

> [!IMPORTANT]
> Raw `/var/run/docker.sock` authority is confined to the unpublished `docker-authority` broker. The gateway and executor do not receive the socket. The executor reaches the broker only over the private internal network with a separate `DOCKER_AUTHORITY_TOKEN` and named, independently validated operations. Never publish the broker or executor and never mount the Docker socket into the gateway, executor, target, or agent runner.

> [!IMPORTANT]
> Do not use a SHA or test count copied from this runbook as current release truth. QuaranGate advances through immutable acceptance receipts; establish the live branch/HEAD/status mechanically and use the matching audit/control receipt for that exact revision. Historical SHAs and test counts below are retained only where explicitly labeled as historical evidence.

---

## Contents

- [Operational model](#operational-model)
- [Supported operator environment](#supported-operator-environment)
- [Repository and shell](#repository-and-shell)
- [First-time configuration](#first-time-configuration)
- [Secrets and sensitive configuration](#secrets-and-sensitive-configuration)
- [Build reproducibility](#build-reproducibility)
- [Starting and stopping QuaranGate](#starting-and-stopping-quarangate)
- [Health and readiness](#health-and-readiness)
- [Image provenance](#image-provenance)
- [Runtime identity and compatibility](#runtime-identity-and-compatibility)
- [Client credentials](#client-credentials)
- [Agent backend configuration](#agent-backend-configuration)
- [Targets](#targets)
- [Logs and audit evidence](#logs-and-audit-evidence)
- [Remote ingress](#remote-ingress)
- [Testing and acceptance](#testing-and-acceptance)
- [Backup and recovery](#backup-and-recovery)
- [Troubleshooting](#troubleshooting)
- [Operational rules](#operational-rules)

## Historical closeout gates — 2026-09-06

This section preserves the GitHub/MCP side-quest state as it existed on 2026-09-06. It is historical evidence, not current operational authority:

1. At this checkpoint, `QuaranHUB` on `JustAGameZA` used **Selected repositories** and the then-current broker rejected that mode. P4 removes that obsolete all-only restriction without adding App permissions; current source discovery is constrained to the repositories GitHub grants to the installation.
2. The clean candidate overlaps protected uncommitted owner work at `scripts/remote-owner-start.sh`; do not fast-forward/cherry-pick over that path until it is deliberately reconciled.

The statuses-only repair is live: `github_checks` succeeds without GitHub Checks permission, reads Commit statuses, and returns `checkRuns: []` for compatibility.

The rebuilt MCP target images use the hardened Node 24 Bookworm toolchain and preserve the read-only/no-Docker-socket boundaries. Current accepted image evidence from the closeout is:

```text
mcp-bridge-review:latest             sha256:48574f4ea71693dc26b219f5532bc48de7f7ff32d45c3eb46d5b50f36018fd29
assistant-environment-review:latest  sha256:e189e748ea13046f8734e62ce53b871f40a901809279c693aa58a5e6048f33aa
assistant-environment-work:latest    sha256:aae07d9f44652e782c5c0051856d7180850faf32d70f0fc19e5230e388d02872
```

---

# Operational model

QuaranGate has three operationally distinct areas:

```text
PUBLIC CONTROL PLANE
MCP client
   |
   v
Gateway
authentication / OAuth / scopes / audit
NO Docker socket

PRIVATE EXECUTION PLANE
Gateway
   |
   v
Executor
trusted config / job store / policy enforcement
NO raw Docker socket / NO published port
   |
   | distinct DOCKER_AUTHORITY_TOKEN + named operations
   v
Docker-authority broker
ONLY QuaranGate raw Docker-socket holder / NO published port

WORK EXECUTION
Docker-authority broker, only after executor policy + broker policy
   +--> authorized target containers
   +--> isolated agent runners
   +--> dedicated apply helpers
```

The most important operating rule is:

> **Do not use one plane to compensate for a failure in another.**

Examples:

- do not give the gateway a Docker socket because the executor is inconvenient;
- do not mount a live project read-write into an agent runner because sandbox apply is inconvenient;
- do not expose the executor publicly because a client cannot reach it directly;
- do not weaken a failed build check merely to create an image;
- do not treat liveness as readiness.

---

# Supported operator environment

## Current strongest evidence

The project has been developed and most deeply exercised on:

```text
Windows 11
  -> WSL2 Ubuntu 24.04
  -> Docker Desktop / Linux containers
```

This is the current verified operator environment.

## Linux

The architecture is Linux-container-native and is **design-compatible with a normal Linux Docker host**. Native-Linux qualification should still be recorded before the project claims that every installation path has been verified there.

## macOS

The architecture is **design-compatible with Docker Desktop on macOS**, including the current named BuildKit-context direction for offline npm artifacts. macOS has not been accepted as a production platform yet. Apple Silicon also requires the correct pre-provisioned Linux/arm64 image and dependency artifacts.

## Native Windows without WSL2

Not currently claimed as verified.

---

# Repository and shell

Canonical project path on the current workstation:

```text
/home/herman/projects/QuaranGate
```

Run project commands from that repository unless a command explicitly says otherwise.

Before any mutation, establish the real state:

```bash
cd /home/herman/projects/QuaranGate

git rev-parse HEAD
git branch --show-current
git status --short
git diff --cached --name-only
```

For governed project work, exact Git state is evidence. Do not continue from a remembered SHA when the live repository says something else.

---

# First-time configuration

QuaranGate intentionally has no meaningful "run one command and trust the defaults" installation mode.

At minimum the operator must create live configuration from the committed examples:

```bash
cp .env.example .env
cp config/bridge.example.yaml  config/bridge.yaml
cp config/clients.example.yaml config/clients.yaml
```

The Agent Control Plane is optional. To enable it, create and review:

```text
config/agents.yaml
```

from the supplied example/configuration contract.

Live configuration is gitignored. The repository contains examples and schemas; the real deployment contains principals, host paths, image selections and other local decisions.

## `.env`

Important values include:

```text
INTERNAL_TOKEN
DOCKER_AUTHORITY_TOKEN
DOCKER_GID
BRIDGE_PUBLIC_URL
GIT_REVISION
GATEWAY_IMAGE
EXECUTOR_IMAGE
agent runtime image references / secret-file paths when Agent Control is enabled
```

N1 introduces a build-only `QUARANGATE_NPM_BUNDLE_PATH`. It is required for a valid source build but deliberately not required for ordinary runtime Compose operations such as `ps`, `logs` or `restart`.

Generate the gateway-to-executor token and the Docker-authority token independently with a cryptographically secure random source:

```bash
openssl rand -base64 32   # INTERNAL_TOKEN
openssl rand -base64 32   # DOCKER_AUTHORITY_TOKEN — generate separately
```

The two values MUST differ. QuaranGate refuses Docker-authority calls when the executor sees credential reuse; this prevents compromise of the ordinary internal service token from automatically granting the broker credential as well.

Determine the Docker socket group visible on the Linux/WSL host:

```bash
stat -c %g /var/run/docker.sock
```

Do not paste secret values into chat transcripts, tickets or committed files.

---

# Secrets and sensitive configuration

QuaranGate separates **references to secrets** from **secret values** wherever practical.

## Client API keys

Generate one principal key per client rather than sharing one browser/IDE identity:

```bash
npm run gen-key -- <client-id>
```

The raw key is printed once. Only its hash belongs in `config/clients.yaml`.

If a raw key appears in a chat transcript or other uncontrolled record, treat it as exposed and rotate it.

## Kiro automation key

The Kiro automation key is stored in a host file and mounted as a Compose secret into the executor. It must not be placed in source, normal Compose environment variables, MCP arguments or logs.

Current preferred host path:

```text
/home/herman/.config/quarangate/kiro-api-key
```

The legacy path remains a compatibility fallback where the accepted migration code still supports it:

```text
/home/herman/.config/mcp-ide-bridge/kiro-api-key
```

Do not keep two uncontrolled live copies of the same credential merely for convenience.

## `docker compose config` warning

Compose can render environment values into its expanded configuration. Do not paste unfiltered output from:

```bash
docker compose config
```

into external logs or chats.

When validating image/config selections, filter for the exact non-secret fields you need.

---

# Build reproducibility

QuaranGate distinguishes three very different statements:

```text
1. The source compiles.
2. The image can be rebuilt on this machine with approved local inputs.
3. A different machine can reproduce the same build with pre-provisioned inputs.
```

They are not interchangeable.

## Accepted Tini boundary

Tini `0.19.0` is vendored under:

```text
third_party/tini/0.19.0/
```

Accepted binary SHA-256:

```text
1358f1be32dc2a0dd8084dbda675c3b3dde8352b519b7b8a65573262551ad0fc
```

Accepted license SHA-256:

```text
e5f46bca81266bdd511cf08018d66866870531794569c04f9b45f50dd23c28b0
```

The Dockerfile verifies the binary before using it as `/sbin/tini`.

### Why it is vendored

The previous Dockerfile installed Tini using Alpine package repositories during the image build. That meant a supposedly offline build could not start without external package access.

Vendoring the exact accepted binary removes that dependency and makes its provenance inspectable.

### What this does not mean

Vendoring Tini did **not**, by itself, prove the entire image could be rebuilt offline. The next blocker was npm dependency acquisition. That work is N1 and is intentionally a separate gate.

## N1 npm offline-build architecture — accepted

N1 separates dependency acquisition from the build that sees application source:

```text
CONTROLLED DEPENDENCY PREPARATION
package.json + package-lock.json + preparation tool
                 |
                 | bounded HTTPS to exact lock URLs
                 | no project source / Git / runtime config / credentials
                 v
verified external npm artifact bundle
                 |
                 | read-only BuildKit named context
                 v
REAL SOURCE BUILD
network = none
canonical package-lock.json
fresh ephemeral npm cache
npm ci --offline --ignore-scripts
```

Accepted checkpoint:

```text
18179696b3ef3ff2192805590027d2e1a43a43d4
build: add governed offline npm dependency bundle
```

Accepted dependency identity:

```text
package-lock SHA-256:
31688b0a46cb5051e069ff049bbafd34752ace10dfb9dac3a60c9a3fef5258e5

lock entries:           221
unique artifact bodies: 220
SHA-512 coverage:       221 / 221
allowed dependency host:
registry.npmjs.org:443

bundle manifest SHA-256:
43eb077e7f23c23014882738508b624dd738cc0315d5ea8730392e15e6aec788
```

Two lock paths reference the same `content-type@2.0.0` tarball with identical URL and integrity, which is why 221 lock entries map to 220 artifact bodies.

### Choose the artifact root

The current workstation uses an operator-owned location outside the repository:

```bash
export QUARANGATE_NPM_ARTIFACT_ROOT="$HOME/.local/share/quarangate/build-artifacts/npm"
```

This is an operator choice, not a Dockerfile constant. Another Linux/WSL/macOS host may use a different host path.

### Controlled preparation — networked but source-free

Preparation requires the exact digest-pinned base `node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81` to already exist locally. The tool intentionally uses `--pull=never`; it will stop rather than silently pulling or substituting a tag target.

Check first:

```bash
docker image inspect node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81 >/dev/null
```

If this fails, decide how the approved base image will be provisioned. In an online bootstrap that may be an explicit operator-controlled image acquisition. In an offline installation it must be imported/pre-provisioned from trusted media or an approved local registry/cache. Do not hide that acquisition inside the source build.

Prepare the dependency bundle:

```bash
node scripts/npm-offline-bundle.mjs prepare \
  --artifact-root "$QUARANGATE_NPM_ARTIFACT_ROOT"
```

The preparation container receives only:

```text
package.json                       read-only
package-lock.json                  read-only
scripts/npm-offline-bundle.mjs     read-only
approved artifact root             read-write
```

It receives no repository-root mount, `.git`, source tree, live config, npmrc, Docker config, secret mount or Docker socket. It validates the complete lock before the first download, then requests the exact lockfile tarball URLs from `registry.npmjs.org` and rejects redirects. Every accepted artifact is checked against the lockfile SHA-512.

> [!IMPORTANT]
> The registry restriction is currently enforced by application URL policy plus SHA-512 verification. The preparation container itself uses Docker bridge networking; there is not yet a kernel/iptables host allowlist for that container. Treat this as a known defense-in-depth limitation, not as an air-gap claim.

### Resolve and verify the exact bundle

```bash
export QUARANGATE_NPM_BUNDLE_PATH="$(node scripts/npm-offline-bundle.mjs print-path \
  --artifact-root "$QUARANGATE_NPM_ARTIFACT_ROOT")"

node scripts/npm-offline-bundle.mjs verify \
  --bundle "$QUARANGATE_NPM_BUNDLE_PATH" \
  --descriptor build/npm-dependencies.json
```

Verification checks the canonical lock hash, deterministic manifest, descriptor binding, exact file allowlist, every artifact filename/size/SHA-512, and rejects unexpected files/symlinks/hardlinks.

### Build QuaranGate

Set provenance and image references according to the deployment gate, then build:

```bash
export GIT_REVISION="$(git rev-parse HEAD)"
export GATEWAY_IMAGE="quarangate:gateway-$GIT_REVISION"
export DOCKER_AUTHORITY_IMAGE="quarangate:docker-authority-$GIT_REVISION"
export EXECUTOR_IMAGE="quarangate:executor-$GIT_REVISION"
export QUARANGATE_NPM_BUNDLE_PATH

docker compose build gateway
docker tag "$GATEWAY_IMAGE" "$DOCKER_AUTHORITY_IMAGE"
docker tag "$GATEWAY_IMAGE" "$EXECUTOR_IMAGE"
```

Both gateway and executor build definitions use the same named `npm_deps` context, build network `none`, and `pull: false`.

Inside the build stage QuaranGate:

1. verifies the bundle against the canonical lock and committed descriptor;
2. copies re-verified tarball bytes into a private tmpfs directory;
3. seeds a fresh ephemeral npm cache from those local tarballs;
4. runs `npm ci --offline --ignore-scripts`;
5. copies the application source only after dependency installation;
6. compiles TypeScript;
7. prunes development dependencies with network disabled and scripts ignored;
8. copies only runtime `node_modules`, `dist` and `package.json` into the runtime stage.

No dependency tarball bundle or temporary npm cache is retained in the final runtime image.

### Missing bundle behavior

`compose.yaml` deliberately defaults the named `npm_deps` context to `./build` when `QUARANGATE_NPM_BUNDLE_PATH` is unset.

That is a **sentinel**, not a usable dependency bundle.

This design allows ordinary commands such as:

```bash
docker compose config --services
docker compose ps
docker compose logs
docker compose restart gateway
```

to parse/run without requiring a build artifact path. If someone actually tries to build without configuring a valid bundle, the Dockerfile verifier rejects `./build` before npm runs. The acceptance suite includes this regression check.

### Full N1 acceptance

Run the bounded acceptance driver against an already-prepared bundle:

```bash
node scripts/accept-npm-offline-build.mjs \
  --bundle "$QUARANGATE_NPM_BUNDLE_PATH"
```

The accepted N1 run proved:

```text
TypeScript:                 PASS
unit test files:            44 / 44 PASS
unit tests:                 1693 / 1693 PASS
source build:               PASS
npm ci offline:             PASS
npm lifecycle scripts:      disabled
Docker no-cache build:      PASS
Docker build network:       none
Docker pull:                false
runtime dependency bundle:  absent
runtime npm cache:           absent
live stack mutation:         none
```

The acceptance driver creates/removes only bounded temporary acceptance resources; it does not deploy the resulting image into the live QuaranGate stack.

## Base-image governance

SH-06 binds the main source build and npm preparation helper to the exact reviewed base:

```text
node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
```

All tracked Dockerfiles now pin external `FROM` inputs by SHA-256 digest, and `security:invariants` fails if a later tag-only external base is introduced. The source build remains offline (`build.network=none`, `pull: false`) and refuses if the approved digest is not already local.

This proves the **base-image identity selected by source**. It does not prove an empty machine has that artifact, that owner-host provisioning has already occurred, or that every downstream build step is bit-for-bit reproducible across platforms. Those remain deployment/qualification evidence, not assumptions.

## Dependency update workflow

A legitimate dependency change intentionally invalidates the old bundle. Do not “fix” that failure by pointing the build at a broader npm cache.

The governed flow is:

```text
reviewed package.json / package-lock.json change
        ↓
new package-lock SHA-256
        ↓
old descriptor/bundle no longer match
        ↓
review package/version/source/install-script changes
        ↓
prepare new source-free bundle
        ↓
verify every artifact against the new lock SHA-512
        ↓
generate/review new build/npm-dependencies.json descriptor
        ↓
run full offline acceptance
        ↓
separate commit/promotion decision
```

Useful commands after the dependency/lock change has been separately authorized:

```bash
node scripts/npm-offline-bundle.mjs prepare \
  --artifact-root "$QUARANGATE_NPM_ARTIFACT_ROOT"

export QUARANGATE_NPM_BUNDLE_PATH="$(node scripts/npm-offline-bundle.mjs print-path \
  --artifact-root "$QUARANGATE_NPM_ARTIFACT_ROOT")"

node scripts/npm-offline-bundle.mjs descriptor \
  --bundle "$QUARANGATE_NPM_BUNDLE_PATH" \
  > /tmp/npm-dependencies.json
```

Review `/tmp/npm-dependencies.json` before replacing the tracked `build/npm-dependencies.json`. Do not redirect generated metadata straight into the tracked file before review. Then run `verify`, typecheck/tests/build and the complete offline acceptance driver.

A lock change may also introduce a new registry host, Git/file dependency, non-SHA512 integrity form or required install script. The current preparation policy should fail closed in those cases; changing that policy is a separate security decision, not an automatic dependency-update step.

---

# Starting and stopping QuaranGate

Runtime commands should remain usable independently of whether a new source build is being prepared.

Typical operations are:

```bash
docker compose up -d
docker compose ps
docker compose logs -f gateway
docker compose logs -f executor
docker compose restart gateway
docker compose restart executor
docker compose down
```

Do not use `docker compose down -v` casually. Volume deletion has a different risk profile from container recreation.

## Disposable demo target

The repository includes a disposable target for integration testing:

```bash
docker compose -f test-target/compose.yaml up -d --build
docker compose -f test-target/compose.yaml down -v
```

Keep disposable test-stack operations separate from the live QuaranGate stack.

---

# Health and readiness

QuaranGate deliberately separates liveness from readiness.

## Liveness

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

`/healthz` answers the narrow question:

> Is the gateway process alive?

It should not depend on client configuration or executor reachability.

## Readiness

```bash
curl -fsS http://127.0.0.1:8787/readyz
```

`/readyz` answers:

> Is the gateway actually in a state where it can serve authenticated QuaranGate work?

Readiness fails closed if the clients configuration is unavailable/invalid or the executor cannot be reached.

This distinction prevents a process with an empty `/config` mount from being reported as operational merely because Node is still running.

## Docker service health

```bash
docker compose ps
```

The gateway healthcheck uses readiness rather than simple liveness. A configuration failure should surface as unhealthy while leaving the process alive long enough to diagnose.

---

# Image provenance

Production candidates must be attributable to the exact reviewed Git state.

Current naming convention:

```text
quarangate:gateway-<full-reviewed-sha>
quarangate:docker-authority-<full-reviewed-sha>
quarangate:executor-<full-reviewed-sha>
```

All three service tags intentionally point to the same reviewed QuaranGate artifact. `remote-owner-deploy-candidate.sh` persists each service-specific tag **and** its exact Docker `sha256:` image ID. `remote-owner-start.sh` refuses recovery if any tag has been retargeted, if any persisted image ID is absent/malformed, or if the live container does not match both the expected service tag and immutable image ID.

`compose.yaml` has no `quarangate:latest` or unset production image fallback. Gateway, Docker-authority and executor image selections are mandatory and all use `pull_policy: never`.

Build candidates carry OCI labels including:

```text
org.opencontainers.image.revision=<exact commit SHA>
org.opencontainers.image.source=https://github.com/Herman940306/QuaranGate
```

Verify the labels on the actual image before deployment.

Do not use `docker commit` of a running container as a production rollback artifact.

---

# Runtime identity and compatibility

The canonical product identity is QuaranGate.

Most live runtime identity migration is already designed/implemented around compatibility rather than deleting history.

Important retained compatibility identifiers include:

```text
mcp-bridge-jobs
```

for durable agent job/evidence storage and existing target Compose project names such as the review/test targets where those remain part of the compatibility contract.

Current resource ownership uses the QuaranGate namespace while reconciliation code continues to understand approved legacy namespaces long enough for historical resources to age out safely.

Do not rename persistent Docker resources simply to remove old text from `docker volume ls`. A compatibility artifact is not the same thing as the product's public identity.

See the Master PRD identity-migration record for the decision history.

---

# Client credentials

## Generate / rotate

```bash
npm run gen-key -- <client-id>
```

Replace the client's stored hash in `config/clients.yaml`, then reload/restart the gateway according to the accepted config-reload procedure.

## Disable / revoke

Use the repository's client-revocation tooling rather than deleting unrelated state.

```bash
npm run revoke-key -- <client-id>
```

Use the explicit removal mode only when deleting the principal is the intended action.

## OAuth clients

Browser clients that require OAuth still resolve to the same QuaranGate principal/authorization model as static API keys.

OAuth state is stored on the gateway data volume. It is not the agent job database.

---

# Agent backend configuration

Agent Control is optional and deny-by-default.

Without a trusted `config/agents.yaml`, the direct MCP target surface remains available but governed agent tools fail closed as unavailable.

Trusted agent configuration controls:

```text
logical projects
host-side project resolution
allowed backends
profiles
resource policies
network policy
runner images
retention
```

These values are executor-owned policy. They are not caller inputs.

## Kiro

Kiro automation uses a dedicated automation credential and isolated runner state. Do not reuse a normal personal interactive session as implicit machine authority.

## Ollama O1

The O1 source/model are qualified and the current image is deployed. Post-enable
production acceptance remains a separate incomplete gate. Do not interpret a
healthy deployment as accepted repository-inspection behavior.

Current workstation's deployed O1 profile:

```text
model=qwen3.5:4b-q4_K_M
model_id=2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd
image=ollama/ollama:0.32.3
image_id=sha256:ec24bcaa2a810eb74171ce7c517813ef4821ed678988845e8d76cf62467036d4
OLLAMA_CONTEXT_LENGTH=65536
OLLAMA_GPU_DEVICE=0
OLLAMA_CPU_LIMIT=2.0
OLLAMA_MEM_LIMIT=3g
OLLAMA_PIDS_LIMIT=256
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_NO_CLOUD=1
```

GPU `0` is this host's GTX 1080 Ti. C2 at context `65536` recorded 100% GPU,
VRAM peak `7684 MiB`, approximately `3580 MiB` GPU headroom, approximately
`1520 MiB` container RAM peak, approximately `11690 MiB` host available RAM,
approximately `102.08%` CPU peak, and approximately `47.60 tok/s` generation.
Portable Compose requires explicit context/GPU/CPU/RAM/PID inputs with no host
defaults. Changing them requires deployment requalification.

O1-C3 historically accepted these exact settings in a disposable hardened Ollama `0.32.3`
canary: read-only root, model store read-only, ephemeral Ollama home/temp,
GPU device `0`, `100% GPU`, context `65536`, successful local inference, no OOM,
no restart, no pull, and positive `Ollama cloud disabled: true` log evidence.
Canary resources were removed afterward. Production deployment occurred later.

Current deployment record:

```text
previous deployment revision:   199c567008d9c8fe047235332ce79dd6a006170b
previous production image:      sha256:3df1d4f6b88d442e363d67ff2c75582c37805482fce3a85c3acf44d85f0d23d5
R1 remediated revision:          92b39ec98c423413c61880cde75b3f9ca4d21c45
R1 production image:             sha256:6f56657ddfd87f145de900c52d18fc49bf8135ee777c42650dd28de341903be9
current deployed revision:       a41c4bc6d568dd00bd323d67c342c1f60f587dd6
current gateway image:           sha256:b117566a28030adcf13e41212443fc0d6a4cced3f09bc195104189227cda0c68
current executor image:          sha256:065b7f00433d7acb787ecad2f92f7d46ce63e047d775bd738b32c3dd1f2970f7
current acceptance:              PRODUCTION DEPLOYED / POST-ENABLE ACCEPTANCE INCOMPLETE
```

R2 deployed accepted revision `a41c4bc6d568dd00bd323d67c342c1f60f587dd6`
on 2026-09-05. Exact committed-HEAD staging, plan, review and all refusal gates
passed, but audit reliability was 1/3: two successfully completed jobs returned
zero-byte summaries. O1 therefore remains not production-accepted.

The first production gate recorded 5/6 checks and triggered R1 because
`agent_result` returned generic telemetry instead of the model's final answer.
R1 fixed result delivery and preserved the public 16384-character summary bound.
R1's live matrix then exposed the empty-workspace defect; R2 closed that staging
lifecycle defect and exposed the separate successful-empty-result contract hole.
Do not close O1 or compensate with retries, a model change, fallback, wider
authority, or a manually manufactured summary.

**R3 source candidate (uncommitted, not deployed):** the backend now refuses
empty or whitespace-only terminal assistant content as an agent failure, records
only bounded content/thinking byte counts plus tool-call and completion metadata,
and never publishes raw thinking as the public answer. A streamed response that
ends without a terminal `done=true` signal also fails closed. No inference knob,
model, provider, resource, network, fallback, or public-authority setting changed.

Before an R3 qualification commit, the normal desktop host must remove any
remaining `/tmp/quarangate-r3-*` temporary credential artifacts from the prior
integration attempt and rerun the focused O1 test, full main unit suite and live
integration suite. The confined review target passes typecheck and diff/static
checks but cannot run Vitest because its Alpine/musl dependency environment lacks
the matching Rollup optional native package. Do not install dependencies or alter
the lockfile to bypass that environment-only limitation. An immutable R3 image
must be built from an exact committed revision after explicit commit approval.
A8 remains blocked until the complete O1 live matrix passes.

### 2026-09-06 O1 live re-acceptance result and next candidate

The complete post-remediation re-acceptance attempt failed. Audit reliability was 0/3: two required audit jobs failed closed at the 10-turn limit and the third completed with an incorrect arithmetic interpretation of the inspected source (`48576` instead of `48 * 1024 = 49152`). Plan also hit the 10-turn ceiling; review incorrectly searched only for decimal `49152`. Implement refusal, sensitive-path refusal, and focused `read_file` / `list_files` / `literal_search` probes passed. Do not mark O1 accepted and do not replace the failed required runs with retries.

The next committed source candidate is `a1ec1fcff0255c4dccfec9a9607b4c0967227725`. It raises only the bounded O1 reasoning budget to 16 turns / 64 total tool calls (10 per turn) and adds shortest-evidence-path, stop-when-proven, and simple source-arithmetic guidance. The Ollama runtime remains single-parallel (`OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`) on this workstation. Build/deploy this exact committed source immutably before any new live qualification.

`quarangate-ollama-models` is the external persistent artifact store for the verified O1 model. Create and seed it through the separate controlled model-seeding operation before O1 deployment. Compose consumes this exact volume but does not create or own it; deployment must fail closed when it is absent.

Mount this artifact store read-only at `/model-store`; set
`OLLAMA_MODELS=/model-store/models`. `/root/.ollama` and `/tmp` are ephemeral
tmpfs. Persistent model storage must not receive Ollama-generated identity,
configuration or runtime state. `OLLAMA_NO_CLOUD=1` is mandatory; private Docker
networking remains a separate egress boundary.

O1 request envelopes are capped at `49152` UTF-8 bytes, including model,
messages, tool definitions and request JSON structure. Initial overflow fails
before Ollama invocation. Tool output that would overflow the next request is
withheld using bounded `CONTEXT_BUDGET_EXCEEDED` metadata. No arbitrary silent
truncation or model-driven budget increase is permitted.

O1 `read_file` therefore returns line windows rather than whole eligible files.
`path` alone remains valid and defaults to `startLine=1,maxLines=200`; operators
and qualification prompts may request positive integer `startLine` and
`maxLines` up to `400`. Total eligible file size remains `256 KiB`, while one
successful response exposes no more than `8192` bytes of complete file-content
lines and reports `nextStartLine` plus `eof`. Use `literal_search` to find a
target in a large file, then request the corresponding bounded window.

**Historical state:** Earlier pre-hardening Ollama startup created `id_ed25519`
and `id_ed25519.pub` in the retained volume; their contents were never read.

**Current state (O1-C4 complete, 2026-09-04):** Both legacy identity files were
removed through bounded offline sanitization. The persistent volume now contains
only `models/` at the top level, consistent with the model-artifact-only design.
The model manifest and all four blobs were verified byte-identical before and
after removal. The hardened disposable verification runtime confirmed it did not
recreate persistent identity files in the persistent store.

**Operational invariant:** The persistent model volume must contain only model
artifacts. Reappearance of top-level identity, configuration or runtime files
(such as `id_ed25519`, `id_ed25519.pub`, or similar Ollama-generated state) is
an integrity regression. Production runtime uses read-only `/model-store` and
ephemeral `/root/.ollama`; runtime must not write identity/config to the
persistent volume. If unexpected top-level non-model files appear, investigate
before enabling O1 or promoting to production.

Normal teardown, including `docker compose down -v`, must not delete this external volume. Explicit `docker volume rm quarangate-ollama-models` remains destructive and must never be part of routine teardown. Reseeding is also a separate controlled operation, not a deployment or teardown side effect.

### Persistent model-store ownership invariant

The destination volume `quarangate-ollama-models` is not a sandbox resource. Create it independently; do not use `ownershipLabels(...)`, sandbox/resource cleanup labels or any accepted current/legacy sandbox ownership marker. In particular, the destination volume must not carry:

```text
io.quarangate.managed=true
io.mcp-ide-bridge.managed=true
io.mcp-bridge.managed=true
```

These markers grant deletion authority over ephemeral QuaranGate agent/sandbox resources. Executor startup reconciliation is permitted to remove resources carrying them. Seed containers or temporary staging resources may use their own disposable cleanup identity when needed, but that identity must not be applied to the destination model volume.

Inspect destination labels both before and after seeding. This command prints labels only:

```bash
docker volume inspect quarangate-ollama-models --format '{{json .Labels}}'
```

An accepted result is `null`, empty, or benign persistent metadata. If any accepted QuaranGate current/legacy namespace reports `managed=true`, stop: do not start or restart the executor. Verification of model contents and verification of lifecycle identity are separate required gates.

---

# Targets

Callers address logical target IDs, never host paths or Docker IDs.

Operationally, target availability is the intersection of:

```text
container/config discovery
AND
principal authorization
```

Discovery alone does not grant access.

Before adding a real target, verify:

- exact Compose project/service identity;
- intended workspace path inside the container;
- desired RO/RW authority;
- principal allowlist;
- target has only the tools/runtime assumptions QuaranGate expects.

See `docs/architecture/TARGETS.md` for the complete target contract.

---

# Logs and audit evidence

Gateway and executor logs:

```bash
docker compose logs -f gateway
docker compose logs -f executor
```

QuaranGate audit evidence is intended to answer:

```text
who
asked for what
against which target/project/job
under which scope/profile
allowed or denied
how long it took
what terminal state resulted
```

It is not intended to become a raw repository/prompt/secret dump.

Do not paste large unredacted logs into external systems without reviewing them first.

---

# Remote ingress

The gateway binds to loopback by default:

```text
127.0.0.1:8787
```

That should remain true even when remote browser access is enabled through an external ingress layer.

The currently proven browser-ingress pattern is Tailscale Funnel terminating public HTTPS and forwarding to the loopback gateway.

The executor remains private and unpublished.

Before changing ingress, preserve these invariants:

```text
TLS for remote clients
exact BRIDGE_PUBLIC_URL origin (no path/query/fragment)
non-loopback BRIDGE_PUBLIC_URL uses HTTPS
raw Host must resolve to the configured public authority or exact gateway loopback authority
browser Origin, when present, must be an approved same deployment origin
X-Forwarded-Host / Forwarded never grant request authority
loopback-only gateway bind
no public executor port
no Docker socket in the gateway
OAuth metadata matches the public origin
```

Ingress configuration is host infrastructure. Agent workers must not receive authority to run `tailscale serve`, `tailscale funnel`, firewall or equivalent exposure-changing commands unless a future separately governed operations capability explicitly allows it.

---

# Testing and acceptance

Ordinary source validation:

```bash
npm run typecheck
npm test
npm run build
```

Do not maintain a moving "current baseline" SHA or test count in this runbook. Current acceptance belongs to the immutable audit/control receipt for the exact candidate under qualification. For chronology only, an earlier accepted checkpoint was:

```text
HISTORICAL HEAD: 92b39ec98c423413c61880cde75b3f9ca4d21c45
TypeScript: PASS
45 / 45 unit test files PASS
1786 / 1786 unit tests PASS
source build: PASS
full governed no-cache/network-none Docker acceptance with approved pre-provisioned inputs: PASS
```

The N1 checkpoint (`18179696`) likewise remains historical evidence at 44 files / 1693 tests. The preceding Tini-only checkpoint (`6129d3d`) remains historical evidence at 43 files / 1671 tests.

Integration, Docker, destructive apply and credentialed provider tests have additional prerequisites and authority boundaries. Do not run every test merely because it exists.

See `docs/testing/TEST_RESULTS.md` for point-in-time evidence and historical counts.

---

# Backup and recovery

## Gateway OAuth data

Gateway OAuth state is intentionally separate from durable agent-job evidence. The gateway data volume is lower-stakes and can be recreated under the approved identity migration policy, at the cost of client reauthorization.

## Agent job/evidence database

The physical `mcp-bridge-jobs` volume is intentionally retained because it contains durable SQLite job state, retained-resource metadata and quarantine/evidence relationships.

Treat it as persistent operational data.

Before any operation that could affect that volume:

1. establish exact current volume identity;
2. stop writers or otherwise reach a stable state;
3. take a verified backup;
4. record DB integrity/state evidence;
5. test the recovery path before deleting the old copy.

Do not rename/copy the job store merely for cosmetic identity cleanup.

## Quarantined projects

An `UNCERTAIN` apply means rollback could not be proven.

That is not a normal retry state.

Do not clear quarantine through ad-hoc database edits or by deleting evidence. Investigate and reconcile the real project state first, then use an explicitly designed recovery procedure.

---

# Troubleshooting

## Gateway is running but unhealthy

Check readiness first:

```bash
curl -i http://127.0.0.1:8787/readyz
docker compose logs gateway
```

Likely categories include:

- clients config missing/invalid;
- executor unreachable;
- deployment config drift.

Do not solve a readiness failure by changing the Docker healthcheck back to liveness.

## Executor is unreachable

Verify:

```text
executor container running
internal network intact
shared internal token consistent
no public-port workaround was introduced
```

Do not publish port `8990` to "see if it helps".

## Build fails while offline

First classify the failure:

```text
missing pre-provisioned base image
missing/invalid npm bundle
lock/descriptor mismatch
corrupt tarball
Tini hash mismatch
source compile/test failure
```

Do not turn networking back on inside the real source build as the first troubleshooting step.

## Tests fail because an optional native npm package is missing

The project has already encountered a stale local dependency environment where the repository source was valid but `node_modules` was incomplete for the current platform.

Classify dependency-environment failures separately from source failures. Do not edit source until the environment evidence says the source is the problem.

## Browser client cannot perform a destructive tool

A client may apply its own safety policy before a request reaches QuaranGate. Check gateway audit evidence before declaring the server broken.

---

# Operational rules

These rules summarize the runbook:

1. **Verify exact Git state before mutation.**
2. **Build evidence is not deployment authority.**
3. **Liveness is not readiness.**
4. **The gateway never receives the Docker socket.**
5. **The executor is never published.**
6. **Agent runners never receive host/Docker authority.**
7. **Dependency acquisition and source compilation are separate trust domains.**
8. **A lock/hash mismatch fails closed; do not regenerate silently.**
9. **Do not weaken a gate to make a candidate pass.**
10. **Historical evidence stays historical.**
11. **A model being local does not prove the IDE/build/runtime is private.**
12. **Only the exact reviewed artifact should be promoted.**

---

# Remote owner workstation operation

The remote-owner pattern is intended for an owner who leaves the workstation running and continues development from ChatGPT or another authenticated remote MCP client.

The trust path is:

```text
remote authenticated client
  -> approved HTTPS ingress
  -> loopback-bound QuaranGate gateway
  -> private executor
  -> configured targets / governed agents
```

The unpublished `docker-authority` broker is the only normal QuaranGate service with the raw Docker socket. The executor has no raw socket and uses only the named authenticated broker contract. Broad work targets such as `projects-work` must not receive `/var/run/docker.sock`.

## Persistent projects-work target

Set the host root explicitly when starting the target:

```bash
export PROJECTS_ROOT="$HOME/projects"
docker compose -p projects-work -f projects-work-target/compose.yaml up -d --no-build --pull never
```

The target uses `restart: unless-stopped`, so Docker can restore it after the Docker daemon returns. The compose file never pulls/builds implicitly and does not expose the Docker socket.

Add `projects-work` as a **manual** entry in `config/bridge.yaml` and grant it only to the owner principal. Grant `targets:control` separately if the owner is permitted to start/stop/restart manually registered targets. Grant `targets:logs` separately if bounded container-log access is required.

## Bounded remote lifecycle controls

The remote control surface is intentionally not Docker CLI passthrough:

```text
target_logs       bounded stdout/stderr, requires targets:logs
target_start      existing manual target only
target_stop       existing manual target only
target_restart    currently-running manual target only
```

Mutation requires both:

```text
target is in the principal target allowlist
AND
targets:control scope is present
```

The executor independently resolves the target from trusted configuration and refuses ambiguity. No lifecycle request can specify an image, bind mount, host path, network, port, privilege, device, capability or arbitrary Docker parameter.

## Controlled deployment and owner-logon recovery

Before installing unattended recovery, deploy the candidate with:

```bash
./scripts/remote-owner-deploy-candidate.sh
```

The deploy helper requires a clean candidate worktree, performs the source build through the governed local-base builder: the exact digest-pinned Node base must already exist locally, the exact local base image ID is exported into a private validated OCI layout and bound into the Dockerfile by exact layout digest, build RUN networking is disabled, unexpected registry/auth activity is refused, and only exact BuildKit alias-normalization lines paired with the matching `OCI load from client` context/digest are accepted as local resolution evidence; the verified offline npm bundle is the only dependency source; it then tags one verified shared artifact for gateway/executor and verifies the embedded Git revision, captures the exact currently running gateway/executor images for rollback, deploys the new gateway/executor without changing Docker mounts or public bindings, runs infrastructure acceptance, and only then persists the exact image tags into the ignored operator `.env`. It never prints the `.env` contents. A failure after mutation begins attempts to restore the prior image selections and prior `.env` bytes.

If O1 is already configured (trusted `OLLAMA_MODEL_QUALIFIER` present or an existing QuaranGate Ollama service exists), deployment and recovery include `compose.ollama.yaml`. This prevents the remote-owner path from silently dropping the existing inference service/network while O1 remains open.

`scripts/remote-owner-start.sh` is the bounded WSL recovery entrypoint. It:

- waits up to 120 seconds for the already-installed Docker Engine;
- resolves the ignored runtime `.env` without printing it;
- refuses mutable `:latest` QuaranGate gateway/executor image selections;
- verifies every configured image already exists locally;
- performs no image pull or build;
- preserves the configured O1 compose overlay when present;
- starts the existing QuaranGate and `projects-work` compose services;
- waits for gateway health;
- proves the work target has no Docker socket;
- checks local gateway readiness;
- reports Tailscale Funnel status read-only when the CLI is available.

The Windows helper `scripts/windows/Install-QuaranGateRemoteOwnerAutostart.ps1` installs a non-elevated Task Scheduler action at owner logon. The scheduled action launches a per-user Windows PowerShell wrapper under `%LOCALAPPDATA%\QuaranGate`; that wrapper records Windows-side start/exit evidence in `remote-owner-task.log` and invokes `wsl.exe` with an argument array targeting the tracked `scripts/remote-owner-autostart.sh`. The Linux wrapper then creates `~/.local/state/quarangate/remote-owner-autostart.log` and invokes `remote-owner-start.sh`. This extra Windows boundary is required on the qualified workstation because direct Task Scheduler → `wsl.exe` returned `0xFFFFFFFF` even though the identical WSL command succeeded interactively. This is intentionally a **logon recovery** guarantee, not a claim that Docker Desktop can run an interactive-user stack before any Windows user session exists.

## Remote acceptance

After deployment, acceptance should prove all of the following with an owner-authorized client:

```text
[ ] projects-work visible and running
[ ] read a project file under ~/projects
[ ] create/read/delete a disposable file under ~/projects
[ ] execute a target-confined terminal command
[ ] inspect an approved target
[ ] read bounded target logs
[ ] restart one disposable/approved manual target and verify health afterward
[ ] client without targets:control is denied lifecycle mutation
[ ] discovery-only target is denied lifecycle mutation
[ ] projects-work has no Docker socket
[ ] target path traversal outside ~/projects remains denied
[ ] lifecycle API exposes no arbitrary image/mount/network/privileged-container creation
[ ] gateway remains loopback-bound and executor remains unpublished
[ ] approved HTTPS ingress still reaches the gateway
```

Do not use a production datastore or other stateful service as the lifecycle acceptance target merely to demonstrate restart authority; use a disposable or explicitly approved target.

Host-side infrastructure acceptance is available as:

```bash
./scripts/remote-owner-infra-acceptance.sh
```

It performs only read/health checks and fails closed if the gateway is not loopback-only, the executor or Docker-authority broker is published, raw Docker socket ownership drifts away from broker-only, or the projects root bind is broader/different than approved.
