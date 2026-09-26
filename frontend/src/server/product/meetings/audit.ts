import "server-only";

export interface MeetingExportAuditRecord {
  event: "meeting.transcript_exported";
  outcome: "allowed" | "denied" | "error";
  correlationId: string;
  productUserId: string;
  organizationId: string;
  workspaceId: string;
  meetingId: string;
  artifactType: "transcript";
  policyVersion: number;
}

export type MeetingAuditSink = (record: MeetingExportAuditRecord) => void;

export const defaultMeetingAuditSink: MeetingAuditSink = (record) => {
  console.info(JSON.stringify({ component: "product_meetings", ...record }));
};
