# BE7 Contract Audit

## Exact base

BE7 starts from accepted BE6 R1 commit `e0d7458724dae6bf85d8fb0493c71963172ab865`, tree `ba88838704a714d3dc8c0051c8d9e42104704c54`.

## Source hierarchy

Current repository source and authoritative product contracts govern this implementation. Engram confirms prior product direction for user-selectable voice/STT, but does not settle recording, consent, retention, external-provider, export, speaker-identification, or reuse policy.

## Capability classification

| Capability | Classification | Source truth / BE7 action |
|---|---|---|
| Meeting metadata/session lifecycle | A. ACCEPTED_CONTRACT_READY | Safe product foundation may be workspace-scoped and durable without implying recording. |
| Meeting creator membership | A. ACCEPTED_CONTRACT_READY | Server session derives creator; no browser tenant authority. |
| Additional participant mutation | D. OWNER_DECISION_REQUIRED | Participant notification/consent policy is unresolved; no public mutation route. |
| Meeting events: created/started/ended | A. ACCEPTED_CONTRACT_READY | Already named in PRODUCT_EVENT_CONTRACTS_V0; metadata only. |
| Recording state | D. OWNER_DECISION_REQUIRED | Recording/transcription payload and retention require separately approved privacy contract. Feature remains disabled. |
| Raw audio persistence/upload | D. OWNER_DECISION_REQUIRED | No raw-audio storage field or upload/record route is introduced. |
| Transcript body persistence | D. OWNER_DECISION_REQUIRED | No transcript body column or content route payload. Metadata/status only. |
| STT provider integration | C. EXTERNAL_PROVIDER_BOUNDARY | Server-only typed boundary may exist; no provider selected/configured. |
| Speaker labels/diarization | D. OWNER_DECISION_REQUIRED | No identity or speaker inference is made. |
| Summary body persistence | D. OWNER_DECISION_REQUIRED | Metadata state/provenance contract only while retention/reuse policy is unresolved. |
| Action-item content persistence | D. OWNER_DECISION_REQUIRED | Read contract remains unavailable while policy is unresolved. Action items never grant execution authority. |
| BE5 attachment linking | A. ACCEPTED_CONTRACT_READY | Meeting artifacts may reference accepted scanned attachment metadata only. No second custody model. |
| Recording/transcript/summary retention | D. OWNER_DECISION_REQUIRED | No durations, cleanup jobs or expiry policy selected. |
| Public transcript/export links | F. NOT_AVAILABLE | No public links or export/download endpoint. |
| Browser microphone capture | E. DEFERRED | Agent B does not own frontend/client and recording policy is unresolved. |
| Automatic recording | F. NOT_AVAILABLE | Explicitly absent. |
| Generic provider URL/proxy | F. NOT_AVAILABLE | Explicitly prohibited. |

## Data-model boundary

Dependency-ready durable state:
- meeting session identity, org/workspace ownership, title and safe lifecycle state;
- creator and creator participant membership;
- metadata-only recording/transcription/summary truth states;
- safe transcript metadata with no transcript body;
- meeting-to-BE5-attachment reference with the existing scan-state boundary;
- optimistic versioning and timestamps.

Not persisted:
- raw audio bytes or storage location;
- transcript text/body;
- generated summary text/body;
- free-form action-item content;
- provider credentials;
- browser credentials;
- Principal/MCP/GitHub/Docker/host authority;
- inferred consent or speaker identity.

## Lifecycle separation

Meeting session, recording, transcription and summary are independent truth dimensions.

Meeting session states:
`DRAFT | READY | ACTIVE | STOPPED | PROCESSING | COMPLETED | FAILED | CANCELLED | EXPIRED`.

`ACTIVE` means only that the meeting session is active. It does not mean recording is active.

Recording remains `OWNER_DECISION_REQUIRED` in BE7 dependency-ready scope.

Transcription remains `NOT_AVAILABLE` until an approved provider/policy exists.

Summary generation remains `NOT_AVAILABLE` until transcript/summary retention and generation policy exists.

## Authority

BE7 is product metadata/workflow state only:
- authenticated BE1 product session derives product user/org/workspace;
- browser org/workspace/Principal fields are non-authoritative and ignored;
- meeting state does not grant operational capability;
- generated summaries/action items, when later implemented, never grant execution authority;
- events are audit/activity metadata, not authority.

## Event boundary

Accepted durable event names used by dependency-ready BE7:
- `meeting.created`;
- `meeting.started`;
- `meeting.ended`.

No event payload includes raw audio, transcript body, prompt text, secrets, provider tokens or participant private content.

Recording-state events are not emitted while recording is disabled.

## API boundary

Dependency-ready same-origin routes:
- `GET /api/product/meetings`
- `POST /api/product/meetings`
- `GET /api/product/meetings/{id}`
- `PATCH /api/product/meetings/{id}`
- `GET /api/product/meetings/{id}/transcript`
- `GET /api/product/meetings/{id}/summary`
- `GET /api/product/meetings/{id}/action-items`

No recording, raw-audio upload, transcription-start, export/download, participant mutation, generic provider or generic proxy route is dependency-ready.

## Live qualification

- `LIVE_POSTGRESQL=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_STT_PROVIDER=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_AUDIO_STORAGE=UNAVAILABLE / NOT_CLAIMED`
- `LIVE_RECORDING=DISABLED / OWNER_DECISION_REQUIRED`
- `RETENTION_POLICY=OWNER_DECISION_REQUIRED`
