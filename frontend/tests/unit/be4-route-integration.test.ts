import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const session = {
    id: "session-a",
    identity: { userRef: "user-a", subject: "subject-a" },
    workspace: { id: "workspace-a", organizationId: "org-a", name: "Workspace A" },
    version: 4,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    correlationId: "corr-a",
    csrfToken: "csrf-a",
    principalMapping: { state: "unmapped" as const },
    oidcTokens: {},
  };
  return {
    session,
    current: vi.fn(() => session),
    provider: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      replaceSecret: vi.fn(),
      validate: vi.fn(),
    },
  };
});

vi.mock("../../src/server/product/session/runtime", () => ({
  productSessionService: () => ({ current: mocks.current }),
}));

vi.mock("../../src/server/product/provider/runtime", () => ({
  productProviderService: () => mocks.provider,
}));

import { GET as listProviders, POST as createProvider } from "../../src/app/api/product/providers/route";
import { GET as getProvider, PATCH as updateProvider } from "../../src/app/api/product/providers/[id]/route";
import { POST as replaceProviderSecret } from "../../src/app/api/product/providers/[id]/secret/route";
import { POST as validateProvider } from "../../src/app/api/product/providers/[id]/validate/route";

const root = process.cwd();
const providerRoot = join(root, "src/app/api/product/providers");
const safeProvider = {
  id: "provider-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  kind: "kiro",
  displayLabel: "Kiro",
  configured: true,
  status: "enabled",
  validation: { status: "valid" },
  version: 5,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routeFiles(path) : name === "route.ts" ? [relative(root, path)] : [];
  });
}

function routeMethods(path: string): string[] {
  const source = readFileSync(join(root, path), "utf8");
  return [...source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)].map((match) => match[1] as string);
}

function mutationRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example.invalid${path}`, {
    method: "POST",
    headers: {
      cookie: "qg_product_session=session-a",
      origin: "https://app.example.invalid",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": "csrf-a",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("BE4 provider route integration contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.current.mockReturnValue(mocks.session);
    mocks.provider.list.mockResolvedValue([safeProvider]);
    mocks.provider.get.mockResolvedValue(safeProvider);
    mocks.provider.create.mockResolvedValue(safeProvider);
    mocks.provider.update.mockResolvedValue(safeProvider);
    mocks.provider.replaceSecret.mockResolvedValue(safeProvider);
    mocks.provider.validate.mockResolvedValue(safeProvider);
  });

  it("retains all five BE1 canonical route files while adding exactly the accepted provider namespace", () => {
    const all = routeFiles(join(root, "src/app/api/product")).sort();
    for (const path of [
      "src/app/api/product/auth/login/route.ts",
      "src/app/api/product/auth/callback/route.ts",
      "src/app/api/product/session/current/route.ts",
      "src/app/api/product/session/workspace/route.ts",
      "src/app/api/product/session/logout/route.ts",
    ]) expect(all).toContain(path);

    expect(routeFiles(providerRoot).sort()).toEqual([
      "src/app/api/product/providers/[id]/route.ts",
      "src/app/api/product/providers/[id]/secret/route.ts",
      "src/app/api/product/providers/[id]/validate/route.ts",
      "src/app/api/product/providers/route.ts",
    ]);
  });

  it("defines exactly the six accepted BE4 provider operations and no DELETE/proxy operation", () => {
    const operations = routeFiles(providerRoot).flatMap((path) =>
      routeMethods(path).map((method) => `${method} ${path}`),
    ).sort();
    expect(operations).toEqual([
      "GET src/app/api/product/providers/[id]/route.ts",
      "GET src/app/api/product/providers/route.ts",
      "PATCH src/app/api/product/providers/[id]/route.ts",
      "POST src/app/api/product/providers/[id]/secret/route.ts",
      "POST src/app/api/product/providers/[id]/validate/route.ts",
      "POST src/app/api/product/providers/route.ts",
    ]);
    const source = routeFiles(providerRoot).map((path) => readFileSync(join(root, path), "utf8")).join("\n");
    expect(source).not.toMatch(/export async function DELETE|targetUrl|baseUrl|custodyRef|custodyPath|fetch\(/);
  });

  it("delegates reads with the server-held session rather than browser tenant authority", async () => {
    const response = await listProviders(new Request("https://app.example.invalid/api/product/providers", {
      headers: { cookie: "qg_product_session=session-a" },
    }));
    expect(response.status).toBe(200);
    expect(mocks.provider.list).toHaveBeenCalledWith(mocks.session);

    await getProvider(
      new Request("https://app.example.invalid/api/product/providers/provider-a", {
        headers: { cookie: "qg_product_session=session-a" },
      }),
      { params: Promise.resolve({ id: "provider-a" }) },
    );
    expect(mocks.provider.get).toHaveBeenCalledWith(mocks.session, "provider-a");
  });

  it("ignores browser-supplied tenant, Principal and custody authority on create", async () => {
    const response = await createProvider(mutationRequest("/api/product/providers", {
      kind: "kiro",
      displayLabel: "Kiro",
      secretValue: "WRITE-ONLY-SECRET",
      productUserId: "attacker-user",
      organizationId: "attacker-org",
      workspaceId: "attacker-workspace",
      principalRef: "owner-control-center",
      custodyRef: "qg/product/escape",
    }));
    expect(response.status).toBe(201);
    expect(mocks.provider.create).toHaveBeenCalledWith(mocks.session, {
      kind: "kiro",
      displayLabel: "Kiro",
      secretValue: "WRITE-ONLY-SECRET",
    });
    expect(JSON.stringify(await response.json())).not.toMatch(/WRITE-ONLY-SECRET|custodyRef|owner-control-center/);
  });

  it("rejects cross-site provider mutation before delegation", async () => {
    const response = await createProvider(mutationRequest("/api/product/providers", {
      kind: "kiro",
      displayLabel: "Kiro",
    }, {
      origin: "https://evil.example.invalid",
      "sec-fetch-site": "cross-site",
    }));
    expect(response.status).toBe(403);
    expect(mocks.provider.create).not.toHaveBeenCalled();
  });

  it("rejects a missing or incorrect CSRF token before secret replacement", async () => {
    const request = mutationRequest("/api/product/providers/provider-a/secret", {
      secretValue: "WRITE-ONLY-SECRET",
      expectedVersion: 4,
    }, { "x-csrf-token": "wrong" });
    const response = await replaceProviderSecret(request, { params: Promise.resolve({ id: "provider-a" }) });
    expect(response.status).toBe(403);
    expect(mocks.provider.replaceSecret).not.toHaveBeenCalled();
  });

  it("passes only write-only secret and expectedVersion to the provider service", async () => {
    const response = await replaceProviderSecret(
      mutationRequest("/api/product/providers/provider-a/secret", {
        secretValue: "WRITE-ONLY-SECRET",
        expectedVersion: 4,
        custodyRef: "qg/product/escape",
      }),
      { params: Promise.resolve({ id: "provider-a" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.provider.replaceSecret).toHaveBeenCalledWith(mocks.session, "provider-a", {
      secretValue: "WRITE-ONLY-SECRET",
      expectedVersion: 4,
    });
    const body = JSON.stringify(await response.json());
    expect(body).not.toMatch(/WRITE-ONLY-SECRET|custodyRef|qg\/product/);
  });

  it("maps stale expectedVersion failure to the safe stale-version envelope", async () => {
    mocks.provider.update.mockRejectedValueOnce(new Error("provider_stale_version"));
    const request = new Request("https://app.example.invalid/api/product/providers/provider-a", {
      method: "PATCH",
      headers: {
        cookie: "qg_product_session=session-a",
        origin: "https://app.example.invalid",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": "csrf-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayLabel: "Kiro",
        status: "enabled",
        expectedVersion: 3,
      }),
    });
    const response = await updateProvider(request, { params: Promise.resolve({ id: "provider-a" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "STALE_VERSION" } });
  });

  it("redacts provider/upstream detail from safe errors", async () => {
    mocks.provider.replaceSecret.mockRejectedValueOnce(new Error("upstream WRITE-ONLY-SECRET /host/private/path"));
    const response = await replaceProviderSecret(
      mutationRequest("/api/product/providers/provider-a/secret", {
        secretValue: "WRITE-ONLY-SECRET",
        expectedVersion: 4,
      }),
      { params: Promise.resolve({ id: "provider-a" }) },
    );
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(500);
    expect(body).not.toMatch(/WRITE-ONLY-SECRET|\/host\/private\/path|upstream/);
  });

  it("validation accepts expectedVersion only and remains non-authoritative", async () => {
    const response = await validateProvider(
      mutationRequest("/api/product/providers/provider-a/validate", {
        expectedVersion: 4,
        principalRef: "owner-control-center",
        scopes: ["agents:apply"],
      }),
      { params: Promise.resolve({ id: "provider-a" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.provider.validate).toHaveBeenCalledWith(mocks.session, "provider-a", 4);
    const body = JSON.stringify(await response.json());
    expect(body).not.toMatch(/owner-control-center|agents:apply|principalRef|scopes/);
  });
});
