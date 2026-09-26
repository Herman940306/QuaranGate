import "server-only";
import type { SecurityDiscoveryRequest } from "./types";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DISCOVERY_ID = /^disc_[0-9a-f]{24}$/;
export const MAX_SECURITY_REQUEST_BODY_BYTES = 16 * 1024;

export async function readBoundedSecurityJson(request: Request, maxBytes = MAX_SECURITY_REQUEST_BODY_BYTES): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) throw new Error("security_request_body_too_large");
  }

  if (!request.body) throw new Error("security_request_invalid");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("security_request_body_too_large");
        throw new Error("security_request_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) throw new Error("security_request_invalid");

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("security_request_invalid");
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("security_request_invalid");
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedSet.has(key))) throw new Error("security_request_invalid");
}

export function parseSecurityDiscoveryRequest(value: unknown): SecurityDiscoveryRequest {
  const body = objectBody(value);
  rejectUnknownKeys(body, ["projectId", "targetId", "assessmentIntent"]);
  if (typeof body.projectId !== "string" || !PROJECT_ID.test(body.projectId)) throw new Error("security_project_invalid");
  if (body.targetId !== undefined && (typeof body.targetId !== "string" || !TARGET_ID.test(body.targetId))) throw new Error("security_target_invalid");
  if (body.assessmentIntent !== undefined && !["source", "runtime", "pipeline"].includes(String(body.assessmentIntent))) {
    throw new Error("security_request_invalid");
  }
  return {
    projectId: body.projectId,
    ...(typeof body.targetId === "string" ? { targetId: body.targetId } : {}),
    ...(typeof body.assessmentIntent === "string" ? { assessmentIntent: body.assessmentIntent as SecurityDiscoveryRequest["assessmentIntent"] } : {}),
  };
}

export function parseDiscoveryIdRequest(value: unknown): string {
  const body = objectBody(value);
  rejectUnknownKeys(body, ["discoveryId"]);
  if (typeof body.discoveryId !== "string" || !DISCOVERY_ID.test(body.discoveryId)) throw new Error("security_discovery_id_invalid");
  return body.discoveryId;
}

export function parseDiscoveryId(value: string | null): string {
  if (!value || !DISCOVERY_ID.test(value)) throw new Error("security_discovery_id_invalid");
  return value;
}
