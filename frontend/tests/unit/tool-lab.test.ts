import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { toolCatalog } from "../../src/lib/operational/tool-catalog";
import { compareTools, discoveryPage } from "../../src/lib/operational/tool-discovery";
import { createOperationalClient } from "../../src/lib/operational/client";
import type { Transport } from "../../src/lib/operational/transport";
const tools = toolCatalog.map(tool=>({name:tool.name,fields:[]}));
const response = (result: unknown): Transport => async(_url,init)=>new Response(JSON.stringify({jsonrpc:"2.0",id:JSON.parse(String(init.body)).id,result}),{headers:{"content-type":"application/json"}});
describe("FE16 exact current MCP catalog",()=>{
  it("matches current gateway registrations without a historical count",()=>{
    const names = new Set<string>();
    for(const file of ["mcp.ts","agentTools.ts","githubTools.ts","controlCenterTools.ts"]){const source=readFileSync(`../src/gateway/${file}`,"utf8");for(const match of source.matchAll(/(?:registerTool|targetControlTool|gitTool)\('([^']+)'/g)) names.add(match[1]);}
    expect(toolCatalog.map(tool=>tool.name).sort()).toEqual([...names].sort());
  });
  it("compares names exactly and reports missing/extra",()=>{
    expect(compareTools(tools)).toEqual({expected:tools.length,live:tools.length,missing:[],extra:[]});
    const drift=compareTools([...tools.slice(1),{name:"additional_tool",fields:[]}]);expect(drift.missing).toEqual([tools[0].name]);expect(drift.extra).toEqual(["additional_tool"]);
    expect(()=>compareTools([tools[0],tools[0]])).toThrow();
  });
  it("preserves impact classifications without permission inference",()=>{
    expect(toolCatalog.find(tool=>tool.name==="terminal_exec")?.authority).toBe("Execution");expect(toolCatalog.find(tool=>tool.name==="agent_apply")?.authority).toBe("Destructive");expect(toolCatalog.find(tool=>tool.name==="fs_write")?.authority).toBe("Write");expect(toolCatalog.find(tool=>tool.name==="fs_read")?.authority).toBe("Read");
  });
  it("drops arbitrary schema bodies/defaults/descriptions",()=>{const result=discoveryPage({tools:[{name:"fs_read",description:"omit",inputSchema:{properties:{path:{type:"string",maxLength:256,default:"omit",description:"omit"}},required:["path"]}}]});expect(JSON.stringify(result)).not.toContain("omit");expect(result.tools[0].fields).toEqual([{name:"path",type:"string",required:true,min:null,max:256}]);});
  it("uses only fixed tools/list, same-origin /mcp and bounded pagination",async()=>{
    let calls=0;const transport=vi.fn(async(url,init)=>{const q=JSON.parse(String(init.body));expect(url).toBe("/mcp");expect(q.method).toBe("tools/list");expect(init.credentials).toBe("same-origin");expect(init.redirect).toBe("error");expect(q.params).toEqual(calls++ ? {cursor:"next"}:{});return response(calls===1?{tools:[{name:"first"}],nextCursor:"next"}:{tools:[{name:"second"}]})(url,init);}) as Transport;
    expect((await createOperationalClient(transport).discoverTools()).data.map(tool=>tool.name)).toEqual(["first","second"]);
  });
  it("fails closed on duplicate tools, repeated cursor and unsafe responses",async()=>{
    for(const result of [{tools:[{name:"duplicate"},{name:"duplicate"}]},{tools:[],nextCursor:"repeated"},{tools:[{name:"arbitrary/url"}]}]) await expect(createOperationalClient(response(result)).discoverTools()).rejects.toMatchObject({state:"unknown"});
    await expect(createOperationalClient(async()=>new Response("private",{status:403})).discoverTools()).rejects.toMatchObject({state:"forbidden"});
  });
  it("cancels before discovery and never leaks transport errors",async()=>{const abort=new AbortController();abort.abort();const fetch=vi.fn(response({tools:[]}));await expect(createOperationalClient(fetch).discoverTools(abort.signal)).rejects.toMatchObject({state:"cancelled"});expect(fetch).not.toHaveBeenCalled();await expect(createOperationalClient(async()=>{throw Error("private");}).discoverTools()).rejects.toMatchObject({state:"unavailable"});});
});
