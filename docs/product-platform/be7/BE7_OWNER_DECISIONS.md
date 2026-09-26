# BE7 Owner Decisions

STATUS: RESOLVED BY OWNER FOR CURRENT BE7 OWNER-POLICY SOURCE

The historical questions below are preserved for decision provenance. The owner has now selected the following exact policies for the current BE7 implementation:

1. Recording consent: meeting-owner attestation plus participant notice.
2. Participant notification: persistent visual notice.
3. Raw audio: transient processing only with verified deletion/cleanup.
4. Transcript retention: bounded workspace retention.
5. Summary/action-item retention: ephemeral only; no reuse authority.
6. STT provider/data egress: LOCAL_ONLY.
7. Speaker handling: anonymous Speaker A/B labels only; no identity inference.
8. Export/download: role-restricted and audited transcript export.
9. Automatic recording: explicit per-meeting opt-in only.

These decisions authorize only the bounded source behavior implemented by the BE7 owner-policy candidate. They do not by themselves qualify a live STT engine, live audio capture/storage runtime, PostgreSQL deployment, client-side notice rendering, or production recording.


## BE7-OD-01 — Recording consent model

**QUESTION**
What consent model must be satisfied before any recording capability may be enabled?

**WHY_REQUIRED**
Recording may be jurisdiction-sensitive and the accepted source forbids consent inference.

**SECURITY/PRIVACY IMPACT**
Defines whether capture may start and what evidence/participant state must exist.

**SAFE DEFAULT WHILE UNDECIDED**
Recording disabled; no microphone-start or raw-audio upload API.

**OPTIONS**
- explicit per-participant consent before capture;
- explicit meeting-owner attestation plus participant notice;
- organization-configured policy with explicit participant notification and legal review.

**IMPLEMENTATION CONSEQUENCE**
Determines future recording preconditions, consent records and UI workflow.

## BE7-OD-02 — Participant notification requirements

**QUESTION**
What notification must participants receive before/during recording?

**WHY_REQUIRED**
Notification obligations vary by product/legal policy.

**SECURITY/PRIVACY IMPACT**
Hidden or ambiguous recording is prohibited.

**SAFE DEFAULT WHILE UNDECIDED**
No recording.

**OPTIONS**
- persistent in-product indicator plus explicit notice;
- notice plus periodic audible indicator;
- organization policy selected from reviewed allowed modes.

**IMPLEMENTATION CONSEQUENCE**
Blocks recording enablement; metadata-only meetings remain available.

## BE7-OD-03 — Raw audio persistence and retention

**QUESTION**
May raw audio be persisted, and if so for how long?

**WHY_REQUIRED**
Current data-ownership contract explicitly owner-gates audio retention.

**SECURITY/PRIVACY IMPACT**
Raw audio is sensitive content and increases breach/subject-access surface.

**SAFE DEFAULT WHILE UNDECIDED**
No durable raw-audio storage or storage reference.

**OPTIONS**
- never persist raw audio;
- transient processing only with verified deletion;
- durable encrypted storage with explicit bounded retention.

**IMPLEMENTATION CONSEQUENCE**
Blocks raw-audio storage/upload workflow and deletion scheduler.

## BE7-OD-04 — Transcript retention

**QUESTION**
May transcript text be stored, and for what retention period?

**WHY_REQUIRED**
Transcript retention is explicitly unresolved in authoritative contracts.

**SECURITY/PRIVACY IMPACT**
Transcripts can contain personal/confidential information.

**SAFE DEFAULT WHILE UNDECIDED**
Transcript body is not persisted; metadata/status only.

**OPTIONS**
- no transcript persistence;
- bounded workspace retention;
- organization-configurable reviewed retention tiers.

**IMPLEMENTATION CONSEQUENCE**
Blocks transcript-body persistence and searchable transcript features.

## BE7-OD-05 — Summary/action-item retention and reuse

**QUESTION**
May generated meeting summaries/action-item content be persisted, and may it be reused for model improvement or other processing?

**WHY_REQUIRED**
Generated content may reproduce sensitive transcript information.

**SECURITY/PRIVACY IMPACT**
Controls persistence, secondary use and training/reuse exposure.

**SAFE DEFAULT WHILE UNDECIDED**
No generated summary/action-item body persistence; no training/reuse.

**OPTIONS**
- ephemeral only;
- bounded workspace persistence, no reuse;
- separately consented organization policy.

**IMPLEMENTATION CONSEQUENCE**
Blocks durable generated content and automatic downstream workflows.

## BE7-OD-06 — STT provider policy

**QUESTION**
Which transcription providers/local engines are approved, and may audio leave the local environment?

**WHY_REQUIRED**
No accepted provider endpoint/auth/data-residency contract exists.

**SECURITY/PRIVACY IMPACT**
External STT can disclose audio/transcript content to third parties.

**SAFE DEFAULT WHILE UNDECIDED**
`LIVE_STT_PROVIDER=UNAVAILABLE / NOT_CLAIMED`.

**OPTIONS**
- local-only approved STT;
- approved cloud STT with reviewed data-processing terms;
- organization-selectable allowlist of reviewed providers.

**IMPLEMENTATION CONSEQUENCE**
Blocks live transcription adapter wiring.

## BE7-OD-07 — Speaker identification / diarization policy

**QUESTION**
May speaker labels be generated, and may identity be inferred from voice?

**WHY_REQUIRED**
Speaker identification can become biometric/sensitive processing.

**SECURITY/PRIVACY IMPACT**
Potential biometric and identity inference risk.

**SAFE DEFAULT WHILE UNDECIDED**
No speaker identity inference or durable speaker labels.

**OPTIONS**
- no diarization;
- anonymous Speaker A/B labels only;
- explicit-consent identity mapping after legal/privacy review.

**IMPLEMENTATION CONSEQUENCE**
Blocks speaker-label identity features.

## BE7-OD-08 — Export/download policy

**QUESTION**
Who may export/download audio, transcript or generated meeting artifacts?

**WHY_REQUIRED**
Export changes the data-control and leakage boundary.

**SECURITY/PRIVACY IMPACT**
Creates portable copies outside QuaranGate controls.

**SAFE DEFAULT WHILE UNDECIDED**
No export/download API.

**OPTIONS**
- no export;
- workspace-role restricted export with audit;
- organization-configurable reviewed policy.

**IMPLEMENTATION CONSEQUENCE**
Blocks export/download routes.

## BE7-OD-09 — Automatic recording

**QUESTION**
May any meeting auto-start recording?

**WHY_REQUIRED**
Current BE7 contract explicitly forbids automatic recording without owner policy.

**SECURITY/PRIVACY IMPACT**
Highest risk of unintentional/hidden capture.

**SAFE DEFAULT WHILE UNDECIDED**
Disabled.

**OPTIONS**
- never;
- explicit per-meeting opt-in;
- organization policy only after separate review.

**IMPLEMENTATION CONSEQUENCE**
No BE7 dependency-ready route or service starts recording automatically.
