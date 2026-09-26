import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function mockGitHub(page: Page) {
  await page.route("**/mcp", async route => {
    const request=route.request().postDataJSON();
    const name=request.params.name as string;
    let data:unknown;
    if(name==="github_repositories") data={repositories:[{repository:"org/repo",owner:"org",repo:"repo",private:true,archived:false,localProject:"demo",protectedBranches:["main"]}]};
    else if(name==="github_pull_requests") data={pulls:[{number:7,title:"Bounded PR",state:"open",draft:false,headRef:"feature/demo",baseRef:"main",author:"reviewer"}]};
    else if(name==="github_issues") data={issues:[{number:3,title:"Tracked issue",state:"open",author:"owner",labels:["bug"],comments:2}]};
    else if(name==="github_pull_request_files") data={files:[{filename:"src/a.ts",status:"modified",additions:2,deletions:1,changes:3,patch:"<script>untrusted patch</script>"}]};
    else if(name==="github_pull_request_reviews") data={reviews:[{id:5,user:"reviewer",state:"APPROVED"}]};
    else if(name==="github_checks") data={ref:"main",checkRuns:[],statuses:[{context:"ci/test",state:"success",description:"green"}]};
    else throw new Error(`Unexpected GitHub tool ${name}`);
    await route.fulfill({json:{jsonrpc:"2.0",id:request.id,result:{structuredContent:data}},headers:{"X-QuaranGate-Request-Id":"12345678-1234-1234-1234-123456789abc"}});
  });
}
async function axe(page:Page){expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);}

for(const width of [1280,360]){
  test(`FE8 GitHub experience is governed and responsive at ${width}`,async({page})=>{
    await page.setViewportSize({width,height:900}); await mockGitHub(page); await page.goto("/github"); await page.waitForLoadState("networkidle");
    await page.getByRole("button",{name:"Read repositories"}).click();
    await expect(page.getByRole("table",{name:"Governed repositories"})).toContainText("org/repo");
    await page.getByLabel("Repository workspace").selectOption("org/repo");
    await page.getByRole("button",{name:"Read pull requests"}).click();
    await expect(page.getByRole("table",{name:"Pull requests"})).toContainText("Bounded PR");
    await page.getByRole("button",{name:"Read issues"}).click();
    await expect(page.getByRole("table",{name:"Issues"})).toContainText("Tracked issue");
    await page.getByLabel("Pull request number").fill("7");
    await page.getByRole("button",{name:"Read changed files"}).click();
    await expect(page.getByText("<script>untrusted patch</script>",{exact:true})).toBeVisible();
    await expect(page.locator(".machine script")).toHaveCount(0);
    await page.getByRole("button",{name:"Read reviews"}).click();
    await expect(page.getByRole("table",{name:"Submitted reviews"})).toContainText("APPROVED");
    await page.getByLabel("Branch or exact commit for statuses").fill("main");
    await page.getByRole("button",{name:"Read commit statuses"}).click();
    await expect(page.getByRole("table",{name:"Commit statuses"})).toContainText("success");
    await expect(page.getByText(/Product identity integration pending/)).toBeVisible();
    await expect(page.getByRole("button",{name:"Publish exact HEAD"})).toBeDisabled();
    expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,search:location.search,hash:location.hash}))).toEqual({local:0,session:0,search:"",hash:""});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await axe(page);
  });
}
