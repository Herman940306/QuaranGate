import { describe, expect, it } from "vitest";
import { resources } from "../../src/lib/operational/recovery";
import { control } from "../../src/lib/operational/contracts";
describe("FE14 informational recovery",()=>{
  it("keeps missing resource evidence UNKNOWN and discards raw resource data",()=>{const result=resources({view:"resources",generatedAt:"now",data:{resources:[{credential:"omit"}]}});expect(result.state).toBe("UNKNOWN");expect(JSON.stringify(result)).not.toContain("omit");});
  it("projects only exposed recovery fields without inferring success",()=>{const result=control("recovery",{view:"recovery",generatedAt:"now",data:{startupRecovery:"CONFIGURED",backups:"MANAGED_OUTSIDE_CONSOLE",quarantine:"omit"}});expect(result.rows).toContainEqual({label:"providerSessionRecovery",value:"UNKNOWN"});expect(JSON.stringify(result)).not.toContain("omit");expect(JSON.stringify(result)).not.toContain("RECOVERED");});
  it("rejects a wrong view or malformed state",()=>{expect(()=>resources({view:"recovery",generatedAt:"now",data:{}})).toThrow();expect(()=>resources({view:"resources",generatedAt:"now",data:{state:{allowed:true}}})).toThrow();});
});
