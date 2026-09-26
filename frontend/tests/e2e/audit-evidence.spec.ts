import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
const reqId = "12345678-1234-1234-1234-123456789abc";
for (const width of [1280,360]) test(`FE13 safe metadata and stopped lineage at ${width}`, async ({ page },testInfo) => {
  await page.setViewportSize({width,height:900});
  await page.route("**/mcp",async route=>{const q=route.request().postDataJSON();expect(q.params).toEqual({name:"control_center_query",arguments:{view:"activity",limit:100,sinceMs:86400000}});await route.fulfill({json:{jsonrpc:"2.0",id:q.id,result:{structuredContent:{view:"activity",generatedAt:new Date().toISOString(),data:{retention:{storage:"memory",maxEntries:2048,maxAgeMs:86400000},rows:[{ts:new Date().toISOString(),reqId,principal:"safe",tool:"agent_dispatch",decision:"allow",target:"demo",durationMs:20,prompt:"PRIVATE PAYLOAD",jobId:"UNPROVEN JOB"}]}}}}});});
  await page.goto("/audit-evidence");await page.waitForLoadState("networkidle");await page.getByRole("button",{name:"Read audit metadata"}).click();
  await expect(page.getByRole("table",{name:"Chronological activity · newest first"})).toContainText(reqId);
  await page.getByLabel("Known request reference").selectOption(reqId);await expect(page.getByRole("table",{name:"Proven lineage"})).toContainText("UNKNOWN · no relationship exposed");
  await expect(page.getByText("PRIVATE PAYLOAD")).toHaveCount(0);await expect(page.getByText("UNPROVEN JOB")).toHaveCount(0);
  await page.getByRole("button",{name:"Read audit metadata"}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("table",{name:"Chronological activity · newest first"})).toContainText(reqId);
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
  await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});await page.screenshot({path:testInfo.outputPath(`audit-${width}.png`),fullPage:true});
});
test("FE13 unavailable does not create evidence",async({page})=>{await page.route("**/mcp",route=>route.fulfill({status:503,body:"private"}));await page.goto("/audit-evidence");await page.waitForLoadState("networkidle");await page.getByRole("button",{name:"Read audit metadata"}).click();await expect(page.getByText("The operational service is unavailable. Retry when it is reachable.")).toBeVisible();await expect(page.getByLabel("Known request reference")).toHaveCount(0);});
