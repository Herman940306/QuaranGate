# P7 I2 — IDE companion runtime / enrollment + listener startup composition

Date: 2026-09-14

Accepted source base: `dcb3517bd53d425f7e796261d12bb4abde27f0ec` (`merge(ide): integrate vscode qualification evidence`)

Accepted control base: `3c20d1cc4890ba49d10884a86010fc6310db96d9`

## Scope

This source slice composes the already accepted Plane-B IDE Session Control foundations into an executor-startable, review-only production source path. It adds explicit trusted enrollment configuration, durable `IdeSessionStore` ownership, exact B4 runtime provisioning/recovery, B6 `IdeCompanionListener` startup in accepted I2.2 remote mode with governed user-review intents, executor startup/shutdown ordering, truthful source-wired runtime status, and the minimum optional Compose topology required for a VS Code Remote-WSL extension host and executor container to name the same Unix runtime path.

This is source/composition evidence only. It does **not** perform live VS Code/Remote-WSL qualification, install/reload VS Code, write live VS Code settings, request model consent, consume provider quota, start a live review against an owner workspace, deploy a new executor image, grant implementation authority, or authorize P7/branch convergence.

## Phase 0 — IPC topology

The accepted VS Code client refuses translated or symlinked runtime paths. It reads an exact absolute `credential.json`, validates canonical owner-only runtime directories, requires `credential.socketPath` to equal `<credential-directory>/companion.sock`, and calls `net.connect()` on that exact path. The accepted B4/B6 server derives and binds that same socket path.

The base `compose.yaml` had no runtime path shared with the WSL host, so simply constructing `IdeCompanionListener` in `src/executor/index.ts` would have produced a container-private endpoint. This slice therefore introduces an **optional** `compose.ide.yaml` overlay. The overlay has one operator-required `QUARANGATE_IDE_RUNTIME_ROOT` with no production default and bind-mounts it into the executor at the **same literal absolute pathname**:

`WSL host QUARANGATE_IDE_RUNTIME_ROOT == executor IDE_RUNTIME_ROOT == bind source == bind target`.

The bind uses long syntax with `create_host_path: false`; Docker may not invent the trusted host directory. The owner/install step must pre-create a canonical, non-symlink directory owned by the same numeric Unix uid observed by the Remote-WSL extension host and executor runtime user, mode exactly `0700`. Bind mounts preserve the numeric owner. Both the accepted server and client validators independently reject wrong uid, wrong mode, non-canonical paths and symlinks, so a namespace/ownership mismatch fails closed before an authenticated IDE connection can become available.

The overlay adds no port, TCP/WebSocket listener, network, privileged mode, capability, Docker socket or extension Docker authority. The base Compose deployment remains Plane-B `NOT_CONFIGURED` unless the owner deliberately enables the overlay.

A Docker Compose CLI is not installed in the governed source target, and the owner-host control surface exposes only bounded deployment/qualification actions rather than arbitrary Docker shell access. Consequently this source gate did not claim a live cross-namespace socket exercise. Static source validation proves exact source/target/env path identity and absence of authority widening; actual WSL/container socket reachability remains part of the separately authorized live qualification gate.

## Trusted runtime root and owner bootstrap

`.env.example` documents `QUARANGATE_IDE_RUNTIME_ROOT` only as a trusted installation variable. Production source contains no Herman-specific home path and no fallback runtime root. `compose.ide.yaml` passes that exact path as `IDE_RUNTIME_ROOT` and mounts it at the same absolute path.

The owner/install handoff is explicit:

1. create the selected WSL runtime root as a real directory, exact mode `0700`, with the required numeric owner;
2. copy and replace the identities in `config/ide-sessions.example.yaml` into trusted `config/ide-sessions.yaml`;
3. enable the optional Compose overlay;
4. configure the extension machine setting `quarangate.runtimeCredentialPath` to `<runtime-root>/<runtimeInstanceId>/credential.json`.

