# Product Data Ownership V0

## Principle

Do not migrate specialized operational stores into PostgreSQL merely to centralize persistence. Each store retains authority for the domain it already safely owns.

## PostgreSQL product database — future owner

Planned ownership:
- product users/profile metadata;
- organizations;
- workspaces;
- memberships;
- product roles and overrides;
- preferences;
- Agent Profiles;
- provider configuration metadata and secret references;
- groups/messages/reactions/attachment metadata;
- notifications;
- approvals/autonomous policy metadata;
- durable event outbox/replay cursor state;
- security assessments/plans/findings/retests/reports;
- durable statistics aggregates;
- Tool/Skill Creator metadata.

PostgreSQL does not store provider secret values.

## OpenBao — future owner

Planned ownership:
- provider credential secret values;
- user/org scoped secret material;
- versions/rotation lifecycle.

The product database stores only secret references plus safe metadata.

## Agent Control Plane SQLite — existing owner

Retains:
- agent jobs and lifecycle;
- normalized result/evidence references;
- provider admission/session state where currently defined;
- apply attempts and apply journal;
- project quarantine/apply state;
- live-writer lease state.

PostgreSQL may index safe cross-domain references to jobs, but it must not become the authoritative ACP state machine without a separately reviewed migration.

## IDE Session Control SQLite — existing owner

Retains:
- IDE enrollments;
- session identity/lifecycle;
- operation attribution;
- metadata-only events;
- writer binding/settlement fields.

## Gateway-owned auth state — existing owner

Retains current OAuth:
- registered client state;
- access/refresh token hash records;
- short-lived process-local authorization-code state.

BE1 may introduce Keycloak product sessions, but those sessions do not silently replace MCP OAuth/API-key semantics.

## Trusted configuration — existing owner

Current principal/grant configuration remains QuaranGate authority source until an explicit reviewed authority-management design replaces or adapts it.

Product roles are not a substitute.

## Evidence/artifacts — existing owner

Machine-derived agent/release/security evidence remains in its governed immutable/local evidence locations according to current architecture. Product DB rows may reference digests/identities but must not rewrite accepted evidence.

## Attachments — deferred owner decision

The physical attachment store is not selected in BE0.

Required future properties:
- content digest;
- size/type bounds;
- malware/security scan state;
- workspace ownership;
- retention/deletion policy;
- no public-by-default access;
- object identity separated from user-supplied filename.

## Observability stores

Future:
- Tempo owns traces when introduced;
- Zabbix remains an external monitoring source;
- PostgreSQL/product analytics may own derived durable rolling aggregates.

Existing Control Center in-memory metadata remains a current-state source, not historical warehouse truth.

## Retention decisions still owner-gated

BE0 does not invent retention for:
- collaboration messages;
- attachments;
- notifications;
- presence;
- audio/recordings/transcripts;
- security findings/reports;
- long-term audit/analytics.

Those require explicit product/privacy policy before implementation.
