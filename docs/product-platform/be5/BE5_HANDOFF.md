# BE5 Collaboration / Approvals / Events Handoff

CHECKPOINT: BE5.0
STATUS: COMPLETE
IMPLEMENTED:
- global engineering policy recalled;
- exact BE4.5 base/worktree/branch verified and dedicated BE5 worktree created;
- BE0-BE4 plus BE5 roadmap/frontend contracts audited directly;
- durable vs ephemeral, authority, privacy, retention and transport boundaries frozen in BE5_CONTRACT_AUDIT.md.
TESTS:
- read-only source/contract preflight complete.
SECURITY:
- collaboration/approvals remain product state, never operational capability;
- secret/raw operational payload storage is prohibited.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
- LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED.
- LIVE_ATTACHMENT_STORAGE=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- collaboration/attachment/notification retention duration remains OWNER_DECISION_REQUIRED;
- no accepted concrete realtime transport exists.
NEXT:
- BE5.1 durable event/outbox/replay migration and repository.

CHECKPOINT: BE5.1
STATUS: COMPLETE
IMPLEMENTED:
- forward migration 0004 for workspace event sequences, append-only events and durable replay cursor state;
- immutable event IDs, type/version, actor/subject, aggregate version, sequence, correlation, bounded JSON payload and delivery metadata;
- workspace stream uniqueness and event idempotency key.
TESTS:
- migration order/checksum PASS;
- event sequence append, idempotency, payload redaction and cursor validation PASS.
SECURITY:
- event payload recursively rejects secret/credential/authority keys and common secret shapes.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- no live PostgreSQL constraint execution.
NEXT:
- BE5.2 outbox/replay semantics.

CHECKPOINT: BE5.2
STATUS: COMPLETE
IMPLEMENTED:
- at-least-once durable replay semantics;
- opaque bounded replay cursor;
- current membership re-authorization on replay;
- typed durable consumer cursor initialize/read/advance with optimistic version;
- duplicate event delivery is tolerated through immutable eventId and idempotency key.
TESTS:
- replay order/page/cross-workspace parameter binding PASS;
- durable cursor stale-version failure PASS;
- malformed cursor failure PASS.
SECURITY:
- no exactly-once claim; no cross-workspace replay primitive.
LIVE QUALIFICATION:
- LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- no accepted WebSocket/SSE runtime transport.
NEXT:
- BE5.3 groups.

CHECKPOINT: BE5.3
STATUS: COMPLETE
IMPLEMENTED:
- workspace-bound groups and explicit group membership;
- creator membership established as owner;
- list/read/create/update service/repository semantics;
- optimistic group updates.
TESTS:
- create/list/update and membership isolation PASS.
SECURITY:
- group membership never maps to operational authority.
LIVE QUALIFICATION:
- source/contracts only.
OPEN GAPS:
- public membership mutation is DEFERRED because V0 freezes no membership-change API.
NEXT:
- BE5.4 messages.

CHECKPOINT: BE5.4
STATUS: COMPLETE
IMPLEMENTED:
- durable group messages with bounded body, author/context, cursor pagination and optimistic revision field;
- message-created events exclude message body content.
TESTS:
- create/read/pagination binding PASS;
- cross-tenant negative PASS;
- HTML/script text remains inert data;
- malformed Unicode/control-character rejection PASS.
SECURITY:
- no raw message body in event/audit payloads.
LIVE QUALIFICATION:
- source/contracts only.
OPEN GAPS:
- COLLABORATION_RETENTION=OWNER_DECISION_REQUIRED;
- public edit/delete is DEFERRED because V0 does not freeze those endpoints.
NEXT:
- BE5.5 reactions.

CHECKPOINT: BE5.5
STATUS: COMPLETE
IMPLEMENTED:
- message/user/workspace-bound normalized reaction keys;
- database uniqueness plus idempotent repeat behavior;
- reaction event idempotency key.
TESTS:
- idempotency and active-membership isolation PASS.
SECURITY:
- reaction state has no authority effect.
LIVE QUALIFICATION:
- source/contracts only.
OPEN GAPS:
- none in accepted V0 scope.
NEXT:
- BE5.6 attachment metadata.

CHECKPOINT: BE5.6
STATUS: COMPLETE
IMPLEMENTED:
- metadata-only attachment lifecycle with server-generated opaque storage reference;
- uploader/org/workspace, content type, size, digest, scan state, status, version and retention-ready nullable metadata;
- internal scan-state transition: clean=>safe, infected=>rejected, error=>uploaded.
TESTS:
- bounds/digest/state tests PASS;
- upload-complete != safe PASS;
- storage path/URL browser injection negative PASS.
SECURITY:
- no physical storage path/provider URL in safe DTO;
- no generic file proxy.
LIVE QUALIFICATION:
- LIVE_ATTACHMENT_STORAGE=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- ATTACHMENT_RETENTION=OWNER_DECISION_REQUIRED.
NEXT:
- BE5.7 notifications.

