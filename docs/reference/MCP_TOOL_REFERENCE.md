# QuaranGate MCP Tool Reference

**Candidate surface:** 45 tools on `integrate/u1-control-center-full`.  
**Accepted base:** 44 tools on `b01015c4c2854881aeac7cab6e2caf45d978a75d`.  
**U1 addition:** `control_center_query` is the 45th candidate tool and is read-only.

This document is the operator/developer reference for every public MCP function currently represented by the U1 candidate. It describes purpose, required authority, key arguments and a representative use case.

> The MCP server remains authoritative. This reference does not grant permission. Every call still requires authentication, the required scope and any applicable target/project/backend/profile/GitHub grant.

## Surface summary

| Surface | Count | Purpose |
|---|---:|---|
| Direct target operations | 18 | Governed target, file, terminal, Git and process operations. |
| Agent Control Plane | 9 | Durable governed AI jobs, evidence review and guarded promotion/disposition. |
| GitHub App Control Plane | 17 | Trusted-repository discovery/read/write/review through QuaranHUB. |
| Control Center observability | 1 | Bounded metadata-only operator read model. |
| **Total U1 candidate** | **45** | |

## Authority terms

- **Read** — inspection-only MCP call.
- **Write** — bounded content/job creation that is not itself a destructive promotion.
- **Execution** — shell execution inside an authorized target workspace.
- **Destructive** — lifecycle/deletion/promotion/cancel/discard or bounded remote-write action.

## Direct target operations — 18

### `targets_list`

- **Authority:** Read
- **Required scope:** `targets:read`
- **Arguments:** none
- **Purpose:** list configured targets visible to the current principal.
- **Returns:** authorized logical target summaries only.
- **Use case:** populate the Console target picker before inspecting files or running commands.

### `target_inspect`

- **Authority:** Read
- **Required scope:** `targets:read`
- **Arguments:** `target`
- **Purpose:** show runtime state, workspace, image/status/health for one authorized target.
- **Use case:** confirm which governed target is running before a diagnostic operation.

### `target_logs`

- **Authority:** Read
- **Required scope:** `targets:logs`
- **Arguments:** `target`, optional `maxBytes` (1,024–262,144)
- **Purpose:** read bounded stdout/stderr from an authorized manual target.
- **Use case:** inspect the last bounded service output after a target becomes unhealthy.

### `target_start`

- **Authority:** Destructive
- **Required scope:** `targets:control`
- **Arguments:** `target`
- **Purpose:** start an existing explicitly authorized manual target container.
- **Constraint:** cannot create a container or change image, mount, network, port or privilege configuration.
- **Use case:** bring an enrolled stopped development target online.

### `target_stop`

- **Authority:** Destructive
- **Required scope:** `targets:control`
- **Arguments:** `target`
- **Purpose:** stop one existing authorized manual target using a bounded grace period.
- **Use case:** intentionally take an enrolled target offline for maintenance.

### `target_restart`

- **Authority:** Destructive
- **Required scope:** `targets:control`
- **Arguments:** `target`
- **Purpose:** restart one running authorized manual target without altering its configuration.
- **Use case:** restart an enrolled service after an approved configuration reload requirement.

### `fs_list`

- **Authority:** Read
- **Required scope:** `files:read`
- **Arguments:** `target`, optional `path` (default root), optional `maxDepth` (1–5)
- **Purpose:** list workspace-relative directory entries.
- **Use case:** inspect project structure before opening a file.

### `fs_stat`

- **Authority:** Read
- **Required scope:** `files:read`
- **Arguments:** `target`, `path`
- **Purpose:** read type, size, mode and modified time for a confined workspace path.
- **Use case:** confirm whether a path is a file/directory and inspect metadata before modification.

### `fs_read`

- **Authority:** Read
- **Required scope:** `files:read`
- **Arguments:** `target`, `path`
- **Purpose:** read a file from the authorized workspace and return bounded content.
- **Use case:** inspect source/configuration before review or patching.

### `fs_search`

- **Authority:** Read
- **Required scope:** `files:read`
- **Arguments:** `target`, `query`, optional `path`, optional `maxResults` (1–1000)
- **Purpose:** fixed-string recursive search inside the confined workspace.
- **Use case:** find all occurrences of a symbol or configuration value before editing.

### `fs_write`

- **Authority:** Write
- **Required scope:** `files:write`
- **Arguments:** `target`, `path`, `content`
- **Purpose:** create or overwrite a workspace-relative file.
- **Use case:** write an approved source/configuration change directly inside an authorized work target.

### `fs_patch`

