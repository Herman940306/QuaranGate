import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only",()=>({}));

import type { QueryExecutor, QueryResultLike } from "../../src/server/product/data/db";
import { ProductDataError } from "../../src/server/product/data/errors";
import { readProductMigrationsThroughBe5 } from "../../src/server/product/collaboration/migrations";
import { assertSafeEventPayload, decodeReplayCursor, encodeReplayCursor, ProductEventRepository } from "../../src/server/product/collaboration/events";
import { CollaborationRepository } from "../../src/server/product/collaboration/repository";
import { EphemeralPresenceStore } from "../../src/server/product/collaboration/presence";
import { UnavailableRealtimeTransport } from "../../src/server/product/collaboration/transport";
import { CollaborationService } from "../../src/server/product/collaboration/service";

type Call={text:string;values?:readonly unknown[]};
class ScriptedDb implements QueryExecutor{
  readonly calls:Call[]=[];
  constructor(private readonly responses:QueryResultLike<Record<string,unknown>>[]=[]){}
  async query<T>(text:string,values?:readonly unknown[]):Promise<QueryResultLike<T>>{
    this.calls.push({text,values});
    return (this.responses.shift()??{rows:[],rowCount:0}) as QueryResultLike<T>;
  }
}

const NOW="2026-09-26T00:00:00.000Z";
const USER="11111111-1111-4111-8111-111111111111";
const ORG="22222222-2222-4222-8222-222222222222";
const WS="33333333-3333-4333-8333-333333333333";
const GROUP="44444444-4444-4444-8444-444444444444";
const MESSAGE="55555555-5555-4555-8555-555555555555";
const ATTACHMENT="66666666-6666-4666-8666-666666666666";
const APPROVAL="77777777-7777-4777-8777-777777777777";

function eventRow(seq=1){
  return{id:"88888888-8888-4888-8888-888888888888",organization_id:ORG,workspace_id:WS,event_type:"group.created",event_version:1,actor_product_user_id:USER,subject_type:"group",subject_id:GROUP,aggregate_version:0,stream_key:"workspace",sequence:seq,correlation_id:"corr",payload:{name:"Team"},created_at:NOW};
}
function groupRow(){return{id:GROUP,organization_id:ORG,workspace_id:WS,name:"Team",status:"active",version:0,created_by:USER,created_at:NOW,updated_at:NOW};}
function messageRow(){return{id:MESSAGE,group_id:GROUP,organization_id:ORG,workspace_id:WS,author_product_user_id:USER,body:"<script>alert(1)</script> is inert text",version:0,created_at:NOW,edited_at:null};}
function attachmentRow(){return{id:ATTACHMENT,organization_id:ORG,workspace_id:WS,uploader_product_user_id:USER,original_name:"report.txt",content_type:"text/plain",size_bytes:12,sha256_hex:"a".repeat(64),storage_ref:`qg-attachment:${ATTACHMENT}`,scan_state:"pending",status:"uploaded",version:1,created_at:NOW,updated_at:NOW};}
function approvalRow(status="PENDING",version=0){return{id:APPROVAL,organization_id:ORG,workspace_id:WS,requester_product_user_id:USER,decision_product_user_id:null,action_class:"agent.apply",subject_type:"job",subject_id:"job-safe-ref",evidence_digest_sha256:"b".repeat(64),request_correlation_id:"corr",rationale:null,status,expires_at:null,decided_at:null,version,created_at:NOW,updated_at:NOW};}

