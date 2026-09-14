# QuaranGate Console — Operator & Support Manual

**Audience:** operators, developers, QA, support engineers and administrators.  
**Product:** QuaranGate Console.  
**Default URL:** `http://127.0.0.1:8787/console/` when the gateway uses its default loopback binding.

> This manual describes the U1 implementation candidate. A screen can exist before its underlying roadmap capability is production-qualified. Always trust the capability/status label shown by QuaranGate.

## Quick start

### Before opening the Console

Confirm the QuaranGate gateway is running and the operator has an already-provisioned client credential with the required scopes and grants.

The browser does not create credentials and must not be used as a credential store.

### Connect

1. Open `/console/`.
2. Enter the QuaranGate API key/bearer credential.
3. Select **Connect**.
4. The Console discovers the live MCP tool surface.
5. Confirm Tool Lab does not report unexpected `MISSING` or `EXTRA` drift.
6. Review **Overview** before performing mutations.

The credential remains in page memory only and is cleared on Disconnect.

## Authority legend

Every action is presented with one of four authority classes:

| Class | Meaning | Typical examples |
|---|---|---|
| Read | Inspection only | target/file/Git/process reads, job status, GitHub reads. |
| Write | Creates bounded content/work | file write/patch, agent dispatch. |
| Execution | Runs a bounded command in an authorized target | `terminal_exec`. |
| Destructive | Lifecycle, deletion, promotion/cancel/discard or bounded remote write | target control, delete, apply, GitHub write/review. |

A browser confirmation never overrides server policy. A denied action remains denied after confirmation.

## Daily operator workflow

### 1. Check system state

Open **Overview** and **Monitoring**.

Review:

- Gateway/Executor state;
- source/build/runtime provenance (`MATCH`, `DRIFT`, `UNKNOWN`);
- authorized target availability;
- provider/model state;
- queue/activity state;
- recent incidents/denials;
- capability states such as session continuity and IDE control.

Do not treat `UNKNOWN` as healthy.

### 2. Inspect a project or target

Use **Projects** for logical agent-project policy/capability information and **Targets** for target/container workspace operations.

Targets are logical authorized IDs. The Console does not expose arbitrary Docker container selection or host paths.

### 3. Read or change files

Use **Files**:

- Browse → `fs_list`
- Metadata → `fs_stat`
- Read → `fs_read`
- Search → `fs_search`
- Write → `fs_write`
- Exact replacement → `fs_patch`
- Delete → `fs_delete`

Delete is destructive-class. Paths are workspace-relative and server-confined.

### 4. Run a bounded terminal command

Use **Terminal** only when Execution authority is appropriate.

`terminal_exec` executes inside the authorized target workspace with bounded timeout/output. It is not a host shell and grants no Docker authority.

### 5. Run governed AI work

Use **Chat** or **Agents**:

1. Select backend.
2. Select logical project.
3. Select profile (`audit`, `plan`, `implement`, `review`).
4. Enter the request.
5. Dispatch.
6. Monitor the durable job.
7. Inspect `agent_result`.
8. For implementation evidence, inspect `agent_diff`.
9. After review, choose **Apply verified changes** or **Discard result**.

Remember:

> A `COMPLETED` implementation has not changed the registered live project.

Only a successful `agent_apply` creates `APPLIED` state.

### 6. GitHub workflow

Use **GitHub** for governed repository work:

1. discover repositories;
2. inspect repository/branches/commits;
3. inspect issues or pull requests;
4. review PR files/reviews/comments/statuses;
5. if authorized, publish an exact local HEAD to a bounded non-protected branch;
6. create or update a PR;
7. submit a PR review.

The Console does **not** expose merge, force push, delete-ref, arbitrary remote URL or repository administration.

GitHub App **Selected repositories** installations are supported; discovery must remain limited to App-granted repositories.

## Page-by-page guide