The credential path is non-secret; the B4 secret remains only inside the `0600` credential file. Neither secret bytes nor credential contents are emitted in logs/environment/labels/audit output. No recursive scan, newest-directory selection, process inference, UI automation or public/MCP provisioning exists.

## Dedicated Plane-B trusted configuration

`src/executor/ide/ideSessionConfig.ts` and `config/ide-sessions.example.yaml` define a dedicated strict Plane-B registry rather than overloading `agents.yaml`. The two authority planes remain independent.

Version 1 accepts 1..16 explicit enrollments. Each enrollment is strictly bound to:

- principal ID;
- project ID;
- worktree ID;
- current supported IDE product `vscode`;
- stable IDE instance ID;
- exact B5 workspace fingerprint;
- optional exact Git base revision;
- exact adapter version;
- stable non-secret runtime instance ID;
- exact review-only capability set `prompt`, `cancel`, `observe_response`, `request_review`.

Unknown keys, malformed identities, unsupported products, duplicate binding/runtime identities, unsupported capabilities and `request_implementation` fail closed. The schema contains no host workspace path, runtime-root path, socket path, raw secret, provider credential or model-controlled field. `scripts/validate-config.mjs` independently validates the optional trusted file using the repository's existing deployment-config convention.

## Enrollment lifecycle and durable store

Production owns one existing `IdeSessionStore` at trusted durable `IDE_SESSIONS_DB`, default `/jobs/ide-sessions.db` on the executor-owned persistent jobs volume. `:memory:` and non-absolute DB locations are refused. The DB parent must be canonical, non-symlink, owned by the executor uid and owner-only; an existing DB must remain an owner-only regular non-symlink file. Store construction performs the existing schema verification/migrations before any listener is started.

`IdeSessionStore.reconcileEnrollment()` adds a narrow trusted reconciliation seam without a parallel enrollment database. A first never-seen trusted binding creates one normal enrollment. Ordinary restart reuses the exact ACTIVE enrollment only when principal/project/worktree/product/IDE instance/workspace fingerprint/base revision/capabilities are unchanged. Drift fails closed. A revoked historical binding is not silently re-enrolled; a deliberate new IDE instance binding is required.

Startup calls the existing `recoverAfterRestart()` before listeners are available. Any formerly live session becomes `STALE`; any active operation follows the existing B7 conservative recovery to `INDETERMINATE`; prior controller authority is cleared. A new connection generation advances only through a real authenticated B6 reconnect.

## B4 runtime credential lifecycle

The accepted B4 credential schema is unchanged. Existing `createIdeCompanionRuntime()`, `readIdeCompanionSecret()`, `rotateIdeCompanionSecret()`, `revokeIdeCompanionSecret()`, runtime-reference checks and socket hardening remain authoritative.

For production durability, trusted configuration carries a stable opaque `runtimeInstanceId`. `createIdeCompanionRuntime()` may now accept that already-validated trusted ID for first provisioning. `recoverIdeCompanionRuntime()` recovers **only that exact configured ID** and revalidates the existing canonical ACTIVE credential against enrollment ID, IDE instance/product, adapter identity/version and QuaranGate-derived paths. It performs no runtime-directory scan and no newest-entry selection.

The runtime root inventory itself is closed: every root entry must be one explicitly configured runtime instance directory, owner-only `0700`, non-symlink. Unexpected/ambiguous entries fail startup. Ordinary controlled shutdown removes only listener-owned socket files; it does not revoke or delete the credential. Explicit revocation remains distinct from process shutdown.

## Listener mode and authority

For every configured enrollment, production constructs the accepted `IdeCompanionListener` with:

- existing durable `IdeSessionStore`;
- exact recovered/provisioned B4 runtime;
- `userReviewIntents: true`.

Production deliberately supplies **no** `operationAdapter`, `writerStore` or `implementationAdapter`. This is the accepted I2.2 QuaranGate-origin remote channel path only. The user review intent remains non-authoritative; operation identity/controller/workspace admission remains server-governed; B7 durable admission still precedes model execution. No `request_implementation`, B8 writer lease or startup-created operation is introduced.

