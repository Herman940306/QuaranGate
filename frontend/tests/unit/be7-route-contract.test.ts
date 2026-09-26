import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  const session = {
    id: "sid",
    identity: { userRef: "user-a", subject: "sub" },
    workspace: { id: "ws-a", organizationId: "org-a", name: "Workspace" },
    version: 1,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    correlationId: "corr",
    csrfToken: "csrf",
    principalMapping: { state: "unmapped" as const },
    oidcTokens: {},
  };
  return {
    session,
    current: vi.fn(() => session),
    meetings: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      transcript: vi.fn(),
      summary: vi.fn(),
      actionItems: vi.fn(),
    },
  };
});

vi.mock("../../src/server/product/session/runtime", () => ({
  productSessionService: () => ({ current: mocks.current }),
}));
vi.mock("../../src/server/product/meetings/runtime", () => ({
  meetingService: () => mocks.meetings,
}));

import { GET as listMeetings, POST as createMeeting } from "../../src/app/api/product/meetings/route";
import { GET as getMeeting, PATCH as updateMeeting } from "../../src/app/api/product/meetings/[id]/route";
import { GET as getTranscript } from "../../src/app/api/product/meetings/[id]/transcript/route";
import { GET as getSummary } from "../../src/app/api/product/meetings/[id]/summary/route";
import { GET as getActionItems } from "../../src/app/api/product/meetings/[id]/action-items/route";

const root = process.cwd();

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? routeFiles(path)
      : name === "route.ts"
        ? [relative(root, path)]
        : [];
  });
}

function methods(path: string): string[] {
  const source = readFileSync(join(root, path), "utf8");
  return [...source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)]
    .map((match) => match[1] as string);
}

