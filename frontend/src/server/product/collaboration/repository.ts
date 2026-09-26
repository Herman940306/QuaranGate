import "server-only";
import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "../data/db";
import { ProductDataError } from "../data/errors";
import type {
  ApprovalStatus,
  AutonomousPolicy,
  SafeApproval,
  SafeAttachment,
  SafeGroup,
  SafeMessage,
  SafeNotification,
} from "./types";

interface GroupRow extends Record<string, unknown> {
  id:string; organization_id:string; workspace_id:string; name:string;
  status:"active"|"archived"; version:number|string; created_by:string;
  created_at:string|Date; updated_at:string|Date;
}
interface MessageRow extends Record<string, unknown> {
  id:string; group_id:string; organization_id:string; workspace_id:string;
  author_product_user_id:string; body:string; version:number|string;
  created_at:string|Date; edited_at:string|Date|null;
}
interface AttachmentRow extends Record<string, unknown> {
  id:string; organization_id:string; workspace_id:string; uploader_product_user_id:string;
  original_name:string; content_type:string; size_bytes:number|string; sha256_hex:string|null;
  scan_state:"pending"|"clean"|"infected"|"error"; status:"initiated"|"uploaded"|"safe"|"rejected";
  version:number|string; created_at:string|Date; updated_at:string|Date;
}
interface NotificationRow extends Record<string, unknown> {
  id:string; organization_id:string; workspace_id:string; product_user_id:string;
  notification_type:string; summary:string; subject_type:string|null; subject_id:string|null;
  read_at:string|Date|null; dismissed_at:string|Date|null; expires_at:string|Date|null;
  version:number|string; created_at:string|Date; updated_at:string|Date;
}
interface ApprovalRow extends Record<string, unknown> {
  id:string; organization_id:string; workspace_id:string; requester_product_user_id:string;
  decision_product_user_id:string|null; action_class:string; subject_type:string; subject_id:string;
  evidence_digest_sha256:string|null; request_correlation_id:string; rationale:string|null;
  status:ApprovalStatus; expires_at:string|Date|null; decided_at:string|Date|null;
  version:number|string; created_at:string|Date; updated_at:string|Date;
}
interface PolicyRow extends Record<string, unknown> {
  id:string; organization_id:string; workspace_id:string; action_class:string; enabled:boolean;
  approval_requirement:"required"|"conditional"|"not_required"; max_operations:number|null;
  version:number|string; created_by:string; created_at:string|Date; updated_at:string|Date;
}
function iso(v:string|Date){return new Date(v).toISOString();}
function group(row:GroupRow):SafeGroup{return{id:row.id,organizationId:row.organization_id,workspaceId:row.workspace_id,name:row.name,status:row.status,version:Number(row.version),createdBy:row.created_by,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
function message(row:MessageRow):SafeMessage{return{id:row.id,groupId:row.group_id,organizationId:row.organization_id,workspaceId:row.workspace_id,authorProductUserId:row.author_product_user_id,body:row.body,version:Number(row.version),createdAt:iso(row.created_at),...(row.edited_at?{editedAt:iso(row.edited_at)}:{})};}
function attachment(row:AttachmentRow):SafeAttachment{return{id:row.id,organizationId:row.organization_id,workspaceId:row.workspace_id,uploaderProductUserId:row.uploader_product_user_id,originalName:row.original_name,contentType:row.content_type,sizeBytes:Number(row.size_bytes),...(row.sha256_hex?{sha256Hex:row.sha256_hex}:{}),scanState:row.scan_state,status:row.status,version:Number(row.version),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
function notification(row:NotificationRow):SafeNotification{return{id:row.id,organizationId:row.organization_id,workspaceId:row.workspace_id,productUserId:row.product_user_id,notificationType:row.notification_type,summary:row.summary,...(row.read_at?{readAt:iso(row.read_at)}:{}),...(row.dismissed_at?{dismissedAt:iso(row.dismissed_at)}:{}),...(row.expires_at?{expiresAt:iso(row.expires_at)}:{}),version:Number(row.version),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
function approval(row:ApprovalRow):SafeApproval{return{id:row.id,organizationId:row.organization_id,workspaceId:row.workspace_id,requesterProductUserId:row.requester_product_user_id,...(row.decision_product_user_id?{decisionProductUserId:row.decision_product_user_id}:{}),actionClass:row.action_class,subjectType:row.subject_type,subjectId:row.subject_id,...(row.evidence_digest_sha256?{evidenceDigestSha256:row.evidence_digest_sha256}:{}),requestCorrelationId:row.request_correlation_id,...(row.rationale?{rationale:row.rationale}:{}),status:row.status,...(row.expires_at?{expiresAt:iso(row.expires_at)}:{}),...(row.decided_at?{decidedAt:iso(row.decided_at)}:{}),version:Number(row.version),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
function policy(row:PolicyRow):AutonomousPolicy{return{id:row.id,organizationId:row.organization_id,workspaceId:row.workspace_id,actionClass:row.action_class,enabled:row.enabled,approvalRequirement:row.approval_requirement,...(row.max_operations!==null?{maxOperations:row.max_operations}:{}),version:Number(row.version),createdBy:row.created_by,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}

export class CollaborationRepository {
  constructor(private readonly db:QueryExecutor){}

  async createGroup(user:string,org:string,ws:string,name:string):Promise<SafeGroup>{
    const id=randomUUID();
    const r=await this.db.query<GroupRow>(`INSERT INTO collaboration_groups(id,organization_id,workspace_id,name,created_by)
      SELECT $1,$2,$3,$4,$5 FROM memberships m
      JOIN product_users u ON u.id=m.product_user_id AND u.status='active'
      JOIN workspaces w ON w.id=m.workspace_id AND w.organization_id=m.organization_id AND w.status='active'
      JOIN organizations o ON o.id=m.organization_id AND o.status='active'
      WHERE m.product_user_id=$5 AND m.organization_id=$2 AND m.workspace_id=$3 AND m.status='active'
      RETURNING *`,[id,org,ws,name,user]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","group_create_denied");
    await this.db.query(`INSERT INTO collaboration_group_members(group_id,product_user_id,organization_id,workspace_id,role)
      VALUES($1,$2,$3,$4,'owner') ON CONFLICT DO NOTHING`,[id,user,org,ws]);
    return group(r.rows[0]);
  }

  async listGroups(user:string,org:string,ws:string):Promise<SafeGroup[]>{
    const r=await this.db.query<GroupRow>(`SELECT g.* FROM collaboration_groups g
      JOIN collaboration_group_members gm ON gm.group_id=g.id AND gm.organization_id=g.organization_id AND gm.workspace_id=g.workspace_id
      WHERE gm.product_user_id=$1 AND gm.status='active' AND g.organization_id=$2 AND g.workspace_id=$3 AND g.status='active'
      ORDER BY g.updated_at DESC,g.id`,[user,org,ws]);
    return r.rows.map(group);
  }

  async getGroup(user:string,org:string,ws:string,id:string):Promise<SafeGroup|undefined>{
    const r=await this.db.query<GroupRow>(`SELECT g.* FROM collaboration_groups g
      JOIN collaboration_group_members gm ON gm.group_id=g.id AND gm.organization_id=g.organization_id AND gm.workspace_id=g.workspace_id
      WHERE gm.product_user_id=$1 AND gm.status='active' AND g.organization_id=$2 AND g.workspace_id=$3 AND g.id=$4 LIMIT 1`,[user,org,ws,id]);
    return r.rows[0]?group(r.rows[0]):undefined;
  }

  async updateGroup(user:string,org:string,ws:string,id:string,name:string,status:"active"|"archived",expectedVersion:number):Promise<SafeGroup>{
    const r=await this.db.query<GroupRow>(`UPDATE collaboration_groups g SET name=$1,status=$2,version=g.version+1,updated_at=CURRENT_TIMESTAMP
      FROM collaboration_group_members gm WHERE g.id=$3 AND g.organization_id=$4 AND g.workspace_id=$5 AND g.version=$6
      AND gm.group_id=g.id AND gm.product_user_id=$7 AND gm.status='active' AND gm.role='owner'
      RETURNING g.*`,[name,status,id,org,ws,expectedVersion,user]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","group_update_stale_or_denied");
    return group(r.rows[0]);
  }

  async createMessage(user:string,org:string,ws:string,groupId:string,body:string):Promise<SafeMessage>{
    const r=await this.db.query<MessageRow>(`INSERT INTO collaboration_messages(id,group_id,organization_id,workspace_id,author_product_user_id,body)
      SELECT $1,g.id,g.organization_id,g.workspace_id,$2,$3 FROM collaboration_groups g
      JOIN collaboration_group_members gm ON gm.group_id=g.id AND gm.organization_id=g.organization_id AND gm.workspace_id=g.workspace_id
      WHERE g.id=$4 AND g.organization_id=$5 AND g.workspace_id=$6 AND g.status='active'
      AND gm.product_user_id=$2 AND gm.status='active' RETURNING collaboration_messages.*`,
      [randomUUID(),user,body,groupId,org,ws]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","message_create_denied");
    return message(r.rows[0]);
  }

  async listMessages(user:string,org:string,ws:string,groupId:string,before?:string,limit=50):Promise<{messages:SafeMessage[];nextCursor?:string}>{
    let beforeCreated:string|null=null,beforeId:string|null=null;
    if(before){
      try{const decoded=JSON.parse(Buffer.from(before,"base64url").toString("utf8")) as {t?:unknown;i?:unknown};if(typeof decoded.t!=="string"||typeof decoded.i!=="string")throw new Error();beforeCreated=decoded.t;beforeId=decoded.i;}catch{throw new ProductDataError("PRODUCT_DATA_INVALID","message_cursor_invalid");}
    }
    const size=Math.max(1,Math.min(100,Math.trunc(limit)));
    const r=await this.db.query<MessageRow>(`SELECT m.* FROM collaboration_messages m
      JOIN collaboration_group_members gm ON gm.group_id=m.group_id AND gm.organization_id=m.organization_id AND gm.workspace_id=m.workspace_id
      WHERE gm.product_user_id=$1 AND gm.status='active' AND m.organization_id=$2 AND m.workspace_id=$3 AND m.group_id=$4
      AND ($5::timestamptz IS NULL OR (m.created_at,m.id)<($5::timestamptz,$6::uuid))
      ORDER BY m.created_at DESC,m.id DESC LIMIT $7`,[user,org,ws,groupId,beforeCreated,beforeId,size+1]);
    const hasMore=r.rows.length>size;const rows=r.rows.slice(0,size);const messages=rows.map(message);const last=rows.at(-1);
    return{messages,...(hasMore&&last?{nextCursor:Buffer.from(JSON.stringify({t:iso(last.created_at),i:last.id})).toString("base64url")}:{})};
  }

  async addReaction(user:string,org:string,ws:string,messageId:string,reactionKey:string):Promise<void>{
    const r=await this.db.query(`INSERT INTO collaboration_reactions(message_id,product_user_id,organization_id,workspace_id,reaction_key)
      SELECT m.id,$1,m.organization_id,m.workspace_id,$2 FROM collaboration_messages m
      JOIN collaboration_group_members gm ON gm.group_id=m.group_id AND gm.product_user_id=$1 AND gm.status='active'
      WHERE m.id=$3 AND m.organization_id=$4 AND m.workspace_id=$5
      ON CONFLICT DO NOTHING RETURNING message_id`,[user,reactionKey,messageId,org,ws]);
    if(!r.rowCount) {
      const visible=await this.db.query(`SELECT 1 FROM collaboration_reactions r
        JOIN collaboration_messages m ON m.id=r.message_id AND m.workspace_id=r.workspace_id
        JOIN collaboration_group_members gm ON gm.group_id=m.group_id AND gm.product_user_id=r.product_user_id AND gm.status='active'
        WHERE r.message_id=$1 AND r.product_user_id=$2 AND r.reaction_key=$3 AND r.organization_id=$4 AND r.workspace_id=$5`,
        [messageId,user,reactionKey,org,ws]);
      if(!visible.rowCount)throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","reaction_denied");
    }
  }

  async initiateAttachment(user:string,org:string,ws:string,originalName:string,contentType:string,sizeBytes:number):Promise<SafeAttachment>{
    const id=randomUUID();const storageRef=`qg-attachment:${id}`;
    const r=await this.db.query<AttachmentRow>(`INSERT INTO collaboration_attachments(id,organization_id,workspace_id,uploader_product_user_id,original_name,content_type,size_bytes,storage_ref)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM memberships m
      WHERE m.product_user_id=$4 AND m.organization_id=$2 AND m.workspace_id=$3 AND m.status='active'
      RETURNING *`,[id,org,ws,user,originalName,contentType,sizeBytes,storageRef]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","attachment_initiate_denied");
    return attachment(r.rows[0]);
  }

  async completeAttachment(user:string,org:string,ws:string,id:string,sha256Hex:string,expectedVersion:number):Promise<SafeAttachment>{
    const r=await this.db.query<AttachmentRow>(`UPDATE collaboration_attachments SET sha256_hex=$1,status='uploaded',version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$2 AND organization_id=$3 AND workspace_id=$4 AND uploader_product_user_id=$5 AND version=$6 AND status='initiated'
      RETURNING *`,[sha256Hex,id,org,ws,user,expectedVersion]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","attachment_complete_stale_or_denied");
    return attachment(r.rows[0]);
  }

  async recordAttachmentScan(org:string,ws:string,id:string,scanState:"clean"|"infected"|"error",expectedVersion:number):Promise<SafeAttachment>{
    const status=scanState==="clean"?"safe":scanState==="infected"?"rejected":"uploaded";
    const r=await this.db.query<AttachmentRow>(`UPDATE collaboration_attachments SET scan_state=$1,status=$2,version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$3 AND organization_id=$4 AND workspace_id=$5 AND version=$6 AND status='uploaded' RETURNING *`,
      [scanState,status,id,org,ws,expectedVersion]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","attachment_scan_stale_or_denied");
    return attachment(r.rows[0]);
  }

  async listNotifications(user:string,org:string,ws:string):Promise<SafeNotification[]>{
    const r=await this.db.query<NotificationRow>(`SELECT * FROM product_notifications WHERE product_user_id=$1 AND organization_id=$2 AND workspace_id=$3
      AND dismissed_at IS NULL AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP) ORDER BY created_at DESC,id DESC LIMIT 100`,[user,org,ws]);
    return r.rows.map(notification);
  }

  async createApproval(user:string,org:string,ws:string,input:{actionClass:string;subjectType:string;subjectId:string;evidenceDigestSha256?:string;expiresAt?:string;rationale?:string;correlationId:string}):Promise<SafeApproval>{
    const r=await this.db.query<ApprovalRow>(`INSERT INTO product_approvals(id,organization_id,workspace_id,requester_product_user_id,action_class,subject_type,subject_id,evidence_digest_sha256,request_correlation_id,rationale,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz FROM memberships m
      WHERE m.product_user_id=$4 AND m.organization_id=$2 AND m.workspace_id=$3 AND m.status='active'
      RETURNING *`,[randomUUID(),org,ws,user,input.actionClass,input.subjectType,input.subjectId,input.evidenceDigestSha256??null,input.correlationId,input.rationale??null,input.expiresAt??null]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","approval_create_denied");
    return approval(r.rows[0]);
  }

  async listApprovals(user:string,org:string,ws:string):Promise<SafeApproval[]>{
    const member=await this.db.query(`SELECT 1 FROM memberships WHERE product_user_id=$1 AND organization_id=$2 AND workspace_id=$3 AND status='active' LIMIT 1`,[user,org,ws]);
    if(!member.rowCount)throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","approval_list_denied");
    const r=await this.db.query<ApprovalRow>(`SELECT * FROM product_approvals WHERE organization_id=$1 AND workspace_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,[org,ws]);
    return r.rows.map(approval);
  }

  async decideApproval(user:string,org:string,ws:string,id:string,decision:"APPROVED"|"REJECTED",expectedVersion:number,rationale?:string):Promise<SafeApproval>{
    const r=await this.db.query<ApprovalRow>(`UPDATE product_approvals a SET status=$1,decision_product_user_id=$2,decided_at=CURRENT_TIMESTAMP,
      rationale=COALESCE($3,a.rationale),version=a.version+1,updated_at=CURRENT_TIMESTAMP
      FROM memberships m WHERE a.id=$4 AND a.organization_id=$5 AND a.workspace_id=$6 AND a.version=$7 AND a.status='PENDING'
      AND (a.expires_at IS NULL OR a.expires_at>CURRENT_TIMESTAMP)
      AND m.product_user_id=$2 AND m.organization_id=a.organization_id AND m.workspace_id=a.workspace_id AND m.status='active'
      RETURNING a.*`,[decision,user,rationale??null,id,org,ws,expectedVersion]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","approval_decision_stale_or_denied");
    return approval(r.rows[0]);
  }

  async createNotification(user:string,org:string,ws:string,input:{notificationType:string;summary:string;subjectType?:string;subjectId?:string;idempotencyKey:string;expiresAt?:string}):Promise<SafeNotification>{
    const r=await this.db.query<NotificationRow>(`INSERT INTO product_notifications(id,organization_id,workspace_id,product_user_id,notification_type,summary,subject_type,subject_id,idempotency_key,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz FROM memberships m
      WHERE m.product_user_id=$4 AND m.organization_id=$2 AND m.workspace_id=$3 AND m.status='active'
      ON CONFLICT (product_user_id,workspace_id,idempotency_key) DO UPDATE SET updated_at=product_notifications.updated_at
      RETURNING *`,[randomUUID(),org,ws,user,input.notificationType,input.summary,input.subjectType??null,input.subjectId??null,input.idempotencyKey,input.expiresAt??null]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","notification_create_denied");
    return notification(r.rows[0]);
  }

  async markNotificationRead(user:string,org:string,ws:string,id:string,expectedVersion:number):Promise<SafeNotification>{
    const r=await this.db.query<NotificationRow>(`UPDATE product_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP),version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1 AND product_user_id=$2 AND organization_id=$3 AND workspace_id=$4 AND version=$5 RETURNING *`,[id,user,org,ws,expectedVersion]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","notification_read_stale_or_denied");
    return notification(r.rows[0]);
  }

  async cancelApproval(user:string,org:string,ws:string,id:string,expectedVersion:number):Promise<SafeApproval>{
    const r=await this.db.query<ApprovalRow>(`UPDATE product_approvals SET status='CANCELLED',version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1 AND requester_product_user_id=$2 AND organization_id=$3 AND workspace_id=$4 AND version=$5 AND status='PENDING'
      RETURNING *`,[id,user,org,ws,expectedVersion]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","approval_cancel_stale_or_denied");
    return approval(r.rows[0]);
  }

  async expireApproval(org:string,ws:string,id:string,expectedVersion:number):Promise<SafeApproval>{
    const r=await this.db.query<ApprovalRow>(`UPDATE product_approvals SET status='EXPIRED',version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1 AND organization_id=$2 AND workspace_id=$3 AND version=$4 AND status='PENDING' AND expires_at IS NOT NULL AND expires_at<=CURRENT_TIMESTAMP
      RETURNING *`,[id,org,ws,expectedVersion]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","approval_expire_stale_or_not_due");
    return approval(r.rows[0]);
  }

  async createPolicy(user:string,org:string,ws:string,input:{actionClass:string;enabled:boolean;approvalRequirement:"required"|"conditional"|"not_required";maxOperations?:number}):Promise<AutonomousPolicy>{
    const r=await this.db.query<PolicyRow>(`INSERT INTO product_autonomous_policies(id,organization_id,workspace_id,action_class,enabled,approval_requirement,max_operations,created_by)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM memberships m
      WHERE m.product_user_id=$8 AND m.organization_id=$2 AND m.workspace_id=$3 AND m.status='active'
      ON CONFLICT (workspace_id,action_class) DO NOTHING RETURNING *`,[randomUUID(),org,ws,input.actionClass,input.enabled,input.approvalRequirement,input.maxOperations??null,user]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","policy_create_denied");
    return policy(r.rows[0]);
  }

  async updatePolicy(user:string,org:string,ws:string,id:string,input:{enabled:boolean;approvalRequirement:"required"|"conditional"|"not_required";maxOperations?:number;expectedVersion:number}):Promise<AutonomousPolicy>{
    const member=await this.db.query(`SELECT 1 FROM memberships WHERE product_user_id=$1 AND organization_id=$2 AND workspace_id=$3 AND status='active' LIMIT 1`,[user,org,ws]);
    if(!member.rowCount)throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","policy_update_denied");
    const r=await this.db.query<PolicyRow>(`UPDATE product_autonomous_policies SET enabled=$1,approval_requirement=$2,max_operations=$3,version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=$4 AND organization_id=$5 AND workspace_id=$6 AND version=$7 RETURNING *`,[input.enabled,input.approvalRequirement,input.maxOperations??null,id,org,ws,input.expectedVersion]);
    if(!r.rows[0])throw new ProductDataError("PRODUCT_DATA_STALE_VERSION","policy_update_stale_or_denied");
    return policy(r.rows[0]);
  }

  async getPolicy(user:string,org:string,ws:string,actionClass:string):Promise<AutonomousPolicy|undefined>{
    const member=await this.db.query(`SELECT 1 FROM memberships WHERE product_user_id=$1 AND organization_id=$2 AND workspace_id=$3 AND status='active' LIMIT 1`,[user,org,ws]);
    if(!member.rowCount)return undefined;
    const r=await this.db.query<PolicyRow>("SELECT * FROM product_autonomous_policies WHERE organization_id=$1 AND workspace_id=$2 AND action_class=$3 LIMIT 1",[org,ws,actionClass]);
    return r.rows[0]?policy(r.rows[0]):undefined;
  }
}
