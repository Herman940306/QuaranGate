# Product Service Boundaries

## Design principle

The new product platform is additive. It may orchestrate and present QuaranGate capabilities, but it must not become a bypass around the existing gateway/executor/ACP/GitHub authority planes.

## 1. Product Identity Service
Owns:
- Keycloak integration and product login/session;
- product user lifecycle;
- organization/workspace membership context.

Does not own:
- QuaranGate scopes;
- target/project/backend/profile grants;
- Docker/filesystem/GitHub operational authorization.

## 2. Product Authorization Service
Owns:
- product roles;
- workspace role defaults;
- bounded per-user overrides;
- product-feature visibility/action eligibility.

Its output is advisory until intersected with current QuaranGate Principal authority.

## 3. Principal Mapping Service
Owns:
- product user → QuaranGate Principal association;
- effective-authority intersection;
- mapping audit metadata;
- fail-closed handling when no valid operational principal exists.

It must never synthesize or widen QuaranGate grants from Keycloak/Entra claims.

## 4. Product Data Service
Backed by PostgreSQL in later waves. Owns:
- organizations/workspaces/memberships;
- preferences;
- Agent Profiles;
- collaboration metadata;
- approvals;
- notifications;
- security-assessment metadata.

It must not absorb the Agent job SQLite or IDE Session SQLite merely for architectural uniformity.

## 5. Provider Configuration Service
Owns:
- provider definitions and safe metadata;
- validation requests/results;
- user/org binding;
- model/config selection metadata.

Secret values are write-only and delegated to the secret custody service.

## 6. Secret Custody Service
Backed by OpenBao in later waves. Owns:
- encrypted/private provider credentials;
- version/rotation/revocation metadata;
- secret references.

Read DTOs return configured/masked metadata only. Raw secret retrieval is not a product API.

## 7. Agent Profile Service
Owns reusable product-level presets for:
- backend;
- ACP profile;
- project/workspace binding;
- resource policy;
- allowed tool/capability preferences where server policy permits.

Dispatch still goes through the existing ACP contract and server re-authorization.

## 8. Collaboration Service
Owns:
- groups/channels/DMs;
- messages/threads/reactions;
- attachments metadata;
- durable collaboration events;
- notifications;
- durable approvals.

Presence/typing are separate ephemeral channels.

## 9. Event Delivery Service
Owns:
- durable outbox;
- replay cursor;
- WebSocket delivery;
- reconnect semantics;
- event authorization.

It does not make ephemeral presence durable by default.

## 10. Observability Service
Owns product-facing durable metrics/traces:
- rolling 24h/7d/30d statistics;
- Zabbix adapter;
- OTel/Tempo integration;
- bounded aggregation.

The existing Control Center remains the authoritative current-runtime metadata surface until new data is independently sourced and qualified.

## 11. Security Assessment Service
Owns:
- stack fingerprint;
- capability registry;
- assessment plan;
- scanner orchestration;
- normalized findings;
- reports/retest;
- CI pipeline export.

It must execute through governed registered targets/disposable sandboxes and preserve stop conditions for destructive or production work.

## 12. Execution Concurrency Service (BE1A)
Owns:
- project-partitioned queues;
- fair scheduling;
- resource lease broker;
- capacity accounting;
- project-scoped cancellation;
- stale lease/crash recovery;
- bounded read snapshot/cache invalidation.

It extends existing ACP/execution semantics. It does not replace live-writer arbitration.

## 13. Recovery Service
Exposes only bounded, policy-defined recovery operations backed by proven lifecycle/recovery implementations. No generic Docker/host recovery API is allowed.

## 14. Tool/Skill Creator Service
Owns creation/admission workflow, schemas, validation and review metadata. Installation/activation must still cross explicit governed admission.

## Shared invariants
- server-side authority always wins;
- no client-calculated operational authorization;
- no raw secret value in reads/events/logs;
- all consequential writes use version/stale checks;
- destructive or production-affecting actions require explicit policy and human review where defined;
- one writer per worktree remains a hard invariant.
