import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  service: {
    createOperationalIntent: vi.fn(),
    applyOperationalAdmission: vi.fn(),
    operationalAssessment: vi.fn(),
    operationalCancel: vi.fn(),
    operationalEvidence: vi.fn(),
  },
}));

vi.mock("../../src/server/product/security/runtime", () => ({
  securityAssessmentService: () => mocks.service,
}));

import { POST } from "../../src/app/internal/security/assessment/mcp/route";

const MCP_TOKEN = "m".repeat(40);
const BRIDGE_TOKEN = "b".repeat(40);
const INTERNAL_TOKEN = "i".repeat(40);
const DISCOVERY = `disc_${"a".repeat(24)}`;
const ASSESSMENT = `assessment_${"c".repeat(24)}`;

function request(body: unknown, token = MCP_TOKEN): Request {
  const text = JSON.stringify(body);
  return new Request("http://product.internal/internal/security/assessment/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text, "utf8")),
      "x-product-assessment-mcp-token": token,
    },
    body: text,
  });
}

describe("BE9.2 internal MCP assessment adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PRODUCT_ASSESSMENT_MCP_TOKEN = MCP_TOKEN;
    process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN = BRIDGE_TOKEN;
    process.env.INTERNAL_TOKEN = INTERNAL_TOKEN;
    mocks.service.createOperationalIntent.mockResolvedValue({ assessmentId: ASSESSMENT });
    mocks.service.operationalAssessment.mockResolvedValue({ id: ASSESSMENT, state: "PLANNED" });
    mocks.service.operationalCancel.mockResolvedValue({ id: ASSESSMENT, state: "CANCELLED" });
    mocks.service.operationalEvidence.mockResolvedValue({ admissions: [], evidence: [] });
  });

  afterEach(() => {
    delete process.env.PRODUCT_ASSESSMENT_MCP_TOKEN;
    delete process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN;
    delete process.env.INTERNAL_TOKEN;
  });

  it("requires a dedicated MCP service credential distinct from broader internal credentials", async () => {
    process.env.PRODUCT_ASSESSMENT_MCP_TOKEN = BRIDGE_TOKEN;
    expect((await POST(request({
      action: "status",
      principalRef: "principal-a",
      assessmentId: ASSESSMENT,
    }, BRIDGE_TOKEN))).status).toBe(503);
    expect(mocks.service.operationalAssessment).not.toHaveBeenCalled();

    process.env.PRODUCT_ASSESSMENT_MCP_TOKEN = INTERNAL_TOKEN;
    expect((await POST(request({
      action: "status",
      principalRef: "principal-a",
      assessmentId: ASSESSMENT,
    }, INTERNAL_TOKEN))).status).toBe(503);
    expect(mocks.service.operationalAssessment).not.toHaveBeenCalled();
  });

  it("starts from exact Principal + discovery identity without caller tenant assertions", async () => {
    const response = await POST(request({
      action: "start",
      principalRef: "principal-a",
      discoveryId: DISCOVERY,
      correlationId: "corr-mcp",
    }));
    expect(response.status).toBe(200);
    expect(mocks.service.createOperationalIntent).toHaveBeenCalledWith(
      "principal-a",
      DISCOVERY,
      "corr-mcp",
    );

    mocks.service.createOperationalIntent.mockClear();
    const rejected = await POST(request({
      action: "start",
      principalRef: "principal-a",
      discoveryId: DISCOVERY,
      correlationId: "corr-mcp",
      organizationId: "org-injected",
      workspaceId: "ws-injected",
    }));
    expect(rejected.status).toBe(400);
    expect(mocks.service.createOperationalIntent).not.toHaveBeenCalled();
  });

  it("status/cancel/evidence accept only exact assessment identity and Principal", async () => {
    for (const [action, method] of [
      ["status", mocks.service.operationalAssessment],
      ["cancel", mocks.service.operationalCancel],
      ["evidence", mocks.service.operationalEvidence],
    ] as const) {
      vi.clearAllMocks();
      method.mockResolvedValue(action === "evidence"
        ? { admissions: [], evidence: [] }
        : { id: ASSESSMENT, state: "PLANNED" });
      const response = await POST(request({
        action,
        principalRef: "principal-a",
        assessmentId: ASSESSMENT,
      }));
      expect(response.status).toBe(200);
      expect(method).toHaveBeenCalledWith("principal-a", ASSESSMENT);
    }
  });

  it.each(["no-length", "understated-length"])(
    "bounds streamed internal assessment requests with %s without buffering all chunks",
    async (lengthMode) => {
      let pulls = 0;
      let cancellations = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(16 * 1024).fill(97));
          if (pulls >= 30) controller.close();
        },
        cancel() { cancellations += 1; },
      });
      const headers = new Headers({
        "content-type": "application/json",
        "x-product-assessment-mcp-token": MCP_TOKEN,
      });
      if (lengthMode === "understated-length") headers.set("content-length", "1");
      const req = new Request("http://product.internal/internal/security/assessment/mcp", {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: string });
      const response = await POST(req);
      expect(response.status).toBe(400);
      expect(pulls).toBeLessThan(20);
      expect(cancellations).toBe(1);
      expect(mocks.service.operationalAssessment).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed or oversized identities before service delegation", async () => {
    const malformed = await POST(request({
      action: "status",
      principalRef: "../principal",
      assessmentId: ASSESSMENT,
    }));
    expect(malformed.status).toBe(400);
    expect(mocks.service.operationalAssessment).not.toHaveBeenCalled();

    const text = JSON.stringify({
      action: "status",
      principalRef: "principal-a",
      assessmentId: ASSESSMENT,
      padding: "x".repeat(70 * 1024),
    });
    const oversized = new Request("http://product.internal/internal/security/assessment/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
        "x-product-assessment-mcp-token": MCP_TOKEN,
      },
      body: text,
    });
    expect((await POST(oversized)).status).toBe(400);
    expect(mocks.service.operationalAssessment).not.toHaveBeenCalled();
  });
});
