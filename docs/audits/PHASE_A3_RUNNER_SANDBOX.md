# PHASE A3 — RUNNER SANDBOX

**Document ID:** MIB-A3-AUDIT
**Program:** Governed Agent Dispatch (ChatGPT → MCP IDE Bridge → Kiro / GitHub Copilot workers)
**Phase executed:** 2026-07-28
**Implementer:** Claude (senior implementation engineer session)
**Starting HEAD:** `9e52d5bde11bcabd370fd45baac9021ea955fa04` — `security: restrict agent job database permissions`
**Implementation commit:** `7df2e09c9cf1c426d91641894dfb11693cc41439` — `feat: add isolated agent runner sandbox`
**Verdict:** **A3 COMPLETE — PASS. READY FOR A4.**

---

## 1. Objective

Build and prove the sandbox execution foundation future real Agent backends will use: trusted staging,
Docker resource ownership, container confinement, resource limits, lifecycle control, bounded logs,
cleanup, orphan reconciliation, source immutability and the security invariants — WITHOUT integrating
Kiro/Copilot, without exposing any Docker primitive to an MCP caller, and without applying changes to
the real project. A3 proves the sandbox, not AI-agent functionality.

The public MCP surface is unchanged: **14 original + 6 operational Agent tools = 20 operational tools**,
**9 Agent contracts**, with `agent_diff` / `agent_apply` / `agent_discard` still unregistered. The
deterministic fake backend remains the operational A2 Agent Dispatch backend. The sandbox is exercised
ONLY through a controlled internal harness (unit + Docker integration), never through live dispatch.

## 2. Files changed (implementation commit `7df2e09`)

**Added:**

```text
runner/Dockerfile                              trusted A3 sandbox image (node:24-alpine + git; /workspace owned node)
src/executor/agents/sandboxSpec.ts             pure policy -> Docker construction (labels, limits, network, bodies, scripts)
src/executor/agents/sandboxRunner.ts           Executor-owned staging + runner lifecycle + orphan reconciliation
tests/unit/agent-sandbox.test.ts               22 pure security-spec tests (no daemon)
tests/unit/agent-jobstore-migration.test.ts    4 v1->v2 migration tests (record preservation)
tests/integration/a3-sandbox.test.ts           6 controlled Docker integration tests (host socket harness)
```

**Modified:**

```text
src/executor/docker.ts       +bounded sandbox-lifecycle primitives (never exposed as HTTP routes)
src/executor/agents/jobStore.ts  schema v1 -> v2 migration (+base_commit) + setBaseCommit + row field
src/executor/index.ts        startup label-scoped orphan reconciliation (agent subsystem only)
src/shared/errors.ts         +FORBIDDEN_POLICY, PRECONDITION_FAILED, SANDBOX_FAILED (additive, fail-closed)
tests/unit/agent-jobstore.test.ts  schema version assertion 1 -> 2
```

## 3. Docker Engine client expansion (exact new bounded capabilities)

Added to `src/executor/docker.ts`, preserving the existing undici `Pool` (16 connections) so a
long-running runner wait cannot block concurrent lifecycle/control calls. NO general-purpose Docker
wrapper; NO new executor HTTP routes; request bodies come exclusively from trusted `sandboxSpec.ts`:

```text
inspectImage                image -> immutable Id
createVolume / removeVolume / listVolumesByFilter
createContainer / startContainer / inspectContainerFull
waitContainer (timeout-bounded; aborts the wait, not the container)
getContainerLogs (bounded, demultiplexed; never unbounded RAM)
stopContainer / killContainer / removeContainer
listContainersByFilter (label-scoped enumeration)
```

Enumeration/removal is ALWAYS scoped by a Docker `filters` selector (label). No name-prefix / image /
age / status enumeration exists.

## 4. Resource ownership labels (the single cleanup authority)

Namespace `io.mcp-ide-bridge`:

```text
io.mcp-ide-bridge.managed  = true
io.mcp-ide-bridge.resource = runner | stager | workspace
io.mcp-ide-bridge.job      = <job-id>
```