Provisioning and startup contain no model selection/request, provider consent path, VS Code private command/API, UI automation, generic shell/filesystem/terminal proxy or public MCP endpoint.

## Startup ordering and truthful status

`src/executor/index.ts` awaits `startIdeCompanionProduction()` after existing trusted recovery/configuration stages and **before** `app.listen()`. For a configured Plane-B deployment, config/store/runtime reconciliation and every Unix listener bind/socket hardening step must complete before executor HTTP availability. Any configured Plane-B startup failure rejects the main startup sequence; the executor cannot stay available while falsely claiming a usable IDE listener.

Truthful bounded metadata is now:

- `NOT_CONFIGURED` — optional trusted Plane-B configuration absent;
- `AVAILABLE_NOT_LIVE_QUALIFIED` — source composition and configured listeners started, without a claim of live VS Code qualification;
- `FAILED` — reserved wire-state semantics for failure classification; configured startup currently fails the process rather than serving false availability.

No state is named `LIVE`, `QUALIFIED` or `PRODUCTION_ACCEPTED`.

## Shutdown ordering

The executor shutdown path awaits Plane-B shutdown before existing Agent Control Plane/HTTP teardown. `IdeCompanionProductionRuntime.stop()` is bounded/idempotent and:

1. stops listeners in reverse order, preventing new connections and invoking accepted listener channel/session reconciliation;
2. removes only listener-owned socket paths through existing listener behavior;
3. closes `IdeSessionStore` only after every listener stop succeeded.

If a listener cannot prove it stopped, the store is not closed underneath a potentially active listener; the outer executor still retains its bounded hard-exit fail-safe. Normal shutdown does not delete credentials or re-enroll identities.

## Validation

Completed on the final executable source bytes before audit-only documentation freeze:

- runtime/enrollment/startup focused: **151/151 PASS across 5 files**;
- integrated qualification regression: **19/19 PASS**;
- existing VS Code activation/bridge/I2 focused: **115/115 PASS across 8 files**;
- full P7 B1-B9 + I2 regression including this slice: **343/343 PASS across 26 files**;
- shared writer / `agent_apply`: **246/246 PASS across 4 files**;
- canonical unit corpus: **2612/2612 PASS across 92/92 files**;
- root typecheck: **PASS**;
- root build: **PASS**;
- catalog/public subset: **42/42 PASS across 4 files**;
- public MCP catalog: **45 exact / 45 unique / no missing / no extra**;
- `git diff --check`: **PASS**.

Static Compose/source topology check: bind type `bind`; source equals target; environment runtime root equals target; `create_host_path=false`; no ports/privileged/cap-add/network override. Docker Compose CLI rendering is **not executable in the governed source target because Docker is absent**, so no live/deployment claim is derived from the static receipt.

## Security/scope scans

The production composition/config/overlay adds no `request_implementation`, `writerStore`, `implementationAdapter`, `executeCommand`, `workspace.fs`, terminal creation, private Copilot/VS Code APIs, Docker socket reference, privileged/cap-add/network/port broadening, or raw-secret logging. Public MCP remains 45 exactly.

The seven accepted qualification/evidence paths are unchanged. Project-control paths are unchanged. The only intended source paths for this gate are the runtime/config/Compose/startup/test/audit paths frozen with this document.

## Explicit non-claims and next gate

This candidate does not claim live Remote-WSL extension placement, live B4/B6/B5 binding, actual cross-namespace socket reachability, VS Code public model API/access, provider consent, review execution/cancellation/disconnect/backpressure/reconnect behavior in a real owner IDE, deployment, final I2/P7 acceptance, or branch convergence.

After immutable source freeze and ChatGPT independent source acceptance, project control must reconcile this source gate. Only after that reconciliation, and only if review evidence identifies no further prerequisite gap, the next product gate is **LIVE VS CODE / REMOTE-WSL QUALIFICATION** using the already integrated qualification infrastructure and a genuinely clean immutable source worktree/clone.