| Page | Operator purpose | Important caution |
|---|---|---|
| Overview | Health/trust/activity summary | `UNKNOWN` is not `READY`. |
| Chat | Governed conversational job workflow | Job lifecycle is durable truth; no fake streaming. |
| Projects | Logical project policy/capability view | Host paths are not exposed. |
| Targets | Target inventory, inspect, logs, lifecycle | Start/stop/restart are destructive-class. |
| Files | Workspace file operations | Delete is destructive; paths are confined. |
| Terminal | Bounded command execution | Execution authority is higher risk than Read. |
| Git | Status/diff/log | Read-only Git operations. |
| Processes | Inspect target processes | Target-local only. |
| Agents | Backends/profiles/projects/dispatch | Availability comes from trusted config/runtime. |
| Jobs | Durable lifecycle and evidence | `COMPLETED != APPLIED`. |
| Review & Approvals | Human decision workflow | Distinct authority decisions must remain separate. |
| IDE Sessions | IDE-control readiness/future state | Do not assume control exists until qualified. |
| GitHub | Governed remote repository operations | No merge/admin/secret authority. |
| Local AI / Models | Provider/model state | Local process alone does not prove privacy. |
| Monitoring | Traffic/topology/egress/provider/drift | Metadata only; missing counters are unavailable. |
| Statistics | Retained-window aggregates | Current U1 data is bounded, not a long-term warehouse. |
| Security & Access | Effective grants and preflight | Preflight is advisory and non-mutating. |
| Audit & Evidence | Request metadata/evidence lineage | Raw prompts/file/command bodies are intentionally absent. |
| Recovery & Backups | Recovery/quarantine/backup state | Backup mutations remain external unless governed APIs exist. |
| Settings | Current config/capability state | Read-only where no governed mutation contract exists. |
| Tool Lab | Complete low-level MCP surface | Prefer purpose-built screens for normal work. |

## Monitoring interpretation

### Activity retention

The U1 activity view is a bounded gateway-memory ring:

- max 2,048 events;
- max age 24 hours;
- max 200 rows returned per query;
- current-principal filtering.

A zero count proves no matching retained event in the queried window; it does not prove historical absence outside retention.

### Runtime drift

- `MATCH` — compared known identities agree.
- `DRIFT` — known identities disagree.
- `UNKNOWN` — evidence is insufficient.

Do not override drift through the browser.

### Provider/model state

Configured, implemented and production-qualified are separate states. An adapter/model can exist while remaining `NOT_QUALIFIED`.

### Session/IDE state

A session capability or provider session ID is not authorization. Current principal/project/backend/profile authority still governs every operation.

## Common errors and support actions

### 401 / `UNAUTHENTICATED` / `INVALID_CREDENTIAL`

**Meaning:** credential absent, invalid, expired or revoked.

**Action:** Disconnect, obtain a valid credential through the authorized process, reconnect. Never put the secret into tickets, screenshots or chat logs.

### 403 / `FORBIDDEN_*`

**Meaning:** QuaranGate correctly denied authority.

Common examples:

- `FORBIDDEN_SCOPE`
- `FORBIDDEN_TARGET`
- `FORBIDDEN_PROJECT`
- `FORBIDDEN_BACKEND`
- `FORBIDDEN_PROFILE`
- `FORBIDDEN_JOB`
- GitHub account/project denial

**Action:** verify intended scopes/resource grants. Do not bypass the denial with direct Docker, executor access or another client.

### 429 / `RATE_LIMITED` / `CONCURRENCY_LIMIT`

**Meaning:** caller or execution-plane bounded limit reached.

**Action:** wait for the active window/job to clear. Do not repeatedly dispatch duplicates.

### `DOCKER_UNAVAILABLE` / executor not ready

**Meaning:** the private executor cannot prove trusted Docker readiness.

**Action:** treat the system as degraded and use the approved owner/runtime recovery path. Never add Docker socket access to gateway or worker targets.

### Tool surface `MISSING` / `EXTRA`

**Meaning:** expected Console catalog and live MCP server differ.

**Action:** stop before assuming feature parity. Capture expected/present/missing/extra names and reconcile source/runtime version.

### Runtime `DRIFT`

**Meaning:** known source/build/runtime identities disagree.

**Action:** do not perform promotion/deployment decisions until provenance is reconciled.

### Long-running job

Use **Jobs** to inspect durable status. A browser polling timeout does not mean the durable job stopped. Cancel only when appropriate and authorized.

