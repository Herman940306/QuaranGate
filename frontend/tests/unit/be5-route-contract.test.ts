import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only",()=>({}));

const mocks=vi.hoisted(()=>{
  const session={id:"sid",identity:{userRef:"user-a",subject:"sub"},workspace:{id:"ws-a",organizationId:"org-a",name:"Workspace"},version:1,issuedAt:1,expiresAt:Date.now()+60000,correlationId:"corr",csrfToken:"csrf",principalMapping:{state:"unmapped" as const},oidcTokens:{}};
  return{
    session,
    current:vi.fn(()=>session),
    collab:{
      listGroups:vi.fn(),createGroup:vi.fn(),listMessages:vi.fn(),createMessage:vi.fn(),addReaction:vi.fn(),
      initiateAttachment:vi.fn(),completeAttachment:vi.fn(),listApprovals:vi.fn(),createApproval:vi.fn(),decideApproval:vi.fn(),replayEvents:vi.fn(),
    },
  };
});
vi.mock("../../src/server/product/session/runtime",()=>({productSessionService:()=>({current:mocks.current})}));
vi.mock("../../src/server/product/collaboration/runtime",()=>({collaborationService:()=>mocks.collab}));

import { GET as getGroups, POST as postGroup } from "../../src/app/api/product/groups/route";
import { GET as getMessages, POST as postMessage } from "../../src/app/api/product/groups/[id]/messages/route";
import { POST as postReaction } from "../../src/app/api/product/messages/[id]/reactions/route";
import { POST as initiateAttachment } from "../../src/app/api/product/attachments/initiate/route";
import { POST as completeAttachment } from "../../src/app/api/product/attachments/[id]/complete/route";
import { GET as getApprovals, POST as postApproval } from "../../src/app/api/product/approvals/route";
import { POST as decideApproval } from "../../src/app/api/product/approvals/[id]/decision/route";
import { GET as getEvents } from "../../src/app/api/product/events/route";

const root=process.cwd();
function routeFiles(dir:string):string[]{return readdirSync(dir).flatMap((name)=>{const p=join(dir,name);return statSync(p).isDirectory()?routeFiles(p):name==="route.ts"?[relative(root,p)]:[];});}
function methods(path:string):string[]{const s=readFileSync(join(root,path),"utf8");return [...s.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)].map((m)=>m[1] as string);}
function request(path:string,body:unknown,headers:Record<string,string>={}):Request{return new Request(`https://app.example.invalid${path}`,{method:"POST",headers:{cookie:"qg_product_session=sid",origin:"https://app.example.invalid","sec-fetch-site":"same-origin","x-csrf-token":"csrf","content-type":"application/json",...headers},body:JSON.stringify(body)});}

