# Backend Implementation Sequence

## BE0 — current phase
Deliver documentation/contract freeze only:
- prove existing backend;
- classify product delta;
- define service/authority/API/event/data boundaries;
- reconcile legacy North-Star obligations;
- define BE1A constraints.

No live infrastructure or runtime behavior changes.

## BE1 — Product identity/session
Scope:
- Keycloak deployment design and bounded runtime composition;
- product OIDC session;
- account lifecycle;
- workspace selection context;
- product session → internal user identity;
- safe federation profile contract for Entra.

Acceptance focus:
- no IdP claim grants QuaranGate authority;
- session fixation/replay/logout/expiry negatives;
- no operational credential leakage;
- product session and MCP operational authentication remain distinguishable.

## BE1A — Cross-project concurrency/execution fabric
May start once BE1 identity/session contracts are stable.

Implement:
- project execution identity;
- project-partitioned queues;
- fair scheduler/starvation resistance;
- configurable bounded concurrency;
- async long-job dispatch;
- resource lease broker;
- project-scoped cancellation;
- crash/stale lease recovery;
- read snapshot/cache plus mutation invalidation;
- governed read/control surface.

Preserve:
- live-writer arbitration;
- one writer per worktree;
- project quarantine semantics;
- evidence/apply immutability.

Acceptance:
- at least four registered projects concurrently active;
- one long Project A job does not stall non-conflicting B-D;
- deterministic overlapping-resource serialization;
- non-conflicting owner-host concurrency;
- strict global-exclusive operations remain serialized;
- no starvation;
- cancellation project/job scoped;
- stale/crash recovery;
- cache invalidation;
- no cross-project filesystem/credential/Docker/evidence/control leakage.

## BE2 — PostgreSQL product platform
Can run alongside BE1A only if:
- writer paths are isolated;
- deployment resources do not overlap;
- schema ownership is explicit.

Implement core product relational model and migration discipline.

## BE3 — Principal mapping
Can overlap BE1A after BE1 contracts stabilize because it should primarily own product authority/mapping code rather than scheduler internals.

Implement:
- product-user → QuaranGate Principal mapping;
- effective authority intersection;
- fail-closed unmapped/disabled/stale mapping;
- audit metadata.

## BE4 — OpenBao/provider service
Introduce secret custody and safe provider configuration.

## BE5 — Collaboration/approvals/events
Introduce WebSocket/outbox/replay, groups/messages/attachments, notifications, presence/typing and persisted approvals/autonomous policy.

## BE6 — Observability/statistics
Introduce Zabbix, OTel Collector, Tempo and durable rolling analytics.

## BE7 — Audio meetings
Owner privacy/consent/retention decisions are now recorded and implemented in the recovered BE7 owner-policy source. Current policy is: per-meeting explicit recording opt-in; meeting-owner attestation plus persistent participant notice; transient raw-audio processing with verified cleanup; bounded workspace transcript retention; ephemeral summary/action content; LOCAL_ONLY STT; anonymous Speaker A/B labels; role-restricted audited transcript export. Live provider/storage qualification remains separate and must not be inferred from source qualification.

## BE8-B12 — Universal Security Assessment
Sequence:
1. discovery/planner;
2. governed assessment API/sandbox;
3. scanner plugins;
4. pipeline compiler/findings/report/retest;
5. QuaranGate adversarial harness.

Do not grant generic host/Docker execution as a shortcut.

## BE13 — Recovery + Tool/Skill Creator
Expose only bounded proven recovery actions and governed creator/admission workflows.

## BE14 — backend hardening/release
- tenant isolation negatives;
- secret leakage checks;
- outage/recovery;
- supply chain;
- final independent pentest support;
- release evidence.

## Safe parallelism after BE1

Recommended:
- BE1A scheduler/lease lane;
- BE2 product data lane;
- BE3 principal mapping lane;

Only when each uses separate worktrees and non-overlapping code/resource ownership.

Avoid concurrent changes to:
- `src/executor/agents/jobStore.ts`;
- common Principal/authority types;
- deployment composition;
- DB migration roots;
- shared release/security policy files.

These should have one explicit owner per integration wave.