- **Authority:** Write
- **Required scope:** `files:write`
- **Arguments:** `target`, `path`, `oldText`, `newText`
- **Purpose:** replace one unique exact substring in a file.
- **Use case:** apply a narrow deterministic textual repair without replacing the full file.

### `fs_delete`

- **Authority:** Destructive
- **Required scope:** `files:delete`
- **Arguments:** `target`, `path`, optional `recursive` (default false)
- **Purpose:** delete a workspace path; directories require explicit recursive intent.
- **Use case:** remove a known generated/obsolete artifact after review.

### `terminal_exec`

- **Authority:** Execution (MCP destructive hint is true)
- **Required scope:** `terminal:exec`
- **Arguments:** `target`, `command`, optional `cwd`, optional `timeoutMs` (1,000–600,000)
- **Purpose:** execute a bounded shell command inside the authorized target workspace.
- **Constraint:** this is target-local execution, not a host/Docker shell.
- **Use case:** run tests, typecheck, build or a bounded diagnostic command in an enrolled work target.

### `git_status`

- **Authority:** Read
- **Required scope:** `git:read`
- **Arguments:** `target`
- **Purpose:** run bounded `git status --porcelain=v1 -b` inside the target workspace.
- **Use case:** establish branch and dirty-state evidence before work.

### `git_diff`

- **Authority:** Read
- **Required scope:** `git:read`
- **Arguments:** `target`
- **Purpose:** return Git diff statistics for the target workspace.
- **Use case:** quickly see the scope of uncommitted tracked changes.

### `git_log`

- **Authority:** Read
- **Required scope:** `git:read`
- **Arguments:** `target`
- **Purpose:** return the latest 30 oneline commits.
- **Use case:** verify recent history/base before implementation or review.

### `process_list`

- **Authority:** Read
- **Required scope:** `process:read`
- **Arguments:** `target`
- **Purpose:** list processes running inside the authorized target.
- **Use case:** verify whether an expected dev/test process is alive inside the target.

## Agent Control Plane — 9

Agent inputs are strict and caller-controlled host paths, Docker images, volumes, networks and privilege flags are not expressible.

### `agents_list`

- **Authority:** Read
- **Required scope:** `agents:read`
- **Arguments:** none
- **Purpose:** list agent backends the current principal may use, including availability and permitted profiles.
- **Use case:** populate the Agent/Chat backend selector with trusted availability.

### `agent_projects`

- **Authority:** Read
- **Required scope:** `agents:read`
- **Arguments:** none
- **Purpose:** list logical agent projects visible to the principal without exposing host paths.
- **Use case:** select the project for a governed agent dispatch.

### `agent_dispatch`

- **Authority:** Write
- **Required scope:** `agents:dispatch`
- **Arguments:** `backend`, `project`, `profile`, `prompt`; optional `resourcePolicy`, optional `sessionPolicy` (`new`/`resume`)
- **Additional grants:** project, backend and profile must all be permitted.
- **Purpose:** create a durable asynchronous governed agent job.
- **Use case:** ask Ollama/Kiro/another qualified backend to audit, plan, review or implement against an isolated governed workspace.
- **Important:** implement work remains sandboxed; dispatch does not apply changes to live registered source.

### `agent_status`

- **Authority:** Read
- **Required scope:** `agents:read`
- **Arguments:** `jobId`
- **Additional rule:** caller must own the job.
- **Purpose:** return durable lifecycle state and bounded timing/progress metadata.
- **Use case:** poll a dispatched job until it reaches a terminal state.

### `agent_result`

- **Authority:** Read
- **Required scope:** `agents:read`
- **Arguments:** `jobId`
- **Additional rule:** caller must own the job.
- **Purpose:** return a bounded normalized job result; large evidence remains local.
- **Use case:** read the final answer/failure summary after a completed audit or plan job.

### `agent_diff`

- **Authority:** Read
- **Required scope:** `agents:read`
- **Arguments:** `jobId`; optional `path`, `cursor`, `maxBytes` (1,024–262,144)
- **Additional rules:** caller owns job and retains current project grant.
- **Purpose:** review canonical machine-derived change evidence from the immutable artifact.
- **Use case:** inspect an implementation job's verified diff before any live promotion decision.

### `agent_apply`

- **Authority:** Destructive
- **Required scope:** `agents:apply`
- **Arguments:** `jobId` only
- **Additional rules:** caller owns job, retains current project grant and job/evidence/runtime preconditions must pass.
- **Purpose:** apply an already-reviewed COMPLETED job's independently re-verified canonical artifact to its registered live project.
- **Safety:** no caller patch text, host path or Docker options are accepted; stale/dirty/guarded/mismatched state fails closed, and uncertain mutation causes quarantine.
- **Use case:** explicitly promote reviewed verified agent work after `agent_diff` approval.

