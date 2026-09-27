import { request } from 'undici';
import { BridgeError } from '../shared/errors.js';
import type {
  SecurityAssessmentAdmissionReceipt,
  SecurityAssessmentOperationalBinding,
} from '../shared/securityAssessment.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;

function base(): string {
  const raw = process.env.QG_PRODUCT_INTERNAL_URL?.trim() ?? '';
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new BridgeError('PRECONDITION_FAILED', 'product assessment internal service is not configured', 503);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new BridgeError('PRECONDITION_FAILED', 'product assessment internal service URL is invalid', 503);
  }
  return parsed.origin;
}

function token(): string {
  const value = process.env.PRODUCT_ASSESSMENT_MCP_TOKEN?.trim() ?? '';
  const bridge = process.env.PRODUCT_ASSESSMENT_BRIDGE_TOKEN?.trim() ?? '';
  const internal = process.env.INTERNAL_TOKEN?.trim() ?? '';
  if (
    value.length < 32
    || value.length > 4096
    || /[\r\n\0]/.test(value)
    || (bridge && value === bridge)
    || (internal && value === internal)
  ) {
    throw new BridgeError('PRECONDITION_FAILED', 'product assessment MCP service identity is unavailable', 503);
  }
  return value;
}

async function call<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await request(`${base()}/internal/security/assessment/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-product-assessment-mcp-token': token(),
    },
    body: JSON.stringify(payload),
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  }).catch(() => {
    throw new BridgeError('DOCKER_UNAVAILABLE', 'product assessment internal service is unavailable', 503);
  });
  const body = await response.body.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new BridgeError('INTERNAL', 'product assessment internal response exceeded bound', 503);
  }
  let parsed: any;
  try { parsed = body ? JSON.parse(body) : {}; } catch {
    throw new BridgeError('INTERNAL', 'product assessment internal response is malformed', 503);
  }
  if (response.statusCode >= 400) {
    const code = String(parsed?.error?.code ?? 'INTERNAL');
    const status = response.statusCode;
    if (status === 404) throw new BridgeError('PRECONDITION_FAILED', 'security assessment is unavailable', 404);
    if (status === 403) throw new BridgeError('FORBIDDEN_PROJECT', 'security assessment is not permitted', 403);
    if (status === 409) throw new BridgeError('CONCURRENCY_LIMIT', 'security assessment state is stale', 409);
    if (status === 400) throw new BridgeError('MALFORMED_REQUEST', 'security assessment request was rejected', 400);
    throw new BridgeError('DOCKER_UNAVAILABLE', `product assessment internal service unavailable (${code})`, 503);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.data) {
    throw new BridgeError('INTERNAL', 'product assessment internal response shape is invalid', 503);
  }
  return parsed.data as T;
}

export interface SecurityAssessmentSummaryWire {
  id: string;
  state: string;
  version: number;
  discoveryId: string;
  planId: string;
  binding: {
    projectId: string;
    targetId?: string;
    sourceRevision: string;
    assessmentIntent?: string;
  };
  requestedAt: string;
  updatedAt: string;
  correlationId: string;
}

export const productAssessmentClient = {
  startIntent: (principalRef: string, discoveryId: string, correlationId: string) =>
    call<SecurityAssessmentOperationalBinding>({
      action: 'start',
      principalRef,
      discoveryId,
      correlationId,
    }),
  applyAdmission: (principalRef: string, receipt: SecurityAssessmentAdmissionReceipt) =>
    call<SecurityAssessmentSummaryWire>({
      action: 'apply-admission',
      principalRef,
      receipt,
    }),
  status: (principalRef: string, assessmentId: string) =>
    call<SecurityAssessmentSummaryWire>({
      action: 'status',
      principalRef,
      assessmentId,
    }),
  cancel: (principalRef: string, assessmentId: string) =>
    call<SecurityAssessmentSummaryWire>({
      action: 'cancel',
      principalRef,
      assessmentId,
    }),
  evidence: (principalRef: string, assessmentId: string) =>
    call<{
      admissions: SecurityAssessmentAdmissionReceipt[];
      evidence: Array<{
        type: string;
        producerClass: string;
        sha256Hex: string;
        sizeBytes: number;
        truncated: boolean;
        finalized: boolean;
        createdAt: string;
        finalizedAt?: string;
      }>;
    }>({
      action: 'evidence',
      principalRef,
      assessmentId,
    }),
};
