import "server-only";

export type MeetingState =
  | "DRAFT"
  | "READY"
  | "ACTIVE"
  | "STOPPED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export type RecordingState =
  | "DISABLED"
  | "OPTED_IN"
  | "READY"
  | "RECORDING"
  | "STOPPING"
  | "STOPPED"
  | "FAILED";

export type NoticePolicy = "PERSISTENT_VISUAL";
export type NoticeState = "REQUIRED" | "CLIENT_ACKNOWLEDGED";
export type RetentionState = "NOT_CONFIGURED" | "CONFIGURED";
export type ProcessingState = "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface MeetingParticipantDto {
  productUserId: string;
  role: "owner" | "participant";
  consentState: "OWNER_ATTESTATION_MODEL";
}

export interface MeetingDto {
  id: string;
  organizationId: string;
  workspaceId: string;
  createdBy: string;
  title: string;
  state: MeetingState;
  recordingState: RecordingState;
  recordingOptIn: boolean;
  recordingPolicyVersion: number;
  noticePolicy: NoticePolicy;
  noticeState: NoticeState;
  noticeRequired: true;
  noticeRenderingVerified: false;
  transcriptionState: ProcessingState;
  summaryState: ProcessingState;
  retentionState: RetentionState;
  version: number;
  participants: MeetingParticipantDto[];
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptDto {
  meetingId: string;
  state: ProcessingState;
  contentAvailable: boolean;
  retentionState: RetentionState;
  retainedUntil?: string;
  transcriptVersion?: number;
  providerClass: "LOCAL_ONLY";
  liveProviderQualification: "UNAVAILABLE_NOT_CLAIMED" | "IMPLEMENTED_NOT_QUALIFIED";
  anonymousSpeakerLabels: string[];
}

export interface MeetingSummaryDto {
  meetingId: string;
  state: ProcessingState;
  generated: false;
  reviewed: false;
  contentAvailable: false;
  authoritativeHumanDecision: false;
  retentionMode: "EPHEMERAL_ONLY";
}

export interface MeetingActionItemsDto {
  meetingId: string;
  state: "NOT_AVAILABLE";
  items: [];
  executionAuthority: false;
  retentionMode: "EPHEMERAL_ONLY";
}

export interface RecordingAttestationDto {
  meetingId: string;
  attestingProductUserId: string;
  attestationCode: "NOTICE_AND_CONSENT_OBLIGATIONS_ATTESTED_BY_MEETING_OWNER";
  policyVersion: number;
  meetingVersion: number;
  createdAt: string;
}

export interface TranscriptRetentionPolicyDto {
  organizationId: string;
  workspaceId: string;
  enabled: boolean;
  retentionMinutes?: number;
  state: RetentionState;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface TranscriptMetadataDto {
  id: string;
  meetingId: string;
  organizationId: string;
  workspaceId: string;
  transcriptVersion: number;
  contentRef: string;
  retainedUntil: string;
  providerClass: "LOCAL_ONLY";
  anonymousSpeakerLabels: string[];
  createdAt: string;
  updatedAt: string;
}