CHECKPOINT: BE5.7
STATUS: COMPLETE
IMPLEMENTED:
- workspace/user-scoped notification persistence;
- idempotent creation and optimistic read transition;
- nullable expiry supports later retention policy.
TESTS:
- user/workspace isolation and read transition PASS.
SECURITY:
- safe notification DTO intentionally omits referenced-object ids until a domain re-authorization adapter exists.
LIVE QUALIFICATION:
- source/contracts only.
OPEN GAPS:
- NOTIFICATION_RETENTION=OWNER_DECISION_REQUIRED;
- no arbitrary notification-target API added.
NEXT:
- BE5.8 presence/typing.

CHECKPOINT: BE5.8
STATUS: COMPLETE
IMPLEMENTED:
- typed process-local ephemeral presence and typing store;
- bounded TTL expiry;
- workspace/group isolation;
- no durable history, location or device fingerprint metadata.
TESTS:
- TTL expiration PASS.
SECURITY:
- presence/typing never grants authority and is not durable audit evidence.
LIVE QUALIFICATION:
- LIVE_PRESENCE_TRANSPORT=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- no accepted realtime transport.
NEXT:
- BE5.9 approvals.

CHECKPOINT: BE5.9
STATUS: COMPLETE
IMPLEMENTED:
- persisted approval records with PENDING/APPROVED/REJECTED/EXPIRED/CANCELLED states;
- requester/decision user, action class, safe subject, evidence digest, correlation, optional expiry/rationale and version;
- create/list/decide plus repository cancel/expire semantics;
- approval lifecycle durable events.
TESTS:
- create, approve/reject route/service contract, stale version, expiry and cancellation PASS.
SECURITY:
- approval record has explicit no-operational-authority invariant;
- no approval endpoint invokes an operational mutation.
LIVE QUALIFICATION:
- source/contracts only.
OPEN GAPS:
- special approver-role policy is not frozen; current record operations require active workspace membership and remain non-executing.
NEXT:
- BE5.10 autonomous policy metadata.

CHECKPOINT: BE5.10
STATUS: COMPLETE
IMPLEMENTED:
- workspace-scoped autonomous policy metadata with action class, enabled state, approval requirement, bounded max operations and optimistic version;
- repository create/read/update only; no browser policy-bypass route.
TESTS:
- create/update/versioning/no-authority PASS.
SECURITY:
- policy source contains no Principal/MCP/target/GitHub/Docker/host grant synthesis.
LIVE QUALIFICATION:
- source/contracts only.
OPEN GAPS:
- no public V0 policy mutation API is frozen.
NEXT:
- BE5.11 product API.

CHECKPOINT: BE5.11
STATUS: COMPLETE
IMPLEMENTED:
- bounded same-origin routes for groups/messages/reactions/attachment metadata/approvals and read-only event replay;
- every mutation reuses BE1 session and CSRF/origin checks;
- browser tenant/Principal/scope/grant/storage authority inputs are ignored.
TESTS:
- exact BE5 route surface PASS;
- CSRF/origin negatives PASS;
- session-derived delegation PASS;
- no generic publish/proxy/approval-execute route PASS.
SECURITY:
- safe existing product envelopes/errors reused.
LIVE QUALIFICATION:
- source/contracts only.
OPEN GAPS:
- none for accepted V0 route scope.
NEXT:
- BE5.12 realtime transport boundary.

CHECKPOINT: BE5.12
STATUS: COMPLETE
IMPLEMENTED:
- transport-neutral delivery interface and authenticated workspace delivery context;
- durable replay/resume contract remains independent of transport selection;
- unavailable transport implementation fails closed.
TESTS:
- unavailable transport fail-closed PASS.
SECURITY:
- event replay re-authorizes current product membership.
LIVE QUALIFICATION:
- LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- WebSocket/SSE/other transport selection remains intentionally unchosen.
NEXT:
- full BE5 validation, frontend handoff, evidence and immutable candidate freeze.

CHECKPOINT: BE5.FREEZE
STATUS: COMPLETE
IMPLEMENTED:
- all dependency-ready BE5 durable collaboration/approval/event scope complete;
- final frontend integration contract complete;
- no unaccepted realtime/storage/retention implementation invented.
TESTS:
- typecheck PASS;
- lint PASS, zero warnings;
- focused BE1-BE5 PASS 131/131;
- full frontend unit suite PASS 138/138;
- production Next.js build PASS;
- npm audit PASS, 0 vulnerabilities;
- migration/static schema checks PASS;
- event/order/replay checks PASS;
- tenant-isolation scan PASS;
- approval-no-authority scan PASS;
- bounded secret scan PASS;
- ownership PASS;
- git diff --check PASS.
SECURITY:
- collaboration/approvals/events remain product state only;
- no generic event publish/proxy/approval execution;
- no browser Principal/scope/grant authority;
- no raw secrets/prompts/terminal output stored in BE5 product state.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED;
- LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED;
- LIVE_ATTACHMENT_STORAGE=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- collaboration/attachment/notification retention durations remain OWNER_DECISION_REQUIRED;
- no live realtime transport selected;
- no physical attachment storage selected.
NEXT:
- immutable BE5 candidate freeze and independent/orchestrator review.

