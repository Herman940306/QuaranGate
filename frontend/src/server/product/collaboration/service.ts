import "server-only";
import type { TransactionPool } from "../data/db";
import { withTransaction } from "../data/db";
import { productPool } from "../data/runtime";
import type { ProductContextAdapter } from "../adapters/workspace";
import { PostgresProductContextAdapter } from "../adapters/postgres-context";
import { productDataRepository } from "../data/runtime";
import type { ProductSession } from "../identity/types";
import { ProductDataError } from "../data/errors";
import { CollaborationRepository } from "./repository";
import { ProductEventRepository } from "./events";
import type {
  ApprovalStatus,
  ReplayPage,
  SafeApproval,
  SafeAttachment,
  SafeGroup,
  SafeMessage,
  SafeNotification,
} from "./types";

function boundedText(value:string,max:number,code:string,{allowNewlines=false}={}):string{
  if(typeof value!=="string")throw new ProductDataError("PRODUCT_DATA_INVALID",code);
  const normalized=value.normalize("NFC");
  if(!normalized.trim()||normalized.length>max)throw new ProductDataError("PRODUCT_DATA_INVALID",code);
  for(let i=0;i<normalized.length;i++){
    const c=normalized.charCodeAt(i);
    if(c>=0xd800&&c<=0xdbff){
      const n=normalized.charCodeAt(i+1);
      if(!(n>=0xdc00&&n<=0xdfff))throw new ProductDataError("PRODUCT_DATA_INVALID",code);
      i++;continue;
    }
    if(c>=0xdc00&&c<=0xdfff)throw new ProductDataError("PRODUCT_DATA_INVALID",code);
    if(c<32&&!(allowNewlines&&(c===9||c===10)))throw new ProductDataError("PRODUCT_DATA_INVALID",code);
    if(c===127)throw new ProductDataError("PRODUCT_DATA_INVALID",code);
  }
  return normalized;
}
function boundedKey(value:string,max=96):string{
  if(!new RegExp(`^[a-z][a-z0-9_.:-]{0,${max-1}}$`).test(value))throw new ProductDataError("PRODUCT_DATA_INVALID","collaboration_key_invalid");
  return value;
}
function boundedIdempotency(value:string|undefined):string|undefined{
  if(value===undefined)return undefined;
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))throw new ProductDataError("PRODUCT_DATA_INVALID","idempotency_key_invalid");
  return value;
}

export class CollaborationService {
  constructor(
    private readonly pool:TransactionPool=productPool(),
    private readonly context:ProductContextAdapter=new PostgresProductContextAdapter(productDataRepository()),
  ){}

  private async eligible(session:ProductSession):Promise<{organizationId:string;workspaceId:string}>{
    if(!session.workspace)throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","collaboration_workspace_required");
    const workspace=await this.context.workspaceForUser(session.identity.userRef,session.workspace.id);
    if(!workspace||workspace.organizationId!==session.workspace.organizationId)throw new ProductDataError("PRODUCT_DATA_FORBIDDEN","collaboration_forbidden");
    return{organizationId:workspace.organizationId,workspaceId:workspace.id};
  }

  async listGroups(session:ProductSession):Promise<SafeGroup[]>{
    const c=await this.eligible(session);
    return new CollaborationRepository(this.pool).listGroups(session.identity.userRef,c.organizationId,c.workspaceId);
  }

