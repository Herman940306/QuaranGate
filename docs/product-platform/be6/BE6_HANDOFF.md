# BE6 Observability / Statistics Handoff

CHECKPOINT: BE6.0
STATUS: COMPLETE
IMPLEMENTED:
- exact accepted BE5 base/worktree preflight completed;
- direct observability/statistics source audit completed;
- desired metrics classified in BE6_CONTRACT_AUDIT.md;
- authority, retention and external-adapter boundaries frozen.
SOURCE OF TRUTH:
- current source/docs, Control Center docs, BE5 events, Product Data Ownership, Service Boundaries.
TESTS:
- read-only preflight/audit complete.
SECURITY:
- BE6 is a read model only; no dashboard state grants authority.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
- LIVE_HARDWARE_TELEMETRY=UNAVAILABLE / NOT_CLAIMED.
- LIVE_TRACE_BACKEND=UNAVAILABLE / NOT_CLAIMED.
- LIVE_LONG_HORIZON_STATISTICS=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- long-horizon retention remains OWNER_DECISION_REQUIRED.
NEXT:
- BE6.1 telemetry contracts and aggregation core.

CHECKPOINT: BE6.1-BE6.3
STATUS: COMPLETE
IMPLEMENTED:
- typed telemetry/truth-state/provenance DTO contracts;
- deterministic nearest-rank p50/p95 aggregation;
- explicit requested vs available window semantics;
- product-event-derived statistics with top-N bounds;
- token/cost/savings unavailable without authoritative provenance.
SOURCE OF TRUTH:
- BE5 product_events for product-derived statistics;
- Control Center/ACP remain operational authority sources.
TESTS:
- percentile/window/top-N tests PASS;
- focused BE1-BE6 PASS 144/144.
SECURITY:
- missing telemetry is never converted to zero;
- no raw payloads or secret-shaped values in DTOs/tests.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- long-horizon retention remains OWNER_DECISION_REQUIRED.
NEXT:
- BE6.4-BE6.8 external adapter boundaries and read APIs.

CHECKPOINT: BE6.4-BE6.8
STATUS: COMPLETE
IMPLEMENTED:
- hardware telemetry adapter boundary with trusted server config parser and fail-closed default;
- trace/Tempo adapter boundary with fail-closed default;
- operational read-model adapter boundary for network/security Control Center data;
- provider configuration/product-event derived summaries;
- completed-is-not-applied invariant in job DTOs.
SOURCE OF TRUTH:
- current docs/source for Zabbix/Tempo/Control Center/ACP boundaries.
TESTS:
- unavailable adapter tests PASS;
- completed-vs-applied test PASS;
- cross-workspace fail-closed test PASS.
SECURITY:
- no generic Zabbix/Tempo/SQL/PromQL/proxy exposed;
- no browser host/container/source selector.
LIVE QUALIFICATION:
- LIVE_HARDWARE_TELEMETRY=UNAVAILABLE / NOT_CLAIMED.
- LIVE_TRACE_BACKEND=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- live external telemetry endpoint/auth/query contracts absent.
NEXT:
- BE6.9-BE6.11 API and frontend contract.

CHECKPOINT: BE6.9-BE6.11
STATUS: COMPLETE
IMPLEMENTED:
- bounded 24h window-capable APIs;
- unsupported 7d/30d truthfully marked unavailable/owner-gated;
- six read-only product observability/statistics routes;
- frontend integration contract finalized.
SOURCE OF TRUTH:
- BE6 prompt, current product route conventions, BE6_CONTRACT_AUDIT.md.
TESTS:
- BE6 route contract tests PASS;
- focused BE1-BE6 PASS 144/144.
SECURITY:
- read-only routes only;
- no mutation, Docker admin, generic query, arbitrary host or hidden authority inputs.
LIVE QUALIFICATION:
- LIVE_LONG_HORIZON_STATISTICS=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- live PostgreSQL/external adapter/runtime qualification remains unclaimed.
NEXT:
- full validation, evidence and freeze.

CHECKPOINT: BE6.FREEZE
STATUS: COMPLETE
IMPLEMENTED:
- dependency-ready BE6 observability/statistics backend foundation completed;
- read-only API surface installed;
- source-qualified product-event statistics, provider-health summary, unavailable adapter boundaries and DTO contracts frozen;
- frontend contract and contract audit finalized.
SOURCE OF TRUTH:
- current source/docs/tests and BE6 validation evidence.
TESTS:
- typecheck PASS;
- lint PASS, zero warnings;
- focused BE1-BE6 PASS 144/144;
- full frontend/server suite PASS 151/151;
- production build PASS;
- npm audit PASS, 0 vulnerabilities;
- route-surface checks PASS;
- executable source security scans PASS;
- ownership/package/regression checks PASS;
- git diff --check PASS.
SECURITY:
- no mutation routes;
- no generic query/proxy;
- no Docker admin surface;
- no browser-selected host/source/container;
- no authority widening;
- no missing-to-zero conversion;
- no token/cost/savings fabrication.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
- LIVE_HARDWARE_TELEMETRY=UNAVAILABLE / NOT_CLAIMED.
- LIVE_TRACE_BACKEND=UNAVAILABLE / NOT_CLAIMED.
- LIVE_LONG_HORIZON_STATISTICS=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- external telemetry contracts and long-horizon retention remain owner/orchestrator decisions.
NEXT:
- independent/orchestrator review of frozen BE6 candidate.