describe("BE5 product route contract",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();mocks.current.mockReturnValue(mocks.session);
    mocks.collab.listGroups.mockResolvedValue([]);
    mocks.collab.createGroup.mockResolvedValue({id:"g"});
    mocks.collab.listMessages.mockResolvedValue({messages:[]});
    mocks.collab.createMessage.mockResolvedValue({id:"m"});
    mocks.collab.addReaction.mockResolvedValue(undefined);
    mocks.collab.initiateAttachment.mockResolvedValue({id:"a",status:"initiated"});
    mocks.collab.completeAttachment.mockResolvedValue({id:"a",status:"uploaded",scanState:"pending"});
    mocks.collab.listApprovals.mockResolvedValue([]);
    mocks.collab.createApproval.mockResolvedValue({id:"p",status:"PENDING"});
    mocks.collab.decideApproval.mockResolvedValue({id:"p",status:"APPROVED"});
    mocks.collab.replayEvents.mockResolvedValue({events:[]});
  });

  it("installs exactly the bounded BE5 route files and operations",()=>{
    const bases=["src/app/api/product/groups","src/app/api/product/messages","src/app/api/product/attachments","src/app/api/product/approvals","src/app/api/product/events"];
    const files=bases.flatMap((p)=>routeFiles(join(root,p))).sort();
    expect(files).toEqual([
      "src/app/api/product/approvals/[id]/decision/route.ts",
      "src/app/api/product/approvals/route.ts",
      "src/app/api/product/attachments/[id]/complete/route.ts",
      "src/app/api/product/attachments/initiate/route.ts",
      "src/app/api/product/events/route.ts",
      "src/app/api/product/groups/[id]/messages/route.ts",
      "src/app/api/product/groups/route.ts",
      "src/app/api/product/messages/[id]/reactions/route.ts",
    ]);
    const ops=files.flatMap((p)=>methods(p).map((m)=>`${m} ${p}`)).sort();
    expect(ops).toHaveLength(11);
    expect(ops.filter((x)=>x.startsWith("DELETE "))).toEqual([]);
    expect(ops).toContain("GET src/app/api/product/events/route.ts");
    expect(ops).not.toContain("POST src/app/api/product/events/route.ts");
  });

  it("has no generic event publish, storage proxy, authority or arbitrary target inputs",()=>{
    const source=["groups","messages","attachments","approvals","events"].flatMap((d)=>routeFiles(join(root,`src/app/api/product/${d}`))).map((p)=>readFileSync(join(root,p),"utf8")).join("\n");
    expect(source).not.toMatch(/principalRef|principalId|scopes|targetGrants|githubAccounts|agentBackends|storageRef|storageUrl|targetUrl|baseUrl|generic.?proxy|fetch\(/i);
  });

  it("group create enforces origin/CSRF before delegation",async()=>{
    const response=await postGroup(request("/api/product/groups",{name:"Team"},{origin:"https://evil.invalid","sec-fetch-site":"cross-site"}));
    expect(response.status).toBe(403);expect(mocks.collab.createGroup).not.toHaveBeenCalled();
  });

  it("message create delegates server session and ignores browser tenant/authority fields",async()=>{
    const response=await postMessage(request("/api/product/groups/g/messages",{body:"hello",organizationId:"evil",workspaceId:"evil",principalRef:"evil"}),{params:Promise.resolve({id:"g"})});
    expect(response.status).toBe(201);
    expect(mocks.collab.createMessage).toHaveBeenCalledWith(mocks.session,"g","hello",undefined);
  });

  it("reaction mutation is CSRF protected and idempotent service delegation only",async()=>{
    const response=await postReaction(request("/api/product/messages/m/reactions",{reaction:"ack"}),{params:Promise.resolve({id:"m"})});
    expect(response.status).toBe(200);
    expect(mocks.collab.addReaction).toHaveBeenCalledWith(mocks.session,"m","ack");
  });

  it("attachment initiate never accepts storage refs/URLs and complete preserves scan-state response",async()=>{
    const first=await initiateAttachment(request("/api/product/attachments/initiate",{originalName:"a.txt",contentType:"text/plain",sizeBytes:12,storageRef:"/etc/passwd",storageUrl:"http://169.254.169.254"}));
    expect(first.status).toBe(201);
    expect(mocks.collab.initiateAttachment).toHaveBeenCalledWith(mocks.session,{originalName:"a.txt",contentType:"text/plain",sizeBytes:12});
    const second=await completeAttachment(request("/api/product/attachments/a/complete",{sha256Hex:"a".repeat(64),expectedVersion:0}),{params:Promise.resolve({id:"a"})});
    expect(second.status).toBe(200);
    expect(JSON.stringify(await second.json())).toContain('"status":"uploaded"');
  });

  it("approval create and decision do not forward browser operational authority",async()=>{
    await postApproval(request("/api/product/approvals",{actionClass:"agent.apply",subjectType:"job",subjectId:"job-1",principalRef:"owner",scopes:["agents:apply"]}));
    expect(mocks.collab.createApproval).toHaveBeenCalledWith(mocks.session,{actionClass:"agent.apply",subjectType:"job",subjectId:"job-1"},undefined);
    await decideApproval(request("/api/product/approvals/p/decision",{decision:"APPROVED",expectedVersion:0,execute:true,tool:"agent_apply"}),{params:Promise.resolve({id:"p"})});
    expect(mocks.collab.decideApproval).toHaveBeenCalledWith(mocks.session,"p",{decision:"APPROVED",expectedVersion:0});
  });

  it("event replay is read-only, bounded and session-scoped",async()=>{
    const response=await getEvents(new Request("https://app.example.invalid/api/product/events?limit=25&cursor=abc",{headers:{cookie:"qg_product_session=sid"}}));
    expect(response.status).toBe(200);
    expect(mocks.collab.replayEvents).toHaveBeenCalledWith(mocks.session,"abc",25);
  });

  it("message and approval reads use the server session",async()=>{
    await getGroups(new Request("https://app.example.invalid/api/product/groups",{headers:{cookie:"qg_product_session=sid"}}));
    await getMessages(new Request("https://app.example.invalid/api/product/groups/g/messages",{headers:{cookie:"qg_product_session=sid"}}),{params:Promise.resolve({id:"g"})});
    await getApprovals(new Request("https://app.example.invalid/api/product/approvals",{headers:{cookie:"qg_product_session=sid"}}));
    expect(mocks.collab.listGroups).toHaveBeenCalledWith(mocks.session);
    expect(mocks.collab.listMessages).toHaveBeenCalledWith(mocks.session,"g",undefined,50);
    expect(mocks.collab.listApprovals).toHaveBeenCalledWith(mocks.session);
  });

  it("safe error envelopes redact collaboration internals",async()=>{
    mocks.collab.createMessage.mockRejectedValueOnce(new Error("raw secret /host/path token"));
    const response=await postMessage(request("/api/product/groups/g/messages",{body:"hello"}),{params:Promise.resolve({id:"g"})});
    const body=JSON.stringify(await response.json());
    expect(response.status).toBe(500);
    expect(body).not.toMatch(/raw secret|\/host\/path|token/);
  });
});
