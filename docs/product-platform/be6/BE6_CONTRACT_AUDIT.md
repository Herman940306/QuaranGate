# BE6 Contract Audit

## Exact base

BE6 starts from accepted BE5 commit `08cf081e6e47f0296ce1f567de3e3a49cbf62b25`, tree `790043979c9c5267486ffb5c20b461bccddf59cf`, subject `feat(product): add BE5 collaboration events foundation`.

## Source audit summary

Current repository truth establishes:
- Control Center `control_center_query` is the existing bounded operational read model for current runtime metadata. It is read-only, metadata-only, scoped by current principal and backed by gateway/executor state. It has gateway-memory retention only: max 2,048 events, max 24 hours, max 200 rows/query.
- BE5 product events are durable product-domain events in PostgreSQL and are safe for product-derived statistics where the authenticated product session has workspace access.
- Provider configuration health exists in BE4 product metadata but live provider/OpenBao validation remains unclaimed.
- Product data ownership names Tempo and Zabbix as future observability owners, but no accepted endpoint/auth/query contract exists in source.
- Agent jobs and lifecycle remain ACP-owned. PostgreSQL may reference safe job ids/events but is not authoritative ACP state.
- Existing docs explicitly forbid fabricating unavailable values, converting missing telemetry to zero, exposing raw prompts/command output/file contents, or turning dashboards into authority.

## Metric classification

| Area | Metric family | Classification | Source of truth / limitation |
|---|---|---|---|
| Hardware | CPU/RAM/GPU/VRAM/temp/local-model utilization | D. EXTERNAL_OBSERVABILITY_ADAPTER | Zabbix/future telemetry named, but no live adapter contract. `LIVE_HARDWARE_TELEMETRY=UNAVAILABLE / NOT_CLAIMED`. |
| Agent job flows | queued/running/completed/failed/cancelled/current queue | A. EXISTING_OPERATIONAL_READ_MODEL | Control Center/ACP is canonical for live state. Product BE6 can expose adapter boundary only until a product bridge is accepted. |
| Agent job flows | applied/discarded distinction | A. EXISTING_OPERATIONAL_READ_MODEL | ACP job disposition is canonical. Completed is never inferred as applied. |
| Agent job flows | product-visible events about approvals/messages/providers | B. NEW_PRODUCT_DERIVED_METRIC | Derived from BE5 product events, not ACP truth. |
| Network | safe egress destination/policy/allow-deny metadata | A/D | Control Center and egress policy code are current safe metadata sources; no packet telemetry source or generic scanner. |
| Security | auth failures/authorization denials/runtime drift/provider failures/Docker-boundary state | A/D | Control Center is current operational source. BE6 exposes fail-closed adapter boundary and product event summaries only. |
| Provider health | configured/validation state | B | BE4 product provider metadata can provide product configuration health; live provider/OpenBao remains unclaimed. |
| Request counts | product event counts | B | Derived from BE5 product events in requested/available window. |
| p50/p95 latency | product events | E. NOT_AVAILABLE | BE5 events do not store duration. Operational latency exists only in Control Center retained metadata. |
| token usage | provider usage | E. NOT_AVAILABLE | No authoritative product/provider usage source in BE6 base. |
| cost | billing/rate data | E. NOT_AVAILABLE | No authoritative usage + billing/rate basis. |
| estimated savings | owner formula | F. OWNER_DECISION_REQUIRED | No accepted auditable formula. |
| 7d/30d statistics | long horizon history | F/E | Owner retention decision is not frozen; do not synthesize from 24h operational retention. |

## BE6 implementation boundary

BE6 implements:
- typed telemetry/truth-state DTOs;
- deterministic aggregation utilities;
- product-event-derived statistics for the authenticated workspace;
- fail-closed hardware, trace and operational read-model adapter contracts;
- bounded read-only product API routes;
- frontend integration contract.

BE6 does not implement:
- generic metrics/SQL/PromQL/Zabbix/Tempo proxy;
- host/container/Docker administration;
- packet/log/prompt/terminal/file-content capture;
- durable 7d/30d retention expansion;
- token/cost/savings estimates;
- operational authority.

## Live qualification

- `LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED` for live DB execution.
- `LIVE_HARDWARE_TELEMETRY=UNAVAILABLE / NOT_CLAIMED`.
- `LIVE_TRACE_BACKEND=UNAVAILABLE / NOT_CLAIMED`.
- `LIVE_LONG_HORIZON_STATISTICS=UNAVAILABLE / NOT_CLAIMED`.