describe("BE5 migration and durable event contracts",()=>{
  it("composes accepted migrations through 0004 with checksums",async()=>{
    const migrations=await readProductMigrationsThroughBe5();
    expect(migrations.map(({version,name})=>({version,name}))).toEqual([
      {version:1,name:"0001_product_context.sql"},
      {version:2,name:"0002_principal_mapping.sql"},
      {version:3,name:"0003_provider_configuration.sql"},
      {version:4,name:"0004_collaboration_events.sql"},
    ]);
    expect(migrations.every((m)=>/^[0-9a-f]{64}$/.test(m.checksum))).toBe(true);
  });

  it("schema has tenant FKs, optimistic versions, bounded states and no authority/secret columns",()=>{
    const sql=readFileSync(join(process.cwd(),"src/server/product/collaboration/migrations/0004_collaboration_events.sql"),"utf8");
    for(const table of ["product_events","collaboration_groups","collaboration_messages","collaboration_reactions","collaboration_attachments","product_notifications","product_approvals","product_autonomous_policies"])expect(sql).toContain(`CREATE TABLE ${table}`);
    expect(sql).toContain("FOREIGN KEY (workspace_id, organization_id)");
    expect(sql.match(/CHECK \(version >= 0\)/g)?.length).toBeGreaterThanOrEqual(7);
    expect(sql).toContain("CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'))");
    expect(sql).not.toMatch(/secret_value|access_token|refresh_token|id_token|session_cookie|mcp_scope|target_grant|github_grant|docker_authority/i);
  });

  it("event payload rejects secret/authority keys, secret-shaped values, depth and oversized data",()=>{
    expect(()=>assertSafeEventPayload({secretValue:"x"})).toThrow();
    const tokenShaped=["ghp","abcdefghijklmnopqrstuvwxyz123456"].join("_");
    expect(()=>assertSafeEventPayload({safe:tokenShaped})).toThrow();
    expect(()=>assertSafeEventPayload({grants:["agents:apply"]})).toThrow();
    expect(()=>assertSafeEventPayload({summary:"x".repeat(3000)})).toThrow();
    expect(()=>assertSafeEventPayload({groupId:GROUP,status:"active"})).not.toThrow();
  });

  it("replay cursor round-trips monotonically and rejects malformed cursor",()=>{
    expect(decodeReplayCursor(encodeReplayCursor(42))).toBe(42);
    expect(()=>decodeReplayCursor("not-a-cursor")).toThrow(ProductDataError);
  });

  it("appends a workspace sequence and safe event using parameterized values",async()=>{
    const db=new ScriptedDb([
      {rows:[{sequence:1}],rowCount:1},
      {rows:[eventRow(1)],rowCount:1},
    ]);
    const event=await new ProductEventRepository(db).append({organizationId:ORG,workspaceId:WS,type:"group.created",actorProductUserId:USER,subjectType:"group",subjectId:GROUP,aggregateVersion:0,correlationId:"corr",data:{name:"Team"}});
    expect(event.sequence).toBe(1);
    expect(db.calls[0]?.text).toContain("product_event_sequences");
    expect(db.calls[1]?.text).not.toContain("Team");
    expect(db.calls[1]?.values).toContain(JSON.stringify({name:"Team"}));
  });

  it("deduplicates an event idempotency key before allocating another sequence",async()=>{
    const db=new ScriptedDb([{rows:[eventRow(7)],rowCount:1}]);
    const event=await new ProductEventRepository(db).append({organizationId:ORG,workspaceId:WS,type:"group.created",subjectType:"group",subjectId:GROUP,aggregateVersion:0,correlationId:"corr",idempotencyKey:"group:req-1"});
    expect(event.sequence).toBe(7);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.values).toEqual([WS,"group:req-1"]);
  });

  it("durable replay cursor state is initialized and advanced with optimistic versioning",async()=>{
    const initDb=new ScriptedDb([
      {rows:[],rowCount:1},
      {rows:[{last_sequence:0,version:0}],rowCount:1},
      {rows:[{last_sequence:5,version:1}],rowCount:1},
    ]);
    const repo=new ProductEventRepository(initDb);
    expect(await repo.ensureDurableCursor(ORG,WS,"browser-session")).toEqual({lastSequence:0,version:0});
    expect(await repo.advanceDurableCursor(ORG,WS,"browser-session",5,0)).toEqual({lastSequence:5,version:1});
    expect(initDb.calls[2]?.text).toContain("version=version+1");
  });

  it("stale durable replay cursor fails closed",async()=>{
    const db=new ScriptedDb([{rows:[],rowCount:0}]);
    await expect(new ProductEventRepository(db).advanceDurableCursor(ORG,WS,"browser-session",5,9))
      .rejects.toMatchObject({code:"PRODUCT_DATA_STALE_VERSION"});
  });

  it("replay is user/org/workspace bound and paginated by opaque cursor",async()=>{
    const db=new ScriptedDb([{rows:[eventRow(2),eventRow(3)],rowCount:2}]);
    const page=await new ProductEventRepository(db).replayForUser(USER,ORG,WS,encodeReplayCursor(1),1);
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBe(encodeReplayCursor(2));
    expect(db.calls[0]?.values).toEqual([USER,ORG,WS,1,2]);
    expect(db.calls[0]?.text).toContain("m.product_user_id = $1");
    expect(db.calls[0]?.text).toContain("e.workspace_id = $3");
  });
});

