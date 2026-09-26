import "server-only";
import { ProductDataError } from "../data/errors";

export type ProductErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "STALE_VERSION"
  | "VALIDATION_FAILED"
  | "BACKEND_UNAVAILABLE"
  | "INTERNAL";

function mapError(error: unknown): { status: number; code: ProductErrorCode; message: string } {
  if (error instanceof ProductDataError) {
    if (error.code === "PRODUCT_DATA_STALE_VERSION") return { status: 409, code: "STALE_VERSION", message: "Product data version is stale." };
    if (error.code === "PRODUCT_DATA_FORBIDDEN") return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
    if (error.code === "PRODUCT_DATA_NOT_FOUND") return { status: 404, code: "VALIDATION_FAILED", message: "Requested product data is unavailable." };
    if (error.code === "PRODUCT_DATA_UNAVAILABLE") return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Product data service is unavailable." };
    return { status: 400, code: "VALIDATION_FAILED", message: "Product data request was rejected." };
  }
  const value = error instanceof Error ? error.message : "";
  if (value.includes("session_missing") || value.includes("session_invalid")) return { status: 401, code: "UNAUTHENTICATED", message: "Product session is not valid." };
  if (value.includes("csrf") || value.includes("workspace_forbidden") || value.includes("provider_forbidden")) return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
  if (value.includes("stale_version")) return { status: 409, code: "STALE_VERSION", message: "Product data version is stale." };
  if (value.includes("provider_not_found")) return { status: 404, code: "VALIDATION_FAILED", message: "Requested product data is unavailable." };
  if (value.includes("provider_request") || value.includes("provider_secret") || value.includes("provider_custody")) return { status: 400, code: "VALIDATION_FAILED", message: "Provider request was rejected." };
  if (value.includes("openbao_") || value.includes("secret_custody")) return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Provider custody service is unavailable." };
  if (value.includes("meeting_request") || value.includes("meeting_title") || value.includes("meeting_version") || value.includes("meeting_state_transition") || value.includes("meeting_idempotency")) return { status: 400, code: "VALIDATION_FAILED", message: "Meeting request was rejected." };
  if (value.includes("meeting_forbidden") || value.includes("meeting_workspace_required")) return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
  if (value.includes("meeting_stt_provider_unavailable")) return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Meeting transcription service is unavailable." };
  if (value.includes("security_request") || value.includes("security_project_invalid") || value.includes("security_target_invalid") || value.includes("security_discovery_id_invalid") || value.includes("security_discovery_project_invalid") || value.includes("security_discovery_target_invalid") || value.includes("security_discovery_revision_invalid") || value.includes("security_discovery_file_count_exceeded") || value.includes("security_discovery_total_bytes_exceeded")) return { status: 400, code: "VALIDATION_FAILED", message: "Security discovery request was rejected." };
  if (value.includes("security_workspace_required") || value.includes("security_forbidden") || value.includes("security_project_forbidden") || value.includes("security_target_forbidden")) return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
  if (value.includes("security_source_unavailable") || value.includes("security_principal_unavailable")) return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Security discovery service is unavailable." };
  if (value.includes("security_discovery_not_found")) return { status: 404, code: "VALIDATION_FAILED", message: "Requested security discovery is unavailable." };
  if (value.includes("observability_window") || value.includes("top_n") || value.includes("bucket_count")) return { status: 400, code: "VALIDATION_FAILED", message: "Observability request was rejected." };
  if (value.includes("security_discovery") || value.includes("security_project")) return { status: 400, code: "VALIDATION_FAILED", message: "Security assessment request was rejected." };
  if (value.includes("security_workspace_required")) return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
  if (value.includes("observability_forbidden") || value.includes("observability_workspace_required")) return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
  if (value.includes("zabbix_") || value.includes("tempo_")) return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Observability backend is unavailable." };
  if (value.includes("collaboration_request") || value.includes("group_name") || value.includes("message_body") || value.includes("message_cursor") || value.includes("attachment_") || value.includes("approval_") || value.includes("event_cursor") || value.includes("event_payload") || value.includes("idempotency_key")) return { status: 400, code: "VALIDATION_FAILED", message: "Collaboration request was rejected." };
  if (value.includes("collaboration_forbidden") || value.includes("collaboration_workspace_required")) return { status: 403, code: "FORBIDDEN", message: "Request is not permitted." };
  if (value.includes("realtime_transport")) return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Realtime delivery is unavailable." };
  if (value.includes("workspace_request") || value.includes("login_transaction") || value.includes("identity_")) return { status: 400, code: "VALIDATION_FAILED", message: "Identity/session request was rejected." };
  if (value.includes("not_configured") || value.includes("adapter_") || value.includes("non_durable")) return { status: 503, code: "BACKEND_UNAVAILABLE", message: "Product identity service is unavailable." };
  return { status: 500, code: "INTERNAL", message: "Request failed." };
}

function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return headers;
}

export function success(data: unknown, init: ResponseInit = {}): Response {
  return Response.json({ data, meta: { serverTime: new Date().toISOString() } }, { ...init, headers: noStoreHeaders(init.headers) });
}

export function failure(error: unknown): Response {
  const mapped = mapError(error);
  return new Response(JSON.stringify({ error: { code: mapped.code, message: mapped.message } }), {
    status: mapped.status,
    headers: noStoreHeaders({ "Content-Type": "application/json" }),
  });
}
