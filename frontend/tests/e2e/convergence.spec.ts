import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
const primary = ["/overview","/arena","/projects","/targets","/files","/terminal","/git","/processes","/agents","/jobs","/approvals","/ide-sessions","/github","/models","/monitoring","/statistics","/security","/audit-evidence","/recovery-backups","/settings","/tool-lab"];
for(const width of [1280,360]) test(`all 21 product surfaces: shell, axe, unknown state and storage at ${width}`,async({page,context},testInfo)=>{
  test.setTimeout(180000);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.name));
  await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:"reduce"});await page.route("**/mcp",route=>route.fulfill({status:503,body:"Unavailable"}));
  for(const route of primary){
    await page.goto(route);await page.waitForLoadState("networkidle");await expect(page.locator("main h1")).toHaveCount(1);await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator(`aside.rail nav a[href="${route}"]`)).toHaveCount(1);await expect(page.getByText("Product authority is enforced by the server.")).toBeVisible();
    expect((await new AxeBuilder({page}).analyze()).violations,route).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),route).toBeLessThanOrEqual(1);
    expect(await page.evaluate(async()=>({local:localStorage.length,session:sessionStorage.length,databases:(await indexedDB.databases()).length,search:location.search,hash:location.hash})),route).toEqual({local:0,session:0,databases:0,search:"",hash:""});expect(await context.cookies()).toEqual([]);
  }
  expect(errors).toEqual([]);expect(await page.evaluate(()=>matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  if(width===360){await page.getByRole("button",{name:"Open navigation"}).focus();await page.keyboard.press("Enter");for(const route of primary)await expect(page.getByRole("dialog").locator(`a[href="${route}"]`)).toBeVisible();await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Open navigation"})).toBeFocused();}
  await page.getByRole("button",{name:"Find pages & tools",exact:true}).focus();await page.keyboard.press("Control+k");await expect(page.getByRole("dialog")).toBeVisible();await page.keyboard.press("Tab");await expect(page.getByLabel("Find page or tool")).toBeFocused();await page.keyboard.press("Shift+Tab");await expect(page.getByRole("dialog").getByRole("button",{name:"Close",exact:true})).toBeFocused();expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Find pages & tools",exact:true})).toBeFocused();
  await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo(0,0);});await page.screenshot({path:testInfo.outputPath(`convergence-${width}.png`),fullPage:true});
});
