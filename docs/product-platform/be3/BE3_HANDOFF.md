# BE3 Principal Mapping Handoff

CHECKPOINT: BE3.0
STATUS: COMPLETE
IMPLEMENTED:
- exact accepted BE2 base/worktree verification;
- direct audit of gateway Principal, API-key/OAuth resolution and operational authorization boundaries;
- product consumption boundary frozen: Principal.id reference only, no product-owned grant snapshot or parallel authority evaluator;
- live Principal validation and live PostgreSQL qualification explicitly unavailable/not claimed.
TESTS:
- read-only source/contract inspection complete.
OPEN GAPS:
- no accepted live product-to-gateway Principal resolver exists; BE3 cannot claim live Principal enabled/grant verification.
NEXT:
- BE3.1 bounded PostgreSQL mapping migration/repository and fail-closed resolver.

CHECKPOINT: BE3.1
STATUS: COMPLETE
IMPLEMENTED:
- forward migration 0002_product_principal_mapping with user/org/workspace binding, Principal.id reference, lifecycle status, revision and timestamps;
- unique product-user/workspace mapping plus workspace/org referential integrity;
- server-only typed create/update/resolve repository;
- create is active-membership/product-user/workspace/org bound and parameterized;
- update requires expected mapping revision;
- resolution states: unmapped, mapped-reference, unavailable, forbidden;
- ambiguous/backend/stale results fail closed.
TESTS:
- focused BE1+BE2+BE3 suite PASS 67/67;
- typecheck PASS; lint PASS.
OPEN GAPS:
- Principal reference is intentionally not live-validated against gateway configuration because no accepted product-to-gateway authority resolver exists.
NEXT:
- BE3.2 session re-resolution, confused-deputy and audit qualification.

CHECKPOINT: BE3.2
STATUS: COMPLETE
IMPLEMENTED:
- workspace switch resolves mapping from server-held durable product-user + validated workspace context and never accepts a browser Principal id;
- same-context session reads re-resolve with expected mapping revision;
- stale mapping revision becomes unavailable and cannot retain the prior Principal reference;
- missing mapping has no privileged/default fallback;
- disabled/revoked mapping becomes forbidden;
- safe session exposes mapping state/reference/revision only, never operational grants or OIDC tokens;
- mapping lifecycle audit uses safe allow-listed product metadata and redacts repository errors.
TESTS:
- cross-user and cross-workspace parameter binding PASS;
- browser Principal spoof surface negative PASS;
- stale mapping invalidation PASS;
- disabled/revoked/unmapped/unavailable/ambiguous matrix PASS;
- product-role/no-operational-grant synthesis checks PASS;
- audit/error redaction PASS;
- focused BE1+BE2+BE3 suite PASS 67/67.
OPEN GAPS:
- live Principal enabled/grant/runtime-precondition verification remains gateway-owned and unavailable to this source-only product lane.
NEXT:
- BE3.3 full validation, evidence and candidate freeze.

CHECKPOINT: BE3.3
STATUS: COMPLETE
IMPLEMENTED:
- BE3 migration ownership reconciled without modifying accepted BE1/BE2 tests;
- aggregate migration reader composes accepted BE2 migration 0001 plus BE3 principal migration 0002 deterministically;
- final authority-boundary, ownership, secret and migration static reviews complete.
TESTS:
- typecheck PASS;
- lint PASS with zero warnings;
- focused BE1+BE2+BE3 suite PASS 67/67;
- full frontend unit suite PASS 75/75;
- Next production build PASS with accepted five product routes;
- npm audit PASS: 0 vulnerabilities;
- accepted BE1/BE2 test delta NONE;
- authority-copy grep PASS;
- migration static checks PASS;
- bounded secret scan PASS;
- ownership check PASS;
- git diff --check PASS.
OPEN GAPS:
- LIVE_PRINCIPAL_RUNTIME_QUALIFICATION=UNAVAILABLE / NOT CLAIMED: no accepted product-to-gateway live Principal resolver exists.
- LIVE_POSTGRESQL_QUALIFICATION=UNAVAILABLE / NOT CLAIMED: no governed disposable PostgreSQL target was exposed.
NEXT:
- bounded evidence manifest and immutable BE3 candidate freeze for independent/orchestrator review.

## Final BE3 scope

BE3 persists and resolves only a tenant-bound reference to the existing gateway-owned Principal identity. It does not persist, copy, infer or widen operational scopes/resource grants. Mapping absence, ambiguity, backend failure, stale revision and disabled/revoked state all fail closed. Workspace switching re-resolves from server-held product user/context, and same-context session reads revalidate the recorded mapping revision.

The product service still cannot claim that a referenced Principal currently exists, is enabled, or possesses any particular operational grant. Those facts remain owned and enforced by the existing QuaranGate gateway authority boundary.
