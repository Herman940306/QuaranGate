# BE6 Frontend Integration Contract

## Status

BE6 provides bounded read-only product APIs for Monitoring and Statistics. The frontend must render truth states and unavailable reasons exactly; it must not guess missing values, coerce missing telemetry to zero, or treat dashboard state as authority.

## Truth states

Allowed states:
- `READY`
- `DEGRADED`
- `UNKNOWN`
- `NOT_AVAILABLE`
- `NOT_IMPLEMENTED`
- `NOT_QUALIFIED`
- `DEFERRED`

## Common metric DTO

Every metric includes:
- `id`
- `label`
- `scope.organizationId`
- `scope.workspaceId`
- optional `scope.projectId`
- `observedAt`
- `window.requestedStart`
- `window.requestedEnd`
- optional `window.availableStart`
- optional `window.availableEnd`
- `window.supported`
- optional `window.reason`
- `freshness`
- `state`
- `unit`
- optional `value`
- `sampleCount`
- `provenance.source`
- `provenance.sourceDetail`
- `provenance.qualified`
- optional `unavailableReason`

Frontend must display unavailable/deferred/not-qualified values as such.

## Routes

Read-only same-origin product routes:

- `GET /api/product/observability/summary?windowMs=<bounded>`
- `GET /api/product/observability/hardware`
- `GET /api/product/observability/jobs?windowMs=<bounded>`
- `GET /api/product/observability/network`
- `GET /api/product/observability/security`
- `GET /api/product/statistics?windowMs=<bounded>&top=<1..20>`

All routes use the existing HttpOnly product session. Browser-supplied organization, workspace, principal, host, container, source, PromQL, SQL, Zabbix or Tempo parameters are ignored or not representable.

There are no BE6 mutation routes.

## Monitoring summary DTO

`/observability/summary` returns:
- `scope`
- `observedAt`
- overall `state`
- tab states for `hardware`, `jobs`, `network`, `security`
- safe metric list

The current source-qualified baseline usually reports hardware/network/security as `NOT_QUALIFIED` unless future live adapters are accepted.

## Hardware DTO

`/observability/hardware` returns:
- `state`
- `metrics`

Current live state: `LIVE_HARDWARE_TELEMETRY=UNAVAILABLE / NOT_CLAIMED`.

No browser host/device/path selection exists.

## Agent job-flow DTO

`/observability/jobs` returns:
- `state`
- product-event-derived `counts`
- `completedIsApplied: false`
- deferred concurrency metric when BE1A is not accepted

Do not infer `APPLIED` from `COMPLETED`.

ACP remains the canonical job lifecycle source. BE6 product stats from product events are labelled as product-derived, not ACP truth.

## Network DTO

`/observability/network` returns:
- `state`
- `metrics`

Current live source is unavailable to product service. No packet contents, firewall mutation, Tailscale mutation, arbitrary hostname query or network scanner exists.

## Security DTO

`/observability/security` returns:
- `state`
- `metrics`

Current source-qualified product API does not expose raw logs. Ambiguous telemetry must not be labelled as an attack or compromise.

## Statistics DTO

`/statistics` returns:
- `scope`
- `observedAt`
- requested and available window
- event counts from BE5 `product_events` where available
- top event types
- latency summary state
- token usage metric
- cost metric
- estimated savings metric

Percentile method: deterministic nearest-rank.

Token usage is `NOT_AVAILABLE` unless an authoritative provider/runtime source exposes usage. Cost is `NOT_AVAILABLE` unless authoritative usage and billing/rate basis exist. Estimated savings is `OWNER_DECISION_REQUIRED` until an explicit auditable owner formula exists.

## Window and retention semantics

Maximum supported product window in this source-qualified BE6 layer is 24h. Requests beyond the current accepted retention window return a truthful unsupported window with reason `OWNER_DECISION_REQUIRED_LONG_HORIZON_RETENTION`; the frontend must not synthesize 7d/30d from 24h data.

## Safe errors

Use existing product error envelopes. Do not display raw adapter messages. External adapter errors are normalized/redacted.

## Live qualification

- `LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_HARDWARE_TELEMETRY=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_TRACE_BACKEND=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_LONG_HORIZON_STATISTICS=UNAVAILABLE / NOT_CLAIMED`
