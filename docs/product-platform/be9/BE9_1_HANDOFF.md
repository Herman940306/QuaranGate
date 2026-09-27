# BE9.1 — Security assessment lifecycle foundation

Status: `SOURCE_CANDIDATE / NOT_SELF_ACCEPTED`

Base: `324abd6da9360197b3af28bfcc95fc7c987a1cdd`

This slice implements only the BE9.1 domain, state-machine and in-memory persistence foundation for governed security assessments.

Implemented:

- closed BE9 lifecycle vocabulary;
- legal transition table and fail-closed illegal transition rejection;
- terminal-state immutability;
- `CLEANUP_FAILED` override helper for cleanup uncertainty;
- tenant/user/workspace/Principal-bound assessment ownership;
- immutable BE8 discovery and deterministic-plan snapshot digests;
- in-memory repository with persistence/reload fixture support;
- optimistic expected-version transition writes;
- sensitive-material rejection for persisted snapshots;
- explicit exclusion of BE11 finding/report/retest schema concepts.

Not implemented in BE9.1:

- product assessment routes;
- MCP assessment tools;
- operational bridge;
- source staging;
- Docker Authority assessment sandbox;
- scanner plugins / BE10 behavior;
- BE11 findings, reports or retests;
- PostgreSQL migration.

Migration governance:

- current accepted migration high-water mark: `0006_meeting_privacy_policy.sql`;
- next nominal migration number would be `0007`;
- no BE9 migration was allocated in this slice because the parked LF0 worktree currently has dirty product migration files;
- BE9.1 therefore remains a non-colliding source-only foundation slice.

Independent review is required before BE9.2 or any migration allocation.
