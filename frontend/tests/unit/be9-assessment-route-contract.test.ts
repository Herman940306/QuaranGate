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
    principalMapping: {
      state: "mapped-reference" as const,
      principalRef: "principal-a",
      mappingVersion: 1,
    },
    oidcTokens: {},
  };
  return {
    session,
    current: vi.fn(() => session),
    assessments: {
      createAssessment: vi.fn(),
      assessment: vi.fn(),
      evidence: vi.fn(),
      cancelAssessment: vi.fn(),
    },
  };
});

vi.mock("../../src/server/product/session/runtime", () => ({
  productSessionService: () => ({ current: mocks.current }),
}));
vi.mock("../../src/server/product/security/runtime", () => ({
  securityAssessmentService: () => mocks.assessments,
}));

import { POST as createAssessment } from "../../src/app/api/product/security/assessments/route";
import { GET as getAssessment } from "../../src/app/api/product/security/assessments/[id]/route";
import { GET as getEvidence } from "../../src/app/api/product/security/assessments/[id]/evidence/route";
import { POST as cancelAssessment } from "../../src/app/api/product/security/assessments/[id]/cancel/route";

const root = process.cwd();
const DISCOVERY = `disc_${"a".repeat(24)}`;
const ASSESSMENT = `assessment_${"b".repeat(24)}`;

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

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  const text = JSON.stringify(body);
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
    body: text,
  });
}

describe("BE9.2 product assessment route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.current.mockReturnValue(mocks.session);
    mocks.assessments.createAssessment.mockResolvedValue({ id: ASSESSMENT, state: "PLANNED" });
    mocks.assessments.assessment.mockResolvedValue({ id: ASSESSMENT, state: "PLANNED" });
    mocks.assessments.evidence.mockResolvedValue({ assessmentId: ASSESSMENT, admissions: [], evidence: [] });
    mocks.assessments.cancelAssessment.mockResolvedValue({ id: ASSESSMENT, state: "CANCELLED" });
  });

  it("installs exactly the four frozen BE9 product operations and no /run route", () => {
    const files = routeFiles(join(root, "src/app/api/product/security/assessments")).sort();
    expect(files).toEqual([
      "src/app/api/product/security/assessments/[id]/cancel/route.ts",
      "src/app/api/product/security/assessments/[id]/evidence/route.ts",
      "src/app/api/product/security/assessments/[id]/route.ts",
      "src/app/api/product/security/assessments/route.ts",
    ]);
    expect(files.flatMap((path) => methods(path).map((method) => `${method} ${path}`)).sort()).toEqual([
      "GET src/app/api/product/security/assessments/[id]/evidence/route.ts",
      "GET src/app/api/product/security/assessments/[id]/route.ts",
      "POST src/app/api/product/security/assessments/[id]/cancel/route.ts",
      "POST src/app/api/product/security/assessments/route.ts",
    ]);
    expect(files.some((path) => path.includes("/run/"))).toBe(false);
  });

  it("create accepts only discoveryId and delegates no browser authority", async () => {
    const response = await createAssessment(post(
      "/api/product/security/assessments",
      { discoveryId: DISCOVERY },
    ));
    expect(response.status).toBe(201);
    expect(mocks.assessments.createAssessment).toHaveBeenCalledWith(mocks.session, DISCOVERY);

    mocks.assessments.createAssessment.mockClear();
    const rejected = await createAssessment(post(
      "/api/product/security/assessments",
      {
        discoveryId: DISCOVERY,
        sourceRevision: "c".repeat(40),
        scanner: "semgrep",
        image: "attacker:latest",
        argv: ["sh", "-c", "id"],
        hostPath: "/host",
        network: "internet",
      },
    ));
    expect(rejected.status).toBe(400);
    expect(mocks.assessments.createAssessment).not.toHaveBeenCalled();
  });

  it("create and cancel enforce CSRF/origin before service delegation", async () => {
    const create = await createAssessment(post(
      "/api/product/security/assessments",
      { discoveryId: DISCOVERY },
      { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" },
    ));
    expect(create.status).toBe(403);
    expect(mocks.assessments.createAssessment).not.toHaveBeenCalled();

    const cancel = await cancelAssessment(post(
      `/api/product/security/assessments/${ASSESSMENT}/cancel`,
      {},
      {
        origin: "https://evil.invalid",
        "sec-fetch-site": "cross-site",
        "content-length": "2",
      },
    ), { params: Promise.resolve({ id: ASSESSMENT }) });
    expect(cancel.status).toBe(403);
    expect(mocks.assessments.cancelAssessment).not.toHaveBeenCalled();
  });

  it("read and evidence forward only a validated assessment identity", async () => {
    const request = new Request(`https://app.example.invalid/api/product/security/assessments/${ASSESSMENT}`, {
      headers: { cookie: "qg_product_session=sid" },
    });
    expect((await getAssessment(request, { params: Promise.resolve({ id: ASSESSMENT }) })).status).toBe(200);
    expect(mocks.assessments.assessment).toHaveBeenCalledWith(mocks.session, ASSESSMENT);

    expect((await getEvidence(request, { params: Promise.resolve({ id: ASSESSMENT }) })).status).toBe(200);
    expect(mocks.assessments.evidence).toHaveBeenCalledWith(mocks.session, ASSESSMENT);

    mocks.assessments.assessment.mockClear();
    const malformed = await getAssessment(request, { params: Promise.resolve({ id: "../foreign" }) });
    expect(malformed.status).toBe(400);
    expect(mocks.assessments.assessment).not.toHaveBeenCalled();
  });

  it("cancel accepts an empty body only and delegates the exact owned assessment id", async () => {
    const request = new Request(`https://app.example.invalid/api/product/security/assessments/${ASSESSMENT}/cancel`, {
      method: "POST",
      headers: {
        cookie: "qg_product_session=sid",
        origin: "https://app.example.invalid",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": "csrf",
        "content-length": "0",
      },
    });
    expect((await cancelAssessment(request, { params: Promise.resolve({ id: ASSESSMENT }) })).status).toBe(200);
    expect(mocks.assessments.cancelAssessment).toHaveBeenCalledWith(mocks.session, ASSESSMENT);

    mocks.assessments.cancelAssessment.mockClear();
    const rejected = await cancelAssessment(post(
      `/api/product/security/assessments/${ASSESSMENT}/cancel`,
      { force: true },
      { "content-length": "14" },
    ), { params: Promise.resolve({ id: ASSESSMENT }) });
    expect(rejected.status).toBe(400);
    expect(mocks.assessments.cancelAssessment).not.toHaveBeenCalled();
  });
});
