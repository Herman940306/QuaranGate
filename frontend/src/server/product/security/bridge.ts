import "server-only";
import type {
  ProductAssessmentAdmissionRequest,
  SecurityAssessmentAdmissionReceipt,
} from "../../../../../src/shared/securityAssessment";
import { ProductDataError } from "../data/errors";

const MAX_RESPONSE_BYTES = 64 * 1024;
const BRIDGE_TIMEOUT_MS = 5_000;

export interface SecurityAssessmentAdmissionAdapter {
  admit(request: ProductAssessmentAdmissionRequest): Promise<SecurityAssessmentAdmissionReceipt>;
}

function gatewayOrigin(): string {
  const raw = process.env.QG_PRODUCT_GATEWAY_URL?.trim();
  if (!raw) throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_gateway_not_configured");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "security_assessment_gateway_url_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "security_assessment_gateway_url_invalid");
  }
  return url.origin;
}

function bridgeToken(): string {
  const token = process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN?.trim();
  if (!token || token.length < 32 || token.length > 4096 || /[\r\n\0]/.test(token)) {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_not_configured");
  }
  return token;
}

function validateReceipt(value: unknown): SecurityAssessmentAdmissionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_response_invalid");
  }
  const r = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "bridgeRequestId", "assessmentId", "assessmentVersion",
    "correlationId", "decision", "decisionCode", "decisionAt", "decisionExpiresAt",
    "admissionReceiptDigest", "resolvedPrincipalId", "resolvedProjectId",
    "resolvedTargetId", "resolvedSourceRevision", "policyVersion", "resourceClass",
    "networkClass", "credentialClass",
  ]);
  if (Object.keys(r).some((key) => !allowed.has(key))) {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_response_invalid");
  }
  if (
    r.schemaVersion !== "BE9_ADMISSION_RECEIPT_V1"
    || !/^bar_[0-9a-f]{24}$/.test(String(r.bridgeRequestId))
    || !/^assessment_[0-9a-f]{24}$/.test(String(r.assessmentId))
    || !Number.isSafeInteger(r.assessmentVersion)
    || typeof r.correlationId !== "string"
    || !["ADMITTED", "DENIED_POLICY", "FAILED_PRECONDITION", "TEMPORARILY_UNAVAILABLE", "REPLAY_REJECTED"].includes(String(r.decision))
    || !/^[A-Z][A-Z0-9_:-]{0,127}$/.test(String(r.decisionCode))
    || !/^[0-9a-f]{64}$/.test(String(r.admissionReceiptDigest))
    || r.policyVersion !== "BE9_ADMISSION_POLICY_V1"
    || r.resourceClass !== "STATIC_SOURCE"
    || r.networkClass !== "NONE"
    || r.credentialClass !== "NONE"
  ) {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_response_invalid");
  }
  for (const key of ["decisionAt", "decisionExpiresAt"] as const) {
    const raw = r[key];
    if (typeof raw !== "string" || new Date(raw).toISOString() !== raw) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_response_invalid");
    }
  }
  return r as unknown as SecurityAssessmentAdmissionReceipt;
}

export class HttpSecurityAssessmentAdmissionAdapter implements SecurityAssessmentAdmissionAdapter {
  async admit(request: ProductAssessmentAdmissionRequest): Promise<SecurityAssessmentAdmissionReceipt> {
    let response: Response;
    try {
      response = await fetch(`${gatewayOrigin()}/internal/security/assessment/admit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-product-assessment-token": bridgeToken(),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_unavailable");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_response_oversized");
    }
    if (!response.ok) {
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_unavailable");
    }
    try {
      return validateReceipt(JSON.parse(text));
    } catch (error) {
      if (error instanceof ProductDataError) throw error;
      throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_response_invalid");
    }
  }
}

export class UnavailableSecurityAssessmentAdmissionAdapter implements SecurityAssessmentAdmissionAdapter {
  async admit(_request: ProductAssessmentAdmissionRequest): Promise<SecurityAssessmentAdmissionReceipt> {
    throw new ProductDataError("PRODUCT_DATA_UNAVAILABLE", "security_assessment_bridge_unavailable");
  }
}
