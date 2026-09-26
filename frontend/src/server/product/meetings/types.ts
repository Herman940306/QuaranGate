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

export type OwnerDecisionState = "OWNER_DECISION_REQUIRED";
export type ProcessingState = "NOT_AVAILABLE" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface MeetingParticipantDto {
  productUserId: string;
  role: "owner" | "participant";
  consentState: OwnerDecisionState;
}

export interface MeetingDto {
  id: string;
  organizationId: string;
  workspaceId: string;
  createdBy: string;
  title: string;
  state: MeetingState;
  recordingState: OwnerDecisionState;
  transcriptionState: ProcessingState;
  summaryState: ProcessingState;
  retentionState: OwnerDecisionState;
  version: number;
  participants: MeetingParticipantDto[];
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptDto {
  meetingId: string;
  state: ProcessingState;
  contentAvailable: false;
  retentionState: OwnerDecisionState;
  providerState: "NOT_AVAILABLE";
  liveProviderQualification: "UNAVAILABLE_NOT_CLAIMED";
}

export interface MeetingSummaryDto {
  meetingId: string;
  state: ProcessingState;
  generated: false;
  reviewed: false;
  contentAvailable: false;
  authoritativeHumanDecision: false;
  retentionState: OwnerDecisionState;
}

export interface MeetingActionItemsDto {
  meetingId: string;
  state: OwnerDecisionState;
  items: [];
  executionAuthority: false;
  retentionState: OwnerDecisionState;
}
