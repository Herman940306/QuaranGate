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
      optInRecording: vi.fn(),
      attestRecording: vi.fn(),
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      exportTranscript: vi.fn(),
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
import { POST as optInRecording } from "../../src/app/api/product/meetings/[id]/recording/opt-in/route";
import { POST as attestRecording } from "../../src/app/api/product/meetings/[id]/recording/attest/route";
import { POST as startRecording } from "../../src/app/api/product/meetings/[id]/recording/start/route";
import { POST as stopRecording } from "../../src/app/api/product/meetings/[id]/recording/stop/route";
import { GET as exportTranscript } from "../../src/app/api/product/meetings/[id]/transcript/export/route";

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

function mutation(path: string, body: unknown, method = "POST", headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example.invalid${path}`, {
    method,
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

describe("BE7 R1 meeting route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.current.mockReturnValue(mocks.session);
    mocks.meetings.list.mockResolvedValue([]);
    mocks.meetings.get.mockResolvedValue({ id: "m" });
    mocks.meetings.create.mockResolvedValue({ id: "m", recordingState: "DISABLED" });
    mocks.meetings.update.mockResolvedValue({ id: "m", state: "READY" });
    mocks.meetings.transcript.mockResolvedValue({
      meetingId: "m",
      state: "NOT_AVAILABLE",
      contentAvailable: false,
      retentionState: "NOT_CONFIGURED",
      providerClass: "LOCAL_ONLY",
    });
    mocks.meetings.summary.mockResolvedValue({
      meetingId: "m",
      state: "NOT_AVAILABLE",
      contentAvailable: false,
      retentionMode: "EPHEMERAL_ONLY",
    });
    mocks.meetings.actionItems.mockResolvedValue({
      meetingId: "m",
      state: "NOT_AVAILABLE",
      items: [],
      executionAuthority: false,
      retentionMode: "EPHEMERAL_ONLY",
    });
    mocks.meetings.optInRecording.mockResolvedValue({ id: "m", recordingState: "OPTED_IN" });
    mocks.meetings.attestRecording.mockResolvedValue({
      id: "m",
      recordingState: "READY",
      noticePolicy: "PERSISTENT_VISUAL",
      noticeState: "CLIENT_ACKNOWLEDGED",
      noticeRenderingVerified: false,
    });
    mocks.meetings.startRecording.mockResolvedValue({ id: "m", recordingState: "RECORDING" });
    mocks.meetings.stopRecording.mockResolvedValue({ id: "m", recordingState: "STOPPED" });
    mocks.meetings.exportTranscript.mockResolvedValue({
      content: "bounded transcript",
      filename: "meeting-m-transcript.txt",
      retainedUntil: "2026-10-01T00:00:00.000Z",
    });
  });

  it("installs exactly the bounded R1 meeting route files and twelve operations", () => {
    const files = routeFiles(join(root, "src/app/api/product/meetings")).sort();
    expect(files).toEqual([
      "src/app/api/product/meetings/[id]/action-items/route.ts",
      "src/app/api/product/meetings/[id]/recording/attest/route.ts",
      "src/app/api/product/meetings/[id]/recording/opt-in/route.ts",
      "src/app/api/product/meetings/[id]/recording/start/route.ts",
      "src/app/api/product/meetings/[id]/recording/stop/route.ts",
      "src/app/api/product/meetings/[id]/route.ts",
      "src/app/api/product/meetings/[id]/summary/route.ts",
      "src/app/api/product/meetings/[id]/transcript/export/route.ts",
      "src/app/api/product/meetings/[id]/transcript/route.ts",
      "src/app/api/product/meetings/route.ts",
    ]);
    const operations = files.flatMap((path) => methods(path).map((method) => `${method} ${path}`)).sort();
    expect(operations).toEqual([
      "GET src/app/api/product/meetings/[id]/action-items/route.ts",
      "GET src/app/api/product/meetings/[id]/route.ts",
      "GET src/app/api/product/meetings/[id]/summary/route.ts",
      "GET src/app/api/product/meetings/[id]/transcript/export/route.ts",
      "GET src/app/api/product/meetings/[id]/transcript/route.ts",
      "GET src/app/api/product/meetings/route.ts",
      "PATCH src/app/api/product/meetings/[id]/route.ts",
      "POST src/app/api/product/meetings/[id]/recording/attest/route.ts",
      "POST src/app/api/product/meetings/[id]/recording/opt-in/route.ts",
      "POST src/app/api/product/meetings/[id]/recording/start/route.ts",
      "POST src/app/api/product/meetings/[id]/recording/stop/route.ts",
      "POST src/app/api/product/meetings/route.ts",
    ]);
  });

  it("has no raw-audio ingestion, arbitrary provider/model URL, generic proxy or generated-content export", () => {
    const source = routeFiles(join(root, "src/app/api/product/meetings"))
      .map((path) => readFileSync(join(root, path), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/audioBytes|rawAudio|uploadAudio|providerUrl|modelUrl|targetUrl|baseUrl|fetch\(|generic.?proxy/i);
    expect(source).not.toMatch(/summary\/export|action-items\/export|audio\/export/i);
  });

  it("recording mutations enforce CSRF/origin before delegation", async () => {
    const response = await startRecording(mutation(
      "/api/product/meetings/m/recording/start",
      { expectedVersion: 3 },
      "POST",
      { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" },
    ), { params: Promise.resolve({ id: "m" }) });
    expect(response.status).toBe(403);
    expect(mocks.meetings.startRecording).not.toHaveBeenCalled();
  });

  it("opt-in forwards only expectedVersion and ignores browser authority fields", async () => {
    const response = await optInRecording(mutation(
      "/api/product/meetings/m/recording/opt-in",
      { expectedVersion: 1, principalRef: "owner", role: "admin", scopes: ["*"], autoRecord: true },
    ), { params: Promise.resolve({ id: "m" }) });
    expect(response.status).toBe(200);
    expect(mocks.meetings.optInRecording).toHaveBeenCalledWith(mocks.session, "m", 1);
  });

  it("attestation requires explicit persistent-visual acknowledgement without claiming participant consent", async () => {
    const response = await attestRecording(mutation(
      "/api/product/meetings/m/recording/attest",
      {
        expectedVersion: 2,
        persistentVisualNoticeAcknowledged: true,
        allParticipantsConsented: true,
      },
    ), { params: Promise.resolve({ id: "m" }) });
    expect(response.status).toBe(200);
    expect(mocks.meetings.attestRecording).toHaveBeenCalledWith(mocks.session, "m", {
      expectedVersion: 2,
      persistentVisualNoticeAcknowledged: true,
    });
    expect(JSON.stringify(await response.json())).not.toMatch(/allParticipantsConsented/i);
  });

  it("start and stop forward only versioned recording commands", async () => {
    await startRecording(mutation("/api/product/meetings/m/recording/start", {
      expectedVersion: 3,
      principalRef: "owner",
    }), { params: Promise.resolve({ id: "m" }) });
    expect(mocks.meetings.startRecording).toHaveBeenCalledWith(mocks.session, "m", 3);

    await stopRecording(mutation("/api/product/meetings/m/recording/stop", {
      expectedVersion: 4,
      role: "admin",
    }), { params: Promise.resolve({ id: "m" }) });
    expect(mocks.meetings.stopRecording).toHaveBeenCalledWith(mocks.session, "m", 4);
  });

  it("transcript export is a read route with bounded no-store text response", async () => {
    const response = await exportTranscript(
      new Request("https://app.example.invalid/api/product/meetings/m/transcript/export", {
        headers: { cookie: "qg_product_session=sid" },
      }),
      { params: Promise.resolve({ id: "m" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("bounded transcript");
    expect(mocks.meetings.exportTranscript).toHaveBeenCalledWith(mocks.session, "m");
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

  it("patch remains CSRF protected and forwards only title/state/expectedVersion", async () => {
    const response = await updateMeeting(mutation(
      "/api/product/meetings/m",
      { title: "Sync", state: "READY", expectedVersion: 0, recording: true, principalRef: "owner" },
      "PATCH",
    ), { params: Promise.resolve({ id: "m" }) });
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

  it("list remains session-derived and safe errors redact backend content", async () => {
    await listMeetings(new Request("https://app.example.invalid/api/product/meetings", {
      headers: { cookie: "qg_product_session=sid" },
    }));
    expect(mocks.meetings.list).toHaveBeenCalledWith(mocks.session);

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
