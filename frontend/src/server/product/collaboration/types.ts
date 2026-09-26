import "server-only";

export interface SafeGroup {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  status: "active" | "archived";
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SafeMessage {
  id: string;
  groupId: string;
  organizationId: string;
  workspaceId: string;
  authorProductUserId: string;
  body: string;
  version: number;
  createdAt: string;
  editedAt?: string;
}

export interface SafeAttachment {
  id: string;
  organizationId: string;
  workspaceId: string;
  uploaderProductUserId: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  sha256Hex?: string;
  scanState: "pending" | "clean" | "infected" | "error";
  status: "initiated" | "uploaded" | "safe" | "rejected";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SafeNotification {
  id: string;
  organizationId: string;
  workspaceId: string;
  productUserId: string;
  notificationType: string;
  summary: string;
  readAt?: string;
  dismissedAt?: string;
  expiresAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";

export interface SafeApproval {
  id: string;
  organizationId: string;
  workspaceId: string;
  requesterProductUserId: string;
  decisionProductUserId?: string;
  actionClass: string;
  subjectType: string;
  subjectId: string;
  evidenceDigestSha256?: string;
  requestCorrelationId: string;
  rationale?: string;
  status: ApprovalStatus;
  expiresAt?: string;
  decidedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SafeProductEvent {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  workspaceId: string;
  actor?: { productUserId: string };
  subject: { type: string; id: string };
  sequence: number;
  correlationId: string;
  data: Record<string, unknown>;
}

export interface ReplayPage {
  events: SafeProductEvent[];
  nextCursor?: string;
}

export interface AutonomousPolicy {
  id: string;
  organizationId: string;
  workspaceId: string;
  actionClass: string;
  enabled: boolean;
  approvalRequirement: "required" | "conditional" | "not_required";
  maxOperations?: number;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