Cleanup and reconciliation operate ONLY on resources carrying `io.mcp-ide-bridge.managed=true` (verified
both via the server-side filter AND locally in `isBridgeManaged`). Unrelated Docker resources are never
candidates. Proven live: the orphan test removes bridge-owned resources while an unrelated labeled
container + volume remain untouched.

## 5. Staging model

```text
trusted project id -> Executor trusted registry -> trusted hostPath
      -> trusted stager helper container (RO source bind at /src, RW workspace volume)
      -> git archive HEAD (tracked committed content only) -> /workspace volume
```

The stager is the ONLY container that ever sees the source, mounted **read-only** at `/src`. It is
trusted infrastructure (not an Agent runner): fixed trusted image chosen by Executor policy only, no
caller-controllable image/command/mounts/host path/Docker options, `NetworkMode=none`, no docker.sock,
non-root (`1000:1000`), non-privileged, `CapDrop=ALL`, `no-new-privileges`, read-only rootfs, private
IPC/PID namespaces, no devices, deterministic command, 120 s bounded runtime, removed after staging.

The Agent runner NEVER receives the source bind and NEVER receives any host bind — only the staged RW
workspace volume.

## 6. Source snapshot semantics

`gitRequired: true` (A3 is git-project-first). The stager, with `GIT_OPTIONAL_LOCKS=0` on the read-only
worktree, verifies: repository exists (`rev-parse --git-dir`), HEAD resolves (`rev-parse HEAD`), working
tree is a clean checkpoint (`git status --porcelain --untracked-files=all` empty). A dirty source
(tracked modifications, staged modifications, OR untracked files) **fails closed** with
`PRECONDITION_FAILED` (stager exit 3). No auto-stash / auto-clean / auto-commit. Then
`git archive HEAD | tar -x` stages the tracked committed snapshot — no `.git`, no untracked, no ignored,
no host secrets. A non-git source (exit 4) and an unresolvable HEAD (exit 5) also fail closed.

## 7. Secret exclusion

`git archive HEAD` inherently excludes untracked and ignored files. Proven with a fixture containing a
committed tracked file + committed `.gitignore` + an **ignored** sentinel secret (clean per porcelain):
after staging the workspace holds the tracked content only; the ignored secret is absent. **Untracked**
secrets are covered even more strongly — an untracked sentinel makes the tree dirty, so staging is
**refused** (`PRECONDITION_FAILED`) and the untracked secret never has any opportunity to reach the
workspace. Only obvious synthetic sentinels are used; no real credentials. (This reconciles the brief's
§11 fail-closed-on-untracked with §30 secret exclusion: untracked ⇒ refused; ignored ⇒ archive-excluded.)

## 8. Base commit handling

The stager emits `BASE_COMMIT=<40-hex>`; `stageWorkspace` returns it as provenance for the staged
workspace. Persistence is plumbed via the schema migration below (`setBaseCommit`); base state is never
re-inferred later from host HEAD. Because A3 does not wire the sandbox into live dispatch, no live job
populates it yet — A4 sets it when the sandbox runs under a real job.

## 9. DB schema migration (durable A2 state preserved)

`AGENT_JOB_SCHEMA_VERSION` 1 → **2**. Forward-only, stepwise, explicit: a fresh DB is created at the
latest shape; an existing A2 (v1) DB is migrated in place with `ALTER TABLE agent_jobs ADD COLUMN
base_commit TEXT` — every historical job record is preserved (never wiped/recreated). Idempotent on
reopen; a newer future schema still refuses to open. Proven by 4 dedicated migration tests seeding a
hand-built v1 DB with 12 (>10) records and asserting preservation + the new nullable column.

## 10. Runner security settings

```text
user:              1000:1000 (non-root; the sandbox image's `node`)
privileged:        false
CapDrop:           ALL          CapAdd: []
no-new-privileges: yes (SecurityOpt)
rootfs:            read-only    writable: /workspace (volume) + tmpfs /tmp only
host binds:        none
docker.sock:       absent
network:           none (deny)  NetworkDisabled: true
namespaces:        PidMode "" (not host), IpcMode private, UsernsMode "" (not host)
devices:           []           GroupAdd: []
```

