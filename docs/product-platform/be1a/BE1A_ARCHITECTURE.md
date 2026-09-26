# BE1A Cross-Project Execution Fabric Architecture

## Scope

BE1A removes unnecessary global ACP execution serialization while preserving the permanent **one writer per worktree** invariant and all pre-existing apply/live-writer authority.

## Trusted identity and queue partitioning

Every job already carries a registered project id. BE1A snapshots executor-derived logical resource keys onto the durable job row at dispatch. Callers never provide host paths, worktree paths, Docker selectors, ports, credentials, release material, or concurrency limits.

Queue admission remains globally bounded and is additionally bounded per project by trusted `execution.maxQueuedPerProject`.

## Fair scheduler

`AgentJobStore.claimNext(maxActive)` runs under `BEGIN IMMEDIATE`.

1. Refuse a claim when active jobs already equal the trusted global capacity.
2. Consider queued jobs ordered by each project's most recent `started_at` ascending.
3. Tie-break by job `created_at`, then SQLite `rowid`.
4. Skip projects that already have an executing job.
5. Skip jobs whose trusted logical resources conflict with ACTIVE or UNCERTAIN leases.
6. Atomically transition the selected job to PREPARING and acquire all its resource leases.

This deterministic least-recently-scheduled project policy prevents a long/repeated queue for one project from permanently starving other queued projects.

## Concurrency

Trusted configuration defaults to four active jobs and is bounded to 1..32. Callers cannot override it.

BE1A deliberately keeps same-project execution serialized. Same-worktree multi-writer is out of scope. Writer jobs automatically acquire the trusted registered worktree logical resource in addition to any configured resource claims.

## Resource model

Safe logical categories:

- worktree
- compose-project
- port
- database
- gpu
- provider-slot
- owner-host
- release-signing
- production-deployment
- shared-cache
- temp-root
- machine

Resource ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; separators that could encode paths or arbitrary selectors are rejected. `/tmp/q` is represented by a trusted logical temp-root id rather than exposing the host path.

The durable `execution_resource_leases` table has a partial unique index over held resource keys for states ACTIVE and UNCERTAIN. SQLite is the exclusion authority; in-memory state is not.

## Global exclusive work

Trusted project configuration may classify a project lane `globalExclusive`. Such a job acquires `machine:global-exclusive` and is admitted only when there is no active job and no ACTIVE/UNCERTAIN execution lease. While that lease is held, unrelated jobs are not admitted.

Production deployment, release signing, trust-root mutation, machine/WSL/runtime configuration, global credential rotation, singleton production-store migration, and security-critical authority reconfiguration must remain in global-exclusive trusted lanes unless separately proven safe.

## Crash and stale recovery

Startup reconciliation transitions orphaned PREPARING/RUNNING/VALIDATING jobs to FAILED_INFRASTRUCTURE and changes their ACTIVE execution leases to UNCERTAIN. UNCERTAIN leases still participate in the unique held-resource exclusion and therefore block conflicting work.

No timer silently releases uncertainty. The only store settlement seam requires exact job id + exact resource key + bounded recovery evidence and is intentionally not exposed through MCP. A future trusted recovery workflow may call it only after independent proof that mutation authority is safe to release.

## Cancellation

Cancellation remains job/principal scoped. Cancelling one project aborts only that job. Unrelated active projects continue. Leases settle in that job's execution finalizer; shutdown ambiguity instead marks leases UNCERTAIN.

## Read snapshot/cache

The engine exposes a bounded server-derived execution-fabric snapshot containing only configured capacity, per-project queued/active counts, safe logical held/waiting resources, global-exclusive state, and generation metadata.

The snapshot uses a one-entry generation cache. Dispatch, claim, cancellation, recovery, lease settlement during completion, and other engine scheduling mutations invalidate the generation. It never caches prompts, credentials, terminal output, arbitrary provider output, Docker configuration, or host paths.

## Control Center contract

The private executor exposes `/control-center/execution-fabric`. The gateway fetches it and filters all project-specific rows against the authenticated principal's project grants before returning it through `control_center_query` summary/resources views.

Authority remains server-side; frontend/product consumers cannot calculate or assert lease ownership.
