import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, readlink, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';

// Run from the repository root with an isolated, already-built frontend snapshot.
const root = process.cwd();
const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
assert(source.startsWith(`${root}/frontend/test-results/`));
assert(output.startsWith(`${root}/docs/frontend/evidence/`));
const origin = 'http://127.0.0.1:3100';
const routes = ['/overview','/targets','/arena','/jobs','/ide-sessions','/github','/models','/monitoring','/statistics','/security','/audit-evidence','/recovery-backups','/settings','/tool-lab','/projects','/files','/terminal','/git','/processes','/agents','/approvals','/providers','/agent-profiles','/control-center'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function requireFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 3100, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}
async function bundleHashes() {
  const hashes = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(source, '.next', relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) hashes[name] = digest(await readFile(path.join(source, '.next', name)));
    }
  }
  await visit('static');
  await visit('server');
  hashes.BUILD_ID = digest(await readFile(path.join(source, '.next/BUILD_ID')));
  return hashes;
}
await requireFreePort(); // Fail before requesting or signalling any existing listener.
const before = await bundleHashes();
const buildId = (await readFile(path.join(source, '.next/BUILD_ID'), 'utf8')).trim();
const log = await open(path.join(output, 'server.txt'), 'wx');
const server = spawn(process.execPath, [path.join(root, 'frontend/node_modules/next/dist/bin/next'), 'start', source, '--hostname', '127.0.0.1', '--port', '3100'], { cwd: source, stdio: ['ignore', log.fd, log.fd] });
let spawnError;
server.on('error', error => { spawnError = error; });
const exited = new Promise(resolve => server.once('exit', (code, signal) => resolve({ code, signal })));
function ownedListener() {
  assert(!spawnError && server.exitCode === null && server.signalCode === null, 'Owned server exited before readiness');
  const sockets = execFileSync('ss', ['-ltnp', 'sport = :3100'], { encoding: 'utf8' });
  assert(sockets.includes('127.0.0.1:3100') && sockets.includes(`pid=${server.pid},`), 'Listener is not the spawned production child');
  return sockets.trim();
}
let browser;
let receipt;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (spawnError) throw spawnError;
    assert(server.exitCode === null && server.signalCode === null, 'Production child exited');
    const sockets = execFileSync('ss', ['-ltnp', 'sport = :3100'], { encoding: 'utf8' });
    if (sockets.includes('127.0.0.1:3100')) {
      ownedListener();
      assert.equal(await readlink(`/proc/${server.pid}/cwd`), source);
      const response = await fetch(`${origin}/overview`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) { ready = true; break; }
    }
    await pause(100);
  }
  assert(ready, 'Production child did not become ready');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: 'reduce', colorScheme: 'light' });
  await context.route('**/mcp', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  const page = await context.newPage();
  const receipts = [];
  for (const width of [1280, 360]) for (const route of routes) {
    ownedListener();
    await page.setViewportSize({ width, height: 900 });
    assert((await page.goto(origin + route))?.ok(), `Route failed: ${route}`);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    const assetPath = await page.locator('link[rel="stylesheet"]').first().getAttribute('href');
    assert(assetPath?.startsWith('/_next/static/'), 'No production stylesheet');
    const resource = await fetch(origin + assetPath, { signal: AbortSignal.timeout(3000) });
    assert(resource.ok);
    const resourceHash = digest(Buffer.from(await resource.arrayBuffer()));
    assert.equal(resourceHash, before[decodeURIComponent(assetPath.split('?')[0].replace('/_next/', ''))], 'Served asset differs from pinned bundle');
    const file = `${route.slice(1)}-${width}.png`;
    const image = await page.screenshot({ fullPage: true });
    await writeFile(path.join(output, file), image, { flag: 'wx' });
    const measurement = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, h1: document.querySelector('h1')?.textContent, font: getComputedStyle(document.querySelector('h1')).fontSize, rail: getComputedStyle(document.querySelector('.rail')).width }));
    receipts.push({ route, viewport: { width, height: 900 }, file, sha256: digest(image), measurement, assetPath, resourceHash, state: 'Production integration-pending; synthetic MCP unavailable; no live backend' });
    console.log(route, width);
  }
  ownedListener();
  assert.deepEqual(await bundleHashes(), before, 'Production bundle changed during capture');
  receipt = { source, buildId, serverPid: server.pid, serverCommand: server.spawnargs, listener: ownedListener(), bundle: before, receipts };
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  const stop = await Promise.race([exited, pause(10000).then(() => { throw new Error('Owned server failed to exit after SIGTERM'); })]);
  await log.close();
  await requireFreePort();
  if (receipt) {
    receipt.stop = stop;
    receipt.portReleased = true;
    await writeFile(path.join(output, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  }
}
