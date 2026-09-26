import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productRoutes } from "../../src/lib/navigation";
const primary = ["/overview","/arena","/projects","/targets","/files","/terminal","/git","/processes","/agents","/jobs","/approvals","/ide-sessions","/github","/models","/monitoring","/statistics","/security","/audit-evidence","/recovery-backups","/settings","/tool-lab"];
describe("frontend convergence route coverage",()=>{
  it("maps all 21 required product surfaces to routes and shell navigation",()=>{const paths=productRoutes.map(([path])=>path as string);expect(new Set(paths).size).toBe(paths.length);for(const path of primary){expect(paths).toContain(path);expect(existsSync(`src/app/(foundation)${path}/page.tsx`)).toBe(true);}});
});
