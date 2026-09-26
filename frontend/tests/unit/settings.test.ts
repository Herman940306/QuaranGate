import { describe, expect, it } from "vitest";
import { settingsIdentity } from "../../src/lib/settings";
import type { IdentityState } from "../../src/lib/identity/contracts";
describe("FE15 identity display",()=>{
  it("keeps absent session data unknown without fabricating an identity",()=>{expect(settingsIdentity({kind:"unavailable"})).toContainEqual({label:"Product identity",value:"NOT_AVAILABLE"});expect(settingsIdentity({kind:"revoked"})).toContainEqual({label:"Principal mapping",value:"UNKNOWN"});});
  it("does not turn identity roles or capabilities into authority",()=>{const state={kind:"active",session:{user:{displayName:"Safe"},workspace:{name:"Demo"},principal:{status:"unmapped"},roles:["admin"],capabilitySummary:["allow-all"],credential:"omit"}} as unknown as IdentityState;const rows=settingsIdentity(state);expect(rows).toContainEqual({label:"Principal mapping",value:"unmapped"});expect(JSON.stringify(rows)).not.toContain("admin");expect(JSON.stringify(rows)).not.toContain("allow-all");expect(JSON.stringify(rows)).not.toContain("omit");});
});
