# Product Backend Delta Matrix

Status categories:
- **ALREADY_SUPPORTED** — current backend can serve the product requirement without a new authority model.
- **ADAPTER_REQUIRED** — capability exists but needs a bounded product DTO/service adapter.
- **NEW_PRODUCT_SERVICE** — genuinely new backend domain/service.
- **NEW_INFRASTRUCTURE** — external platform/service required.
- **DEFERRED_OWNER_GATED** — implementation depends on later owner/security/privacy/runtime decisions or external qualification.

| Requirement | Classification | BE0 determination |
|---|---|---|
| Keycloak | NEW_INFRASTRUCTURE | Product identity/session broker; must not replace QuaranGate Principal authority. |
| PostgreSQL product layer | NEW_INFRASTRUCTURE | Needed for product relational state; current SQLite stores are specialized operational stores. |
| org/workspace/membership | NEW_PRODUCT_SERVICE | New product tenancy/domain model. |
| roles + per-user overrides | NEW_PRODUCT_SERVICE | Product authorization defaults only; final operational authority still intersects with QuaranGate grants. |
| product-user → QuaranGate principal mapping | NEW_PRODUCT_SERVICE | Explicit mapping/authority-intersection service required. |
| OpenBao | NEW_INFRASTRUCTURE | Product/provider secret custody; operational secret injection remains server-side. |
| Provider Configuration | NEW_PRODUCT_SERVICE | Product CRUD/validation layer; secret values write-only. |
| Agent Profiles | NEW_PRODUCT_SERVICE | Product configuration over existing ACP backend/profile/project choices. |
| persisted approvals | NEW_PRODUCT_SERVICE | Current apply confirmation is operational; product approval records require durable domain state. |
| Autonomous-mode policy | NEW_PRODUCT_SERVICE | Needs explicit bounded policy and human-review gates. |
| WebSocket/outbox/replay | NEW_PRODUCT_SERVICE | Current ACP uses polling and Control Center request/response. |
| Groups/messages/attachments | NEW_PRODUCT_SERVICE | No current collaboration domain. |
| notifications | NEW_PRODUCT_SERVICE | No durable product notification service. |
| presence/typing | NEW_PRODUCT_SERVICE | Ephemeral collaboration channel, separate from durable event log. |
| audio meetings | NEW_PRODUCT_SERVICE | Requires privacy/consent and media architecture decisions. |
| Zabbix adapter | NEW_INFRASTRUCTURE | External monitoring adapter. |
| OTel Collector + Tempo | NEW_INFRASTRUCTURE | External tracing pipeline. |
| rolling 24h/7d/30d statistics | NEW_PRODUCT_SERVICE | Current 2,048/24h in-memory activity is insufficient. |
| Universal Security Assessment | NEW_PRODUCT_SERVICE | New orchestrator/domain. |
| stack detection | NEW_PRODUCT_SERVICE | New bounded discovery engine. |
| capability registry | NEW_PRODUCT_SERVICE | New product registry describing scanner applicability/capabilities. |
| assessment sandbox | NEW_PRODUCT_SERVICE | New orchestration over existing governed execution, not generic Docker control. |
| scanner plugins | NEW_PRODUCT_SERVICE | Tool adapters plus explicit capability/egress/resource policies. |
| CI pipeline export | NEW_PRODUCT_SERVICE | Compiler/export service with generated artifacts, never implicit deployment. |
| finding/report/retest | NEW_PRODUCT_SERVICE | New normalized security-domain persistence/workflows. |
| recovery API | ADAPTER_REQUIRED | Existing bounded recovery/lifecycle logic exists but no broad product API should be inferred. |
| Tool Creator backend | NEW_PRODUCT_SERVICE | Governed creator/admission service required. |
| Skill Creator backend | NEW_PRODUCT_SERVICE | Governed creator/admission service required. |
| existing operational pages | ALREADY_SUPPORTED | Direct MCP + ACP + GitHub + Control Center already supply the authority-bearing operations. |
| F2A/BE1A cross-project concurrency | NEW_PRODUCT_SERVICE | Scheduler/lease/read-contract enhancement around existing ACP/execution core. |

## BE1A current assumptions proven in source

### Global/single-job assumptions
- Agent ACP job execution: globally serialized by `claimNext()`, which refuses new claims while any job is active.
- Agent queue selection: one global FIFO oldest-first query.
- ACP queued-job cap: one global bounded queue.
- Provider status: currently summarized globally rather than project-partitioned.
- Control Center active/queued counts: global aggregate.

### Existing project-scoped safety that must be retained
- Agent job rows already carry `project`.
- Writer jobs can be counted per project.
- Apply attempts exclude overlapping active attempts by job/project.
- live-writer leases already bind project + worktree + principal + owner identity.
- IDE enrollments/operations already bind principal/project/worktree/session.

### Resources that require explicit lease identities in BE1A
At minimum:
- writable worktree/path scope;
- Compose project;
- fixed/published port;
- database/schema or migration target;
- GPU allocation;
- provider/runtime slot where not safely shareable;
- owner-host operation scope;
- release/signing/trust material;
- production deployment target;
- mutable shared caches/registries where writes can conflict.
- globally shared test/runtime temp roots where the tool contract is exclusive. The current root Vitest wrapper uses the exclusive Unix temp root `/tmp/q`, so concurrent root Vitest executions across otherwise isolated worktrees can conflict. Current orchestration must serialize that shared test resource; future BE1A resource modeling should represent such shared temp roots as explicit leaseable resources where appropriate rather than assuming worktree isolation is sufficient.

### Operations that remain globally exclusive
Unless later independently proven narrower:
- production deployment;
- release signing/trust-root mutation;
- Docker-daemon or machine-wide runtime configuration;
- WSL/host restart or machine configuration;
- global credential rotation;
- migration of a singleton production store;
- security-critical authority reconfiguration.

### Governed read/control contract for frontend
Future Agent A consumption should use bounded read models for:
- per-project queue depth and active jobs;
- fair-scheduler state without internal prompts;
- held/waiting lease summaries with safe resource categories/identities;
- cancellation state;
- stale/crash recovery state;
- cache generation/invalidation metadata;
- global-exclusive lock state;
- capacity limits and denial reason codes.

The UI must not infer lease ownership or authority client-side.

### Explicit non-goal
BE1A does **not** solve multiple writers to the same project/worktree. One-writer-per-worktree remains mandatory. Same-project parallel mutation requires separate isolated worktrees, path/resource claims and governed merge/admission in a later capability.
