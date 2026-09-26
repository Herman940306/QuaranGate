import "server-only";

export type PresenceState = "online" | "away";
export interface PresenceRecord {
  productUserId: string;
  workspaceId: string;
  state: PresenceState;
  expiresAt: number;
}
export interface TypingRecord {
  productUserId: string;
  workspaceId: string;
  groupId: string;
  expiresAt: number;
}

export class EphemeralPresenceStore {
  private readonly presence = new Map<string, PresenceRecord>();
  private readonly typing = new Map<string, TypingRecord>();

  setPresence(productUserId:string,workspaceId:string,state:PresenceState,ttlMs=30_000,now=Date.now()):PresenceRecord{
    const ttl=Math.max(1_000,Math.min(60_000,Math.trunc(ttlMs)));
    const record={productUserId,workspaceId,state,expiresAt:now+ttl};
    this.presence.set(`${workspaceId}:${productUserId}`,record);
    return record;
  }

  listPresence(workspaceId:string,now=Date.now()):PresenceRecord[]{
    const out:PresenceRecord[]=[];
    for(const [key,record] of this.presence){
      if(record.expiresAt<=now){this.presence.delete(key);continue;}
      if(record.workspaceId===workspaceId)out.push(record);
    }
    return out;
  }

  setTyping(productUserId:string,workspaceId:string,groupId:string,ttlMs=8_000,now=Date.now()):TypingRecord{
    const ttl=Math.max(1_000,Math.min(15_000,Math.trunc(ttlMs)));
    const record={productUserId,workspaceId,groupId,expiresAt:now+ttl};
    this.typing.set(`${workspaceId}:${groupId}:${productUserId}`,record);
    return record;
  }

  listTyping(workspaceId:string,groupId:string,now=Date.now()):TypingRecord[]{
    const out:TypingRecord[]=[];
    for(const [key,record] of this.typing){
      if(record.expiresAt<=now){this.typing.delete(key);continue;}
      if(record.workspaceId===workspaceId&&record.groupId===groupId)out.push(record);
    }
    return out;
  }
}
