import "server-only";

export type IdentityAuditEvent =
  | "identity.login_started"
  | "identity.login_succeeded"
  | "identity.login_failed"
  | "identity.session_read"
  | "identity.workspace_switched"
  | "identity.logout";

export interface SafeAuditRecord {
  event: IdentityAuditEvent;
  outcome: "allowed" | "denied" | "error";
  correlationId: string;
  userRef?: string;
  workspaceId?: string;
  reason?: string;
}

export type AuditSink = (record: SafeAuditRecord) => void;

export const defaultAuditSink: AuditSink = (record) => {
  console.info(JSON.stringify({ component: "product_identity", ...record }));
};
