# BE4 OpenBao Custody + Provider Service Handoff

CHECKPOINT: BE4.0
STATUS: COMPLETE
IMPLEMENTED:
- exact accepted BE3 base/worktree preflight;
- direct BE0–BE3 provider/data/API/authority/security audit;
- read-only operational credential and runtime composition audit;
- custody, SSRF, distributed-consistency and authority boundaries frozen.
TESTS:
- read-only contract/source inspection complete.
OPEN GAPS:
- LIVE_OPENBAO=UNAVAILABLE / NOT_CLAIMED: no accepted endpoint/auth/mount/runtime topology exists.
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
NEXT:
- BE4.1 provider metadata migration/repository and BE4.2 custody abstraction.

CHECKPOINT: BE4.1-BE4.4
STATUS: COMPLETE
IMPLEMENTED:
- durable provider metadata migration 0003 with tenant/workspace FK, bounded kinds/status/validation, safe custody reference, optimistic version and timestamps;
- provider repository with membership/user/workspace/org isolation;
- server-only custody interface with store/resolve-at-use/delete/availability semantics;
- test memory custody denied outside test;
- OpenBao config/boundary with production HTTPS, bounded timeout/response constants and no default credentials/auth/mount invention;
- provider service create/list/get/update/replace-secret with server-derived custody namespace and compensating cleanup.
TESTS:
- focused BE1-BE4 suite PASS 84/84;
- typecheck PASS; lint PASS.
OPEN GAPS:
- LIVE_OPENBAO=UNAVAILABLE / NOT_CLAIMED;
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
NEXT:
- BE4.5 integration gate + BE4.6-BE4.9 qualification.

CHECKPOINT: BE4.5
STATUS: BLOCKED
IMPLEMENTED:
- exact intended same-origin route/envelope/CSRF/version contract documented in BE4_FE3_INTEGRATION_CONTRACT.md;
- provisional route implementation was removed after mandatory inherited regression.
TESTS:
- accepted BE1 route contract proves the entire product API tree is frozen to exactly five BE1 handlers.
OPEN GAPS:
- adding required BE4 provider routes conflicts with accepted BE1 test invariant; Agent B will not modify accepted BE1 tests.
NEXT:
- orchestrator/integration lane must explicitly supersede/reconcile the BE1 route-count invariant before FE3 HTTP wiring.

CHECKPOINT: BE4.6-BE4.9
STATUS: COMPLETE
IMPLEMENTED:
- bounded validation states separated from operational authority;
- versioned secret rotation and compensation semantics;
- tenant/provider-id/custody namespace defenses;
- no browser provider host/base URL/custody path;
- no generic network proxy;
- safe provider/audit DTOs;
- FE3 integration contract frozen without editing Agent A.
TESTS:
- write-only create/replace and no readback PASS;
- production test-custody denial PASS;
- unavailable custody fail-closed PASS;
- stale/compensation paths PASS;
- cross-user/workspace isolation PASS;
- namespace escape negative PASS;
- safe audit/DTO redaction PASS;
- no operational grant synthesis PASS.
OPEN GAPS:
- HTTP route installation remains BLOCKED_INTEGRATION as above.
NEXT:
- final source-only qualification/evidence; freeze only as a qualified partial candidate if all gates pass.

CHECKPOINT: BE4.FREEZE
STATUS: PARTIAL
IMPLEMENTED:
- dependency-ready BE4 server scope is complete and qualified;
- provider metadata persistence, server-only custody abstraction, fail-closed OpenBao boundary, provider service, validation, secret lifecycle/compensation, tenant/SSRF/confused-deputy defenses and FE3 integration contract are frozen;
- no provider HTTP routes were retained because doing so violates the accepted BE1 five-route invariant.
TESTS:
- typecheck PASS;
- lint PASS, zero warnings;
- focused/full frontend suite PASS 91/91;
- production build PASS;
- npm audit PASS, 0 vulnerabilities;
- migration/static schema validation PASS;
- bounded secret scan PASS;
- authority/SSRF/generic-proxy review PASS;
- ownership PASS;
- accepted BE1-BE3 test delta NONE;
- product API route delta NONE;
- git diff --check PASS.
OPEN GAPS:
- BE4.5 HTTP route installation is BLOCKED_INTEGRATION pending orchestrator reconciliation of accepted BE1 route-count contract.
- LIVE_OPENBAO=UNAVAILABLE / NOT_CLAIMED.
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
- no provider network validator is wired because no accepted provider endpoint/network policy contract exists.
NEXT:
- independent/orchestrator review of this qualified partial candidate;
- orchestrator must decide/reconcile the BE1 route invariant before a bounded BE4.5 integration candidate can be created.
