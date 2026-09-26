import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => {
  const session = { id: "sid", identity: { userRef: "user-a", subject: "sub" }, workspace: { id: "ws-a", organizationId: "org-a", name: "Workspace" }, version: 1, issuedAt: 1, expiresAt: Date.now() + 60_000, correlationId: "corr", csrfToken: "csrf", principalMapping: { state: "unmapped" as const }, oidcTokens: {} };
  return { session, current: vi.fn(() => session), service: { summary: vi.fn(), hardware: vi.fn(), jobs: vi.fn(), network: vi.fn(), security: vi.fn(), statistics: vi.fn() } };
});
vi.mock("../../src/server/product/session/runtime", () => ({ productSessionService: () => ({ current: mocks.current }) }));
vi.mock("../../src/server/product/observability/runtime", () => ({ observabilityService: () => mocks.service }));
import { GET as summary } from "../../src/app/api/product/observability/summary/route";
import { GET as hardware } from "../../src/app/api/product/observability/hardware/route";
import { GET as jobs } from "../../src/app/api/product/observability/jobs/route";
import { GET as network } from "../../src/app/api/product/observability/network/route";
import { GET as security } from "../../src/app/api/product/observability/security/route";
import { GET as statistics } from "../../src/app/api/product/statistics/route";

const root = process.cwd();
function routeFiles(dir: string): string[] { return readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? routeFiles(path) : name === "route.ts" ? [relative(root, path)] : []; }); }
function routeMethods(path: string): string[] { const source = readFileSync(join(root, path), "utf8"); return [...source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)].map((match) => match[1] as string); }
function get(path: string): Request { return new Request(`https://app.example.invalid${path}`, { headers: { cookie: "qg_product_session=sid" } }); }

describe("BE6 observability/statistics route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.current.mockReturnValue(mocks.session);
    for (const key of Object.keys(mocks.service) as Array<keyof typeof mocks.service>) mocks.service[key].mockResolvedValue({ ok: true });
  });

  it("installs exactly the curated read-only BE6 route surface", () => {
    const files = [...routeFiles(join(root, "src/app/api/product/observability")), ...routeFiles(join(root, "src/app/api/product/statistics"))].sort();
    expect(files).toEqual([
      "src/app/api/product/observability/hardware/route.ts",
      "src/app/api/product/observability/jobs/route.ts",
      "src/app/api/product/observability/network/route.ts",
      "src/app/api/product/observability/security/route.ts",
      "src/app/api/product/observability/summary/route.ts",
      "src/app/api/product/statistics/route.ts",
    ]);
    expect(files.flatMap((file) => routeMethods(file).map((method) => `${method} ${file}`))).toEqual(files.map((file) => `GET ${file}`));
  });

  it("exposes no generic metrics/query/proxy/browser source selector", () => {
    const source = [...routeFiles(join(root, "src/app/api/product/observability")), ...routeFiles(join(root, "src/app/api/product/statistics"))].map((file) => readFileSync(join(root, file), "utf8")).join("\n");
    expect(source).not.toMatch(/POST|DELETE|PUT|PATCH|sql|promql|zabbix|tempo|targetUrl|baseUrl|host|containerId|sourceSelector|fetch\(/i);
  });

  it("delegates all reads using the server-held product session", async () => {
    await summary(get("/api/product/observability/summary?windowMs=3600000"));
    await hardware(get("/api/product/observability/hardware?organizationId=evil"));
    await jobs(get("/api/product/observability/jobs?windowMs=3600000&principalRef=evil"));
    await network(get("/api/product/observability/network?host=169.254.169.254"));
    await security(get("/api/product/observability/security?containerId=abc"));
    await statistics(get("/api/product/statistics?windowMs=3600000&top=5&sql=select"));
    expect(mocks.service.summary).toHaveBeenCalledWith(mocks.session, "3600000");
    expect(mocks.service.hardware).toHaveBeenCalledWith(mocks.session);
    expect(mocks.service.jobs).toHaveBeenCalledWith(mocks.session, "3600000");
    expect(mocks.service.network).toHaveBeenCalledWith(mocks.session);
    expect(mocks.service.security).toHaveBeenCalledWith(mocks.session);
    expect(mocks.service.statistics).toHaveBeenCalledWith(mocks.session, "3600000", 5);
  });

  it("normalizes/redacts adapter failures in safe envelopes", async () => {
    mocks.service.statistics.mockRejectedValueOnce(new Error("tempo token secret /raw/prompt/header"));
    const response = await statistics(get("/api/product/statistics?windowMs=3600000"));
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(500);
    expect(body).not.toMatch(/token secret|raw\/prompt|header|tempo/);
  });
});
