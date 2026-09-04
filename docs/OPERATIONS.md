# QuaranGate Operations

This document is the operator runbook for QuaranGate. It focuses on actions that change or validate the running system: configuration, builds, deployment, health, credentials, target checks, evidence, ingress, recovery and troubleshooting.

QuaranGate is intentionally conservative about operational authority. A successful source build is not a deployment. A successful agent job is not an apply. A running process is not necessarily ready. Those distinctions are part of the product, not ceremony around it.

> [!IMPORTANT]
> The executor holds `/var/run/docker.sock`. Docker socket access is effectively host-level authority. QuaranGate limits that authority by keeping the executor private and exposing only a narrow internal API, but the residual impact of an executor or Docker-daemon compromise is still high. Never publish the executor and never mount the Docker socket into the gateway or an agent runner.

> [!IMPORTANT]
> This runbook is finalized against accepted local baseline `18179696b3ef3ff2192805590027d2e1a43a43d4` (`build: add governed offline npm dependency bundle`). N1 was accepted and committed locally with 44/44 unit test files, 1693/1693 tests, source build PASS and a no-cache/network-none Docker build PASS. It was not pushed, deployed, or used to enable O1 as part of that gate.

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
Docker authority / trusted config / job store
NO published port

WORK EXECUTION
Executor
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
/home/herman/projects/mcp-ide-bridge
```

Run project commands from that repository unless a command explicitly says otherwise.

Before any mutation, establish the real state:

```bash
cd /home/herman/projects/mcp-ide-bridge

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
DOCKER_GID
BRIDGE_PUBLIC_URL
GIT_REVISION
GATEWAY_IMAGE
EXECUTOR_IMAGE
agent runtime image references / secret-file paths when Agent Control is enabled
```

N1 introduces a build-only `QUARANGATE_NPM_BUNDLE_PATH`. It is required for a valid source build but deliberately not required for ordinary runtime Compose operations such as `ps`, `logs` or `restart`.

Generate the internal gateway-to-executor token with a cryptographically secure random source, for example:

```bash
openssl rand -base64 32
```

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

Preparation requires the `node:24-alpine` image to already exist locally. The tool intentionally uses `--pull=never`; it will stop rather than silently pulling the image.

Check first:

```bash
docker image inspect node:24-alpine >/dev/null
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
export EXECUTOR_IMAGE="quarangate:executor-$GIT_REVISION"
export QUARANGATE_NPM_BUNDLE_PATH

docker compose build
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

## Base-image limitation

The current Dockerfile uses:

```text
node:24-alpine
```

N1 proves a current-machine offline build against an already-local image identity. The source does not yet bind `FROM` to an immutable cross-machine digest.

Therefore:

```text
current-machine rebuild with approved local base image:
can be proven

cross-machine bit-for-bit base-image reproducibility:
not yet proven by the tag alone
```

Do not claim otherwise.

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
quarangate:executor-<full-reviewed-sha>
```

Both are built from the same source/Dockerfile but are independently selectable deployment references.

The unset/development fallback `quarangate:latest` is not production provenance.

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

The O1 source and model selection are qualified, but final container deployment/post-deployment acceptance remains a separate operational gate. Do not interpret model qualification as production activation.

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

See `docs/TARGETS.md` for the complete target contract.

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
exact BRIDGE_PUBLIC_URL
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

The current accepted local baseline is:

```text
HEAD: 18179696b3ef3ff2192805590027d2e1a43a43d4
TypeScript: PASS
44 / 44 unit test files PASS
1693 / 1693 unit tests PASS
source build: PASS
no-cache network-none Docker build with approved pre-provisioned inputs: PASS
```

The preceding Tini-only checkpoint (`6129d3d`) remains historical evidence at 43 files / 1671 tests.

Integration, Docker, destructive apply and credentialed provider tests have additional prerequisites and authority boundaries. Do not run every test merely because it exists.

See `docs/TEST_RESULTS.md` for point-in-time evidence and historical counts.

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
