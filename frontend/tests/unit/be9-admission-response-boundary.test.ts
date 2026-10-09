import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { HttpSecurityAssessmentAdmissionAdapter } from "../../src/server/product/security/bridge";

const receipt = {
  schemaVersion: "BE9_ADMISSION_RECEIPT_V1",
  bridgeRequestId: `bar_${"a".repeat(24)}`,
  assessmentId: `assessment_${"b".repeat(24)}`,
  assessmentVersion: 1,
  correlationId: "corr",
  decision: "ADMITTED",
  decisionCode: "ADMISSION_OK",
  decisionAt: "2026-10-10T00:00:00.000Z",
  decisionExpiresAt: "2026-10-10T00:00:30.000Z",
  admissionReceiptDigest: "c".repeat(64),
  policyVersion: "BE9_ADMISSION_POLICY_V1",
  resourceClass: "STATIC_SOURCE",
  networkClass: "NONE",
  credentialClass: "NONE",
};

function streamResponse(chunks: Uint8Array[], options: { status?: number; length?: string; fail?: string } = {}) {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.fail) { controller.error(new Error(options.fail)); return; }
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  });
  const response = new Response(body, { status: options.status ?? 200,
    headers: options.length === undefined ? {} : { "content-length": options.length } });
  return { response, get reads() { return reads; }, get cancelled() { return cancelled; } };
}

const encode = (value: string) => new TextEncoder().encode(value);
const adapter = new HttpSecurityAssessmentAdmissionAdapter();

describe("BE9 Product admission response boundary", () => {
  beforeEach(() => {
    process.env.QG_PRODUCT_GATEWAY_URL = "http://127.0.0.1:8999";
    process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN = "x".repeat(32);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.QG_PRODUCT_GATEWAY_URL;
    delete process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN;
  });

  async function admit(response: Response) {
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    const result = adapter.admit({} as never);
    return { result, fetch };
  }

  it("accepts a valid receipt split across chunks at exactly 64 KiB", async () => {
    const json = JSON.stringify(receipt);
    const bytes = encode(json.padEnd(64 * 1024, " "));
    const streamed = streamResponse([bytes.subarray(0, 11), bytes.subarray(11, 65535), bytes.subarray(65535)]);
    const { result, fetch } = await admit(streamed.response);
    await expect(result).resolves.toEqual(receipt);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8999/internal/security/assessment/admit",
      expect.objectContaining({ headers: expect.objectContaining({ "x-product-assessment-token": "x".repeat(32) }), cache: "no-store" }));
  });

  it.each([1, 8192])("rejects 64 KiB plus one without consuming a later chunk (prefix %i)", async (prefix) => {
    const streamed = streamResponse([encode("x".repeat(prefix)), encode("y".repeat(65537 - prefix)), encode("sentinel")]);
    const { result } = await admit(streamed.response);
    await expect(result).rejects.toMatchObject({ code: "PRODUCT_DATA_UNAVAILABLE",
      message: "security_assessment_bridge_response_oversized" });
    expect(streamed.cancelled).toBe(true);
  });

  it("rejects oversized content-length before reading", async () => {
    const streamed = streamResponse([encode("private")], { length: "65537" });
    const { result } = await admit(streamed.response);
    await expect(result).rejects.toMatchObject({ message: "security_assessment_bridge_response_oversized" });
    expect(streamed.reads).toBeLessThanOrEqual(1);
    expect(streamed.cancelled).toBe(true);
  });

  it.each(["malformed", "empty", "status", "stream error"])("sanitizes %s", async (kind) => {
    const secret = "private gateway diagnostic";
    const streamed = kind === "empty" ? { response: new Response(null), cancelled: false }
      : streamResponse([encode(kind === "malformed" ? `{${secret}` : secret)], {
        status: kind === "status" ? 500 : 200,
        fail: kind === "stream error" ? secret : undefined,
      });
    const { result } = await admit(streamed.response);
    await expect(result).rejects.toMatchObject({ code: "PRODUCT_DATA_UNAVAILABLE",
      message: kind === "status" || kind === "stream error"
        ? "security_assessment_bridge_unavailable" : "security_assessment_bridge_response_invalid" });
    await result.catch((error: Error) => expect(error.message).not.toContain(secret));
  });
});