Runtime evidence from the probe confirms `uid=1000/gid=1000`, `docker.sock` absent, root filesystem
write DENIED, marker written only inside `/workspace`, `/tmp` writable. Container-config evidence
(create → inspect → remove) confirms every HostConfig field above.

## 11. Network policy

`deny` is implemented as real Docker isolation (`NetworkMode=none`), not application-layer faking. The
probe's runtime network attempt to a reserved TEST-NET-1 address (`192.0.2.1:80`, no external contact)
returns `DENIED:*` / `TIMEOUT`, never `CONNECTED_BAD`. `backend-only` **fails closed** in A3
(`resolveNetworkMode` throws `FORBIDDEN_POLICY`); it is never treated as unrestricted. Concrete provider
egress is deferred to A4. Runner containers never join the tailnet; Tailscale is unchanged.

## 12. Resource limits (exact integer conversions)

`ResourcePolicy` → container create-time limits: `Memory = maxMemoryBytes`, `MemorySwap = Memory`
(swap disabled), `NanoCpus = maxCpuMillicores × 1_000_000` (1000 millicores = 1 CPU), `PidsLimit =
maxPids`; `maxRuntimeMs` enforced by the bounded wait; `maxOutputBytes` bounds log capture. Non-integer
or non-positive values are rejected (`MALFORMED_REQUEST`), never silently ignored or replaced by Docker
defaults. Verified live via inspect (Memory / NanoCpus / PidsLimit) and by unit conversion tests.

## 13. Evidence collection

Locally measured, never fabricated: `runtimeMs`, `outputBytes` (+ `outputTruncated`), `exitCode`,
`timedOut`, `oomKilled`, immutable `imageId` (from container inspect, not a mutable tag), `containerId`,
`baseCommit`, `volumeName`, and the parsed probe JSON. Absent provider metrics remain absent (the
AgentUsage contract permits this). No peak CPU/memory/process or provider credits are invented.

## 14. Cleanup

`runManagedContainer` removes the runner in a `finally` on success, failure AND timeout (proven for all
three). Staging failure removes the partial container and workspace volume (fail closed). Probe
workspaces are ephemeral: `runSandboxProbe` disposes the volume by default (workspace lifetime is
deliberately separable from runner lifetime, so A5/A6 can retain a changed workspace long enough to
derive a diff before disposal). `agent_apply` / `agent_discard` are NOT activated in A3.

## 15. Orphan reconciliation

`reconcileOrphans` (run at Executor startup for the agent subsystem, and drivable directly) lists
containers + volumes by the exact managed label, verifies the label locally, then kills+removes managed
containers and removes managed volumes (A3 runners are ephemeral and not attachable ⇒ any survivor is an
orphan ⇒ fail closed). Only exact-labeled resources are candidates. Proven: bridge-owned orphan runner
(live) + orphan workspace volume removed; unrelated labeled container (still running) + unrelated volume
untouched.

## 16. Tests actually run this phase

```text
git diff --check        PASS (clean)
npm run typecheck        PASS
npm test (unit)          137 / 137 PASS  (109 pre-A3 + 28 new: 22 sandbox-spec, 4 migration, +2 jobstore)
npm run build            PASS
A3 Docker integration    6 / 6 PASS   (tests/integration/a3-sandbox.test.ts, host Docker harness)
```

A3 Docker integration proved, against the host Docker socket with NO MCP/gateway/keys and NO unrelated
project touched: workspace volume created; tracked source staged; ignored sentinel excluded; untracked
sentinel ⇒ fail-closed; runner non-root / non-privileged / no docker.sock / no host bind / no host
network / private namespaces / cap-drop / read-only rootfs / workspace RW / tmpfs /tmp / resource limits
applied; runner reads workspace and writes a sandbox marker; runner cannot mutate the trusted source
(byte-for-byte unchanged); network deny enforced at runtime; output bounded+truncated; timeout bounded
with the runner removed; success/failure cleanup; orphan reconciliation scoped to owned resources only.
No Kiro. No Copilot.