### `agent_cancel`

- **Authority:** Destructive
- **Required scope:** `agents:cancel`
- **Arguments:** `jobId`
- **Additional rule:** caller owns job.
- **Purpose:** cancel a queued/running job. Cancellation is final; retry is a new job.
- **Use case:** stop work that is no longer required or is consuming resources unexpectedly.

### `agent_discard`

- **Authority:** Destructive
- **Required scope:** `agents:dispatch`
- **Arguments:** `jobId`
- **Additional rule:** caller owns job; only a COMPLETED job is eligible.
- **Purpose:** durably record that verified evidence will not be applied; live source and evidence remain unchanged.
- **Use case:** reject a completed implementation after review while preserving audit evidence.

## GitHub App Control Plane — 17

GitHub remote operations are independently authorized by GitHub scopes plus trusted account/project grants. Repository discovery comes from QuaranHUB GitHub App installations, including supported **Selected repositories** installations. Callers do not provide credentials or arbitrary remote URLs. No merge tool exists.

### `github_repositories`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** none
- **Purpose:** discover repositories available through trusted GitHub App installations/accounts.
- **Use case:** populate the Console repository selector with only governed repositories.

### `github_repository`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`
- **Additional grant:** repository owner/account must be trusted for the principal.
- **Purpose:** read bounded repository metadata.
- **Use case:** inspect default branch/private/archived state before PR or issue work.

### `github_branches`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, optional `maxItems` (bounded up to 100)
- **Purpose:** list bounded branch names, SHAs and protection state.
- **Use case:** choose a safe PR base/head or inspect branch protection.

### `github_commits`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, `ref`, optional `maxItems`
- **Purpose:** read bounded commit metadata from a trusted branch/exact commit ref.
- **Use case:** inspect recent remote history without cloning or arbitrary API access.

### `github_pull_requests`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, optional `state` (`open`/`closed`/`all`), optional `maxItems`
- **Purpose:** list bounded PR metadata.
- **Use case:** find active pull requests for review.

### `github_pull_request`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, `number`
- **Purpose:** read one pull request's bounded metadata.
- **Use case:** inspect title/state/head/base/author before review.

### `github_pull_request_files`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, `number`, optional `maxItems`
- **Purpose:** read bounded changed-file metadata and bounded patch text for a PR.
- **Use case:** perform code-review inspection before submitting a review.

### `github_issues`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, optional `state`, optional `maxItems`
- **Purpose:** list bounded issues (pull requests excluded).
- **Use case:** browse open work items for triage.

### `github_issue`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, `number`
- **Purpose:** read bounded issue metadata/body.
- **Use case:** inspect an issue before planning or implementation.

### `github_issue_comments`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, `number`, optional `maxItems`
- **Purpose:** read up to the bounded comment limit for an issue.
- **Use case:** understand discussion/history on a tracked issue.

### `github_pull_request_reviews`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, `number`, optional `maxItems`
- **Purpose:** read submitted PR reviews.
- **Use case:** determine existing approval/request-changes state.

### `github_pull_request_review_comments`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, `number`, optional `maxItems`
- **Purpose:** read bounded code-review comments with path/line metadata where available.
- **Use case:** inspect outstanding inline review feedback.

### `github_checks`

- **Authority:** Read
- **Required scope:** `github:read`
- **Arguments:** `repository`, `ref`
- **Purpose:** read bounded commit-status compatibility data; `checkRuns` remains empty where GitHub Checks permission is intentionally absent.
- **Use case:** determine whether commit statuses are green before PR/update decisions.

### `github_push_branch`

- **Authority:** Destructive / remote write
- **Required scope:** `github:write`
- **Arguments:** `project`, `expectedHead` (exact commit), `remoteBranch`
- **Additional grant:** trusted logical local project mapping.
- **Purpose:** publish one exact current local HEAD to a trusted non-protected remote branch.
- **Cannot:** force push, delete refs, push tags/default/protected branch, select arbitrary remote URL.
- **Use case:** publish a reviewed candidate commit so a PR can be opened.

### `github_pull_request_create`

- **Authority:** Destructive / remote write
- **Required scope:** `github:write`
- **Arguments:** `repository`, `head`, `base`, `title`; optional `body`, `draft`
- **Purpose:** create a pull request on a trusted repository.
- **Cannot:** merge the pull request.
- **Use case:** open a PR for a bounded published branch.

### `github_pull_request_update`

- **Authority:** Destructive / remote write
- **Required scope:** `github:write`
- **Arguments:** `repository`, `number`; at least one of optional `title`, `body`, `state` (`open`/`closed`)
- **Purpose:** update bounded PR metadata or open/closed state.
- **Cannot:** merge.
- **Use case:** correct PR title/body or close/reopen an existing PR.

