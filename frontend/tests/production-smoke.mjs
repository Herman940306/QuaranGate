import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";

const origin = "http://127.0.0.1:3200";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3200"], {
  cwd: process.cwd(),
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", chunk => { output += chunk; });
server.stderr.on("data", chunk => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Production server did not become ready.\n${output}`);
}

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const response = await page.goto(origin);
  if (!response?.ok()) throw new Error(`Foundation route returned ${response?.status()}`);
  if ((await page.title()) !== "Foundation — QuaranGate") throw new Error("Unexpected production title");
  await page.waitForTimeout(1000);
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
    databases: "databases" in indexedDB ? (await indexedDB.databases()).length : 0,
    caches: "caches" in window ? (await caches.keys()).length : 0,
  }));
  if (JSON.stringify(storage) !== JSON.stringify({ local: 0, session: 0, cookies: "", databases: 0, caches: 0 })) {
    throw new Error(`Unexpected production browser persistence: ${JSON.stringify(storage)}`);
  }
  for (const [route, title] of [["overview", "Overview"], ["targets", "Targets"], ["projects", "Projects"], ["agents", "Agents"], ["providers", "Providers"], ["agent-profiles", "Agent Profiles"], ["jobs", "Jobs"], ["git", "Git"], ["github", "GitHub"], ["control-center", "Control Center"], ["security", "Security & Access"], ["sign-in", "Sign in"], ["account", "Account"], ["workspaces", "Workspaces"], ["permissions", "Product permissions"]]) {
    const productResponse = await page.goto(`${origin}/${route}`);
    if (!productResponse?.ok() || await page.title() !== `${title} — QuaranGate`) throw new Error(`Product route failed: ${route}`);
    if (route === "providers" || route === "agent-profiles") {
      if (!await page.getByText("Product integration pending.", { exact: false }).isVisible()) throw new Error(`Unintegrated FE3 route exposed controls: ${route}`);
      if (!await page.getByRole("button", { name: "Re-read configuration" }).isDisabled()) throw new Error(`Unintegrated FE3 route enabled reads: ${route}`);
    }
  }
  await page.goto(`${origin}/overview`);
  await page.getByRole("button", { name: "Read overview", exact: true }).click();
  await page.getByText("The operational service is unavailable. Retry when it is reachable.").waitFor();
  if (await page.evaluate(() => localStorage.length + sessionStorage.length) !== 0) throw new Error("Product read persisted browser data");
  await page.goto(`${origin}/sign-in`);
  if (!await page.getByRole("button", { name: "Continue to identity provider" }).isDisabled()) throw new Error("Unintegrated sign-in is enabled");
  if (!await page.getByText("Identity service not integrated yet. Sign-in is unavailable.").isVisible()) throw new Error("Missing integration boundary");
  const previewResponse = await page.goto(`${origin}/identity-preview`);
  if (previewResponse?.status() !== 404) throw new Error("Synthetic identity preview exposed in production");
  const productPreviewResponse = await page.goto(`${origin}/product-preview`);
  if (productPreviewResponse?.status() !== 404) throw new Error("Synthetic product preview exposed in production");
  if (await page.evaluate(() => localStorage.length + sessionStorage.length) !== 0) throw new Error("Identity UI persisted browser data");
  const designResponse = await page.goto(`${origin}/design-system`);
  if (designResponse?.status() !== 404) throw new Error(`Production design-system route returned ${designResponse?.status()}`);
  const headers = await fetch(origin);
  const expected = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };
  for (const [name, value] of Object.entries(expected)) {
    if (headers.headers.get(name) !== value) throw new Error(`Missing header ${name}`);
  }
  await browser.close();
  console.log("production smoke: PASS (root + fifteen product routes 200, FE3 integration pending, missing /mcp unavailable, identity-preview/product-preview/design-system 404, storage clean, headers present)");
} finally {
  server.kill("SIGTERM");
}