## 17. Deployment / boundary (post-implementation, live)

The A2 stack was **not** redeployed in A3 (the sandbox is not wired into live dispatch; functional proof
is the direct Docker harness, and the v1→v2 migration is proven by unit test to apply safely whenever the
Executor next starts). Live boundary re-verified via `docker inspect` (unchanged from A2):

```text
gateway published ports:  127.0.0.1:8787   gateway docker.sock: ABSENT   gateway /jobs: ABSENT
executor published ports: {}               executor docker.sock: PRESENT (existing trusted authority)   executor /jobs: PRESENT
runner (integration):     no published ports; docker.sock ABSENT; host project bind ABSENT; privileged false; network none
bridge-managed resources left after suite: 0 containers / 0 volumes
```

Runner image used for the A3 probe: `mcp-ide-bridge-sandbox:a3`
(`sha256:20535453bb7797eb21169246f9695c1f5311bd68c78a34a34d2011f9bce8236f`), built from
`runner/Dockerfile` (pinned base `node:24-alpine`, minimal added package `git`, `/workspace` owned
node so a fresh volume inherits node ownership — no CAP_CHOWN, non-root throughout). This is a controlled
A3 probe image ONLY; it is NOT declared the production Kiro runner image (A4 owns that).

## 18. Legacy tests not rerun and why

The pre-A2 live MCP suites (`bridge.test.ts`, `output-schema.test.ts`) and the A2 live suites
(`agents.test.ts`, `a2-regress.test.ts`, `a2-persistence.test.ts`) depend on the gitignored live
`config/clients.yaml` principals and `KEYS_ENV`. Per the A3 brief, pre-existing real client credentials
were NOT rotated and no key was printed to satisfy historical fixtures. Those suites were not rerun in
this session; their A2 evidence stands (see `PHASE_A2_DURABLE_JOB_ENGINE.md`). The public tool surface
count (20) is additionally asserted by the unmodified A2 tests and unchanged by A3. New A3 evidence is
reported separately above.

## 19. Deviations

1. **Not redeployed / live MCP suites not rerun** — A3 does not change the public contract or wire the
   sandbox into live dispatch; functional proof is the direct Docker harness and the migration unit
   tests. Documented in §17–§18.
2. **Untracked-vs-ignored secret exclusion** — untracked ⇒ fail-closed refusal (stronger than exclusion);
   ignored ⇒ archive-excluded. Reconciles the brief's §11 and §30 coherently (§7).
3. **`backend-only` fails closed** in A3 (no guessed provider egress); `deny` fully implemented (§11).
4. **Global serial execution retained** from A2 (one active job); A3 prioritizes confinement over
   throughput — no concurrency optimization.
5. **New error codes** `FORBIDDEN_POLICY` / `PRECONDITION_FAILED` / `SANDBOX_FAILED` — additive, typed,
   fail-closed.
6. **Dedicated runner image** (`runner/Dockerfile`) rather than reusing the executor image, matching the
   A3 principle that the runner image is separate trusted infrastructure (as the future Kiro image will
   be). One controlled image serves both trusted roles (stager + probe). No new npm dependency; no opaque
   third-party image pulled.

## 20. A4 entry conditions

1. Repository at the A3 closeout commit, clean tree.
2. `RunnerSandbox` is the substrate: A4 replaces the deterministic probe step with a real read-only Kiro
   ACP adapter invoked from trusted code, reusing staging, confinement, limits, evidence and cleanup
   unchanged. `backend-only` egress and `AGENT_RUNNER_IMAGE` (Kiro runner image validation + immutable ID)
   are A4's to resolve.
3. The fake backend remains the operational public backend until A4 wires the real adapter.

## 21. No-real-agent proof

```text
Kiro invoked:                 NO
Copilot invoked:              NO
real Agent backend activated: NO
sandbox wired to live dispatch: NO (deterministic internal probe only)
new npm dependency:           NONE
Tailscale changed:            NO
unrelated Docker project touched: NO
```
