# BE7 Frontend Integration Contract

## Scope

This contract describes only the dependency-ready BE7 backend foundation. It does not authorize recording, microphone capture, raw-audio upload, live transcription, transcript-body persistence, generated summary persistence, export/download, or speaker identification.

## Truth vocabulary

Frontend must render these states literally and must not infer capability:
- `AVAILABLE`
- `DISABLED`
- `NOT_AVAILABLE`
- `OWNER_DECISION_REQUIRED`
- `PROCESSING`
- `FAILED`

## Meeting DTO

```ts
interface MeetingDto {
  id: string;
  organizationId: string;
  workspaceId: string;
  createdBy: string;
  title: string;
  state:
    | "DRAFT" | "READY" | "ACTIVE" | "STOPPED"
    | "PROCESSING" | "COMPLETED" | "FAILED"
    | "CANCELLED" | "EXPIRED";
  recordingState: "OWNER_DECISION_REQUIRED";
  transcriptionState: "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";
  summaryState: "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";
  retentionState: "OWNER_DECISION_REQUIRED";
  version: number;
  participants: MeetingParticipantDto[];
  createdAt: string;
  updatedAt: string;
}
```

`ACTIVE` describes the meeting session only. It does **not** mean recording is active.

## Participant DTO

```ts
interface MeetingParticipantDto {
  productUserId: string;
  role: "owner" | "participant";
  consentState: "OWNER_DECISION_REQUIRED";
}
```

BE7 does not fabricate participant consent. Additional participant mutation is not exposed in this dependency-ready surface.

## Transcript DTO

```ts
interface TranscriptDto {
  meetingId: string;
  state: "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";
  contentAvailable: false;
  retentionState: "OWNER_DECISION_REQUIRED";
  providerState: "NOT_AVAILABLE";
  liveProviderQualification: "UNAVAILABLE_NOT_CLAIMED";
}
```

No transcript body is returned by BE7 dependency-ready scope.

## Summary DTO

```ts
interface MeetingSummaryDto {
  meetingId: string;
  state: "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";
  generated: false;
  reviewed: false;
  contentAvailable: false;
  authoritativeHumanDecision: false;
  retentionState: "OWNER_DECISION_REQUIRED";
}
```

Generated summaries, when later authorized, must remain visibly generated and must never be represented as authoritative human decisions.

## Action-item DTO

```ts
interface MeetingActionItemsDto {
  meetingId: string;
  state: "OWNER_DECISION_REQUIRED";
  items: [];
  executionAuthority: false;
  retentionState: "OWNER_DECISION_REQUIRED";
}
```

Meeting action items never confer tool, Principal, MCP, GitHub, Docker, host or other execution authority.

## API routes

Dependency-ready routes:
- `GET /api/product/meetings`
- `POST /api/product/meetings`
- `GET /api/product/meetings/{id}`
- `PATCH /api/product/meetings/{id}`
- `GET /api/product/meetings/{id}/transcript`
- `GET /api/product/meetings/{id}/summary`
- `GET /api/product/meetings/{id}/action-items`

All requests use the existing HttpOnly product session. POST/PATCH use existing BE1 origin/CSRF protection. Organization/workspace/user/Principal authority is server-derived.

## Disabled operations

The following operations do not exist in BE7 dependency-ready scope:
- microphone start/stop;
- recording start/stop;
- automatic recording;
- raw-audio upload;
- transcription start/retry;
- speaker identification/diarization mutation;
- transcript body upload/edit;
- summary generation mutation;
- action-item execution;
- participant mutation;
- export/download;
- arbitrary provider/model URL;
- generic HTTP proxy.

## Attachment integration

BE7 reuses BE5 `collaboration_attachments` through a meeting link table. It does not create a second physical attachment/audio custody model.

The existing attachment scan state/digest/type/size/workspace boundary remains authoritative. An uploaded attachment is not automatically trusted.

## Product events

BE7 may emit only accepted safe metadata events:
- `meeting.created`
- `meeting.started`
- `meeting.ended`

No event contains audio, transcript body, prompt text, provider token, secret or participant private content.

## Error semantics

Use existing product envelopes:
- unauthenticated session → `UNAUTHENTICATED`;
- cross-workspace/not-permitted → `FORBIDDEN`;
- invalid meeting request/state transition → `VALIDATION_FAILED`;
- stale optimistic version → `STALE_VERSION`;
- unavailable future STT provider → `BACKEND_UNAVAILABLE`.

Raw backend/provider/database errors are not returned.

## Provider/STT qualification

`LIVE_STT_PROVIDER=UNAVAILABLE / NOT_CLAIMED`.

Frontend must not render transcription as available until a separately approved provider/privacy contract is implemented and qualified.

## Retention

`RETENTION_POLICY=OWNER_DECISION_REQUIRED`.

No frontend timer/countdown should imply a recording, transcript, summary or meeting-metadata retention duration.

## Owner-policy blocked areas

Before BE7 full audio/recording completion, owner decisions are required for:
- recording consent model;
- participant notification;
- raw-audio persistence/retention;
- transcript retention;
- summary/action-item retention/reuse;
- STT provider/data egress;
- diarization/speaker identity;
- export/download;
- automatic recording.
