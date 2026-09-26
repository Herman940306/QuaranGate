import { describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../../src/lib/client/github/client";
import type { Transport } from "../../src/lib/operational/transport";

function transport(result: unknown, onCall?: (name:string,args:Record<string,unknown>)=>void): Transport {
  return async (url, init) => {
    expect(url).toBe("/mcp");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).not.toHaveProperty("Authorization");
    const req=JSON.parse(String(init.body));
    onCall?.(req.params.name,req.params.arguments);
    return new Response(JSON.stringify({jsonrpc:"2.0",id:req.id,result:{structuredContent:result}}),{headers:{"content-type":"application/json"}});
  };
}
const repo={repository:"org/repo",owner:"org",repo:"repo",private:true,archived:false,localProject:"demo",protectedBranches:["main"]};
const pr={number:7,title:"Bounded PR",state:"open",draft:false,headRef:"feature/demo",baseRef:"main",author:"reviewer"};

describe("FE8 governed GitHub client",()=>{
  it("discovers only projected governed repository metadata",async()=>{
    const result=await createGitHubClient(transport({repositories:[{...repo,secret:"hidden"}]})).repositories();
    expect(result.data).toEqual([repo]);
    expect(JSON.stringify(result.data)).not.toContain("hidden");
  });
  it("bounds repository reads and review evidence",async()=>{
    expect((await createGitHubClient(transport({pulls:[pr]})).pulls("org/repo")).data[0]?.number).toBe(7);
    expect((await createGitHubClient(transport({files:[{filename:"src/a.ts",status:"modified",additions:2,deletions:1,changes:3,patch:"<script>diff</script>"}]})).files("org/repo",7)).data[0]?.patch).toBe("<script>diff</script>");
    expect((await createGitHubClient(transport({ref:"main",checkRuns:[],statuses:[{context:"ci/test",state:"success"}]})).checks("org/repo","main")).data.statuses[0]?.state).toBe("success");
  });
  it("uses closed exact arguments for remote review",async()=>{
    const calls:unknown[]=[];
    const client=createGitHubClient(transport({id:99,state:"APPROVED"},(name,args)=>calls.push([name,args])));
    const result=await client.reviewPull("org/repo",7,"APPROVE","Reviewed");
    expect(result.data).toEqual({id:99,state:"APPROVED"});
    expect(calls).toEqual([["github_pull_request_review",{repository:"org/repo",number:7,event:"APPROVE",body:"Reviewed"}]]);
  });
  it("requires exact SHA and bounded project for push before transport",()=>{
    const call=vi.fn();
    const client=createGitHubClient(call);
    expect(()=>client.push("demo","not-a-sha","feature/demo")).toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  it("rejects empty PR updates locally",()=>{
    const call=vi.fn();
    const client=createGitHubClient(call);
    expect(()=>client.updatePull("org/repo",7,{})).toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});