### `UNCERTAIN` / quarantine

QuaranGate cannot prove a clean live mutation outcome. Stop automated promotion, preserve evidence and use the recovery process. Do not manually clear quarantine without evidence.

## Support triage checklist

Collect **safe metadata only**:

- UTC timestamp/time window;
- Console/source/runtime revision where visible;
- request ID;
- MCP tool name;
- safe error code;
- principal/client ID (not key/hash/token);
- logical target/project/repository ID;
- job ID or PR/issue number if relevant;
- provenance state;
- approved `/healthz` and `/readyz` outcome if available;
- browser name/version and viewport for UI issues;
- exact reproduction steps without secrets.

Do **not** request by default:

- API keys, tokens or private keys;
- raw prompt text;
- customer/company/healthcare secrets;
- arbitrary file contents;
- full terminal output containing sensitive data;
- Docker socket access;
- credential files.

Use the smallest approved redacted excerpt only when content is essential.

## Security incident escalation

Treat these as high priority:

- credential appears in UI/log/toast/URL/browser storage;
- gateway or worker unexpectedly gains Docker socket access;
- caller can select arbitrary host paths/Docker options;
- unauthorized target/project/repository becomes visible or mutable;
- `COMPLETED` work is applied without explicit `agent_apply`;
- cloud/provider fallback occurs contrary to policy;
- source/image/runtime drift is ignored and mutation proceeds;
- GitHub merge/force-push/delete/admin capability appears unexpectedly;
- telemetry exposes raw prompt/file/command payloads.

Preserve request/job/revision evidence and stop the affected mutation path.

## Operational health

QuaranGate separates liveness from trusted readiness:

- `/healthz` — process/service liveness where implemented;
- `/readyz` — authority/readiness gate; executor readiness includes Docker authority validation.

Do not weaken `/readyz` just to make a deployment appear green.

## Backups, recovery and lifecycle

The current Console may report recovery/backup capability state but does not invent browser backup/restore mutation APIs.

Use:

- [`OPERATIONS.md`](../operations/OPERATIONS.md)
- [`REMOTE_OWNER_ORCHESTRATION.md`](../operations/REMOTE_OWNER_ORCHESTRATION.md)
- [`INSTALLER_PRODUCTIZATION.md`](../operations/INSTALLER_PRODUCTIZATION.md)

for owner-level lifecycle procedures.

## Keyboard and accessibility

- `Ctrl/Cmd + K` — command palette.
- `Tab` / `Shift+Tab` — move through controls.
- `Escape` — dismiss safe modal/dialog flows.
- Skip link — jump to main content.

Destructive confirmation dialogs trap focus and restore focus to the invoking control when closed.

## Support boundaries

Support must not “fix” a problem by weakening the trust model. Never:

- give Docker socket access to gateway/workers;
- change Selected repositories to All repositories merely for discovery;
- bypass MCP authorization with a direct executor call;
- persist API keys in browser storage;
- add generic Docker/host shells;
- manually mutate live project state to hide an apply failure;
- classify unknown provenance as healthy.

## Engineering escalation template

```text
TIME_UTC:
CONSOLE_REVISION:
RUNTIME_REVISION:
REQUEST_ID:
TOOL:
ERROR_CODE:
PRINCIPAL_ID:
TARGET_OR_PROJECT:
JOB_OR_GITHUB_ID:
PROVENANCE_STATE:
STEPS_TO_REPRODUCE:
EXPECTED:
ACTUAL:
SECRETS_INCLUDED: NO
```

## Related reference

- [`CONSOLE_FRONTEND_ARCHITECTURE.md`](../frontend/CONSOLE_FRONTEND_ARCHITECTURE.md)
- [`CONSOLE_PRODUCT_SPECIFICATION.md`](../frontend/CONSOLE_PRODUCT_SPECIFICATION.md)
- [`MCP_TOOL_REFERENCE.md`](../reference/MCP_TOOL_REFERENCE.md)
- [`SECURITY.md`](../security/SECURITY.md)
- [`OPERATIONS.md`](../operations/OPERATIONS.md)
