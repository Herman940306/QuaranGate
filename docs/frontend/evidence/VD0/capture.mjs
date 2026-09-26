import { chromium } from '/home/herman/projects/QuaranGate-product-frontend-continuation-codex/frontend/node_modules/@playwright/test/index.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = process.cwd();
const phase = process.argv[2];
const output = path.join(root,'docs/frontend/evidence',phase);
const routes = ['/overview','/targets','/arena','/jobs','/ide-sessions','/github','/models','/monitoring','/statistics','/security','/audit-evidence','/recovery-backups','/settings','/tool-lab','/projects','/files','/terminal','/git','/processes','/agents','/approvals','/providers','/agent-profiles','/control-center'];
const server = spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3100'],{cwd:path.join(root,'frontend'),stdio:'ignore'});
let browser;
const receipts=[];
try {
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3100/overview')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({reducedMotion:'reduce',colorScheme:'light'});
 await context.route('**/mcp',route=>route.fulfill({status:503,body:'Unavailable'}));
 const page=await context.newPage();
 for(const width of [1280,360])for(const route of routes){
  await page.setViewportSize({width,height:900});
  await page.goto('http://127.0.0.1:3100'+route);
  await page.waitForLoadState('networkidle');await page.evaluate(()=>document.fonts.ready);
  const file=route.slice(1)+'-'+width+'.png';
  await page.screenshot({path:path.join(output,file),fullPage:true});
  const measurement=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,h1:document.querySelector('h1')?.textContent,font:getComputedStyle(document.querySelector('h1')).fontSize,rail:getComputedStyle(document.querySelector('.rail')).width}));
  receipts.push({route,viewport:{width,height:900},file,measurement,state:'Production integration-pending / synthetic MCP unavailable; no live backend'});
  console.log(phase,route,width);
 }
 await writeFile(path.join(output,'capture.json'),JSON.stringify({phase,sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),receipts},null,2)+'\n');
}finally{await browser?.close();server.kill('SIGTERM');}
