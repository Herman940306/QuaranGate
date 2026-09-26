# BE5 Frontend Integration Contract

## Status

BE5 source implements durable collaboration/approval/event contracts and bounded same-origin product APIs. Live PostgreSQL, realtime transport and attachment storage are unavailable/not claimed.

## Safe group DTO

Fields: `id`, `organizationId`, `workspaceId`, `name`, `status`, `version`, `createdBy`, `createdAt`, `updatedAt`.

Group membership is collaboration visibility only. It does not grant operational authority.

## Safe message DTO

Fields: `id`, `groupId`, `organizationId`, `workspaceId`, `authorProductUserId`, `body`, `version`, `createdAt`, optional `editedAt`.

Message `body` is inert product text. The frontend must not treat it as trusted HTML or execute scripts.

Pagination uses opaque `cursor` values returned by the server.

## Reaction semantics

`POST /api/product/messages/{id}/reactions` accepts a bounded `reaction` key. Reactions are idempotent per user/message/reaction and have no authority effect.

## Attachment metadata and scan-state semantics

`POST /api/product/attachments/initiate` records metadata only: display name, content type and size.

`POST /api/product/attachments/{id}/complete` records a digest and moves metadata to uploaded/pending state.

`uploaded` does not mean safe. Content is not safe/available until a server scan state says clean. Physical upload/storage is not implemented in BE5.

The frontend must not send storage paths, storage URLs or provider URLs.

## Notification DTO

Notifications expose safe summary metadata only. Notification presence does not authorize access to referenced objects; referenced object reads must be re-authorized by their owning service.

Notification retention duration is `OWNER_DECISION_REQUIRED`.

## Approval DTO and states

States: `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `CANCELLED`.

Approval records are decision records, not capability tokens. `APPROVED` does not execute the operation. Any future execution workflow must still re-check current session, product context, mapped Principal, operational grant and live resource/preconditions.

## Event/replay envelope

Safe event shape:
- `eventId`
- `type`
- `version`
- `occurredAt`
- `workspaceId`
- optional actor product user reference
- subject type/id
- monotonic sequence
- correlation id
- safe data object

Replay is `GET /api/product/events?cursor=&limit=` and returns a bounded page with optional `nextCursor`. Delivery semantics are at-least-once; clients should deduplicate by event id.

## Routes

Implemented routes:
- `GET /api/product/groups`
- `POST /api/product/groups`
- `GET /api/product/groups/{id}/messages?cursor=&limit=`
- `POST /api/product/groups/{id}/messages`
- `POST /api/product/messages/{id}/reactions`
- `POST /api/product/attachments/initiate`
- `POST /api/product/attachments/{id}/complete`
- `GET /api/product/approvals`
- `POST /api/product/approvals`
- `POST /api/product/approvals/{id}/decision`
- `GET /api/product/events?cursor=&limit=`

Not implemented:
- generic event publish;
- generic realtime command proxy;
- arbitrary storage URL/path;
- notification target mutation;
- approval execution;
- message edit/delete;
- destructive attachment deletion;
- group membership mutation public API.

## CSRF rules

All mutations require the existing BE1 product session and CSRF/origin checks:
- same-origin request context;
- valid `x-csrf-token` matching the server-held session;
- server-derived product user/org/workspace.

Browser-supplied tenant, Principal, scope, grant or storage authority is ignored.

## Safe errors

Responses use the existing product envelope. Raw database errors, secrets, host paths, operational grants and inaccessible tenant metadata must not be rendered.

## Retention limitations

Current retention decisions remain owner-gated for:
- collaboration messages;
- attachments;
- notifications;
- presence/typing;
- long-term product analytics/audit.

BE5 schema is designed to support future retention policy without inventing one now.

## Integration availability

- `LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_REALTIME_TRANSPORT=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_ATTACHMENT_STORAGE=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_PRESENCE_TRANSPORT=UNAVAILABLE / NOT_CLAIMED`

Source contracts and deterministic tests are qualified; live runtime is not.