describe("BE5 collaboration repository isolation and lifecycle",()=>{
  it("lists groups only through explicit active membership",async()=>{
    const db=new ScriptedDb([{rows:[groupRow()],rowCount:1}]);
    const values=await new CollaborationRepository(db).listGroups(USER,ORG,WS);
    expect(values[0]?.id).toBe(GROUP);
    expect(db.calls[0]?.values).toEqual([USER,ORG,WS]);
    expect(db.calls[0]?.text).toContain("collaboration_group_members");
  });

  it("group create/update are membership bound and optimistic",async()=>{
    const createDb=new ScriptedDb([
      {rows:[groupRow()],rowCount:1},
      {rows:[],rowCount:1},
    ]);
    expect((await new CollaborationRepository(createDb).createGroup(USER,ORG,WS,"Team")).name).toBe("Team");
    expect(createDb.calls[0]?.values?.slice(1)).toEqual([ORG,WS,"Team",USER]);
    expect(createDb.calls[1]?.text).toContain("'owner'");

    const updateDb=new ScriptedDb([{rows:[{...groupRow(),name:"Renamed",version:1}],rowCount:1}]);
    const updated=await new CollaborationRepository(updateDb).updateGroup(USER,ORG,WS,GROUP,"Renamed","active",0);
    expect(updated.version).toBe(1);
    expect(updateDb.calls[0]?.text).toContain("g.version=$6");
    expect(updateDb.calls[0]?.text).toContain("gm.role='owner'");
  });

  it("message create requires group membership and stores HTML as inert text",async()=>{
    const db=new ScriptedDb([{rows:[messageRow()],rowCount:1}]);
    const value=await new CollaborationRepository(db).createMessage(USER,ORG,WS,GROUP,"<script>alert(1)</script> is inert text");
    expect(value.body).toContain("<script>");
    expect(db.calls[0]?.text).not.toContain("<script>");
    expect(db.calls[0]?.values).toEqual(expect.arrayContaining([USER,GROUP,ORG,WS]));
  });

  it("cross-tenant message lookup is bound to user/org/workspace/group",async()=>{
    const db=new ScriptedDb([{rows:[],rowCount:0}]);
    const page=await new CollaborationRepository(db).listMessages("other-user","other-org","other-ws",GROUP,undefined,20);
    expect(page.messages).toEqual([]);
    expect(db.calls[0]?.values?.slice(0,4)).toEqual(["other-user","other-org","other-ws",GROUP]);
  });

  it("reaction insert is idempotent for the same user/message/reaction",async()=>{
    const db=new ScriptedDb([
      {rows:[],rowCount:0},
      {rows:[{"?column?":1}],rowCount:1},
    ]);
    await expect(new CollaborationRepository(db).addReaction(USER,ORG,WS,MESSAGE,"ack")).resolves.toBeUndefined();
    expect(db.calls[0]?.text).toContain("ON CONFLICT DO NOTHING");
  });

  it("service rejects malformed/control-character message content before persistence",async()=>{
    const context={workspaceForUser:vi.fn(async()=>({id:WS,organizationId:ORG,name:"Workspace"})),resolveIdentity:vi.fn()};
    const svc=new CollaborationService({} as never,context as never);
    const session={id:"sid",identity:{userRef:USER,subject:"sub"},workspace:{id:WS,organizationId:ORG,name:"Workspace"},version:1,issuedAt:1,expiresAt:2,correlationId:"corr",csrfToken:"csrf",principalMapping:{state:"unmapped" as const},oidcTokens:{}};
    await expect(svc.createMessage(session,GROUP,"bad\u0000text")).rejects.toMatchObject({code:"PRODUCT_DATA_INVALID"});
    await expect(svc.createMessage(session,GROUP,"\ud800")).rejects.toMatchObject({code:"PRODUCT_DATA_INVALID"});
  });

  it("attachment completion remains uploaded/pending rather than trusted safe",async()=>{
    const db=new ScriptedDb([{rows:[attachmentRow()],rowCount:1}]);
    const value=await new CollaborationRepository(db).completeAttachment(USER,ORG,WS,ATTACHMENT,"a".repeat(64),0);
    expect(value.status).toBe("uploaded");
    expect(value.scanState).toBe("pending");
    expect(JSON.stringify(value)).not.toContain("qg-attachment:");
  });

  it("attachment scan state alone controls safe/rejected status",async()=>{
    const cleanDb=new ScriptedDb([{rows:[{...attachmentRow(),scan_state:"clean",status:"safe",version:2}],rowCount:1}]);
    expect((await new CollaborationRepository(cleanDb).recordAttachmentScan(ORG,WS,ATTACHMENT,"clean",1)).status).toBe("safe");
    const infectedDb=new ScriptedDb([{rows:[{...attachmentRow(),scan_state:"infected",status:"rejected",version:2}],rowCount:1}]);
    expect((await new CollaborationRepository(infectedDb).recordAttachmentScan(ORG,WS,ATTACHMENT,"infected",1)).status).toBe("rejected");
  });

  it("internal notification/attachment/approval lifecycle methods emit only accepted durable event families",()=>{
    const source=readFileSync(join(process.cwd(),"src/server/product/collaboration/service.ts"),"utf8");
    for(const type of ["notification.created","notification.read","attachment.ready","attachment.rejected","approval.cancelled","approval.expired"])expect(source).toContain(type);
    expect(source).not.toMatch(/type:"(?:scope|grant|authority|credential|secret)\./);
  });

  it("notification read transition is scoped and optimistic without exposing subject refs",async()=>{
    const row={id:"99999999-9999-4999-8999-999999999999",organization_id:ORG,workspace_id:WS,product_user_id:USER,notification_type:"approval.requested",summary:"Approval requested",subject_type:"approval",subject_id:APPROVAL,read_at:NOW,dismissed_at:null,expires_at:null,version:1,created_at:NOW,updated_at:NOW};
    const db=new ScriptedDb([{rows:[row],rowCount:1}]);
    const value=await new CollaborationRepository(db).markNotificationRead(USER,ORG,WS,row.id,0);
    expect(value.readAt).toBe(NOW);
    expect(JSON.stringify(value)).not.toContain(APPROVAL);
    expect(db.calls[0]?.values).toEqual([row.id,USER,ORG,WS,0]);
  });

  it("approval create and rejection are durable decision records only",async()=>{
    const createDb=new ScriptedDb([{rows:[approvalRow("PENDING",0)],rowCount:1}]);
    const created=await new CollaborationRepository(createDb).createApproval(USER,ORG,WS,{actionClass:"agent.apply",subjectType:"job",subjectId:"job-safe-ref",evidenceDigestSha256:"b".repeat(64),correlationId:"corr"});
    expect(created.status).toBe("PENDING");
    const rejectDb=new ScriptedDb([{rows:[{...approvalRow("REJECTED",1),decision_product_user_id:USER,decided_at:NOW}],rowCount:1}]);
    const rejected=await new CollaborationRepository(rejectDb).decideApproval(USER,ORG,WS,APPROVAL,"REJECTED",0);
    expect(rejected.status).toBe("REJECTED");
    expect(CollaborationService.approvalIsOperationalAuthority(rejected.status)).toBe(false);
  });

  it("approval stale decision fails closed and never invokes an operational action",async()=>{
    const db=new ScriptedDb([{rows:[],rowCount:0}]);
    await expect(new CollaborationRepository(db).decideApproval(USER,ORG,WS,APPROVAL,"APPROVED",9))
      .rejects.toMatchObject({code:"PRODUCT_DATA_STALE_VERSION"});
    expect(CollaborationService.approvalIsOperationalAuthority("APPROVED")).toBe(false);
    expect(db.calls[0]?.text).not.toMatch(/agent_apply|target_|github_|terminal_exec|mcp/i);
  });

  it("approval cancellation and expiry are explicit bounded states",async()=>{
    const cancelDb=new ScriptedDb([{rows:[approvalRow("CANCELLED",1)],rowCount:1}]);
    expect((await new CollaborationRepository(cancelDb).cancelApproval(USER,ORG,WS,APPROVAL,0)).status).toBe("CANCELLED");
    const expireDb=new ScriptedDb([{rows:[approvalRow("EXPIRED",1)],rowCount:1}]);
    expect((await new CollaborationRepository(expireDb).expireApproval(ORG,WS,APPROVAL,0)).status).toBe("EXPIRED");
  });

  it("notification reads are user/workspace scoped and do not expose referenced object authority",async()=>{
    const db=new ScriptedDb([{rows:[],rowCount:0}]);
    expect(await new CollaborationRepository(db).listNotifications(USER,ORG,WS)).toEqual([]);
    expect(db.calls[0]?.values).toEqual([USER,ORG,WS]);
    expect(db.calls[0]?.text).not.toMatch(/JOIN.*subject|principal|scope|grant/i);
  });

  it("autonomous policy create/update is product-only metadata with optimistic versioning",async()=>{
    const createRow={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",organization_id:ORG,workspace_id:WS,action_class:"agent.apply",enabled:true,approval_requirement:"required",max_operations:5,version:0,created_by:USER,created_at:NOW,updated_at:NOW};
    const createDb=new ScriptedDb([{rows:[createRow],rowCount:1}]);
    const created=await new CollaborationRepository(createDb).createPolicy(USER,ORG,WS,{actionClass:"agent.apply",enabled:true,approvalRequirement:"required",maxOperations:5});
    expect(created.approvalRequirement).toBe("required");
    const updateDb=new ScriptedDb([{rows:[{"?column?":1}],rowCount:1},{rows:[{...createRow,enabled:false,version:1}],rowCount:1}]);
    const updated=await new CollaborationRepository(updateDb).updatePolicy(USER,ORG,WS,createRow.id,{enabled:false,approvalRequirement:"required",maxOperations:5,expectedVersion:0});
    expect(updated.version).toBe(1);
    expect(updateDb.calls[1]?.text).toContain("version=version+1");
    expect(JSON.stringify(updated)).not.toMatch(/principal|scope|grant|docker|github/i);
  });

  it("autonomous policy lookup is product metadata only",async()=>{
    const db=new ScriptedDb([{rows:[{"?column?":1}],rowCount:1},{rows:[],rowCount:0}]);
    expect(await new CollaborationRepository(db).getPolicy(USER,ORG,WS,"agent.apply")).toBeUndefined();
    const source=readFileSync(join(process.cwd(),"src/server/product/collaboration/repository.ts"),"utf8");
    expect(source).not.toMatch(/principalHasScope|principalCanTarget|keyHash|githubAccounts|agentBackends/);
  });
});

describe("BE5 ephemeral presence and transport boundary",()=>{
  it("expires presence and typing without durable history",()=>{
    const store=new EphemeralPresenceStore();
    store.setPresence(USER,WS,"online",2_000,1_000);
    expect(store.listPresence(WS,2_000)).toHaveLength(1);
    expect(store.listPresence(WS,3_001)).toEqual([]);
    store.setTyping(USER,WS,GROUP,1_000,1_000);
    expect(store.listTyping(WS,GROUP,1_500)).toHaveLength(1);
    expect(store.listTyping(WS,GROUP,2_001)).toEqual([]);
  });

  it("live realtime transport is fail-closed unavailable",async()=>{
    const transport=new UnavailableRealtimeTransport();
    await expect(transport.status()).resolves.toBe("unavailable");
    await expect(transport.deliver({productUserId:USER,organizationId:ORG,workspaceId:WS},[])).rejects.toThrow("realtime_transport_unavailable");
  });
});