function mutation(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example.invalid${path}`, {
    method: "POST",
    headers: {
      cookie: "qg_product_session=sid",
      origin: "https://app.example.invalid",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": "csrf",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("BE7 meeting route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.current.mockReturnValue(mocks.session);
    mocks.meetings.list.mockResolvedValue([]);
    mocks.meetings.get.mockResolvedValue({ id: "m" });
    mocks.meetings.create.mockResolvedValue({ id: "m", recordingState: "OWNER_DECISION_REQUIRED" });
    mocks.meetings.update.mockResolvedValue({ id: "m", state: "READY" });
    mocks.meetings.transcript.mockResolvedValue({ meetingId: "m", state: "NOT_AVAILABLE", contentAvailable: false });
    mocks.meetings.summary.mockResolvedValue({ meetingId: "m", state: "NOT_AVAILABLE", contentAvailable: false });
    mocks.meetings.actionItems.mockResolvedValue({ meetingId: "m", state: "OWNER_DECISION_REQUIRED", items: [], executionAuthority: false });
  });

  it("installs exactly the bounded BE7 meeting route files and seven operations", () => {
    const files = routeFiles(join(root, "src/app/api/product/meetings")).sort();
    expect(files).toEqual([
      "src/app/api/product/meetings/[id]/action-items/route.ts",
      "src/app/api/product/meetings/[id]/route.ts",
      "src/app/api/product/meetings/[id]/summary/route.ts",
      "src/app/api/product/meetings/[id]/transcript/route.ts",
      "src/app/api/product/meetings/route.ts",
    ]);
    const operations = files.flatMap((path) => methods(path).map((method) => `${method} ${path}`)).sort();
    expect(operations).toEqual([
      "GET src/app/api/product/meetings/[id]/action-items/route.ts",
      "GET src/app/api/product/meetings/[id]/route.ts",
      "GET src/app/api/product/meetings/[id]/summary/route.ts",
      "GET src/app/api/product/meetings/[id]/transcript/route.ts",
      "GET src/app/api/product/meetings/route.ts",
      "PATCH src/app/api/product/meetings/[id]/route.ts",
      "POST src/app/api/product/meetings/route.ts",
    ]);
  });

  it("has no recording/upload/transcription/provider/proxy/export mutation surface", () => {
    const source = routeFiles(join(root, "src/app/api/product/meetings"))
      .map((path) => readFileSync(join(root, path), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/startRecording|recording|audio|microphone|upload|transcribe\(|providerUrl|modelUrl|targetUrl|baseUrl|fetch\(|download|principalRef|scopes/i);
  });

  it("create enforces CSRF/origin before delegation", async () => {
    const response = await createMeeting(mutation("/api/product/meetings", { title: "Sync" }, {
      origin: "https://evil.invalid",
      "sec-fetch-site": "cross-site",
    }));
    expect(response.status).toBe(403);
    expect(mocks.meetings.create).not.toHaveBeenCalled();
  });

  it("create ignores browser tenant/Principal/recording authority fields", async () => {
    const response = await createMeeting(mutation("/api/product/meetings", {
      title: "Sync",
      organizationId: "evil-org",
      workspaceId: "evil-ws",
      principalRef: "owner",
      recording: true,
      autoRecord: true,
      providerUrl: "https://evil.invalid",
    }));
    expect(response.status).toBe(201);
    expect(mocks.meetings.create).toHaveBeenCalledWith(mocks.session, { title: "Sync" }, undefined);
    expect(JSON.stringify(await response.json())).not.toMatch(/evil-org|evil-ws|principalRef|providerUrl/);
  });

  it("patch is CSRF protected and forwards only title/state/expectedVersion", async () => {
    const request = new Request("https://app.example.invalid/api/product/meetings/m", {
      method: "PATCH",
      headers: {
        cookie: "qg_product_session=sid",
        origin: "https://app.example.invalid",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": "csrf",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Sync",
        state: "READY",
        expectedVersion: 0,
        recording: true,
        principalRef: "owner",
      }),
    });
    const response = await updateMeeting(request, { params: Promise.resolve({ id: "m" }) });
    expect(response.status).toBe(200);
    expect(mocks.meetings.update).toHaveBeenCalledWith(mocks.session, "m", {
      title: "Sync",
      state: "READY",
      expectedVersion: 0,
    });
  });

  it("read routes use server session and never put transcript content in URL/query", async () => {
    const request = new Request("https://app.example.invalid/api/product/meetings/m", {
      headers: { cookie: "qg_product_session=sid" },
    });
    await getMeeting(request, { params: Promise.resolve({ id: "m" }) });
    await getTranscript(request, { params: Promise.resolve({ id: "m" }) });
    await getSummary(request, { params: Promise.resolve({ id: "m" }) });
    await getActionItems(request, { params: Promise.resolve({ id: "m" }) });
    expect(mocks.meetings.get).toHaveBeenCalledWith(mocks.session, "m");
    expect(mocks.meetings.transcript).toHaveBeenCalledWith(mocks.session, "m");
    expect(mocks.meetings.summary).toHaveBeenCalledWith(mocks.session, "m");
    expect(mocks.meetings.actionItems).toHaveBeenCalledWith(mocks.session, "m");
    expect(request.url).not.toMatch(/transcript=|audio=|content=/i);
  });

  it("list is session-derived", async () => {
    await listMeetings(new Request("https://app.example.invalid/api/product/meetings", {
      headers: { cookie: "qg_product_session=sid" },
    }));
    expect(mocks.meetings.list).toHaveBeenCalledWith(mocks.session);
  });

  it("safe error envelope redacts meeting backend detail", async () => {
    mocks.meetings.get.mockRejectedValueOnce(new Error("raw transcript secret /private/path"));
    const response = await getMeeting(
      new Request("https://app.example.invalid/api/product/meetings/m", {
        headers: { cookie: "qg_product_session=sid" },
      }),
      { params: Promise.resolve({ id: "m" }) },
    );
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(500);
    expect(body).not.toMatch(/raw transcript|secret|\/private\/path/);
  });
});
