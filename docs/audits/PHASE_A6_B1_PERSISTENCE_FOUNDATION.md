# Phase A6-B1 — Persistence Foundation Closeout

## Verdict

PASS

## Implementation Commit

1a5ae2d974d34e402fdc5dd2a4e968ba6aa8fadb

## Parent

819ae215556bb8d403efac5bcb502231b72c7575

## Scope

- schema v3 persistence foundation
- durable apply-attempt lifecycle
- durable per-project/per-job active-attempt exclusion
- project quarantine
- restart recovery split
- atomic APPLIED persistence
- atomic DISCARDED persistence
- UNCERTAIN discard prohibition
- durable attempt/job foreign key
- durable job-derived attempt provenance
- artifact cache/index schema foundation
- A5/A6 hash semantic separation

## Critical Invariants

- generic transition cannot create APPLIED or DISCARDED
- markApplySuccess is sole APPLIED persistence path
- discardJob is sole DISCARDED persistence path
- startApplyAttempt derives durable provenance from agent_jobs
- only COMPLETED jobs admit attempts
- UNCERTAIN quarantines project and prevents discard of affected job

## Public A1 Schema

UNCHANGED

## Agent Tools Activated

NONE

## Docker Changed

NO

## Provider Calls Through Bridge

0

## Artifact Content in SQLite

NO

## Hash Semantics

change_set_hash:
A5 change-set/path-operation identity

artifact_hash:
future A6 content-authenticated approval artifact identity

## Validation

Observed results, run against commit 1a5ae2d974d34e402fdc5dd2a4e968ba6aa8fadb:

- `git diff --check`: PASS (clean, no whitespace/conflict markers)
- `npm run typecheck`: PASS (`tsc -p tsconfig.json --noEmit`, exit 0)
- `npm test` (full unit suite): PASS — 337/337 tests passed, 23/23 test files
- Focused suite (`npx vitest run tests/unit/agent-jobstore-migration.test.ts tests/unit/agent-jobstore.test.ts tests/unit/agent-apply-state.test.ts`): PASS — 85/85 tests passed (14 + 22 + 49)
- `npm run build` (`tsc -p tsconfig.json`): PASS (exit 0)

## Review History

- initial B1 implementation passed tests
- engineering-lead schema completeness review required remediation
- final closeout review discovered D1 generic disposition bypass
- final closeout review discovered D2 caller-controlled project identity/quarantine bypass
- bounded remediation closed both
- final adversarial reviewer returned PASS

## Deferred A6 Work

NOT IMPLEMENTED in B1:

- pristine STAGED_BEFORE capture
- POST capture
- canonical delta
- canonical manifest
- artifact blobs/volumes
- static host-base certification
- unified diff
- runtime agent_diff
- runtime agent_apply
- applier container
- bounded rollback execution
- runtime agent_discard activation
- guardedPaths matching semantics
- nested-mount enforcement

## Pre-existing Observation

`claimNext()` contains a pre-existing post-COMMIT read inside its transaction
try/catch, meaning a later read exception could attempt ROLLBACK after COMMIT.

Facts:

- pre-dates A6-B1
- not introduced by this batch
- not modified by this batch
- not a B1 blocker
- requires a future bounded remediation/hardening decision

## A6-B2

NOT STARTED

## A7

NOT STARTED