### `github_pull_request_review`

- **Authority:** Destructive / remote review
- **Required scope:** `github:review`
- **Arguments:** `repository`, `number`, `event` (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`), optional `body`
- **Purpose:** submit a bounded PR review.
- **Cannot:** merge or alter repository settings.
- **Use case:** formally approve, comment on or request changes to a reviewed PR.

## Control Center observability — 1

### `control_center_query`

- **Status:** U1 candidate addition; not part of the 44-tool accepted base until U1 is promoted.
- **Authority:** Read
- **Required scope:** `targets:read`
- **Arguments:** required `view`; optional `limit`, `sinceMs`, and authority-preflight fields (`tool`, `target`, `project`, `backend`, `profile`, `githubAccount`, `githubProject`).
- **Purpose:** read bounded metadata-only operator views for the current principal.
- **Security:** never returns prompts, file contents, command output, credentials, Docker options or raw tool payloads.

Supported `view` values:

| View | Purpose | Representative use case |
|---|---|---|
| `summary` | Current principal, runtime, targets/backends/projects, activity/rate/capability summary. | Render Overview. |
| `activity` | Current-principal bounded MCP audit metadata and aggregates. | MCP Traffic & Activity monitor. |
| `authority` | Effective principal grants plus optional advisory preflight. | “Can this principal perform X?” explanation. |
| `topology` | Bounded gateway/executor/target topology and revision comparison. | Runtime topology and drift view. |
| `egress` | Expected network/provider policy state where known. | Verify local/no-fallback policy claims without packet capture. |
| `providers` | Backend/Ollama/job queue/provider capability state. | Provider health and model operations. |
| `incidents` | Deduplicated bounded denial/runtime incident metadata. | Incident center. |
| `statistics` | Retained-window activity/job/target/backend aggregates. | Statistics page. |
| `capabilities` | Backend/IDE capability and qualification matrix. | Compatibility/capability page. |
| `resources` | Current safe resource-lifecycle capability state. | Show that generic Docker enumeration is not exposed. |
| `recovery` | Startup/session/backup/rollback/owner-host state. | Recovery & Backups page. |

Current activity retention for this candidate is gateway-memory-only, max 2,048 events, max 24 hours, max 200 rows/query.

## Typical end-to-end use cases

### Read-only source investigation

```text
targets_list
→ fs_search / fs_read
→ git_status / git_diff / git_log
```

Use when an AI or operator needs evidence without mutation.

### Governed implementation and promotion

```text
agents_list
→ agent_projects
→ agent_dispatch(profile=implement)
→ agent_status
→ agent_result
→ agent_diff
→ human review
→ agent_apply OR agent_discard
```

The explicit `agent_apply` call is the only promotion step in this sequence.

### GitHub PR review

```text
github_repositories
→ github_pull_requests
→ github_pull_request
→ github_pull_request_files
→ github_pull_request_reviews
→ github_pull_request_review_comments
→ github_checks
→ github_pull_request_review
```

No merge operation is available.

### U1 operational diagnosis

```text
control_center_query(view=summary)
→ control_center_query(view=activity)
→ control_center_query(view=topology)
→ control_center_query(view=incidents)
```

Use to identify health/authority/drift issues without exposing raw payloads or Docker administration.

## Deliberately absent MCP capabilities

QuaranGate intentionally does **not** expose generic operations for:

- arbitrary Docker commands/options;
- arbitrary host shell/path access;
- caller-selected runner images/mounts/networks/privileged mode;
- arbitrary GitHub API calls;
- GitHub merge;
- force push;
- delete refs/tags/releases;
- repository/secret administration;
- raw credential reads;
- generic packet capture;
- arbitrary SQL;
- automatic live application of completed agent work.

## Related documentation

- [`CONSOLE_FRONTEND_ARCHITECTURE.md`](../frontend/CONSOLE_FRONTEND_ARCHITECTURE.md)
- [`CONSOLE_PRODUCT_SPECIFICATION.md`](../frontend/CONSOLE_PRODUCT_SPECIFICATION.md)
- [`CONSOLE_OPERATIONS_SUPPORT_MANUAL.md`](../user-guides/CONSOLE_OPERATIONS_SUPPORT_MANUAL.md)
- [`AGENT_CONTROL_PLANE.md`](../backend/AGENT_CONTROL_PLANE.md)
- [`GITHUB_CONTROL_PLANE.md`](../backend/GITHUB_CONTROL_PLANE.md)
- [`SECURITY.md`](../security/SECURITY.md)
