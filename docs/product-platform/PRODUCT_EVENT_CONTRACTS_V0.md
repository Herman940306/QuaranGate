# Product Event Contracts V0

This defines a future product event contract only. No WebSocket/outbox runtime is created in BE0.

## Common envelope

```json
{
  "eventId": "evt_...",
  "type": "domain.event",
  "version": 1,
  "occurredAt": "ISO-8601",
  "workspaceId": "ws_...",
  "actor": {
    "productUserId": "usr_...",
    "principalId": "optional-safe-operational-id"
  },
  "subject": {
    "type": "resource-type",
    "id": "resource-id"
  },
  "sequence": 123,
  "correlationId": "request-or-operation-id",
  "data": {}
}
```

Rules:
- durable events use server-generated immutable event IDs and ordered workspace/domain sequence semantics;
- events carry only safe metadata;
- raw secrets, credentials, prompts, command output, file contents and provider secret values are forbidden;
- authorization is evaluated at subscription/replay time as well as event creation time;
- replay is cursor-based and bounded.

## Durable event families

### Groups/messages
- group.created
- group.updated
- group.member_added
- group.member_removed
- message.created
- message.updated
- message.deleted
- message.reaction_added
- attachment.ready
- attachment.rejected

### Notifications
- notification.created
- notification.read
- notification.dismissed

### Approvals
- approval.requested
- approval.decided
- approval.expired
- approval.cancelled

Approval events are decision-history events. They are not operational capability tokens.

### Meetings
- meeting.created
- meeting.started
- meeting.ended
- meeting.participant_joined
- meeting.participant_left
- meeting.recording_state_changed

Recording/transcription payload and retention require a separately approved privacy contract.

### Provider validation
- provider.validation_requested
- provider.validation_succeeded
- provider.validation_failed

Events may expose provider ID/type and safe error class but not secret material.

### Security
Selected normalized events:
- assessment.created
- assessment.started
- assessment.completed
- assessment.failed
- finding.created
- finding.updated
- finding.retest_completed
- pipeline_export.created

## Ephemeral event families

Presence and typing are explicitly non-durable by default:
- presence.changed
- typing.started
- typing.stopped

They:
- may use short TTLs;
- are not written to the durable outbox unless a later privacy/product decision says otherwise;
- must not be used as authoritative audit evidence.

## Delivery semantics

Target semantics:
- at-least-once delivery for durable events;
- client deduplication by eventId;
- ordered replay within the defined stream/partition;
- reconnect with last acknowledged cursor;
- bounded replay window plus durable database recovery path.

No exactly-once delivery claim is made.

## Authorization

A subscriber receives an event only if current server-side product membership and any applicable QuaranGate resource visibility permit it.

Historical access does not guarantee replay access after membership/grant revocation.

## Versioning

Event `type` + `version` are immutable contracts. Additive fields may be introduced compatibly. Breaking payload changes require a new event version.