  async createGroup(session:ProductSession,name:string,idempotencyKey?:string):Promise<SafeGroup>{
    const c=await this.eligible(session);const safeName=boundedText(name,120,"group_name_invalid");const idem=boundedIdempotency(idempotencyKey);
    return withTransaction(this.pool,async db=>{
      const repo=new CollaborationRepository(db);const events=new ProductEventRepository(db);
      const value=await repo.createGroup(session.identity.userRef,c.organizationId,c.workspaceId,safeName);
      await events.append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"group.created",actorProductUserId:session.identity.userRef,subjectType:"group",subjectId:value.id,aggregateVersion:value.version,correlationId:session.correlationId,data:{name:value.name},...(idem?{idempotencyKey:`group:${idem}`}:{})});
      return value;
    });
  }

  async getGroup(session:ProductSession,id:string):Promise<SafeGroup>{
    const c=await this.eligible(session);const value=await new CollaborationRepository(this.pool).getGroup(session.identity.userRef,c.organizationId,c.workspaceId,id);
    if(!value)throw new ProductDataError("PRODUCT_DATA_NOT_FOUND","group_not_found");return value;
  }

  async updateGroup(session:ProductSession,id:string,input:{name:string;status:"active"|"archived";expectedVersion:number}):Promise<SafeGroup>{
    const c=await this.eligible(session);const safeName=boundedText(input.name,120,"group_name_invalid");
    return withTransaction(this.pool,async db=>{
      const repo=new CollaborationRepository(db);const value=await repo.updateGroup(session.identity.userRef,c.organizationId,c.workspaceId,id,safeName,input.status,input.expectedVersion);
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"group.updated",actorProductUserId:session.identity.userRef,subjectType:"group",subjectId:value.id,aggregateVersion:value.version,correlationId:session.correlationId,data:{status:value.status}});
      return value;
    });
  }

  async listMessages(session:ProductSession,groupId:string,cursor?:string,limit=50):Promise<{messages:SafeMessage[];nextCursor?:string}>{
    const c=await this.eligible(session);
    return new CollaborationRepository(this.pool).listMessages(session.identity.userRef,c.organizationId,c.workspaceId,groupId,cursor,limit);
  }

  async createMessage(session:ProductSession,groupId:string,body:string,idempotencyKey?:string):Promise<SafeMessage>{
    const c=await this.eligible(session);const safeBody=boundedText(body,8000,"message_body_invalid",{allowNewlines:true});const idem=boundedIdempotency(idempotencyKey);
    return withTransaction(this.pool,async db=>{
      const repo=new CollaborationRepository(db);const value=await repo.createMessage(session.identity.userRef,c.organizationId,c.workspaceId,groupId,safeBody);
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"message.created",actorProductUserId:session.identity.userRef,subjectType:"message",subjectId:value.id,aggregateVersion:value.version,correlationId:session.correlationId,data:{groupId:value.groupId},...(idem?{idempotencyKey:`message:${idem}`}:{})});
      return value;
    });
  }

  async addReaction(session:ProductSession,messageId:string,reactionKey:string):Promise<void>{
    const c=await this.eligible(session);const key=boundedKey(reactionKey,32);
    await withTransaction(this.pool,async db=>{
      await new CollaborationRepository(db).addReaction(session.identity.userRef,c.organizationId,c.workspaceId,messageId,key);
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"message.reaction_added",actorProductUserId:session.identity.userRef,subjectType:"message",subjectId:messageId,aggregateVersion:0,correlationId:session.correlationId,data:{reactionKey:key},idempotencyKey:`reaction:${messageId}:${session.identity.userRef}:${key}`});
    });
  }

  async initiateAttachment(session:ProductSession,input:{originalName:string;contentType:string;sizeBytes:number}):Promise<SafeAttachment>{
    const c=await this.eligible(session);const name=boundedText(input.originalName,240,"attachment_name_invalid");
    if(/[\\/]/.test(name)||!(/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,95}$/i.test(input.contentType)))throw new ProductDataError("PRODUCT_DATA_INVALID","attachment_metadata_invalid");
    if(!Number.isSafeInteger(input.sizeBytes)||input.sizeBytes<1||input.sizeBytes>52_428_800)throw new ProductDataError("PRODUCT_DATA_INVALID","attachment_size_invalid");
    return new CollaborationRepository(this.pool).initiateAttachment(session.identity.userRef,c.organizationId,c.workspaceId,name,input.contentType.toLowerCase(),input.sizeBytes);
  }

  async completeAttachment(session:ProductSession,id:string,input:{sha256Hex:string;expectedVersion:number}):Promise<SafeAttachment>{
    const c=await this.eligible(session);if(!/^[0-9a-f]{64}$/.test(input.sha256Hex))throw new ProductDataError("PRODUCT_DATA_INVALID","attachment_digest_invalid");
    return new CollaborationRepository(this.pool).completeAttachment(session.identity.userRef,c.organizationId,c.workspaceId,id,input.sha256Hex,input.expectedVersion);
  }

  async listNotifications(session:ProductSession):Promise<SafeNotification[]>{
    const c=await this.eligible(session);return new CollaborationRepository(this.pool).listNotifications(session.identity.userRef,c.organizationId,c.workspaceId);
  }

  async listApprovals(session:ProductSession):Promise<SafeApproval[]>{
    const c=await this.eligible(session);return new CollaborationRepository(this.pool).listApprovals(session.identity.userRef,c.organizationId,c.workspaceId);
  }

  async createApproval(session:ProductSession,input:{actionClass:string;subjectType:string;subjectId:string;evidenceDigestSha256?:string;expiresAt?:string;rationale?:string},idempotencyKey?:string):Promise<SafeApproval>{
    const c=await this.eligible(session);const actionClass=boundedKey(input.actionClass);const subjectType=boundedKey(input.subjectType,64);const subjectId=boundedText(input.subjectId,256,"approval_subject_invalid");const idem=boundedIdempotency(idempotencyKey);
    if(input.evidenceDigestSha256&&!/^[0-9a-f]{64}$/.test(input.evidenceDigestSha256))throw new ProductDataError("PRODUCT_DATA_INVALID","approval_digest_invalid");
    if(input.expiresAt&&!Number.isFinite(Date.parse(input.expiresAt)))throw new ProductDataError("PRODUCT_DATA_INVALID","approval_expiry_invalid");
    const rationale=input.rationale===undefined?undefined:boundedText(input.rationale,1000,"approval_rationale_invalid",{allowNewlines:true});
    return withTransaction(this.pool,async db=>{
      const value=await new CollaborationRepository(db).createApproval(session.identity.userRef,c.organizationId,c.workspaceId,{actionClass,subjectType,subjectId,...(input.evidenceDigestSha256?{evidenceDigestSha256:input.evidenceDigestSha256}:{}),...(input.expiresAt?{expiresAt:input.expiresAt}:{}),...(rationale?{rationale}:{}),correlationId:session.correlationId});
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"approval.requested",actorProductUserId:session.identity.userRef,subjectType:"approval",subjectId:value.id,aggregateVersion:value.version,correlationId:session.correlationId,data:{actionClass:value.actionClass},...(idem?{idempotencyKey:`approval:${idem}`}:{})});
      return value;
    });
  }

  async decideApproval(session:ProductSession,id:string,input:{decision:"APPROVED"|"REJECTED";expectedVersion:number;rationale?:string}):Promise<SafeApproval>{
    const c=await this.eligible(session);const rationale=input.rationale===undefined?undefined:boundedText(input.rationale,1000,"approval_rationale_invalid",{allowNewlines:true});
    return withTransaction(this.pool,async db=>{
      const value=await new CollaborationRepository(db).decideApproval(session.identity.userRef,c.organizationId,c.workspaceId,id,input.decision,input.expectedVersion,rationale);
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"approval.decided",actorProductUserId:session.identity.userRef,subjectType:"approval",subjectId:value.id,aggregateVersion:value.version,correlationId:session.correlationId,data:{decision:value.status}});
      return value;
    });
  }

  async recordAttachmentScan(session:ProductSession,id:string,scanState:"clean"|"infected"|"error",expectedVersion:number):Promise<SafeAttachment>{
    const c=await this.eligible(session);
    return withTransaction(this.pool,async db=>{
      const value=await new CollaborationRepository(db).recordAttachmentScan(c.organizationId,c.workspaceId,id,scanState,expectedVersion);
      if(scanState==="clean"||scanState==="infected"){
        await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:scanState==="clean"?"attachment.ready":"attachment.rejected",actorProductUserId:session.identity.userRef,subjectType:"attachment",subjectId:id,aggregateVersion:value.version,correlationId:session.correlationId,data:{scanState}});
      }
      return value;
    });
  }

  async createNotification(session:ProductSession,input:{notificationType:string;summary:string;subjectType?:string;subjectId?:string;idempotencyKey:string;expiresAt?:string}):Promise<SafeNotification>{
    const c=await this.eligible(session);const notificationType=boundedKey(input.notificationType);const summary=boundedText(input.summary,320,"notification_summary_invalid");const idempotencyKey=boundedIdempotency(input.idempotencyKey);
    if(!idempotencyKey)throw new ProductDataError("PRODUCT_DATA_INVALID","idempotency_key_invalid");
    const subjectType=input.subjectType===undefined?undefined:boundedKey(input.subjectType,64);
    const subjectId=input.subjectId===undefined?undefined:boundedText(input.subjectId,256,"notification_subject_invalid");
    return withTransaction(this.pool,async db=>{
      const value=await new CollaborationRepository(db).createNotification(session.identity.userRef,c.organizationId,c.workspaceId,{notificationType,summary,...(subjectType?{subjectType}:{}),...(subjectId?{subjectId}:{}),idempotencyKey,...(input.expiresAt?{expiresAt:input.expiresAt}:{})});
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"notification.created",actorProductUserId:session.identity.userRef,subjectType:"notification",subjectId:value.id,aggregateVersion:value.version,correlationId:session.correlationId,data:{notificationType},idempotencyKey:`notification:${idempotencyKey}`});
      return value;
    });
  }

  async markNotificationRead(session:ProductSession,id:string,expectedVersion:number):Promise<SafeNotification>{
    const c=await this.eligible(session);
    return withTransaction(this.pool,async db=>{
      const value=await new CollaborationRepository(db).markNotificationRead(session.identity.userRef,c.organizationId,c.workspaceId,id,expectedVersion);
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"notification.read",actorProductUserId:session.identity.userRef,subjectType:"notification",subjectId:id,aggregateVersion:value.version,correlationId:session.correlationId});
      return value;
    });
  }

  async cancelApproval(session:ProductSession,id:string,expectedVersion:number):Promise<SafeApproval>{
    const c=await this.eligible(session);
    return withTransaction(this.pool,async db=>{
      const value=await new CollaborationRepository(db).cancelApproval(session.identity.userRef,c.organizationId,c.workspaceId,id,expectedVersion);
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"approval.cancelled",actorProductUserId:session.identity.userRef,subjectType:"approval",subjectId:id,aggregateVersion:value.version,correlationId:session.correlationId});
      return value;
    });
  }

  async expireApproval(session:ProductSession,id:string,expectedVersion:number):Promise<SafeApproval>{
    const c=await this.eligible(session);
    return withTransaction(this.pool,async db=>{
      const value=await new CollaborationRepository(db).expireApproval(c.organizationId,c.workspaceId,id,expectedVersion);
      await new ProductEventRepository(db).append({organizationId:c.organizationId,workspaceId:c.workspaceId,type:"approval.expired",actorProductUserId:session.identity.userRef,subjectType:"approval",subjectId:id,aggregateVersion:value.version,correlationId:session.correlationId});
      return value;
    });
  }

  async replayEvents(session:ProductSession,cursor?:string,limit=50):Promise<ReplayPage>{
    const c=await this.eligible(session);return new ProductEventRepository(this.pool).replayForUser(session.identity.userRef,c.organizationId,c.workspaceId,cursor,limit);
  }

  static approvalIsOperationalAuthority(_status:ApprovalStatus):false{return false;}
}