CHECKPOINT: BE5.1-BE5.2
STATUS: COMPLETE
IMPLEMENTED:
- durable product event/outbox schema with workspace-scoped monotonic sequences;
- safe bounded event payload contract and secret/authority redaction checks;
- idempotency key handling;
- cursor-based bounded replay with current user/workspace membership recheck;
- at-least-once delivery semantics; exactly-once is not claimed.
TESTS:
- migration order/checksum checks PASS;
- event append/order/idempotency/replay tests PASS;
- safe payload redaction negatives PASS.
SECURITY:
- event payloads reject secret-shaped values and authority/grant keys;
- replay is tenant/workspace/user bound.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- live durable DB execution remains unavailable.
NEXT:
- BE5.3-BE5.10 domain services and routes.

CHECKPOINT: BE5.3-BE5.10
STATUS: COMPLETE
IMPLEMENTED:
- groups and explicit group membership schema/repository/service;
- messages with bounded inert text body and cursor pagination;
- idempotent bounded reactions;
- attachment metadata initiate/complete only, with uploaded != safe preserved;
- notifications with nullable owner-gated expiry;
- approval create/list/decision/cancel/expiry records;
- autonomous-policy metadata repository contracts;
- ephemeral presence/typing store with bounded TTL and no durable history;
- transaction-bound domain events for group/message/reaction/approval state changes where practical.
TESTS:
- group/message/reaction/attachment/notification/approval/policy repository tests PASS;
- malformed Unicode/control-character/message bound checks PASS;
- approval no-authority invariant PASS;
- presence/typing TTL expiry PASS.
SECURITY:
- collaboration membership never grants MCP/ACP/GitHub/Docker/host authority;
- approval decisions do not execute operations;
- attachment storage refs remain server-owned abstractions.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
- LIVE_ATTACHMENT_STORAGE=UNAVAILABLE / NOT_CLAIMED.
- LIVE_PRESENCE_TRANSPORT=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- retention durations remain OWNER_DECISION_REQUIRED;
- physical attachment storage remains deferred.
NEXT:
- BE5.11 API routes and BE5.12 transport boundary qualification.

CHECKPOINT: BE5.11-BE5.12
STATUS: COMPLETE
IMPLEMENTED:
- bounded same-origin routes for groups, group messages, message reactions, attachment metadata initiate/complete, approvals, approval decisions and read-only event replay;
- all mutations reuse BE1 session + CSRF/origin guard;
- no generic event publish endpoint;
- no generic storage URL/proxy;
- no notification target endpoint;
- no approval execution endpoint;
- transport-neutral realtime interface plus fail-closed unavailable adapter.
TESTS:
- BE5 route contract tests PASS 10/10;
- focused BE1-BE5 suite PASS 131/131;
- typecheck PASS;
- lint PASS, zero warnings.
SECURITY:
- browser tenant/Principal/scope/grant fields are not forwarded;
- event replay is read-only and session-scoped;
- safe error envelope redaction tested.
LIVE QUALIFICATION:
- LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- no WebSocket/SSE/live fanout selected or implemented because no accepted transport runtime contract exists.
NEXT:
- full validation, frontend integration contract, evidence and candidate freeze.

CHECKPOINT: BE5.FREEZE
STATUS: COMPLETE
IMPLEMENTED:
- durable BE5 source/contracts/tests for collaboration, approvals, notifications, attachment metadata, autonomous-policy metadata, ephemeral presence/typing, durable events/outbox/replay and bounded BE5 product APIs;
- frontend integration contract finalized;
- retention owner decisions and live transport/storage/database limitations documented honestly.
TESTS:
- typecheck PASS;
- lint PASS, zero warnings;
- focused BE1-BE5 suite PASS 131/131;
- full frontend unit suite PASS 138/138;
- production build PASS;
- npm audit PASS, 0 vulnerabilities;
- migration/static schema checks PASS;
- event/order/replay checks PASS;
- tenant-isolation scan PASS;
- approval-no-authority scan PASS;
- bounded secret scan PASS;
- ownership check PASS;
- git diff --check PASS.
SECURITY:
- no generic event publish/proxy/storage URL/approval execution route;
- browser Principal/scopes/grants ignored;
- collaboration/approval/policy state does not synthesize or widen operational authority;
- attachments remain metadata-only and uploaded != safe;
- durable events reject secrets/authority payloads.
LIVE QUALIFICATION:
- LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED.
- LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED.
- LIVE_ATTACHMENT_STORAGE=UNAVAILABLE / NOT_CLAIMED.
- LIVE_PRESENCE_TRANSPORT=UNAVAILABLE / NOT_CLAIMED.
OPEN GAPS:
- collaboration/message/attachment/notification/presence retention durations remain OWNER_DECISION_REQUIRED;
- no live WebSocket/SSE/fanout runtime selected;
- no live attachment storage backend selected;
- no live PostgreSQL runtime exercised.
NEXT:
- independent/orchestrator review of immutable BE5 candidate.
