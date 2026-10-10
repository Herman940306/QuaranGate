import { failure, success } from "../../../../../server/product/http/errors";
import { readBoundedSecurityJson } from "../../../../../server/product/security/request";
import { validateSecurityAssessmentAdmissionReceipt } from "../../../../../server/product/security/evidence";
import { securityAssessmentService } from "../../../../../server/product/security/runtime";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DISCOVERY = /^disc_[0-9a-f]{24}$/;
const ASSESSMENT = /^assessment_[0-9a-f]{24}$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

async function body(request: Request): Promise<Record<string, unknown>> {
  // Bound bytes during streaming, including chunked and falsely declared bodies.
  // This reader cancels the stream as soon as the enforced cap is exceeded.
  const parsed = await readBoundedSecurityJson(request, MAX_BODY_BYTES);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("security_request_invalid");
  return parsed as Record<string, unknown>;
}

function token(request: Request): void {
  const configured = process.env.PRODUCT_ASSESSMENT_MCP_TOKEN?.trim();
  const bridge = process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN?.trim();
  const internal = process.env.INTERNAL_TOKEN?.trim();
  if (!configured || configured.length < 32 || configured.length > 4096 || /[\r\n\0]/.test(configured)) {
    throw new Error("security_mcp_bridge_not_configured");
  }
  if ((bridge && configured === bridge) || (internal && configured === internal)) {
    throw new Error("security_mcp_bridge_not_configured");
  }
  if (request.headers.get("x-product-assessment-mcp-token") !== configured) {
    throw new Error("security_forbidden");
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) throw new Error("security_request_invalid");
}

export async function POST(request: Request): Promise<Response> {
  try {
    token(request);
    const value = await body(request);
    if (typeof value.action !== "string" || typeof value.principalRef !== "string" || !PRINCIPAL.test(value.principalRef)) {
      throw new Error("security_request_invalid");
    }
    const service = securityAssessmentService();
    if (value.action === "start") {
      exactKeys(value, ["action", "principalRef", "discoveryId", "correlationId"]);
      if (typeof value.discoveryId !== "string" || !DISCOVERY.test(value.discoveryId)
        || typeof value.correlationId !== "string" || !CORRELATION.test(value.correlationId)) {
        throw new Error("security_request_invalid");
      }
      return success(await service.createOperationalIntent(
        value.principalRef,
        value.discoveryId,
        value.correlationId,
      ));
    }
    if (value.action === "apply-admission") {
      exactKeys(value, ["action", "principalRef", "receipt"]);
      const receipt = validateSecurityAssessmentAdmissionReceipt(value.receipt);
      return success(await service.applyOperationalAdmission(value.principalRef, receipt));
    }
    if (value.action === "status" || value.action === "cancel" || value.action === "evidence") {
      exactKeys(value, ["action", "principalRef", "assessmentId"]);
      if (typeof value.assessmentId !== "string" || !ASSESSMENT.test(value.assessmentId)) {
        throw new Error("security_request_invalid");
      }
      if (value.action === "status") {
        return success(await service.operationalAssessment(value.principalRef, value.assessmentId));
      }
      if (value.action === "cancel") {
        return success(await service.operationalCancel(value.principalRef, value.assessmentId));
      }
      return success(await service.operationalEvidence(value.principalRef, value.assessmentId));
    }
    throw new Error("security_request_invalid");
  } catch (error) {
    return failure(error);
  }
}
