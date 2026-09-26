# BE2 PostgreSQL Product Data Foundation Handoff

Base: `c84d32d4dbb4636a4a9a676137b4f969854bae1f`
Base tree: `7605bc9b0a002706da4f6f0b6b3c6b41fd11ec65`

This working handoff is updated after each dependency-ready BE2 subsection.

CHECKPOINT: BE2.0
STATUS: COMPLETE
IMPLEMENTED:
- exact BE2 worktree/branch/base/tree verified clean with empty staging;
- accepted BE1 authority/data contracts re-read;
- governed target inventory checked; no PostgreSQL-specific disposable test target is exposed;
- selected `pg@8.23.0` (MIT) with `@types/pg@8.23.1` (MIT);
- npm audit after dependency addition reported zero vulnerabilities.
TESTS:
- repository identity/preflight PASS;
- dependency metadata/license review PASS;
- npm audit PASS.
OPEN GAPS:
- live PostgreSQL qualification is not yet available on a governed disposable database surface.
NEXT:
- BE2.1 deterministic schema and migration contract.

CHECKPOINT: BE2.1
STATUS: COMPLETE
IMPLEMENTED:
- deterministic forward-only migration `0001_product_context.sql`;
- product users, organizations, workspaces, memberships, product-role defaults, per-user permission overrides and preferences;
- issuer+subject uniqueness, workspace/org composite integrity, explicit foreign keys and product-only permission namespace;
- nonnegative version fields and `timestamptz` timestamps;
- migration source loader/checksum contract and migration registry;
- single transaction owner in the migration runner; trusted migration source SQL only.
TESTS:
- frontend typecheck PASS;
- lint PASS;
- static SQL contract checks PASS for uniqueness, tenant integrity, version constraints, timestamps, product permission namespace and absence of credentials.
OPEN GAPS:
- migration has not yet been executed against a live disposable PostgreSQL instance.
NEXT:
- BE2.2 typed database/repository layer and transaction behavior.

CHECKPOINT: BE2.2
STATUS: COMPLETE
IMPLEMENTED:
- server-only PostgreSQL pool, transaction helper and typed repositories;
- product-user issuer+subject find/create, visible organization/workspace reads, membership resolution, product-role merge and optimistic preference updates;
- all repository values are parameterized; no user-derived SQL identifiers.
TESTS:
- typecheck PASS; lint PASS;
- repository contract tests PASS.
OPEN GAPS:
- live PostgreSQL execution remains unqualified because no governed disposable DB target is exposed.
NEXT:
- BE2.3 BE1 durable product-context integration.

CHECKPOINT: BE2.3
STATUS: COMPLETE
IMPLEMENTED:
- BE1 callback now carries verified issuer into the product-context adapter;
- PostgreSQL adapter resolves verified issuer+subject to durable product-user id;
- workspace switching validates durable membership;
- raw OIDC tokens remain only in the BE1 server-side session and are not passed to PostgreSQL;
- principal mapping remains BE1 reference/state only; no operational grant synthesis.
TESTS:
- focused BE1+BE2 tests PASS 34/34;
- durable adapter cross-user/workspace isolation assertion PASS;
- typecheck PASS; lint PASS.
OPEN GAPS:
- auth-session persistence remains intentionally separate and production memory sessions still fail closed.
NEXT:
- BE2.4 privacy/isolation/API/error-contract qualification and full validation.

CHECKPOINT: BE2.4
STATUS: COMPLETE
IMPLEMENTED:
- deterministic repository/API contract tests for product-user identity, tenant visibility, workspace membership, product roles, preferences, transactions and safe HTTP errors;
- no new browser database/query endpoint; accepted BE1 five-route API remains stable;
- cross-user and cross-workspace requests are bound to product-user identity and return no repository record when unauthorized;
- product-role output is constrained to product-space permissions and cannot synthesize operational grants;
- stale preference writes return typed conflict semantics;
- accepted BE1 test files remain unchanged.
TESTS:
- focused BE1+BE2 qualification PASS;
- full frontend unit suite PASS 56/56;
- typecheck PASS; lint PASS with zero warnings;
- parameterized-query injection negative PASS;
- cross-user/workspace isolation PASS;
- safe error redaction PASS;
- transaction rollback PASS.
OPEN GAPS:
- no live disposable PostgreSQL target is exposed, so live DB constraint/migration/backup-restore qualification remains unclaimed.
NEXT:
- BE2.5 final build/SCA/static SQL/secret/ownership validation, evidence and freeze.

CHECKPOINT: BE2.5
STATUS: COMPLETE
IMPLEMENTED:
- final source/static qualification, dependency/SCA review, ownership and secret-boundary checks;
- recovery policy documented as forward corrective migration or backup/restore, not destructive down-migration;
- ignored-by-root-pattern product data files identified for explicit force-staging without changing shared .gitignore.
TESTS:
- typecheck PASS;
- lint PASS with zero warnings;
- focused BE1+BE2 tests PASS 34/34;
- full frontend tests PASS 56/56;
- Next production build PASS with the accepted five product routes;
- npm audit PASS: 0 vulnerabilities;
- migration/static SQL validation PASS;
- bounded secret scan PASS;
- git diff --check PASS;
- ownership namespace check PASS.
OPEN GAPS:
- LIVE_POSTGRESQL_QUALIFICATION=UNAVAILABLE: no governed disposable PostgreSQL target was exposed. Live migration execution, database constraint execution, DB-role least privilege, backup/restore and recovery drills are not claimed.
NEXT:
- evidence manifest and immutable BE2 candidate freeze for independent/orchestrator review.

## Final BE2 scope

BE2 owns durable product context only: product users, organizations, workspaces, memberships, product-role defaults/overrides and preferences. BE1 OIDC token custody remains server-session-only. Final product-user to QuaranGate Principal mapping remains BE3. No operational MCP/ACP/GitHub/Docker/host grant is stored or synthesized by BE2.
