import "server-only";
import type { SecurityDiscoveryRequest } from "./types";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DISCOVERY_ID = /^disc_[0-9a-f]{24}$/;

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
