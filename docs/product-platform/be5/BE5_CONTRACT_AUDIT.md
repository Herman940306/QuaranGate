# BE5 Contract Audit

## Exact implementation base

BE5 starts from accepted BE4.5 route-integration commit `1806d818f75383e006208a32aaa1c352777d0120`, tree `4e5494a304358bbcf6c225341132a6223d7d439f`.

The dedicated worktree/branch was created from that exact object after verifying no existing BE5 branch/worktree collision.

## Authoritative entities and ownership

Current accepted contracts assign PostgreSQL product ownership for:
- groups and explicit group membership;
- messages and reactions;
- attachment metadata only;
- notifications;
- persisted approvals;
- autonomous-policy metadata;
- durable product events/outbox/replay cursor state.

These records are organization/workspace scoped and do not replace existing ACP/IDE/gateway/evidence authority stores.

Presence and typing are explicitly ephemeral product state and are not durable by default.

## Accepted collaboration API surface

V0 freezes product semantics for:
- list/create groups;
- list/post group messages;
- add message reactions;
- initiate/complete attachment metadata;
- list/create approvals;
- decide approval records.

The current product implementation uses `/api/product/**`; BE5 maps those V0 semantics into bounded same-origin routes under that architecture.

No accepted V0 endpoint exists for:
- editing/deleting messages;
- destructive attachment deletion;
- arbitrary group membership mutation;
- generic event publication;
- generic realtime command proxy;
- approval execution.

Those are not invented in BE5.

## Event/outbox contract

Accepted durable semantics:
- immutable server-generated event id;
- type + immutable event version;
- workspace-scoped ordered sequence semantics;
- actor and safe subject references;
- correlation id;
- bounded safe payload;
- cursor-based bounded replay;
- at-least-once delivery semantics;
- eventId client deduplication/idempotent consumption;
- authorization re-evaluated at replay/subscription time.

Exactly-once delivery is explicitly not claimed.

Durable event families accepted for BE5 include group/message/reaction/attachment, notification and approval lifecycle events.

## Realtime transport

The contracts describe Event Delivery Service responsibilities including WebSocket delivery, but they do not freeze an executable WebSocket vs SSE vs other transport contract, endpoint, handshake or runtime deployment.

BE5 therefore implements:
- durable event/outbox/replay core;
- a transport-neutral typed delivery interface;
- authenticated workspace subscription/resume contract;
- fan-out authorization inputs;
- bounded event envelope.

`LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED`.

No WebSocket/SSE listener or runtime is invented.

## Groups

Accepted group state includes workspace ownership, explicit membership and durable group events.

BE5 implements group create/list/read/update repository/service semantics with optimistic versioning and explicit membership tables. Because V0 does not freeze a group-membership mutation API, membership-change public routes are deferred; creator membership is established transactionally on group creation.

Group membership is product collaboration visibility only and does not grant QuaranGate operational authority.

## Messages and reactions

Accepted V0 routes freeze message list/create and reaction create semantics.

Message bodies are durable product content. BE5 bounds body length and rejects control-character log-injection shapes while treating HTML/script text as inert content. It does not introduce HTML rendering semantics or end-to-end encryption.

Message edit/delete event names exist in the future event family, but public edit/delete APIs are not frozen and are not implemented.

Reactions are message/user/workspace bound, use a bounded normalized vocabulary and idempotent uniqueness.

## Attachments

Physical content storage/provider remains an owner decision.

BE5 implements metadata only:
- server-generated attachment id;
- uploader;
- org/workspace;
- bounded original display name;
- content type;
- size;
- SHA-256 digest;
- scan state;
- opaque server-owned storage reference abstraction;
- status/version/timestamps.

`upload complete != safe`. Completion does not mark content trusted; a scan state of `clean` is required before safe availability may be represented.

No arbitrary provider URL/storage path or file proxy exists.

`LIVE_ATTACHMENT_STORAGE=UNAVAILABLE / NOT_CLAIMED`.

## Notifications

PostgreSQL ownership is accepted, but notification retention duration is explicitly owner-gated.

BE5 models notification state and leaves expiry/retention policy nullable/configurable rather than choosing a duration.

`NOTIFICATION_RETENTION=OWNER_DECISION_REQUIRED`.

Notification presence never authorizes access to its referenced subject; subject access must be re-authorized by the owning service.

## Presence and typing

Presence/typing are explicitly ephemeral and non-audit by default.

BE5 provides a testable in-process interface with short bounded TTL semantics and no durable history, location or device fingerprinting.

`LIVE_PRESENCE_TRANSPORT=UNAVAILABLE / NOT_CLAIMED`.

## Approvals

Accepted authority semantics:
- approval is a decision record, not a capability token;
- it binds org/workspace, action class, requester/approver, exact safe subject/resource, source/evidence digest where applicable, expiry, status, rationale/metadata and decision timestamps;
- decision never executes the operation;
- later execution must re-check current session, product context, mapped Principal, operational grant and current resource/version/preconditions.

BE5 uses bounded states `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `CANCELLED` because no different accepted terminology is present in current source.

## Autonomous policy metadata

PostgreSQL ownership is accepted. BE5 stores bounded product workflow policy metadata only: action class, enabled state, approval requirement and bounded numeric limits. It never stores or creates operational grants/scopes/target/GitHub/Docker/host authority.

No public autonomous-policy mutation endpoint is frozen in V0, so BE5 implements repository contracts only.

## Retention owner decisions

Current contracts explicitly leave retention owner-gated for:
- collaboration messages;
- attachments;
- notifications;
- presence;
- long-term product audit/analytics.

BE5 does not invent durations. Schema uses nullable expiry/deletion-policy metadata where needed and documents:
`COLLABORATION_RETENTION=OWNER_DECISION_REQUIRED`.

## Existing patterns reused

- BE1 HttpOnly product session and `assertCsrf` origin/token guard for mutations.
- Server-derived product user/org/workspace context; browser tenant/Principal/scope input is non-authoritative.
- Existing safe `success` / `failure` response envelope.
- PostgreSQL typed repository pattern with parameterized values and optimistic versions.
- BE1 audit principle: safe allow-listed metadata only.

## Live qualification

- `LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED`.
- `LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED`.
- `LIVE_ATTACHMENT_STORAGE=UNAVAILABLE / NOT_CLAIMED`.

Source/contracts/tests may qualify without fabricating these live states.
